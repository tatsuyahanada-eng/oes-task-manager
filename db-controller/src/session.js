'use strict';

/**
 * ログイン (セッション) の管理。
 *
 * 方針:
 *   - パスワードは scrypt でハッシュ化して保存する。平文は保存も送信もしない
 *   - セッションは httpOnly Cookie。JavaScript から読めないようにする
 *   - SameSite=Strict で、他サイトからの誘導によるリクエストに Cookie を乗せない
 *   - 無操作が続いたセッションと、発行から時間が経ったセッションは無効にする
 *   - ログイン失敗が続く相手は一定時間受け付けない (総当たり対策)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUTH_FILE = path.join(__dirname, '..', 'data', 'auth.json');

/** 初期アカウント。初回起動時に data/auth.json が無ければこれで作る。 */
const DEFAULT_USERNAME = 'welsysadm';
const DEFAULT_PASSWORD = 'Welsys@1234';

const COOKIE_NAME = 'dbc_session';

/** 無操作でセッションが切れるまで (既定 30 分) */
const IDLE_MS = Number(process.env.DBC_SESSION_IDLE_MS || 30 * 60 * 1000);
/** 発行からの上限 (既定 12 時間)。長く開きっぱなしでも必ず切れる。 */
const ABSOLUTE_MS = Number(process.env.DBC_SESSION_MAX_MS || 12 * 60 * 60 * 1000);

/** ログイン失敗の許容回数と、超えたときの待ち時間 */
const MAX_ATTEMPTS = Number(process.env.DBC_LOGIN_MAX_ATTEMPTS || 5);
const LOCK_MS = Number(process.env.DBC_LOGIN_LOCK_MS || 15 * 60 * 1000);

/* ------------------------------------------------------------
 * パスワードのハッシュ化
 * ---------------------------------------------------------- */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  });
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

