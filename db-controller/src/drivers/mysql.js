'use strict';

/**
 * MySQL / MariaDB 用のドライバ。
 *
 * MySQL には PostgreSQL のような「データベースの中のスキーマ」という階層が無く、
 * データベース = スキーマ である。
 * 画面の階層を他の DB と揃えるため、スキーマ一覧には接続中のデータベースだけを返す。
 *
 * ロリポップなどの共用サーバでは、データベース名にハイフンが含まれることがある
 * (例: LAA1234567-shop)。識別子は必ずバッククォートで囲む。
 */

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
    return require('mysql2/promise');
  } catch (err) {
    const e = new Error('MySQL ドライバが未インストールです。`npm install mysql2` を実行してください。');
    e.status = 500;
    throw e;
  }
}

/** MySQL の識別子引用。内部のバッククォートは 2 個にする。 */
function quote(name) {
  return `\`${String(name).replace(/`/g, '``')}\``;
}

/** MySQL 自身が使うデータベース。一覧から隠す。 */
const SYSTEM_DATABASES = ['information_schema', 'mysql', 'performance_schema', 'sys'];

async function connect(conn, database) {
  const mysql = requireDriver();
  const connection = await mysql.createConnection({
    host: conn.host,
    port: conn.port || 3306,
    user: conn.username,
    password: conn.password,
    database: database || conn.database || undefined,
    ssl: conn.ssl ? { rejectUnauthorized: false } : undefined,
    connectTimeout: 15000,
    charset: 'utf8mb4',
    // 数値や日付を素直な形で受け取る
    dateStrings: true,        // DATE / DATETIME は文字列のまま (タイムゾーンでずらさない)
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false, // 複文を禁止する
    timezone: 'Z',
  });
  return connection;
}

async function close(connection) {
  await connection.end();
}

async function serverInfo(connection) {
  const [rows] = await connection.query(
    'SELECT VERSION() AS version, DATABASE() AS db, CURRENT_USER() AS usr'
  );
  return { version: rows[0].version, database: rows[0].db, user: rows[0].usr };
}

async function listDatabases(connection) {
  const [rows] = await connection.query('SHOW DATABASES');
  return rows
    .map((r) => ({ name: Object.values(r)[0] }))
    .filter((d) => !SYSTEM_DATABASES.includes(d.name));
}

/**
 * MySQL ではデータベースがスキーマそのもの。
 * 画面の階層を揃えるため、接続中のデータベースを 1 件だけ返す。
 */
async function listSchemas(connection) {
  const [rows] = await connection.query('SELECT DATABASE() AS db');
  const current = rows[0].db;
  if (!current) {
    // データベース未選択のときは、選べるものを列挙する
    const dbs = await listDatabases(connection);
    return dbs.map((d) => ({ name: d.name, objectCount: 0 }));
  }
  const [counts] = await connection.query(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
    [current]
  );
  return [{ name: current, objectCount: Number(counts[0].n) }];
}

async function listTables(connection, schema) {
  const [rows] = await connection.query(
    `SELECT TABLE_NAME AS name,
            CASE WHEN TABLE_TYPE = 'VIEW' THEN 'VIEW' ELSE 'TABLE' END AS type,
            TABLE_ROWS AS estimated_rows,
            TABLE_COMMENT AS comment
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME`,
    [schema]
  );
  return rows.map((r) => ({
    schema,
    name: r.name,
    type: r.type,
    estimatedRows: r.type === 'VIEW' || r.estimated_rows === null ? null : Number(r.estimated_rows),
    comment: r.comment || null,
  }));
}

async function describeTable(connection, schema, table) {
  const [columns] = await connection.query(
    `SELECT ORDINAL_POSITION AS position,
            COLUMN_NAME      AS name,
            COLUMN_TYPE      AS data_type,
            IS_NULLABLE      AS nullable,
            COLUMN_DEFAULT   AS default_value,
            COLUMN_COMMENT   AS comment,
            EXTRA            AS extra,
            COLUMN_KEY       AS column_key
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [schema, table]
  );

  const [indexRows] = await connection.query(
    `SELECT INDEX_NAME  AS index_name,
            NON_UNIQUE  AS non_unique,
            COLUMN_NAME AS column_name,
            SEQ_IN_INDEX AS seq
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY (INDEX_NAME = 'PRIMARY') DESC, INDEX_NAME, SEQ_IN_INDEX`,
    [schema, table]
  );

  const [fkRows] = await connection.query(
    `SELECT k.CONSTRAINT_NAME        AS fk_name,
            k.COLUMN_NAME            AS column_name,
            k.REFERENCED_TABLE_SCHEMA AS ref_schema,
            k.REFERENCED_TABLE_NAME  AS ref_table,
            k.REFERENCED_COLUMN_NAME AS ref_column,
            k.ORDINAL_POSITION       AS ordinal
       FROM information_schema.KEY_COLUMN_USAGE k
      WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ?
        AND k.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
    [schema, table]
  );

  const primaryKey = indexRows.filter((r) => r.index_name === 'PRIMARY').map((r) => r.column_name);

  const indexMap = new Map();
  for (const row of indexRows) {
    if (!indexMap.has(row.index_name)) {
      indexMap.set(row.index_name, {
        name: row.index_name,
        unique: Number(row.non_unique) === 0,
        primary: row.index_name === 'PRIMARY',
        columns: [],
      });
    }
    indexMap.get(row.index_name).columns.push(row.column_name);
  }

  const fkMap = new Map();
  for (const row of fkRows) {
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
    columns: columns.map((c) => ({
      position: Number(c.position),
      name: c.name,
      dataType: c.data_type,
      nullable: c.nullable === 'YES',
      defaultValue: c.default_value,
      comment: c.comment || null,
      isIdentity: String(c.extra || '').includes('auto_increment'),
      isPrimaryKey: primaryKey.includes(c.name),
    })),
    primaryKey,
    indexes: [...indexMap.values()].map((idx) => ({
      ...idx,
      definition: `${idx.primary ? 'PRIMARY KEY ' : idx.unique ? 'UNIQUE ' : ''}` +
        `${idx.primary ? '' : `INDEX ${idx.name} `}(${idx.columns.join(', ')})`,
    })),
    foreignKeys: [...fkMap.values()].map((fk) => ({
      ...fk,
      definition: `FOREIGN KEY (${fk.columns.join(', ')}) REFERENCES ` +
        `${fk.refSchema === schema ? '' : `${fk.refSchema}.`}${fk.refTable} (${fk.refColumns.join(', ')})`,
    })),
  };
}

