// Chromium exposes only `chrome.*`; Firefox exposes both. In MV3 the chrome
// APIs return Promises when called without a callback, so one alias is enough.
globalThis.browser ??= chrome;

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

// ─── Device-local settings ───────────────────────────────────────────────────
// The API token and the CLI switch stay in storage.local by default: on Chrome,
// storage.sync travels through the user's Google account, and the CLI switch is
// per profile anyway (the nativeMessaging grant is). `tokenSynced` (always
// local) records that the user opted the token into storage.sync instead.
// Installs predating this read their old sync values once and migrate.
// Duplicated in options.js on purpose: no build step, no shared file.

async function readToken() {
  const { logseqApiToken, tokenSynced } = await browser.storage.local.get({ logseqApiToken: '', tokenSynced: false });
  if (tokenSynced) {
    const synced = (await browser.storage.sync.get({ logseqApiToken: '' })).logseqApiToken;
    if (synced) return synced;
    // Another profile turned syncing off and withdrew the shared token: this
    // profile is no longer synced and must be given a token again.
    await browser.storage.local.set({ tokenSynced: false });
    return logseqApiToken;
  }
  if (logseqApiToken) return logseqApiToken;
  const synced = (await browser.storage.sync.get({ logseqApiToken: '' })).logseqApiToken;
  if (synced) await browser.storage.local.set({ tokenSynced: true }); // pre-toggle install: keep it where it is
  return synced;
}

async function readCliEnabled() {
  const local = await browser.storage.local.get('cliEnabled');
  if ('cliEnabled' in local) return Boolean(local.cliEnabled);
  const sync = await browser.storage.sync.get('cliEnabled');
  if ('cliEnabled' in sync) {
    await browser.storage.local.set({ cliEnabled: Boolean(sync.cliEnabled) });
    await browser.storage.sync.remove('cliEnabled');
    return Boolean(sync.cliEnabled);
  }
  return false;
}

// ─── Transport seam (ADR 0004) ────────────────────────────────────────────────
// Two transports behind one seam. The HTTP API talks only to the graph
// currently open in the app; the CLI (via native messaging) routes to any
// graph, lists graphs, and reads tag schemas. CLI features fail soft to HTTP.

const httpTransport = {
  name: 'http',
  capabilities: { routeWrites: false, listGraphs: false, readSchemas: false },

  async call(method, args) {
    const logseqApiToken = await readToken();
    const { logseqApiPort } = await browser.storage.sync.get({ logseqApiPort: 12315 });

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
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('Native host timed out'));
        }
      }, 90000);
      const settle = (fn) => (v) => { clearTimeout(timer); fn(v); };
      pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      try {
        ensurePort().postMessage({ id, cmd, args });
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  // Drop the port (and fail anything pending) when this transport is replaced.
  function close() {
    const p = port;
    port = null;
    try { p?.disconnect?.(); } catch { /* already gone */ }
    const err = new Error('Native host transport replaced');
    pending.forEach(({ reject }) => reject(err));
    pending.clear();
  }

  // The CLI does not reject an unknown --graph: even a read silently creates
  // an empty graph and spawns a worker for it. Every command that names a
  // graph is checked against the CLI's own graph list first (re-read once on
  // a miss, for graphs created since).
  let graphNames = null;
  async function knownGraphNames(refresh) {
    if (!graphNames || refresh) graphNames = (await runJson(['graph', 'list']))?.graphs ?? [];
    return graphNames;
  }

  async function cliJson(args) {
    const i = args.indexOf('--graph');
    if (i !== -1) {
      const graph = args[i + 1];
      const known = (await knownGraphNames(false)).includes(graph)
        || (await knownGraphNames(true)).includes(graph);
      if (!known) {
        throw new Error(`Logseq has no graph named "${graph}" — check the target graph in the extension settings.`);
      }
    }
    return runJson(args);
  }

  // Run a CLI command with -o json and unwrap the {status, data} envelope
  async function runJson(args) {
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
    close,
  };
}

let cliTransport = null;
let cliUnavailableReason = ''; // why the CLI transport is not active, for the modal