/** タイミング差から答えが漏れないように比較する。 */
function verifyPassword(password, record) {
  const { hash } = hashPassword(password, record.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(record.hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------
 * アカウント情報の保存
 * ---------------------------------------------------------- */

function readAccount() {
  if (!fs.existsSync(AUTH_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeAccount(account) {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(account, null, 2) + '\n', { mode: 0o600 });
}

/**
 * アカウントを用意する。
 * 環境変数で指定があればそれを、無ければ初期アカウントを作る。
 */
function ensureAccount() {
  let account = readAccount();
  if (account) return account;

  const username = process.env.DBC_AUTH_USER || DEFAULT_USERNAME;
  const password = process.env.DBC_AUTH_PASS || DEFAULT_PASSWORD;
  const { salt, hash } = hashPassword(password);

  account = {
    username,
    salt,
    hash,
    algo: 'scrypt',
    // 初期パスワードのままかどうか。外部公開の可否判定に使う。
    isDefaultPassword: !process.env.DBC_AUTH_PASS && password === DEFAULT_PASSWORD,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeAccount(account);
  return account;
}

function changePassword(currentPassword, newPassword) {
  const account = ensureAccount();
  if (!verifyPassword(currentPassword, account)) {
    const e = new Error('現在のパスワードが違います。');
    e.status = 400;
    throw e;
  }
  const problems = checkPasswordStrength(newPassword);
  if (problems.length) {
    const e = new Error(problems.join(' '));
    e.status = 400;
    throw e;
  }
  const { salt, hash } = hashPassword(newPassword);
  writeAccount({
    ...account, salt, hash,
    isDefaultPassword: false,
    updatedAt: new Date().toISOString(),
  });
  // パスワードを変えたら、既存のセッションはすべて無効にする
  sessions.clear();
  return true;
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

/* ------------------------------------------------------------
 * セッション
 * ---------------------------------------------------------- */

/** token -> { username, createdAt, lastSeen, ip, userAgent } */
const sessions = new Map();

function createSession(username, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  sessions.set(token, {
    username,
    createdAt: now,
    lastSeen: now,
    ip: clientIp(req),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
  });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  const now = Date.now();
  if (now - s.lastSeen > IDLE_MS || now - s.createdAt > ABSOLUTE_MS) {
    sessions.delete(token);
    return null;
  }
  s.lastSeen = now;
  return s;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

function activeSessionCount() {
  // 期限切れを掃除してから数える
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now - s.lastSeen > IDLE_MS || now - s.createdAt > ABSOLUTE_MS) sessions.delete(token);
  }
  return sessions.size;
}

/* ------------------------------------------------------------
 * ログイン失敗の制限
 * ---------------------------------------------------------- */

/** ip -> { count, firstAt, lockedUntil } */
const attempts = new Map();

function clientIp(req) {
  // リバースプロキシ経由を考慮する
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket ? req.socket.remoteAddress : 'unknown';
}

function checkLock(ip) {
  const a = attempts.get(ip);
  if (!a) return null;
  if (a.lockedUntil && Date.now() < a.lockedUntil) {
    return Math.ceil((a.lockedUntil - Date.now()) / 1000);
  }
  if (a.lockedUntil && Date.now() >= a.lockedUntil) attempts.delete(ip);
  return null;
}

function recordFailure(ip) {
  const now = Date.now();
  const a = attempts.get(ip) || { count: 0, firstAt: now };
  // 一定時間が空いたら数え直す
  if (now - a.firstAt > LOCK_MS) { a.count = 0; a.firstAt = now; }
  a.count += 1;
  if (a.count >= MAX_ATTEMPTS) a.lockedUntil = now + LOCK_MS;
  attempts.set(ip, a);
  return Math.max(MAX_ATTEMPTS - a.count, 0);
}

function clearFailures(ip) { attempts.delete(ip); }

/* ------------------------------------------------------------
 * Cookie
 * ---------------------------------------------------------- */

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** HTTPS 経由かどうか (リバースプロキシのヘッダも見る)。 */
function isSecureRequest(req) {
  if (process.env.DBC_SECURE_COOKIE === 'true') return true;
  if (process.env.DBC_SECURE_COOKIE === 'false') return false;
  if (req.secure) return true;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setSessionCookie(req, res, token) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(ABSOLUTE_MS / 1000)}`,
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isSecureRequest(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/* ------------------------------------------------------------
 * ログイン処理
 * ---------------------------------------------------------- */

function login(req, res, username, password) {
  const ip = clientIp(req);

  const wait = checkLock(ip);
  if (wait !== null) {
    const e = new Error(`ログインの試行が続いたため、しばらく受け付けません。あと ${Math.ceil(wait / 60)} 分お待ちください。`);
    e.status = 429;
    throw e;
  }

  const account = ensureAccount();
  const userOk = typeof username === 'string' && username.length < 200
    && crypto.timingSafeEqual(
      crypto.createHash('sha256').update(String(username)).digest(),
      crypto.createHash('sha256').update(account.username).digest()
    );
  const passOk = typeof password === 'string' && password.length < 500
    && verifyPassword(password, account);

  // ユーザー名とパスワードのどちらが違うかは伝えない
  if (!userOk || !passOk) {
    const remaining = recordFailure(ip);
    const e = new Error(
      remaining > 0
        ? `ユーザー名またはパスワードが違います。（あと ${remaining} 回）`
        : 'ログインの試行が続いたため、しばらく受け付けません。'
    );
    e.status = 401;
    throw e;
  }

  clearFailures(ip);
  const token = createSession(account.username, req);
  setSessionCookie(req, res, token);
  return { username: account.username, isDefaultPassword: Boolean(account.isDefaultPassword) };
}

function logout(req, res) {
  const token = parseCookies(req)[COOKIE_NAME];
  destroySession(token);
  clearSessionCookie(req, res);
}

/** リクエストからログイン中のセッションを取り出す。 */
function currentSession(req) {
  return getSession(parseCookies(req)[COOKIE_NAME]);
}

/**
 * ログインを必須にするミドルウェア。
 * ログイン画面と、そこで使う静的ファイルだけは通す。
 */
function requireLogin(publicPaths) {
  const allow = new Set(publicPaths);
  return (req, res, next) => {
    if (allow.has(req.path)) return next();
    if (req.path.startsWith('/api/auth/')) return next();

    const session = currentSession(req);
    if (session) {
      req.session = session;
      return next();
    }

    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'ログインが必要です。', needLogin: true });
    }
    // 画面はログイン画面へ送る
    return res.redirect(302, '/login.html');
  };
}

/**
 * 起動時の検査。
 * 初期パスワードのまま外部へ公開しようとしていたら止める。
 */
function checkStartupPolicy(host, account) {
  const loopback = ['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1'].includes(String(host));
  if (loopback) return { ok: true, loopback: true };

  if (account.isDefaultPassword) {
    return {
      ok: false,
      message: [
        `待ち受けアドレスが ${host} (localhost 以外) ですが、パスワードが初期値のままです。`,
        '',
        'このツールは DB の接続情報を保持し、画面から DB を操作できます。',
        '初期パスワードのまま外部へ公開すると、非常に危険です。',
        '',
        '次のいずれかを行ってから起動してください:',
        '  1. localhost で起動してログインし、設定画面からパスワードを変更する',
        '  2. 環境変数 DBC_AUTH_PASS に新しいパスワードを設定し、data/auth.json を削除して作り直す',
        '',
        'ローカルでのみ使う場合は DBC_HOST を設定しないでください (既定で 127.0.0.1)。',
      ].join('\n'),
    };
  }
  return { ok: true, loopback: false };
}

module.exports = {
  COOKIE_NAME,
  DEFAULT_USERNAME,
  DEFAULT_PASSWORD,
  ensureAccount,
  readAccount,
  changePassword,
  checkPasswordStrength,
  login,
  logout,
  currentSession,
  requireLogin,
  checkStartupPolicy,
  activeSessionCount,
  clientIp,
  isSecureRequest,
  parseCookies,
  IDLE_MS,
  ABSOLUTE_MS,
};
