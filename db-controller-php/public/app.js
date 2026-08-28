'use strict';

/* ============================================================
 * DB Controller — フロントエンド (PWA)
 *
 * 画面:
 *   ツリー / データ / CUI / 設定
 *   PC はツリー常時表示 + 右側切替、スマホは下部タブで 1 画面ずつ
 *
 * 安全の考え方 (サーバ側と同じ):
 *   - 接続は既定で読み取り専用。書き込み可のときだけ編集 UI が出る
 *   - 変更は主キーで特定した 1 行ずつ。実行前に SQL と差分を見せて確認
 * ========================================================== */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  drivers: [],
  me: null,
  theme: null,
  labels: {},
  servers: [],
  view: 'tree',
  /** ツリーの展開状態 key -> bool */
  open: {},
  /** 現在の選択 */
  sel: { serverId: null, database: '', schema: '', table: null },
  detail: null,
  rows: [],
  rowColumns: [],
  offset: 0,
  limit: 50,
  orderBy: '',
  orderDir: 'ASC',
  where: '',
  /** 検索パネルの条件 [{column, op, value, value2}] */
  filters: [],
  editing: null,
  pending: null,
  history: [],
  historyIndex: -1,
};

/* ------------------------------------------------------------
 * API
 * ---------------------------------------------------------- */

/**
 * API の基準パス。
 *
 * このアプリはサブディレクトリに置かれることがある
 * （例: https://例.com/AI-TOOL/DBControler/）。
 * "/api/..." と絶対パスで呼ぶと、ブラウザはドメインの直下を見にいってしまい、
 * サブディレクトリでは全部 404 になる。
 * index.html の位置から基準を求め、そこからの相対で呼ぶ。
 */
const BASE = location.pathname.replace(/\/[^/]*$/, '');

/** "/api/..." を、いまの設置場所に合わせた URL にする。 */
function url(path) {
  return path.startsWith('/') ? BASE + path : path;
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(url(path), {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    // fetch 自体が失敗 = サーバから応答が返っていない
    throw new Error('サーバに接続できません。DB Controller の Node.js が起動しているか確認してください。');
  }
  const text = await res.text();
  let payload = {};
  if (text) {
    try { payload = JSON.parse(text); }
    catch { throw new Error(`応答を解釈できません (HTTP ${res.status})`); }
  }
  // セッションが切れていたらログイン画面へ戻す
  if (res.status === 401 && payload.needLogin) {
    location.replace(BASE + '/login.html');
    throw new Error('ログインが必要です。');
  }
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

function dbPath(serverId, suffix, params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, v);
  }
  const enc = suffix ? '/' + suffix.split('/').map(encodeURIComponent).join('/') : '';
  const qs = q.toString();
  return `/api/db/${serverId}${enc}${qs ? `?${qs}` : ''}`;
}

const serverById = (id) => state.servers.find((s) => s.id === id) || null;
/**
 * この接続でデータを変更できるか。
 * 接続が書き込み可であることと、ログイン中の利用者が運用者以上であることの両方が要る。
 */
const canWrite = (id) => {
  const s = serverById(id);
  if (!state.me || !state.me.canWrite) return false;
  return Boolean(s && s.readOnly === false);
};

/* ------------------------------------------------------------
 * 画面切替
 * ---------------------------------------------------------- */

