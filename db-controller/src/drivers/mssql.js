'use strict';

const {
  serializeValue,
  serializeRow,
  normalizePaging,
  normalizeOrderDir,
  assertReadOnly,
  assertSingleStatement,
  assertIdentifier,
  badRequest,
} = require('./util');

function requireDriver() {
  try {
    return require('mssql');
  } catch (err) {
    const e = new Error('SQL Server ドライバが未インストールです。`npm install mssql` を実行してください。');
    e.status = 500;
    throw e;
  }
}

function quote(name) {
  return `[${String(name).replace(/]/g, ']]')}]`;
}

const SYSTEM_DATABASES = ['master', 'tempdb', 'model', 'msdb'];

async function connect(conn, database) {
  const sql = requireDriver();
  const config = {
    server: conn.host,
    port: conn.instanceName ? undefined : conn.port || 1433,
    user: conn.username,
    password: conn.password,
    database: database || conn.database || 'master',
    options: {
      encrypt: conn.encrypt !== false,
      trustServerCertificate: conn.trustServerCertificate !== false,
      instanceName: conn.instanceName || undefined,
      enableArithAbort: true,
    },
    connectionTimeout: 15000,
    requestTimeout: 120000,
    // T-SQL の明示トランザクションが同じ物理接続で完結するよう 1 本に固定する
    pool: { max: 1, min: 0, idleTimeoutMillis: 30000 },
  };
  const pool = new sql.ConnectionPool(config);
  await pool.connect();
  return pool;
}

async function close(pool) {
  await pool.close();
}

/** 名前付きパラメータで問い合わせる。 */
async function exec(pool, statement, params = {}) {
  const request = pool.request();
  request.arrayRowMode = true;
  for (const [key, value] of Object.entries(params)) request.input(key, value);
  return request.query(statement);
}

/** 列名付きオブジェクトとして受け取りたいとき用。 */
async function execObjects(pool, statement, params = {}) {
  const request = pool.request();
  for (const [key, value] of Object.entries(params)) request.input(key, value);
  const result = await request.query(statement);
  return result.recordset || [];
}

async function serverInfo(pool) {
  const rows = await execObjects(
    pool,
    `SELECT @@VERSION AS version, DB_NAME() AS db, SUSER_SNAME() AS usr`
  );
  return { version: rows[0].version, database: rows[0].db, user: rows[0].usr };
}

async function listDatabases(pool) {
  const rows = await execObjects(
    pool,
    `SELECT name
       FROM sys.databases
      WHERE state = 0 AND HAS_DBACCESS(name) = 1
      ORDER BY name`
  );
  return rows
    .filter((r) => !SYSTEM_DATABASES.includes(r.name))
    .map((r) => ({ name: r.name }));
}

async function listSchemas(pool) {
  const rows = await execObjects(
    pool,
    `SELECT s.name AS name, COUNT(o.object_id) AS object_count
       FROM sys.schemas s
       LEFT JOIN sys.objects o
              ON o.schema_id = s.schema_id AND o.type IN ('U', 'V')
      WHERE s.name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest')
        AND s.name NOT LIKE 'db!_%' ESCAPE '!'
      GROUP BY s.name
      ORDER BY s.name`
  );
  return rows.map((r) => ({ name: r.name, objectCount: Number(r.object_count) }));
}

async function listTables(pool, schema) {
  const rows = await execObjects(
    pool,
    `SELECT o.name AS name,
            CASE o.type WHEN 'V' THEN 'VIEW' ELSE 'TABLE' END AS type,
            CAST(ISNULL(p.row_count, 0) AS BIGINT) AS estimated_rows,
            CAST(ep.value AS NVARCHAR(MAX)) AS comment
       FROM sys.objects o
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       LEFT JOIN (
            SELECT ps.object_id, SUM(ps.row_count) AS row_count
              FROM sys.dm_db_partition_stats ps
             WHERE ps.index_id IN (0, 1)
             GROUP BY ps.object_id
       ) p ON p.object_id = o.object_id
       LEFT JOIN sys.extended_properties ep
              ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
      WHERE s.name = @schema AND o.type IN ('U', 'V')
      ORDER BY o.name`,
    { schema }
  );
  return rows.map((r) => ({
    schema,
    name: r.name,
    type: r.type,
    estimatedRows: r.type === 'VIEW' ? null : Number(r.estimated_rows),
    comment: r.comment || null,
  }));
}

