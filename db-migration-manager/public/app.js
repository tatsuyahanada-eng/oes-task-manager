'use strict';

/* ============================================================
 * DB Migration Manager - フロントエンド
 *
 * 安全性の考え方:
 *   - 接続は既定で読み取り専用。書き込み可の接続だけが編集 UI を出す
 *   - 編集は主キーのあるテーブルのみ。1 行ずつしか変更できない
 *   - 実行前に必ず SQL と変更内容を見せて確認を取る
 * ========================================================== */

const state = {
  drivers: [],
  connections: [],
  activeConnectionId: null,
  database: '',
  schema: '',
  tables: [],
  table: null,
  detail: null,        // describeTable の結果 (列定義・主キー)
  rows: [],            // 現在表示中の行 (配列の配列)
  rowColumns: [],      // 現在表示中の列名
  offset: 0,
  limit: 100,
  orderBy: '',
  orderDir: 'ASC',
  where: '',
  exactCount: null,
  editing: null,       // { mode: 'insert'|'update', original, key }
  pendingAction: null, // 確認待ちの操作
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/* ------------------------------------------------------------
 * API ヘルパ
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
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`応答を解釈できません (HTTP ${res.status})`);
    }
  }
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

/** 参照系 API のパス。データベース切り替えはクエリで渡す。 */
function dbPath(suffix, params = {}) {
  const search = new URLSearchParams();
  if (state.database) search.set('database', state.database);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') search.set(k, v);
  }
  const qs = search.toString();
  const encoded = suffix.split('/').map(encodeURIComponent).join('/');
  return `/api/db/${state.activeConnectionId}/${encoded}${qs ? `?${qs}` : ''}`;
}

function activeConnection() {
  return state.connections.find((c) => c.id === state.activeConnectionId) || null;
}

/** 現在の接続でデータを変更できるか。 */
function canWrite() {
  const conn = activeConnection();
  // 明示的に false のときだけ書き込み可。未設定は読み取り専用として扱う。
  return Boolean(conn && conn.readOnly === false);
}

/* ------------------------------------------------------------
 * トースト
 * ---------------------------------------------------------- */

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toastStack').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 8000 : 3500);
}

/* ------------------------------------------------------------
 * 接続一覧 (設定)
 * ---------------------------------------------------------- */

async function loadDrivers() {
  const { drivers } = await api('/api/connections/drivers');
  state.drivers = drivers;
  $('#typeSelect').innerHTML = drivers
    .map((d) => `<option value="${d.id}"${d.installed ? '' : ' disabled'}>${d.label}${d.installed ? '' : ' (未導入)'}</option>`)
    .join('');
}

async function loadConnections() {
  const { connections, sessions } = await api('/api/connections');
  state.connections = connections;
  renderConnections(sessions || []);
  updateModeIndicators();
}

function renderConnections(sessions) {
  const wrap = $('#connList');
  if (!state.connections.length) {
    wrap.innerHTML = '<p class="empty">接続先が未登録です<br>「+ 追加」から登録してください</p>';
    return;
  }
  const liveIds = new Set(sessions.map((s) => s.connectionId));
  wrap.innerHTML = state.connections
    .map((c) => {
      const driver = state.drivers.find((d) => d.id === c.type);
      const target = c.type === 'oracle'
        ? `${c.host}:${c.port}/${c.serviceName || c.sid || ''}`
        : `${c.host}:${c.port}${c.database ? `/${c.database}` : ''}`;
      const classes = [
        'conn-card',
        c.id === state.activeConnectionId ? 'is-active' : '',
        c.readOnly === false ? 'is-writable' : '',
      ].filter(Boolean).join(' ');
      return `
        <div class="${classes}" data-id="${c.id}">
          <div class="conn-card-top">
            <span class="conn-name">${esc(c.name)}</span>
            ${liveIds.has(c.id) ? '<span class="pill live">接続中</span>' : ''}
          </div>
          <div class="conn-card-top" style="margin-top:4px">
            <span class="pill ${c.type}">${esc(driver ? driver.label : c.type)}</span>
            ${c.role ? `<span class="pill ${c.role}">${c.role === 'source' ? '移行元' : '移行先'}</span>` : ''}
            <span class="pill ${c.readOnly === false ? 'rw' : 'ro'}">${c.readOnly === false ? '書込可' : '読取専用'}</span>
          </div>
          <div class="conn-meta">${esc(c.username)}@${esc(target)}</div>
          <div class="conn-actions">
            <button class="btn btn-sm" data-action="edit">設定</button>
            <button class="btn btn-sm" data-action="test">テスト</button>
            <button class="btn btn-sm btn-danger" data-action="delete">削除</button>
          </div>
        </div>`;
    })
    .join('');
}

$('#connList').addEventListener('click', async (ev) => {
  const card = ev.target.closest('.conn-card');
  if (!card) return;
  const id = card.dataset.id;
  const action = ev.target.dataset.action;

  if (action === 'edit') return openConnectionModal(id);
  if (action === 'delete') return deleteConnection(id);
  if (action === 'test') return testSavedConnection(id);
  await selectConnection(id);
});

async function deleteConnection(id) {
  const conn = state.connections.find((c) => c.id === id);
  if (!conn) return;
  if (!confirm(`接続「${conn.name}」の設定を削除します。\n(DB のデータは削除されません)\n\nよろしいですか？`)) return;
  await api(`/api/connections/${id}`, { method: 'DELETE' });
  if (state.activeConnectionId === id) resetBrowser();
  await loadConnections();
  toast('接続設定を削除しました', 'ok');
}

