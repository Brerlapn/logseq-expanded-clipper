'use strict';

window.onerror = (msg, src, line, col, err) => {
  const banner = document.getElementById('lqc-err-banner');
  if (banner) { banner.textContent = `JS Error: ${msg}\n${src}:${line}:${col}`; banner.style.display = 'block'; }
};

const FIELD_TYPES = ['text', 'number', 'date', 'checkbox', 'url', 'node'];

// ── State ─────────────────────────────────────────────────────────────────────

let tagConfigs = []; // { tagName: string, graph?: string, fields: { name: string, type: string }[] }[]
let graphSettings = {}; // { [graphName]: { capturePage } } — Known Graphs
let editingIndex = -1; // -1 = new, ≥0 = editing existing

// ── Load ──────────────────────────────────────────────────────────────────────

async function load() {
  const data = await browser.storage.sync.get({
    logseqApiToken: '',
    logseqApiPort: 12315,
    tagConfigs: [],
    graphSettings: {},
  });

  document.getElementById('api-token').value = data.logseqApiToken;
  document.getElementById('api-port').value = data.logseqApiPort;
  tagConfigs = data.tagConfigs;
  graphSettings = data.graphSettings;

  const { cliEnabled } = await browser.storage.sync.get({ cliEnabled: false });
  document.getElementById('cli-enabled').checked = cliEnabled;

  // Migration: configs predating graph binding bind to the only known graph
  const known = Object.keys(graphSettings);
  if (known.length === 1) {
    tagConfigs.forEach((c) => { if (!c.graph) c.graph = known[0]; });
  }

  renderGraphList();
  renderTagConfigs();
  await mergeCliGraphs();
}

// CLI transport lists every graph on disk, so none has to be seen open in
// Logseq first. Merged in memory; Save settings persists them.
async function mergeCliGraphs() {
  try {
    const resp = await browser.runtime.sendMessage({ type: 'LQC_OP', op: 'listGraphs' });
    if (!resp?.ok || !Array.isArray(resp.result)) return;
    let added = false;
    resp.result.forEach((name) => {
      if (name && !(name in graphSettings)) {
        graphSettings[name] = { capturePage: '' };
        added = true;
      }
    });
    if (added) renderGraphList();
  } catch { /* baseline transport — Known Graphs stay observation-only */ }
}

// ── Save settings ─────────────────────────────────────────────────────────────

async function saveSettings() {
  const status = document.getElementById('save-status');
  try {
    document.querySelectorAll('#graph-list [data-graph]').forEach((input) => {
      const g = graphSettings[input.dataset.graph];
      if (g) g.capturePage = input.value.trim();
    });

    await browser.storage.sync.set({
      logseqApiToken: document.getElementById('api-token').value.trim(),
      logseqApiPort: parseInt(document.getElementById('api-port').value, 10) || 12315,
      graphSettings,
      tagConfigs,
    });
    showStatus(status, 'Saved!', 'ok');
  } catch (err) {
    showStatus(status, `Error: ${err.message}`, 'err');
  }
}

// ── CLI integration ───────────────────────────────────────────────────────────

async function toggleCli(enabled) {
  const result = document.getElementById('cli-result');
  if (enabled) {
    // Optional permission request must happen in the user-gesture handler
    const granted = await browser.permissions.request({ permissions: ['nativeMessaging'] });
    if (!granted) {
      document.getElementById('cli-enabled').checked = false;
      return;
    }
  }
  await browser.storage.sync.set({ cliEnabled: enabled });
  if (enabled) {
    await testCli();
  } else {
    result.hidden = true;
  }
}

async function testCli() {
  const result = document.getElementById('cli-result');
  result.textContent = 'Testing…';
  result.className = 'test-result';
  result.hidden = false;

  try {
    const status = await browser.runtime.sendMessage({ type: 'LQC_CLI_DETECT' });
    if (status?.available) {
      result.textContent = `CLI connected (${(status.version ?? '').split('\n')[0]})`;
      result.className = 'test-result ok';
      await mergeCliGraphs();
    } else {
      result.textContent = status?.error ?? 'CLI not reachable.';
      result.className = 'test-result err';
    }
  } catch (err) {
    result.textContent = `Error: ${err.message}`;
    result.className = 'test-result err';
  }
}

// ── Known Graphs / capture pages ──────────────────────────────────────────────

function renderGraphList() {
  const list = document.getElementById('graph-list');
  list.innerHTML = '';

  const names = Object.keys(graphSettings);
  if (!names.length) {
    list.innerHTML =
      '<p style="color:#9ca3af;font-size:13px;">No graphs seen yet — connect once ' +
      '(e.g. Test connection above, or open the capture modal) and they will appear here.</p>';
    return;
  }

  names.forEach((name) => {
    const row = document.createElement('div');
    row.className = 'field';

    const label = document.createElement('label');
    label.textContent = name;

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = "Leave blank for this graph's daily journal";
    input.value = graphSettings[name]?.capturePage ?? '';
    input.dataset.graph = name;

    row.appendChild(label);
    row.appendChild(input);
    list.appendChild(row);
  });
}

