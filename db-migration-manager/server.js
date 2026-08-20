'use strict';

const path = require('path');
const express = require('express');

const connectionsRouter = require('./src/routes/connections');
const browseRouter = require('./src/routes/browse');
const writeRouter = require('./src/routes/write');
const auth = require('./src/auth');
const pool = require('./src/pool');

const app = express();
const PORT = Number(process.env.PORT || 3000);
// 既定では localhost のみで待ち受ける。DB 認証情報を扱うため外部公開はしない。
const HOST = process.env.DBM_HOST || '127.0.0.1';
const AUTH_USER = process.env.DBM_AUTH_USER || '';
const AUTH_PASS = process.env.DBM_AUTH_PASS || '';

// localhost 以外にバインドするなら認証を必須にする
const policy = auth.checkStartupPolicy(HOST, AUTH_USER, AUTH_PASS);
if (!policy.ok) {
  console.error('\n起動を中止しました。\n');
  console.error(policy.message);
  console.error('');
  process.exit(1);
}

// 静的ファイルより先に認証を通す (画面自体も保護する)
app.use(auth.middleware(AUTH_USER, AUTH_PASS));

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: require('./package.json').version });
});

app.use('/api/connections', connectionsRouter);
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
    // DB へ到達できない・認証に失敗したケース。想定内なので1行だけ残す。
    console.warn(`[db] ${req.method} ${req.originalUrl} — ${err.message}`);
  } else if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  }
  res.status(status).json({ error: err.message || 'サーバーエラーが発生しました。' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`db-migration-manager: http://${HOST}:${PORT}`);
  console.log(`  認証: ${policy.enabled ? `有効 (ユーザー ${AUTH_USER})` : '無効 (localhost 専用)'}`);
  if (!auth.isLoopback(HOST)) {
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