async function testSavedConnection(id) {
  toast('接続テスト中...');
  try {
    const result = await api(`/api/connections/${id}/test`, { method: 'POST', body: {} });
    toast(`接続成功 (${result.elapsedMs}ms) ${shortVersion(result.info.version)}`, 'ok');
  } catch (err) {
    toast(`接続失敗: ${err.message}`, 'err');
  }
}

function shortVersion(version) {
  return String(version || '').split(/[\r\n]/)[0].slice(0, 70);
}

/** 画面上部と各所の「書き込み可 / 読み取り専用」表示を揃える。 */
function updateModeIndicators() {
  const conn = activeConnection();
  const badge = $('#modeBadge');
  if (!conn) {
    badge.hidden = true;
  } else {
    badge.hidden = false;
    const writable = conn.readOnly === false;
    badge.textContent = writable ? 'WRITE ENABLED' : 'READ ONLY';
    badge.className = `mode-badge ${writable ? 'is-writable' : 'is-readonly'}`;
  }

  const writable = canWrite();
  $('#sqlModeBadge').textContent = writable ? '更新可' : '参照のみ';
  $('#sqlModeBadge').className = `badge${writable ? ' write' : ''}`;
  $('#sqlInput').placeholder = writable
    ? 'SELECT / INSERT / UPDATE / DELETE ...'
    : 'SELECT * FROM ...';

  // 主キーのあるテーブルでのみ行追加を許可する
  const editable = writable && state.detail && state.detail.primaryKey.length && state.table
    && state.table.type === 'TABLE';
  $('#btnInsertRow').hidden = !editable;
}

/* ------------------------------------------------------------
 * 接続の選択 → データベース / スキーマ / テーブル
 * ---------------------------------------------------------- */

function resetBrowser() {
  state.activeConnectionId = null;
  state.database = '';
  state.schema = '';
  state.tables = [];
  state.table = null;
  state.detail = null;
  $('#databaseSelect').innerHTML = '';
  $('#databaseSelect').disabled = true;
  $('#schemaSelect').innerHTML = '';
  $('#schemaSelect').disabled = true;
  $('#tableFilter').disabled = true;
  $('#tableList').innerHTML = '<p class="empty">接続先を選択してください</p>';
  $('#detail').hidden = true;
  $('#contentPlaceholder').hidden = false;
  setStatus('not connected', false);
  updateModeIndicators();
}

function setStatus(text, connected) {
  const el = $('#sessionStatus');
  el.textContent = text;
  el.classList.toggle('is-connected', Boolean(connected));
}

async function selectConnection(id) {
  state.activeConnectionId = id;
  state.database = '';
  state.schema = '';
  state.table = null;
  state.detail = null;
  $('#detail').hidden = true;
  $('#contentPlaceholder').hidden = false;
  $('#tableList').innerHTML = '<p class="spinner">connecting</p>';

  const conn = state.connections.find((c) => c.id === id);
  setStatus(`${conn.name} connecting...`, false);
  updateModeIndicators();

  try {
    const { databases, supportsDatabaseSwitch } = await api(dbPath('databases'));
    const info = await api(dbPath('info'));
    setStatus(`${conn.name} ${shortVersion(info.info.version)}`, true);

    const dbSelect = $('#databaseSelect');
    if (supportsDatabaseSwitch && databases.length) {
      const current = info.database || databases[0].name;
      dbSelect.innerHTML = databases
        .map((d) => `<option value="${esc(d.name)}"${d.name === current ? ' selected' : ''}>${esc(d.name)}</option>`)
        .join('');
      dbSelect.disabled = false;
      state.database = current;
    } else {
      dbSelect.innerHTML = `<option>${supportsDatabaseSwitch ? '(取得不可)' : '(切り替え非対応)'}</option>`;
      dbSelect.disabled = true;
    }

    await loadSchemas();
    await loadConnections();
  } catch (err) {
    setStatus(`${conn.name} 接続失敗`, false);
    $('#tableList').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    toast(`接続失敗: ${err.message}`, 'err');
  }
}

$('#databaseSelect').addEventListener('change', async (ev) => {
  state.database = ev.target.value;
  state.schema = '';
  state.table = null;
  state.detail = null;
  $('#detail').hidden = true;
  $('#contentPlaceholder').hidden = false;
  updateModeIndicators();
  await loadSchemas();
});

async function loadSchemas() {
  $('#tableList').innerHTML = '<p class="spinner">loading schemas</p>';
  const { schemas } = await api(dbPath('schemas'));
  const select = $('#schemaSelect');
  if (!schemas.length) {
    select.innerHTML = '<option>(なし)</option>';
    select.disabled = true;
    $('#tableList').innerHTML = '<p class="empty">参照可能なスキーマがありません</p>';
    return;
  }
  select.innerHTML = schemas
    .map((s) => `<option value="${esc(s.name)}">${esc(s.name)}${s.objectCount ? ` (${s.objectCount})` : ''}</option>`)
    .join('');
  select.disabled = false;
  state.schema = pickDefaultSchema(schemas);
  select.value = state.schema;
  await loadTables();
}

/**
 * 既定で開くスキーマを選ぶ。
 * 接続ユーザーと同名 (Oracle でよくある構成) > オブジェクト数が最多 > 先頭 の順。
 */
function pickDefaultSchema(schemas) {
  const conn = activeConnection();
  if (conn) {
    const user = String(conn.username || '').toLowerCase();
    const own = schemas.find((s) => s.name.toLowerCase() === user);
    if (own && own.objectCount) return own.name;
  }
  const populated = schemas.filter((s) => s.objectCount > 0);
  if (!populated.length) return schemas[0].name;
  return populated.reduce((best, s) => (s.objectCount > best.objectCount ? s : best)).name;
}

