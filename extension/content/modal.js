(function () {
  'use strict';

  // Remove any host left by a previous extension context (e.g. after hot-reload)
  // so the new context takes over cleanly. Duplicate injection from the manifest
  // is not possible in MV3, so there's no need for a window-level guard.
  document.getElementById('lqc-host')?.remove();

  // ─── State ──────────────────────────────────────────────────────────────────

  let host = null;
  let root = null;
  let modalVisible = false;
  let currentMode = 'clipper';
  let selectedTags = [];
  let newTags = [];       // subset of selectedTags explicitly created via the Create row
  let allTags = [];
  let tagConfigs = [];
  let capturedTitle = '';
  let capturedUrl = '';
  let capturedHighlight = '';
  let tpTagName = '';         // Tag Properties: the picked tag ('' = none)
  let tagPickIndex = -1;
  let orphanValues = []; // typed Tag Properties values with no field: [{key, name, value}]
  let modeValuesDismissed = false; // notes/highlight notice dismissed for this capture
  let autocompleteIndex = -1;
  let knownGraphs = [];       // Known Graphs: names observed open in Logseq
  let graphSettings = {};     // { [graphName]: { capturePage } }
  let targetGraph = '';       // Web Clipper Target Graph ('' = the open graph, no guard)
  let currentGraphName = '';  // last observed open graph
  let transportInfo = { name: 'http', capabilities: {} };

  // ─── DOM helpers ────────────────────────────────────────────────────────────

  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => root.querySelectorAll(sel);

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

  // ─── Persistence ────────────────────────────────────────────────────────────

  function savePending(state) {
    browser.storage.local.set({ lqcPending: state });
  }

  function clearPending() {
    return browser.storage.local.remove('lqcPending');
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
        graph: targetGraph,
        tags: [...selectedTags],
        newTags: [...newTags],
        notes: $('#lqc-notes')?.value ?? '',
      };
    }
    const tagName = tpTagName;
    const fields = {};
    $$('.lqc-prop-input').forEach((el) => {
      fields[el.dataset.field] = el.type === 'checkbox' ? el.checked
        : el.dataset.multi ? [...(el._lqcValues ?? [])]
        : el.value;
    });
    return {
      mode: 'tags', url: capturedUrl, title: capturedTitle, highlight: capturedHighlight,
      tagName, fields, orphans: orphanValues,
      graph: configFor(tagName)?.graph || targetGraph,
      notes: $('#lqc-notes')?.value ?? '',
      tags: [...selectedTags],
      newTags: [...newTags],
    };
  }

  // A draft is worth keeping only if it holds something the user entered: a
  // tag chip, notes, a picked Tag Properties tag, or a typed value left
  // without a field. An emptied form clears the stored draft, so the
  // "Unsaved capture" bar never appears with nothing to restore.
  function draftHasContent(draft) {
    if (draft.tags?.length || draft.newTags?.length || String(draft.notes ?? '').trim()) return true;
    return draft.mode === 'tags' && Boolean(draft.tagName || draft.orphans?.length);
  }

  function saveDraft() {
    const draft = collectDraft();
    if (draftHasContent(draft)) savePending(draft);
    else clearPending();
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
        newTags = newTags.filter((t) => t !== tag);
        renderChips();
        saveDraft();
      });
      chip.appendChild(btn);
      container.insertBefore(chip, input);
    });
  }

  function addTag(tag, isNew = false) {
    const t = tag.trim().replace(/^#/, '');
    if (t && !selectedTags.includes(t)) {
      selectedTags.push(t);
      renderChips();
    }
    if (isNew && t && !newTags.some((x) => x.toLowerCase() === t.toLowerCase())) newTags.push(t);
    $('#lqc-tag-input').value = '';
    hideAutocomplete();
    saveDraft();
  }

  // ─── Autocomplete ───────────────────────────────────────────────────────────

  function showAutocomplete(matches, query = '') {
    const list = $('#lqc-autocomplete');
    list.innerHTML = '';

    const entries = matches.slice(0, 8).map((tag) => ({ tag, create: false }));

    // New tags are created only via an explicit "Create" row, never implicitly
    const q = query.trim().replace(/^#/, '');
    const exists = allTags.some((t) => t.toLowerCase() === q.toLowerCase());
    const taken = selectedTags.some((t) => t.toLowerCase() === q.toLowerCase());
    if (q && !exists && !taken) entries.push({ tag: q, create: true });

    if (!entries.length) { list.hidden = true; autocompleteIndex = -1; return; }

    entries.forEach(({ tag, create }) => {
      const item = document.createElement('div');
      item.className = create ? 'lqc-ac-item lqc-ac-create' : 'lqc-ac-item';
      item.dataset.tag = tag;
      item.textContent = create ? `Create "#${tag}"` : tag;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault(); // prevent input blur
        addTag(tag, create);
      });
      list.appendChild(item);
    });

    list.hidden = false;
    autocompleteIndex = -1;
  }

  // Resolve typed text the same way the visible list would: exact tag wins,
  // then the first suggestion, then the literal text (create)
  function resolvePendingTag(val) {
    const v = val.trim().replace(/^#/, '');
    const exact = allTags.find((t) => t.toLowerCase() === v.toLowerCase());
    if (exact) return { tag: exact, create: false };
    const match = allTags.find(
      (t) => t.toLowerCase().includes(v.toLowerCase()) && !selectedTags.includes(t)
    );
    if (match) return { tag: match, create: false };
    // Literal text counts as an explicit create only when the tag list actually
    // loaded — with no list, "no match" doesn't mean the user saw a Create row
    return { tag: v, create: allTags.length > 0 };
  }

  function hideAutocomplete() {
    const list = $('#lqc-autocomplete');
    if (list) list.hidden = true;
    autocompleteIndex = -1;
  }

  function moveAutocomplete(dir) {
    const items = $('#lqc-autocomplete').querySelectorAll('.lqc-ac-item');
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
    renderOrphanNote();
  }

  // ─── Tag Properties tag picker ───────────────────────────────────────────────
  // Any tag in the Target Graph can be picked; its fields come from a live
  // schema read. Tag configs saved in settings are pinned first, and are the
  // only choices without the CLI transport (no schema read to render from).

  const sameTag = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const configFor = (tagName) => (tagName ? tagConfigs.find((c) => sameTag(c.tagName, tagName)) : undefined);
  // The graph the mode works against; '' while following an open graph not yet observed
  const effectiveGraph = () => targetGraph || currentGraphName;

  function tagPickEntries(query) {
    const q = query.trim().toLowerCase();
    const pinned = tagConfigs.filter((c) => !c.adhoc)
      .map((c) => ({ name: c.tagName, graph: c.graph ?? '', pinned: true }));
    const rest = transportInfo.capabilities?.readSchemas
      ? allTags.filter((t) => !pinned.some((p) => sameTag(p.name, t))).map((t) => ({ name: t }))
      : [];
    return [...pinned, ...rest].filter((e) => !q || e.name.toLowerCase().includes(q));
  }

  function hideTagPickList() {
    const list = $('#lqc-tag-pick-ac');
    if (list) list.hidden = true;
    tagPickIndex = -1;
  }

  function showTagPickList() {
    const input = $('#lqc-tag-pick');
    const list = $('#lqc-tag-pick-ac');
    list.textContent = '';
    // With the picked tag still in the box, offer the whole list, not a filter on itself
    const query = sameTag(input.value.trim(), tpTagName) ? '' : input.value;
    const entries = tagPickEntries(query).slice(0, 8);
    if (!entries.length) { hideTagPickList(); return; }

    entries.forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'lqc-ac-item';
      item.dataset.tag = entry.name;
      item.textContent = `${entry.pinned ? '★ ' : ''}#${entry.name}`;
      if (entry.pinned && entry.graph) {
        const graph = document.createElement('span');
        graph.className = 'lqc-ac-graph';
        graph.textContent = entry.graph;
        item.appendChild(graph);
      }
      item.addEventListener('mousedown', (e) => {
        e.preventDefault(); // prevent input blur
        pickTag(entry.name);
      });
      list.appendChild(item);
    });
    list.hidden = false;
    tagPickIndex = -1;
    list.scrollIntoView?.({ block: 'nearest' }); // the body scrolls; don't leave the list clipped
  }

  function pickTag(name) {
    let cfg = configFor(name);
    if (name && !cfg) {
      cfg = { tagName: name, graph: effectiveGraph(), fields: [], adhoc: true };
      tagConfigs.push(cfg);
    } else if (cfg?.adhoc && effectiveGraph() && cfg.graph !== effectiveGraph()) {
      // Remembered from another graph — those fields don't apply here
      cfg.graph = effectiveGraph();
      cfg.fields = [];
    } else if (cfg && !cfg.adhoc && cfg.graph && cfg.graph !== targetGraph && knownGraphs.includes(cfg.graph)) {
      setTargetGraph(cfg.graph); // a pinned tag brings its own graph
    }
    tpTagName = cfg?.tagName ?? '';
    $('#lqc-tag-pick').value = tpTagName;
    hideTagPickList();
    renderTagFields(tpTagName);
    loadTagSchema(tpTagName);
    saveDraft();
  }

  // Settle whatever is typed in the box: an exact tag name is picked, an
  // empty box clears the pick, a partial search reverts to the current pick
  function resolveTagPick() {
    const input = $('#lqc-tag-pick');
    const text = input.value.trim();
    if (sameTag(text, tpTagName)) { input.value = tpTagName; return; }
    if (!text) { pickTag(''); return; }
    const hit = tagPickEntries('').find((e) => sameTag(e.name, text));
    if (hit) pickTag(hit.name);
    else input.value = tpTagName;
  }

  // ─── Node property field widget ──────────────────────────────────────────────
  // Autocomplete over the graph's existing values for a node property (values
  // in use + members of the property's constraint class), with an explicit
  // Create row for new values — same interaction model as the tags field.
  // Cardinality-many properties get chips; single-value ones a plain input.

  // A field's identity is its property ident when a live schema read supplied
  // one; titles are display only and can collide (URL vs url). Hand-typed
  // static configs have just the name.
  const fieldKey = (field) => field.ident ?? field.name;

  // Suggestions are {id, title}; configs stored before idents hold bare titles
  const suggestionTitle = (s) => (typeof s === 'string' ? s : s.title);

  function makeNodeField(field) {
    const multi = field.cardinality === 'many';
    const titles = () => [...new Set((field.suggestions ?? []).map(suggestionTitle))];
    const wrap = document.createElement('div');
    wrap.className = 'lqc-node-wrap';

    const box = document.createElement('div');
    box.className = 'lqc-node-box';
    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.className = 'lqc-node-input';
    if (multi) {
      input.placeholder = 'Add values…';
      input.dataset.multi = '1';
      input._lqcValues = [];
    }
    box.appendChild(input);

    const list = document.createElement('div');
    list.className = 'lqc-node-ac';
    list.hidden = true;

    wrap.appendChild(box);
    wrap.appendChild(list);

    let acIndex = -1;

    function renderNodeChips() {
      box.querySelectorAll('.lqc-chip').forEach((c) => c.remove());
      input._lqcValues.forEach((val) => {
        const chip = document.createElement('span');
        chip.className = 'lqc-chip';
        chip.textContent = val;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lqc-chip-remove';
        btn.setAttribute('aria-label', `Remove ${val}`);
        btn.textContent = '×';
        btn.addEventListener('click', () => {
          input._lqcValues = input._lqcValues.filter((v) => v !== val);
          renderNodeChips();
          saveDraft();
        });
        chip.appendChild(btn);
        box.insertBefore(chip, input);
      });
    }
    if (multi) input._lqcRenderChips = renderNodeChips;

    function hideList() {
      list.hidden = true;
      acIndex = -1;
    }

    function commit(val) {
      const v = val.trim();
      if (!v) return;
      if (multi) {
        if (!input._lqcValues.includes(v)) {
          input._lqcValues.push(v);
          renderNodeChips();
        }
        input.value = '';
      } else {
        input.value = v;
      }
      hideList();
      saveDraft();
    }

    function showList() {
      const q = input.value.trim();
      list.innerHTML = '';
      const taken = multi ? input._lqcValues : [];
      const pool = titles().filter((s) => !taken.includes(s));
      const matches = q
        ? pool.filter((s) => s.toLowerCase().includes(q.toLowerCase()))
        : pool;
      const entries = matches.slice(0, 8).map((s) => ({ val: s, create: false }));
      const exists = titles().some((s) => s.toLowerCase() === q.toLowerCase());
      if (q && !exists && !taken.includes(q)) entries.push({ val: q, create: true });
      if (!entries.length) { hideList(); return; }

      entries.forEach(({ val, create }) => {
        const item = document.createElement('div');
        item.className = create ? 'lqc-ac-item lqc-ac-create' : 'lqc-ac-item';
        item.dataset.val = val;
        item.textContent = create ? `Create "${val}"` : val;
        item.addEventListener('mousedown', (e) => {
          e.preventDefault(); // prevent input blur
          commit(val);
        });
        list.appendChild(item);
      });
      list.hidden = false;
      acIndex = -1;
      list.scrollIntoView?.({ block: 'nearest' }); // the body scrolls; don't leave the list clipped
    }

    input.addEventListener('focus', showList);
    input.addEventListener('input', showList);
    input.addEventListener('blur', () => setTimeout(hideList, 150));
    input.addEventListener('keydown', (e) => {
      const items = list.hidden ? [] : Array.from(list.querySelectorAll('.lqc-ac-item'));
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        acIndex = Math.min(acIndex + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle('lqc-ac-active', i === acIndex));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        acIndex = Math.max(acIndex - 1, -1);
        items.forEach((el, i) => el.classList.toggle('lqc-ac-active', i === acIndex));
      } else if (e.key === 'Enter' || (multi && e.key === ',')) {
        e.preventDefault();
        if (acIndex >= 0 && items[acIndex]) commit(items[acIndex].dataset.val);
        else if (items.length) commit(items[0].dataset.val); // default to first suggestion
        else if (input.value.trim()) commit(input.value);
      } else if (multi && e.key === 'Backspace' && !input.value && input._lqcValues.length) {
        input._lqcValues.pop();
        renderNodeChips();
        saveDraft();
      } else if (e.key === 'Escape' && !list.hidden) {
        e.stopPropagation(); // close the list, not the modal
        hideList();
      }
    });

    return { wrap, input };
  }

  // ─── Typed values that lost their field ─────────────────────────────────────
  // A value can end up with no field to live in: the tag was switched, the
  // live schema changed under it, or a restored draft names a property the
  // tag no longer shows. Such values are kept and shown so they can be
  // hand-copied — the modal never drops typed input without saying so.

  const hasValue = (v) => (Array.isArray(v) ? v.length > 0 : v !== '' && v !== false && v != null);

  function snapshotFieldValues() {
    return Array.from($$('.lqc-prop-input'))
      .map((el) => ({
        key: el.dataset.field,
        name: el._lqcField?.name ?? el.dataset.field,
        value: el.type === 'checkbox' ? el.checked
          : el.dataset.multi ? [...(el._lqcValues ?? [])]
          : el.value,
        // the auto-filled clip URL is not typed input
        auto: el.dataset.type === 'url' && el.value === capturedUrl,
      }))
      .filter((v) => !v.auto && hasValue(v.value))
      .map(({ auto, ...v }) => v);
  }

  // Puts each value into the rendered field with the same key (or the same
  // name, for values recorded before fields carried idents). Returns the
  // values no field accepted.
  function applyFieldValues(entries) {
    const inputs = Array.from($$('.lqc-prop-input'));
    const latest = new Map();
    entries.forEach((e) => { if (hasValue(e.value)) latest.set(e.key, e); });
    const unplaced = [];
    latest.forEach((entry) => {
      const el = inputs.find((i) => i.dataset.field === entry.key)
        ?? inputs.find((i) => i._lqcField?.name === entry.key);
      const val = entry.value;
      if (!el) { unplaced.push(entry); return; }
      if (el.type === 'checkbox') { el.checked = Boolean(val); return; }
      if (el.dataset.multi) {
        el._lqcValues = [].concat(val).map(String);
        el._lqcRenderChips?.();
        return;
      }
      const text = Array.isArray(val) ? val.join(', ') : String(val);
      el.value = text;
      // a dropdown or number/date input silently refuses a value it can't hold
      if (el.value !== text) { el.value = ''; unplaced.push(entry); }
    });
    return unplaced;
  }

  // Tag Properties mode writes only its one tag and that tag's fields (spec),
  // so tags and notes entered in Web Clipper and text selected on the page
  // count as unsaved here too.
  function unsavedModeValues() {
    if (currentMode !== 'tags' || modeValuesDismissed) return [];
    const out = [];
    const notes = $('#lqc-notes')?.value.trim();
    if (selectedTags.length) out.push({ key: 'tags', name: 'Tags', value: [...selectedTags] });
    if (notes) out.push({ key: 'notes', name: 'Notes', value: notes });
    if (capturedHighlight) out.push({ key: 'highlight', name: 'Highlight', value: capturedHighlight });
    return out;
  }

  function renderOrphanNote() {
    const container = $('#lqc-tag-fields');
    if (!container) return;
    container.querySelector('.lqc-orphan-note')?.remove();
    const unsaved = [...orphanValues, ...unsavedModeValues()];
    if (!unsaved.length) return;

    const note = document.createElement('div');
    note.className = 'lqc-orphan-note';
    const lead = document.createElement('div');
    lead.textContent = unsaved.length === 1
      ? "This value isn't part of a visible property and won't be saved. Hand-copy it to save in a different field or note:"
      : "These values aren't part of a visible property and won't be saved. Hand-copy them to save in a different field or note:";
    note.appendChild(lead);
    unsaved.forEach(({ key, name, value }) => {
      const line = document.createElement('div');
      line.className = 'lqc-orphan-value';
      const label = name ?? String(key).replace(/^.*\//, '');
      const shown = value === true ? 'checked' : [].concat(value).join(', ');
      line.textContent = `${label}: ${shown}`;
      note.appendChild(line);
    });
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'lqc-orphan-dismiss';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => {
      orphanValues = [];
      modeValuesDismissed = true;
      renderOrphanNote();
      saveDraft();
    });
    note.appendChild(dismiss);
    container.appendChild(note);
  }

  // ─── Tag Properties field rendering ─────────────────────────────────────────

  function renderTagFields(tagName) {
    const config = tagConfigs.find((c) => c.tagName === tagName);
    const container = $('#lqc-tag-fields');
    // Whatever is typed survives the re-render: values go back into the field
    // with the same key, and the rest are shown as orphans, never dropped
    const carried = [...orphanValues, ...snapshotFieldValues()];
    container.innerHTML = '';
    if (!config?.fields?.length) {
      orphanValues = carried;
      renderOrphanNote();
      return;
    }

    config.fields.forEach((field) => {
      const row = document.createElement('div');
      row.className = 'lqc-field';

      const label = document.createElement('label');
      label.textContent = field.name;
      label.htmlFor = `lqc-prop-${fieldKey(field)}`;

      let input;
      let mount = null; // widget fields append a wrapper, not the input itself
      if (field.choices?.length) {
        // Choices property: only the predefined values are valid — free text
        // would fail Logseq's closed-value validation at save time
        input = document.createElement('select');
        input.className = 'lqc-input';
        const none = document.createElement('option');
        none.value = '';
        none.textContent = '(none)';
        input.appendChild(none);
        field.choices.forEach((choice) => {
          const opt = document.createElement('option');
          opt.value = choice;
          opt.textContent = choice;
          input.appendChild(opt);
        });
      } else if (field.type === 'node' && (field.ident || Array.isArray(field.suggestions))) {
        const widget = makeNodeField(field);
        input = widget.input;
        mount = widget.wrap;
      } else if (field.type === 'checkbox') {
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

      // Auto-fill the clip URL into url-typed fields (visible and editable);
      // when saved with a value there, the block text becomes the plain title
      if (field.type === 'url' && capturedUrl) input.value = capturedUrl;

      input.id = `lqc-prop-${fieldKey(field)}`;
      input.className = (input.className || '') + ' lqc-prop-input';
      input.dataset.field = fieldKey(field);
      input._lqcField = field;
      input.dataset.type = field.type;
      input.addEventListener('input', saveDraft);
      input.addEventListener('change', saveDraft);

      row.appendChild(label);
      row.appendChild(mount ?? input);
      container.appendChild(row);
    });

    orphanValues = applyFieldValues(carried);
    renderOrphanNote();
  }

  // ─── Live tag schema (CLI transport) ─────────────────────────────────────────

  // The graph's own schema is the source of truth: refresh the config from
  // the tag's Target Graph, cache it, and re-render only if it changed.
  // Suggestion lists can be large and drift constantly, so they live in
  // storage.local; storage.sync (8 KB per item) keeps only the schema itself.
  const suggestionCacheKey = (cfg) => `${cfg.graph ?? ''}\n${cfg.tagName}`;

  function persistTagConfigs() {
    const tagSuggestions = {};
    const slim = tagConfigs.map((cfg) => ({
      ...cfg,
      fields: (cfg.fields ?? []).map(({ suggestions, ...rest }) => {
        if (Array.isArray(suggestions)) {
          (tagSuggestions[suggestionCacheKey(cfg)] ??= {})[fieldKey(rest)] = suggestions;
        }
        return rest;
      }),
    }));
    // Tags picked without a settings entry are remembered locally (offline
    // fields, draft restore) — settings keeps only the configs saved there
    browser.storage.sync.set({ tagConfigs: slim.filter((c) => !c.adhoc) }).catch(() => {});
    browser.storage.local.set({
      tagSuggestions,
      recentTagConfigs: slim.filter((c) => c.adhoc && c.fields.length).slice(-30),
    }).catch(() => {});
  }

  function applyCachedSuggestions(tagSuggestions) {
    tagConfigs.forEach((cfg) => {
      const cached = tagSuggestions?.[suggestionCacheKey(cfg)];
      if (!cached) return;
      (cfg.fields ?? []).forEach((f) => {
        if (!Array.isArray(f.suggestions) && cached[fieldKey(f)]) f.suggestions = cached[fieldKey(f)];
      });
    });
  }

  // Says where the shown fields came from. A failed or unavailable schema
  // read used to leave saved (or no) fields with no explanation, which made
  // a working feature look missing.
  function setTagStatus(text, kind = 'warn') {
    const el = $('#lqc-tag-status');
    if (!el) return;
    el.textContent = text;
    el.className = `lqc-tag-status lqc-tag-status-${kind}`;
    el.hidden = !text;
  }

  async function loadTagSchema(tagName) {
    if (!tagName) { setTagStatus(''); return; }
    const idx = tagConfigs.findIndex((c) => c.tagName === tagName);
    const cfg = tagConfigs[idx];
    if (!cfg) { setTagStatus(''); return; }
    // The fallback message depends on whether there is anything saved to show
    const fallback = (why) => {
      if (tpTagName !== tagName) return;
      setTagStatus(cfg.fields?.length
        ? `Using saved fields — ${why}.`
        : `No fields to show — ${why}.`);
    };

    if (!transportInfo.capabilities?.readSchemas) {
      fallback(transportInfo.reason || 'CLI integration is not enabled');
      return;
    }
    const graph = cfg.graph || effectiveGraph();
    if (!graph) {
      fallback('no graph is selected and the open graph is not known yet');
      return;
    }
    if (cfg.adhoc) cfg.graph = graph;
    setTagStatus('Reading fields from Logseq…', 'live');

    try {
      const resp = await browser.runtime.sendMessage({
        type: 'LQC_OP', op: 'getTagSchema', graph, tag: tagName,
      });
      if (!resp?.ok || !Array.isArray(resp.result)) {
        fallback(`the read from Logseq failed: ${resp?.error ?? 'no response'}`);
        return;
      }
      if (!resp.result.length) {
        fallback(`#${tagName} has no properties in Logseq (${graph})`);
        return;
      }
      if (tpTagName === tagName) setTagStatus(`Fields read from Logseq (${graph}).`, 'live');

      // Re-render only on structural change (fields/types/choices) — node
      // suggestion lists drift constantly and a re-render wipes typed values
      const structure = (fields) => JSON.stringify(
        (fields ?? []).map(({ suggestions, ...rest }) => rest)
      );
      const changed = structure(resp.result) !== structure(cfg.fields);
      if (changed) {
        tagConfigs[idx] = { ...cfg, fields: resp.result, liveRead: true };
      } else {
        // Same structure, same order: refresh suggestions on the field objects
        // the rendered widgets already hold
        cfg.fields.forEach((f, i) => { f.suggestions = resp.result[i].suggestions; });
        tagConfigs[idx] = { ...cfg, liveRead: true };
      }
      persistTagConfigs();
      if (changed && tpTagName === tagName) renderTagFields(tagName);
    } catch (err) {
      fallback(`the read from Logseq failed: ${err.message}`); // cached fields remain
    }
  }

  // ─── Restore a pending draft ─────────────────────────────────────────────────

  // A draft belongs to the page it was captured on. Restoring it must bring
  // that page's url/title/highlight back too, or Page A's notes and tags
  // would be saved under Page B's URL.
  function applyDraftPage(draft) {
    if (typeof draft.url === 'string') capturedUrl = draft.url;
    if (typeof draft.title === 'string') capturedTitle = draft.title;
    capturedHighlight = typeof draft.highlight === 'string' ? draft.highlight : '';
    renderPageMeta();
  }

  function restoreDraft(draft) {
    if (!draft) return;
    applyDraftPage(draft);

    if (draft.mode === 'clipper') {
      switchMode('clipper');
      selectedTags = draft.tags ?? [];
      newTags = draft.newTags ?? [];
      renderChips();
      if ($('#lqc-notes')) $('#lqc-notes').value = draft.notes ?? '';
      if (typeof draft.graph === 'string') {
        targetGraph = draft.graph;
        populateGraphSelect();
        loadTagsFromCache();
      }
    } else {
      if ($('#lqc-notes')) $('#lqc-notes').value = draft.notes ?? '';
      selectedTags = draft.tags ?? [];
      newTags = draft.newTags ?? [];
      renderChips();
      switchMode('tags');
      if (draft.graph && draft.graph !== targetGraph && knownGraphs.includes(draft.graph)) {
        targetGraph = draft.graph;
        populateGraphSelect();
        loadTagsFromCache();
      }
      if (draft.tagName) {
        // A tag picked without a settings entry may have no remembered config
        if (!configFor(draft.tagName)) {
          tagConfigs.push({
            tagName: draft.tagName, graph: draft.graph || effectiveGraph(), fields: [], adhoc: true,
          });
        }
        tpTagName = configFor(draft.tagName).tagName;
        $('#lqc-tag-pick').value = tpTagName;
        orphanValues = [];
        renderTagFields(tpTagName);
        loadTagSchema(tpTagName);
        // field values need to wait for DOM to settle
        setTimeout(() => {
          const entries = [
            ...(Array.isArray(draft.orphans) ? draft.orphans : []),
            ...Object.entries(draft.fields ?? {}).map(([key, value]) => ({ key, value })),
          ];
          orphanValues = [...orphanValues, ...applyFieldValues(entries)];
          renderOrphanNote();
        }, 0);
      }
    }
  }

  // ─── Save ────────────────────────────────────────────────────────────────────
  // Save composition (guard, routing, target page, tag/property resolution)
  // lives in the background behind the transport seam — the modal only
  // collects the payload and renders the outcome.

  function buildSavePayload() {
    if (currentMode === 'clipper') {
      return {
        mode: 'clipper',
        graph: targetGraph,
        title: capturedTitle,
        url: capturedUrl,
        tags: [...selectedTags],
        newTags: [...newTags],
        notes: $('#lqc-notes').value.trim(),
        highlight: capturedHighlight,
      };
    }

    const tagName = tpTagName;
    if (!tagName) throw new Error('Please pick a tag.');
    const cfg = configFor(tagName);
    const fields = Array.from($$('.lqc-prop-input')).map((el) => {
      const def = el._lqcField ?? {};
      const field = {
        name: def.name ?? el.dataset.field,
        type: el.dataset.type,
        value: el.type === 'checkbox' ? el.checked
          // Multi-value chips, plus any text still in the input (commit on save)
          : el.dataset.multi ? [...(el._lqcValues ?? []), ...(el.value.trim() ? [el.value.trim()] : [])]
          : el.value,
      };
      if (def.ident) field.ident = def.ident;
      // Picked node suggestions travel with their db id so the save links
      // that exact node; a title with no id is an explicit Create
      if (def.type === 'node') {
        const ids = {};
        const picked = [].concat(field.value).map((v) => String(v).trim());
        (def.suggestions ?? []).forEach((s) => {
          if (typeof s === 'object' && picked.includes(s.title) && !(s.title in ids)) ids[s.title] = s.id;
        });
        if (Object.keys(ids).length) field.ids = ids;
      }
      return field;
    });
    return {
      mode: 'tags',
      graph: cfg?.graph || targetGraph,
      title: capturedTitle,
      url: capturedUrl,
      tagName,
      fields,
    };
  }

  async function handleSave() {
    const btn = $('#lqc-save');
    const errEl = $('#lqc-error');

    // Commit any tag text still in the input (user typed a tag but didn't press Enter)
    const pendingTag = $('#lqc-tag-input')?.value.trim();
    if (pendingTag) {
      const { tag, create } = resolvePendingTag(pendingTag);
      addTag(tag, create);
    }

    if (currentMode === 'tags') resolveTagPick();

    btn.disabled = true;
    btn.textContent = 'Saving…';
    errEl.hidden = true;

    try {
      const payload = buildSavePayload();
      const resp = await browser.runtime.sendMessage({ type: 'LQC_SAVE', payload });
      if (!resp?.ok) throw new Error(resp?.error ?? 'Save failed — no response from background.');
      clearPending();
      closeModal();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Retry';
      // The likeliest guard failure ends with the user switching graphs —
      // refresh so Retry-time autocomplete reflects the target graph
      refreshTagCache();
    }
  }

  // ─── Open / close ────────────────────────────────────────────────────────────

  async function openModal() {
    if (modalVisible) return;

    // Prefer the page's own metadata title (og:title) — usually cleaner than
    // document.title, which sites often suffix with the site name
    capturedTitle = document.querySelector('meta[property="og:title"]')?.content?.trim()
      || document.title;
    capturedUrl = location.href;
    capturedHighlight = window.getSelection()?.toString().trim() ?? '';

    const settings = await browser.storage.sync.get({
      tagConfigs: [],
      graphSettings: {},
      webClipperTargetGraph: '',
    });
    tagConfigs = settings.tagConfigs ?? [];
    try {
      const { tagSuggestions, recentTagConfigs } = await browser.storage.local.get({
        tagSuggestions: {}, recentTagConfigs: [],
      });
      recentTagConfigs.forEach((c) => {
        if (c?.tagName && !configFor(c.tagName)) tagConfigs.push({ ...c, adhoc: true });
      });
      applyCachedSuggestions(tagSuggestions);
    } catch { /* suggestions arrive with the live schema read */ }
    graphSettings = settings.graphSettings ?? {};
    knownGraphs = Object.keys(graphSettings);
    targetGraph = settings.webClipperTargetGraph;

    try {
      transportInfo = await browser.runtime.sendMessage({ type: 'LQC_TRANSPORT_INFO' }) ?? transportInfo;
    } catch { /* keep defaults */ }

    // CLI transport: the graph list is live, not accumulated
    if (transportInfo.capabilities?.listGraphs) {
      try {
        const resp = await browser.runtime.sendMessage({ type: 'LQC_OP', op: 'listGraphs' });
        if (resp?.ok && Array.isArray(resp.result) && resp.result.length) {
          knownGraphs = resp.result;
        }
      } catch { /* stored Known Graphs remain */ }
    }

    if (!host) injectModal();

    populateGraphSelect();

    // Reset to clean state
    selectedTags = [];
    newTags = [];
    switchMode('clipper');
    await loadTagsFromCache();
    renderChips();
    $('#lqc-notes').value = '';
    $('#lqc-error').hidden = true;
    resetSaveButton();

    renderPageMeta();

    // Tag Properties: nothing picked yet
    tpTagName = '';
    $('#lqc-tag-pick').value = '';
    setTagStatus('');
    hideTagPickList();
    $('#lqc-tag-fields').innerHTML = '';
    orphanValues = [];
    modeValuesDismissed = false;

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
      notice.querySelector('#lqc-pending-discard').onclick = async () => {
        await clearPending();
        notice.querySelector('.lqc-pending-text').textContent = '';
        notice.hidden = true;
      };
    } else {
      notice.hidden = true;
    }

    // Show modal
    host.hidden = false;
    modalVisible = true;

    // Observe the open graph + refresh its tag cache (best-effort, non-blocking)
    refreshTagCache();

    setTimeout(() => $('#lqc-tag-input')?.focus(), 50);
  }

  function renderPageMeta() {
    $('#lqc-title-display').textContent = capturedTitle;
    $('#lqc-url-display').textContent = capturedUrl;
    $('#lqc-tp-title-display').textContent = capturedTitle;
    $('#lqc-tp-url-display').textContent = capturedUrl;

    if (capturedHighlight) {
      $('#lqc-highlight-section').hidden = false;
      const preview = capturedHighlight.length > 200
        ? capturedHighlight.slice(0, 200) + '…'
        : capturedHighlight;
      $('#lqc-highlight-preview').textContent = preview;
    } else {
      $('#lqc-highlight-section').hidden = true;
    }
    renderOrphanNote();
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

  // ─── Target Graph / Tag Cache ────────────────────────────────────────────────

  // The graph the current capture is aimed at ('' = follow the open graph)
  // Both modes share one Target Graph selection
  function currentTargetGraph() {
    return targetGraph;
  }

  function populateGraphSelect() {
    ['#lqc-graph-select', '#lqc-tp-graph-select'].forEach((id) => {
      const sel = $(id);
      sel.innerHTML = '<option value="">(the open graph)</option>';
      knownGraphs.forEach((name) => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
      });
      sel.value = knownGraphs.includes(targetGraph) ? targetGraph : '';
    });
  }

  // The selection persists until changed
  async function setTargetGraph(value) {
    targetGraph = value;
    browser.storage.sync.set({ webClipperTargetGraph: targetGraph }).catch(() => {});
    populateGraphSelect();
    allTags = [];
    hideAutocomplete();
    await loadTagsFromCache();
    refreshTagCache();
  }

  // Autocomplete reads the Target Graph's cached tags, never the open graph's
  async function loadTagsFromCache() {
    const target = currentTargetGraph();
    if (!target) return; // following the open graph — refreshTagCache fills allTags
    const { tagCache } = await browser.storage.local.get({ tagCache: {} });
    allTags = tagCache[target] ?? [];
  }

  // Refresh tags for autocomplete. CLI transport: read the Target Graph's
  // tags directly, whatever the app has open. HTTP: fetch the OPEN graph's
  // tags and cache them under its name; adopt them only when the open graph
  // is (or acts as) the Target Graph.
  async function refreshTagCache() {
    const target = currentTargetGraph();
    if (target && transportInfo.capabilities?.readSchemas) {
      try {
        const resp = await browser.runtime.sendMessage({ type: 'LQC_OP', op: 'getTags', graph: target });
        if (resp?.ok && Array.isArray(resp.result)) {
          allTags = resp.result;
          const { tagCache } = await browser.storage.local.get({ tagCache: {} });
          tagCache[target] = allTags;
          await browser.storage.local.set({ tagCache });
          return;
        }
      } catch { /* fall through to the HTTP flow */ }
    }

    try {
      const cur = await apiCall('logseq.App.getCurrentGraph', []);
      currentGraphName = cur?.name ?? cur?.['graph/name'] ?? '';
      if (currentGraphName && !knownGraphs.includes(currentGraphName)) {
        knownGraphs.push(currentGraphName);
        populateGraphSelect();
      }

      const result = await apiCall('logseq.Editor.getAllTags', []);
      const tags = Array.isArray(result)
        ? result
            .map((t) => (typeof t === 'string' ? t : t['original-name'] ?? t.name ?? ''))
            .filter(Boolean)
        : [];

      if (currentGraphName) {
        const { tagCache } = await browser.storage.local.get({ tagCache: {} });
        tagCache[currentGraphName] = tags;
        await browser.storage.local.set({ tagCache });
      }

      const target = currentTargetGraph();
      if (!target || target === currentGraphName) allTags = tags;
    } catch { /* autocomplete falls back to whatever the cache had */ }
  }

  // ─── CSS ─────────────────────────────────────────────────────────────────────

  const CSS = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    /* Author display:flex on a section would otherwise beat the hidden
       attribute, leaving e.g. the pending notice on screen after Discard. */
    [hidden] { display: none !important; }

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

    #lqc-settings {
      margin-left: auto;
      background: none;
      border: none;
      cursor: pointer;
      font-size: 16px;
      color: #9ca3af;
      line-height: 1;
      padding: 4px 6px;
      border-radius: 4px;
      align-self: center;
      font-family: inherit;
    }
    #lqc-settings:hover { color: #111827; background: #f3f4f6; }

    #lqc-close {
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
    .lqc-orphan-note {
      margin-top: 8px;
      padding: 8px 10px;
      font-size: 12px;
      color: #92400e;
      background: #fffbeb;
      border: 1px solid #fcd34d;
      border-radius: 6px;
      user-select: text;
      max-height: 180px;
      overflow-y: auto;
    }
    .lqc-orphan-value { margin-top: 4px; font-weight: 600; overflow-wrap: anywhere; }
    .lqc-orphan-dismiss {
      margin-top: 6px;
      padding: 2px 8px;
      font-size: 12px;
      color: #92400e;
      background: none;
      border: 1px solid #fcd34d;
      border-radius: 4px;
      cursor: pointer;
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
    .lqc-ac-create {
      font-style: italic;
      color: #6b7280;
      border-top: 1px solid #e5e7eb;
    }

    /* ── Node property fields ── */
    /* Tag Properties starts with only a Graph and a Tag box; without a floor
       the modal is too short to show the tag list that opens under the box */
    #lqc-tags-panel { min-height: 400px; }

    .lqc-node-wrap { position: relative; }
    .lqc-ac-graph { margin-left: 8px; font-size: 11px; color: #9ca3af; }
    .lqc-tag-status { margin-top: 4px; font-size: 11px; }
    .lqc-tag-status-live { color: #6b7280; }
    .lqc-tag-status-warn { color: #92400e; }
    .lqc-node-box {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      align-items: center;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      padding: 6px 8px;
      background: #fff;
      cursor: text;
    }
    .lqc-node-box:focus-within {
      border-color: #4f46e5;
      box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.12);
    }
    .lqc-node-input {
      border: none;
      outline: none;
      flex: 1;
      min-width: 80px;
      font-size: 13px;
      background: transparent;
      color: #111827;
    }
    .lqc-node-ac {
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
          <button id="lqc-settings" aria-label="Settings" title="Settings">&#9881;</button>
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

            <div class="lqc-field">
              <label for="lqc-graph-select">Graph</label>
              <select id="lqc-graph-select" class="lqc-input">
                <option value="">(the open graph)</option>
              </select>
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
              <label for="lqc-tp-graph-select">Graph</label>
              <select id="lqc-tp-graph-select" class="lqc-input">
                <option value="">(the open graph)</option>
              </select>
            </div>

            <div class="lqc-field">
              <label for="lqc-tag-pick">Tag</label>
              <div class="lqc-node-wrap">
                <div class="lqc-node-box">
                  <input id="lqc-tag-pick" class="lqc-node-input" type="text" placeholder="Type a tag…"
                         autocomplete="off" spellcheck="false">
                </div>
                <div id="lqc-tag-pick-ac" class="lqc-node-ac" hidden></div>
              </div>
              <div id="lqc-tag-status" class="lqc-tag-status" hidden></div>
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

    // Settings — open options page in a new tab via background
    $('#lqc-settings').addEventListener('click', () => {
      browser.runtime.sendMessage({ type: 'LQC_OPEN_OPTIONS' });
      closeModal();
    });

    // ESC to close. Bubble phase: capture-phase stopPropagation on the shadow
    // root would kill the event before it reaches the inputs' own handlers.
    root.addEventListener('keydown', (e) => {
      e.stopPropagation(); // don't leak keypresses to page
      if (e.key === 'Escape') closeModal();
    }, false);

    // Tab switching
    $$('.lqc-tab').forEach((tab) =>
      tab.addEventListener('click', () => switchMode(tab.dataset.mode))
    );

    // Target Graph selectors — one shared selection, shown in both modes
    $('#lqc-graph-select').addEventListener('change', async (e) => {
      await setTargetGraph(e.target.value);
      saveDraft();
    });
    $('#lqc-tp-graph-select').addEventListener('change', async (e) => {
      await setTargetGraph(e.target.value);
      // The picked tag belongs to the previous graph; typed values move to
      // the unsaved-values note until a tag here takes them
      if (tpTagName) pickTag('');
      saveDraft();
    });

    // Tag input
    const tagInput = $('#lqc-tag-input');

    tagInput.addEventListener('input', () => {
      saveDraft();
      const val = tagInput.value.trim();
      if (!val) { hideAutocomplete(); return; }
      const matches = allTags.filter(
        (t) => t.toLowerCase().includes(val.toLowerCase()) && !selectedTags.includes(t)
      );
      showAutocomplete(matches, val);
    });

    tagInput.addEventListener('keydown', (e) => {
      const list = $('#lqc-autocomplete');
      const items = list.hidden ? [] : list.querySelectorAll('.lqc-ac-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveAutocomplete(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveAutocomplete(-1);
      } else if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        if (autocompleteIndex >= 0 && items[autocompleteIndex]) {
          const item = items[autocompleteIndex];
          addTag(item.dataset.tag, item.classList.contains('lqc-ac-create'));
        } else if (items.length) {
          const item = items[0]; // default to first suggestion
          addTag(item.dataset.tag, item.classList.contains('lqc-ac-create'));
        } else if (tagInput.value.trim()) {
          const { tag, create } = resolvePendingTag(tagInput.value); // list dismissed — same resolution
          addTag(tag, create);
        }
      } else if (e.key === 'Backspace' && !tagInput.value && selectedTags.length) {
        const removed = selectedTags.pop();
        newTags = newTags.filter((t) => t !== removed);
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

    // Tag Properties: tag picker
    const tagPick = $('#lqc-tag-pick');
    tagPick.addEventListener('focus', () => { tagPick.select(); showTagPickList(); });
    tagPick.addEventListener('input', showTagPickList);
    tagPick.addEventListener('blur', () => setTimeout(() => {
      hideTagPickList();
      if (modalVisible) resolveTagPick();
    }, 150));
    tagPick.addEventListener('keydown', (e) => {
      const list = $('#lqc-tag-pick-ac');
      const items = list.hidden ? [] : Array.from(list.querySelectorAll('.lqc-ac-item'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        tagPickIndex = e.key === 'ArrowDown'
          ? Math.min(tagPickIndex + 1, items.length - 1)
          : Math.max(tagPickIndex - 1, -1);
        items.forEach((el, i) => el.classList.toggle('lqc-ac-active', i === tagPickIndex));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = items[tagPickIndex] ?? items[0]; // default to first suggestion
        if (item) pickTag(item.dataset.tag);
        else resolveTagPick();
      } else if (e.key === 'Escape' && !list.hidden) {
        e.stopPropagation(); // close the list, not the modal
        hideTagPickList();
      }
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
