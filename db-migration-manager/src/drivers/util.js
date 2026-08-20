'use strict';

/** JSON で安全に返せる形へ値を正規化する。 */
function serializeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) {
    const head = value.subarray(0, 32).toString('hex').toUpperCase();
    const suffix = value.length > 32 ? ` ... (${value.length} bytes)` : '';
    return `0x${head}${suffix}`;
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return value;
}

function serializeRow(row, columns) {
  return columns.map((c) => serializeValue(row[c]));
}

/** ページング・並び順パラメータを検証済みの数値へ落とす。 */
function normalizePaging({ limit, offset }, maxLimit = 1000) {
  const l = Math.min(Math.max(parseInt(limit, 10) || 100, 1), maxLimit);
  const o = Math.max(parseInt(offset, 10) || 0, 0);
  return { limit: l, offset: o };
}

function normalizeOrderDir(dir) {
  return String(dir || '').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
}

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

/** 参照系 SQL だけを許可する (このツールの現行スコープは参照専用)。 */
function assertReadOnly(sql) {
  const stripped = String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .trim()
    .replace(/;\s*$/, '');

  if (!stripped) throw badRequest('SQL が空です。');
  if (stripped.includes(';')) {
    throw badRequest('複数ステートメントは実行できません。1文ずつ実行してください。');
  }
  if (!/^(select|with)\b/i.test(stripped)) {
    throw badRequest('現在は参照 (SELECT / WITH) のみ実行できます。');
  }
  return stripped;
}

/** テーブル名・列名を SQL へ埋め込む前の検査。 */
function assertIdentifier(name, label = '識別子') {
  if (typeof name !== 'string' || !name.length || name.length > 128) {
    throw badRequest(`${label}が不正です。`);
  }
  if (/["'`\]\[;]/.test(name)) {
    throw badRequest(`${label}に使用できない文字が含まれています: ${name}`);
  }
  return name;
}

/** 更新系 SQL かどうか (SQL実行タブの確認ダイアログ判定に使う)。 */
function classifyStatement(sql) {
  const stripped = String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .trim();
  if (/^(select|with)\b/i.test(stripped)) return 'read';
  if (/^(insert|update|delete|merge)\b/i.test(stripped)) return 'write';
  return 'other';
}

/** 単一ステートメントであることを保証する。 */
function assertSingleStatement(sql) {
  const stripped = String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .trim()
    .replace(/;\s*$/, '');
  if (!stripped) throw badRequest('SQL が空です。');
  if (stripped.includes(';')) {
    throw badRequest('複数ステートメントは実行できません。1文ずつ実行してください。');
  }
  return stripped;
}

/**
 * 更新対象の行を特定するキーを検証する。
 * 主キーが無いテーブルは行を一意に特定できないため、編集を許可しない。
 */
function assertRowKey(primaryKey, keyValues) {
  if (!Array.isArray(primaryKey) || !primaryKey.length) {
    throw badRequest('主キーが無いテーブルは、行を一意に特定できないため編集できません。');
  }
  for (const col of primaryKey) {
    if (keyValues[col] === undefined || keyValues[col] === null) {
      throw badRequest(`主キー列 ${col} の値が指定されていません。`);
    }
  }
  return primaryKey;
}

/** 入力値を DB へ渡す形に整える。空文字と NULL を取り違えないよう明示的に扱う。 */
function normalizeInputValue(field) {
  if (!field || typeof field !== 'object') return field;
  if (field.isNull) return null;
  return field.value;
}

module.exports = {
  classifyStatement,
  assertSingleStatement,
  assertRowKey,
  normalizeInputValue,
  serializeValue,
  serializeRow,
  normalizePaging,
  normalizeOrderDir,
  assertReadOnly,
  assertIdentifier,
  badRequest,
};
