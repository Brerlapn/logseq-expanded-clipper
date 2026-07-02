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
// All Logseq traffic flows through one active transport. Capabilities gate
// feature behavior: the HTTP API can only talk to the graph currently open in
// the app, so it can't route writes, list graphs, or read tag schemas.

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

let transport = httpTransport; // CliTransport (native messaging) plugs in here — Tranche 3

// Proxy Logseq API calls from content script (content scripts can't make
// cross-origin requests to localhost reliably without host_permissions in
// the background context)
browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'LQC_API') return false;

  callLogseq(message.method, message.args)
    .then(result => sendResponse({ ok: true, result }))
    .catch(err => sendResponse({ ok: false, error: err.message }));

  return true; // keep message channel open for async sendResponse
});

browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'LQC_TRANSPORT_INFO') {
    return Promise.resolve({ name: transport.name, capabilities: transport.capabilities });
  }
});

async function callLogseq(method, args) {
  const result = await transport.call(method, args);

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