function showStatus(el, text, type) {
  el.textContent = text;
  el.className = `save-status ${type}`;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 2500);
}

// ── Test connection ───────────────────────────────────────────────────────────

async function testConnection() {
  const result = document.getElementById('test-result');
  result.textContent = 'Testing…';
  result.className = 'test-result';
  result.hidden = false;

  const token = document.getElementById('api-token').value.trim();
  const port = parseInt(document.getElementById('api-port').value, 10) || 12315;

  if (!token) {
    result.textContent = 'Enter an API token first.';
    result.className = 'test-result err';
    return;
  }

  try {
    const res = await fetch(`http://localhost:${port}/api`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ method: 'logseq.App.getCurrentGraph', args: [] }),
    });

    if (res.status === 401) {
      result.textContent = 'Invalid token.';
      result.className = 'test-result err';
      return;
    }
    if (!res.ok) {
      result.textContent = `Error ${res.status}`;
      result.className = 'test-result err';
      return;
    }

    const data = await res.json();
    // The HTTP API reports the internal repo name ("logseq_db_General")
    const name = String(data?.name ?? data?.['graph/name'] ?? 'graph').replace(/^logseq_db_/, '');
    result.textContent = `Connected to "${name}"`;
    result.className = 'test-result ok';

    // A successful test observes the open graph — register it as a Known Graph
    if (name && name !== 'graph' && !(name in graphSettings)) {
      graphSettings[name] = { capturePage: '' };
      await browser.storage.sync.set({ graphSettings });
      renderGraphList();
    }
  } catch {
    result.textContent = 'Could not reach Logseq — is it running with the HTTP API enabled?';
    result.className = 'test-result err';
  }
}

// ── Tag config list ───────────────────────────────────────────────────────────

function renderTagConfigs() {
  const list = document.getElementById('tag-configs-list');
  list.innerHTML = '';

  if (!tagConfigs.length) {
    list.innerHTML = '<p style="color:#9ca3af;font-size:13px;">No tag configs yet.</p>';
    return;
  }

  tagConfigs.forEach((cfg, i) => {
    const card = document.createElement('div');
    card.className = 'tag-config-card';

    const header = document.createElement('div');
    header.className = 'tag-config-header';

    const name = document.createElement('span');
    name.className = 'tag-config-name';
    name.textContent = cfg.tagName
      + (cfg.graph ? ` — ${cfg.graph}` : ' — (no graph set)')
      + (cfg.liveRead ? ' • live' : '');

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-secondary';
    editBtn.textContent = 'Edit';
    editBtn.style.padding = '4px 12px';
    editBtn.style.fontSize = '12px';
    editBtn.addEventListener('click', () => openEditor(i));

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => deleteTagConfig(i));

    header.appendChild(name);
    header.appendChild(editBtn);
    header.appendChild(delBtn);

    const pills = document.createElement('div');
    pills.className = 'tag-config-fields';
    (cfg.fields ?? []).forEach((f) => {
      const pill = document.createElement('span');
      pill.className = 'field-pill';
      pill.textContent = f.name;
      const typeSpan = document.createElement('span');
      typeSpan.className = 'field-type';
      typeSpan.textContent = f.type;
      pill.appendChild(typeSpan);
      pills.appendChild(pill);
    });

    card.appendChild(header);
    if (cfg.fields?.length) card.appendChild(pills);
    list.appendChild(card);
  });
}

function deleteTagConfig(i) {
  if (!confirm(`Delete config for #${tagConfigs[i].tagName}?`)) return;
  tagConfigs.splice(i, 1);
  renderTagConfigs();
  if (editingIndex === i) closeEditor();
}

// ── Tag editor ────────────────────────────────────────────────────────────────

