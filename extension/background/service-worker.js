// Route keyboard command and toolbar click to the active tab's content script
browser.commands.onCommand.addListener(async (command) => {
  if (command !== 'open-modal') return;
  let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) await openInTab(tab.id);
});

// onClicked receives the tab directly — no query needed
browser.action.onClicked.addListener(async (tab) => {
  if (tab?.id) await openInTab(tab.id);
});

async function openInTab(tabId) {
  try {
    await browser.tabs.sendMessage(tabId, { type: 'LQC_OPEN' });
    return;
  } catch { /* not yet injected, fall through */ }

  try {
    await browser.scripting.executeScript({ target: { tabId }, files: ['content/modal.js'] });
    await browser.scripting.executeScript({ target: { tabId }, func: () => { window.__lqcOpen?.(); } });
  } catch { /* browser-internal page — nothing to do */ }
}

browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'LQC_OPEN_OPTIONS') {
    browser.tabs.create({ url: browser.runtime.getURL('options/options.html') });
  }
});

// ─── Transport seam (ADR 0004) ────────────────────────────────────────────────
// Two transports behind one seam. The HTTP API talks only to the graph
// currently open in the app; the CLI (via native messaging) routes to any
// graph, lists graphs, and reads tag schemas. CLI features fail soft to HTTP.

const httpTransport = {
  name: 'http',
  capabilities: { routeWrites: false, listGraphs: false, readSchemas: false },

  async call(method, args) {
    const { logseqApiToken, logseqApiPort } = await browser.storage.sync.get({
      logseqApiToken: '',
      logseqApiPort: 12315,
    });

    if (!logseqApiToken) {
      throw new Error('No API token configured — open extension settings to add one.');
    }

    let res;
    try {
      res = await fetch(`http://localhost:${logseqApiPort}/api`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${logseqApiToken}`,
        },
        body: JSON.stringify({ method, args }),
      });
    } catch {
      throw new Error('Could not reach Logseq. Is it running with the HTTP API enabled?');
    }

    if (res.status === 401) throw new Error('Invalid API token. Check extension settings.');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Logseq API error ${res.status}${text ? ': ' + text : ''}`);
    }

    return res.json();
  },
};

// ─── CLI transport via native messaging ──────────────────────────────────────

const NATIVE_HOST = 'logseq_quick_capture';

function createCliTransport() {
  let port = null;
  let nextId = 1;
  const pending = new Map();

  function ensurePort() {
    if (port) return port;
    port = browser.runtime.connectNative(NATIVE_HOST);
    port.onMessage.addListener((msg) => {
      const entry = pending.get(msg?.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error || 'Native host error'));
    });
    port.onDisconnect.addListener(() => {
      const err = new Error(port?.error?.message || 'Native host disconnected');
      pending.forEach(({ reject }) => reject(err));
      pending.clear();
      port = null;
    });
    return port;
  }

  function send(cmd, args) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try {
        ensurePort().postMessage({ id, cmd, args });
      } catch (err) {
        pending.delete(id);
        reject(err);
        return;
      }
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('Native host timed out'));
        }
      }, 90000);
    });
  }

  // Run a CLI command with -o json and unwrap the {status, data} envelope
  async function cliJson(args) {
    let out;
    try {
      out = await send('cli', [...args, '-o', 'json']);
    } catch (err) {
      // Non-zero CLI exits (e.g. tag-not-found) reject here, before the parse
      // below ever runs — the native host forwards the CLI's own stdout as the
      // error message. Parse it so structured fields (phase/code) survive.
      try {
        const parsed = JSON.parse(err.message);
        if (parsed?.status !== 'ok' && parsed?.error) {
          err.detail = parsed.error;
          if (parsed.error.message) {
            err.message = parsed.error.code
              ? `${parsed.error.code}: ${parsed.error.message}`
              : parsed.error.message;
          }
        }
      } catch { /* not JSON — leave as a plain error */ }
      throw err;
    }
    const parsed = JSON.parse(out);
    if (parsed?.status !== 'ok') {
      const error = new Error(parsed?.error?.message ?? parsed?.message ?? 'Logseq CLI error');
      error.detail = parsed?.error ?? parsed;
      throw error;
    }
    return parsed.data;
  }

  return {
    name: 'cli',
    capabilities: { routeWrites: true, listGraphs: true, readSchemas: true },
    send,
    cliJson,
  };
}

