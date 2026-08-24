'use strict';

const path = require('path');
const express = require('express');

const connectionsRouter = require('./src/routes/connections');
const browseRouter = require('./src/routes/browse');
const writeRouter = require('./src/routes/write');
const csvRouter = require('./src/routes/csv');
const authRouter = require('./src/routes/auth');
const session = require('./src/session');
const users = require('./src/users');
const drivers = require('./src/drivers');
const pool = require('./src/pool');

const app = express();
const PORT = Number(process.env.PORT || 3000);
// 既定では localhost のみで待ち受ける。DB 認証情報を扱うため外部公開はしない。
const HOST = process.env.DBC_HOST || '127.0.0.1';

// 利用者を用意する (初回は data/auth.json を作る。旧形式なら新形式へ移す)
const accounts = users.load();

// 初期パスワードのまま外部公開しようとしていたら止める
const policy = session.checkStartupPolicy(HOST);
if (!policy.ok) {
  console.error('\n起動を中止しました。\n');
  console.error(policy.message);
  console.error('');
  process.exit(1);
}

// リバースプロキシ配下でも、元のプロトコルと接続元 IP を正しく見る
app.set('trust proxy', process.env.DBC_TRUST_PROXY === 'false' ? false : 1);
app.disable('x-powered-by');

// 最低限のセキュリティヘッダー
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

app.use(express.json({ limit: '2mb' }));

// ログイン API はログイン不要。ログイン画面と、その表示に要る静的ファイルも通す。
app.use('/api/auth', authRouter);
app.use(session.requireLogin([
  '/login.html', '/style.css', '/logo.svg',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
  '/manifest.webmanifest', '/sw.js',
]));

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      // Service Worker は毎回取り直させる (更新が反映されなくなるのを防ぐ)
      if (filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
      // 画面と API の応答は端末に残さない
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    },
  })
);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'DB Controller', version: require('./package.json').version });
});

app.use('/api/connections', connectionsRouter);
// CSV は参照系より先に置く (tables/... 配下に export.csv を足しているため)
app.use('/api/db/:connectionId', csvRouter);
// 更新系を先に評価する (参照系と同じパスに PATCH / DELETE を足しているため)
app.use('/api/db/:connectionId', writeRouter);
app.use('/api/db/:connectionId', browseRouter);

app.use((req, res) => {
  res.status(404).json({ error: `見つかりません: ${req.method} ${req.path}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 502) {
    console.warn(`[db] ${req.method} ${req.originalUrl} — ${err.message}`);
  } else if (status === 401 || status === 429) {
    console.warn(`[auth] ${req.method} ${req.originalUrl} — ${err.message}`);
  } else if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  }
  res.status(status).json({ error: err.message || 'サーバーエラーが発生しました。' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`DB Controller: http://${HOST}:${PORT}`);

  const active = accounts.users.filter((u) => !u.disabled);
  const admins = active.filter((u) => u.role === 'admin').map((u) => u.username);
  console.log(`  ログイン: 必須（利用者 ${active.length} 人 / 管理者: ${admins.join(', ')}）`);

  // どの DB につなげる状態かを、起動時にはっきり見せる
  const cat = drivers.driverCatalog();
  const ready = cat.filter((d) => d.installed).map((d) => d.label);
  const missing = cat.filter((d) => !d.installed);
  console.log(`  使える DB: ${ready.length ? ready.join(' / ') : 'なし'}`);
  for (const d of missing) {
    console.log(`  ※ ${d.label} は未導入です。使うには: npm install ${d.module}`);
  }

  const stale = accounts.users.filter((u) => u.isDefaultPassword && !u.disabled);
  if (stale.length) {
    console.log('');
    console.log(`  ※ パスワードが初期値のままの利用者がいます: ${stale.map((u) => u.username).join(', ')}`);
    console.log('     ログイン後、設定画面から変更してください。');
    console.log('     変更するまで、localhost 以外での待ち受けはできません。');
    console.log('');
  }
  if (!policy.loopback) {
    console.log('  注意: 外部公開しています。HTTPS 経由でのみアクセスしてください。');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`ポート ${PORT} は既に使用されています。`);
    console.error(`別のポートで起動する場合: PORT=3001 npm start`);
    process.exit(1);
  }
  throw err;
});

async function shutdown(signal) {
  console.log(`\n${signal} を受信しました。接続を閉じています…`);
  server.close();
  await pool.closeAll();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
