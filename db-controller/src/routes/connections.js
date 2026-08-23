'use strict';

const express = require('express');
const store = require('../store');
const pool = require('../pool');
const { driverCatalog, getDriver } = require('../drivers');

const router = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** 対応DB種別の一覧 (画面のプルダウン用) */
router.get('/drivers', (req, res) => {
  res.json({ drivers: driverCatalog() });
});

/** 登録済み接続の一覧 */
router.get('/', (req, res) => {
  res.json({ connections: store.list(), sessions: pool.activeSessions() });
});

router.get('/:id', (req, res) => {
  const conn = store.get(req.params.id);
  if (!conn) return res.status(404).json({ error: '接続が見つかりません。' });
  res.json({ connection: conn });
});

router.post('/', wrap(async (req, res) => {
  const created = store.create(req.body || {});
  res.status(201).json({ connection: created });
}));

router.put('/:id', wrap(async (req, res) => {
  const updated = store.update(req.params.id, req.body || {});
  // 設定が変わったので既存の接続は張り直す
  await pool.releaseAll(req.params.id);
  res.json({ connection: updated });
}));

router.delete('/:id', wrap(async (req, res) => {
  await pool.releaseAll(req.params.id);
  store.remove(req.params.id);
  res.json({ ok: true });
}));

/**
 * 接続テスト。
 * 保存済みプロファイル (`:id`) でも、未保存のフォーム入力でもテストできる。
 */
router.post('/:id/test', wrap(async (req, res) => {
  const conn = store.getRuntime(req.params.id);
  if (!conn) return res.status(404).json({ error: '接続が見つかりません。' });
  const started = Date.now();
  const info = await pool.withTemporary(conn, req.body && req.body.database, (driver, client) =>
    driver.serverInfo(client)
  );
  res.json({ ok: true, elapsedMs: Date.now() - started, info });
}));

router.post('/test', wrap(async (req, res) => {
  const input = req.body || {};
  const driver = getDriver(input.type);
  const conn = {
    ...input,
    port: Number(input.port) || driver.defaultPort,
    password: input.password || '',
  };
  // 既存プロファイルを編集中でパスワードが伏せられている場合は保存済みの値を使う
  if (!conn.password && input.id) {
    const saved = store.getRuntime(input.id);
    if (saved) conn.password = saved.password;
  }
  const started = Date.now();
  const info = await pool.withTemporary(conn, input.database, (d, client) => d.serverInfo(client));
  res.json({ ok: true, elapsedMs: Date.now() - started, info });
}));

/** 接続を明示的に切断する */
router.post('/:id/disconnect', wrap(async (req, res) => {
  await pool.releaseAll(req.params.id);
  res.json({ ok: true, sessions: pool.activeSessions() });
}));

module.exports = router;