async function countRows(connection, schema, table, where) {
  assertIdentifier(schema, 'スキーマ名');
  assertIdentifier(table, 'テーブル名');
  const clause = where && where.trim() ? ` WHERE ${where}` : '';
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS cnt FROM ${quote(schema)}.${quote(table)}${clause}`
  );
  return Number(rows[0].cnt);
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
  // LIMIT / OFFSET は検証済みの数値なので、そのまま埋め込んで良い
  const sql = `SELECT * FROM ${quote(schema)}.${quote(table)}${where}${order} LIMIT ${limit} OFFSET ${offset}`;
  const [rows, fields] = await connection.query(sql);
  const columns = fields.map((f) => f.name);
  return {
    columns,
    rows: rows.map((row) => serializeRow(row, columns)),
    sql,
    limit,
    offset,
  };
}

async function runQuery(connection, sql, maxRows = 500) {
  const statement = assertReadOnly(sql);
  const [rows, fields] = await connection.query(statement);
  const columns = (fields || []).map((f) => f.name);
  const all = Array.isArray(rows) ? rows : [];
  return {
    columns,
    rows: all.slice(0, maxRows).map((row) => serializeRow(row, columns)),
    rowCount: all.length,
    truncated: all.length > maxRows,
  };
}

/* ---------------- 更新系 ---------------- */

async function begin(connection) { await connection.beginTransaction(); }
async function commit(connection) { await connection.commit(); }
async function rollback(connection) { await connection.rollback(); }

/** WHERE 句を主キー列から組み立てる。値はすべてバインドする。 */
function buildKeyClause(keyColumns, keyValues, params) {
  return keyColumns.map((col) => {
    assertIdentifier(col, '主キー列名');
    params.push(keyValues[col]);
    return `${quote(col)} = ?`;
  }).join(' AND ');
}

async function insertRow(connection, schema, table, values) {
  assertIdentifier(schema, 'スキーマ名');
  assertIdentifier(table, 'テーブル名');
  const columns = Object.keys(values);
  if (!columns.length) throw badRequest('登録する値が指定されていません。');
  columns.forEach((c) => assertIdentifier(c, '列名'));

  const sql =
    `INSERT INTO ${quote(schema)}.${quote(table)} (${columns.map(quote).join(', ')})` +
    ` VALUES (${columns.map(() => '?').join(', ')})`;
  const [result] = await connection.execute(sql, columns.map((c) => values[c]));
  return { affected: result.affectedRows || 0, sql };
}

async function updateRow(connection, schema, table, keyColumns, keyValues, values) {
  assertIdentifier(schema, 'スキーマ名');
  assertIdentifier(table, 'テーブル名');
  const columns = Object.keys(values);
  if (!columns.length) throw badRequest('変更された列がありません。');
  columns.forEach((c) => assertIdentifier(c, '列名'));

  const params = columns.map((c) => values[c]);
  const setParts = columns.map((c) => `${quote(c)} = ?`);
  const where = buildKeyClause(keyColumns, keyValues, params);
  const sql = `UPDATE ${quote(schema)}.${quote(table)} SET ${setParts.join(', ')} WHERE ${where}`;
  const [result] = await connection.execute(sql, params);
  // MySQL の affectedRows は「値が変わらなかった行」を 0 と数えることがあるため、
  // 一致した行数 (changedRows ではなく affectedRows) の判定には注意が必要。
  // ここでは info の matched を優先して見る。
  const matched = typeof result.info === 'string' && /Rows matched: (\d+)/.exec(result.info)
    ? Number(/Rows matched: (\d+)/.exec(result.info)[1])
    : result.affectedRows;
  return { affected: matched || 0, sql };
}

async function deleteRow(connection, schema, table, keyColumns, keyValues) {
  assertIdentifier(schema, 'スキーマ名');
  assertIdentifier(table, 'テーブル名');
  const params = [];
  const where = buildKeyClause(keyColumns, keyValues, params);
  const sql = `DELETE FROM ${quote(schema)}.${quote(table)} WHERE ${where}`;
  const [result] = await connection.execute(sql, params);
  return { affected: result.affectedRows || 0, sql };
}

async function executeWrite(connection, sql) {
  const statement = assertSingleStatement(sql);
  const [result] = await connection.query(statement);
  return { affected: (result && result.affectedRows) || 0, sql: statement };
}

module.exports = {
  id: 'mysql',
  label: 'MySQL / MariaDB',
  defaultPort: 3306,
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
  serializeValue,
};