function setView(view) {
  state.view = view;
  const desktop = window.matchMedia('(min-width: 820px)').matches;

  // PC ではツリーが常時表示なので、右側には「データ」を出しておく
  const right = desktop && view === 'tree' ? 'data' : view;

  $$('.pane').forEach((p) => {
    const v = p.dataset.view;
    p.classList.toggle('is-active', v === right || (desktop && v === 'tree'));
  });
  $$('.tabbar .tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === view));
  $$('.desktop-tabs .dtab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === right));

  if (right === 'cui') setTimeout(() => $('#consoleInput').focus(), 60);
}

$$('.tabbar .tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
$$('.desktop-tabs .dtab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));

// PC ではツリーを常に出す必要があるので、幅の変化に追従する
window.matchMedia('(min-width: 820px)').addEventListener('change', () => setView(state.view));

/* ------------------------------------------------------------
 * トースト
 * ---------------------------------------------------------- */

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toastStack').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3200);
}

function esc(v) {
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const num = (v) => Number(v).toLocaleString('ja-JP');

/* ============================================================
 * ツリー
 * ========================================================== */

async function loadServers() {
  const { connections } = await api('/api/connections');
  state.servers = connections;
  renderTree();
  renderServerList();
  updateBadges();

  // 開いたままだったサーバ枝を復元する。renderTree() は
  // 「開いている見た目」だけを再現するので、中身は改めて取り直す。
  for (const s of state.servers) {
    if (state.open[nodeKey('srv', s.id)]) connectServer(s.id);
  }
}

function updateBadges() {
  const id = state.sel.serverId;
  const badge = $('#modeBadge');
  if (!id) {
    badge.hidden = true;
    $('#btnAddRow').hidden = true;
    return;
  }
  const w = canWrite(id);
  const byRole = state.me && !state.me.canWrite;
  badge.hidden = false;
  badge.textContent = w
    ? badgeLabel('writable', '書込可')
    : badgeLabel('readOnly', '読取専用') + (byRole ? '（権限）' : '');
  badge.className = `mode-badge ${w ? 'is-writable' : ''}`;

  const editable = w && state.detail && state.detail.primaryKey.length
    && state.sel.table && state.sel.table.type === 'TABLE';
  $('#btnAddRow').hidden = !editable;

  // 読取専用で、かつ自分で解除できる（管理者）なら、バッジを押せるようにする。
  // 「なぜ直せないのか」で終わらせず、「ここを押せば直せる」までつなげる。
  const canFix = !w && !byRole && state.me && state.me.canManageUsers;
  badge.classList.toggle('is-actionable', canFix);
  badge.title = byRole
    ? `ログイン中の権限（${state.me.roleLabel || state.me.role}）ではデータを変更できません。`
    : (canFix ? 'クリックすると、この接続の設定を開きます。' : '');
}

$('#modeBadge').addEventListener('click', () => {
  const id = state.sel.serverId;
  if (!id || !$('#modeBadge').classList.contains('is-actionable')) return;
  setView('settings');
  openServerModal(id);
});

/** ツリーは「必要になったときに読む」遅延展開。 */
// 区切りには名前に現れない文字を使う (テーブル名に空白が含まれても衝突しない)
function nodeKey(...parts) { return parts.join('\u0000'); }

function renderTree() {
  const wrap = $('#tree');
  if (!state.servers.length) {
    wrap.innerHTML = '<p class="empty">サーバが未登録です<br><br>' +
      '<button class="btn btn-sm btn-primary" data-act="add-server">+ サーバを追加</button></p>';
    return;
  }
  wrap.innerHTML = state.servers.map((s) => renderServerNode(s)).join('');
}

function renderServerNode(s) {
  const key = nodeKey('srv', s.id);
  const open = Boolean(state.open[key]);
  const driver = state.drivers.find((d) => d.id === s.type);
  const selected = state.sel.serverId === s.id && !state.sel.database;

  return `<div class="tree-node">
    <div class="tree-row${selected ? ' is-selected' : ''}" data-kind="server" data-server="${s.id}">
      <span class="tree-caret${open ? ' is-open' : ''}">▶</span>
      <span class="tree-icon server">■</span>
      <span class="tree-label">${esc(s.name)}</span>
      <span class="pill ${esc(s.type)}">${esc(driver ? driver.label.split(' ')[0] : s.type)}</span>
      ${s.readOnly === false ? '<span class="pill rw">W</span>' : ''}
    </div>
    <div class="tree-children" data-children="${key}">${open ? '<p class="tree-loading">読み込み中…</p>' : ''}</div>
  </div>`;
}

/** 子ノードの HTML を差し込む。 */
function setChildren(key, html) {
  const el = document.querySelector(`[data-children="${CSS.escape(key)}"]`);
  if (el) el.innerHTML = html;
}

$('#tree').addEventListener('click', async (ev) => {
  if (ev.target.dataset.act === 'add-server') return openServerModal(null);

  const row = ev.target.closest('.tree-row');
  if (!row) return;
  const kind = row.dataset.kind;

  if (kind === 'server') return toggleServer(row.dataset.server);
  if (kind === 'database') return toggleDatabase(row.dataset.server, row.dataset.database);
  if (kind === 'schema') return toggleSchema(row.dataset.server, row.dataset.database, row.dataset.schema);
  if (kind === 'table') {
    return openTable(row.dataset.server, row.dataset.database, row.dataset.schema,
      row.dataset.table, row.dataset.type);
  }
  if (kind === 'columns') {
    return toggleColumns(row.dataset.server, row.dataset.database, row.dataset.schema, row.dataset.table);
  }
});

async function toggleServer(id) {
  const key = nodeKey('srv', id);
  state.open[key] = !state.open[key];
  state.sel.serverId = id;
  updateBadges();

  // 全体を描き直すと、遅延読み込みした子ノードが消えてしまう。
  // 対象のサーバノードだけをその場で開閉する。
  const caret = document.querySelector(`[data-kind="server"][data-server="${CSS.escape(id)}"] .tree-caret`);
  if (caret) caret.classList.toggle('is-open', state.open[key]);
  if (!state.open[key]) { setChildren(key, ''); return; }
  await connectServer(id);
}

/**
 * サーバへ接続し、その直下（データベース、または DB 切替の無い種別ならスキーマ）を組み立てる。
 *
 * 呼び出し元は 2 つある。
 *   - ツリーでサーバを開いたとき（toggleServer から）
 *   - 接続設定を保存したあと、「開いていたはずの枝」を復元するとき（loadServers から）
 *
 * 後者が無いと、設定変更のたびに loadServers() → renderTree() が
 * ツリー全体を作り直し、開いていた枝が「読み込み中…」のまま
 * 二度と中身を取りに行かなくなる（見た目の open は復元されるが、
 * renderTree は静的な HTML を組むだけで、実際の取得は行わないため）。
 */
async function connectServer(id) {
  const key = nodeKey('srv', id);
  const s = serverById(id);
  if (!s) return;

  setChildren(key, '<p class="tree-loading">接続中…</p>');
  setStatus(`${s.name} へ接続中…`, false);
  try {
    const [{ databases, supportsDatabaseSwitch }, info] = await Promise.all([
      api(dbPath(id, 'databases')),
      api(dbPath(id, 'info')),
    ]);
    setStatus(`${s.name}`, true);
    setPrompt(`${s.name}`);
    const v = (info && info.info && info.info.version) ? String(info.info.version) : '';
    echoGui(`${s.name} に接続${v ? `（${v.split(/[\r\n]/)[0].slice(0, 40)}）` : ''}`,
            null, `\\use ${s.name}`);

    if (supportsDatabaseSwitch && databases.length) {
      setChildren(key, databases.map((d) => {
        const dk = nodeKey('db', id, d.name);
        const open = Boolean(state.open[dk]);
        return `<div class="tree-node">
          <div class="tree-row" data-kind="database" data-server="${id}" data-database="${esc(d.name)}">
            <span class="tree-caret${open ? ' is-open' : ''}">▶</span>
            <span class="tree-icon database">◆</span>
            <span class="tree-label">${esc(d.name)}</span>
          </div>
          <div class="tree-children" data-children="${dk}"></div>
        </div>`;
      }).join(''));
      // 既定のデータベースは自動で開く
      const current = info.database || databases[0].name;
      if (databases.some((d) => d.name === current)) await toggleDatabase(id, current, true);
    } else {
      // Oracle など DB 切り替えの概念が無いものは、スキーマを直接ぶら下げる
      await renderSchemas(id, '', key);
    }
  } catch (err) {
    setStatus(`${s.name} 接続失敗`, false);
    setChildren(key, `<p class="tree-loading">${esc(err.message)}</p>`);
    toast(err.message, 'err');
  }
}

async function toggleDatabase(serverId, database, forceOpen = false) {
  const key = nodeKey('db', serverId, database);
  state.open[key] = forceOpen ? true : !state.open[key];
  const caret = document.querySelector(
    `[data-kind="database"][data-server="${CSS.escape(serverId)}"][data-database="${CSS.escape(database)}"] .tree-caret`
  );
  if (caret) caret.classList.toggle('is-open', state.open[key]);
  if (!state.open[key]) { setChildren(key, ''); return; }

  state.sel.serverId = serverId;
  state.sel.database = database;
  await renderSchemas(serverId, database, key);
}

async function renderSchemas(serverId, database, parentKey) {
  setChildren(parentKey, '<p class="tree-loading">スキーマを読み込み中…</p>');
  try {
    const { schemas } = await api(dbPath(serverId, 'schemas', { database }));
    if (!schemas.length) { setChildren(parentKey, '<p class="tree-loading">スキーマなし</p>'); return; }
    setChildren(parentKey, schemas.map((sc) => {
      const sk = nodeKey('sch', serverId, database, sc.name);
      const open = Boolean(state.open[sk]);
      return `<div class="tree-node">
        <div class="tree-row" data-kind="schema" data-server="${serverId}"
             data-database="${esc(database)}" data-schema="${esc(sc.name)}">
          <span class="tree-caret${open ? ' is-open' : ''}">▶</span>
          <span class="tree-icon schema">▣</span>
          <span class="tree-label">${esc(sc.name)}</span>
          ${sc.objectCount ? `<span class="tree-meta">${sc.objectCount}</span>` : ''}
        </div>
        <div class="tree-children" data-children="${sk}"></div>
      </div>`;
    }).join(''));

    // オブジェクトが最も多いスキーマを自動で開く
    const populated = schemas.filter((s) => s.objectCount > 0);
    if (populated.length) {
      const best = populated.reduce((a, b) => (b.objectCount > a.objectCount ? b : a));
      await toggleSchema(serverId, database, best.name, true);
    }
  } catch (err) {
    setChildren(parentKey, `<p class="tree-loading">${esc(err.message)}</p>`);
  }
}

async function toggleSchema(serverId, database, schema, forceOpen = false) {
  const key = nodeKey('sch', serverId, database, schema);
  state.open[key] = forceOpen ? true : !state.open[key];
  const caret = document.querySelector(
    `[data-kind="schema"][data-server="${CSS.escape(serverId)}"][data-schema="${CSS.escape(schema)}"] .tree-caret`
  );
  if (caret) caret.classList.toggle('is-open', state.open[key]);
  if (!state.open[key]) { setChildren(key, ''); return; }

  setChildren(key, '<p class="tree-loading">テーブルを読み込み中…</p>');
  try {
    const { tables } = await api(dbPath(serverId, 'tables', { database, schema }));
    state.open[nodeKey('tables', serverId, database, schema)] = tables;
    echoGui(`${schema} のテーブル一覧を取得（${tables.length} 件）`, null, '\\tables');
    renderTableNodes(serverId, database, schema, tables);
  } catch (err) {
    setChildren(key, `<p class="tree-loading">${esc(err.message)}</p>`);
  }
}

function renderTableNodes(serverId, database, schema, tables) {
  const key = nodeKey('sch', serverId, database, schema);
  const filter = $('#treeFilter').value.trim().toLowerCase();
  const list = filter ? tables.filter((t) => t.name.toLowerCase().includes(filter)) : tables;

  if (!list.length) { setChildren(key, '<p class="tree-loading">該当なし</p>'); return; }

  setChildren(key, list.map((t) => {
    const ck = nodeKey('col', serverId, database, schema, t.name);
    const open = Boolean(state.open[ck]);
    const isSel = state.sel.table && state.sel.table.name === t.name
      && state.sel.schema === schema && state.sel.serverId === serverId;
    const rows = t.estimatedRows === null || t.estimatedRows === undefined
      ? '' : `<span class="tree-meta">~${num(t.estimatedRows)}</span>`;
    return `<div class="tree-node">
      <div class="tree-row${isSel ? ' is-selected' : ''}" data-kind="table" data-server="${serverId}"
           data-database="${esc(database)}" data-schema="${esc(schema)}"
           data-table="${esc(t.name)}" data-type="${esc(t.type)}" title="${esc(t.comment || t.name)}">
        <span class="tree-caret is-leaf">▶</span>
        <span class="tree-icon ${t.type === 'TABLE' ? 'table' : 'view'}">${t.type === 'TABLE' ? '▤' : '◫'}</span>
        <span class="tree-label">${esc(t.name)}</span>${rows}
      </div>
      <div class="tree-node" style="margin-left:13px">
        <div class="tree-row" data-kind="columns" data-server="${serverId}"
             data-database="${esc(database)}" data-schema="${esc(schema)}" data-table="${esc(t.name)}">
          <span class="tree-caret${open ? ' is-open' : ''}">▶</span>
          <span class="tree-icon column">≡</span>
          <span class="tree-label" style="color:var(--text-dim)">カラム</span>
        </div>
        <div class="tree-children" data-children="${ck}"></div>
      </div>
    </div>`;
  }).join(''));
}

async function toggleColumns(serverId, database, schema, table) {
  const key = nodeKey('col', serverId, database, schema, table);
  state.open[key] = !state.open[key];
  const caret = document.querySelector(
    `[data-kind="columns"][data-table="${CSS.escape(table)}"][data-schema="${CSS.escape(schema)}"] .tree-caret`
  );
  if (caret) caret.classList.toggle('is-open', state.open[key]);
  if (!state.open[key]) { setChildren(key, ''); return; }

  setChildren(key, '<p class="tree-loading">読み込み中…</p>');
  try {
    const d = await api(dbPath(serverId, `tables/${schema}/${table}`, { database }));
    setChildren(key, d.columns.map((c) => `
      <div class="tree-row" style="cursor:default">
        <span class="tree-caret is-leaf">▶</span>
        <span class="tree-icon column">${c.isPrimaryKey ? '🔑' : '·'}</span>
        <span class="tree-label">${esc(c.name)}</span>
        <span class="tree-meta">${esc(c.dataType)}${c.nullable ? '' : ' *'}</span>
      </div>`).join(''));
  } catch (err) {
    setChildren(key, `<p class="tree-loading">${esc(err.message)}</p>`);
  }
}

$('#treeFilter').addEventListener('input', () => {
  const { serverId, database, schema } = state.sel;
  if (!serverId || !schema) return;
  const tables = state.open[nodeKey('tables', serverId, database, schema)];
  if (Array.isArray(tables)) renderTableNodes(serverId, database, schema, tables);
});

$('#btnRefreshTree').addEventListener('click', async () => {
  state.open = {};
  await loadServers();
  toast('ツリーを再読み込みしました', 'ok');
});

/* ============================================================
 * データ
 * ========================================================== */

function setStatus(text, connected) {
  const el = $('#connStatus');
  el.textContent = text;
  el.classList.toggle('is-connected', Boolean(connected));
}

function setPrompt(name) { $('#consolePrompt').textContent = name ? `${name} $` : '$'; }

async function openTable(serverId, database, schema, table, type) {
  state.sel = { serverId, database, schema, table: { name: table, type } };
  state.detail = null;
  state.offset = 0;
  state.orderBy = '';
  state.orderDir = 'ASC';
  state.where = '';
  state.filters = [];
  $('#whereInput').value = '';
  $('#dataTitle').textContent = `${schema}.${table}`;

  highlightSelectedTable();
  setView('data');
  await loadDefinition();
  renderFilterPanel();
  await loadRows();
}

/** ツリーを描き直さずに、選択中のテーブルだけ強調する。 */
function highlightSelectedTable() {
  const { serverId, schema, table } = state.sel;
  $$('.tree-row[data-kind="table"]').forEach((row) => {
    const isSel = row.dataset.server === serverId
      && row.dataset.schema === schema
      && row.dataset.table === (table ? table.name : '');
    row.classList.toggle('is-selected', isSel);
  });
}

async function loadDefinition() {
  const { serverId, database, schema, table } = state.sel;
  try {
    state.detail = await api(dbPath(serverId, `tables/${schema}/${table.name}`, { database }));
    echoGui(`${schema}.${table.name} の列定義を取得`, null, `\\d ${table.name}`);
  } catch {
    state.detail = null;
  }
  updateBadges();
}

/* ============================================================
 * 検索パネル（日付・ユーザー・項目などで絞り込む）
 * ========================================================== */

/** 列の型を、検索欄をどう出すかの区分にする。 */
function columnKind(dataType) {
  const t = String(dataType || '').toLowerCase();
  if (/bool/.test(t)) return 'bool';
  if (/date|time/.test(t)) return 'date';
  if (/int|numeric|decimal|float|double|real|serial|money/.test(t)) return 'number';
  return 'text';
}

const FILTER_OPS = {
  date:   [['between', '期間で指定'], ['eq', 'この日'], ['gte', '以降'], ['lte', '以前'],
           ['is_null', '未設定'], ['is_not_null', '設定あり']],
  number: [['eq', '等しい'], ['ne', '等しくない'], ['gte', '以上'], ['lte', '以下'],
           ['between', '範囲で指定'], ['is_null', '未設定'], ['is_not_null', '設定あり']],
  bool:   [['eq', '等しい'], ['is_null', '未設定'], ['is_not_null', '設定あり']],
  text:   [['contains', '含む'], ['eq', '等しい'], ['starts_with', 'で始まる'], ['ends_with', 'で終わる'],
           ['in', 'いずれかに一致（改行/カンマ区切り）'], ['is_null', '未設定'], ['is_not_null', '設定あり']],
};

const FILTER_INPUT_TYPE = { date: 'date', number: 'number', bool: 'text', text: 'text' };

let filterRowSeq = 0;

/** 検索パネルを作り直す。ボタンを押さなくても条件を組めるよう、最初から1行出しておく。 */
function renderFilterPanel() {
  filterRowSeq = 0;
  $('#filterRows').innerHTML = '';
  $('#filterPanel').hidden = !state.detail;
  if (state.detail) addFilterRow();
}

/** 条件行が1つも無くならないようにする。無くなったら空の1行を出し直す。 */
function ensureFilterRow() {
  if (!$('#filterRows').querySelector('.filter-row')) addFilterRow();
}

function addFilterRow() {
  if (!state.detail || !state.detail.columns.length) return;
  const idx = filterRowSeq++;
  const col = state.detail.columns[0];
  const row = document.createElement('div');
  row.className = 'filter-row';
  row.dataset.idx = String(idx);
  row.innerHTML = filterRowHtml(col.name);
  $('#filterRows').appendChild(row);
  fillFilterOps(row, col.name);
}

function filterRowHtml(colName) {
  const cols = state.detail.columns.map((c) =>
    `<option value="${esc(c.name)}"${c.name === colName ? ' selected' : ''}>${esc(c.name)}（${esc(c.dataType)}）</option>`
  ).join('');
  return `
    <select class="filter-col">${cols}</select>
    <select class="filter-op"></select>
    <span class="filter-values">
      <input class="filter-val" type="text">
      <span class="filter-sep" hidden>〜</span>
      <input class="filter-val2" type="text" hidden>
    </span>
    <button type="button" class="btn btn-sm btn-danger filter-remove" title="この条件を削除">×</button>`;
}

/**
 * 選んだ列の型に合わせて、演算子と値欄を作り直す。
 * 列の型（区分）が変わったときは、演算子は区分ごとの既定（先頭）に戻す。
 * 前の演算子をそのまま残すと、たとえば数値の「等しい」が日付でも
 * たまたま同じ値名で存在するために、日付では不向きな演算子が残ってしまう。
 */
function fillFilterOps(row, colName) {
  const col = state.detail.columns.find((c) => c.name === colName);
  const kind = columnKind(col ? col.dataType : '');
  const prevKind = row.dataset.kind || '';
  const opSel = row.querySelector('.filter-op');
  const prevOp = opSel.value;
  opSel.innerHTML = FILTER_OPS[kind].map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
  if (prevKind === kind && FILTER_OPS[kind].some(([v]) => v === prevOp)) opSel.value = prevOp;
  row.dataset.kind = kind;
  updateFilterValueInputs(row, kind);
}

function updateFilterValueInputs(row, kind) {
  const op = row.querySelector('.filter-op').value;
  const inputType = FILTER_INPUT_TYPE[kind] || 'text';
  const v1 = row.querySelector('.filter-val');
  const v2 = row.querySelector('.filter-val2');
  const sep = row.querySelector('.filter-sep');

  const noValue = op === 'is_null' || op === 'is_not_null';
  const isBetween = op === 'between';

  v1.hidden = noValue;
  v2.hidden = !isBetween;
  sep.hidden = !isBetween;
  v1.type = kind === 'bool' ? 'text' : inputType;
  v2.type = v1.type;
  if (kind === 'bool' && !noValue) {
    v1.placeholder = 'true / false など';
  } else if (op === 'in') {
    v1.placeholder = '値1, 値2 …';
  } else {
    v1.placeholder = '';
  }
}

$('#btnAddFilter').addEventListener('click', addFilterRow);

/** 「条件をクリア」: 全部消して、最初の空の1行だけに戻す。 */
$('#btnClearFilter').addEventListener('click', () => {
  $('#filterRows').innerHTML = '';
  filterRowSeq = 0;
  addFilterRow();
});

$('#filterRows').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.filter-remove');
  if (!btn) return;
  btn.closest('.filter-row').remove();
  ensureFilterRow();
});

$('#filterRows').addEventListener('change', (ev) => {
  const row = ev.target.closest('.filter-row');
  if (!row) return;
  if (ev.target.classList.contains('filter-col')) {
    fillFilterOps(row, ev.target.value);
  } else if (ev.target.classList.contains('filter-op')) {
    const col = state.detail.columns.find((c) => c.name === row.querySelector('.filter-col').value);
    updateFilterValueInputs(row, columnKind(col ? col.dataType : ''));
  }
});

// 検索欄で Enter を押したときも、SQL条件欄と同じく「検索」を押したことにする。
// 条件を入力しただけで押し忘れると、前の結果が出たままになって
// 「絞り込みが効いていない」ように見えてしまうため。
$('#filterRows').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  if (!ev.target.classList.contains('filter-val') && !ev.target.classList.contains('filter-val2')) return;
  ev.preventDefault();
  $('#btnReload').click();
});