$('#schemaSelect').addEventListener('change', async (ev) => {
  state.schema = ev.target.value;
  await loadTables();
});

async function loadTables() {
  $('#tableList').innerHTML = '<p class="spinner">loading tables</p>';
  try {
    const { tables } = await api(dbPath('tables', { schema: state.schema }));
    state.tables = tables;
    $('#tableFilter').disabled = false;
    renderTables();
  } catch (err) {
    $('#tableList').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

function renderTables() {
  const filter = $('#tableFilter').value.trim().toLowerCase();
  const list = filter
    ? state.tables.filter((t) => t.name.toLowerCase().includes(filter))
    : state.tables;

  if (!list.length) {
    $('#tableList').innerHTML = '<p class="empty">該当するテーブルがありません</p>';
    return;
  }

  $('#tableList').innerHTML = list
    .map((t) => {
      const active = state.table && state.table.name === t.name ? ' is-active' : '';
      const rows = t.estimatedRows === null || t.estimatedRows === undefined
        ? ''
        : `<span class="trows">~${formatNumber(t.estimatedRows)}</span>`;
      const view = t.type !== 'TABLE' ? '<span class="tview">VIEW</span>' : '';
      return `<div class="table-item${active}" data-name="${esc(t.name)}" title="${esc(t.comment || t.name)}">
        <span class="tname">${esc(t.name)}</span>${view}${rows}
      </div>`;
    })
    .join('');
}

$('#tableFilter').addEventListener('input', renderTables);

$('#tableList').addEventListener('click', (ev) => {
  const item = ev.target.closest('.table-item');
  if (!item) return;
  openTable(item.dataset.name);
});

/* ------------------------------------------------------------
 * テーブル詳細
 * ---------------------------------------------------------- */

async function openTable(name) {
  const table = state.tables.find((t) => t.name === name);
  if (!table) return;

  state.table = table;
  state.detail = null;
  state.offset = 0;
  state.orderBy = '';
  state.orderDir = 'ASC';
  state.where = '';
  state.exactCount = null;
  $('#whereInput').value = '';

  renderTables();
  $('#contentPlaceholder').hidden = true;
  $('#detail').hidden = false;
  $('#detailTitle').textContent = `${state.schema}.${table.name}`;
  $('#detailSub').textContent = [
    table.type,
    state.database ? `db=${state.database}` : null,
    table.estimatedRows === null || table.estimatedRows === undefined
      ? null
      : `概算 ${formatNumber(table.estimatedRows)} 行`,
    table.comment || null,
  ].filter(Boolean).join('  ·  ');

  // 列定義は編集可否の判定にも使うので先に読む
  await loadTableDefinition();
  await loadRows();
}

async function loadTableDefinition() {
  $('#columnsWrap').innerHTML = '<p class="spinner">loading</p>';
  try {
    const detail = await api(dbPath(`tables/${state.schema}/${state.table.name}`));
    state.detail = detail;
    renderColumns(detail);
    renderKeys(detail);
  } catch (err) {
    state.detail = null;
    $('#columnsWrap').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
  updateModeIndicators();
}

function renderColumns(detail) {
  const head = ['#', '列名', '型', 'NULL', '既定値', 'キー', 'コメント'];
  const rows = detail.columns.map((c) => [
    c.position,
    c.name,
    c.dataType,
    c.nullable ? 'YES' : 'NO',
    c.defaultValue || '',
    [c.isPrimaryKey ? 'PK' : '', c.isIdentity ? 'IDENTITY' : ''].filter(Boolean).join(' '),
    c.comment || '',
  ]);
  $('#columnsWrap').innerHTML = buildGrid(head, rows, {});
}

function renderKeys(detail) {
  const block = (title, items, emptyText) =>
    `<div class="keyblock"><h3>${title}</h3>${
      items.length
        ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
        : `<p class="none">${emptyText}</p>`
    }</div>`;

  const pkNote = detail.primaryKey.length
    ? ''
    : '<div class="notice danger">主キーが無いため、このテーブルの行は編集できません（行を一意に特定できないため）。</div>';

  $('#keysWrap').innerHTML =
    pkNote +
    block('主キー', detail.primaryKey.length ? [detail.primaryKey.join(', ')] : [], '主キーなし') +
    block('索引', detail.indexes.map((i) => i.definition || `${i.name} (${i.columns.join(', ')})`), '索引なし') +
    block('外部キー', detail.foreignKeys.map((f) => `${f.name}: ${f.definition}`), '外部キーなし');
}

async function loadRows() {
  $('#dataGridWrap').innerHTML = '<p class="spinner">loading rows</p>';
  try {
    const result = await api(dbPath(`tables/${state.schema}/${state.table.name}/rows`, {
      limit: state.limit,
      offset: state.offset,
      orderBy: state.orderBy,
      orderDir: state.orderDir,
      where: state.where,
    }));
    state.rows = result.rows;
    state.rowColumns = result.columns;
    $('#dataGridWrap').innerHTML = result.rows.length
      ? buildGrid(result.columns, result.rows, {
          rowNumbers: true,
          startIndex: state.offset,
          sortable: true,
          rowOps: rowOpsEnabled(),
        })
      : '<p class="empty">該当する行がありません</p>';
    $('#sqlPreview').textContent = result.sql;
    updatePager(result.rows.length);
  } catch (err) {
    $('#dataGridWrap').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    toast(err.message, 'err');
  }
}

/** 行ごとの編集・削除ボタンを出せる条件。 */
function rowOpsEnabled() {
  return Boolean(
    canWrite() &&
    state.detail &&
    state.detail.primaryKey.length &&
    state.table &&
    state.table.type === 'TABLE'
  );
}

function updatePager(fetched) {
  const from = fetched ? state.offset + 1 : 0;
  const to = state.offset + fetched;
  const total = state.exactCount === null ? '' : ` / ${formatNumber(state.exactCount)}`;
  $('#pagerInfo').textContent = `${formatNumber(from)}-${formatNumber(to)}${total}`;
  $('#btnPrev').disabled = state.offset === 0;
  $('#btnNext').disabled = fetched < state.limit;
}

$('#btnPrev').addEventListener('click', () => {
  state.offset = Math.max(0, state.offset - state.limit);
  loadRows();
});

$('#btnNext').addEventListener('click', () => {
  state.offset += state.limit;
  loadRows();
});

$('#btnReload').addEventListener('click', () => {
  state.where = $('#whereInput').value.trim();
  state.limit = Number($('#limitSelect').value);
  state.offset = 0;
  state.exactCount = null;
  loadRows();
});

$('#whereInput').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') $('#btnReload').click();
});

$('#btnExactCount').addEventListener('click', async () => {
  if (!state.table) return;
  const button = $('#btnExactCount');
  button.disabled = true;
  const label = button.textContent;
  button.textContent = '集計中';
  try {
    const { count } = await api(dbPath(`tables/${state.schema}/${state.table.name}/count`, {
      where: state.where,
    }));
    state.exactCount = count;
    toast(`${state.schema}.${state.table.name}: ${formatNumber(count)} 行`, 'ok');
    updatePager(Math.min(state.limit, Math.max(count - state.offset, 0)));
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
});

/* タブ切り替え */
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    $$('.tab-panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === tab.dataset.tab));
  });
});

