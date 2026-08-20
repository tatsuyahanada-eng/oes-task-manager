'use strict';

/**
 * 開いた接続をプロセス内にキャッシュし、同じ接続プロファイル・同じデータベースへの
 * 連続アクセスで毎回ハンドシェイクしないようにする。
 * 一定時間アクセスが無い接続は自動的に切断する。
 */

const store = require('./store');
const { getDriver } = require('./drivers');

const IDLE_TIMEOUT_MS = Number(process.env.DBM_IDLE_TIMEOUT_MS || 10 * 60 * 1000);
const SWEEP_INTERVAL_MS = 60 * 1000;

/** key -> { client, driver, connectionId, database, lastUsed, connectedAt } */
const sessions = new Map();

function keyOf(connectionId, database) {
  return `${connectionId}::${database || ''}`;
}

/**
 * 接続を取得する (無ければ張る)。
 * @param {string} connectionId 接続プロファイルID
 * @param {string} [database]   切り替え先データベース (SQL Server / PostgreSQL のみ)
 */
async function acquire(connectionId, database) {
  const conn = store.getRuntime(connectionId);
  if (!conn) {
    const e = new Error('接続が見つかりません。');
    e.status = 404;
    throw e;
  }

  const driver = getDriver(conn.type);
  // 未指定なら既定データベースへ寄せる。同じDBに二重接続しないようキーを正規化する。
  const effectiveDatabase = driver.supportsDatabaseSwitch ? database || conn.database || '' : '';

  const key = keyOf(connectionId, effectiveDatabase);
  const existing = sessions.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }

  const client = await driver.connect(conn, effectiveDatabase);
  const session = {
    key,
    client,
    driver,
    connectionId,
    connectionName: conn.name,
    type: conn.type,
    database: effectiveDatabase || null,
    connectedAt: Date.now(),
    lastUsed: Date.now(),
  };
  sessions.set(key, session);
  return session;
}

/** 一時的な接続 (接続テスト用)。キャッシュしない。 */
async function withTemporary(conn, database, fn) {
  const driver = getDriver(conn.type);
  let client;
  try {
    client = await driver.connect(conn, database);
  } catch (err) {
    // 認証エラーや到達不能はサーバー障害ではないので 502 として返す
    err.status = err.status || 502;
    throw err;
  }
  try {
    return await fn(driver, client);
  } finally {
    await driver.close(client).catch(() => {});
  }
}

async function release(connectionId, database) {
  const key = keyOf(connectionId, database);
  const session = sessions.get(key);
  if (!session) return false;
  sessions.delete(key);
  await session.driver.close(session.client).catch(() => {});
  return true;
}

/** 指定プロファイルの全データベース分の接続を閉じる (設定変更・削除時)。 */
async function releaseAll(connectionId) {
  const targets = [];
  for (const [key, session] of sessions) {
    if (session.connectionId === connectionId) {
      sessions.delete(key);
      targets.push(session);
    }
  }
  await Promise.all(targets.map((s) => s.driver.close(s.client).catch(() => {})));
}

function activeSessions() {
  return [...sessions.values()].map((s) => ({
    connectionId: s.connectionId,
    connectionName: s.connectionName,
    type: s.type,
    database: s.database,
    connectedAt: new Date(s.connectedAt).toISOString(),
    lastUsed: new Date(s.lastUsed).toISOString(),
  }));
}

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - session.lastUsed > IDLE_TIMEOUT_MS) {
      sessions.delete(key);
      session.driver.close(session.client).catch(() => {});
    }
  }
}, SWEEP_INTERVAL_MS);
sweeper.unref();

async function closeAll() {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map((s) => s.driver.close(s.client).catch(() => {})));
}

module.exports = { acquire, release, releaseAll, withTemporary, activeSessions, closeAll };
