'use strict';

/** ログイン・ログアウト・パスワード変更の API。 */

const express = require('express');
const session = require('../session');
const audit = require('../audit');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.post('/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const result = session.login(req, res, username, password);
  audit.record({
    action: 'login',
    connection: '-',
    target: result.username,
    sql: `ログイン (${session.clientIp(req)})`,
  });
  res.json({ ok: true, ...result });
}));

router.post('/logout', (req, res) => {
  const current = session.currentSession(req);
  session.logout(req, res);
  if (current) {
    audit.record({ action: 'logout', connection: '-', target: current.username, sql: 'ログアウト' });
  }
  res.json({ ok: true });
});

/** ログイン状態の確認。画面の起動時に呼ぶ。 */
router.get('/me', (req, res) => {
  const current = session.currentSession(req);
  if (!current) return res.status(401).json({ error: 'ログインしていません。', needLogin: true });
  const account = session.readAccount() || {};
  res.json({
    username: current.username,
    isDefaultPassword: Boolean(account.isDefaultPassword),
    loginAt: new Date(current.createdAt).toISOString(),
    idleTimeoutMinutes: Math.floor(session.IDLE_MS / 60000),
  });
});

router.post('/password', wrap(async (req, res) => {
  const current = session.currentSession(req);
  if (!current) return res.status(401).json({ error: 'ログインが必要です。', needLogin: true });

  const { currentPassword, newPassword } = req.body || {};
  session.changePassword(currentPassword, newPassword);
  audit.record({
    action: 'password',
    connection: '-',
    target: current.username,
    sql: 'パスワード変更（全セッションを無効化）',
  });
  // セッションを作り直して、変更した本人だけログインを続けられるようにする
  session.logout(req, res);
  res.json({ ok: true, message: 'パスワードを変更しました。もう一度ログインしてください。' });
}));

module.exports = router;