/* ------------------------------------------------------------
 * グリッド描画
 * ---------------------------------------------------------- */

function buildGrid(columns, rows, options = {}) {
  const { rowNumbers = false, startIndex = 0, sortable = false, rowOps = false } = options;
  const pkSet = new Set(sortable && state.detail ? state.detail.primaryKey : []);

  const head = columns
    .map((c) => {
      const isSorted = sortable && state.orderBy === c;
      const marker = isSorted ? `<span class="sort">${state.orderDir === 'ASC' ? '^' : 'v'}</span>` : '';
      const pk = pkSet.has(c) ? '<span class="pk">PK</span>' : '';
      const attrs = sortable ? ` data-column="${esc(c)}"` : ' style="cursor:default"';
      return `<th${attrs} title="${esc(c)}">${esc(c)}${pk}${marker}</th>`;
    })
    .join('');

  const body = rows
    .map((row, i) => {
      const cells = row.map(renderCell).join('');
      const num = rowNumbers ? `<td class="rownum">${startIndex + i + 1}</td>` : '';
      const ops = rowOps
        ? `<td class="rowops"><div class="rowops-inner">
             <button class="btn btn-sm" data-row="${i}" data-op="edit" title="この行を修正">修正</button>
             <button class="btn btn-sm btn-danger" data-row="${i}" data-op="delete" title="この行を削除">削除</button>
           </div></td>`
        : '';
      return `<tr data-row="${i}">${ops}${num}${cells}</tr>`;
    })
    .join('');

  const opsHead = rowOps ? '<th class="rownum" style="cursor:default">操作</th>' : '';
  const numHead = rowNumbers ? '<th class="rownum" style="cursor:default">#</th>' : '';

  return `<table class="grid">
    <thead><tr>${opsHead}${numHead}${head}</tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function renderCell(value) {
  if (value === null) return '<td class="null">NULL</td>';
  if (typeof value === 'boolean') return `<td class="bool">${value}</td>`;
  const numeric = typeof value === 'number';
  const text = String(value);
  return `<td class="${numeric ? 'num' : ''}" title="${esc(text)}">${esc(text)}</td>`;
}

/* 列ヘッダで並び替え / 行操作ボタン */
$('#dataGridWrap').addEventListener('click', (ev) => {
  const opButton = ev.target.closest('button[data-op]');
  if (opButton) {
    const index = Number(opButton.dataset.row);
    if (opButton.dataset.op === 'edit') return openRowEditor('update', index);
    if (opButton.dataset.op === 'delete') return confirmDeleteRow(index);
    return;
  }

  const th = ev.target.closest('th[data-column]');
  if (!th) return;
  const column = th.dataset.column;
  if (state.orderBy === column) {
    state.orderDir = state.orderDir === 'ASC' ? 'DESC' : 'ASC';
  } else {
    state.orderBy = column;
    state.orderDir = 'ASC';
  }
  state.offset = 0;
  loadRows();
});

/* ------------------------------------------------------------
 * 行の編集
 * ---------------------------------------------------------- */

/** 表示中の行から { 列名: 値 } を作る。 */
function rowToObject(index) {
  const row = state.rows[index];
  if (!row) return null;
  const obj = {};
  state.rowColumns.forEach((col, i) => { obj[col] = row[i]; });
  return obj;
}

/** 主キーの値だけを取り出す。 */
function keyOfRow(rowObject) {
  const key = {};
  for (const col of state.detail.primaryKey) key[col] = rowObject[col];
  return key;
}

function openRowEditor(mode, index) {
  if (!rowOpsEnabled() && mode === 'update') return;
  const original = mode === 'update' ? rowToObject(index) : null;

  state.editing = {
    mode,
    original,
    key: original ? keyOfRow(original) : null,
  };

  $('#rowModalTitle').textContent = mode === 'insert' ? '行の追加' : '行の修正';
  $('#rowModalSub').textContent = `${state.schema}.${state.table.name}${
    original ? ` — ${state.detail.primaryKey.map((c) => `${c}=${original[c]}`).join(', ')}` : ''
  }`;
  $('#rowFormMessage').textContent = '';
  $('#rowFormMessage').className = 'form-message';
  $('#btnSubmitRow').textContent = mode === 'insert' ? '確認へ進む' : '確認へ進む';

  renderRowEditor(mode, original);
  $('#rowModal').hidden = false;
  updateChangeCount();
}

function renderRowEditor(mode, original) {
  const pk = new Set(state.detail.primaryKey);

  $('#rowEditor').innerHTML = state.detail.columns
    .map((col) => {
      const isKey = pk.has(col.name);
      // 主キーは更新時に変更させない (WHERE 句の基準になるため)
      const locked = mode === 'update' && isKey;
      const value = original ? original[col.name] : null;
      const isEmpty = value === null || value === undefined;
      // 追加時は NULL を既定で立てない。未入力の列は送らず、DB の既定値に任せる。
      const isNull = mode === 'update' && isEmpty;
      const shown = isEmpty ? '' : String(value);
      const identityNote = col.isIdentity ? ' (自動採番)' : '';

      return `<div class="editor-field${isKey ? ' is-key' : ''}" data-column="${esc(col.name)}">
        <label class="editor-name" for="f_${esc(col.name)}">
          ${esc(col.name)}
          <span class="editor-type">${esc(col.dataType)}${col.nullable ? '' : ' NOT NULL'}${identityNote}</span>
        </label>
        <input type="text" id="f_${esc(col.name)}" data-input="${esc(col.name)}"
               value="${esc(shown)}"${locked ? ' disabled' : ''}
               placeholder="${col.defaultValue && mode === 'insert' ? `既定: ${esc(col.defaultValue)}` : ''}">
        <label class="editor-null" title="この列に NULL を設定します">
          <input type="checkbox" data-null="${esc(col.name)}"${isNull ? ' checked' : ''}${locked || !col.nullable ? ' disabled' : ''}>
          NULL
        </label>
      </div>`;
    })
    .join('');
}

$('#rowEditor').addEventListener('input', updateChangeCount);
$('#rowEditor').addEventListener('change', (ev) => {
  // NULL にチェックを入れたら値欄を空にして無効化する
  const nullBox = ev.target.closest('input[data-null]');
  if (nullBox) {
    const input = $(`input[data-input="${CSS.escape(nullBox.dataset.null)}"]`);
    if (input && !input.disabled) {
      if (nullBox.checked) input.value = '';
      input.readOnly = nullBox.checked;
    }
  }
  updateChangeCount();
});

/** 編集フォームから現在の入力値を取り出す。 */
function collectEditorFields() {
  const fields = {};
  for (const el of $$('#rowEditor input[data-input]')) {
    const column = el.dataset.input;
    const nullBox = $(`#rowEditor input[data-null="${CSS.escape(column)}"]`);
    fields[column] = {
      value: el.value,
      // 無効化されたチェックボックス (NOT NULL 列や主キー) は NULL 指定として扱わない
      isNull: Boolean(nullBox && nullBox.checked && !nullBox.disabled),
      locked: el.disabled,
    };
  }
  return fields;
}