function openEditor(index) {
  editingIndex = index;
  const editor = document.getElementById('tag-editor');
  const title = document.getElementById('tag-editor-title');
  const nameInput = document.getElementById('te-tag-name');
  const graphSelect = document.getElementById('te-tag-graph');
  const fieldsList = document.getElementById('te-fields-list');

  const known = Object.keys(graphSettings);
  graphSelect.innerHTML = known.length
    ? ''
    : '<option value="">(no graphs seen yet)</option>';
  known.forEach((g) => {
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = g;
    graphSelect.appendChild(opt);
  });
  graphSelect.onchange = () => loadTagNameSuggestions(graphSelect.value);

  if (index === -1) {
    title.textContent = 'New tag config';
    nameInput.value = '';
    fieldsList.innerHTML = '';
  } else {
    const cfg = tagConfigs[index];
    title.textContent = `Edit #${cfg.tagName}`;
    nameInput.value = cfg.tagName;
    if (cfg.graph) graphSelect.value = cfg.graph;
    fieldsList.innerHTML = '';
    (cfg.fields ?? []).forEach((f) => addFieldRow(f.name, f.type));
  }

  // Live-read configs mirror the graph's schema — field edits would be
  // overwritten on the next refresh, so lock them
  const isLive = index !== -1 && Boolean(tagConfigs[index]?.liveRead);
  document.getElementById('te-live-note').hidden = !isLive;
  document.getElementById('te-add-field').style.display = isLive ? 'none' : '';
  fieldsList.querySelectorAll('input, select, button').forEach((el) => { el.disabled = isLive; });

  loadTagNameSuggestions(graphSelect.value);

  editor.hidden = false;
  nameInput.focus();
  editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// With the CLI transport, the selected graph's existing tags feed a datalist
// under the tag-name input, so configs reference real tags instead of typos.
// Baseline (no CLI): silently no suggestions.
async function loadTagNameSuggestions(graph) {
  const datalist = document.getElementById('te-tag-names');
  const hint = document.getElementById('te-tag-names-hint');
  datalist.innerHTML = '';
  hint.hidden = true;
  if (!graph) return;

  try {
    const resp = await browser.runtime.sendMessage({ type: 'LQC_OP', op: 'getTags', graph });
    if (!resp?.ok || !Array.isArray(resp.result)) return;
    resp.result.forEach((tag) => {
      const opt = document.createElement('option');
      opt.value = tag;
      datalist.appendChild(opt);
    });
    hint.hidden = resp.result.length === 0;
  } catch { /* baseline transport — no suggestions */ }
}

function closeEditor() {
  document.getElementById('tag-editor').hidden = true;
  editingIndex = -1;
}

function addFieldRow(name = '', type = 'text') {
  const list = document.getElementById('te-fields-list');

  const row = document.createElement('div');
  row.className = 'field-row';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'field-name';
  nameInput.value = name;
  nameInput.dataset.role = 'field-name';

  const typeSelect = document.createElement('select');
  typeSelect.dataset.role = 'field-type';
  FIELD_TYPES.forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    if (t === type) opt.selected = true;
    typeSelect.appendChild(opt);
  });

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-remove-field';
  removeBtn.setAttribute('aria-label', 'Remove field');
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => row.remove());

  row.appendChild(nameInput);
  row.appendChild(typeSelect);
  row.appendChild(removeBtn);
  list.appendChild(row);
  nameInput.focus();
}

function saveEditor() {
  const tagName = document.getElementById('te-tag-name').value.trim().replace(/^#/, '');
  if (!tagName) {
    alert('Tag name is required.');
    return;
  }

  // Graph binding is required once any graph is known; before first connection
  // there is nothing to choose from, so an unbound config is allowed (no guard)
  const graph = document.getElementById('te-tag-graph').value;
  if (!graph && Object.keys(graphSettings).length) {
    alert('Pick the graph this tag lives in.');
    return;
  }

  const fieldRows = document.getElementById('te-fields-list').querySelectorAll('.field-row');
  const fields = [];
  let valid = true;

  fieldRows.forEach((row) => {
    const name = row.querySelector('[data-role="field-name"]').value.trim();
    const type = row.querySelector('[data-role="field-type"]').value;
    if (!name) { valid = false; return; }
    fields.push({ name, type });
  });

  if (!valid) {
    alert('All fields must have a name.');
    return;
  }

  // Check for duplicate tag name when creating new
  if (editingIndex === -1) {
    if (tagConfigs.some((c) => c.tagName === tagName)) {
      alert(`A config for #${tagName} already exists.`);
      return;
    }
    tagConfigs.push({ tagName, graph, fields });
  } else {
    const prev = tagConfigs[editingIndex];
    tagConfigs[editingIndex] = prev?.liveRead
      ? { ...prev, tagName, graph } // fields stay mirrored from the graph
      : { tagName, graph, fields };
  }

  renderTagConfigs();
  closeEditor();
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Wire up ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  load();

  document.getElementById('save-settings').addEventListener('click', saveSettings);
  document.getElementById('test-connection').addEventListener('click', testConnection);
  document.getElementById('cli-enabled').addEventListener('change', (e) => toggleCli(e.target.checked));
  document.getElementById('cli-test').addEventListener('click', testCli);
  document.getElementById('add-tag-config').addEventListener('click', () => openEditor(-1));
  document.getElementById('te-add-field').addEventListener('click', () => addFieldRow());
  document.getElementById('te-save').addEventListener('click', saveEditor);
  document.getElementById('te-cancel').addEventListener('click', closeEditor);
});
