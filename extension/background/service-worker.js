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

// Proxy Logseq HTTP API calls from content script (content scripts can't
// make cross-origin requests to localhost reliably without host_permissions
// in the background context)
browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'LQC_API') return false;

  callLogseq(message.method, message.args)
    .then(result => sendResponse({ ok: true, result }))
    .catch(err => sendResponse({ ok: false, error: err.message }));

  return true; // keep message channel open for async sendResponse
});

async function callLogseq(method, args) {
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
}
