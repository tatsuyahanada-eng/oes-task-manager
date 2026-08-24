'use strict';

/**
 * CSV の入出力。
 *
 * 出力:
 *   - テーブル 1 つを CSV で
 *   - SQL の結果を CSV で
 *   - スキーマ内の全テーブルを ZIP でまとめて (バックアップ用途)
 *
 * 入力:
 *   - CSV をテーブルへ取り込む。まず内容を確認 (preview) してから実行 (execute)
 *
 * 大きなテーブルを一度に読み込まないよう、出力は一定件数ずつ取得して書き出す。
 * 取り込みは全件を 1 つのトランザクションで行い、1 行でも失敗したら全体を取り消す。
 */

const express = require('express');
const pool = require('../pool');
const store = require('../store');
const audit = require('../audit');
const csv = require('../csv');
const { ZipBuilder } = require('../zip');
const { badRequest, assertIdentifier } = require('../drivers/util');
const auth = require('../session');

const router = express.Router({ mergeParams: true });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** 1 回の取得件数。大きなテーブルでもメモリに全件を載せないため。 */
const BATCH = 1000;
/** 取り込みの上限行数。 */
const MAX_IMPORT_ROWS = 50000;

async function session(req) {
  const database = req.query.database || (req.body && req.body.database) || '';
  return pool.acquire(req.params.connectionId, database);
}

/** 読み取り専用の接続では取り込みを行わない。 */
function assertWritable(connectionId) {
  const conn = store.get(connectionId);
  if (!conn) { const e = new Error('接続が見つかりません。'); e.status = 404; throw e; }
  if (conn.readOnly !== false) {
    const e = new Error(
      `接続「${conn.name}」は読み取り専用です。CSV を取り込むには、設定で「読み取り専用」を解除してください。`
    );
    e.status = 403;
    throw e;
  }
  return conn;
}

/** ダウンロード時のファイル名 (日本語などは filename* で渡す)。 */
function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '').replace(/-/g, '');

/**
 * テーブルの全行を一定件数ずつ読み、行ごとに処理する。
 * 並び順が安定するよう、主キーがあればそれで並べる。
 */
async function eachRow(s, schema, table, options, onColumns, onRow) {
  const { where = '', limit = 0 } = options;

  let orderBy = '';
  try {
    const detail = await s.driver.describeTable(s.client, schema, table);
    if (detail.primaryKey.length) orderBy = detail.primaryKey[0];
  } catch { /* 並び順が取れなくても出力は続ける */ }

  let offset = 0;
  let total = 0;
  let columnsSent = false;

  for (;;) {
    const size = limit > 0 ? Math.min(BATCH, limit - total) : BATCH;
    if (size <= 0) break;

    const result = await s.driver.selectRows(s.client, schema, table, {
      limit: size, offset, orderBy, orderDir: 'ASC', where,
    });

    if (!columnsSent) { onColumns(result.columns); columnsSent = true; }
    for (const row of result.rows) onRow(row);

    total += result.rows.length;
    offset += result.rows.length;
    if (result.rows.length < size) break;
  }

  if (!columnsSent) {
    // 0 行でも列名だけは出す
    const detail = await s.driver.describeTable(s.client, schema, table);
    onColumns(detail.columns.map((c) => c.name));
  }
  return total;
}

/* ============================================================
 * 出力: テーブル 1 つ
 * ========================================================== */

router.get('/tables/:schema/:table/export.csv', wrap(async (req, res) => {
  const { schema, table } = req.params;
  assertIdentifier(schema, 'スキーマ名');
  assertIdentifier(table, 'テーブル名');

  const encoding = req.query.encoding || 'utf-8';
  const delimiter = csv.resolveDelimiter(req.query.delimiter);
  const limit = Number(req.query.limit) || 0;
  const s = await session(req);

  res.setHeader('Content-Type', 'text/csv; charset=' + csv.resolveEncoding(encoding).iconv);
  res.setHeader('Content-Disposition', contentDisposition(`${schema}.${table}_${stamp()}.csv`));
  res.setHeader('Cache-Control', 'no-store');
  res.write(csv.bomFor(encoding));

  const count = await eachRow(
    s, schema, table, { where: req.query.where || '', limit },
    (columns) => res.write(csv.encodeText(csv.formatRow(columns, delimiter), encoding)),
    (row) => res.write(csv.encodeText(csv.formatRow(row, delimiter), encoding))
  );

  console.log(`[csv] 出力 ${schema}.${table} — ${count} 行`);
  res.end();
}));

