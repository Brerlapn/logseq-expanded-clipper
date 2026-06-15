'use strict';

window.onerror = (msg, src, line, col, err) => {
  const banner = document.getElementById('lqc-err-banner');
  if (banner) { banner.textContent = `JS Error: ${msg}\n${src}:${line}:${col}`; banner.style.display = 'block'; }
};

const FIELD_TYPES = ['text', 'number', 'date', 'checkbox', 'url', 'node'];

// ── State ─────────────────────────────────────────────────────────────────────

let tagConfigs = []; // { tagName: string, fields: { name: string, type: string }[] }[]
let editingIndex = -1; // -1 = new, ≥0 = editing existing

// ── Load ──────────────────────────────────────────────────────────────────────

async function load() {
  const data = await browser.storage.sync.get({
    logseqApiToken: '',
    logseqApiPort: 12315,
    defaultCapturePage: '',
    tagConfigs: [],
  });

  document.getElementById('api-token').value = data.logseqApiToken;
  document.getElementById('api-port').value = data.logseqApiPort;
  document.getElementById('default-page').value = data.defaultCapturePage;
  tagConfigs = data.tagConfigs;

  renderTagConfigs();
}

// ── Save settings ─────────────────────────────────────────────────────────────

async function saveSettings() {
  const status = document.getElementById('save-status');
  try {
    await browser.storage.sync.set({
      logseqApiToken: document.getElementById('api-token').value.trim(),
      logseqApiPort: parseInt(document.getElementById('api-port').value, 10) || 12315,
      defaultCapturePage: document.getElementById('default-page').value.trim(),
      tagConfigs,
    });
    showStatus(status, 'Saved!', 'ok');
  } catch (err) {
    showStatus(status, `Error: ${err.message}`, 'err');
  }
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
    const name = data?.name ?? data?.['graph/name'] ?? 'graph';
    result.textContent = `Connected to "${name}"`;
    result.className = 'test-result ok';
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
    name.textContent = cfg.tagName;

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
  const fieldsList = document.getElementById('te-fields-list');

  if (index === -1) {
    title.textContent = 'New tag config';
    nameInput.value = '';
    fieldsList.innerHTML = '';
  } else {
    const cfg = tagConfigs[index];
    title.textContent = `Edit #${cfg.tagName}`;
    nameInput.value = cfg.tagName;
    fieldsList.innerHTML = '';
    (cfg.fields ?? []).forEach((f) => addFieldRow(f.name, f.type));
  }

  editor.hidden = false;
  nameInput.focus();
  editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
    tagConfigs.push({ tagName, fields });
  } else {
    tagConfigs[editingIndex] = { tagName, fields };
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
  document.getElementById('add-tag-config').addEventListener('click', () => openEditor(-1));
  document.getElementById('te-add-field').addEventListener('click', () => addFieldRow());
  document.getElementById('te-save').addEventListener('click', saveEditor);
  document.getElementById('te-cancel').addEventListener('click', closeEditor);
});
