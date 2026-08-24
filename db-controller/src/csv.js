'use strict';

/**
 * CSV の組み立てと読み取り。
 *
 * 方針:
 *   - 書式は RFC 4180 に従う (区切り文字・引用符・改行を含む値を正しく扱う)
 *   - 日本語環境では Shift_JIS の CSV が多いため、入出力とも文字コードを選べる
 *   - Excel で開くことを考え、UTF-8 出力には BOM を付けられるようにする
 */

const iconv = require('iconv-lite');

const ENCODINGS = {
  'utf-8': { label: 'UTF-8 (BOM付き / Excel向け)', iconv: 'utf-8', bom: true },
  'utf-8-nobom': { label: 'UTF-8 (BOMなし)', iconv: 'utf-8', bom: false },
  'shift_jis': { label: 'Shift_JIS (CP932)', iconv: 'CP932', bom: false },
  'euc-jp': { label: 'EUC-JP', iconv: 'EUC-JP', bom: false },
};

const DELIMITERS = { comma: ',', tab: '\t', semicolon: ';' };

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function resolveEncoding(name) {
  return ENCODINGS[String(name || 'utf-8').toLowerCase()] || ENCODINGS['utf-8'];
}

function resolveDelimiter(name) {
  if (!name) return ',';
  return DELIMITERS[String(name).toLowerCase()] || (String(name).length === 1 ? String(name) : ',');
}

/* ------------------------------------------------------------
 * 書き出し
 * ---------------------------------------------------------- */

/** 1 つの値を CSV のフィールドにする。 */
function formatField(value, delimiter) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  // 区切り文字・引用符・改行のいずれかを含むなら引用符で囲み、内部の " は "" にする
  if (text.includes(delimiter) || text.includes('"') || text.includes('\n') || text.includes('\r')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** 1 行分を CSV にする (改行は CRLF。RFC 4180 の既定)。 */
function formatRow(values, delimiter = ',') {
  return values.map((v) => formatField(v, delimiter)).join(delimiter) + '\r\n';
}

/** 文字列を指定の文字コードのバイト列にする。 */
function encodeText(text, encodingName) {
  const enc = resolveEncoding(encodingName);
  return iconv.encode(text, enc.iconv);
}

/** 出力の先頭に付ける BOM (不要なら空バッファ)。 */
function bomFor(encodingName) {
  return resolveEncoding(encodingName).bom ? UTF8_BOM : Buffer.alloc(0);
}

/* ------------------------------------------------------------
 * 読み取り
 * ---------------------------------------------------------- */

/** バイト列を文字列にする。BOM は取り除く。 */
function decodeBuffer(buffer, encodingName) {
  const enc = resolveEncoding(encodingName);
  let buf = buffer;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    buf = buf.subarray(3);
  }
  return iconv.decode(buf, enc.iconv);
}

/**
 * 文字コードを推定する。
 * UTF-8 として解釈できなければ CP932 とみなす、という単純な判定。
 */
function detectEncoding(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return 'utf-8';
  }
  // UTF-8 の妥当性を厳密に検査する
  let i = 0;
  while (i < buffer.length) {
    const b = buffer[i];
    if (b < 0x80) { i += 1; continue; }
    let extra;
    if (b >= 0xc2 && b <= 0xdf) extra = 1;
    else if (b >= 0xe0 && b <= 0xef) extra = 2;
    else if (b >= 0xf0 && b <= 0xf4) extra = 3;
    else return 'shift_jis';
    if (i + extra >= buffer.length) return 'shift_jis';
    for (let k = 1; k <= extra; k += 1) {
      if ((buffer[i + k] & 0xc0) !== 0x80) return 'shift_jis';
    }
    i += extra + 1;
  }
  return 'utf-8-nobom';
}

/**
 * CSV を行の配列に分解する (RFC 4180)。
 * 引用符の中の区切り文字・改行・"" をすべて扱う。
 */
function parse(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === '"' && field === '') { inQuotes = true; i += 1; continue; }
    if (c === delimiter) { row.push(field); field = ''; i += 1; continue; }
    if (c === '\r') {
      if (text[i + 1] === '\n') i += 1;
      row.push(field); field = ''; rows.push(row); row = [];
      i += 1;
      continue;
    }
    if (c === '\n') {
      row.push(field); field = ''; rows.push(row); row = [];
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }

  // 最終行 (末尾に改行が無い場合)
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  // 完全に空の行は落とす (末尾の改行由来)
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** 区切り文字を推定する (先頭数行で最も数が揃うもの)。 */
function detectDelimiter(text) {
  const head = text.split(/\r?\n/).slice(0, 5).filter(Boolean);
  if (!head.length) return ',';
  let best = ',';
  let bestScore = -1;
  for (const [, d] of Object.entries(DELIMITERS)) {
    const counts = head.map((line) => parse(line, d)[0]?.length || 0);
    const first = counts[0] || 0;
    if (first < 2) continue;
    const consistent = counts.every((c) => c === first);
    const score = (consistent ? 100 : 0) + first;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

module.exports = {
  ENCODINGS,
  DELIMITERS,
  resolveEncoding,
  resolveDelimiter,
  formatField,
  formatRow,
  encodeText,
  bomFor,
  decodeBuffer,
  detectEncoding,
  detectDelimiter,
  parse,
};