/* ============================================================
 * 出力: SQL の結果
 * ========================================================== */

router.post('/export/query.csv', wrap(async (req, res) => {
  const { sql, encoding = 'utf-8', delimiter: delimName } = req.body || {};
  const delimiter = csv.resolveDelimiter(delimName);
  const s = await session(req);

  // 参照専用のガードは driver.runQuery 側で効く
  const result = await s.driver.runQuery(s.client, sql, 1000000);

  res.setHeader('Content-Type', 'text/csv; charset=' + csv.resolveEncoding(encoding).iconv);
  res.setHeader('Content-Disposition', contentDisposition(`query_${stamp()}.csv`));
  res.setHeader('Cache-Control', 'no-store');
  res.write(csv.bomFor(encoding));
  res.write(csv.encodeText(csv.formatRow(result.columns, delimiter), encoding));
  for (const row of result.rows) {
    res.write(csv.encodeText(csv.formatRow(row, delimiter), encoding));
  }
  res.end();
}));

/* ============================================================
 * 出力: スキーマ全体を ZIP で
 * ========================================================== */

router.get('/export/schema.zip', wrap(async (req, res) => {
  const schema = req.query.schema;
  if (!schema) throw badRequest('schema は必須です。');
  assertIdentifier(schema, 'スキーマ名');

  const encoding = req.query.encoding || 'utf-8';
  const delimiter = csv.resolveDelimiter(req.query.delimiter);
  const includeViews = req.query.includeViews === 'true';
  const s = await session(req);

  const { database } = s;
  const tables = (await s.driver.listTables(s.client, schema))
    .filter((t) => includeViews || t.type === 'TABLE');

  const zip = new ZipBuilder();
  const summary = [];

  for (const t of tables) {
    const parts = [csv.bomFor(encoding)];
    let count = 0;
    try {
      count = await eachRow(
        s, schema, t.name, { where: '', limit: 0 },
        (columns) => parts.push(csv.encodeText(csv.formatRow(columns, delimiter), encoding)),
        (row) => parts.push(csv.encodeText(csv.formatRow(row, delimiter), encoding))
      );
      zip.add(`${schema}/${t.name}.csv`, Buffer.concat(parts));
      summary.push({ table: t.name, type: t.type, rows: count, ok: true });
    } catch (err) {
      // 1 つのテーブルで失敗しても、他のテーブルの取得は続ける
      summary.push({ table: t.name, type: t.type, rows: 0, ok: false, error: err.message });
    }
  }

  // 何を取得したかが後から分かるように、一覧を同梱する
  const manifest = [
    `# CSV バックアップ`,
    `作成日時: ${new Date().toLocaleString('ja-JP')}`,
    `接続: ${s.connectionName}`,
    `DB種別: ${s.type}`,
    database ? `データベース: ${database}` : null,
    `スキーマ: ${schema}`,
    `文字コード: ${csv.resolveEncoding(encoding).label}`,
    `区切り文字: ${delimiter === '\t' ? 'タブ' : delimiter}`,
    '',
    '対象:',
    ...summary.map((x) => `  ${x.ok ? '○' : '×'} ${x.table} (${x.type}) ${x.ok ? `${x.rows} 行` : `失敗: ${x.error}`}`),
  ].filter((x) => x !== null).join('\r\n');
  zip.add(`${schema}/_backup_info.txt`, Buffer.from(manifest, 'utf8'));

  const buffer = zip.end();
  const failed = summary.filter((x) => !x.ok).length;
  console.log(`[csv] ZIP 出力 ${schema} — ${summary.length - failed}/${summary.length} テーブル`);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', contentDisposition(`${schema}_backup_${stamp()}.zip`));
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Cache-Control', 'no-store');
  res.end(buffer);
}));