let cliTransport = null;

async function detectCli() {
  try {
    const granted = await browser.permissions.contains({ permissions: ['nativeMessaging'] });
    const { cliEnabled } = await browser.storage.sync.get({ cliEnabled: false });
    if (!granted || !cliEnabled) {
      cliTransport = null;
      return { available: false, error: 'CLI integration is not enabled.' };
    }
    const t = createCliTransport();
    const version = await t.send('version');
    cliTransport = t;
    return { available: true, version };
  } catch (err) {
    cliTransport = null;
    return { available: false, error: err.message };
  }
}

// Event-page wake race: the message that woke this page must not be answered
// before detection settles, or every operation silently drops to HTTP.
let cliReady = detectCli();

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.cliEnabled) cliReady = detectCli();
});

function activeTransport() {
  return cliTransport ?? httpTransport;
}

// ─── Messages ─────────────────────────────────────────────────────────────────

// Proxy Logseq HTTP API calls from content script (content scripts can't make
// cross-origin requests to localhost reliably without host_permissions in
// the background context)
browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'LQC_API') return false;

  cliReady.then(() => callLogseq(message.method, message.args))
    .then(result => sendResponse({ ok: true, result }))
    .catch(err => sendResponse({ ok: false, error: err.message }));

  return true; // keep message channel open for async sendResponse
});

browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'LQC_TRANSPORT_INFO') {
    return cliReady.then(() => {
      const t = activeTransport();
      return { name: t.name, capabilities: t.capabilities };
    });
  }
  if (message.type === 'LQC_CLI_DETECT') {
    return detectCli();
  }
  if (message.type === 'LQC_OP') {
    return cliReady.then(() => handleOp(message))
      .then((result) => ({ ok: true, result }))
      .catch((err) => ({ ok: false, error: err.message }));
  }
  if (message.type === 'LQC_SAVE') {
    return cliReady.then(() => handleSaveOp(message.payload))
      .then(() => ({ ok: true }))
      .catch((err) => ({ ok: false, error: err.message }));
  }
});

async function callLogseq(method, args) {
  const result = await httpTransport.call(method, args);

  // Known Graphs accumulate by observation — every graph seen open in Logseq
  // becomes a Target Graph choice (there is deliberately no manual add)
  if (method === 'logseq.App.getCurrentGraph') {
    const name = result?.name ?? result?.['graph/name'];
    if (name) recordKnownGraph(name).catch(() => {});
  }

  return result;
}

async function recordKnownGraph(name) {
  const { graphSettings, defaultCapturePage } = await browser.storage.sync.get({
    graphSettings: {},
    defaultCapturePage: '',
  });
  if (name in graphSettings) return;

  // Migration: a pre-graph-aware global capture page belongs to the first
  // graph we observe (the one it was in effect for)
  const capturePage = Object.keys(graphSettings).length === 0 ? defaultCapturePage : '';
  graphSettings[name] = { capturePage };

  const update = { graphSettings };
  if (capturePage) update.defaultCapturePage = '';
  await browser.storage.sync.set(update);
}

// ─── EDN encoding (CLI --update-tags / --update-properties) ──────────────────

function edn(value) {
  if (Array.isArray(value)) return '[' + value.map(edn).join(' ') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.entries(value)
      .map(([k, v]) => `${edn(String(k))} ${edn(v)}`)
      .join(' ') + '}';
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return 'nil';
}

// ─── Date formatting (journal page names) ─────────────────────────────────────

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

  const year = String(date.getFullYear());
  return fmt
    .replace(/MMMM/g,     months[date.getMonth()])
    .replace(/MMM/g,      short[date.getMonth()])
    .replace(/MM/g,       pad(date.getMonth() + 1))
    .replace(/do/g,       d + suffix)
    .replace(/DD|dd/g,    pad(d))
    .replace(/D(?!o)\b/g, String(d))
    .replace(/YYYY|yyyy/g, year)
    .replace(/YY|yy/g,    year.slice(-2));
}

// ─── Read ops ─────────────────────────────────────────────────────────────────

