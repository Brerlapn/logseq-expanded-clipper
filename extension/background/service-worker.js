// Route keyboard command and toolbar click to the active tab's content script
browser.commands.onCommand.addListener(async (command) => {
  if (command === 'open-modal') await sendOpen();
});

browser.action.onClicked.addListener(async () => {
  await sendOpen();
});

async function sendOpen() {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return;
  try {
    await browser.tabs.sendMessage(tab.id, { type: 'LQC_OPEN' });
  } catch {
    // Content script unavailable on browser-internal pages — nothing to do
  }
}

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
