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

/**
 * Oracle は node-oracledb の Thin モードで接続する。
 * Instant Client のインストールは不要 (Oracle Database 12.1 以降が対象)。
 */
function requireDriver() {
  try {
    return require('oracledb');
  } catch (err) {
    const e = new Error('Oracle ドライバが未インストールです。`npm install oracledb` を実行してください。');
    e.status = 500;
    throw e;
  }
}

function quote(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** Oracle にはデータベース切り替えの概念が無い (スキーマ = ユーザー)。 */
const SYSTEM_SCHEMAS = [
  'SYS', 'SYSTEM', 'OUTLN', 'DBSNMP', 'APPQOSSYS', 'CTXSYS', 'MDSYS', 'OLAPSYS',
  'ORDDATA', 'ORDSYS', 'ORDPLUGINS', 'XDB', 'WMSYS', 'LBACSYS', 'DVSYS', 'DVF',
  'GSMADMIN_INTERNAL', 'AUDSYS', 'OJVMSYS', 'SI_INFORMTN_SCHEMA', 'DBSFWUSER',
  'REMOTE_SCHEDULER_AGENT', 'SYSBACKUP', 'SYSDG', 'SYSKM', 'SYSRAC', 'SYS$UMF',
  'GGSYS', 'ANONYMOUS', 'XS$NULL', 'PDBADMIN', 'RDSADMIN',
];

const NLS_SESSION_SETTINGS = [
  `ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'`,
  `ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SSXFF'`,
  `ALTER SESSION SET NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SSXFF TZR'`,
];

function buildConnectString(conn) {
  const host = conn.host;
  const port = conn.port || 1521;
  if (conn.serviceName) return `${host}:${port}/${conn.serviceName}`;
  if (conn.sid) {
    return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))(CONNECT_DATA=(SID=${conn.sid})))`;
  }
  return `${host}:${port}`;
}

async function connect(conn) {
  const oracledb = requireDriver();
  // CLOB は文字列、BLOB は Buffer として受け取り、Lob ストリームを扱わずに済ませる。
  // DATE も文字列にする (JS の Date に変換するとローカルタイムゾーンの分だけずれるため)。
  oracledb.fetchAsString = [oracledb.CLOB, oracledb.DATE];
  oracledb.fetchAsBuffer = [oracledb.BLOB];
  const connection = await oracledb.getConnection({
    user: conn.username,
    password: conn.password,
    connectString: buildConnectString(conn),
  });
  // NLS 設定に依存せず一定の書式で表示するため、セッション書式を固定する
  for (const stmt of NLS_SESSION_SETTINGS) {
    await connection.execute(stmt).catch(() => {});
  }
  return connection;
}

async function close(connection) {
  await connection.close();
}

/** oracledb は outFormat OBJECT / ARRAY を選べる。ここでは配列で受ける。 */
async function exec(connection, sql, binds = {}) {
  const oracledb = requireDriver();
  return connection.execute(sql, binds, {
    outFormat: oracledb.OUT_FORMAT_OBJECT,
    fetchTypeHandler: (meta) => {
      // LOB / RAW は文字列化して返し、ストリームを扱わずに済ませる
      if (meta.dbType === oracledb.DB_TYPE_CLOB || meta.dbType === oracledb.DB_TYPE_NCLOB) {
        return { type: oracledb.STRING };
      }
      return undefined;
    },
  });
}

async function serverInfo(connection) {
  const result = await exec(
    connection,
    `SELECT banner AS "version" FROM v$version WHERE ROWNUM = 1`
  ).catch(async () => exec(connection, `SELECT 'Oracle Database' AS "version" FROM dual`));
  const who = await exec(connection, `SELECT USER AS "usr" FROM dual`);
  return {
    version: result.rows[0] ? result.rows[0].version : 'Oracle Database',
    database: null,
    user: who.rows[0].usr,
  };
}

/** Oracle は DB 切り替えが無いため空配列を返す。 */
async function listDatabases() {
  return [];
}

async function listSchemas(connection) {
  const result = await exec(
    connection,
    `SELECT owner AS "name", COUNT(*) AS "objectCount"
       FROM all_objects
      WHERE object_type IN ('TABLE', 'VIEW')
      GROUP BY owner
      ORDER BY owner`
  );
  return result.rows
    .map((r) => ({ name: r.name, objectCount: Number(r.objectCount) }))
    .filter((r) => !SYSTEM_SCHEMAS.includes(r.name) && !r.name.startsWith('APEX_'));
}

async function listTables(connection, schema) {
  const result = await exec(
    connection,
    `SELECT t.table_name AS "name",
            'TABLE'      AS "type",
            t.num_rows   AS "estimatedRows",
            c.comments   AS "comment"
       FROM all_tables t
       LEFT JOIN all_tab_comments c
              ON c.owner = t.owner AND c.table_name = t.table_name
      WHERE t.owner = :owner
      UNION ALL
     SELECT v.view_name AS "name",
            'VIEW'      AS "type",
            NULL        AS "estimatedRows",
            c.comments  AS "comment"
       FROM all_views v
       LEFT JOIN all_tab_comments c
              ON c.owner = v.owner AND c.table_name = v.view_name
      WHERE v.owner = :owner
      ORDER BY "name"`,
    { owner: schema }
  );
  return result.rows.map((r) => ({
    schema,
    name: r.name,
    type: r.type,
    estimatedRows: r.estimatedRows === null ? null : Number(r.estimatedRows),
    comment: r.comment || null,
  }));
}

async function describeTable(connection, schema, table) {
  const columnsResult = await exec(
    connection,
    `SELECT c.column_id       AS "position",
            c.column_name     AS "name",
            c.data_type       AS "dataType",
            c.data_length     AS "dataLength",
            c.data_precision  AS "dataPrecision",
            c.data_scale      AS "dataScale",
            c.nullable        AS "nullable",
            c.data_default    AS "defaultValue",
            m.comments        AS "comment"
       FROM all_tab_columns c
       LEFT JOIN all_col_comments m
              ON m.owner = c.owner AND m.table_name = c.table_name AND m.column_name = c.column_name
      WHERE c.owner = :owner AND c.table_name = :tbl
      ORDER BY c.column_id`,
    { owner: schema, tbl: table }
  );

  const pkResult = await exec(
    connection,
    `SELECT cc.column_name AS "name"
       FROM all_constraints c
       JOIN all_cons_columns cc
         ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
      WHERE c.owner = :owner AND c.table_name = :tbl AND c.constraint_type = 'P'
      ORDER BY cc.position`,
    { owner: schema, tbl: table }
  );

  const indexResult = await exec(
    connection,
    `SELECT i.index_name AS "name",
            i.uniqueness AS "uniqueness",
            ic.column_name AS "columnName",
            ic.column_position AS "columnPosition"
       FROM all_indexes i
       JOIN all_ind_columns ic
         ON ic.index_owner = i.owner AND ic.index_name = i.index_name
      WHERE i.table_owner = :owner AND i.table_name = :tbl
      ORDER BY i.index_name, ic.column_position`,
    { owner: schema, tbl: table }
  );

  const fkResult = await exec(
    connection,
    `SELECT c.constraint_name AS "name",
            cc.column_name    AS "columnName",
            rc.owner          AS "refSchema",
            rc.table_name     AS "refTable",
            rcc.column_name   AS "refColumn",
            cc.position       AS "position"
       FROM all_constraints c
       JOIN all_cons_columns cc
         ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
       JOIN all_constraints rc
         ON rc.owner = c.r_owner AND rc.constraint_name = c.r_constraint_name
       JOIN all_cons_columns rcc
         ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name AND rcc.position = cc.position
      WHERE c.owner = :owner AND c.table_name = :tbl AND c.constraint_type = 'R'
      ORDER BY c.constraint_name, cc.position`,
    { owner: schema, tbl: table }
  );

  const primaryKey = pkResult.rows.map((r) => r.name);

  const indexMap = new Map();
  for (const row of indexResult.rows) {
    if (!indexMap.has(row.name)) {
      indexMap.set(row.name, {
        name: row.name,
        unique: row.uniqueness === 'UNIQUE',
        primary: false,
        columns: [],
      });
    }
    indexMap.get(row.name).columns.push(row.columnName);
  }

  const fkMap = new Map();
  for (const row of fkResult.rows) {
    if (!fkMap.has(row.name)) {
      fkMap.set(row.name, {
        name: row.name,
        columns: [],
        refSchema: row.refSchema,
        refTable: row.refTable,
        refColumns: [],
      });
    }
    const fk = fkMap.get(row.name);
    fk.columns.push(row.columnName);
    fk.refColumns.push(row.refColumn);
  }

  return {
    columns: columnsResult.rows.map((r) => ({
      position: Number(r.position),
      name: r.name,
      dataType: formatOracleType(r),
      nullable: r.nullable === 'Y',
      defaultValue: r.defaultValue === null ? null : String(r.defaultValue).trim(),
      comment: r.comment,
      isPrimaryKey: primaryKey.includes(r.name),
    })),
    primaryKey,
    indexes: [...indexMap.values()].map((idx) => ({
      ...idx,
      definition: `${idx.unique ? 'UNIQUE ' : ''}INDEX ${idx.name} (${idx.columns.join(', ')})`,
    })),
    foreignKeys: [...fkMap.values()].map((fk) => ({
      name: fk.name,
      definition: `FOREIGN KEY (${fk.columns.join(', ')}) REFERENCES ${fk.refSchema}.${fk.refTable} (${fk.refColumns.join(', ')})`,
      ...fk,
    })),
  };
}

/** NUMBER(10,2) / VARCHAR2(50) のように精度付きで表示する。 */
function formatOracleType(col) {
  const type = col.dataType;
  if (['NUMBER', 'FLOAT'].includes(type)) {
    if (col.dataPrecision === null) return type;
    return col.dataScale ? `${type}(${col.dataPrecision},${col.dataScale})` : `${type}(${col.dataPrecision})`;
  }
  if (['VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR', 'RAW'].includes(type)) {
    return `${type}(${col.dataLength})`;
  }
  return type;
}

async function countRows(connection, schema, table, where) {
  assertIdentifier(schema, 'スキーマ名');
  assertIdentifier(table, 'テーブル名');
  const clause = where && where.trim() ? ` WHERE ${where}` : '';
  const result = await exec(
    connection,
    `SELECT COUNT(*) AS "cnt" FROM ${quote(schema)}.${quote(table)}${clause}`
  );
  return Number(result.rows[0].cnt);
}

async function selectRows(connection, schema, table, options = {}) {
  assertIdentifier(schema, 'スキーマ名');
  assertIdentifier(table, 'テーブル名');
  const { limit, offset } = normalizePaging(options);
  const where = options.where && options.where.trim() ? ` WHERE ${options.where}` : '';
  let order = '';
  if (options.orderBy) {
    assertIdentifier(options.orderBy, '並び替え列名');
    order = ` ORDER BY ${quote(options.orderBy)} ${normalizeOrderDir(options.orderDir)}`;
  }
  // 12c 以降の行制限句。ORDER BY が無くても使用できる。
  const sql =
    `SELECT * FROM ${quote(schema)}.${quote(table)}${where}${order}` +
    ` OFFSET :offsetRows ROWS FETCH NEXT :limitRows ROWS ONLY`;
  const result = await exec(connection, sql, { offsetRows: offset, limitRows: limit });
  const columns = result.metaData.map((m) => m.name);
  return {
    columns,
    rows: result.rows.map((row) => serializeRow(row, columns)),
    sql,
    limit,
    offset,
  };
}

async function runQuery(connection, sql, maxRows = 500) {
  const statement = assertReadOnly(sql);
  const result = await exec(connection, statement);
  const columns = result.metaData.map((m) => m.name);
  const rows = result.rows.slice(0, maxRows).map((row) => serializeRow(row, columns));
  return { columns, rows, rowCount: result.rows.length, truncated: result.rows.length > maxRows };
}


/* ---------------- 更新系 ---------------- */

// oracledb は既定で autoCommit=false なので、明示的な BEGIN は不要。
async function begin() {}
async function commit(connection) { await connection.commit(); }
async function rollback(connection) { await connection.rollback(); }

/** WHERE 句を主キー列から組み立てる。値はすべてバインドする。 */
function buildKeyClause(keyColumns, keyValues, binds, prefix) {
  const parts = keyColumns.map((col, i) => {
    assertIdentifier(col, '主キー列名');
    const bind = `${prefix}${i}`;
    binds[bind] = keyValues[col];
    return `${quote(col)} = :${bind}`;
  });
  return parts.join(' AND ');
}

async function insertRow(connection, schema, table, values) {
  assertIdentifier(schema, 'スキーマ名');
  assertIdentifier(table, 'テーブル名');
  const columns = Object.keys(values);
  if (!columns.length) throw badRequest('登録する値が指定されていません。');
  columns.forEach((c) => assertIdentifier(c, '列名'));

  const binds = {};
  const placeholders = columns.map((c, i) => {
    binds[`v${i}`] = values[c];
    return `:v${i}`;
  });
  const sql =
    `INSERT INTO ${quote(schema)}.${quote(table)} (${columns.map(quote).join(', ')})` +
    ` VALUES (${placeholders.join(', ')})`;
  const result = await connection.execute(sql, binds, { autoCommit: false });
  return { affected: result.rowsAffected || 0, sql };
}

async function updateRow(connection, schema, table, keyColumns, keyValues, values) {
  assertIdentifier(schema, 'スキーマ名');
  assertIdentifier(table, 'テーブル名');
  const columns = Object.keys(values);
  if (!columns.length) throw badRequest('変更された列がありません。');
  columns.forEach((c) => assertIdentifier(c, '列名'));

  const binds = {};
  const setParts = columns.map((c, i) => {
    binds[`v${i}`] = values[c];
    return `${quote(c)} = :v${i}`;
  });
  const where = buildKeyClause(keyColumns, keyValues, binds, 'k');
  const sql = `UPDATE ${quote(schema)}.${quote(table)} SET ${setParts.join(', ')} WHERE ${where}`;
  const result = await connection.execute(sql, binds, { autoCommit: false });
  return { affected: result.rowsAffected || 0, sql };
}

async function deleteRow(connection, schema, table, keyColumns, keyValues) {
  assertIdentifier(schema, 'スキーマ名');
  assertIdentifier(table, 'テーブル名');
  const binds = {};
  const where = buildKeyClause(keyColumns, keyValues, binds, 'k');
  const sql = `DELETE FROM ${quote(schema)}.${quote(table)} WHERE ${where}`;
  const result = await connection.execute(sql, binds, { autoCommit: false });
  return { affected: result.rowsAffected || 0, sql };
}

async function executeWrite(connection, sql) {
  const statement = assertSingleStatement(sql);
  const result = await connection.execute(statement, {}, { autoCommit: false });
  return { affected: result.rowsAffected || 0, sql: statement };
}

module.exports = {
  id: 'oracle',
  label: 'Oracle Database',
  defaultPort: 1521,
  supportsDatabaseSwitch: false,
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
  serializeValue,
};