async function handleOp(message) {
  if (!cliTransport) throw new Error('CLI transport not available');

  if (message.op === 'listGraphs') {
    const data = await cliTransport.cliJson(['graph', 'list']);
    return data?.graphs ?? [];
  }

  if (message.op === 'getTags') {
    const data = await cliTransport.cliJson([
      'list', 'tag', '--graph', message.graph, '--limit', '2000',
    ]);
    return (data?.items ?? [])
      .filter((t) => String(t['db/ident'] ?? '').startsWith('user.class/'))
      .map((t) => t['block/title'])
      .filter(Boolean);
  }

  if (message.op === 'getTagSchema') {
    const tagMatch = `[?c :block/tags :logseq.class/Tag]
        [?c :block/title ?ct]
        [(clojure.string/lower-case ?ct) ?lct]
        [(= ?lct ${JSON.stringify(message.tag.toLowerCase())})]
        [?c :logseq.property.class/properties ?p]
        [?p :block/title ?pt]`;

    const rows = await cliQuery(message.graph,
      `[:find ?pt ?ty ?card :where ${tagMatch}
        [?p :logseq.property/type ?ty]
        [?p :db/cardinality ?card]]`);

    // Choices ("closed value") properties only accept their predefined value
    // blocks — surface them so the modal can render a dropdown
    const choiceRows = await cliQuery(message.graph,
      `[:find ?pt ?cvt ?cvo :where ${tagMatch}
        [?cv :block/closed-value-property ?p]
        [?cv :block/title ?cvt]
        [?cv :block/order ?cvo]]`);
    const choicesByProp = {};
    choiceRows
      .sort((a, b) => String(a[2]).localeCompare(String(b[2])))
      .forEach(([prop, title]) => {
        (choicesByProp[prop] ??= []).push(title);
      });

    // Node property suggestions: values already in use, plus every node of
    // the property's constraint class when one is set (logseq.property/classes)
    const suggestionsByProp = {};
    const collect = (pairs) => pairs.forEach(([prop, title]) => {
      if (!title) return;
      (suggestionsByProp[prop] ??= new Set()).add(title);
    });
    collect(await cliQuery(message.graph,
      `[:find ?pt ?vt :where ${tagMatch}
        [?p :logseq.property/type :node]
        [?p :db/ident ?a] [?b ?a ?v] [?v :block/title ?vt]]`));
    collect(await cliQuery(message.graph,
      `[:find ?pt ?nt :where ${tagMatch}
        [?p :logseq.property/type :node]
        [?p :logseq.property/classes ?cls]
        [?n :block/tags ?cls] [?n :block/title ?nt]]`));

    const typeMap = {
      default: 'text', string: 'text', number: 'number', date: 'date',
      datetime: 'date', checkbox: 'checkbox', url: 'url', node: 'node',
    };
    return rows.map(([name, type, card]) => {
      const field = {
        name,
        type: typeMap[type] ?? 'text',
        cardinality: String(card).endsWith('many') ? 'many' : 'one',
      };
      if (choicesByProp[name]?.length) field.choices = choicesByProp[name];
      if (field.type === 'node' && !field.choices) {
        field.suggestions = [...(suggestionsByProp[name] ?? [])].sort((a, b) => a.localeCompare(b));
      }
      return field;
    });
  }

  throw new Error(`Unknown op: ${message.op}`);
}

async function cliQuery(graph, query) {
  const data = await cliTransport.cliJson([
    'query', '--graph', graph, '--query', query.replace(/\s+/g, ' '),
  ]);
  return data?.result ?? [];
}

// ─── Save ─────────────────────────────────────────────────────────────────────
// Payload: { mode: 'clipper'|'tags', graph, title, url, tags, notes, highlight,
//            tagName, fields: [{name, type, value}] }

async function handleSaveOp(payload) {
  if (cliTransport) {
    let graph = payload.graph;
    if (!graph) {
      // "(the open graph)" — ask the app which one that is
      const cur = await callLogseq('logseq.App.getCurrentGraph', []);
      graph = cur?.name ?? cur?.['graph/name'] ?? '';
    }
    if (!graph) throw new Error('Pick a target graph — the open graph could not be determined.');

    try {
      return await saveViaCli({ ...payload, graph });
    } catch (err) {
      if (!err?.lqcFallback) throw err;

      let open = '';
      try {
        const cur = await callLogseq('logseq.App.getCurrentGraph', []);
        open = cur?.name ?? cur?.['graph/name'] ?? '';
      } catch {
        throw err; // couldn't confirm graph identity — surface the original error
      }
      if (open && open === graph) return saveViaHttp({ ...payload, graph });
      throw err;
    }
  }
  return saveViaHttp(payload);
}