/** 画面の検索条件を、サーバへ送る形にする。値が要る条件で空欄なら無視する。 */
function collectFilters() {
  if (!$('#filterPanel') || $('#filterPanel').hidden) return [];
  return $$('#filterRows .filter-row').map((row) => {
    const column = row.querySelector('.filter-col').value;
    const op = row.querySelector('.filter-op').value;
    const value = row.querySelector('.filter-val').value.trim();
    const value2 = row.querySelector('.filter-val2').value.trim();
    return { column, op, value, value2 };
  }).filter((f) => {
    if (f.op === 'is_null' || f.op === 'is_not_null') return true;
    if (f.op === 'between') return f.value !== '' || f.value2 !== '';
    return f.value !== '';
  });
}

function filtersParam() {
  const f = state.filters;
  return f && f.length ? JSON.stringify(f) : '';
}

/** 検索条件を、日本語の一言にする。CUI に流す説明で使う。 */
function describeFilters() {
  const opLabel = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤',
    contains: 'を含む', starts_with: 'で始まる', ends_with: 'で終わる',
    is_null: '未設定', is_not_null: '設定あり', in: 'のいずれか' };
  return state.filters.map((f) => {
    if (f.op === 'is_null' || f.op === 'is_not_null') return `${f.column} ${opLabel[f.op]}`;
    if (f.op === 'between') return `${f.column} ${f.value || '…'}〜${f.value2 || '…'}`;
    return `${f.column} ${opLabel[f.op] || f.op} 「${f.value}」`;
  });
}

/** いまの参照条件を、日本語の一言にする。 */
function describeSelect() {
  const { schema, table } = state.sel;
  const parts = [`${schema}.${table.name} を表示`];
  const fdesc = describeFilters();
  if (fdesc.length) parts.push(`検索: ${fdesc.join(' かつ ')}`);
  if (state.where) parts.push(`SQL条件: ${state.where}`);
  if (state.orderBy) parts.push(`並び替え: ${state.orderBy} ${state.orderDir}`);
  if (state.offset) parts.push(`${num(state.offset + 1)} 行目から`);
  return parts.join(' / ');
}

/** 直前に実行された SQL を、CUI を開かなくても分かるようデータ欄にも出す。 */
function showLastSql(sql) {
  const box = $('#lastSqlBox');
  if (!sql) { box.hidden = true; box.textContent = ''; return; }
  box.hidden = false;
  box.textContent = sql;
}

async function loadRows() {
  const { serverId, database, schema, table } = state.sel;
  if (!table) return;
  $('#gridWrap').innerHTML = '<p class="spinner">読み込み中…</p>';
  try {
    const r = await api(dbPath(serverId, `tables/${schema}/${table.name}/rows`, {
      database, limit: state.limit, offset: state.offset,
      orderBy: state.orderBy, orderDir: state.orderDir, where: state.where,
      filters: filtersParam(),
    }));
    state.rows = r.rows;
    state.rowColumns = r.columns;

    // 画面の操作を CUI にも残す。サーバが実際に流した SQL をそのまま出す。
    echoGui(describeSelect(), r.sql, `\\count ${table.name}`);
    showLastSql(r.sql);
    $('#gridWrap').innerHTML = r.rows.length ? buildGrid(r.columns, r.rows) : '<p class="empty">該当する行がありません</p>';
    const from = r.rows.length ? state.offset + 1 : 0;
    $('#pagerInfo').textContent = `${num(from)}–${num(state.offset + r.rows.length)}`;
    $('#btnPrev').disabled = state.offset === 0;
    $('#btnNext').disabled = r.rows.length < state.limit;
  } catch (err) {
    $('#gridWrap').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    toast(err.message, 'err');
  }
}

function rowOpsEnabled() {
  return Boolean(
    canWrite(state.sel.serverId) && state.detail && state.detail.primaryKey.length &&
    state.sel.table && state.sel.table.type === 'TABLE'
  );
}

function buildGrid(columns, rows) {
  const ops = rowOpsEnabled();
  const pk = new Set(state.detail ? state.detail.primaryKey : []);

  const head = columns.map((c) => {
    const sorted = state.orderBy === c;
    return `<th data-column="${esc(c)}">${esc(c)}` +
      `${pk.has(c) ? '<span class="pk">PK</span>' : ''}` +
      `${sorted ? `<span class="sort">${state.orderDir === 'ASC' ? '▲' : '▼'}</span>` : ''}</th>`;
  }).join('');

  const body = rows.map((row, i) => {
    const cells = row.map((v) => {
      if (v === null) return '<td class="null">NULL</td>';
      const t = String(v);
      return `<td class="${typeof v === 'number' ? 'num' : ''}" title="${esc(t)}">${esc(t)}</td>`;
    }).join('');
    const opsCell = ops
      ? `<td class="ops"><div class="ops-inner">
           <button class="btn btn-sm" data-row="${i}" data-op="edit">修正</button>
           <button class="btn btn-sm btn-danger" data-row="${i}" data-op="delete">削除</button>
         </div></td>` : '';
    return `<tr>${opsCell}${cells}</tr>`;
  }).join('');

  return `<table class="grid"><thead><tr>${ops ? '<th class="ops">操作</th>' : ''}${head}</tr></thead>
    <tbody>${body}</tbody></table>`;
}

$('#gridWrap').addEventListener('click', (ev) => {
  const opBtn = ev.target.closest('button[data-op]');
  if (opBtn) {
    const i = Number(opBtn.dataset.row);
    return opBtn.dataset.op === 'edit' ? openRowEditor('update', i) : confirmDelete(i);
  }
  const th = ev.target.closest('th[data-column]');
  if (!th) return;
  const col = th.dataset.column;
  if (state.orderBy === col) state.orderDir = state.orderDir === 'ASC' ? 'DESC' : 'ASC';
  else { state.orderBy = col; state.orderDir = 'ASC'; }
  state.offset = 0;
  loadRows();
});

$('#btnReload').addEventListener('click', () => {
  state.where = $('#whereInput').value.trim();
  state.filters = collectFilters();
  state.limit = Number($('#limitSelect').value);
  state.offset = 0;
  loadRows();
});
$('#whereInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnReload').click(); });
$('#btnPrev').addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); loadRows(); });
$('#btnNext').addEventListener('click', () => { state.offset += state.limit; loadRows(); });

$('#btnColumns').addEventListener('click', () => {
  if (!state.detail) return toast('テーブルを選んでください', 'err');
  const d = state.detail;
  $('#columnsTitle').textContent = `${state.sel.schema}.${state.sel.table.name}`;
  $('#columnsBody').innerHTML = `
    <div class="grid-wrap" style="max-height:56vh;border:1px solid var(--border);border-radius:6px">
      <table class="grid">
        <thead><tr><th>列名</th><th>型</th><th>NULL</th><th>既定値</th><th>キー</th><th>コメント</th></tr></thead>
        <tbody>${d.columns.map((c) => `<tr>
          <td>${esc(c.name)}</td><td>${esc(c.dataType)}</td>
          <td>${c.nullable ? 'YES' : 'NO'}</td><td>${esc(c.defaultValue || '')}</td>
          <td>${c.isPrimaryKey ? 'PK' : ''}${c.isIdentity ? ' IDENTITY' : ''}</td>
          <td>${esc(c.comment || '')}</td></tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="section-label">主キー</p>
    <p class="muted">${d.primaryKey.length ? esc(d.primaryKey.join(', ')) : '主キーなし（この表は編集できません）'}</p>
    <p class="section-label">索引</p>
    <p class="muted">${d.indexes.length ? d.indexes.map((i) => esc(i.definition || i.name)).join('<br>') : 'なし'}</p>
    <p class="section-label">外部キー</p>
    <p class="muted">${d.foreignKeys.length ? d.foreignKeys.map((f) => esc(f.definition)).join('<br>') : 'なし'}</p>`;
  $('#columnsModal').hidden = false;
});

/* ============================================================
 * 行の編集
 * ========================================================== */

function rowToObject(i) {
  const row = state.rows[i];
  if (!row) return null;
  const o = {};
  state.rowColumns.forEach((c, k) => { o[c] = row[k]; });
  return o;
}
function keyOfRow(o) {
  const k = {};
  for (const c of state.detail.primaryKey) k[c] = o[c];
  return k;
}

function openRowEditor(mode, index) {
  const original = mode === 'update' ? rowToObject(index) : null;
  state.editing = { mode, original, key: original ? keyOfRow(original) : null };

  $('#rowModalTitle').textContent = mode === 'insert' ? '行を追加' : '行を修正';
  $('#rowModalSub').textContent = `${state.sel.schema}.${state.sel.table.name}` +
    (original ? ` — ${state.detail.primaryKey.map((c) => `${c}=${original[c]}`).join(', ')}` : '');
  $('#rowFormMessage').textContent = '';

  const pk = new Set(state.detail.primaryKey);
  $('#rowEditor').innerHTML = state.detail.columns.map((c) => {
    const isKey = pk.has(c.name);
    const locked = mode === 'update' && isKey;
    const v = original ? original[c.name] : null;
    const empty = v === null || v === undefined;
    const isNull = mode === 'update' && empty;
    return `<div class="row-field${isKey ? ' is-key' : ''}" data-column="${esc(c.name)}">
      <label class="row-name" for="f_${esc(c.name)}">${esc(c.name)}
        <span class="row-type">${esc(c.dataType)}${c.nullable ? '' : ' NOT NULL'}${c.isIdentity ? ' 自動採番' : ''}</span>
      </label>
      <label class="row-null">
        <input type="checkbox" data-null="${esc(c.name)}"${isNull ? ' checked' : ''}${locked || !c.nullable ? ' disabled' : ''}> NULL
      </label>
      <input type="text" id="f_${esc(c.name)}" data-input="${esc(c.name)}"
             value="${empty ? '' : esc(String(v))}"${locked ? ' disabled' : ''}
             placeholder="${c.defaultValue && mode === 'insert' ? `既定: ${esc(c.defaultValue)}` : ''}">
    </div>`;
  }).join('');

  $('#rowModal').hidden = false;
  updateChangeCount();
}

function collectFields() {
  const out = {};
  for (const el of $$('#rowEditor input[data-input]')) {
    const col = el.dataset.input;
    const nb = document.querySelector(`#rowEditor input[data-null="${CSS.escape(col)}"]`);
    out[col] = {
      value: el.value,
      isNull: Boolean(nb && nb.checked && !nb.disabled),
      locked: el.disabled,
    };
  }
  return out;
}

