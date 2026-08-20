'use strict';

/**
 * 更新操作の記録。誰がいつ何をしたかを後から追えるようにする。
 * data/audit.log へ 1 行 1 JSON (JSON Lines) で追記する。
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'audit.log');
const MAX_SQL_LENGTH = 2000;

function record(entry) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    ...entry,
    sql: entry.sql ? String(entry.sql).slice(0, MAX_SQL_LENGTH) : undefined,
  });
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, line + '\n');
  } catch (err) {
    // 記録に失敗しても操作自体は妨げない
    console.error('[audit] 記録に失敗しました:', err.message);
  }
}

/** 直近の記録を新しい順に返す。 */
function recent(limit = 100) {
  if (!fs.existsSync(FILE)) return [];
  const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
  return lines
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

module.exports = { record, recent };
