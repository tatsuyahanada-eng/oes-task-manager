'use strict';

/**
 * 利用者アカウントの保管。
 *
 * 方針:
 *   - 複数人で使うことを前提に、data/auth.json に利用者の一覧を持つ
 *   - パスワードは scrypt でハッシュ化して保存する。平文は保存しない
 *   - 役割 (role) で、できることを分ける
 *   - 1 人目は必ず管理者。管理者が 0 人になる操作は受け付けない
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUTH_FILE = path.join(__dirname, '..', 'data', 'auth.json');

/** 初期アカウント。初回起動時に data/auth.json が無ければこれで作る。 */
const DEFAULT_USERNAME = 'welsysadm';
const DEFAULT_PASSWORD = 'Welsys@1234';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/**
 * 役割。上にあるものほど強い。
 *
 *   admin    … 利用者の管理、接続先の登録・変更・削除、データの変更
 *   operator … 接続先を使ってデータを参照・変更する。接続先の登録は変更できない
 *   viewer   … 参照と CSV 書き出しだけ。データは一切変更できない
 */
const ROLES = {
  admin: { label: '管理者', rank: 3 },
  operator: { label: '運用者', rank: 2 },
  viewer: { label: '閲覧者', rank: 1 },
};

function isRole(role) { return Object.prototype.hasOwnProperty.call(ROLES, role); }
function rankOf(role) { return ROLES[role] ? ROLES[role].rank : 0; }

/** user の役割が required 以上かどうか。 */
function hasRole(user, required) {
  return Boolean(user) && rankOf(user.role) >= rankOf(required);
}

/* ------------------------------------------------------------
 * パスワード
 * ---------------------------------------------------------- */

function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  });
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