function changedFields() {
  const fields = collectFields();
  const orig = state.editing.original;
  const out = {};
  for (const [col, f] of Object.entries(fields)) {
    if (f.locked) continue;
    if (state.editing.mode === 'insert') {
      if (f.isNull || f.value !== '') out[col] = { value: f.value, isNull: f.isNull };
      continue;
    }
    const before = orig[col] === null || orig[col] === undefined ? null : String(orig[col]);
    const after = f.isNull ? null : f.value;
    if (before !== after) out[col] = { value: f.value, isNull: f.isNull };
  }
  return out;
}

function updateChangeCount() {
  if (!state.editing) return;
  const c = Object.keys(changedFields());
  $('#rowChangeCount').textContent = state.editing.mode === 'insert'
    ? `${c.length} 列に入力` : `${c.length} 列を変更`;
  $$('#rowEditor .row-field').forEach((el) => el.classList.toggle('is-changed', c.includes(el.dataset.column)));
  $('#btnSubmitRow').disabled = c.length === 0;
}

$('#rowEditor').addEventListener('input', updateChangeCount);
$('#rowEditor').addEventListener('change', (ev) => {
  const nb = ev.target.closest('input[data-null]');
  if (nb) {
    const input = document.querySelector(`#rowEditor input[data-input="${CSS.escape(nb.dataset.null)}"]`);
    if (input && !input.disabled) {
      if (nb.checked) input.value = '';
      input.readOnly = nb.checked;
    }
  }
  updateChangeCount();
});

$('#btnAddRow').addEventListener('click', () => openRowEditor('insert', null));
$('#btnCancelRow').addEventListener('click', () => { $('#rowModal').hidden = true; state.editing = null; });
$('#btnCloseRow').addEventListener('click', () => { $('#rowModal').hidden = true; state.editing = null; });

function keyFields() {
  const k = {};
  for (const [c, v] of Object.entries(state.editing.key)) {
    k[c] = { value: v === null ? null : String(v), isNull: v === null };
  }
  return k;
}

const tablePath = (suffix) =>
  dbPath(state.sel.serverId, `tables/${state.sel.schema}/${state.sel.table.name}${suffix}`);

$('#btnSubmitRow').addEventListener('click', () => {
  const changed = changedFields();
  if (!Object.keys(changed).length) return;
  const { schema, table, database } = { ...state.sel, table: state.sel.table.name };
  const cols = Object.keys(changed);

  if (state.editing.mode === 'insert') {
    openConfirm({
      title: '行を追加',
      body: `<div class="notice">${esc(schema)}.${esc(table)} に 1 行追加します。</div>
        <div class="diff-list">${cols.map((c) => `<div><span class="diff-col">${esc(c)}</span> : <span class="diff-new">${esc(changed[c].isNull ? 'NULL' : changed[c].value)}</span></div>`).join('')}</div>`,
      sql: `INSERT INTO ${schema}.${table}\n  (${cols.join(', ')})\nVALUES\n  (${cols.map(() => '?').join(', ')});\n\n-- 値はすべてバインド変数として渡されます`,
      run: () => api(tablePath('/rows'), { method: 'POST', body: { database, fields: changed } }),
      done: '1 行を追加しました',
      cuiHint: `INSERT INTO ${qt(schema, table)} (${cols.map(qi).join(', ')}) VALUES (...);`,
    });
  } else {
    const orig = state.editing.original;
    openConfirm({
      title: '行を修正',
      body: `<div class="notice">対象: <strong>${esc(state.detail.primaryKey.map((c) => `${c}=${orig[c]}`).join(', '))}</strong></div>
        <div class="diff-list">${cols.map((c) => {
          const before = orig[c] === null ? 'NULL' : String(orig[c]);
          const after = changed[c].isNull ? 'NULL' : changed[c].value;
          return `<div><span class="diff-col">${esc(c)}</span> : <span class="diff-old">${esc(before)}</span> <span class="diff-arrow">→</span> <span class="diff-new">${esc(after)}</span></div>`;
        }).join('')}</div>`,
      sql: `UPDATE ${schema}.${table}\nSET\n${cols.map((c) => `  ${c} = ?`).join(',\n')}\nWHERE ${state.detail.primaryKey.map((c) => `${c} = ?`).join(' AND ')};\n\n-- 影響行数が 1 行でなければ自動でロールバックします`,
      run: () => api(tablePath('/rows'), { method: 'PATCH', body: { database, key: keyFields(), fields: changed } }),
      done: '1 行を修正しました',
      cuiHint: `UPDATE ${qt(schema, table)} SET ${cols.map((c) => `${qi(c)} = ...`).join(', ')}`
             + ` WHERE ${state.detail.primaryKey.map((c) => `${qi(c)} = ...`).join(' AND ')};`,
    });
  }
});

function confirmDelete(index) {
  const orig = rowToObject(index);
  state.editing = { mode: 'delete', original: orig, key: keyOfRow(orig) };
  const { schema, database } = state.sel;
  const table = state.sel.table.name;

  openConfirm({
    title: '行を削除',
    danger: true,
    body: `<div class="notice danger"><strong>この操作は取り消せません。</strong><br>
      対象: ${esc(state.detail.primaryKey.map((c) => `${c}=${orig[c]}`).join(', '))}</div>
      <p class="section-label">削除される行</p>
      <div class="diff-list">${state.rowColumns.map((c) =>
        `<div><span class="diff-col">${esc(c)}</span> : ${orig[c] === null ? '<span class="diff-col">NULL</span>' : esc(String(orig[c]))}</div>`).join('')}</div>`,
    sql: `DELETE FROM ${schema}.${table}\nWHERE ${state.detail.primaryKey.map((c) => `${c} = ?`).join(' AND ')};\n\n-- 影響行数が 1 行でなければ自動でロールバックします`,
    run: () => api(tablePath('/rows'), { method: 'DELETE', body: { database, key: keyFields() } }),
    done: '1 行を削除しました',
    cuiHint: `DELETE FROM ${qt(schema, table)}`
           + ` WHERE ${state.detail.primaryKey.map((c) => `${qi(c)} = ...`).join(' AND ')};`,
  });
}

/* ---------- 実行確認 ---------- */

function openConfirm({ title, danger, body, sql, run, done, after, cuiHint,
                      requireAllRows = false }) {
  // after を渡すと、成功後の後始末をそれに差し替える (既定は行の読み直し)
  // cuiHint は、同じ操作を CUI で書くときの形
  state.pending = { run, done, after, cuiHint };
  $('#confirmTitle').textContent = title;
  $('#confirmBody').innerHTML = body;
  $('#confirmSql').textContent = sql;
  $('#confirmMessage').textContent = '';
  $('#btnRunConfirm').className = danger ? 'btn btn-danger' : 'btn btn-write';
  $('#btnRunConfirm').textContent = danger ? '削除する' : '実行';
  $('#confirmAllRows').checked = false;
  $('#confirmAllRowsWrap').hidden = !requireAllRows;
  $('#btnRunConfirm').disabled = requireAllRows;
  $('#confirmModal').hidden = false;
}

$('#confirmAllRows').addEventListener('change', (e) => { $('#btnRunConfirm').disabled = !e.target.checked; });
const closeConfirm = () => { $('#confirmModal').hidden = true; state.pending = null; };
$('#btnCancelConfirm').addEventListener('click', closeConfirm);
$('#btnCloseConfirm').addEventListener('click', closeConfirm);

$('#btnRunConfirm').addEventListener('click', async () => {
  if (!state.pending) return;
  const b = $('#btnRunConfirm');
  b.disabled = true;
  const label = b.textContent;
  b.textContent = '実行中…';
  const editMode = state.editing ? state.editing.mode : null;
  try {
    const r = await state.pending.run();
    const n = r && (r.affected !== undefined ? r.affected : r.inserted);
    const msg = state.pending.done + (n !== undefined ? `（${num(n)} 行）` : '');

    // 更新系はサーバが実行した SQL を返すので、それを CUI に残す
    if (r && r.sql) {
      echoGui(
        `${state.pending.done}${n !== undefined ? `（${num(n)} 行）` : ''}`,
        r.sql,
        state.pending.cuiHint
      );
    }
    // 操作が完了したので、開いているシートはすべて閉じる
    $$('.sheet-backdrop').forEach((b) => { b.hidden = true; });
    const after = state.pending.after;
    state.pending = null;
    state.editing = null;
    toast(msg, 'ok');
    // 修正・削除は見落としが無いよう、通知(トースト)に加えてアラートでも知らせる
    if (editMode === 'update' || editMode === 'delete') alert(msg);
    await (after ? after() : loadRows());
  } catch (err) {
    $('#confirmMessage').className = 'form-message err';
    $('#confirmMessage').textContent = err.message;
  } finally {
    b.disabled = false;
    b.textContent = label;
  }
});

/* ============================================================
 * CUI コンソール
 * ========================================================== */

const CUI_HELP = `使えるコマンド:
  \\help                このヘルプ
  \\servers             登録済みサーバの一覧
  \\use <サーバ名>      サーバを選ぶ
  \\db <データベース>   データベースを切り替える
  \\schemas             スキーマ一覧
  \\tables [絞込]       テーブル一覧
  \\d <テーブル>        テーブルの列定義
  \\count <テーブル>    件数を数える
  \\export <テーブル>   テーブルを CSV で保存
  \\backup              いまのスキーマを ZIP で保存
  \\clear               画面を消す

  上記以外はそのまま SQL として実行します。
  SELECT / WITH は参照。INSERT / UPDATE / DELETE は
  「書込可」のサーバでのみ、確認のうえ実行します。
  ↑ ↓ で履歴をたどれます。`;

/* ============================================================
 * GUI 操作を CUI へ書き出す
 *
 * 画面のボタンで行った操作を、CUI 欄に「実際に流れた SQL」として
 * 残す。CUI に慣れるための写経帳のようなもの。
 *
 * 出すのは 3 行:
 *   -- [GUI] 何をしたか
 *   実際の SQL
 *      CUI: 同じことを CUI で書くとどうなるか（あれば）
 * ========================================================== */

/** 直前に出した SQL。同じものが連続したときに黙らせるため。 */
let lastEchoed = '';

function echoGui(label, sql, hint) {
  // 同じ SQL が続けて流れるときは、記録を汚さないよう省く
  const key = label + '\u0000' + (sql || '');
  if (key === lastEchoed) return;
  lastEchoed = key;

  cout(`-- [GUI] ${label}`, 'c-gui');
  if (sql) {
    // 長い SQL は読みやすいよう、行ごとに分けて出す
    String(sql).split('\n').forEach((line) => cout(line, 'c-sql'));
  }
  if (hint) cout(`   CUI: ${hint}`, 'c-hint');
}