// Single-flight: a detection started while another is running (e.g. the
// cliEnabled migration write fires storage.onChanged mid-detect) reuses the
// in-flight promise instead of opening a second native port. Replacing the
// transport always closes the previous port.
let detecting = null;
function detectCli() {
  if (detecting) return detecting;
  detecting = (async () => {
    try {
      const granted = await browser.permissions.contains({ permissions: ['nativeMessaging'] });
      const cliEnabled = await readCliEnabled();
      if (!granted || !cliEnabled) {
        cliTransport?.close();
        cliTransport = null;
        cliUnavailableReason = 'CLI integration is not enabled';
        return { available: false, error: 'CLI integration is not enabled.' };
      }
      const t = createCliTransport();
      const version = await t.send('version');
      cliTransport?.close();
      cliTransport = t;
      cliUnavailableReason = '';
      return { available: true, version };
    } catch (err) {
      cliTransport?.close();
      cliTransport = null;
      cliUnavailableReason = `the Logseq CLI could not be reached (${err.message})`;
      return { available: false, error: err.message };
    } finally {
      detecting = null;
    }
  })();
  return detecting;
}

// Event-page wake race: the message that woke this page must not be answered
// before detection settles, or every operation silently drops to HTTP.
let cliReady = detectCli();

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.cliEnabled) cliReady = detectCli();
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

// Chromium only honours a Promise returned from onMessage from Chrome 148 on a
// gradual rollout, so every async reply goes through sendResponse + `return true`.
browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  let reply;
  if (message.type === 'LQC_TRANSPORT_INFO') {
    reply = cliReady.then(() => {
      const t = activeTransport();
      return { name: t.name, capabilities: t.capabilities, reason: cliUnavailableReason };
    });
  } else if (message.type === 'LQC_CLI_DETECT') {
    reply = detectCli();
  } else if (message.type === 'LQC_OP') {
    reply = cliReady.then(() => handleOp(message))
      .then((result) => ({ ok: true, result }))
      .catch((err) => ({ ok: false, error: err.message }));
  } else if (message.type === 'LQC_SAVE') {
    reply = cliReady.then(() => handleSaveOp(message.payload))
      .then(() => ({ ok: true }))
      .catch((err) => ({ ok: false, error: err.message }));
  } else {
    return false;
  }
  reply.then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
  return true;
});

// The HTTP API reports the open graph by its internal repo name
// ("logseq_db_General"); the CLI, the app UI and the user call it "General".
// Names are normalised here, at the seam, so every comparison and every
// stored Known Graph uses the one plain name.
const plainGraphName = (name) => String(name ?? '').replace(/^logseq_db_/, '');

async function callLogseq(method, args) {
  const result = await httpTransport.call(method, args);

  // Known Graphs accumulate by observation — every graph seen open in Logseq
  // becomes a Target Graph choice (there is deliberately no manual add)
  if (method === 'logseq.App.getCurrentGraph' && result && typeof result === 'object') {
    if (result.name) result.name = plainGraphName(result.name);
    if (result['graph/name']) result['graph/name'] = plainGraphName(result['graph/name']);
    const name = result.name ?? result['graph/name'];
    if (name) recordKnownGraph(name).catch(() => {});
  }

  return result;
}