/** 元の値と比べて実際に変わった列だけを返す。 */
function changedFields() {
  const fields = collectEditorFields();
  const original = state.editing.original;
  const changed = {};

  for (const [column, field] of Object.entries(fields)) {
    if (field.locked) continue;
    const before = original ? original[column] : undefined;
    const after = field.isNull ? null : field.value;

    if (state.editing.mode === 'insert') {
      // 追加時は、入力があった列と明示的に NULL 指定した列だけ送る
      if (field.isNull || field.value !== '') changed[column] = { value: field.value, isNull: field.isNull };
      continue;
    }

    const beforeText = before === null || before === undefined ? null : String(before);
    const afterText = after === null ? null : String(after);
    if (beforeText !== afterText) {
      changed[column] = { value: field.value, isNull: field.isNull };
    }
  }
  return changed;
}

function updateChangeCount() {
  if (!state.editing) return;
  const changed = Object.keys(changedFields());
  $('#rowChangeCount').textContent =
    state.editing.mode === 'insert'
      ? `${changed.length} 列に値を指定`
      : `${changed.length} 列を変更`;

  for (const el of $$('#rowEditor .editor-field')) {
    el.classList.toggle('is-changed', changed.includes(el.dataset.column));
  }
  $('#btnSubmitRow').disabled = changed.length === 0;
}

$('#btnCancelRow').addEventListener('click', () => { $('#rowModal').hidden = true; state.editing = null; });

$('#btnSubmitRow').addEventListener('click', () => {
  const changed = changedFields();
  if (!Object.keys(changed).length) return;

  if (state.editing.mode === 'insert') {
    openConfirm({
      title: '行の追加',
      danger: false,
      body: buildInsertPreview(changed),
      sql: describeInsertSql(changed),
      run: () => api(dbPath(`tables/${state.schema}/${state.table.name}/rows`), {
        method: 'POST',
        body: { database: state.database, fields: changed },
      }),
      done: '1 行を追加しました',
    });
  } else {
    openConfirm({
      title: '行の修正',
      danger: false,
      body: buildUpdatePreview(changed),
      sql: describeUpdateSql(changed),
      run: () => api(dbPath(`tables/${state.schema}/${state.table.name}/rows`), {
        method: 'PATCH',
        body: { database: state.database, key: keyFields(), fields: changed },
      }),
      done: '1 行を修正しました',
    });
  }
});

/** 主キーを API へ渡す形にする。 */
function keyFields() {
  const key = {};
  for (const [col, value] of Object.entries(state.editing.key)) {
    key[col] = { value: value === null ? null : String(value), isNull: value === null };
  }
  return key;
}