/** 識別子を SQL に書くときの形。CUI の写経用なので、DB 種別に寄せる。 */
function qi(name) {
  const server = serverById(state.sel.serverId);
  const type = server ? server.type : 'mysql';
  if (type === 'mysql') return '`' + String(name).replace(/`/g, '``') + '`';
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/** schema.table の完全な形。 */
function qt(schema, table) {
  return `${qi(schema)}.${qi(table)}`;
}

function cout(text, cls = 'c-out') {
  const el = document.createElement('div');
  el.className = `c-line ${cls}`;
  el.textContent = text;
  $('#console').appendChild(el);
  $('#console').scrollTop = $('#console').scrollHeight;
}

/** 結果を等幅テキストの表として出す。 */
function coutTable(columns, rows) {
  if (!columns.length) return;
  const widths = columns.map((c, i) => Math.min(
    Math.max(String(c).length, ...rows.map((r) => String(r[i] === null ? 'NULL' : r[i]).length)), 28
  ));
  const cut = (s, w) => {
    const t = String(s);
    return (t.length > w ? t.slice(0, w - 1) + '…' : t).padEnd(w);
  };
  cout(columns.map((c, i) => cut(c, widths[i])).join(' | '), 'c-info');
  cout(widths.map((w) => '-'.repeat(w)).join('-+-'), 'c-info');
  for (const r of rows) {
    cout(r.map((v, i) => cut(v === null ? 'NULL' : v, widths[i])).join(' | '), 'c-table');
  }
}

$('#btnCuiClear').addEventListener('click', () => { $('#console').innerHTML = ''; });
$('#btnCuiHelp').addEventListener('click', () => cout(CUI_HELP, 'c-info'));

$('#consoleForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = $('#consoleInput');
  const line = input.value.trim();
  if (!line) return;
  input.value = '';
  state.history.push(line);
  state.historyIndex = state.history.length;
  cout(line, 'c-cmd');
  try {
    await runCui(line);
  } catch (err) {
    cout(err.message, 'c-err');
  }
});

$('#consoleInput').addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    if (state.historyIndex > 0) { state.historyIndex--; $('#consoleInput').value = state.history[state.historyIndex]; }
  } else if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    if (state.historyIndex < state.history.length - 1) {
      state.historyIndex++;
      $('#consoleInput').value = state.history[state.historyIndex];
    } else { state.historyIndex = state.history.length; $('#consoleInput').value = ''; }
  }
});

function requireServer() {
  if (!state.sel.serverId) throw new Error('サーバが選ばれていません。\\servers で一覧、\\use <名前> で選択してください。');
  return state.sel.serverId;
}

async function runCui(line) {
  const [cmd, ...rest] = line.split(/\s+/);
  const arg = rest.join(' ').trim();

  switch (cmd.toLowerCase()) {
    case '\\help': case '\\h': case 'help': return cout(CUI_HELP, 'c-info');
    case '\\clear': case 'clear': return void ($('#console').innerHTML = '');

    case '\\servers': {
      if (!state.servers.length) return cout('サーバが未登録です。設定から追加してください。', 'c-info');
      return coutTable(['名前', '種別', '接続先', 'モード'], state.servers.map((s) => [
        s.name, s.type,
        s.type === 'oracle' ? `${s.host}:${s.port}/${s.serviceName || s.sid || ''}` : `${s.host}:${s.port}`,
        s.readOnly === false ? '書込可' : '読取専用',
      ]));
    }

    case '\\use': {
      const s = state.servers.find((x) => x.name === arg)
        || state.servers.find((x) => x.name.toLowerCase().includes(arg.toLowerCase()));
      if (!s) throw new Error(`サーバが見つかりません: ${arg}`);
      state.sel.serverId = s.id;
      state.sel.database = s.database || '';
      setPrompt(s.name);
      setStatus(s.name, true);
      updateBadges();
      return cout(`サーバを ${s.name} に切り替えました（${s.readOnly === false ? '書込可' : '読取専用'}）`, 'c-ok');
    }

    case '\\db': {
      requireServer();
      state.sel.database = arg;
      return cout(`データベースを ${arg} に切り替えました`, 'c-ok');
    }

    case '\\schemas': {
      const id = requireServer();
      const { schemas } = await api(dbPath(id, 'schemas', { database: state.sel.database }));
      return coutTable(['スキーマ', 'オブジェクト数'], schemas.map((s) => [s.name, s.objectCount]));
    }

    case '\\tables': {
      const id = requireServer();
      if (!state.sel.schema) throw new Error('スキーマが未選択です。ツリーでスキーマを開くか、\\schemas で確認してください。');
      const { tables } = await api(dbPath(id, 'tables', { database: state.sel.database, schema: state.sel.schema }));
      const list = arg ? tables.filter((t) => t.name.toLowerCase().includes(arg.toLowerCase())) : tables;
      return coutTable(['テーブル', '種別', '概算行数'], list.map((t) => [t.name, t.type, t.estimatedRows ?? '-']));
    }

    case '\\d': {
      const id = requireServer();
      if (!arg) throw new Error('テーブル名を指定してください: \\d <テーブル>');
      const d = await api(dbPath(id, `tables/${state.sel.schema}/${arg}`, { database: state.sel.database }));
      coutTable(['列', '型', 'NULL', 'キー'],
        d.columns.map((c) => [c.name, c.dataType, c.nullable ? 'YES' : 'NO', c.isPrimaryKey ? 'PK' : '']));
      return cout(`主キー: ${d.primaryKey.join(', ') || 'なし'}`, 'c-info');
    }

    case '\\export': {
      const id = requireServer();
      if (!arg) throw new Error('テーブル名を指定してください: \\export <テーブル>');
      if (!state.sel.schema) throw new Error('スキーマが未選択です。');
      await loadCsvOptions();
      const qs = csvQuery({ where: '' });
      download(`/api/db/${id}/tables/${encodeURIComponent(state.sel.schema)}/${encodeURIComponent(arg)}/export.csv?${qs}`);
      return cout(`${state.sel.schema}.${arg} を CSV で保存しています…`, 'c-ok');
    }

    case '\\backup': {
      const id = requireServer();
      if (!state.sel.schema) throw new Error('スキーマが未選択です。');
      await loadCsvOptions();
      const qs = csvQuery({ schema: state.sel.schema });
      download(`/api/db/${id}/export/schema.zip?${qs}`);
      return cout(`スキーマ ${state.sel.schema} を ZIP で保存しています…`, 'c-ok');
    }

    case '\\count': {
      const id = requireServer();
      if (!arg) throw new Error('テーブル名を指定してください: \\count <テーブル>');
      const r = await api(dbPath(id, `tables/${state.sel.schema}/${arg}/count`, { database: state.sel.database }));
      return cout(`${state.sel.schema}.${arg}: ${num(r.count)} 行`, 'c-ok');
    }

    default:
      if (cmd.startsWith('\\')) throw new Error(`不明なコマンド: ${cmd}（\\help で一覧）`);
      return runCuiSql(line);
  }
}

function looksReadOnly(sql) {
  const s = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\r\n]*/g, ' ').trim();
  return /^(select|with)\b/i.test(s);
}
function looksAllRows(sql) {
  const s = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\r\n]*/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/^(update|delete)\b/i.test(s)) return false;
  return !/\bwhere\b/i.test(s);
}

async function runCuiSql(sql) {
  const id = requireServer();

  if (looksReadOnly(sql)) {
    const r = await api(`/api/db/${id}/query`, {
      method: 'POST', body: { sql, database: state.sel.database, maxRows: 200 },
    });
    if (!r.rows.length) return cout('0 行', 'c-info');
    coutTable(r.columns, r.rows);
    return cout(`${num(r.rowCount)} 行 / ${r.elapsedMs}ms${r.truncated ? '（先頭200行を表示）' : ''}`, 'c-info');
  }

  if (!canWrite(id)) {
    throw new Error('このサーバは読み取り専用です。更新するには設定で「読み取り専用」を外してください。');
  }

  const all = looksAllRows(sql);
  cout('確認ダイアログを開きました。', 'c-info');
  openConfirm({
    title: '更新系 SQL の実行',
    danger: true,
    requireAllRows: all,
    body: `${all ? '<div class="notice danger"><strong>WHERE 句がありません。</strong><br>テーブルの<strong>全行</strong>が対象になります。</div>' : ''}
      <div class="notice danger"><strong>影響範囲を確認してください。</strong><br>
      トランザクション内で実行し、エラー時はロールバックしますが、成功すればコミットされます。</div>
      <div class="notice">サーバ: <strong>${esc(serverById(id).name)}</strong>${state.sel.database ? ` / ${esc(state.sel.database)}` : ''}</div>`,
    sql,
    run: async () => {
      const r = await api(`/api/db/${id}/execute`, {
        method: 'POST',
        body: { database: state.sel.database, sql, confirm: true, confirmAllRows: all ? true : undefined },
      });
      cout(`${r.affected} 行に影響しました`, 'c-ok');
      return r;
    },
    done: 'SQL を実行しました',
  });
}

/* ============================================================
 * 設定（サーバ管理）
 * ========================================================== */

function renderServerList() {
  const wrap = $('#serverList');
  if (!state.servers.length) {
    wrap.innerHTML = '<p class="empty">サーバが未登録です</p>';
    return;
  }
  wrap.innerHTML = state.servers.map((s) => {
    const d = state.drivers.find((x) => x.id === s.type);
    const target = s.type === 'oracle'
      ? `${s.host}:${s.port}/${s.serviceName || s.sid || ''}`
      : `${s.host}:${s.port}${s.database ? `/${s.database}` : ''}`;
    return `<div class="server-card${s.id === state.sel.serverId ? ' is-active' : ''}${s.readOnly === false ? ' is-writable' : ''}" data-id="${s.id}">
      <div class="server-card-top">
        <span class="server-name">${esc(s.name)}</span>
        <span class="pill ${esc(s.type)}">${esc(d ? d.label.split(' ')[0] : s.type)}</span>
        ${s.role ? `<span class="pill ${s.role}">${s.role === 'source' ? '移行元' : '移行先'}</span>` : ''}
        <span class="pill ${s.readOnly === false ? 'rw' : ''}">${s.readOnly === false ? '書込可' : '読取専用'}</span>
      </div>
      <div class="server-meta">${esc(s.username)}@${esc(target)}</div>
      <div class="server-card-actions">
        <button class="btn btn-sm" data-act="edit">編集</button>
        <button class="btn btn-sm" data-act="test">接続テスト</button>
        <button class="btn btn-sm btn-primary" data-act="open">開く</button>
      </div>
    </div>`;
  }).join('');
}

$('#serverList').addEventListener('click', async (ev) => {
  const card = ev.target.closest('.server-card');
  if (!card) return;
  const id = card.dataset.id;
  const act = ev.target.dataset.act;

  if (act === 'edit') return openServerModal(id);
  if (act === 'test') {
    toast('接続テスト中…');
    try {
      const r = await api(`/api/connections/${id}/test`, { method: 'POST', body: {} });
      toast(`接続成功（${r.elapsedMs}ms）`, 'ok');
    } catch (err) { toast(`接続失敗: ${err.message}`, 'err'); }
    return;
  }
  // 開く: ツリーを展開して切り替え
  state.open = {};
  setView('tree');
  await toggleServer(id);
});

const form = $('#serverForm');

function openServerModal(id) {
  const s = id ? serverById(id) : null;
  $('#serverModalTitle').textContent = s ? 'サーバの設定' : 'サーバを追加';
  $('#serverFormMessage').textContent = '';
  $('#serverFormMessage').className = 'form-message';
  form.reset();

  const fallback = (state.drivers.find((d) => d.installed) || { id: 'postgres' }).id;
  const v = s || { type: fallback, readOnly: true };

  form.elements.id.value = s ? s.id : '';
  form.elements.name.value = v.name || '';
  form.elements.type.value = v.type;
  form.elements.host.value = v.host || '';
  form.elements.port.value = s ? s.port : '';
  form.elements.database.value = v.database || '';
  form.elements.serviceName.value = v.serviceName || '';
  form.elements.sid.value = v.sid || '';
  form.elements.instanceName.value = v.instanceName || '';
  form.elements.username.value = v.username || '';
  form.elements.dbPassword.value = '';
  // 開くたびに readonly へ戻し、自動入力の隙を作らない
  form.elements.dbPassword.setAttribute('readonly', '');
  form.elements.role.value = v.role || '';
  form.elements.note.value = v.note || '';
  form.elements.encrypt.checked = v.encrypt !== false;
  form.elements.trustServerCertificate.checked = v.trustServerCertificate !== false;
  form.elements.ssl.checked = Boolean(v.ssl);
  form.elements.readOnly.checked = v.readOnly !== false;

  $('#passwordHint').hidden = !(s && s.hasPassword);
  $('#passwordInput').placeholder = s && s.hasPassword ? '変更しない場合は空欄' : '暗号化して保存されます';
  $('#btnDeleteServer').hidden = !s;

  applyTypeVisibility();
  applyReadOnlyNotice();
  $('#serverModal').hidden = false;
}

