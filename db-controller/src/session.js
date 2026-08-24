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
 *   - 利用者は複数登録できる。誰がどの操作をしてよいかは役割 (role) で決める
 *   - 役割や利用停止の変更は、開きっぱなしのセッションにも次のリクエストから効く
 */

const crypto = require('crypto');
const users = require('./users');

const COOKIE_NAME = 'dbc_session';

/** 無操作でセッションが切れるまで (既定 30 分) */
const IDLE_MS = Number(process.env.DBC_SESSION_IDLE_MS || 30 * 60 * 1000);
/** 発行からの上限 (既定 12 時間)。長く開きっぱなしでも必ず切れる。 */
const ABSOLUTE_MS = Number(process.env.DBC_SESSION_MAX_MS || 12 * 60 * 60 * 1000);

/** ログイン失敗の許容回数と、超えたときの待ち時間 */
const MAX_ATTEMPTS = Number(process.env.DBC_LOGIN_MAX_ATTEMPTS || 5);
const LOCK_MS = Number(process.env.DBC_LOGIN_LOCK_MS || 15 * 60 * 1000);

/* ------------------------------------------------------------
 * セッション
 * ---------------------------------------------------------- */

/** token -> { username, role, createdAt, lastSeen, ip, userAgent } */
const sessions = new Map();

function createSession(username, role, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  sessions.set(token, {
    username,
    role,
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

  // 役割の変更・利用停止・削除を、開きっぱなしの画面にも効かせる。
  // 保存された内容を毎回引き直すので、管理者の操作が即座に反映される。
  const user = users.find(s.username);
  if (!user || user.disabled) {
    sessions.delete(token);
    return null;
  }
  s.role = user.role;

  s.lastSeen = now;
  return s;
}

/** ある利用者のセッションをすべて無効にする。 */
function destroyUserSessions(username) {
  const key = String(username || '').toLowerCase();
  for (const [token, s] of sessions) {
    if (s.username.toLowerCase() === key) sessions.delete(token);
  }
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

/** 存在しないユーザー名でも同じだけ計算するための捨て駒。 */
const DUMMY_RECORD = users.hashPassword('dummy-password-for-timing');

function login(req, res, username, password) {
  const ip = clientIp(req);

  const wait = checkLock(ip);
  if (wait !== null) {
    const e = new Error(`ログインの試行が続いたため、しばらく受け付けません。あと ${Math.ceil(wait / 60)} 分お待ちください。`);
    e.status = 429;
    throw e;
  }

  const nameOk = typeof username === 'string' && username.length < 200;
  const passOk = typeof password === 'string' && password.length < 500;
  const user = nameOk ? users.find(username) : null;

  // 利用者が居ない場合でも同じだけ計算し、応答時間から存在を推測されないようにする
  const verified = user
    ? users.verifyPassword(password, user)
    : users.verifyPassword(password, DUMMY_RECORD) && false;

  // ユーザー名とパスワードのどちらが違うかは伝えない
  if (!nameOk || !passOk || !user || user.disabled || !verified) {
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
  users.markLogin(user.username);
  const token = createSession(user.username, user.role, req);
  setSessionCookie(req, res, token);
  return {
    username: user.username,
    role: user.role,
    isDefaultPassword: Boolean(user.isDefaultPassword),
  };
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
function checkStartupPolicy(host) {
  const loopback = ['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1'].includes(String(host));
  if (loopback) return { ok: true, loopback: true };

  if (users.anyDefaultPassword()) {
    return {
      ok: false,
      message: [
        `待ち受けアドレスが ${host} (localhost 以外) ですが、初期パスワードのままの利用者がいます。`,
        '',
        'このツールは DB の接続情報を保持し、画面から DB を操作できます。',
        '初期パスワードのまま共有環境へ置くと、非常に危険です。',
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

/**
 * 役割で操作を制限するミドルウェア。
 * requireLogin の後ろに置くこと (ログイン済みである前提)。
 */
function requireRole(required) {
  return (req, res, next) => {
    const current = req.session || currentSession(req);
    if (!current) {
      return res.status(401).json({ error: 'ログインが必要です。', needLogin: true });
    }
    if (!users.hasRole(current, required)) {
      const label = users.ROLES[required] ? users.ROLES[required].label : required;
      return res.status(403).json({
        error: `この操作には「${label}」以上の権限が必要です。`,
      });
    }
    req.session = current;
    return next();
  };
}

module.exports = {
  COOKIE_NAME,
  login,
  logout,
  currentSession,
  requireLogin,
  requireRole,
  checkStartupPolicy,
  destroyUserSessions,
  activeSessionCount,
  clientIp,
  isSecureRequest,
  parseCookies,
  IDLE_MS,
  ABSOLUTE_MS,
};
