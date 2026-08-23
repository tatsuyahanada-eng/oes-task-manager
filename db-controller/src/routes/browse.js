'use strict';

/**
 * データベース参照系 API。
 * すべて  /api/db/:connectionId/...  配下で、`?database=` によりDBを切り替える。
 */

const express = require('express');
const pool = require('../pool');

const router = express.Router({ mergeParams: true });

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** リクエストから接続セッションを取り出す。 */
async function session(req) {
  const database = req.query.database || (req.body && req.body.database) || '';
  return pool.acquire(req.params.connectionId, database);
}

router.get('/info', wrap(async (req, res) => {
  const s = await session(req);
  const info = await s.driver.serverInfo(s.client);
  res.json({
    info,
    type: s.type,
    database: s.database,
    supportsDatabaseSwitch: s.driver.supportsDatabaseSwitch,
    connectedAt: new Date(s.connectedAt).toISOString(),
  });
}));

/** データベース一覧 (Oracle は空配列 = 切り替え非対応) */
router.get('/databases', wrap(async (req, res) => {
  const s = await session(req);
  const databases = await s.driver.listDatabases(s.client);
  res.json({
    databases,
    current: s.database,
    supportsDatabaseSwitch: s.driver.supportsDatabaseSwitch,
  });
}));

router.get('/schemas', wrap(async (req, res) => {
  const s = await session(req);
  const schemas = await s.driver.listSchemas(s.client);
  res.json({ schemas, database: s.database });
}));

router.get('/tables', wrap(async (req, res) => {
  const schema = req.query.schema;
  if (!schema) return res.status(400).json({ error: 'schema は必須です。' });
  const s = await session(req);
  const tables = await s.driver.listTables(s.client, schema);
  res.json({ tables, schema, database: s.database });
}));

/** テーブル定義 (列・主キー・索引・外部キー) */
router.get('/tables/:schema/:table', wrap(async (req, res) => {
  const { schema, table } = req.params;
  const s = await session(req);
  const detail = await s.driver.describeTable(s.client, schema, table);
  res.json({ schema, table, database: s.database, ...detail });
}));

/** 正確な件数 (COUNT(*)。大きなテーブルでは時間がかかる) */
router.get('/tables/:schema/:table/count', wrap(async (req, res) => {
  const { schema, table } = req.params;
  const s = await session(req);
  const count = await s.driver.countRows(s.client, schema, table, req.query.where);
  res.json({ schema, table, count });
}));

/** データ参照 (ページング・絞り込み・並び替え) */
router.get('/tables/:schema/:table/rows', wrap(async (req, res) => {
  const { schema, table } = req.params;
  const s = await session(req);
  const result = await s.driver.selectRows(s.client, schema, table, {
    limit: req.query.limit,
    offset: req.query.offset,
    orderBy: req.query.orderBy,
    orderDir: req.query.orderDir,
    where: req.query.where,
  });
  res.json({ schema, table, database: s.database, ...result });
}));

/** 任意 SQL の実行 (現行スコープでは SELECT / WITH のみ) */
router.post('/query', wrap(async (req, res) => {
  const { sql, maxRows } = req.body || {};
  const s = await session(req);
  const started = Date.now();
  const result = await s.driver.runQuery(s.client, sql, Math.min(Number(maxRows) || 500, 5000));
  res.json({ ...result, elapsedMs: Date.now() - started, database: s.database });
}));

module.exports = router;
