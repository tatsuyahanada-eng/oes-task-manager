'use strict';

/** ログイン・ログアウト・パスワード変更・利用者管理の API。 */

const express = require('express');
const session = require('../session');
const users = require('../users');
const audit = require('../audit');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------
 * ログイン
 * ---------------------------------------------------------- */

router.post('/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const result = session.login(req, res, username, password);
  audit.record({
    action: 'login',
    user: result.username,
    connection: '-',
    target: result.username,
    sql: `ログイン (${result.role} / ${session.clientIp(req)})`,
  });
  res.json({ ok: true, ...result });
}));

router.post('/logout', (req, res) => {
  const current = session.currentSession(req);
  session.logout(req, res);
  if (current) {
    audit.record({
      action: 'logout', user: current.username, connection: '-',
      target: current.username, sql: 'ログアウト',
    });
  }
  res.json({ ok: true });
});

/** ログイン状態の確認。画面の起動時に呼ぶ。 */
router.get('/me', (req, res) => {
  const current = session.currentSession(req);
  if (!current) return res.status(401).json({ error: 'ログインしていません。', needLogin: true });
  const user = users.find(current.username);
  res.json({
    username: current.username,
    role: current.role,
    roleLabel: users.ROLES[current.role] ? users.ROLES[current.role].label : current.role,
    canManageUsers: users.hasRole(current, 'admin'),
    canWrite: users.hasRole(current, 'operator'),
    isDefaultPassword: Boolean(user && user.isDefaultPassword),
    loginAt: new Date(current.createdAt).toISOString(),
    idleTimeoutMinutes: Math.floor(session.IDLE_MS / 60000),
  });
});

/** 本人によるパスワード変更。 */
router.post('/password', wrap(async (req, res) => {
  const current = session.currentSession(req);
  if (!current) return res.status(401).json({ error: 'ログインが必要です。', needLogin: true });

  const { currentPassword, newPassword } = req.body || {};
  users.changePassword(current.username, currentPassword, newPassword);
  audit.record({
    action: 'password', user: current.username, connection: '-',
    target: current.username, sql: 'パスワード変更（本人のセッションを無効化）',
  });
  // 変更した本人のセッションだけを切る。他の利用者は影響を受けない。
  session.destroyUserSessions(current.username);
  session.logout(req, res);
  res.json({ ok: true, message: 'パスワードを変更しました。もう一度ログインしてください。' });
}));

/* ------------------------------------------------------------
 * 利用者管理 (管理者のみ)
 * ---------------------------------------------------------- */

const adminOnly = session.requireRole('admin');

router.get('/roles', (req, res) => {
  if (!session.currentSession(req)) {
    return res.status(401).json({ error: 'ログインが必要です。', needLogin: true });
  }
  res.json({
    roles: Object.entries(users.ROLES).map(([id, r]) => ({
      id, label: r.label, rank: r.rank, description: ROLE_HELP[id],
    })),
  });
});

const ROLE_HELP = {
  admin: '利用者の管理、接続先の登録・変更・削除、データの参照と変更',
  operator: '接続先を使ったデータの参照と変更。接続先の登録内容は変更できない',
  viewer: '参照と CSV 書き出しのみ。データは変更できない',
};

router.get('/users', adminOnly, (req, res) => {
  res.json({ users: users.list() });
});

router.post('/users', adminOnly, wrap(async (req, res) => {
  const { username, password, role } = req.body || {};
  const created = users.create({ username, password, role });
  audit.record({
    action: 'user-create', user: req.session.username, connection: '-',
    target: created.username, sql: `利用者を追加 (役割: ${created.role})`,
  });
  res.json({ ok: true, user: created });
}));

router.put('/users/:username', adminOnly, wrap(async (req, res) => {
  const target = req.params.username;
  const { role, disabled } = req.body || {};

  // 自分自身の権限を落として管理者が居なくなる事故を防ぐ
  if (target.toLowerCase() === req.session.username.toLowerCase()
      && (role !== undefined && role !== 'admin')) {
    return res.status(400).json({ error: '自分自身の役割は下げられません。別の管理者に依頼してください。' });
  }
  if (target.toLowerCase() === req.session.username.toLowerCase() && disabled === true) {
    return res.status(400).json({ error: '自分自身を利用停止にはできません。' });
  }

  const updated = users.update(target, { role, disabled });
  // 停止・降格をその場で効かせる
  if (disabled === true) session.destroyUserSessions(target);
  audit.record({
    action: 'user-update', user: req.session.username, connection: '-',
    target: updated.username,
    sql: `利用者を変更 (役割: ${updated.role} / 停止: ${updated.disabled})`,
  });
  res.json({ ok: true, user: updated });
}));

router.post('/users/:username/password', adminOnly, wrap(async (req, res) => {
  const target = req.params.username;
  const { newPassword } = req.body || {};
  users.resetPassword(target, newPassword);
  session.destroyUserSessions(target);
  audit.record({
    action: 'user-password', user: req.session.username, connection: '-',
    target, sql: '管理者がパスワードを再設定（当該利用者のセッションを無効化）',
  });
  res.json({ ok: true, message: `${target} のパスワードを再設定しました。` });
}));

router.delete('/users/:username', adminOnly, wrap(async (req, res) => {
  const target = req.params.username;
  if (target.toLowerCase() === req.session.username.toLowerCase()) {
    return res.status(400).json({ error: '自分自身は削除できません。' });
  }
  users.remove(target);
  session.destroyUserSessions(target);
  audit.record({
    action: 'user-delete', user: req.session.username, connection: '-',
    target, sql: '利用者を削除',
  });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------
 * 操作履歴 (管理者のみ)
 * ---------------------------------------------------------- */

router.get('/audit', adminOnly, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  res.json({ entries: audit.recent(limit) });
});

module.exports = router;