async function describeTable(pool, schema, table) {
  const columns = await execObjects(
    pool,
    `SELECT c.column_id       AS position,
            c.name            AS name,
            t.name            AS type_name,
            c.max_length      AS max_length,
            c.precision       AS precision,
            c.scale           AS scale,
            c.is_nullable     AS is_nullable,
            c.is_identity     AS is_identity,
            dc.definition     AS default_value,
            CAST(ep.value AS NVARCHAR(MAX)) AS comment
       FROM sys.columns c
       JOIN sys.objects o  ON o.object_id = c.object_id
       JOIN sys.schemas s  ON s.schema_id = o.schema_id
       JOIN sys.types t    ON t.user_type_id = c.user_type_id
       LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
       LEFT JOIN sys.extended_properties ep
              ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
      WHERE s.name = @schema AND o.name = @tbl
      ORDER BY c.column_id`,
    { schema, tbl: table }
  );

  const indexes = await execObjects(
    pool,
    `SELECT i.name          AS index_name,
            i.is_unique     AS is_unique,
            i.is_primary_key AS is_primary,
            c.name          AS column_name,
            ic.key_ordinal  AS key_ordinal
       FROM sys.indexes i
       JOIN sys.objects o  ON o.object_id = i.object_id
       JOIN sys.schemas s  ON s.schema_id = o.schema_id
       JOIN sys.index_columns ic
              ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
       JOIN sys.columns c
              ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE s.name = @schema AND o.name = @tbl AND i.name IS NOT NULL
      ORDER BY i.is_primary_key DESC, i.name, ic.key_ordinal`,
    { schema, tbl: table }
  );

  const foreignKeys = await execObjects(
    pool,
    `SELECT fk.name           AS fk_name,
            pc.name           AS column_name,
            rs.name           AS ref_schema,
            ro.name           AS ref_table,
            rc.name           AS ref_column,
            fkc.constraint_column_id AS ordinal
       FROM sys.foreign_keys fk
       JOIN sys.objects o  ON o.object_id = fk.parent_object_id
       JOIN sys.schemas s  ON s.schema_id = o.schema_id
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
       JOIN sys.objects ro ON ro.object_id = fk.referenced_object_id
       JOIN sys.schemas rs ON rs.schema_id = ro.schema_id
       JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
      WHERE s.name = @schema AND o.name = @tbl
      ORDER BY fk.name, fkc.constraint_column_id`,
    { schema, tbl: table }
  );

  const primaryKey = indexes.filter((r) => r.is_primary).map((r) => r.column_name);

  const indexMap = new Map();
  for (const row of indexes) {
    if (!indexMap.has(row.index_name)) {
      indexMap.set(row.index_name, {
        name: row.index_name,
        unique: Boolean(row.is_unique),
        primary: Boolean(row.is_primary),
        columns: [],
      });
    }
    indexMap.get(row.index_name).columns.push(row.column_name);
  }

  const fkMap = new Map();
  for (const row of foreignKeys) {
    if (!fkMap.has(row.fk_name)) {
      fkMap.set(row.fk_name, {
        name: row.fk_name,
        columns: [],
        refSchema: row.ref_schema,
        refTable: row.ref_table,
        refColumns: [],
      });
    }
    const fk = fkMap.get(row.fk_name);
    fk.columns.push(row.column_name);
    fk.refColumns.push(row.ref_column);
  }

  return {
    columns: columns.map((r) => ({
      position: Number(r.position),
      name: r.name,
      dataType: formatMssqlType(r),
      nullable: Boolean(r.is_nullable),
      defaultValue: r.default_value || null,
      comment: r.comment || null,
      isIdentity: Boolean(r.is_identity),
      isPrimaryKey: primaryKey.includes(r.name),
    })),
    primaryKey,
    indexes: [...indexMap.values()].map((idx) => ({
      ...idx,
      definition: `${idx.primary ? 'PRIMARY KEY ' : idx.unique ? 'UNIQUE ' : ''}INDEX ${idx.name} (${idx.columns.join(', ')})`,
    })),
    foreignKeys: [...fkMap.values()].map((fk) => ({
      ...fk,
      definition: `FOREIGN KEY (${fk.columns.join(', ')}) REFERENCES ${fk.refSchema}.${fk.refTable} (${fk.refColumns.join(', ')})`,
    })),
  };
}

/** NVARCHAR(50) / DECIMAL(18,2) のように長さ・精度付きで表示する。 */
function formatMssqlType(col) {
  const type = String(col.type_name).toUpperCase();
  const wide = ['NVARCHAR', 'NCHAR', 'NTEXT'].includes(type);
  if (['VARCHAR', 'CHAR', 'NVARCHAR', 'NCHAR', 'VARBINARY', 'BINARY'].includes(type)) {
    if (col.max_length === -1) return `${type}(MAX)`;
    return `${type}(${wide ? col.max_length / 2 : col.max_length})`;
  }
  if (['DECIMAL', 'NUMERIC'].includes(type)) return `${type}(${col.precision},${col.scale})`;
  if (['DATETIME2', 'TIME', 'DATETIMEOFFSET'].includes(type)) return `${type}(${col.scale})`;
  return type;
}

async function countRows(pool, schema, table, where) {
  assertIdentifier(schema, 'スキーマ名');
  assertIdentifier(table, 'テーブル名');
  const clause = where && where.trim() ? ` WHERE ${where}` : '';
  const rows = await execObjects(
    pool,
    `SELECT COUNT_BIG(*) AS cnt FROM ${quote(schema)}.${quote(table)}${clause}`
  );
  return Number(rows[0].cnt);
}