function clipTags(payload) {
  const tags = payload.mode === 'tags'
    ? [payload.tagName]
    : [...(payload.tags ?? []), ...(payload.highlight ? ['highlight'] : [])];
  return tags.filter(Boolean);
}

// CLI-tier only: `upsert block --update-tags` resolves existing classes only,
// so tags picked via the modal's explicit Create row must be minted first.
async function ensureCliTags(payload, graph) {
  const newTags = payload.newTags ?? [];
  const mint = new Set(clipTags(payload).filter((t) => newTags.includes(t)));
  // The auto-injected #highlight class is the sole sanctioned implicit tag
  // creation — every other tag requires an explicit Create-row choice.
  if (payload.highlight) mint.add('highlight');
  for (const t of mint) {
    await cliTransport.cliJson(['upsert', 'tag', '--graph', graph, '--name', t]);
  }
}

// Unknown phases fail safe to a hard Retry — only a confirmed pre-apply
// failure (tag resolution before any write) is safe to silently retry via
// HTTP. A future pre-apply phase would need an explicit addition here.
const isPreApplyCliError = (err) => err?.detail?.phase === 'resolve-options';

// The HTTP rerun is further scoped to tags this save was allowed to mint
// (explicit Create-row picks plus the sanctioned highlight class). A resolve
// failure on any other tag — e.g. a typo'd Tag Properties config tagName — is
// a diagnostic and must stay a hard error, not a silent rerun that would mint
// the class. Membership is case-insensitive, matching --update-tags' insensitive
// resolution.
function isMintableTagError(err, payload) {
  const failed = String(err?.detail?.tag ?? '').toLowerCase();
  if (!failed) return false;
  const mintable = [...(payload.newTags ?? [])];
  if (payload.highlight) mintable.push('highlight');
  return mintable.some((t) => t.toLowerCase() === failed);
}

function clipProps(payload) {
  const props = {};
  for (const f of payload.fields ?? []) {
    if (f.value === '' || f.value === false || f.value == null) continue;
    // Multi-value node fields (chips) arrive as arrays
    if (Array.isArray(f.value)) {
      const vals = f.value.map((v) => String(v).trim()).filter(Boolean);
      if (vals.length) props[f.name] = vals;
      continue;
    }
    // Trim string values: choices ("closed value") properties resolve by
    // exact match against the existing choice blocks — " Slim" would mint
    // a new block and fail Logseq's validation instead of linking Slim
    const typed = f.type === 'number' ? (parseFloat(f.value) || f.value)
      : f.type === 'checkbox' ? Boolean(f.value)
      : String(f.value).trim();
    if (typed === '') continue;
    props[f.name] = typed;
  }
  return props;
}

// Tag Properties clips whose tag has a url property get a clean title as the
// block text — the URL lives in the property, keeping table-view Name columns
// readable. Everything else keeps the markdown link.
function clipContent(payload) {
  const urlInProps = payload.mode === 'tags'
    && (payload.fields ?? []).some((f) => f.type === 'url' && String(f.value ?? '').trim());
  return urlInProps ? payload.title : `[${payload.title}](${payload.url})`;
}

// Node values of a class-constrained property go to the CLI as db ids. Given
// a title, the CLI can mint an untagged value block under the property entity
// instead, which never shows in the constraint tag's table (verified
// 2026-10-03). A value with no matching node of the class comes from the
// modal's explicit Create row, so it is created as a node of that class first.
async function resolveNodeValues(payload, graph, props) {
  for (const f of payload.fields ?? []) {
    if (f.type !== 'node' || !(f.name in props)) continue;

    const propMatch = `[?p :block/title ${JSON.stringify(f.name)}]
        [?p :logseq.property/type :node]
        [?p :logseq.property/classes ?cls]`;
    const classes = (await cliQuery(graph,
      `[:find ?cls ?clt ?ci :where ${propMatch}
        [?cls :block/title ?clt] [?cls :db/ident ?ci]]`))
      .filter(([, , ident]) => String(ident).startsWith('user.class/'));
    if (!classes.length) continue; // unconstrained — the CLI links or creates by title
    const [classId, classTitle] = classes[0];

    const members = await cliQuery(graph,
      `[:find ?n ?t :where ${propMatch} [?n :block/tags ?cls] [?n :block/title ?t]]`);

    const toId = async (title) => {
      const hit = members.find(([, t]) => t === title)
        ?? members.find(([, t]) => String(t).toLowerCase() === title.toLowerCase());
      if (hit) return hit[0];
      const made = await cliTransport.cliJson([
        'upsert', 'block', '--graph', graph, '--target-id', String(classId),
        '--content', title, '--update-tags', edn([classTitle]),
      ]);
      const id = made?.result?.[0];
      if (id == null) throw new Error(`Could not create "${title}" as a #${classTitle} node.`);
      members.push([id, title]);
      return id;
    };

    const value = props[f.name];
    if (Array.isArray(value)) {
      const ids = [];
      for (const v of value) ids.push(await toId(v));
      props[f.name] = ids;
    } else {
      props[f.name] = await toId(value);
    }
  }
  return props;
}

