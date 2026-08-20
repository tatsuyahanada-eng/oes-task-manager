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

const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];

let parsersConfigured = false;

/**
 * date / timestamp without time zone には時差の情報が無いため、
 * JS の Date に変換するとローカルタイムゾーンの分だけずれる。
 * 移行ツールでは DB が返した文字列をそのまま見せる。
 */
function configureTypeParsers(pg) {
  if (parsersConfigured) return;
  pg.types.setTypeParser(1082, (v) => v); // date
  pg.types.setTypeParser(1114, (v) => v); // timestamp without time zone
  pg.types.setTypeParser(1083, (v) => v); // time
  parsersConfigured = true;
}

function requireDriver() {
  try {
    const pg = require('pg');
    configureTypeParsers(pg);
    return pg;
  } catch (err) {
    const e = new Error('PostgreSQL ドライバが未インストールです。`npm install pg` を実行してください。');
    e.status = 500;
    throw e;
  }
}

/** PostgreSQL の識別子引用。埋め込み前に " をエスケープする。 */
function quote(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function connect(conn, database) {
  const { Client } = requireDriver();
  const client = new Client({
    host: conn.host,
    port: conn.port || 5432,
    user: conn.username,
    password: conn.password,
    database: database || conn.database || 'postgres',
    ssl: conn.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 15000,
    statement_timeout: 120000,
    application_name: 'db-migration-manager',
  });
  await client.connect();
  return client;
}

async function close(client) {
  await client.end();
}

async function serverInfo(client) {
  const { rows } = await client.query(
    'SELECT version() AS version, current_database() AS db, current_user AS usr'
  );
  return { version: rows[0].version, database: rows[0].db, user: rows[0].usr };
}

async function listDatabases(client) {
  const { rows } = await client.query(
    `SELECT datname AS name
       FROM pg_database
      WHERE datallowconn AND NOT datistemplate
      ORDER BY datname`
  );
  return rows.map((r) => ({ name: r.name }));
}

async function listSchemas(client) {
  const { rows } = await client.query(
    `SELECT n.nspname AS name,
            COUNT(c.oid) FILTER (WHERE c.relkind IN ('r','p','v','m')) AS object_count
       FROM pg_namespace n
       LEFT JOIN pg_class c ON c.relnamespace = n.oid
      WHERE n.nspname <> ALL($1::text[])
        AND n.nspname NOT LIKE 'pg\\_temp%'
      GROUP BY n.nspname
      ORDER BY n.nspname`,
    [SYSTEM_SCHEMAS]
  );
  return rows.map((r) => ({ name: r.name, objectCount: Number(r.object_count) }));
}

async function listTables(client, schema) {
  const { rows } = await client.query(
    `SELECT c.relname AS name,
            CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END AS type,
            c.reltuples::bigint AS estimated_rows,
            pg_catalog.obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m')
      ORDER BY c.relname`,
    [schema]
  );
  return rows.map((r) => ({
    schema,
    name: r.name,
    type: r.type,
    estimatedRows: Number(r.estimated_rows) < 0 ? null : Number(r.estimated_rows),
    comment: r.comment || null,
  }));
}

async function describeTable(client, schema, table) {
  const columnsQuery = await client.query(
    `SELECT a.attnum AS position,
            a.attname AS name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
            NOT a.attnotnull AS nullable,
            pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_value,
            pg_catalog.col_description(a.attrelid, a.attnum) AS comment
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [schema, table]
  );

  const indexQuery = await client.query(
    `SELECT i.relname AS name,
            ix.indisunique AS is_unique,
            ix.indisprimary AS is_primary,
            pg_catalog.pg_get_indexdef(ix.indexrelid) AS definition,
            ARRAY(
              SELECT pg_catalog.pg_get_indexdef(ix.indexrelid, k + 1, true)
                FROM generate_subscripts(ix.indkey, 1) AS k
               ORDER BY k
            ) AS columns
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_class c ON c.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2
      ORDER BY ix.indisprimary DESC, i.relname`,
    [schema, table]
  );

  const fkQuery = await client.query(
    `SELECT con.conname AS name,
            pg_catalog.pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'f'
      ORDER BY con.conname`,
    [schema, table]
  );

  const primary = indexQuery.rows.find((r) => r.is_primary);
  const primaryKey = primary ? primary.columns : [];

  return {
    columns: columnsQuery.rows.map((r) => ({
      position: Number(r.position),
      name: r.name,
      dataType: r.data_type,
      nullable: r.nullable,
      defaultValue: r.default_value,
      comment: r.comment,
      isPrimaryKey: primaryKey.includes(r.name),
    })),
    primaryKey,
    indexes: indexQuery.rows.map((r) => ({
      name: r.name,
      unique: r.is_unique,
      primary: r.is_primary,
      columns: r.columns,
      definition: r.definition,
    })),
    foreignKeys: fkQuery.rows.map((r) => ({ name: r.name, definition: r.definition })),
  };
}

async function countRows(client, schema, table, where) {
  assertIdentifier(schema, 'スキーマ名');
  assertIdentifier(table, 'テーブル名');
  const clause = where && where.trim() ? ` WHERE ${where}` : '';
  const { rows } = await client.query(
    `SELECT COUNT(*)::bigint AS cnt FROM ${quote(schema)}.${quote(table)}${clause}`
  );
  return Number(rows[0].cnt);
}

async function selectRows(client, schema, table, options = {}) {
  assertIdentifier(schema, 'スキーマ名');
  assertIdentifier(table, 'テーブル名');
  const { limit, offset } = normalizePaging(options);
  const where = options.where && options.where.trim() ? ` WHERE ${options.where}` : '';
  let order = '';
  if (options.orderBy) {
    assertIdentifier(options.orderBy, '並び替え列名');
    order = ` ORDER BY ${quote(options.orderBy)} ${normalizeOrderDir(options.orderDir)}`;
  }
  const sql = `SELECT * FROM ${quote(schema)}.${quote(table)}${where}${order} LIMIT $1 OFFSET $2`;
  const result = await client.query({ text: sql, values: [limit, offset], rowMode: 'array' });
  return {
    columns: result.fields.map((f) => f.name),
    rows: result.rows.map((row) => row.map(serializeValue)),
    sql,
    limit,
    offset,
  };
}

async function runQuery(client, sql, maxRows = 500) {
  const statement = assertReadOnly(sql);
  const result = await client.query({ text: statement, rowMode: 'array' });
  const rows = result.rows.slice(0, maxRows).map((row) => row.map(serializeValue));
  return {
    columns: result.fields.map((f) => f.name),
    rows,
    rowCount: result.rows.length,
    truncated: result.rows.length > maxRows,
  };
}


/* ---------------- 更新系 ---------------- */

async function begin(client) { await client.query('BEGIN'); }
async function commit(client) { await client.query('COMMIT'); }
async function rollback(client) { await client.query('ROLLBACK'); }

/** WHERE 句を主キー列から組み立てる。値はすべてバインドする。 */
function buildKeyClause(keyColumns, keyValues, startIndex) {
  const params = [];
  const parts = keyColumns.map((col, i) => {
    assertIdentifier(col, '主キー列名');
    params.push(keyValues[col]);
    return `${quote(col)} = $${startIndex + i}`;
  });
  return { clause: parts.join(' AND '), params };
}

async function insertRow(client, schema, table, values) {
  assertIdentifier(schema, 'スキーマ名');
  assertIdentifier(table, 'テーブル名');
  const columns = Object.keys(values);
  if (!columns.length) throw badRequest('登録する値が指定されていません。');
  columns.forEach((c) => assertIdentifier(c, '列名'));

  const sql =
    `INSERT INTO ${quote(schema)}.${quote(table)} (${columns.map(quote).join(', ')})` +
    ` VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`;
  const result = await client.query(sql, columns.map((c) => values[c]));
  return { affected: result.rowCount, sql };
}

async function updateRow(client, schema, table, keyColumns, keyValues, values) {
  assertIdentifier(schema, 'スキーマ名');
  assertIdentifier(table, 'テーブル名');
  const columns = Object.keys(values);
  if (!columns.length) throw badRequest('変更された列がありません。');
  columns.forEach((c) => assertIdentifier(c, '列名'));

  const setParts = columns.map((c, i) => `${quote(c)} = $${i + 1}`);
  const key = buildKeyClause(keyColumns, keyValues, columns.length + 1);
  const sql =
    `UPDATE ${quote(schema)}.${quote(table)} SET ${setParts.join(', ')} WHERE ${key.clause}`;
  const result = await client.query(sql, [...columns.map((c) => values[c]), ...key.params]);
  return { affected: result.rowCount, sql };
}

async function deleteRow(client, schema, table, keyColumns, keyValues) {
  assertIdentifier(schema, 'スキーマ名');
  assertIdentifier(table, 'テーブル名');
  const key = buildKeyClause(keyColumns, keyValues, 1);
  const sql = `DELETE FROM ${quote(schema)}.${quote(table)} WHERE ${key.clause}`;
  const result = await client.query(sql, key.params);
  return { affected: result.rowCount, sql };
}

/** SQL実行タブからの更新系ステートメント。 */
async function executeWrite(client, sql) {
  const statement = assertSingleStatement(sql);
  const result = await client.query(statement);
  return { affected: result.rowCount === null ? 0 : result.rowCount, sql: statement };
}

module.exports = {
  id: 'postgres',
  label: 'PostgreSQL',
  defaultPort: 5432,
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