// Migration: graph names stored before normalisation may carry the HTTP
// API's "logseq_db_" prefix. Fold each into its plain name — a capture page
// set under either name survives.
async function migrateGraphNames() {
  const sync = await browser.storage.sync.get({
    graphSettings: {}, webClipperTargetGraph: '', tagConfigs: [],
  });
  const update = {};

  const settings = {};
  let settingsChanged = false;
  for (const [name, value] of Object.entries(sync.graphSettings)) {
    const plain = plainGraphName(name);
    if (plain !== name) settingsChanged = true;
    const capturePage = settings[plain]?.capturePage || value?.capturePage || '';
    settings[plain] = { ...value, ...settings[plain], capturePage };
  }
  if (settingsChanged) update.graphSettings = settings;

  if (plainGraphName(sync.webClipperTargetGraph) !== sync.webClipperTargetGraph) {
    update.webClipperTargetGraph = plainGraphName(sync.webClipperTargetGraph);
  }
  if (sync.tagConfigs.some((c) => c.graph && plainGraphName(c.graph) !== c.graph)) {
    update.tagConfigs = sync.tagConfigs.map((c) => (c.graph ? { ...c, graph: plainGraphName(c.graph) } : c));
  }
  if (Object.keys(update).length) await browser.storage.sync.set(update);

  const { tagCache } = await browser.storage.local.get({ tagCache: {} });
  const stale = Object.keys(tagCache).filter((g) => plainGraphName(g) !== g);
  if (stale.length) {
    stale.forEach((g) => {
      tagCache[plainGraphName(g)] ??= tagCache[g];
      delete tagCache[g];
    });
    await browser.storage.local.set({ tagCache });
  }
}

migrateGraphNames().catch(() => {});

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

// A property key of this shape is a db/ident keyword (":user.property/x-Abc"),
// emitted bare so the CLI writes that exact property instead of resolving a
// display name — names collide (General has both URL and url).
const IDENT_KEY_RE = /^:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\-?!*+<>=]+$/;

// Fields from a live schema read carry the property's ident; hand-typed
// static configs only have a name.
function propKey(field) {
  const key = field.ident ? `:${String(field.ident).replace(/^:/, '')}` : '';
  return IDENT_KEY_RE.test(key) ? key : field.name;
}

function edn(value) {
  if (Array.isArray(value)) return '[' + value.map(edn).join(' ') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.entries(value)
      .map(([k, v]) => `${IDENT_KEY_RE.test(k) ? k : edn(String(k))} ${edn(v)}`)
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
    return getTagSchema(message.graph, message.tag);
  }

  throw new Error(`Unknown op: ${message.op}`);
}

// `inputs` is an EDN vector string bound positionally after `$` — values
// that come from the page or the graph go here, never into the query text
async function cliQuery(graph, query, inputs) {
  const args = ['query', '--graph', graph, '--query', query.replace(/\s+/g, ' ')];
  if (inputs) args.push('--inputs', inputs.replace(/\s+/g, ' '));
  const data = await cliTransport.cliJson(args);
  return data?.result ?? [];
}

// ─── Tag schema ───────────────────────────────────────────────────────────────
// One pull returns the tag, its properties (with choices and constraint
// classes) and, through the recursive extends element, every parent tag with
// the same shape. Identity is the db/ident throughout; titles are display only.

const SCHEMA_QUERY = `[:find (pull ?c [:db/id :db/ident :block/title
    {:logseq.property.class/properties [:db/id :db/ident :block/title
      :logseq.property/type :db/cardinality
      :logseq.property/hide? :logseq.property/built-in?
      {:logseq.property/classes [:db/id :db/ident :block/title]}
      {:block/_closed-value-property [:db/id :block/title :block/order]}]}
    {:logseq.property.class/extends ...}])
  :in $ ?lct
  :where [?c :block/tags :logseq.class/Tag]
    [?c :block/title ?ct]
    [(clojure.string/lower-case ?ct) ?lc]
    [(= ?lc ?lct)]]`;

// sub: a class or any class extending it. sugg: nodes already used as the
// property's value, plus every node of its constraint class (or a subclass).
const SUGGESTION_RULES = `[[(sub ?k ?c) [(identity ?c) ?k]]
  [(sub ?k ?c) [?k :logseq.property.class/extends ?m] (sub ?m ?c)]
  [(sugg ?p ?pi ?n) [?b ?pi ?n]]
  [(sugg ?p ?pi ?n) [?p :logseq.property/classes ?cls] (sub ?k ?cls) [?n :block/tags ?k]]]`;

const SCHEMA_TYPE_MAP = {
  default: 'text', string: 'text', number: 'number', date: 'date',
  datetime: 'date', checkbox: 'checkbox', url: 'url', node: 'node',
};