// ── CLI path: routes to any graph; tags matched case-insensitively

async function saveViaCli(payload) {
  const graph = payload.graph;
  const targetPage = await cliTargetPage(graph);

  const args = [
    'upsert', 'block',
    '--graph', graph,
    '--target-page', targetPage,
    '--content', clipContent(payload),
  ];
  const tags = clipTags(payload);
  if (tags.length) args.push('--update-tags', edn(tags));

  let data;
  try {
    await ensureCliTags(payload, graph);
  } catch (err) {
    err.lqcFallback = true;
    throw err;
  }
  const props = await resolveNodeValues(payload, graph, clipProps(payload));
  if (Object.keys(props).length) args.push('--update-properties', edn(props));
  try {
    data = await cliTransport.cliJson(args);
  } catch (err) {
    err.lqcFallback = isPreApplyCliError(err) && isMintableTagError(err, payload);
    throw err;
  }
  const blockId = data?.result?.[0];
  if (blockId == null) throw new Error('Clip saved but no block id returned by the CLI.');

  if (payload.mode === 'clipper' && payload.notes) {
    await cliTransport.cliJson([
      'upsert', 'block', '--graph', graph,
      '--target-id', String(blockId), '--content', payload.notes,
    ]);
  }
  if (payload.mode === 'clipper' && payload.highlight) {
    await cliTransport.cliJson([
      'upsert', 'block', '--graph', graph,
      '--target-id', String(blockId), '--content', `> ${payload.highlight}`,
    ]);
  }
}

async function cliTargetPage(graph) {
  const { graphSettings } = await browser.storage.sync.get({ graphSettings: {} });
  const capturePage = graphSettings[graph]?.capturePage ?? '';
  if (capturePage) return capturePage;

  // Journal writes must target the canonical title. Prefer the existing page
  // for today; otherwise render today with the graph's own title format.
  const now = new Date();
  const journalDay = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
  const existing = await cliQuery(graph,
    `[:find ?t :where [?p :block/journal-day ${journalDay}] [?p :block/title ?t]]`);
  if (existing[0]?.[0]) return existing[0][0];

  const fmtRows = await cliQuery(graph,
    '[:find ?f :where [?e :db/ident :logseq.class/Journal] [?e :logseq.property.journal/title-format ?f]]');
  return formatDate(now, fmtRows[0]?.[0] ?? 'MMM do, yyyy');
}

// ── HTTP path: writes to the open graph only, enforced by the Graph Guard

