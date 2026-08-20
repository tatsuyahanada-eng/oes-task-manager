'use strict';

/**
 * 接続情報のパスワードを保存時に暗号化する。
 *
 * 鍵の優先順位:
 *   1. 環境変数 DBM_MASTER_KEY (32バイト以上の任意文字列 / hex 64文字)
 *   2. data/.masterkey (無ければ初回起動時に自動生成。.gitignore 済み)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGO = 'aes-256-gcm';
const KEY_FILE = path.join(__dirname, '..', 'data', '.masterkey');

let cachedKey = null;

function loadKey() {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.DBM_MASTER_KEY;
  if (fromEnv && fromEnv.trim()) {
    cachedKey = crypto.createHash('sha256').update(fromEnv.trim()).digest();
    return cachedKey;
  }

  if (fs.existsSync(KEY_FILE)) {
    cachedKey = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
  } else {
    const generated = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, generated.toString('hex'), { mode: 0o600 });
    cachedKey = generated;
  }
  return cachedKey;
}

/** 平文 -> "enc:v1:<iv>:<tag>:<cipher>" */
function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, loadKey(), iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['enc:v1', iv.toString('base64'), tag.toString('base64'), body.toString('base64')].join(':');
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith('enc:v1:');
}

function decrypt(value) {
  if (!isEncrypted(value)) return value || '';
  const [, , ivB64, tagB64, bodyB64] = value.split(':');
  try {
    const decipher = crypto.createDecipheriv(ALGO, loadKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(bodyB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new Error('パスワードの復号に失敗しました。マスターキー (data/.masterkey または DBM_MASTER_KEY) が変わっていないか確認してください。');
  }
}

module.exports = { encrypt, decrypt, isEncrypted };
