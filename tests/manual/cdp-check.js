'use strict';
// Drives a Chromium-family browser (already started with --remote-debugging-port and
// --load-extension) through the release checklist in docs/verification/chromium-release.md.
// Usage: node cdp-check.js --port 9222 --label "Chrome" --token T --graph DBtestsync [--steps 1,2,3] [--cli-prompt]
//   --cli-prompt : request nativeMessaging with a user gesture and wait for a human to click Allow.
//   --kill-host  : during the CLI save test, kill lqc_host.py to exercise the reconnect path.
const http = require('node:http');
const { execSync } = require('node:child_process');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => {
  if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] == null ? true : arr[i + 1]]);
  return a;
}, []));
const PORT = Number(args.port || 9222);
const LABEL = args.label || 'browser';
const TOKEN = args.token;
const GRAPH = args.graph || 'DBtestsync';
const STEPS = args.steps ? String(args.steps).split(',').map(Number) : null;
const PINNED_ID = 'aambbkcokmgbfhfnipfbbghaihmcgdgo';
const want = (n) => !STEPS || STEPS.includes(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (step, name, ok, detail) => { results.push({ step, name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${step} ${name} :: ${detail}`); };

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; ws.onmessage = (m) => this.onMessage(JSON.parse(m.data)); }
  onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) { const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
    else this.events.push(msg);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params, sessionId })); });
  }
  async attach(targetId) { const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }); return sessionId; }
  async eval(sessionId, expression, opts = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...opts }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

async function findSW(cdp, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('/background/service-worker.js'));
    if (sw) return sw;
    // Wake an idle worker: a runtime message from an extension page starts it.
    if (i % 4 === 1) {
      let ext = targetInfos.find((t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${PINNED_ID}/`));
      if (!ext) { const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${PINNED_ID}/options/options.html` }); await sleep(800); ext = { targetId }; }
      const sid = await cdp.attach(ext.targetId);
      await cdp.eval(sid, `chrome.runtime.sendMessage({ type: 'LQC_TRANSPORT_INFO' }).then(() => 'woke', () => 'woke')`).catch(() => {});
    }
    await sleep(500);
  }
  throw new Error('no extension service worker target found');
}

async function main() {
  const { webSocketDebuggerUrl } = await getJson('/json/version');
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const cdp = new CDP(ws);
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  // ---- 1. Load + ID ----
  let sw = await findSW(cdp);
  const extId = new URL(sw.url).host;
  record(1, 'extension loaded with pinned ID', extId === PINNED_ID, `${extId}`);
  let swSession = await cdp.attach(sw.targetId);
  const swEval = async (expr, opts) => { // re-find the worker if it was stopped
    try { return await cdp.eval(swSession, expr, opts); }
    catch (e) { if (!/No target|Target closed|Session/i.test(e.message)) throw e; sw = await findSW(cdp); swSession = await cdp.attach(sw.targetId); return cdp.eval(swSession, expr, opts); }
  };

  // Make sure the options page exists (it also serves as a long-lived extension page).
  const { targetId: optTarget } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/options/options.html` });
  await sleep(800);
  const optSession = await cdp.attach(optTarget);

  // Token into local storage, CLI off, as a fresh install would do via the options page.
  await cdp.eval(optSession, `(async () => { await chrome.storage.local.clear(); await chrome.storage.sync.clear(); await writeToken(${JSON.stringify(TOKEN)}); await chrome.storage.local.set({ cliEnabled: false }); return 'ok'; })()`);

  // ---- 2. LNA / HTTP reachability ----
  if (want(2)) {
    try {
      const r = await swEval(`(async () => { const g = await httpTransport.call('logseq.App.getCurrentGraph', []); return JSON.stringify(g); })()`);
      record(2, 'HTTP API reachable from service worker (LNA)', true, r.slice(0, 120));
    } catch (e) { record(2, 'HTTP API reachable from service worker (LNA)', false, e.message); }
  }

  // ---- 3. Shortcut path: activeTab is granted only by a real gesture, so a human presses Alt+Shift+L ----
  let pageSession, pageTarget;
  if (want(3)) {
    ({ targetId: pageTarget } = await cdp.send('Target.createTarget', { url: 'https://example.com/' }));
    await sleep(1500);
    pageSession = await cdp.attach(pageTarget);
    await cdp.send('Target.activateTarget', { targetId: pageTarget });
    console.log('>>> In the browser window, on the example.com tab, press Alt+Shift+L twice (waiting up to 120s)...');
    let hosts = 0, hasShadow = false;
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      hosts = await cdp.eval(pageSession, `document.querySelectorAll('#lqc-host').length`);
      if (hosts) { await sleep(4000); hosts = await cdp.eval(pageSession, `document.querySelectorAll('#lqc-host').length`); hasShadow = await cdp.eval(pageSession, `!!document.getElementById('lqc-host')?.shadowRoot?.querySelector('*')`); break; }
    }
    record(3, 'shortcut opens the modal; two presses leave exactly one host', hosts === 1 && hasShadow, `hosts=${hosts} shadow=${hasShadow}`);
  }

  const clipPayload = (tag, suffix) => ({ mode: 'clipper', url: `https://example.com/${suffix}`, title: `LQC ${LABEL} ${suffix}`, tags: [tag], newTags: [tag], notes: `automated checklist ${new Date().toISOString()}`, highlight: '' });

  // ---- 4/5. HTTP saves (into the open graph) ----
  if (want(4)) {
    try {
      const r = await swEval(`handleSaveOp(${JSON.stringify(clipPayload('lqc-test', 'http-clip'))}).then(() => 'saved')`);
      record(4, 'Web Clipper save over HTTP', r === 'saved', r);
    } catch (e) { record(4, 'Web Clipper save over HTTP', false, e.message); }
  }
  if (want(5)) {
    try {
      // Static-config style Tag Properties payload: a text field on the tag.
      const payload = { mode: 'tags', url: 'https://example.com/http-tagprops', title: `LQC ${LABEL} tagprops`, tagName: 'testtag', fields: [{ name: 'rec-source', type: 'node', value: 'lqc-test-source' }] };
      const r = await swEval(`handleSaveOp(${JSON.stringify(payload)}).then(() => 'saved')`);
      record(5, 'Tag Properties save over HTTP', r === 'saved', r);
    } catch (e) { record(5, 'Tag Properties save over HTTP', false, e.message); }
  }

  // ---- 6. CLI detect ----
  if (want(6)) {
    try {
      let granted;
      if (args['cli-prompt']) {
        console.log('>>> Click "Allow" on the permission prompt in the browser window...');
        granted = await cdp.eval(optSession, `chrome.permissions.request({ permissions: ['nativeMessaging'] })`, { userGesture: true });
      } else {
        granted = await cdp.eval(optSession, `chrome.permissions.contains({ permissions: ['nativeMessaging'] })`);
      }
      await cdp.eval(optSession, `chrome.storage.local.set({ cliEnabled: true })`);
      await sleep(300);
      const det = await swEval(`cliReady.then((r) => JSON.stringify(r))`);
      const info = await swEval(`cliReady.then(() => { const t = activeTransport(); return JSON.stringify({ name: t.name, reason: cliUnavailableReason }); })`);
      const graphs = await swEval(`handleOp({ op: 'listGraphs' }).then((g) => JSON.stringify(g))`);
      const ok = granted && JSON.parse(info).name === 'cli' && JSON.parse(graphs).includes(GRAPH);
      record(6, 'CLI transport active and lists graphs', ok, `granted=${granted} detect=${det} info=${info} graphs=${graphs.slice(0, 100)}`);
    } catch (e) { record(6, 'CLI transport active and lists graphs', false, e.message); }
  }

  const ensureCli = async () => {
    await cdp.eval(optSession, `chrome.storage.local.set({ cliEnabled: true })`); await sleep(300);
    const info = JSON.parse(await swEval(`cliReady.then(() => JSON.stringify({ name: activeTransport().name, reason: cliUnavailableReason }))`));
    if (info.name !== 'cli') throw new Error('CLI transport not active: ' + info.reason);
  };

  // ---- 7. CLI saves into the scratch graph ----
  if (want(7)) {
    try {
      await ensureCli();
      const r = await swEval(`handleSaveOp(${JSON.stringify({ ...clipPayload('lqc-test', 'cli-clip'), graph: GRAPH })}).then(() => 'saved')`);
      record(7, 'Web Clipper save over CLI', r === 'saved', r);
      const field = { name: 'rec-source', type: 'node', value: 'lqc-test-source' };
      const payload = { mode: 'tags', graph: GRAPH, url: 'https://example.com/cli-tagprops', title: `LQC ${LABEL} cli tagprops`, tagName: 'testtag', fields: [field] };
      const r2 = await swEval(`handleSaveOp(${JSON.stringify(payload)}).then(() => 'saved')`);
      record(7, 'Tag Properties save over CLI', r2 === 'saved', `${r2} field=${JSON.stringify(field)}`);
    } catch (e) { record(7, 'saves over CLI', false, e.message); }
  }

  // ---- 8. Worker restart + host kill ----
  if (want(8)) {
    try {
      await ensureCli(); console.log('step8: cli ensured');
      await cdp.send('ServiceWorker.enable', {}, optSession); console.log('step8: sw domain enabled');
      await cdp.send('ServiceWorker.stopAllWorkers', {}, optSession); console.log('step8: stopAllWorkers sent');
      await sleep(1500);
      const { targetInfos: after } = await cdp.send('Target.getTargets');
      const stillUp = after.some((t) => t.targetId === sw.targetId);
      console.log('step8: old worker target still listed? ' + stillUp);
      sw = await findSW(cdp); swSession = await cdp.attach(sw.targetId); console.log('step8: worker re-attached (new target: ' + !stillUp + ')');
      const r = await swEval(`handleSaveOp(${JSON.stringify({ ...clipPayload('lqc-test', 'after-restart'), graph: GRAPH })}).then(() => 'saved')`);
      record(8, 'after worker stop: CLI state rebuilt and save succeeds', r === 'saved', r);
      if (args['kill-host']) {
        const p = swEval(`handleSaveOp(${JSON.stringify({ ...clipPayload('lqc-test', 'killed-mid-save'), graph: GRAPH })}).then(() => 'saved', (e) => 'ERR:' + e.message)`);
        await sleep(150); console.log('step8: killing host');
        try { execSync('pkill -f "lqc_host.py.*chrome-extension" || pkill -n -f lqc_host.py'); } catch { /* none */ }
        const first = await p; console.log('step8: first settled ' + first);
        const second = await swEval(`handleSaveOp(${JSON.stringify({ ...clipPayload('lqc-test', 'after-kill'), graph: GRAPH })}).then(() => 'saved', (e) => 'ERR:' + e.message)`);
        record(8, 'host killed mid-save: that save fails, next reconnects', first.startsWith('ERR') && second === 'saved', `first=${first} second=${second}`);
      }
    } catch (e) { record(8, 'worker restart', false, e.message); }
  }

  // ---- 9. Token toggle ----
  if (want(9)) {
    try {
      const r = await cdp.eval(optSession, `(async () => {
        const out = {};
        out.before = { local: (await chrome.storage.local.get('logseqApiToken')).logseqApiToken ? 'set' : 'empty', sync: (await chrome.storage.sync.get('logseqApiToken')).logseqApiToken ? 'set' : 'empty' };
        await setTokenSynced(true);
        out.on = { local: (await chrome.storage.local.get('logseqApiToken')).logseqApiToken ? 'set' : 'empty', sync: (await chrome.storage.sync.get('logseqApiToken')).logseqApiToken ? 'set' : 'empty', flag: (await chrome.storage.local.get('tokenSynced')).tokenSynced };
        await setTokenSynced(false);
        out.off = { local: (await chrome.storage.local.get('logseqApiToken')).logseqApiToken ? 'set' : 'empty', sync: (await chrome.storage.sync.get('logseqApiToken')).logseqApiToken ? 'set' : 'empty', flag: (await chrome.storage.local.get('tokenSynced')).tokenSynced };
        return JSON.stringify(out);
      })()`);
      const o = JSON.parse(r);
      const ok = o.before.local === 'set' && o.before.sync === 'empty' && o.on.local === 'empty' && o.on.sync === 'set' && o.on.flag === true && o.off.local === 'set' && o.off.sync === 'empty' && o.off.flag === false;
      record(9, 'token toggle moves between local and sync', ok, r);
    } catch (e) { record(9, 'token toggle', false, e.message); }
  }

  // ---- 10. Upgrade from a sync-only token ----
  if (want(10)) {
    try {
      const r = await cdp.eval(optSession, `(async () => {
        await chrome.storage.local.remove(['logseqApiToken', 'tokenSynced']);
        await chrome.storage.sync.set({ logseqApiToken: ${JSON.stringify(TOKEN)} });
        const t = await readToken();
        const flag = (await chrome.storage.local.get('tokenSynced')).tokenSynced;
        return JSON.stringify({ gotToken: t === ${JSON.stringify(TOKEN)}, flag });
      })()`);
      const o = JSON.parse(r);
      const http = await swEval(`httpTransport.call('logseq.App.getCurrentGraph', []).then(() => 'ok', (e) => 'ERR:' + e.message)`);
      record(10, 'pre-toggle install keeps its synced token and saves over HTTP', o.gotToken && o.flag === true && http === 'ok', `${r} http=${http}`);
      await cdp.eval(optSession, `setTokenSynced(false)`); // leave the profile tidy
    } catch (e) { record(10, 'upgrade path', false, e.message); }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n== ${LABEL}: ${results.length - failed}/${results.length} checks passed ==`);
  console.log(JSON.stringify(results));
  ws.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('driver error:', e); process.exit(2); });
