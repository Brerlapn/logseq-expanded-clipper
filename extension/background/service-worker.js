// Route keyboard command and toolbar click to the active tab's content script
browser.commands.onCommand.addListener(async (command) => {
  console.log('[LQC-cmd] command fired:', command);
  if (command !== 'open-modal') return;
  let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  console.log('[LQC-cmd] tab found:', tab?.id, tab?.url?.slice(0, 60));
  if (tab) await openInTab(tab.id);
});

// onClicked receives the tab directly — no query needed
browser.action.onClicked.addListener(async (tab) => {
  console.log('[LQC-a] action.onClicked fired, tabId:', tab?.id, tab?.url?.slice(0, 60));
  if (tab?.id) await openInTab(tab.id);
});

async function openInTab(tabId) {
  console.log('[LQC-b] openInTab tabId:', tabId);

  try {
    await browser.tabs.sendMessage(tabId, { type: 'LQC_OPEN' });
    console.log('[LQC-b] sendMessage succeeded');
    return;
  } catch (e) {
    console.log('[LQC-b] sendMessage failed:', e.message);
  }

  console.log('[LQC-c] attempting scripting.executeScript files');
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: ['content/modal.js'] });
    console.log('[LQC-d] file injection succeeded, calling __lqcOpen');
    await browser.scripting.executeScript({ target: { tabId }, func: () => { window.__lqcOpen?.(); } });
    console.log('[LQC-e] __lqcOpen call done');
  } catch (e) {
    console.log('[LQC-c] executeScript failed:', e.message);
  }
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
