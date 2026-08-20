'use strict';

/**
 * 接続プロファイルの永続化 (data/connections.json)。
 * パスワードは暗号化して保存し、API から外へ出すときは必ず除去する。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { encrypt, decrypt, isEncrypted } = require('./crypto');
const { getDriver, DRIVERS } = require('./drivers');

const FILE = path.join(__dirname, '..', 'data', 'connections.json');

function readAll() {
  if (!fs.existsSync(FILE)) return [];
  const raw = fs.readFileSync(FILE, 'utf8').trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function writeAll(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
}

/** 画面・API に返す形。パスワードは持たせない。 */
function toPublic(conn) {
  const { password, ...rest } = conn;
  return { ...rest, hasPassword: Boolean(password) };
}

/** ドライバに渡す形。パスワードを復号する。 */
function toRuntime(conn) {
  return { ...conn, password: decrypt(conn.password) };
}

function validate(input) {
  const errors = [];
  const type = String(input.type || '').trim();

  if (!input.name || !String(input.name).trim()) errors.push('接続名は必須です。');
  if (!DRIVERS[type]) errors.push(`DB種別が不正です (${DRIVERS_LIST()})。`);

  if (type === 'oracle') {
    if (!input.host) errors.push('ホストは必須です。');
    if (!input.serviceName && !input.sid) errors.push('サービス名 または SID のいずれかが必要です。');
  } else if (type === 'mssql' || type === 'postgres') {
    if (!input.host) errors.push('ホストは必須です。');
  }
  if (!input.username) errors.push('ユーザー名は必須です。');

  return errors;
}

function DRIVERS_LIST() {
  return Object.keys(DRIVERS).join(' / ');
}

function normalize(input, previous) {
  const driver = getDriver(input.type);
  const port = Number(input.port) || driver.defaultPort;

  let password;
  if (input.password === undefined || input.password === null) {
    // 未指定 = 既存パスワードを維持
    password = previous ? previous.password : '';
  } else if (isEncrypted(input.password)) {
    password = input.password;
  } else {
    password = encrypt(input.password);
  }

  return {
    id: previous ? previous.id : crypto.randomUUID(),
    name: String(input.name).trim(),
    type: input.type,
    host: String(input.host || '').trim(),
    port,
    // Oracle: サービス名 / SID。SQL Server・PostgreSQL: 既定データベース。
    database: String(input.database || '').trim(),
    serviceName: String(input.serviceName || '').trim(),
    sid: String(input.sid || '').trim(),
    // SQL Server の名前付きインスタンス (例: SQLEXPRESS)
    instanceName: String(input.instanceName || '').trim(),
    username: String(input.username || '').trim(),
    password,
    // 用途メモ: 'source'(移行元) / 'target'(移行先) / ''
    role: ['source', 'target', ''].includes(input.role) ? input.role : '',
    // 安全側の既定。明示的に false にしない限り書き込みを一切受け付けない。
    readOnly: input.readOnly !== false,
    encrypt: input.encrypt !== false,
    trustServerCertificate: input.trustServerCertificate !== false,
    ssl: Boolean(input.ssl),
    note: String(input.note || '').trim(),
    createdAt: previous ? previous.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function list() {
  return readAll().map(toPublic);
}

function findRaw(id) {
  return readAll().find((c) => c.id === id) || null;
}

function get(id) {
  const found = findRaw(id);
  return found ? toPublic(found) : null;
}

/** 実接続用。パスワード復号済み。 */
function getRuntime(id) {
  const found = findRaw(id);
  if (!found) return null;
  return toRuntime(found);
}

function create(input) {
  const errors = validate(input);
  if (errors.length) { const e = new Error(errors.join(' ')); e.status = 400; throw e; }
  const list = readAll();
  const record = normalize(input, null);
  list.push(record);
  writeAll(list);
  return toPublic(record);
}

function update(id, input) {
  const all = readAll();
  const index = all.findIndex((c) => c.id === id);
  if (index === -1) { const e = new Error('接続が見つかりません。'); e.status = 404; throw e; }
  const merged = { ...all[index], ...input, type: input.type || all[index].type };
  const errors = validate(merged);
  if (errors.length) { const e = new Error(errors.join(' ')); e.status = 400; throw e; }
  const record = normalize(merged, all[index]);
  all[index] = record;
  writeAll(all);
  return toPublic(record);
}

function remove(id) {
  const all = readAll();
  const next = all.filter((c) => c.id !== id);
  if (next.length === all.length) { const e = new Error('接続が見つかりません。'); e.status = 404; throw e; }
  writeAll(next);
  return true;
}

module.exports = { list, get, getRuntime, create, update, remove, toPublic };
