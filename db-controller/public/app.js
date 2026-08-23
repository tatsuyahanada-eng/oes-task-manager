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
  editing: null,
  pending: null,
  history: [],
  historyIndex: -1,
};

/* ------------------------------------------------------------
 * API
 * ---------------------------------------------------------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let payload = {};
  if (text) {
    try { payload = JSON.parse(text); }
    catch { throw new Error(`応答を解釈できません (HTTP ${res.status})`); }
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
const canWrite = (id) => {
  const s = serverById(id);
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
  badge.hidden = false;
  badge.textContent = w ? '書込可' : '読取専用';
  badge.className = `mode-badge ${w ? 'is-writable' : ''}`;

  const editable = w && state.detail && state.detail.primaryKey.length
    && state.sel.table && state.sel.table.type === 'TABLE';
  $('#btnAddRow').hidden = !editable;
}

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
  setChildren(key, '<p class="tree-loading">接続中…</p>');

  const s = serverById(id);
  setStatus(`${s.name} へ接続中…`, false);
  try {
    const [{ databases, supportsDatabaseSwitch }, info] = await Promise.all([
      api(dbPath(id, 'databases')),
      api(dbPath(id, 'info')),
    ]);
    setStatus(`${s.name}`, true);
    setPrompt(`${s.name}`);

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
  $('#whereInput').value = '';
  $('#dataTitle').textContent = `${schema}.${table}`;

  highlightSelectedTable();
  setView('data');
  await loadDefinition();
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
  } catch {
    state.detail = null;
  }
  updateBadges();
}

async function loadRows() {
  const { serverId, database, schema, table } = state.sel;
  if (!table) return;
  $('#gridWrap').innerHTML = '<p class="spinner">読み込み中…</p>';
  try {
    const r = await api(dbPath(serverId, `tables/${schema}/${table.name}/rows`, {
      database, limit: state.limit, offset: state.offset,
      orderBy: state.orderBy, orderDir: state.orderDir, where: state.where,
    }));
    state.rows = r.rows;
    state.rowColumns = r.columns;
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
           <button class="btn btn-sm btn-danger" data-row="${i}" data-op="del">削除</button>
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
  });
}

/* ---------- 実行確認 ---------- */

function openConfirm({ title, danger, body, sql, run, done, requireAllRows = false }) {
  state.pending = { run, done };
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
  try {
    const r = await state.pending.run();
    const msg = state.pending.done + (r && r.affected !== undefined ? `（${r.affected} 行）` : '');
    $('#confirmModal').hidden = true;
    $('#rowModal').hidden = true;
    state.pending = null;
    state.editing = null;
    toast(msg, 'ok');
    await loadRows();
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
  \\clear               画面を消す

  上記以外はそのまま SQL として実行します。
  SELECT / WITH は参照。INSERT / UPDATE / DELETE は
  「書込可」のサーバでのみ、確認のうえ実行します。
  ↑ ↓ で履歴をたどれます。`;

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
  form.elements.password.value = '';
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
  if (d) form.elements.port.placeholder = `既定 ${d.defaultPort}`;
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

$('#typeSelect').addEventListener('change', applyTypeVisibility);
$('#readOnlyInput').addEventListener('change', applyReadOnlyNotice);
$('#btnAddServer').addEventListener('click', () => openServerModal(null));
$('#btnAddServerFromTree').addEventListener('click', () => openServerModal(null));
const closeServerModal = () => { $('#serverModal').hidden = true; };
$('#btnCloseServer').addEventListener('click', closeServerModal);

function formPayload() {
  const d = Object.fromEntries(new FormData(form).entries());
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
 * 起動
 * ========================================================== */

(async function init() {
  try {
    const { drivers } = await api('/api/connections/drivers');
    state.drivers = drivers;
    $('#typeSelect').innerHTML = drivers
      .map((d) => `<option value="${d.id}"${d.installed ? '' : ' disabled'}>${d.label}${d.installed ? '' : '（未導入）'}</option>`)
      .join('');
    await loadServers();
    setView('tree');
    cout('DB Controller — \\help でコマンド一覧', 'c-info');
    if (!state.servers.length) cout('サーバが未登録です。設定タブから追加してください。', 'c-info');
  } catch (err) {
    toast(`初期化に失敗しました: ${err.message}`, 'err');
  }
})();

$('#btnFirstServer')?.addEventListener('click', () => openServerModal(null));