async function saveViaHttp(payload) {
  if (payload.graph) {
    const cur = await callLogseq('logseq.App.getCurrentGraph', []);
    const open = cur?.name ?? cur?.['graph/name'] ?? '';
    if (open && open !== payload.graph) {
      throw new Error(
        `Logseq has "${open}" open, but this capture is aimed at "${payload.graph}". ` +
        `Switch graphs in Logseq, then Retry.`
      );
    }
  }

  const targetPage = await httpTargetPage(payload.graph);
  const tags = await resolveTagCasing(clipTags(payload), payload.graph);

  // Embed tags inline so Logseq DB stores them as native :block/tags
  // relationships. upsertBlockProperty("tags") stores under a plugin
  // namespace instead.
  const tagStr = tags.length ? ' ' + tags.map((t) => `#${t}`).join(' ') : '';
  const block = await callLogseq('logseq.Editor.appendBlockInPage', [
    targetPage,
    `${clipContent(payload)}${tagStr}`,
  ]);
  // When the anchor content mints a new inline class (e.g. the auto-injected
  // #highlight the first time it appears in a graph) Logseq persists the block
  // but returns no uuid. Recover it from the page instead of throwing —
  // throwing strands the block that was already written, and Retry then
  // appends a duplicate.
  const uuid = block?.uuid ?? await recoverAppendedUuid(targetPage, payload);
  if (!uuid) {
    throw new Error('Block created but no UUID returned — check Logseq HTTP API compatibility.');
  }

  if (payload.mode === 'clipper') {
    if (payload.notes) {
      await callLogseq('logseq.Editor.insertBlock', [uuid, payload.notes, { sibling: false }]);
    }
    if (payload.highlight) {
      await callLogseq('logseq.Editor.insertBlock', [
        uuid, `> ${payload.highlight}`, { sibling: false },
      ]);
    }
    return;
  }

  // Property identity in Logseq DB is the ident, not the display name —
  // writing by name mints a plugin-namespaced duplicate. Resolve names to
  // the graph's existing property idents first (user properties win title
  // collisions with plugin-namespaced duplicates).
  const propIdents = {};
  try {
    const rows = await callLogseq('logseq.DB.datascriptQuery', [
      '[:find ?title ?ident :where [?p :block/tags :logseq.class/Property] [?p :db/ident ?ident] [?p :block/title ?title]]',
    ]);
    if (Array.isArray(rows)) {
      const isUserProp = (id) => String(id).replace(/^:/, '').startsWith('user.property/');
      rows.forEach(([title, ident]) => {
        if (!title || !ident) return;
        const key = String(title).toLowerCase();
        if (!propIdents[key] || (isUserProp(ident) && !isUserProp(propIdents[key]))) {
          propIdents[key] = ident;
        }
      });
    }
  } catch { /* fall back to names — properties may be created new */ }

  const props = clipProps(payload);
  for (const [name, value] of Object.entries(props)) {
    const key = propIdents[name.toLowerCase()] ?? name;
    await callLogseq('logseq.Editor.upsertBlockProperty', [uuid, key, value]);
  }
}

// appendBlockInPage can persist a block but return no uuid when its content
// mints a new inline class. Find the just-appended anchor by the clip's URL
// (content is `[title](url)`; falls back to the title when the URL lives in a
// property) so children still attach and the save isn't retried into a dupe.
async function recoverAppendedUuid(targetPage, payload) {
  let tree;
  try {
    tree = await callLogseq('logseq.Editor.getPageBlocksTree', [targetPage]);
  } catch {
    return null;
  }
  if (!Array.isArray(tree) || !tree.length) return null;

  const needle = payload.url || payload.title || '';
  if (needle) {
    for (let i = tree.length - 1; i >= 0; i--) {
      if (String(tree[i]?.content ?? '').includes(needle)) return tree[i]?.uuid ?? null;
    }
    return null;
  }
  return tree[tree.length - 1]?.uuid ?? null;
}

async function httpTargetPage(graph) {
  const { graphSettings } = await browser.storage.sync.get({ graphSettings: {} });
  let graphName = graph;
  if (!graphName) {
    try {
      const cur = await callLogseq('logseq.App.getCurrentGraph', []);
      graphName = cur?.name ?? cur?.['graph/name'] ?? '';
    } catch { /* journal fallback below */ }
  }
  const capturePage = graphSettings[graphName]?.capturePage ?? '';
  if (capturePage) return capturePage;

  try {
    const configs = await callLogseq('logseq.App.getUserConfigs', []);
    const fmt = configs?.preferredDateFormat;
    if (fmt) return formatDate(new Date(), fmt);
  } catch { /* fall through */ }

  return new Date().toISOString().slice(0, 10);
}

// Inline #tag syntax matches case-sensitively — #apparel mints a new class
// even when Apparel exists. Reuse the target graph's cached casing.
async function resolveTagCasing(tags, graph) {
  if (!graph || !tags.length) return tags;
  try {
    const { tagCache } = await browser.storage.local.get({ tagCache: {} });
    const known = tagCache[graph] ?? [];
    return tags.map((t) => known.find((k) => k.toLowerCase() === t.toLowerCase()) ?? t);
  } catch {
    return tags;
  }
}