const HIDDEN_IDENT_RE = /^(logseq\.|block\/|plugin\.property\.)/;

async function getTagSchema(graph, tag) {
  const rows = await cliQuery(graph, SCHEMA_QUERY, edn([String(tag).toLowerCase()]));
  // An unknown tag is an error, distinct from a tag that has no properties
  if (!rows.length) throw new Error(`no tag named "${tag}" in graph "${graph}"`);

  // Several classes match when the graph has case-duplicate tags (Linux /
  // linux) — their schemas merge. Walk breadth-first so a tag's own
  // properties come before inherited ones; the first sighting of an ident wins.
  const fields = [];
  const seenProps = new Set();
  const seenClasses = new Set();
  let level = rows.map((r) => r[0]).filter(Boolean);
  let inherited = false;
  while (level.length) {
    const next = [];
    for (const cls of level) {
      if (seenClasses.has(cls['db/id'])) continue;
      seenClasses.add(cls['db/id']);
      for (const p of cls['logseq.property.class/properties'] ?? []) {
        const field = schemaField(p);
        if (!field || seenProps.has(field.ident)) continue;
        seenProps.add(field.ident);
        if (inherited) field.inherited = true;
        fields.push(field);
      }
      next.push(...(cls['logseq.property.class/extends'] ?? []));
    }
    level = next;
    inherited = true;
  }

  await attachNodeSuggestions(graph, fields);
  return fields;
}

function schemaField(p) {
  const ident = String(p['db/ident'] ?? '');
  const type = SCHEMA_TYPE_MAP[p['logseq.property/type']];
  if (!ident || !type || !p['block/title']) return null;
  if (HIDDEN_IDENT_RE.test(ident)) return null;
  if (p['logseq.property/hide?'] || p['logseq.property/built-in?']) return null;

  const field = {
    name: p['block/title'],
    ident,
    type,
    cardinality: String(p['db/cardinality']).endsWith('many') ? 'many' : 'one',
  };
  // Choices ("closed value") properties only accept their predefined value
  // blocks — surface them so the modal can render a dropdown
  const choices = (p['block/_closed-value-property'] ?? [])
    .filter((c) => c['block/title'])
    .sort((a, b) => {
      const x = String(a['block/order'] ?? '');
      const y = String(b['block/order'] ?? '');
      return x < y ? -1 : x > y ? 1 : 0;
    })
    .map((c) => c['block/title']);
  if (choices.length) field.choices = choices;
  return field;
}

// Node fields get {id, title} suggestions so a pick can be saved as a db id
// (the only value form that reliably links an existing node).
async function attachNodeSuggestions(graph, fields) {
  const nodeFields = fields.filter((f) =>
    f.type === 'node' && !f.choices && IDENT_KEY_RE.test(`:${f.ident}`));
  if (!nodeFields.length) return;

  const idents = nodeFields.map((f) => `:${f.ident}`).join(' ');
  const rows = await cliQuery(graph,
    `[:find ?pi ?n ?nt :in $ % [?pi ...]
      :where [?p :db/ident ?pi] (sugg ?p ?pi ?n) [?n :block/title ?nt]]`,
    `[${SUGGESTION_RULES} [${idents}]]`);

  const byIdent = {};
  rows.forEach(([ident, id, title]) => {
    if (!title) return;
    (byIdent[ident] ??= new Map()).set(id, { id, title });
  });
  nodeFields.forEach((f) => {
    f.suggestions = [...(byIdent[f.ident]?.values() ?? [])]
      .sort((a, b) => a.title.localeCompare(b.title));
  });
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
      if (vals.length) props[propKey(f)] = vals;
      continue;
    }
    // Trim string values: choices ("closed value") properties resolve by
    // exact match against the existing choice blocks — " Slim" would mint
    // a new block and fail Logseq's validation instead of linking Slim
    const typed = f.type === 'number' ? (parseFloat(f.value) || f.value)
      : f.type === 'checkbox' ? Boolean(f.value)
      : String(f.value).trim();
    if (typed === '') continue;
    props[propKey(f)] = typed;
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