function buildUpdatePreview(changed) {
  const original = state.editing.original;
  const rows = Object.entries(changed)
    .map(([col, field]) => {
      const before = original[col];
      const after = field.isNull ? null : field.value;
      return `<div>
        <span class="diff-col">${esc(col)}</span>
        <span class="diff-arrow">:</span>
        <span class="diff-old">${esc(before === null ? 'NULL' : String(before))}</span>
        <span class="diff-arrow">&rarr;</span>
        <span class="diff-new">${esc(after === null ? 'NULL' : after)}</span>
      </div>`;
    })
    .join('');
  return `<div class="notice">対象行: <strong>${esc(
    state.detail.primaryKey.map((c) => `${c}=${original[c]}`).join(', ')
  )}</strong></div><div class="diff-list">${rows}</div>`;
}

function buildInsertPreview(changed) {
  const rows = Object.entries(changed)
    .map(([col, field]) => `<div>
        <span class="diff-col">${esc(col)}</span>
        <span class="diff-arrow">:</span>
        <span class="diff-new">${esc(field.isNull ? 'NULL' : field.value)}</span>
      </div>`)
    .join('');
  return `<div class="notice">${esc(state.schema)}.${esc(state.table.name)} に 1 行追加します。</div>
          <div class="diff-list">${rows}</div>`;
}

/* 表示用の SQL。実際の実行はサーバー側でバインド変数を使って組み立てる。 */
function describeInsertSql(changed) {
  const cols = Object.keys(changed);
  return `INSERT INTO ${state.schema}.${state.table.name}\n  (${cols.join(', ')})\nVALUES\n  (${cols.map(() => '?').join(', ')});\n\n-- 値は全てバインド変数として渡されます`;
}

function describeUpdateSql(changed) {
  const sets = Object.keys(changed).map((c) => `  ${c} = ?`).join(',\n');
  const where = state.detail.primaryKey.map((c) => `${c} = ?`).join(' AND ');
  return `UPDATE ${state.schema}.${state.table.name}\nSET\n${sets}\nWHERE ${where};\n\n-- 影響行数が 1 行でない場合は自動的にロールバックされます`;
}

function describeDeleteSql() {
  const where = state.detail.primaryKey.map((c) => `${c} = ?`).join(' AND ');
  return `DELETE FROM ${state.schema}.${state.table.name}\nWHERE ${where};\n\n-- 影響行数が 1 行でない場合は自動的にロールバックされます`;
}

/* 行の削除 */
function confirmDeleteRow(index) {
  if (!rowOpsEnabled()) return;
  const original = rowToObject(index);
  state.editing = { mode: 'delete', original, key: keyOfRow(original) };

  const preview = state.rowColumns
    .map((col) => `<div><span class="diff-col">${esc(col)}</span><span class="diff-arrow">:</span>${
      original[col] === null ? '<span class="diff-col">NULL</span>' : esc(String(original[col]))
    }</div>`)
    .join('');

  openConfirm({
    title: '行の削除',
    danger: true,
    body: `<div class="notice danger"><strong>この操作は取り消せません。</strong><br>
             対象行: ${esc(state.detail.primaryKey.map((c) => `${c}=${original[c]}`).join(', '))}</div>
           <p class="section-label">削除される行</p>
           <div class="diff-list">${preview}</div>`,
    sql: describeDeleteSql(),
    run: () => api(dbPath(`tables/${state.schema}/${state.table.name}/rows`), {
      method: 'DELETE',
      body: { database: state.database, key: keyFields() },
    }),
    done: '1 行を削除しました',
  });
}

/* ------------------------------------------------------------
 * 実行前の確認ダイアログ
 * ---------------------------------------------------------- */

/** WHERE 句を持たない UPDATE / DELETE か (画面側の判定。最終判定はサーバー側)。 */
function looksUnqualifiedWrite(sql) {
  const stripped = String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/^(update|delete)\b/i.test(stripped)) return false;
  return !/\bwhere\b/i.test(stripped);
}

function openConfirm({ title, danger, body, sql, run, done, requireAllRows = false }) {
  state.pendingAction = { run, done, requireAllRows };
  $('#confirmTitle').textContent = title;
  $('#confirmTitle').className = danger ? 'danger' : '';
  $('#confirmBody').innerHTML = body;
  $('#confirmSql').textContent = sql;
  $('#confirmMessage').textContent = '';
  $('#confirmMessage').className = 'form-message';
  $('#btnRunConfirm').className = danger ? 'btn btn-danger' : 'btn btn-write';
  $('#btnRunConfirm').textContent = danger ? '削除する' : '実行する';

  // WHERE の無い更新は、追加の同意チェックを入れるまで実行できない
  $('#confirmAllRows').checked = false;
  $('#confirmAllRowsWrap').hidden = !requireAllRows;
  $('#btnRunConfirm').disabled = requireAllRows;

  $('#confirmModal').hidden = false;
}

$('#confirmAllRows').addEventListener('change', (ev) => {
  $('#btnRunConfirm').disabled = !ev.target.checked;
});

$('#btnCancelConfirm').addEventListener('click', () => { $('#confirmModal').hidden = true; state.pendingAction = null; });