/** ZIP を作る前に、対象と概算の規模を知らせる。 */
router.get('/export/schema-info', wrap(async (req, res) => {
  const schema = req.query.schema;
  if (!schema) throw badRequest('schema は必須です。');
  const s = await session(req);
  const tables = await s.driver.listTables(s.client, schema);
  res.json({
    schema,
    tables: tables.map((t) => ({ name: t.name, type: t.type, estimatedRows: t.estimatedRows })),
    tableCount: tables.filter((t) => t.type === 'TABLE').length,
    viewCount: tables.filter((t) => t.type !== 'TABLE').length,
  });
}));

/* ============================================================
 * 入力: CSV の取り込み
 * ========================================================== */

/** 生のリクエストボディ (CSV のバイト列) を受け取る。 */
const rawCsv = express.raw({ type: '*/*', limit: '64mb' });

/** CSV を解析し、対象テーブルの列と突き合わせる。 */
async function analyze(req, s) {
  const { schema, table } = req.query;
  if (!schema || !table) throw badRequest('schema と table は必須です。');
  assertIdentifier(schema, 'スキーマ名');
  assertIdentifier(table, 'テーブル名');

  const buffer = req.body;
  if (!buffer || !buffer.length) throw badRequest('CSV が空です。');

  const encoding = req.query.encoding && req.query.encoding !== 'auto'
    ? req.query.encoding
    : csv.detectEncoding(buffer);
  const text = csv.decodeBuffer(buffer, encoding);
  const delimiter = req.query.delimiter && req.query.delimiter !== 'auto'
    ? csv.resolveDelimiter(req.query.delimiter)
    : csv.detectDelimiter(text);

  const rows = csv.parse(text, delimiter);
  if (!rows.length) throw badRequest('CSV に行がありません。');

  const hasHeader = req.query.header !== 'false';
  const header = hasHeader ? rows[0] : rows[0].map((_, i) => `列${i + 1}`);
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const detail = await s.driver.describeTable(s.client, schema, table);
  const tableColumns = detail.columns.map((c) => c.name);
  const lower = new Map(tableColumns.map((c) => [c.toLowerCase(), c]));

  // ヘッダー名をテーブルの列名に対応づける (大文字小文字は無視)
  const mapping = header.map((h) => {
    const name = String(h).trim();
    return { csvColumn: name, tableColumn: lower.get(name.toLowerCase()) || null };
  });

  const matched = mapping.filter((m) => m.tableColumn);
  const unmatched = mapping.filter((m) => !m.tableColumn).map((m) => m.csvColumn);
  const missingRequired = detail.columns
    .filter((c) => !c.nullable && !c.defaultValue && !c.isIdentity)
    .filter((c) => !matched.some((m) => m.tableColumn === c.name))
    .map((c) => c.name);

  const badWidth = [];
  dataRows.forEach((r, i) => {
    if (r.length !== header.length && badWidth.length < 5) {
      badWidth.push({ line: i + (hasHeader ? 2 : 1), expected: header.length, actual: r.length });
    }
  });

  return {
    encoding, delimiter, hasHeader, header, dataRows, detail,
    mapping, matched, unmatched, missingRequired, badWidth, tableColumns,
    schema, table,
  };
}