// Node values go to the CLI as db ids wherever one is known — an id always
// links that node, while a title can mint an untagged value block under the
// property entity that never shows in the constraint tag's table (verified
// 2026-10-03). Ids come from the picked suggestion (field.ids), else from a
// title match among the constraint class's nodes. A value with neither comes
// from the modal's explicit Create row: it is created as a node of the
// constraint class first, or left as a title for an unconstrained property.
async function resolveNodeValues(payload, graph, props) {
  for (const f of payload.fields ?? []) {
    const key = propKey(f);
    if (f.type !== 'node' || !(key in props)) continue;

    const byIdent = key !== f.name;
    const propMatch = `${byIdent ? '[?p :db/ident ?x]' : '[?p :block/title ?x]'}
        [?p :logseq.property/type :node]
        [?p :logseq.property/classes ?cls]`;
    const propInput = byIdent ? key : edn(f.name);
    const classes = (await cliQuery(graph,
      `[:find ?cls ?clt ?ci :in $ ?x :where ${propMatch}
        [?cls :block/title ?clt] [?cls :db/ident ?ci]]`, `[${propInput}]`))
      .filter(([, , ident]) => String(ident).startsWith('user.class/'));
    const [classId, classTitle] = classes[0] ?? [];

    const members = classes.length
      ? await cliQuery(graph,
        `[:find ?n ?t :in $ % ?x :where ${propMatch}
          (sub ?k ?cls) [?n :block/tags ?k] [?n :block/title ?t]]`,
        `[${SUGGESTION_RULES} ${propInput}]`)
      : [];

    const toId = async (title) => {
      const picked = f.ids?.[title];
      if (Number.isInteger(picked)) return picked;
      if (!classes.length) return title; // unconstrained — the CLI links or creates by title
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

    const value = props[key];
    if (Array.isArray(value)) {
      const ids = [];
      for (const v of value) ids.push(await toId(v));
      props[key] = ids;
    } else {
      props[key] = await toId(value);
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

  // Resolve property names before anything is written: if the lookup fails
  // the save stops here, with no block created and nothing for a Retry to
  // duplicate.
  const props = payload.mode === 'tags' ? clipProps(payload) : {};
  const propIdents = Object.keys(props).some((key) => !IDENT_KEY_RE.test(key))
    ? await httpPropertyIdents()
    : {};

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

  for (const [name, value] of Object.entries(props)) {
    const key = IDENT_KEY_RE.test(name) ? name : (propIdents[name.toLowerCase()] ?? name);
    await callLogseq('logseq.Editor.upsertBlockProperty', [uuid, key, value]);
  }
}

// Property identity in Logseq DB is the ident, not the display name — writing
// by name mints a plugin-namespaced duplicate. Maps lowercased titles to the
// graph's existing property idents (user properties win title collisions with
// plugin-namespaced duplicates). A failed lookup is an error, never a reason
// to write by name: Logseq answers "db-worker has not been initialized" while
// its database worker is down or starting.
async function httpPropertyIdents() {
  let rows;
  try {
    rows = await callLogseq('logseq.DB.datascriptQuery', [
      '[:find ?title ?ident :where [?p :block/tags :logseq.class/Property] [?p :db/ident ?ident] [?p :block/title ?title]]',
    ]);
  } catch (err) {
    throw new Error(`Could not read the graph's properties from Logseq, so nothing was saved (${err.message}). Check that Logseq has finished loading, then Retry.`);
  }
  if (!Array.isArray(rows)) {
    throw new Error("Could not read the graph's properties from Logseq, so nothing was saved. Check that Logseq has finished loading, then Retry.");
  }
  const isUserProp = (id) => String(id).replace(/^:/, '').startsWith('user.property/');
  const propIdents = {};
  rows.forEach(([title, ident]) => {
    if (!title || !ident) return;
    const key = String(title).toLowerCase();
    if (!propIdents[key] || (isUserProp(ident) && !isUserProp(propIdents[key]))) {
      propIdents[key] = ident;
    }
  });
  return propIdents;
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