$('#btnRunConfirm').addEventListener('click', async () => {
  if (!state.pendingAction) return;
  const button = $('#btnRunConfirm');
  button.disabled = true;
  const label = button.textContent;
  button.textContent = '実行中...';
  try {
    const result = await state.pendingAction.run();
    $('#confirmModal').hidden = true;
    $('#rowModal').hidden = true;
    const message = state.pendingAction.done +
      (result && result.affected !== undefined ? ` (影響行数 ${result.affected})` : '');
    state.pendingAction = null;
    state.editing = null;
    toast(message, 'ok');
    await loadRows();
  } catch (err) {
    const message = $('#confirmMessage');
    message.className = 'form-message err';
    message.textContent = err.message;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
});

$('#btnInsertRow').addEventListener('click', () => openRowEditor('insert', null));

/* ------------------------------------------------------------
 * SQL 実行
 * ---------------------------------------------------------- */

$('#btnOpenSql').addEventListener('click', () => {
  if (!state.activeConnectionId) return toast('先に接続先を選んでください', 'err');
  $('#sqlRunner').hidden = false;
  $('#sqlInput').focus();
});

$('#btnCloseSql').addEventListener('click', () => { $('#sqlRunner').hidden = true; });

$('#sqlInput').addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') $('#btnRunSql').click();
});

/** SELECT / WITH かどうか (画面側の分岐用。最終判定はサーバー側)。 */
function looksReadOnly(sql) {
  const stripped = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\r\n]*/g, ' ').trim();
  return /^(select|with)\b/i.test(stripped);
}

$('#btnRunSql').addEventListener('click', async () => {
  const sql = $('#sqlInput').value.trim();
  if (!sql) return;

  if (looksReadOnly(sql)) return runReadQuery(sql);

  if (!canWrite()) {
    $('#sqlGridWrap').innerHTML =
      '<p class="empty">この接続は読み取り専用です。更新系 SQL を実行するには、接続設定で「読み取り専用」を解除してください。</p>';
    return;
  }

  // 更新系は必ず確認を挟む
  const unqualified = looksUnqualifiedWrite(sql);
  openConfirm({
    title: '更新系 SQL の実行',
    danger: true,
    body: `${unqualified
        ? `<div class="notice danger"><strong>WHERE 句がありません。</strong><br>
             この SQL はテーブルの<strong>全行</strong>が対象になります。実行すると元に戻せません。</div>`
        : ''}
           <div class="notice danger"><strong>影響範囲を確認してください。</strong><br>
             更新系 SQL は WHERE の指定次第で多数の行に影響します。トランザクション内で実行し、
             エラー時は自動的にロールバックしますが、成功した場合はコミットされます。</div>
           <div class="notice">接続: <strong>${esc(activeConnection().name)}</strong>${
             state.database ? ` / db=${esc(state.database)}` : ''
           }</div>`,
    sql,
    requireAllRows: unqualified,
    run: () => api(`/api/db/${state.activeConnectionId}/execute`, {
      method: 'POST',
      body: {
        database: state.database,
        sql,
        confirm: true,
        confirmAllRows: unqualified ? true : undefined,
      },
    }),
    done: 'SQL を実行しました',
  });
});

async function runReadQuery(sql) {
  $('#sqlGridWrap').innerHTML = '<p class="spinner">running</p>';
  $('#sqlResultInfo').textContent = '';
  try {
    const result = await api(`/api/db/${state.activeConnectionId}/query`, {
      method: 'POST',
      body: { sql, database: state.database, maxRows: 1000 },
    });
    $('#sqlGridWrap').innerHTML = result.rows.length
      ? buildGrid(result.columns, result.rows, { rowNumbers: true })
      : '<p class="empty">結果は 0 行です</p>';
    $('#sqlResultInfo').textContent =
      `${formatNumber(result.rowCount)} 行 / ${result.elapsedMs}ms${result.truncated ? ' (先頭1000行を表示)' : ''}`;
  } catch (err) {
    $('#sqlGridWrap').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    $('#sqlResultInfo').textContent = '';
  }
}

/* ------------------------------------------------------------
 * 操作履歴
 * ---------------------------------------------------------- */