/** タイミング差から答えが漏れないように比較する。 */
function verifyPassword(password, record) {
  if (!record || !record.salt || !record.hash) return false;
  const { hash } = hashPassword(password, record.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(record.hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 新しいパスワードの条件。 */
function checkPasswordStrength(password) {
  const p = String(password || '');
  const problems = [];
  if (p.length < 10) problems.push('パスワードは 10 文字以上にしてください。');
  if (!/[a-z]/.test(p) || !/[A-Z]/.test(p)) problems.push('英大文字と小文字を両方含めてください。');
  if (!/[0-9]/.test(p)) problems.push('数字を含めてください。');
  if (p === DEFAULT_PASSWORD) problems.push('初期パスワードは使えません。');
  return problems;
}

function checkUsername(username) {
  const u = String(username || '').trim();
  if (u.length < 3 || u.length > 32) return 'ユーザー名は 3〜32 文字にしてください。';
  if (!/^[A-Za-z0-9._-]+$/.test(u)) return 'ユーザー名に使えるのは英数字と . _ - です。';
  return null;
}

/* ------------------------------------------------------------
 * 読み書き
 * ---------------------------------------------------------- */

function readFile() {
  if (!fs.existsSync(AUTH_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeFile(db) {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(db, null, 2) + '\n', { mode: 0o600 });
}

/**
 * 1 人だけを持つ旧形式 (version なし) を、利用者一覧の形式へ移す。
 * 既存の設置を壊さないよう、起動時に自動で行う。
 */
function migrate(old) {
  return {
    version: 2,
    users: [{
      username: old.username,
      salt: old.salt,
      hash: old.hash,
      algo: old.algo || 'scrypt',
      role: 'admin',
      disabled: false,
      isDefaultPassword: Boolean(old.isDefaultPassword),
      createdAt: old.createdAt || new Date().toISOString(),
      updatedAt: old.updatedAt || new Date().toISOString(),
      lastLoginAt: null,
    }],
  };
}

function newUser({ username, password, role }) {
  const { salt, hash } = hashPassword(password);
  const now = new Date().toISOString();
  return {
    username, salt, hash, algo: 'scrypt', role,
    disabled: false,
    isDefaultPassword: password === DEFAULT_PASSWORD,
    createdAt: now, updatedAt: now, lastLoginAt: null,
  };
}

/** 利用者一覧を用意する。無ければ管理者を 1 人作る。 */
function load() {
  const raw = readFile();
  if (raw && Array.isArray(raw.users)) return raw;
  if (raw && raw.username) {
    const db = migrate(raw);
    writeFile(db);
    return db;
  }

  const username = process.env.DBC_AUTH_USER || DEFAULT_USERNAME;
  const password = process.env.DBC_AUTH_PASS || DEFAULT_PASSWORD;
  const user = newUser({ username, password, role: 'admin' });
  user.isDefaultPassword = !process.env.DBC_AUTH_PASS && password === DEFAULT_PASSWORD;
  const db = { version: 2, users: [user] };
  writeFile(db);
  return db;
}

function save(db) { writeFile(db); }

function find(username) {
  const db = load();
  const key = String(username || '').toLowerCase();
  return db.users.find((u) => u.username.toLowerCase() === key) || null;
}

function list() {
  return load().users.map(publicView);
}

/** 画面へ返してよい形。ハッシュと塩は絶対に出さない。 */
function publicView(u) {
  return {
    username: u.username,
    role: u.role,
    roleLabel: ROLES[u.role] ? ROLES[u.role].label : u.role,
    disabled: Boolean(u.disabled),
    isDefaultPassword: Boolean(u.isDefaultPassword),
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    lastLoginAt: u.lastLoginAt || null,
  };
}

/** 初期パスワードのままの利用者がいるか。外部公開の可否判定に使う。 */
function anyDefaultPassword() {
  return load().users.some((u) => u.isDefaultPassword && !u.disabled);
}

function adminCount(users) {
  return users.filter((u) => u.role === 'admin' && !u.disabled).length;
}

function fail(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  throw e;
}

/* ------------------------------------------------------------
 * 変更
 * ---------------------------------------------------------- */

function create({ username, password, role }) {
  const nameProblem = checkUsername(username);
  if (nameProblem) fail(nameProblem);
  if (!isRole(role)) fail('役割の指定が正しくありません。');
  const problems = checkPasswordStrength(password);
  if (problems.length) fail(problems.join(' '));

  const db = load();
  const name = String(username).trim();
  if (db.users.some((u) => u.username.toLowerCase() === name.toLowerCase())) {
    fail('そのユーザー名は既に使われています。');
  }
  const user = newUser({ username: name, password, role });
  db.users.push(user);
  save(db);
  return publicView(user);
}

/** 役割の変更と、利用停止 / 再開。 */
function update(username, { role, disabled }) {
  const db = load();
  const user = db.users.find((u) => u.username.toLowerCase() === String(username).toLowerCase());
  if (!user) fail('その利用者は見つかりません。', 404);

  const next = { ...user };
  if (role !== undefined) {
    if (!isRole(role)) fail('役割の指定が正しくありません。');
    next.role = role;
  }
  if (disabled !== undefined) next.disabled = Boolean(disabled);

  // 管理者が 0 人になる変更は受け付けない
  const after = db.users.map((u) => (u === user ? next : u));
  if (adminCount(after) === 0) fail('管理者が 0 人になる変更はできません。');

  next.updatedAt = new Date().toISOString();
  db.users = after;
  save(db);
  return publicView(next);
}

function remove(username) {
  const db = load();
  const idx = db.users.findIndex((u) => u.username.toLowerCase() === String(username).toLowerCase());
  if (idx === -1) fail('その利用者は見つかりません。', 404);

  const after = db.users.filter((_, i) => i !== idx);
  if (after.length === 0) fail('最後の利用者は削除できません。');
  if (adminCount(after) === 0) fail('管理者が 0 人になる削除はできません。');

  db.users = after;
  save(db);
  return true;
}

/** 本人によるパスワード変更。現在のパスワードの確認が要る。 */
function changePassword(username, currentPassword, newPassword) {
  const db = load();
  const user = db.users.find((u) => u.username.toLowerCase() === String(username).toLowerCase());
  if (!user) fail('その利用者は見つかりません。', 404);
  if (!verifyPassword(currentPassword, user)) fail('現在のパスワードが違います。');

  const problems = checkPasswordStrength(newPassword);
  if (problems.length) fail(problems.join(' '));

  applyPassword(db, user, newPassword);
  return true;
}

/** 管理者による再設定。本人のパスワードを知らなくてよい。 */
function resetPassword(username, newPassword) {
  const db = load();
  const user = db.users.find((u) => u.username.toLowerCase() === String(username).toLowerCase());
  if (!user) fail('その利用者は見つかりません。', 404);

  const problems = checkPasswordStrength(newPassword);
  if (problems.length) fail(problems.join(' '));

  applyPassword(db, user, newPassword);
  return true;
}

function applyPassword(db, user, password) {
  const { salt, hash } = hashPassword(password);
  user.salt = salt;
  user.hash = hash;
  user.isDefaultPassword = false;
  user.updatedAt = new Date().toISOString();
  save(db);
}

function markLogin(username) {
  const db = load();
  const user = db.users.find((u) => u.username.toLowerCase() === String(username).toLowerCase());
  if (!user) return;
  user.lastLoginAt = new Date().toISOString();
  save(db);
}

module.exports = {
  ROLES, DEFAULT_USERNAME, DEFAULT_PASSWORD,
  isRole, hasRole, rankOf,
  hashPassword, verifyPassword, checkPasswordStrength, checkUsername,
  load, find, list, publicView, anyDefaultPassword,
  create, update, remove, changePassword, resetPassword, markLogin,
};