function applyTypeVisibility() {
  const type = form.elements.type.value;
  $$('#serverForm [data-for]').forEach((el) => {
    el.hidden = !el.dataset.for.split(' ').includes(type);
  });
  const d = state.drivers.find((x) => x.id === type);
  const hint = $('#driverHint');
  const missing = state.drivers.filter((x) => !x.installed);
  if (missing.length) {
    // なぜ選べないのか、どうすれば使えるのかを、その場で伝える
    hint.hidden = false;
    hint.innerHTML = missing
      .map((x) => `<strong>${esc(x.label)}</strong> は未導入です。サーバの PHP に <code>${esc(x.module)}</code> を入れてください。`)
      .join('<br>');
  } else {
    hint.hidden = true;
    hint.textContent = '';
  }

  // 選んだ種別に応じて、どこから何を写せばよいかを出す
  renderConnGuide(d);
  if (d) {
    form.elements.port.placeholder = `既定 ${d.defaultPort}`;
    // 別の DB 種別の既定ポートが残っていたら、選び直した種別のものに合わせる
    const cur = form.elements.port.value.trim();
    const isOtherDefault = state.drivers.some((x) => x.id !== type && String(x.defaultPort) === cur);
    if (cur === '' || isOtherDefault) form.elements.port.value = String(d.defaultPort);
  }
}

/**
 * 接続情報の案内。
 * 「管理画面のどの欄を、この入力欄へ写せばよいか」を種別ごとに出す。
 */
function renderConnGuide(driver) {
  const box = $('#connGuide');
  if (!box) return;
  if (!driver || !driver.guide || !driver.guide.fields
      || !Object.keys(driver.guide.fields).length) {
    box.hidden = true;
    return;
  }

  const g = driver.guide;
  box.hidden = false;
  box.innerHTML = `
    <div class="guide-head">
      <strong>${esc(g.title)}</strong>
      <span>${esc(g.where)}</span>
    </div>
    <table class="guide-table">
      <thead><tr><th>入力欄</th><th>どこの値か</th><th>例</th></tr></thead>
      <tbody>
        ${Object.values(g.fields).map((f) => `
          <tr>
            <td class="guide-field">${esc(f.label)}</td>
            <td>${esc(f.from)}</td>
            <td class="guide-example">${esc(f.example)}</td>
          </tr>
          ${f.note ? `<tr class="guide-note-row"><td></td>
            <td colspan="2" class="guide-note">${esc(f.note)}</td></tr>` : ''}
        `).join('')}
      </tbody>
    </table>`;
}

function applyReadOnlyNotice() {
  const ro = form.elements.readOnly.checked;
  const block = form.querySelector('.safety-block');
  const n = $('#readOnlyNotice');
  block.classList.toggle('is-write', !ro);
  n.innerHTML = ro
    ? '参照だけを行います。この接続からはデータを変更できません。<br><strong>移行元はこのままを推奨します。</strong>'
    : '<strong>書き込みを許可します。</strong><br>行の追加・修正・削除と更新系 SQL が可能になります。変更は主キーで特定した 1 行ずつ、実行前の確認を経て行われます。';
}

// パスワード欄は readonly の状態で置いてある（自動入力よけ）。
// 実際に触られたときだけ入力できるようにする。
['focus', 'click', 'touchstart'].forEach((ev) => {
  $('#passwordInput').addEventListener(ev, function () { this.removeAttribute('readonly'); });
});

$('#typeSelect').addEventListener('change', applyTypeVisibility);
$('#readOnlyInput').addEventListener('change', applyReadOnlyNotice);
$('#btnAddServer').addEventListener('click', () => openServerModal(null));
$('#btnAddServerFromTree').addEventListener('click', () => openServerModal(null));
const closeServerModal = () => { $('#serverModal').hidden = true; };
$('#btnCloseServer').addEventListener('click', closeServerModal);

function formPayload() {
  const d = Object.fromEntries(new FormData(form).entries());
  // 入力欄の name は dbPassword にしてある（ブラウザの自動入力よけ）。
  // サーバへは password として送る。
  d.password = d.dbPassword || '';
  delete d.dbPassword;
  const p = {
    ...d,
    port: d.port ? Number(d.port) : undefined,
    encrypt: form.elements.encrypt.checked,
    trustServerCertificate: form.elements.trustServerCertificate.checked,
    ssl: form.elements.ssl.checked,
    readOnly: form.elements.readOnly.checked,
  };
  if (!p.password) delete p.password;
  return p;
}

$('#btnTestServer').addEventListener('click', async () => {
  const m = $('#serverFormMessage');
  m.className = 'form-message';
  m.textContent = '接続テスト中…';
  try {
    // formPayload() には隠しフィールドの id も入る。
    // パスワード欄が空（＝変更しない）のとき、サーバ側は
    // その id の保存済みパスワードを使う。
    const r = await api('/api/connections/test', { method: 'POST', body: formPayload() });
    m.className = 'form-message ok';
    m.textContent = `接続成功（${r.elapsedMs}ms）${String(r.info.version).split(/[\r\n]/)[0].slice(0, 46)}`;
  } catch (err) {
    m.className = 'form-message err';
    m.textContent = `接続失敗: ${err.message}`;
  }
});

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const p = formPayload();
  const id = p.id;
  delete p.id;

  if (!p.readOnly && !confirm(`「${p.name}」で書き込みを許可します。\n\nこの接続からデータの追加・修正・削除ができるようになります。\nよろしいですか？`)) return;

  try {
    if (id) await api(`/api/connections/${id}`, { method: 'PUT', body: p });
    else await api('/api/connections', { method: 'POST', body: p });
    closeServerModal();
    await loadServers();
    if (id === state.sel.serverId) { updateBadges(); if (state.sel.table) await loadRows(); }
    toast('保存しました', 'ok');
  } catch (err) {
    $('#serverFormMessage').className = 'form-message err';
    $('#serverFormMessage').textContent = err.message;
  }
});

$('#btnDeleteServer').addEventListener('click', async () => {
  const id = form.elements.id.value;
  const s = serverById(id);
  if (!s || !confirm(`「${s.name}」の設定を削除します。\n（DB のデータは削除されません）\n\nよろしいですか？`)) return;
  await api(`/api/connections/${id}`, { method: 'DELETE' });
  if (state.sel.serverId === id) {
    state.sel = { serverId: null, database: '', schema: '', table: null };
    setStatus('未接続', false);
    setPrompt('');
  }
  closeServerModal();
  state.open = {};
  await loadServers();
  toast('削除しました', 'ok');
});

/* ---------- 操作履歴 ---------- */

$('#btnAudit').addEventListener('click', async () => {
  $('#auditModal').hidden = false;
  $('#auditList').innerHTML = '<p class="spinner">読み込み中…</p>';
  const id = state.sel.serverId || (state.servers[0] && state.servers[0].id);
  if (!id) { $('#auditList').innerHTML = '<p class="empty">サーバが未登録です</p>'; return; }
  try {
    const { entries } = await api(`/api/db/${id}/audit?limit=200`);
    $('#auditList').innerHTML = entries.length ? entries.map((e) => `
      <div class="audit-entry">
        <div class="audit-top">
          <span class="audit-at">${esc(new Date(e.at).toLocaleString('ja-JP'))}</span>
          <span class="audit-action ${esc(e.action)}">${esc(e.action)}</span>
          <span class="muted">${esc(e.target || '')}${e.affected !== undefined ? ` / ${e.affected}行` : ''}</span>
        </div>
        <div class="audit-sql">${esc(e.sql || '')}</div>
      </div>`).join('') : '<p class="empty">記録はまだありません</p>';
  } catch (err) {
    $('#auditList').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
});

/* ---------- 共通のモーダル閉じ ---------- */

['#btnCloseColumns', '#btnCloseAudit'].forEach((sel) => {
  $(sel).addEventListener('click', () => { $(sel).closest('.sheet-backdrop').hidden = true; });
});
$$('.sheet-backdrop').forEach((bd) => {
  bd.addEventListener('click', (ev) => { if (ev.target === bd) bd.hidden = true; });
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  const open = $$('.sheet-backdrop').filter((b) => !b.hidden);
  if (open.length) open[open.length - 1].hidden = true;
});

/* ============================================================
 * ログイン状態
 * ========================================================== */

async function loadAccount() {
  const me = await api('/api/auth/me');
  state.me = me;
  $('#userChip').hidden = false;
  $('#userName').textContent = me.username;
  $('#settingsUser').textContent = me.username;
  $('#settingsRole').textContent = me.roleLabel || me.role;
  $('#settingsIdle').textContent = `${me.idleTimeoutMinutes} 分の無操作でログアウト`;
  $('#defaultPwBanner').hidden = !me.isDefaultPassword;
  applyPermissions();
  return me;
}

/**
 * ログイン中の役割に合わせて、押せないボタンを隠す。
 * 画面を隠すだけでは守りにならないので、サーバ側でも同じ制限をかけている。
 */
function applyPermissions() {
  const me = state.me || {};
  const admin = Boolean(me.canManageUsers);
  const write = Boolean(me.canWrite);

  // 接続先の追加・編集は管理者だけ
  $$('#btnAddServer, #btnAddServerFromTree').forEach((b) => { b.hidden = !admin; });
  $('#usersBlock').hidden = !admin;
  $('#btnAudit').hidden = !admin;

  // データの変更は運用者以上
  $$('[data-needs="write"]').forEach((b) => { b.hidden = !write; });
  document.body.classList.toggle('is-readonly-user', !write);
}

async function doLogout() {
  if (!confirm('ログアウトします。よろしいですか？')) return;
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* 失敗しても画面は戻す */ }
  location.replace(BASE + '/login.html');
}

$('#btnLogout').addEventListener('click', doLogout);
$('#btnLogout2').addEventListener('click', doLogout);

/* ---------- パスワード変更 ---------- */

function openPwModal() {
  $('#pwForm').reset();
  $('#pwMessage').textContent = '';
  $('#pwMessage').className = 'form-message';
  $('#pwModal').hidden = false;
  setTimeout(() => $('#pwCurrent').focus(), 60);
}

$('#btnChangePw').addEventListener('click', openPwModal);
$('#btnChangePwFromBanner').addEventListener('click', openPwModal);
$('#btnClosePw').addEventListener('click', () => { $('#pwModal').hidden = true; });
$('#btnCancelPw').addEventListener('click', () => { $('#pwModal').hidden = true; });

$('#pwForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('#pwMessage');
  msg.className = 'form-message';

  const current = $('#pwCurrent').value;
  const next = $('#pwNew').value;
  if (next !== $('#pwConfirm').value) {
    msg.className = 'form-message err';
    msg.textContent = '新しいパスワードが一致しません。';
    return;
  }

  msg.textContent = '変更しています…';
  try {
    const r = await api('/api/auth/password', {
      method: 'POST', body: { currentPassword: current, newPassword: next },
    });
    msg.className = 'form-message ok';
    msg.textContent = r.message;
    setTimeout(() => location.replace(BASE + '/login.html'), 2500);
  } catch (err) {
    msg.className = 'form-message err';
    msg.textContent = err.message;
  }
});

/* ============================================================
 * CSV 入出力
 * ========================================================== */

let csvOptions = null;
let csvPreviewData = null;

async function loadCsvOptions() {
  if (csvOptions) return csvOptions;
  const id = state.sel.serverId || (state.servers[0] && state.servers[0].id);
  if (!id) return null;
  csvOptions = await api(`/api/db/${id}/csv/options`);
  $('#csvEncoding').innerHTML =
    '<option value="auto">自動判定（取り込み時）</option>' +
    csvOptions.encodings.map((e) => `<option value="${e.id}">${esc(e.label)}</option>`).join('');
  $('#csvEncoding').value = 'utf-8';
  $('#csvDelimiter').innerHTML =
    '<option value="auto">自動判定（取り込み時）</option>' +
    csvOptions.delimiters.map((d) => `<option value="${d.id}">${esc(d.label)}</option>`).join('');
  $('#csvDelimiter').value = 'comma';
  return csvOptions;
}