async function selectRows(pool, schema, table, options = {}) {
  assertIdentifier(schema, 'スキーマ名');
  assertIdentifier(table, 'テーブル名');
  const { limit, offset } = normalizePaging(options);
  const where = options.where && options.where.trim() ? ` WHERE ${options.where}` : '';

  // SQL Server の OFFSET / FETCH は ORDER BY 必須。指定が無ければ安定なダミー順を使う。
  let order = ' ORDER BY (SELECT NULL)';
  if (options.orderBy) {
    assertIdentifier(options.orderBy, '並び替え列名');
    order = ` ORDER BY ${quote(options.orderBy)} ${normalizeOrderDir(options.orderDir)}`;
  }

  const statement =
    `SELECT * FROM ${quote(schema)}.${quote(table)}${where}${order}` +
    ` OFFSET @offsetRows ROWS FETCH NEXT @limitRows ROWS ONLY`;
  const result = await exec(pool, statement, { offsetRows: offset, limitRows: limit });
  // arrayRowMode では recordset.columns が列メタデータの配列になる
  const columns = (result.recordset.columns || []).map((c) => c.name);
  return {
    columns,
    rows: result.recordset.map((row) => row.map(serializeValue)),
    sql: statement,
    limit,
    offset,
  };
}

async function runQuery(pool, sql, maxRows = 500) {
  const statement = assertReadOnly(sql);
  const result = await exec(pool, statement);
  const columns = (result.recordset.columns || []).map((c) => c.name);
  const all = result.recordset;
  const rows = all.slice(0, maxRows).map((row) => row.map(serializeValue));
  return { columns, rows, rowCount: all.length, truncated: all.length > maxRows };
}


/* ---------------- 更新系 ---------------- */

async function begin(pool) { await pool.request().query('BEGIN TRANSACTION'); }
async function commit(pool) { await pool.request().query('COMMIT TRANSACTION'); }
async function rollback(pool) { await pool.request().query('ROLLBACK TRANSACTION'); }

/** 影響行数つきでパラメータ実行する。 */
async function execWrite(pool, statement, params) {
  const request = pool.request();
  for (const [key, value] of Object.entries(params)) request.input(key, value);
  const result = await request.query(statement);
  return result.rowsAffected && result.rowsAffected.length
    ? result.rowsAffected.reduce((a, b) => a + b, 0)
    : 0;
}

/** WHERE 句を主キー列から組み立てる。値はすべてバインドする。 */
function buildKeyClause(keyColumns, keyValues, params, prefix) {
  const parts = keyColumns.map((col, i) => {
    assertIdentifier(col, '主キー列名');
    const name = `${prefix}${i}`;
    params[name] = keyValues[col];
    return `${quote(col)} = @${name}`;
  });
  return parts.join(' AND ');
}

async function insertRow(pool, schema, table, values) {
  assertIdentifier(schema, 'スキーマ名');
  assertIdentifier(table, 'テーブル名');
  const columns = Object.keys(values);
  if (!columns.length) throw badRequest('登録する値が指定されていません。');
  columns.forEach((c) => assertIdentifier(c, '列名'));

  const params = {};
  const placeholders = columns.map((c, i) => {
    params[`v${i}`] = values[c];
    return `@v${i}`;
  });
  const sql =
    `INSERT INTO ${quote(schema)}.${quote(table)} (${columns.map(quote).join(', ')})` +
    ` VALUES (${placeholders.join(', ')})`;
  return { affected: await execWrite(pool, sql, params), sql };
}

async function updateRow(pool, schema, table, keyColumns, keyValues, values) {
  assertIdentifier(schema, 'スキーマ名');
  assertIdentifier(table, 'テーブル名');
  const columns = Object.keys(values);
  if (!columns.length) throw badRequest('変更された列がありません。');
  columns.forEach((c) => assertIdentifier(c, '列名'));

  const params = {};
  const setParts = columns.map((c, i) => {
    params[`v${i}`] = values[c];
    return `${quote(c)} = @v${i}`;
  });
  const where = buildKeyClause(keyColumns, keyValues, params, 'k');
  const sql = `UPDATE ${quote(schema)}.${quote(table)} SET ${setParts.join(', ')} WHERE ${where}`;
  return { affected: await execWrite(pool, sql, params), sql };
}

async function deleteRow(pool, schema, table, keyColumns, keyValues) {
  assertIdentifier(schema, 'スキーマ名');
  assertIdentifier(table, 'テーブル名');
  const params = {};
  const where = buildKeyClause(keyColumns, keyValues, params, 'k');
  const sql = `DELETE FROM ${quote(schema)}.${quote(table)} WHERE ${where}`;
  return { affected: await execWrite(pool, sql, params), sql };
}

async function executeWrite(pool, sql) {
  const statement = assertSingleStatement(sql);
  return { affected: await execWrite(pool, statement, {}), sql: statement };
}

module.exports = {
  id: 'mssql',
  label: 'Microsoft SQL Server',
  defaultPort: 1433,
  supportsDatabaseSwitch: true,
  connect,
  close,
  serverInfo,
  listDatabases,
  listSchemas,
  listTables,
  describeTable,
  countRows,
  selectRows,
  runQuery,
  begin,
  commit,
  rollback,
  insertRow,
  updateRow,
  deleteRow,
  executeWrite,
  quote,
  serializeRow,
};