$('#btnAudit').addEventListener('click', async () => {
  $('#auditModal').hidden = false;
  $('#auditList').innerHTML = '<p class="spinner">loading</p>';
  try {
    // 履歴はサーバー全体で共通なので、どの接続経由で読んでも同じ
    const id = state.activeConnectionId || (state.connections[0] && state.connections[0].id);
    if (!id) { $('#auditList').innerHTML = '<p class="empty">接続が未登録です</p>'; return; }
    const { entries } = await api(`/api/db/${id}/audit?limit=200`);
    $('#auditList').innerHTML = entries.length
      ? entries.map(renderAuditEntry).join('')
      : '<p class="empty">更新操作の記録はまだありません</p>';
  } catch (err) {
    $('#auditList').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
});

function renderAuditEntry(e) {
  const at = new Date(e.at).toLocaleString('ja-JP');
  const detail = [
    e.connection,
    e.database ? `db=${e.database}` : null,
    e.target,
    e.affected !== undefined ? `${e.affected}行` : null,
    e.sql,
  ].filter(Boolean).join('  ·  ');
  return `<div class="audit-entry">
    <span class="audit-at">${esc(at)}</span>
    <span class="audit-action ${esc(e.action)}">${esc(e.action)}</span>
    <span class="audit-body" title="${esc(detail)}">${esc(detail)}</span>
  </div>`;
}

$('#btnCloseAudit').addEventListener('click', () => { $('#auditModal').hidden = true; });

/* ------------------------------------------------------------
 * 接続設定モーダル
 * ---------------------------------------------------------- */

const form = $('#connForm');

function openConnectionModal(id) {
  const conn = id ? state.connections.find((c) => c.id === id) : null;
  $('#connModalTitle').textContent = conn ? `接続設定: ${conn.name}` : '接続の追加';
  $('#connFormMessage').textContent = '';
  $('#connFormMessage').className = 'form-message';
  form.reset();

  const fallbackType = (state.drivers.find((d) => d.installed) || { id: 'postgres' }).id;
  const values = conn || { type: fallbackType, readOnly: true };

  form.elements.id.value = conn ? conn.id : '';
  form.elements.name.value = values.name || '';
  form.elements.type.value = values.type;
  form.elements.host.value = values.host || '';
  form.elements.port.value = conn ? conn.port : '';
  form.elements.database.value = values.database || '';
  form.elements.serviceName.value = values.serviceName || '';
  form.elements.sid.value = values.sid || '';
  form.elements.instanceName.value = values.instanceName || '';
  form.elements.username.value = values.username || '';
  form.elements.password.value = '';
  form.elements.role.value = values.role || '';
  form.elements.note.value = values.note || '';
  form.elements.encrypt.checked = values.encrypt !== false;
  form.elements.trustServerCertificate.checked = values.trustServerCertificate !== false;
  form.elements.ssl.checked = Boolean(values.ssl);
  form.elements.readOnly.checked = values.readOnly !== false;

  $('#passwordHint').hidden = !(conn && conn.hasPassword);
  $('#passwordInput').placeholder = conn && conn.hasPassword ? '変更しない場合は空欄' : '保存時に暗号化されます';

  applyTypeVisibility();
  applyReadOnlyNotice();
  $('#connModal').hidden = false;
  form.elements.name.focus();
}

function closeConnectionModal() { $('#connModal').hidden = true; }

/** DB種別に応じて専用フィールドの表示を切り替える。 */
function applyTypeVisibility() {
  const type = form.elements.type.value;
  $$('[data-for]').forEach((el) => {
    el.hidden = !el.dataset.for.split(' ').includes(type);
  });
  const driver = state.drivers.find((d) => d.id === type);
  if (driver) form.elements.port.placeholder = `既定 ${driver.defaultPort}`;
}

/** 読み取り専用を外したときは、はっきり警告する。 */
function applyReadOnlyNotice() {
  const readOnly = form.elements.readOnly.checked;
  const notice = $('#readOnlyNotice');
  if (readOnly) {
    notice.className = 'notice';
    notice.innerHTML =
      '<strong>読み取り専用（推奨）</strong>：参照だけを行います。この接続からはデータを一切変更できません。' +
      '移行元のサーバーは、この設定のままにしておくことを強く推奨します。';
  } else {
    notice.className = 'notice write';
    notice.innerHTML =
      '<strong>書き込みを許可します</strong>：この接続では行の追加・修正・削除と、更新系 SQL の実行ができるようになります。<br>' +
      '変更は主キーで特定した 1 行ずつ、実行前の確認を経てのみ行われます。操作内容は「履歴」に記録されます。';
  }
}

$('#typeSelect').addEventListener('change', applyTypeVisibility);
$('#readOnlyInput').addEventListener('change', applyReadOnlyNotice);
$('#btnNewConnection').addEventListener('click', () => openConnectionModal(null));
$('#btnCancelConn').addEventListener('click', closeConnectionModal);
$('#connModal').addEventListener('click', (ev) => {
  if (ev.target === $('#connModal')) closeConnectionModal();
});

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  for (const id of ['#confirmModal', '#rowModal', '#auditModal', '#connModal']) {
    if (!$(id).hidden) { $(id).hidden = true; return; }
  }
});

function formPayload() {
  const data = Object.fromEntries(new FormData(form).entries());
  const payload = {
    ...data,
    port: data.port ? Number(data.port) : undefined,
    encrypt: form.elements.encrypt.checked,
    trustServerCertificate: form.elements.trustServerCertificate.checked,
    ssl: form.elements.ssl.checked,
    readOnly: form.elements.readOnly.checked,
  };
  // 空欄のパスワードは「変更しない」を意味するので送らない
  if (!payload.password) delete payload.password;
  return payload;
}

$('#btnTestConnection').addEventListener('click', async () => {
  const message = $('#connFormMessage');
  message.className = 'form-message';
  message.textContent = '接続テスト中...';
  try {
    const result = await api('/api/connections/test', { method: 'POST', body: formPayload() });
    message.className = 'form-message ok';
    message.textContent = `接続成功 (${result.elapsedMs}ms) ${shortVersion(result.info.version)}`;
  } catch (err) {
    message.className = 'form-message err';
    message.textContent = `接続失敗: ${err.message}`;
  }
});

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const payload = formPayload();
  const id = payload.id;
  delete payload.id;

  // 書き込みを許可する設定にするときは、もう一段確認する
  if (!payload.readOnly) {
    const ok = confirm(
      `接続「${payload.name}」で書き込みを許可します。\n\n` +
      'この接続からデータの追加・修正・削除ができるようになります。\n' +
      'よろしいですか？'
    );
    if (!ok) return;
  }

  try {
    if (id) {
      await api(`/api/connections/${id}`, { method: 'PUT', body: payload });
    } else {
      await api('/api/connections', { method: 'POST', body: payload });
    }
    closeConnectionModal();
    await loadConnections();
    // 編集中の接続を開いていたら、編集可否の表示を追従させる
    if (id && id === state.activeConnectionId) {
      updateModeIndicators();
      if (state.table) await loadRows();
    }
    toast('接続設定を保存しました', 'ok');
  } catch (err) {
    const message = $('#connFormMessage');
    message.className = 'form-message err';
    message.textContent = err.message;
  }
});

/* ------------------------------------------------------------
 * ユーティリティ
 * ---------------------------------------------------------- */

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatNumber(value) {
  return Number(value).toLocaleString('ja-JP');
}

/* ------------------------------------------------------------
 * 起動
 * ---------------------------------------------------------- */

(async function init() {
  try {
    await loadDrivers();
    await loadConnections();
  } catch (err) {
    toast(`初期化に失敗しました: ${err.message}`, 'err');
  }
})();