$('#btnCsv').addEventListener('click', async () => {
  if (!state.sel.serverId) return toast('サーバを選んでください', 'err');
  await loadCsvOptions();

  const { schema, table, database } = state.sel;
  $('#csvTarget').textContent = table
    ? `${schema}.${table.name}${database ? ` / ${database}` : ''}`
    : `${schema || '(スキーマ未選択)'}${database ? ` / ${database}` : ''}`;

  // 出力・取り込みはテーブルが選ばれていないと使えない
  const hasTable = Boolean(table);
  $('#btnExportTable').disabled = !hasTable;
  $('#btnCsvPreview').disabled = !hasTable;
  const hasFilter = Boolean(state.where) || state.filters.length > 0;
  $('#csvUseWhere').checked = hasFilter;
  const fdesc = describeFilters();
  const bits = [];
  if (fdesc.length) bits.push(`検索: ${fdesc.join(' かつ ')}`);
  if (state.where) bits.push(`SQL条件: ${state.where}`);
  $('#csvWhereText').textContent = bits.length ? bits.join(' / ') : '（絞り込みなし＝全行）';
  $('#csvImportReadonly').hidden = canWrite(state.sel.serverId);
  $('#csvPreview').innerHTML = '';
  $('#csvImportMessage').textContent = '';
  $('#btnCsvImport').disabled = true;
  csvPreviewData = null;

  $('#csvModal').hidden = false;
  loadBackupInfo();
});

$('#btnCloseCsv').addEventListener('click', () => { $('#csvModal').hidden = true; });

$$('#csvTabs .seg-btn').forEach((b) => b.addEventListener('click', () => {
  $$('#csvTabs .seg-btn').forEach((x) => x.classList.toggle('is-active', x === b));
  $$('.csv-panel').forEach((p) => p.classList.toggle('is-active', p.dataset.csvPanel === b.dataset.csv));
}));

/** 出力用のクエリ文字列を組み立てる。 */
function csvQuery(extra = {}) {
  const q = new URLSearchParams();
  if (state.sel.database) q.set('database', state.sel.database);
  const enc = $('#csvEncoding').value;
  const del = $('#csvDelimiter').value;
  if (enc && enc !== 'auto') q.set('encoding', enc);
  if (del && del !== 'auto') q.set('delimiter', del);
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, v);
  }
  return q.toString();
}

/** ブラウザにダウンロードさせる。 */
function download(path) {
  const a = document.createElement('a');
  a.href = url(path);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ---------- 出力 ---------- */

$('#btnExportTable').addEventListener('click', () => {
  const { serverId, schema, table } = state.sel;
  if (!table) return;
  const useFilter = $('#csvUseWhere').checked;
  const where = useFilter ? state.where : '';
  const filters = useFilter ? filtersParam() : '';
  const qs = csvQuery({ where, filters });
  download(`/api/db/${serverId}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table.name)}/export.csv?${qs}`);
  const fdesc = useFilter ? describeFilters() : [];
  const label = [fdesc.length ? `検索: ${fdesc.join(' かつ ')}` : '', where ? `SQL条件: ${where}` : '']
    .filter(Boolean).join(' / ');
  echoGui(`${schema}.${table.name} を CSV に書き出し${label ? `（${label}）` : ''}`,
          `SELECT * FROM ${qt(schema, table.name)}${where ? `\nWHERE ${where}` : ''};`,
          `\\export ${table.name}`);
  toast('CSV を書き出しています…', 'ok');
});

/* ---------- 一括バックアップ ---------- */

async function loadBackupInfo() {
  const { serverId, schema, database } = state.sel;
  const box = $('#csvBackupInfo');
  if (!serverId || !schema) { box.textContent = 'スキーマを選んでください。'; $('#btnBackupZip').disabled = true; return; }
  box.textContent = '対象を確認しています…';
  $('#btnBackupZip').disabled = true;
  try {
    const info = await api(dbPath(serverId, 'export/schema-info', { database, schema }));
    const rows = info.tables.filter((t) => t.type === 'TABLE')
      .reduce((sum, t) => sum + (t.estimatedRows || 0), 0);
    box.innerHTML = `対象: <strong>${info.tableCount}</strong> テーブル` +
      `（ビュー ${info.viewCount}）／ 概算 <strong>${num(rows)}</strong> 行<br>` +
      info.tables.map((t) => esc(t.name)).join(', ');
    $('#btnBackupZip').disabled = info.tableCount === 0;
  } catch (err) {
    box.textContent = err.message;
  }
}

$('#csvIncludeViews').addEventListener('change', loadBackupInfo);

$('#btnBackupZip').addEventListener('click', () => {
  const { serverId, schema } = state.sel;
  if (!schema) return;
  const qs = csvQuery({ schema, includeViews: $('#csvIncludeViews').checked ? 'true' : '' });
  download(`/api/db/${serverId}/export/schema.zip?${qs}`);
  toast('ZIP を作成しています。大きいと時間がかかります…', 'ok');
});

/* ---------- 取り込み ---------- */

function importQuery(extra = {}) {
  const { serverId, database, schema, table } = state.sel;
  const q = new URLSearchParams({ schema, table: table.name });
  if (database) q.set('database', database);
  const enc = $('#csvEncoding').value;
  const del = $('#csvDelimiter').value;
  if (enc && enc !== 'auto') q.set('encoding', enc);
  if (del && del !== 'auto') q.set('delimiter', del);
  q.set('header', $('#csvHasHeader').checked ? 'true' : 'false');
  q.set('emptyAsNull', $('#csvEmptyAsNull').checked ? 'true' : 'false');
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return { serverId, qs: q.toString() };
}

async function postCsv(path, buffer) {
  const res = await fetch(url(path), {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv' },
    credentials: 'same-origin',
    body: buffer,
  });
  if (res.status === 401) { location.replace(BASE + '/login.html'); throw new Error('ログインが必要です。'); }
  const text = await res.text();
  let payload = {};
  if (text) { try { payload = JSON.parse(text); } catch { throw new Error(`応答を解釈できません (HTTP ${res.status})`); } }
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

$('#btnCsvPreview').addEventListener('click', async () => {
  const file = $('#csvFile').files[0];
  const msg = $('#csvImportMessage');
  msg.className = 'form-message';
  if (!file) { msg.className = 'form-message err'; msg.textContent = 'CSV ファイルを選んでください。'; return; }
  if (!state.sel.table) { msg.className = 'form-message err'; msg.textContent = 'テーブルを選んでください。'; return; }

  msg.textContent = '確認しています…';
  $('#btnCsvImport').disabled = true;
  try {
    const buffer = await file.arrayBuffer();
    const { serverId, qs } = importQuery();
    const p = await postCsv(`/api/db/${serverId}/import/preview?${qs}`, buffer);
    csvPreviewData = { buffer, preview: p };
    renderCsvPreview(p);
    msg.textContent = '';
    $('#btnCsvImport').disabled = !p.canImport || !canWrite(state.sel.serverId);
  } catch (err) {
    $('#csvPreview').innerHTML = '';
    msg.className = 'form-message err';
    msg.textContent = err.message;
  }
});

function renderCsvPreview(p) {
  const map = p.mapping.map((m) => m.tableColumn
    ? `<div class="hit">${esc(m.csvColumn)} <span class="arrow">→</span> ${esc(m.tableColumn)}</div>`
    : `<div class="miss">${esc(m.csvColumn)} <span class="arrow">→</span> （無視）</div>`).join('');

  const head = p.mapping.map((m) => `<th>${esc(m.csvColumn)}</th>`).join('');
  const body = p.sample.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('');

  $('#csvPreview').innerHTML = `
    <dl class="csv-summary">
      <dt>取り込み先</dt><dd>${esc(p.schema)}.${esc(p.table)}</dd>
      <dt>文字コード</dt><dd>${esc(p.encodingLabel)}</dd>
      <dt>区切り文字</dt><dd>${p.delimiter === 'tab' ? 'タブ' : esc(p.delimiter)}</dd>
      <dt>行数</dt><dd>${num(p.totalRows)} 行</dd>
    </dl>
    ${p.warnings.map((w) => `<div class="csv-warn">${esc(w)}</div>`).join('')}
    <p class="section-label">列の対応</p>
    <div class="csv-map">${map}</div>
    <p class="section-label">先頭 ${Math.min(10, p.sample.length)} 行</p>
    <div class="grid-wrap" style="max-height:34vh;border:1px solid var(--border);border-radius:6px">
      <table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    </div>`;
}

$('#csvFile').addEventListener('change', () => {
  $('#csvPreview').innerHTML = '';
  $('#csvImportMessage').textContent = '';
  $('#btnCsvImport').disabled = true;
  csvPreviewData = null;
});

$('#btnCsvImport').addEventListener('click', () => {
  if (!csvPreviewData) return;
  const p = csvPreviewData.preview;
  const { serverId, qs } = importQuery({ confirm: 'true' });

  openConfirm({
    title: 'CSV の取り込み',
    danger: true,
    body: `<div class="notice danger"><strong>${num(p.totalRows)} 行</strong>を
        <strong>${esc(p.schema)}.${esc(p.table)}</strong> に追加します。<br>
        1 行でも失敗した場合は、すべて取り消します（途中まで入ることはありません）。</div>
      <div class="notice">対象の列: ${esc(p.matchedColumns.join(', '))}</div>
      ${p.warnings.length ? p.warnings.map((w) => `<div class="csv-warn">${esc(w)}</div>`).join('') : ''}`,
    sql: `INSERT INTO ${p.schema}.${p.table}\n  (${p.matchedColumns.join(', ')})\nVALUES\n  (${p.matchedColumns.map(() => '?').join(', ')});\n\n-- 上記を ${p.totalRows} 行分、1 つのトランザクションで実行します\n-- 値はすべてバインド変数として渡されます`,
    run: async () => {
      const r = await postCsv(`/api/db/${serverId}/import/execute?${qs}`, csvPreviewData.buffer);
      return r;
    },
    done: 'CSV を取り込みました',
    cuiHint: `INSERT INTO ${p.schema}.${p.table} (${p.matchedColumns.join(', ')}) VALUES (...);`
           + ` × ${p.totalRows} 行`,
  });
});

/* ============================================================
 * PWA
 * ========================================================== */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  deferredPrompt = ev;
  $('#btnInstall').hidden = false;
});
$('#btnInstall').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $('#btnInstall').hidden = true;
});

/* ============================================================
 * 利用者の管理（管理者のみ）
 * ========================================================== */

const ROLE_ORDER = ['admin', 'operator', 'viewer'];

async function loadUsers() {
  if (!state.me || !state.me.canManageUsers) return;
  try {
    const { users } = await api('/api/auth/users');
    renderUsers(users);
  } catch (err) {
    $('#userList').innerHTML = `<p class="hint">利用者を読み込めませんでした: ${esc(err.message)}</p>`;
  }
}

function renderUsers(list) {
  const meName = (state.me && state.me.username) || '';
  $('#userList').innerHTML = list.map((u) => {
    const isMe = u.username.toLowerCase() === meName.toLowerCase();
    const flags = [];
    if (u.disabled) flags.push('<span class="badge badge-off">利用停止</span>');
    if (u.isDefaultPassword) flags.push('<span class="badge badge-warn">初期パスワード</span>');
    if (isMe) flags.push('<span class="badge">自分</span>');
    const last = u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('ja-JP') : '未ログイン';
    return `<div class="user-card${u.disabled ? ' is-off' : ''}" data-user="${esc(u.username)}">
      <div class="user-main">
        <div class="user-name">${esc(u.username)} ${flags.join(' ')}</div>
        <div class="user-sub">${esc(u.roleLabel)} ・ 最終ログイン: ${esc(last)}</div>
      </div>
      <div class="user-ops">
        <select data-act="role"${isMe ? ' disabled' : ''}>
          ${ROLE_ORDER.map((r) => `<option value="${r}"${u.role === r ? ' selected' : ''}>${roleLabel(r)}</option>`).join('')}
        </select>
        <button class="btn btn-sm" data-act="reset">パスワード再設定</button>
        <button class="btn btn-sm" data-act="toggle"${isMe ? ' disabled' : ''}>${u.disabled ? '利用再開' : '利用停止'}</button>
        <button class="btn btn-sm btn-danger" data-act="remove"${isMe ? ' disabled' : ''}>削除</button>
      </div>
    </div>`;
  }).join('') || '<p class="hint">利用者がいません。</p>';
}