/** 取り込み前の確認。実際には書き込まない。 */
router.post('/import/preview', auth.requireRole('operator'), rawCsv, wrap(async (req, res) => {
  const s = await session(req);
  const a = await analyze(req, s);

  const warnings = [];
  if (a.unmatched.length) {
    warnings.push(`テーブルに無い列は無視します: ${a.unmatched.join(', ')}`);
  }
  if (a.missingRequired.length) {
    warnings.push(`CSV に含まれていない必須列があります: ${a.missingRequired.join(', ')}（既定値が無ければ失敗します）`);
  }
  if (a.badWidth.length) {
    warnings.push(`列数が合わない行があります（例: ${a.badWidth.map((b) => `${b.line}行目 ${b.actual}列`).join(' / ')}）`);
  }
  if (a.dataRows.length > MAX_IMPORT_ROWS) {
    warnings.push(`行数が上限 ${MAX_IMPORT_ROWS.toLocaleString('ja-JP')} を超えています（${a.dataRows.length.toLocaleString('ja-JP')} 行）`);
  }
  if (!a.matched.length) {
    warnings.push('対応する列が 1 つもありません。ヘッダー行や区切り文字の設定を確認してください。');
  }

  res.json({
    schema: a.schema,
    table: a.table,
    encoding: a.encoding,
    encodingLabel: csv.resolveEncoding(a.encoding).label,
    delimiter: a.delimiter === '\t' ? 'tab' : a.delimiter,
    hasHeader: a.hasHeader,
    totalRows: a.dataRows.length,
    mapping: a.mapping,
    matchedColumns: a.matched.map((m) => m.tableColumn),
    unmatchedColumns: a.unmatched,
    missingRequired: a.missingRequired,
    tableColumns: a.tableColumns,
    sample: a.dataRows.slice(0, 10),
    warnings,
    canImport: a.matched.length > 0 && a.dataRows.length > 0 && a.dataRows.length <= MAX_IMPORT_ROWS,
  });
}));

/** 取り込みの実行。全件を 1 つのトランザクションで行う。 */
router.post('/import/execute', auth.requireRole('operator'), rawCsv, wrap(async (req, res) => {
  const conn = assertWritable(req.params.connectionId);
  if (req.query.confirm !== 'true') throw badRequest('実行前の確認が行われていません。');

  const s = await session(req);
  const a = await analyze(req, s);

  if (!a.matched.length) throw badRequest('対応する列がありません。');
  if (a.dataRows.length > MAX_IMPORT_ROWS) {
    throw badRequest(`一度に取り込めるのは ${MAX_IMPORT_ROWS.toLocaleString('ja-JP')} 行までです。`);
  }

  // 空文字を NULL として扱うか (既定は扱う)
  const emptyAsNull = req.query.emptyAsNull !== 'false';

  // CSV の列位置 → テーブルの列名
  const columnAt = a.mapping.map((m) => m.tableColumn);

  await s.driver.begin(s.client);
  let inserted = 0;
  try {
    for (let i = 0; i < a.dataRows.length; i += 1) {
      const row = a.dataRows[i];
      const values = {};
      columnAt.forEach((col, idx) => {
        if (!col) return;
        const raw = row[idx];
        if (raw === undefined) return;
        values[col] = emptyAsNull && raw === '' ? null : raw;
      });
      if (!Object.keys(values).length) continue;

      try {
        const r = await s.driver.insertRow(s.client, a.schema, a.table, values);
        inserted += r.affected || 0;
      } catch (err) {
        const line = i + (a.hasHeader ? 2 : 1);
        err.message = `${line} 行目で失敗したため、取り込みをすべて取り消しました: ${err.message}`;
        err.status = 400;
        throw err;
      }
    }
    await s.driver.commit(s.client);
  } catch (err) {
    await s.driver.rollback(s.client).catch(() => {});
    throw err;
  }

  audit.record({
    action: 'import',
    user: req.session.username,
    connection: conn.name,
    type: conn.type,
    database: s.database,
    target: `${a.schema}.${a.table}`,
    affected: inserted,
    sql: `CSV 取り込み (${a.matched.map((m) => m.tableColumn).join(', ')})`,
  });

  console.log(`[csv] 取り込み ${a.schema}.${a.table} — ${inserted} 行`);
  res.json({ ok: true, inserted, columns: a.matched.map((m) => m.tableColumn) });
}));

/** 画面のプルダウン用 */
router.get('/csv/options', (req, res) => {
  res.json({
    encodings: Object.entries(csv.ENCODINGS).map(([id, v]) => ({ id, label: v.label })),
    delimiters: [
      { id: 'comma', label: 'カンマ ( , )' },
      { id: 'tab', label: 'タブ' },
      { id: 'semicolon', label: 'セミコロン ( ; )' },
    ],
    maxImportRows: MAX_IMPORT_ROWS,
  });
});

module.exports = router;
