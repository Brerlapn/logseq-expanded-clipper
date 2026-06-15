(function () {
  'use strict';

  if (window.__lqcLoaded) return;
  window.__lqcLoaded = true;

  // ─── State ──────────────────────────────────────────────────────────────────

  let host = null;
  let root = null;
  let modalVisible = false;
  let currentMode = 'clipper';
  let selectedTags = [];
  let allTags = [];
  let tagConfigs = [];
  let capturedTitle = '';
  let capturedUrl = '';
  let capturedHighlight = '';
  let autocompleteIndex = -1;

  // ─── DOM helpers ────────────────────────────────────────────────────────────

  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => root.querySelectorAll(sel);

  function escHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── Background API proxy ───────────────────────────────────────────────────

  async function apiCall(method, args) {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Logseq API call timed out — is the HTTP API enabled?')), 15000)
    );
    const call = browser.runtime.sendMessage({ type: 'LQC_API', method, args })
      .then(resp => {
        if (!resp?.ok) throw new Error(resp?.error ?? 'Unknown API error');
        return resp.result;
      });
    return Promise.race([call, timeout]);
  }

  // ─── Date formatting ────────────────────────────────────────────────────────

  function formatDate(date, fmt) {
    const months = [
      'January','February','March','April','May','June',
      'July','August','September','October','November','December',
    ];
    const short = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const d = date.getDate();
    const suffix = (['th','st','nd','rd'][
      (d % 10 > 3 || Math.floor((d % 100) / 10) === 1) ? 0 : d % 10
    ]) ?? 'th';
    const pad = (n) => String(n).padStart(2, '0');

    return fmt
      .replace(/MMMM/g, months[date.getMonth()])
      .replace(/MMM/g,  short[date.getMonth()])
      .replace(/MM/g,   pad(date.getMonth() + 1))
      .replace(/do/g,   d + suffix)
      .replace(/DD/g,   pad(d))
      .replace(/D/g,    String(d))
      .replace(/YYYY/g, String(date.getFullYear()))
      .replace(/YY/g,   String(date.getFullYear()).slice(-2));
  }

  // ─── Persistence ────────────────────────────────────────────────────────────

  function savePending(state) {
    browser.storage.local.set({ lqcPending: state });
  }

  function clearPending() {
    browser.storage.local.remove('lqcPending');
  }

  async function getPending() {
    const data = await browser.storage.local.get('lqcPending');
    return data.lqcPending ?? null;
  }

  function collectDraft() {
    if (currentMode === 'clipper') {
      return {
        mode: 'clipper',
        url: capturedUrl,
        title: capturedTitle,
        highlight: capturedHighlight,
        tags: [...selectedTags],
        notes: $('#lqc-notes')?.value ?? '',
      };
    }
    const tagName = $('#lqc-tag-select')?.value ?? '';
    const fields = {};
    $$('.lqc-prop-input').forEach((el) => {
      fields[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return { mode: 'tags', url: capturedUrl, title: capturedTitle, tagName, fields };
  }

  function saveDraft() {
    savePending(collectDraft());
  }

  // ─── Tag chips ──────────────────────────────────────────────────────────────

  function renderChips() {
    const container = $('#lqc-tag-chips');
    container.querySelectorAll('.lqc-chip').forEach((c) => c.remove());
    const input = $('#lqc-tag-input');
    selectedTags.forEach((tag) => {
      const chip = document.createElement('span');
      chip.className = 'lqc-chip';
      chip.textContent = tag;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lqc-chip-remove';
      btn.setAttribute('aria-label', `Remove ${tag}`);
      btn.textContent = '×';
      btn.addEventListener('click', () => {
        selectedTags = selectedTags.filter((t) => t !== tag);
        renderChips();
        saveDraft();
      });
      chip.appendChild(btn);
      container.insertBefore(chip, input);
    });
  }

  function addTag(tag) {
    const t = tag.trim().replace(/^#/, '');
    if (t && !selectedTags.includes(t)) {
      selectedTags.push(t);
      renderChips();
    }
    $('#lqc-tag-input').value = '';
    hideAutocomplete();
    saveDraft();
  }

  // ─── Autocomplete ───────────────────────────────────────────────────────────

  function showAutocomplete(matches) {
    const list = $('#lqc-autocomplete');
    list.innerHTML = '';
    if (!matches.length) { list.hidden = true; return; }

    matches.slice(0, 8).forEach((tag) => {
      const item = document.createElement('div');
      item.className = 'lqc-ac-item';
      item.dataset.tag = tag;
      item.textContent = tag;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault(); // prevent input blur
        addTag(tag);
      });
      list.appendChild(item);
    });

    list.hidden = false;
    autocompleteIndex = -1;
  }

  function hideAutocomplete() {
    const list = $('#lqc-autocomplete');
    if (list) list.hidden = true;
    autocompleteIndex = -1;
  }

  function moveAutocomplete(dir) {
    const items = $$('.lqc-ac-item');
    if (!items.length) return;
    autocompleteIndex = Math.max(-1, Math.min(autocompleteIndex + dir, items.length - 1));
    items.forEach((el, i) => el.classList.toggle('lqc-ac-active', i === autocompleteIndex));
  }

  // ─── Mode switching ──────────────────────────────────────────────────────────

  function switchMode(mode) {
    currentMode = mode;
    $$('.lqc-tab').forEach((t) => t.classList.toggle('lqc-tab-active', t.dataset.mode === mode));
    $('#lqc-clipper-panel').hidden = mode !== 'clipper';
    $('#lqc-tags-panel').hidden = mode !== 'tags';
    resetSaveButton();
  }

  // ─── Tag Properties field rendering ─────────────────────────────────────────

  function renderTagFields(tagName) {
    const config = tagConfigs.find((c) => c.tagName === tagName);
    const container = $('#lqc-tag-fields');
    container.innerHTML = '';
    if (!config?.fields?.length) return;

    config.fields.forEach((field) => {
      const row = document.createElement('div');
      row.className = 'lqc-field';

      const label = document.createElement('label');
      label.textContent = field.name;
      label.htmlFor = `lqc-prop-${escHtml(field.name)}`;

      let input;
      if (field.type === 'checkbox') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'lqc-checkbox';
      } else {
        input = document.createElement('input');
        input.type = {
          number: 'number',
          date: 'date',
          url: 'url',
          text: 'text',
          node: 'text',
        }[field.type] ?? 'text';
        input.className = 'lqc-input';
        if (field.type === 'url') input.placeholder = 'https://…';
        if (field.type === 'number') input.step = 'any';
      }

      input.id = `lqc-prop-${field.name}`;
      input.className = (input.className || '') + ' lqc-prop-input';
      input.dataset.field = field.name;
      input.dataset.type = field.type;
      input.addEventListener('input', saveDraft);
      input.addEventListener('change', saveDraft);

      row.appendChild(label);
      row.appendChild(input);
      container.appendChild(row);
    });
  }

  // ─── Restore a pending draft ─────────────────────────────────────────────────

  function restoreDraft(draft) {
    if (!draft) return;

    if (draft.mode === 'clipper') {
      switchMode('clipper');
      selectedTags = draft.tags ?? [];
      renderChips();
      if ($('#lqc-notes')) $('#lqc-notes').value = draft.notes ?? '';
    } else {
      switchMode('tags');
      const sel = $('#lqc-tag-select');
      if (sel && draft.tagName) {
        sel.value = draft.tagName;
        renderTagFields(draft.tagName);
        // field values need to wait for DOM to settle
        setTimeout(() => {
          Object.entries(draft.fields ?? {}).forEach(([name, val]) => {
            const el = root.querySelector(`.lqc-prop-input[data-field="${name}"]`);
            if (!el) return;
            if (el.type === 'checkbox') el.checked = val;
            else el.value = val;
          });
        }, 0);
      }
    }
  }

  // ─── Target page resolution ──────────────────────────────────────────────────

  async function getTargetPage() {
    const { defaultCapturePage } = await browser.storage.sync.get({ defaultCapturePage: '' });
    if (defaultCapturePage) return defaultCapturePage;

    try {
      const configs = await apiCall('logseq.App.getUserConfigs', []);
      const fmt = configs?.preferredDateFormat;
      if (fmt) return formatDate(new Date(), fmt);
    } catch { /* fall through */ }

    // ISO date as universal fallback
    return new Date().toISOString().slice(0, 10);
  }

  // ─── Save ────────────────────────────────────────────────────────────────────

  async function handleSave() {
    const btn = $('#lqc-save');
    const errEl = $('#lqc-error');

    btn.disabled = true;
    btn.textContent = 'Saving…';
    errEl.hidden = true;

    try {
      if (currentMode === 'clipper') {
        await saveWebClip();
      } else {
        await saveTagProperties();
      }
      clearPending();
      closeModal();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Retry';
    }
  }

  async function saveWebClip() {
    const notes = $('#lqc-notes').value.trim();
    const targetPage = await getTargetPage();

    const block = await apiCall('logseq.Editor.appendBlockInPage', [
      targetPage,
      `[${capturedTitle}](${capturedUrl})`,
    ]);

    if (!block?.uuid) {
      throw new Error('Block created but no UUID returned — check Logseq HTTP API compatibility.');
    }

    const tags = [...selectedTags];
    if (capturedHighlight) tags.push('highlight');
    if (tags.length) {
      await apiCall('logseq.Editor.upsertBlockProperty', [block.uuid, 'tags', tags]);
    }

    if (notes) {
      await apiCall('logseq.Editor.insertBlock', [block.uuid, notes, { sibling: false }]);
    }

    if (capturedHighlight) {
      await apiCall('logseq.Editor.insertBlock', [
        block.uuid,
        `> ${capturedHighlight}`,
        { sibling: false },
      ]);
    }
  }

  async function saveTagProperties() {
    const tagName = $('#lqc-tag-select').value;
    if (!tagName) throw new Error('Please select a tag.');

    const targetPage = await getTargetPage();

    const block = await apiCall('logseq.Editor.appendBlockInPage', [
      targetPage,
      `[${capturedTitle}](${capturedUrl})`,
    ]);

    if (!block?.uuid) {
      throw new Error('Block created but no UUID returned — check Logseq HTTP API compatibility.');
    }

    await apiCall('logseq.Editor.upsertBlockProperty', [block.uuid, 'tags', [tagName]]);

    for (const el of $$('.lqc-prop-input')) {
      const val = el.type === 'checkbox' ? el.checked : el.value;
      const typed = el.dataset.type === 'number' ? (parseFloat(val) || val) : val;
      if (val !== '' && val !== false) {
        await apiCall('logseq.Editor.upsertBlockProperty', [block.uuid, el.dataset.field, typed]);
      }
    }
  }

  // ─── Open / close ────────────────────────────────────────────────────────────

  async function openModal() {
    if (modalVisible) return;

    capturedTitle = document.title;
    capturedUrl = location.href;
    capturedHighlight = window.getSelection()?.toString().trim() ?? '';

    const settings = await browser.storage.sync.get({ tagConfigs: [] });
    tagConfigs = settings.tagConfigs ?? [];

    if (!host) injectModal();

    // Reset to clean state
    selectedTags = [];
    switchMode('clipper');
    renderChips();
    $('#lqc-notes').value = '';
    $('#lqc-error').hidden = true;
    resetSaveButton();

    // Populate page metadata
    $('#lqc-title-display').textContent = capturedTitle;
    $('#lqc-url-display').textContent = capturedUrl;
    $('#lqc-tp-title-display').textContent = capturedTitle;
    $('#lqc-tp-url-display').textContent = capturedUrl;

    // Highlight section
    if (capturedHighlight) {
      $('#lqc-highlight-section').hidden = false;
      const preview = capturedHighlight.length > 200
        ? capturedHighlight.slice(0, 200) + '…'
        : capturedHighlight;
      $('#lqc-highlight-preview').textContent = preview;
    } else {
      $('#lqc-highlight-section').hidden = true;
    }

    // Tag Properties tab options
    const sel = $('#lqc-tag-select');
    sel.innerHTML = '<option value="">Select a tag…</option>';
    tagConfigs.forEach((cfg) => {
      const opt = document.createElement('option');
      opt.value = cfg.tagName;
      opt.textContent = '#' + cfg.tagName;
      sel.appendChild(opt);
    });
    $('#lqc-tag-fields').innerHTML = '';

    // Pending capture notice
    const pending = await getPending();
    const notice = $('#lqc-pending-notice');
    if (pending) {
      const hostname = (() => { try { return new URL(pending.url).hostname; } catch { return pending.url; } })();
      notice.querySelector('.lqc-pending-text').textContent =
        `Unsaved capture from ${hostname}`;
      notice.hidden = false;
      notice.querySelector('#lqc-pending-restore').onclick = () => {
        restoreDraft(pending);
        notice.hidden = true;
      };
      notice.querySelector('#lqc-pending-discard').onclick = () => {
        clearPending();
        notice.hidden = true;
      };
    } else {
      notice.hidden = true;
    }

    // Show modal
    host.hidden = false;
    modalVisible = true;

    // Fetch tags for autocomplete (best-effort, non-blocking)
    fetchAllTags();

    setTimeout(() => $('#lqc-tag-input')?.focus(), 50);
  }

  function closeModal() {
    if (!host) return;
    host.hidden = true;
    modalVisible = false;
    hideAutocomplete();
  }

  function resetSaveButton() {
    const btn = $('#lqc-save');
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = 'Save to Logseq';
  }

  async function fetchAllTags() {
    try {
      const result = await apiCall('logseq.Editor.getAllTags', []);
      if (Array.isArray(result)) {
        allTags = result
          .map((t) => (typeof t === 'string' ? t : t['original-name'] ?? t.name ?? ''))
          .filter(Boolean);
      }
    } catch { /* autocomplete just won't have suggestions */ }
  }

  // ─── CSS ─────────────────────────────────────────────────────────────────────

  const CSS = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    #lqc-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding-top: 72px;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      color: #111827;
    }

    #lqc-modal {
      background: #ffffff;
      border-radius: 10px;
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.35);
      width: 480px;
      max-width: calc(100vw - 32px);
      max-height: calc(100vh - 104px);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ── Header / tabs ── */
    #lqc-header {
      display: flex;
      align-items: stretch;
      border-bottom: 1px solid #e5e7eb;
      padding: 0 12px;
      flex-shrink: 0;
    }

    .lqc-tab {
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      padding: 11px 14px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      color: #6b7280;
      margin-bottom: -1px;
      font-family: inherit;
      transition: color 0.12s, border-color 0.12s;
    }
    .lqc-tab:hover { color: #111827; }
    .lqc-tab.lqc-tab-active { color: #4f46e5; border-bottom-color: #4f46e5; }

    #lqc-close {
      margin-left: auto;
      background: none;
      border: none;
      cursor: pointer;
      font-size: 22px;
      color: #9ca3af;
      line-height: 1;
      padding: 4px 6px;
      border-radius: 4px;
      align-self: center;
      font-family: inherit;
    }
    #lqc-close:hover { color: #111827; background: #f3f4f6; }

    /* ── Body ── */
    #lqc-body {
      padding: 14px 16px;
      overflow-y: auto;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    /* ── Pending notice ── */
    #lqc-pending-notice {
      background: #fffbeb;
      border: 1px solid #fcd34d;
      border-radius: 6px;
      padding: 9px 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .lqc-pending-text { flex: 1; font-size: 12px; color: #92400e; }
    #lqc-pending-restore, #lqc-pending-discard {
      background: none;
      border: 1px solid currentColor;
      border-radius: 4px;
      padding: 2px 8px;
      cursor: pointer;
      font-size: 12px;
      font-family: inherit;
    }
    #lqc-pending-restore { color: #92400e; }
    #lqc-pending-discard { color: #9ca3af; }
    #lqc-pending-restore:hover { background: #fef3c7; }
    #lqc-pending-discard:hover { background: #f3f4f6; }

    /* ── Page meta ── */
    .lqc-meta {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      padding: 9px 12px;
    }
    .lqc-meta-title {
      font-size: 13px;
      font-weight: 600;
      color: #111827;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .lqc-meta-url {
      font-size: 11px;
      color: #9ca3af;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 1px;
    }

    /* ── Fields ── */
    .lqc-field {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .lqc-field label {
      font-size: 11px;
      font-weight: 600;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .lqc-input {
      border: 1px solid #d1d5db;
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 14px;
      font-family: inherit;
      color: #111827;
      background: #fff;
      width: 100%;
      outline: none;
      transition: border-color 0.12s, box-shadow 0.12s;
    }
    .lqc-input:focus {
      border-color: #4f46e5;
      box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.12);
    }

    textarea.lqc-input { resize: vertical; min-height: 68px; }

    select.lqc-input { cursor: pointer; }

    /* ── Tag chips ── */
    .lqc-ac-wrap { position: relative; }

    #lqc-tag-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      align-items: center;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      padding: 6px 8px;
      background: #fff;
      min-height: 40px;
      cursor: text;
      transition: border-color 0.12s, box-shadow 0.12s;
    }
    #lqc-tag-chips:focus-within {
      border-color: #4f46e5;
      box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.12);
    }

    .lqc-chip {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      background: #eef2ff;
      color: #4338ca;
      border-radius: 4px;
      padding: 2px 5px 2px 8px;
      font-size: 13px;
      font-weight: 500;
      line-height: 1.4;
    }
    .lqc-chip-remove {
      background: none;
      border: none;
      cursor: pointer;
      color: #818cf8;
      font-size: 15px;
      line-height: 1;
      padding: 0 1px;
      display: flex;
      align-items: center;
      font-family: inherit;
    }
    .lqc-chip-remove:hover { color: #4338ca; }

    #lqc-tag-input {
      border: none;
      outline: none;
      font-size: 14px;
      font-family: inherit;
      flex: 1;
      min-width: 80px;
      background: transparent;
      color: #111827;
      padding: 2px 0;
    }

    /* ── Autocomplete ── */
    #lqc-autocomplete {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      background: #fff;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
      z-index: 10;
      overflow: hidden;
    }
    .lqc-ac-item {
      padding: 8px 12px;
      cursor: pointer;
      font-size: 13px;
      color: #111827;
    }
    .lqc-ac-item:hover, .lqc-ac-item.lqc-ac-active {
      background: #f5f3ff;
      color: #4f46e5;
    }

    /* ── Highlight ── */
    #lqc-highlight-section { display: flex; flex-direction: column; gap: 5px; }
    .lqc-highlight-label {
      font-size: 11px;
      font-weight: 600;
      color: #4f46e5;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    #lqc-highlight-preview {
      background: #f5f3ff;
      border-left: 3px solid #4f46e5;
      border-radius: 0 6px 6px 0;
      padding: 8px 12px;
      font-size: 13px;
      color: #374151;
      font-style: italic;
      line-height: 1.6;
    }

    /* ── Checkbox prop ── */
    .lqc-checkbox {
      width: 18px;
      height: 18px;
      cursor: pointer;
      accent-color: #4f46e5;
    }

    /* ── Footer ── */
    #lqc-footer {
      padding: 12px 16px;
      border-top: 1px solid #e5e7eb;
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex-shrink: 0;
    }

    #lqc-error {
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 13px;
      color: #dc2626;
      line-height: 1.4;
    }

    #lqc-save {
      background: #4f46e5;
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 10px 20px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      font-family: inherit;
      transition: background 0.12s;
    }
    #lqc-save:hover:not(:disabled) { background: #4338ca; }
    #lqc-save:disabled { opacity: 0.55; cursor: not-allowed; }
  `;

  // ─── HTML template ───────────────────────────────────────────────────────────

  const HTML = `
    <div id="lqc-overlay">
      <div id="lqc-modal" role="dialog" aria-modal="true" aria-label="Logseq Quick Capture">

        <div id="lqc-header">
          <button class="lqc-tab lqc-tab-active" data-mode="clipper">Web Clipper</button>
          <button class="lqc-tab" data-mode="tags">Tag Properties</button>
          <button id="lqc-close" aria-label="Close">&times;</button>
        </div>

        <div id="lqc-body">

          <div id="lqc-pending-notice" hidden>
            <span class="lqc-pending-text"></span>
            <button id="lqc-pending-restore">Restore</button>
            <button id="lqc-pending-discard">Discard</button>
          </div>

          <!-- Web Clipper panel -->
          <div id="lqc-clipper-panel">
            <div class="lqc-meta">
              <div class="lqc-meta-title" id="lqc-title-display"></div>
              <div class="lqc-meta-url" id="lqc-url-display"></div>
            </div>

            <div class="lqc-field lqc-ac-wrap">
              <label>Tags</label>
              <div id="lqc-tag-chips">
                <input id="lqc-tag-input" type="text" placeholder="Add tags…"
                       autocomplete="off" spellcheck="false" aria-label="Add tag">
              </div>
              <div id="lqc-autocomplete" hidden></div>
            </div>

            <div class="lqc-field">
              <label for="lqc-notes">Notes</label>
              <textarea id="lqc-notes" class="lqc-input" placeholder="Optional notes…" rows="3"></textarea>
            </div>

            <div id="lqc-highlight-section" hidden>
              <div class="lqc-highlight-label">&#x2728; Highlight — #highlight tag will be applied</div>
              <div id="lqc-highlight-preview"></div>
            </div>
          </div>

          <!-- Tag Properties panel -->
          <div id="lqc-tags-panel" hidden>
            <div class="lqc-meta">
              <div class="lqc-meta-title" id="lqc-tp-title-display"></div>
              <div class="lqc-meta-url" id="lqc-tp-url-display"></div>
            </div>

            <div class="lqc-field">
              <label for="lqc-tag-select">Tag</label>
              <select id="lqc-tag-select" class="lqc-input">
                <option value="">Select a tag…</option>
              </select>
            </div>

            <div id="lqc-tag-fields"></div>
          </div>

        </div>

        <div id="lqc-footer">
          <div id="lqc-error" hidden></div>
          <button id="lqc-save">Save to Logseq</button>
        </div>

      </div>
    </div>
  `;

  // ─── Modal injection ─────────────────────────────────────────────────────────

  function injectModal() {
    host = document.createElement('div');
    host.id = 'lqc-host';
    host.hidden = true;

    root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    const parser = new DOMParser();
    const doc = parser.parseFromString(HTML, 'text/html');
    doc.body.childNodes.forEach((node) => root.appendChild(document.adoptNode(node)));

    document.documentElement.appendChild(host);
    bindEvents();
  }

  // ─── Event binding ───────────────────────────────────────────────────────────

  function bindEvents() {
    // Close
    $('#lqc-close').addEventListener('click', closeModal);

    // ESC to close (capture phase so page handlers don't fire)
    root.addEventListener('keydown', (e) => {
      e.stopPropagation(); // don't leak keypresses to page
      if (e.key === 'Escape') closeModal();
    }, true);

    // Tab switching
    $$('.lqc-tab').forEach((tab) =>
      tab.addEventListener('click', () => switchMode(tab.dataset.mode))
    );

    // Tag input
    const tagInput = $('#lqc-tag-input');

    tagInput.addEventListener('input', () => {
      saveDraft();
      const val = tagInput.value.trim();
      if (!val) { hideAutocomplete(); return; }
      const matches = allTags.filter(
        (t) => t.toLowerCase().includes(val.toLowerCase()) && !selectedTags.includes(t)
      );
      showAutocomplete(matches);
    });

    tagInput.addEventListener('keydown', (e) => {
      const items = $$('.lqc-ac-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveAutocomplete(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveAutocomplete(-1);
      } else if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        if (autocompleteIndex >= 0 && items[autocompleteIndex]) {
          addTag(items[autocompleteIndex].dataset.tag);
        } else if (tagInput.value.trim()) {
          addTag(tagInput.value);
        }
      } else if (e.key === 'Backspace' && !tagInput.value && selectedTags.length) {
        selectedTags.pop();
        renderChips();
        saveDraft();
      }
    });

    // Focus tag input when clicking chip container
    $('#lqc-tag-chips').addEventListener('click', (e) => {
      if (!e.target.closest('.lqc-chip')) tagInput.focus();
    });

    // Hide autocomplete on outside click
    root.addEventListener('click', (e) => {
      if (!e.target.closest('#lqc-tag-chips') && !e.target.closest('#lqc-autocomplete')) {
        hideAutocomplete();
      }
    });

    // Tag Properties: tag select
    $('#lqc-tag-select').addEventListener('change', (e) => {
      renderTagFields(e.target.value);
      saveDraft();
    });

    // Notes
    $('#lqc-notes').addEventListener('input', saveDraft);

    // Save
    $('#lqc-save').addEventListener('click', handleSave);
  }

  // ─── Message listener ────────────────────────────────────────────────────────

  browser.runtime.onMessage.addListener((message) => {
    if (message.type === 'LQC_OPEN') openModal();
  });

  window.__lqcOpen = openModal;
})();
