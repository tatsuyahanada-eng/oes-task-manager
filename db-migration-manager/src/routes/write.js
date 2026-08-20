'use strict';

/**
 * 更新系 API。安全側に倒すため、次の条件をすべて満たさなければ実行しない。
 *
 *  1. 接続プロファイルが読み取り専用でないこと (既定は読み取り専用)
 *  2. 対象テーブルに主キーがあること (行を一意に特定できること)
 *  3. トランザクション内で実行し、影響行数がちょうど 1 行であること
 *     (0 行 = 対象が既に無い / 2 行以上 = キーの指定ミス。いずれもロールバックする)
 */

const express = require('express');
const pool = require('../pool');
const store = require('../store');
const audit = require('../audit');
const { assertRowKey, normalizeInputValue, classifyStatement, badRequest } = require('../drivers/util');

const router = express.Router({ mergeParams: true });

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** 読み取り専用の接続では更新系を一切通さない。 */
function assertWritable(connectionId) {
  const conn = store.get(connectionId);
  if (!conn) {
    const e = new Error('接続が見つかりません。');
    e.status = 404;
    throw e;
  }
  // 明示的に false でない限り読み取り専用として扱う。
  // (この機能より前に保存されたプロファイルには readOnly が無いため、未設定は安全側に倒す)
  if (conn.readOnly !== false) {
    const e = new Error(
      `接続「${conn.name}」は読み取り専用です。データを変更するには、接続設定で「読み取り専用」を解除してください。`
    );
    e.status = 403;
    throw e;
  }
  return conn;
}

async function session(req) {
  const database = (req.body && req.body.database) || req.query.database || '';
  return pool.acquire(req.params.connectionId, database);
}

/** { col: {value, isNull} } 形式の入力を { col: 値 } に変換する。 */
function toValueMap(fields) {
  if (!fields || typeof fields !== 'object') return {};
  const out = {};
  for (const [col, field] of Object.entries(fields)) {
    out[col] = normalizeInputValue(field);
  }
  return out;
}

/**
 * トランザクション内で 1 行だけの更新を実行する。
 * 影響行数が 1 でなければロールバックし、何が起きたかを伝える。
 */
async function runSingleRowChange(s, operation, describe) {
  await s.driver.begin(s.client);
  let result;
  try {
    result = await operation();
  } catch (err) {
    await s.driver.rollback(s.client).catch(() => {});
    throw err;
  }

  if (result.affected !== 1) {
    await s.driver.rollback(s.client).catch(() => {});
    const reason =
      result.affected === 0
        ? '対象の行が見つかりませんでした。他の利用者が既に変更・削除した可能性があります。'
        : `${result.affected} 行が対象になりました。1 行だけを対象にできないため取り消しました。`;
    throw badRequest(`${describe}は実行されませんでした。${reason}`);
  }

  await s.driver.commit(s.client);
  return result;
}

/** 対象テーブルの主キーを取得する。 */
async function primaryKeyOf(s, schema, table) {
  const detail = await s.driver.describeTable(s.client, schema, table);
  return { primaryKey: detail.primaryKey, columns: detail.columns };
}

/* ---------------- 行の追加 ---------------- */

router.post('/tables/:schema/:table/rows', wrap(async (req, res) => {
  const conn = assertWritable(req.params.connectionId);
  const { schema, table } = req.params;
  const s = await session(req);
  const values = toValueMap(req.body && req.body.fields);

  await s.driver.begin(s.client);
  let result;
  try {
    result = await s.driver.insertRow(s.client, schema, table, values);
    await s.driver.commit(s.client);
  } catch (err) {
    await s.driver.rollback(s.client).catch(() => {});
    throw err;
  }

  audit.record({
    action: 'insert',
    connection: conn.name,
    type: conn.type,
    database: s.database,
    target: `${schema}.${table}`,
    affected: result.affected,
    sql: result.sql,
  });
  res.json({ ok: true, affected: result.affected, sql: result.sql });
}));

/* ---------------- 行の更新 ---------------- */

router.patch('/tables/:schema/:table/rows', wrap(async (req, res) => {
  const conn = assertWritable(req.params.connectionId);
  const { schema, table } = req.params;
  const s = await session(req);

  const { primaryKey } = await primaryKeyOf(s, schema, table);
  const keyValues = toValueMap(req.body && req.body.key);
  assertRowKey(primaryKey, keyValues);

  const values = toValueMap(req.body && req.body.fields);
  if (!Object.keys(values).length) throw badRequest('変更された列がありません。');

  const result = await runSingleRowChange(
    s,
    () => s.driver.updateRow(s.client, schema, table, primaryKey, keyValues, values),
    '更新'
  );

  audit.record({
    action: 'update',
    connection: conn.name,
    type: conn.type,
    database: s.database,
    target: `${schema}.${table}`,
    key: keyValues,
    changed: Object.keys(values),
    affected: result.affected,
    sql: result.sql,
  });
  res.json({ ok: true, affected: result.affected, sql: result.sql });
}));

/* ---------------- 行の削除 ---------------- */

router.delete('/tables/:schema/:table/rows', wrap(async (req, res) => {
  const conn = assertWritable(req.params.connectionId);
  const { schema, table } = req.params;
  const s = await session(req);

  const { primaryKey } = await primaryKeyOf(s, schema, table);
  const keyValues = toValueMap(req.body && req.body.key);
  assertRowKey(primaryKey, keyValues);

  const result = await runSingleRowChange(
    s,
    () => s.driver.deleteRow(s.client, schema, table, primaryKey, keyValues),
    '削除'
  );

  audit.record({
    action: 'delete',
    connection: conn.name,
    type: conn.type,
    database: s.database,
    target: `${schema}.${table}`,
    key: keyValues,
    affected: result.affected,
    sql: result.sql,
  });
  res.json({ ok: true, affected: result.affected, sql: result.sql });
}));

/* ---------------- 更新系 SQL の実行 ---------------- */

router.post('/execute', wrap(async (req, res) => {
  const conn = assertWritable(req.params.connectionId);
  const { sql, confirm } = req.body || {};

  const kind = classifyStatement(sql);
  if (kind === 'read') {
    throw badRequest('参照 SQL は「SQL 実行」から実行してください。');
  }
  if (kind === 'other') {
    throw badRequest(
      'この画面から実行できるのは INSERT / UPDATE / DELETE / MERGE のみです。' +
        'DDL (CREATE / DROP / ALTER / TRUNCATE) は受け付けません。'
    );
  }
  // 画面側の確認ダイアログを通っていない要求は受け付けない
  if (confirm !== true) throw badRequest('実行前の確認が行われていません。');

  const s = await session(req);
  await s.driver.begin(s.client);
  let result;
  try {
    result = await s.driver.executeWrite(s.client, sql);
    await s.driver.commit(s.client);
  } catch (err) {
    await s.driver.rollback(s.client).catch(() => {});
    throw err;
  }

  audit.record({
    action: 'execute',
    connection: conn.name,
    type: conn.type,
    database: s.database,
    affected: result.affected,
    sql: result.sql,
  });
  res.json({ ok: true, affected: result.affected, sql: result.sql });
}));

/* ---------------- 操作履歴 ---------------- */

router.get('/audit', (req, res) => {
  res.json({ entries: audit.recent(Number(req.query.limit) || 100) });
});

module.exports = router;
