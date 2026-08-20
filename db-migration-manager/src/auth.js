'use strict';

/**
 * Basic 認証。
 *
 * このツールは DB の認証情報を保持し、画面から DB を操作できるため、
 * localhost 以外で待ち受ける場合は認証を必須にする。
 * 認証情報が無いまま外部公開されると、URL を知った全員が DB を操作できてしまう。
 */

const crypto = require('crypto');

const LOOPBACK = ['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1'];

function isLoopback(host) {
  return LOOPBACK.includes(String(host));
}

/**
 * 起動時の検査。
 * localhost 以外にバインドするのに認証情報が無ければ、起動を止める。
 */
function checkStartupPolicy(host, user, pass) {
  if (isLoopback(host)) return { ok: true, enabled: Boolean(user && pass) };

  if (!user || !pass) {
    return {
      ok: false,
      message: [
        `待ち受けアドレスが ${host} (localhost 以外) に設定されていますが、認証情報がありません。`,
        '',
        'このツールは DB の接続情報を保持し、画面から DB を操作できます。',
        '認証なしで外部に公開すると、URL を知った人が誰でも DB を操作できてしまいます。',
        '',
        '次の環境変数を設定してから起動してください:',
        '  DBM_AUTH_USER=<ログインID>',
        '  DBM_AUTH_PASS=<16文字以上のパスワード>',
        '',
        'ローカルでのみ使う場合は DBM_HOST を設定しないでください (既定で 127.0.0.1)。',
      ].join('\n'),
    };
  }

  if (String(pass).length < 16) {
    return {
      ok: false,
      message:
        'DBM_AUTH_PASS が短すぎます。外部公開時は 16 文字以上にしてください。\n' +
        '例: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"',
    };
  }

  return { ok: true, enabled: true };
}

/** タイミング攻撃を避けて文字列を比較する。 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // 長さが違うと timingSafeEqual が例外を投げるため、ハッシュ化して長さを揃える
  const hashA = crypto.createHash('sha256').update(bufA).digest();
  const hashB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Basic 認証ミドルウェアを作る。
 * user / pass が未設定なら素通しする (localhost 専用運用のケース)。
 */
function middleware(user, pass) {
  if (!user || !pass) return (req, res, next) => next();

  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');

    if (scheme === 'Basic' && encoded) {
      let decoded = '';
      try {
        decoded = Buffer.from(encoded, 'base64').toString('utf8');
      } catch {
        decoded = '';
      }
      const index = decoded.indexOf(':');
      if (index !== -1) {
        const givenUser = decoded.slice(0, index);
        const givenPass = decoded.slice(index + 1);
        if (safeEqual(givenUser, user) && safeEqual(givenPass, pass)) return next();
      }
    }

    res.set('WWW-Authenticate', 'Basic realm="db-migration-manager", charset="UTF-8"');
    res.status(401).json({ error: '認証が必要です。' });
  };
}

module.exports = { middleware, checkStartupPolicy, isLoopback };