function roleLabel(id) {
  const d = { admin: '管理者', operator: '運用者', viewer: '閲覧者' };
  return d[id] || id;
}

$('#btnAddUser')?.addEventListener('click', async () => {
  const username = prompt('追加する利用者のユーザー名（英数字と . _ -、3〜32文字）');
  if (!username) return;
  const role = prompt('役割を入力してください: admin / operator / viewer', 'viewer');
  if (!role) return;
  const password = prompt('初期パスワード（10文字以上・英大小文字と数字を含む）');
  if (!password) return;
  try {
    await api('/api/auth/users', { method: 'POST', body: { username, role, password } });
    toast(`${username} を追加しました。`, 'ok');
    await loadUsers();
  } catch (err) { toast(err.message, 'err'); }
});

$('#userList')?.addEventListener('change', async (ev) => {
  const sel = ev.target.closest('select[data-act="role"]');
  if (!sel) return;
  const username = sel.closest('.user-card').dataset.user;
  try {
    await api(`/api/auth/users/${encodeURIComponent(username)}`, {
      method: 'PUT', body: { role: sel.value },
    });
    toast(`${username} の役割を「${roleLabel(sel.value)}」にしました。`, 'ok');
  } catch (err) { toast(err.message, 'err'); }
  await loadUsers();
});

$('#userList')?.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const card = btn.closest('.user-card');
  const username = card.dataset.user;
  const act = btn.dataset.act;

  try {
    if (act === 'reset') {
      const newPassword = prompt(`${username} の新しいパスワード（10文字以上・英大小文字と数字を含む）`);
      if (!newPassword) return;
      const r = await api(`/api/auth/users/${encodeURIComponent(username)}/password`, {
        method: 'POST', body: { newPassword },
      });
      toast(r.message, 'ok');
    } else if (act === 'toggle') {
      const off = card.classList.contains('is-off');
      await api(`/api/auth/users/${encodeURIComponent(username)}`, {
        method: 'PUT', body: { disabled: !off },
      });
      toast(off ? `${username} の利用を再開しました。` : `${username} を利用停止にしました。`, 'ok');
    } else if (act === 'remove') {
      openConfirm({
        title: '利用者を削除',
        danger: true,
        body: `<div class="notice danger"><strong>この操作は取り消せません。</strong><br>
          <strong>${esc(username)}</strong> を削除します。この利用者はログインできなくなります。</div>
          <p class="hint">開いているセッションもその場で無効になります。
          接続先の登録や、これまでの操作履歴は残ります。</p>`,
        sql: `-- 利用者 ${username} を data/auth.json から削除します\n-- DB のデータには一切触れません`,
        run: () => api(`/api/auth/users/${encodeURIComponent(username)}`, { method: 'DELETE' }),
        done: `${username} を削除しました`,
        after: loadUsers,
      });
      return;
    }
  } catch (err) { toast(err.message, 'err'); }
  await loadUsers();
});

/* ============================================================
 * 配色・文言（下側の作業エリア）
 *
 * 既定値は theme.css に書いてある。
 * ここで当てるのは「画面から変えた分」だけで、CSS より優先される。
 * ========================================================== */

const THEME_TARGETS = ['#app', '#tabbar'];

/** 変更分を実際の画面へ当てる。 */
function applyTheme(applied) {
  const vars = { ...(applied.tokens || {}), ...(applied.sizes || {}) };
  for (const sel of THEME_TARGETS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    // 前回当てた分を消してから入れ直す（消した項目を CSS の既定へ戻すため）
    for (const name of Array.from(el.style)) {
      if (name.startsWith('--')) el.style.removeProperty(name);
    }
    for (const [k, v] of Object.entries(vars)) el.style.setProperty(`--${k}`, v);
  }
  applyLabels(applied.labels || {});
}

/**
 * 文言を差し替える対象。
 *
 * セレクタは必ずタブの「ボタン」に限ること。
 * [data-view="data"] だけだと <section class="pane" data-view="data"> にも当たり、
 * ペインの中身をまるごと消してしまう。
 */
const LABEL_TARGETS = {
  appTitle:    { sel: '.topbar h1',                            def: 'DB Controller' },
  tabTree:     { sel: '.tab[data-view="tree"], .dtab[data-view="tree"]',         def: 'ツリー' },
  tabData:     { sel: '.tab[data-view="data"], .dtab[data-view="data"]',         def: 'データ' },
  tabCui:      { sel: '.tab[data-view="cui"], .dtab[data-view="cui"]',           def: 'CUI' },
  tabSettings: { sel: '.tab[data-view="settings"], .dtab[data-view="settings"]', def: '設定' },
};

function applyLabels(labels) {
  state.labels = labels || {};
  for (const [id, t] of Object.entries(LABEL_TARGETS)) {
    // 指定が無ければ既定の文言に戻す（「既定に戻す」を押したときのため）
    const text = state.labels[id] || t.def;
    for (const el of $$(t.sel)) {
      const icon = el.querySelector('.tab-icon');
      el.textContent = text;
      if (icon) el.prepend(icon);
    }
  }
  // 読取専用 / 書込可 のバッジにも反映する
  updateBadges();
}

/** 読取専用 / 書込可 の表示文言。 */
function badgeLabel(key, fallback) {
  return (state.labels && state.labels[key]) || fallback;
}

async function loadTheme() {
  try {
    const t = await api('/api/theme');
    state.theme = t;
    applyTheme(t.applied || {});
    if (state.me && state.me.canManageUsers) renderThemeEditor();
  } catch { /* 配色が読めなくても本体は使えるようにする */ }
}

function renderThemeEditor() {
  const t = state.theme;
  if (!t) return;
  $('#themeBlock').hidden = false;

  const groups = {};
  for (const tk of t.tokens) (groups[tk.group] = groups[tk.group] || []).push(tk);

  const colorRows = Object.entries(groups).map(([g, items]) => `
    <div class="theme-group">
      <div class="theme-group-name">${esc(g)}</div>
      ${items.map((tk) => `
        <label class="theme-row">
          <span class="theme-label">${esc(tk.label)}</span>
          <input type="color" data-theme-token="${esc(tk.id)}"
                 value="${esc(tk.value || currentVar(tk.id))}">
          <input type="text" class="theme-text" data-theme-token-text="${esc(tk.id)}"
                 value="${esc(tk.value || '')}" placeholder="${esc(currentVar(tk.id))}">
        </label>`).join('')}
    </div>`).join('');

  const sizeRows = t.sizes.map((sz) => `
    <label class="theme-row">
      <span class="theme-label">${esc(sz.label)}</span>
      <input type="number" data-theme-size="${esc(sz.id)}" step="0.1"
             min="${sz.min}" max="${sz.max}"
             value="${esc(String(sz.value || '').replace(/[a-z]+$/, ''))}"
             placeholder="${esc(currentVar(sz.id))}">
      <span class="theme-unit">${esc(sz.unit || '')}</span>
    </label>`).join('');

  const labelRows = t.labels.map((lb) => `
    <label class="theme-row">
      <span class="theme-label">${esc(lb.label)}</span>
      <input type="text" data-theme-label="${esc(lb.id)}"
             value="${esc(lb.value || '')}" placeholder="${esc(lb.default)}" maxlength="40">
    </label>`).join('');

  $('#themeEditor').innerHTML = `
    ${colorRows}
    ${t.sizes.length ? `<div class="theme-group"><div class="theme-group-name">大きさ</div>${sizeRows}</div>` : ''}
    ${t.labels.length ? `<div class="theme-group"><div class="theme-group-name">文言</div>${labelRows}</div>` : ''}`;
}

/** いま実際に効いている値を読む（既定値の表示用）。 */
function currentVar(name) {
  const el = document.querySelector('#app');
  if (!el) return '';
  const v = getComputedStyle(el).getPropertyValue(`--${name}`).trim();
  return v || '';
}

/** 編集中の内容を集める。 */
function collectTheme() {
  const tokens = {};
  for (const el of $$('#themeEditor [data-theme-token-text]')) {
    const v = el.value.trim();
    if (v) tokens[el.dataset.themeTokenText] = v;
  }
  const sizes = {};
  for (const el of $$('#themeEditor [data-theme-size]')) {
    const v = el.value.trim();
    if (v) sizes[el.dataset.themeSize] = v;
  }
  const labels = {};
  for (const el of $$('#themeEditor [data-theme-label]')) {
    const v = el.value.trim();
    if (v) labels[el.dataset.themeLabel] = v;
  }
  return { tokens, sizes, labels };
}

/** 入力中はその場で反映して、見ながら決められるようにする。 */
function previewTheme() {
  const draft = collectTheme();
  const sizes = {};
  for (const sz of (state.theme ? state.theme.sizes : [])) {
    if (draft.sizes[sz.id]) sizes[sz.id] = draft.sizes[sz.id] + (sz.unit || '');
  }
  applyTheme({ tokens: draft.tokens, sizes, labels: draft.labels });
}

$('#themeEditor')?.addEventListener('input', (ev) => {
  // 色見本と文字入力を連動させる
  const picker = ev.target.closest('[data-theme-token]');
  if (picker) {
    const text = $(`#themeEditor [data-theme-token-text="${CSS.escape(picker.dataset.themeToken)}"]`);
    if (text) text.value = picker.value;
  }
  const text = ev.target.closest('[data-theme-token-text]');
  if (text && /^#[0-9a-fA-F]{6}$/.test(text.value.trim())) {
    const p = $(`#themeEditor [data-theme-token="${CSS.escape(text.dataset.themeTokenText)}"]`);
    if (p) p.value = text.value.trim();
  }
  previewTheme();
});

$('#btnThemeSave')?.addEventListener('click', async () => {
  try {
    const r = await api('/api/theme', { method: 'PUT', body: collectTheme() });
    state.theme.applied = r.applied;
    applyTheme(r.applied);
    toast('配色を保存しました。全員に適用されます。', 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

$('#btnThemeRevert')?.addEventListener('click', async () => {
  await loadTheme();
  renderThemeEditor();
  toast('編集を取り消しました。');
});

$('#btnThemeReset')?.addEventListener('click', () => {
  openConfirm({
    title: '配色を既定に戻す',
    body: `<div class="notice">画面から変更した配色・文言をすべて消し、
      <code>theme.css</code> の内容に戻します。</div>`,
    sql: '-- data/theme.json を削除します\n-- DB のデータには一切触れません',
    run: () => api('/api/theme', { method: 'DELETE' }),
    done: '配色を既定に戻しました',
    after: async () => { await loadTheme(); renderThemeEditor(); },
  });
});

/* ============================================================
 * 起動
 * ========================================================== */

(async function init() {
  try {
    await loadAccount();
    const { drivers } = await api('/api/connections/drivers');
    state.drivers = drivers;
    $('#typeSelect').innerHTML = drivers
      .map((d) => `<option value="${d.id}"${d.installed ? '' : ' disabled'}>${d.label}${d.installed ? '' : '（未導入）'}</option>`)
      .join('');
    await loadServers();
    await loadUsers();
    await loadTheme();
    setView('tree');
    cout('DB Controller — \\help でコマンド一覧', 'c-info');
    if (!state.servers.length) cout('サーバが未登録です。設定タブから追加してください。', 'c-info');
  } catch (err) {
    toast(`初期化に失敗しました: ${err.message}`, 'err');
  }
})();

