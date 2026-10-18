'use strict';
// Firefox Remote Debugging Protocol driver for the release checklist (Firefox counterpart of
// tests/manual/cdp-check.js). Usage: node rdp-check.js --port 6000 --ext /path/in/sandbox --token-file F --graph DBtestsync [--steps 1,3,4]
const net = require('node:net');
const fs = require('node:fs');
const { execSync } = require('node:child_process');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => {
  if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] == null ? true : arr[i + 1]]);
  return a;
}, []));
const PORT = Number(args.port || 6000);
const LABEL = args.label || 'Firefox';
const TOKEN = fs.readFileSync(args['token-file'], 'utf8').trim();
const GRAPH = args.graph || 'DBtestsync';
const EXT_ID = 'logseqexpandedclipper@brerlapn.org';
const STEPS = args.steps ? String(args.steps).split(',').map(Number) : null;
const want = (n) => !STEPS || STEPS.includes(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (step, name, ok, detail) => { results.push({ step, name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${step} ${name} :: ${detail}`); };

class RDP {
  constructor(sock) { this.sock = sock; this.buf = ''; this.waiters = []; this.events = []; sock.on('data', (d) => this.onData(d.toString())); }
  onData(s) {
    this.buf += s;
    for (;;) {
      const i = this.buf.indexOf(':'); if (i < 0) return;
      const len = Number(this.buf.slice(0, i)); if (Buffer.byteLength(this.buf) < i + 1 + len) return;
      const body = Buffer.from(this.buf.slice(i + 1)).subarray(0, len).toString();
      const msg = JSON.parse(body); this.buf = Buffer.from(this.buf.slice(i + 1)).subarray(len).toString();
      const w = this.waiters.findIndex((x) => x.match(msg));
      if (w >= 0) { const { resolve } = this.waiters.splice(w, 1)[0]; resolve(msg); } else this.events.push(msg);
    }
  }
  wait(match, timeout = 30000) {
    const i = this.events.findIndex(match); if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0]);
    return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('rdp timeout')), timeout); this.waiters.push({ match, resolve: (m) => { clearTimeout(t); resolve(m); } }); });
  }
  async request(to, type, extra = {}) {
    const s = JSON.stringify({ to, type, ...extra }); this.sock.write(`${Buffer.byteLength(s)}:${s}`);
    const r = await this.wait((m) => m.from === to && !m.type);
    if (r.error) throw new Error(`${r.error}: ${r.message}`);
    return r;
  }
  async eval(consoleActor, text) {
    const s = JSON.stringify({ to: consoleActor, type: 'evaluateJSAsync', text, mapped: { await: true } }); this.sock.write(`${Buffer.byteLength(s)}:${s}`);
    const { resultID } = await this.wait((m) => m.from === consoleActor && m.resultID && !m.type);
    const r = await this.wait((m) => m.from === consoleActor && m.type === 'evaluationResult' && m.resultID === resultID, 60000);
    if (r.exception != null || r.exceptionMessage) throw new Error(r.exceptionMessage || JSON.stringify(r.exception));
    const v = r.result;
    return v && typeof v === 'object' && v.type === 'undefined' ? undefined : v;
  }
  async consoleFor(descriptorActor, urlMatch) {
    this.cache ??= new Map(); if (this.cache.has(descriptorActor)) return this.cache.get(descriptorActor);
    const { actor: watcher } = await this.request(descriptorActor, 'getWatcher', { isServerTargetSwitchingEnabled: true, isPopupDebuggingEnabled: false });
    const s = JSON.stringify({ to: watcher, type: 'watchTargets', targetType: 'frame' }); this.sock.write(`${Buffer.byteLength(s)}:${s}`);
    const deadline = Date.now() + 15000; const seen = [];
    while (Date.now() < deadline) {
      const ev = await this.wait((m) => m.from === watcher && m.type === 'target-available-form', 5000).catch(() => null);
      if (!ev) break;
      seen.push(ev.target.url);
      if (!urlMatch || (ev.target.url && ev.target.url.includes(urlMatch))) { this.cache.set(descriptorActor, ev.target.consoleActor); return ev.target.consoleActor; }
    }
    throw new Error('no target matching ' + urlMatch + ' among ' + seen.join(','));
  }
}

async function main() {
  const sock = net.connect(PORT, '127.0.0.1'); await new Promise((r, j) => { sock.once('connect', r); sock.once('error', j); });
  const rdp = new RDP(sock);
  await rdp.wait((m) => m.from === 'root' && m.applicationType);
  const root = await rdp.request('root', 'getRoot');

  // ---- 1. Load (temporary add-on, like about:debugging) ----
  let addons = (await rdp.request('root', 'listAddons')).addons;
  let addon = addons.find((a) => a.id === EXT_ID);
  if (!addon) {
    await rdp.request(root.addonsActor, 'installTemporaryAddon', { addonPath: args.ext, openDevTools: false });
    await sleep(1500);
    addons = (await rdp.request('root', 'listAddons')).addons; addon = addons.find((a) => a.id === EXT_ID);
  }
  if (args.reload && addon) { await rdp.request(addon.actor, 'reload'); await sleep(2500); addons = (await rdp.request('root', 'listAddons')).addons; addon = addons.find((a) => a.id === EXT_ID); console.log('reloaded add-on'); }
  record(1, 'extension loaded with gecko ID', !!addon, addon ? `${addon.id} v${addon.version} ${addon.name}` : 'not listed');
  // Firefox MV3 background is an event page: wake it from an existing options tab before attaching.
  const existingOpt = (await rdp.request('root', 'listTabs')).tabs.find((t) => t.url.includes('options/options.html'));
  if (existingOpt) {
    const c = await rdp.consoleFor(existingOpt.actor, 'options.html');
    await rdp.eval(c, `browser.runtime.sendMessage({ type: 'LQC_TRANSPORT_INFO' }).then(() => 'woke', () => 'woke')`).catch(() => {});
    await sleep(800);
  }
  const bg = await rdp.consoleFor(addon.actor, 'background');
  const bgEval = (t) => rdp.eval(bg, t);
  const ver = await bgEval(`browser.runtime.getManifest().version`);
  console.log('background reachable, manifest version', ver);

  // Options page as the long-lived extension page.
  if (!existingOpt) { await bgEval(`browser.tabs.create({ url: browser.runtime.getURL('options/options.html') }).then(t => t.id)`); await sleep(1500); }
  const tabs = (await rdp.request('root', 'listTabs')).tabs;
  const optTab = tabs.find((t) => t.url.includes('options/options.html'));
  if (!optTab) throw new Error('options tab not found: ' + tabs.map((t) => t.url).join(','));
  const opt = await rdp.consoleFor(optTab.actor, 'options.html');
  const optEval = (t) => rdp.eval(opt, t);

  await optEval(`(async () => { await browser.storage.local.clear(); await browser.storage.sync.clear(); await writeToken(${JSON.stringify(TOKEN)}); await browser.storage.local.set({ cliEnabled: false }); return 'ok'; })()`);

  if (want(2)) {
    try { const r = await bgEval(`httpTransport.call('logseq.App.getCurrentGraph', []).then(g => JSON.stringify(g))`); record(2, 'HTTP API reachable from background', true, String(r).slice(0, 120)); }
    catch (e) { record(2, 'HTTP API reachable from background', false, e.message); }
  }

  // ---- 3. Shortcut: needs a real keypress ----
  if (want(3)) {
    await bgEval(`browser.tabs.create({ url: 'https://example.com/', active: true }).then(t => t.id)`);
    await sleep(2500);
    const pageTab = (await rdp.request('root', 'listTabs')).tabs.find((t) => t.url.startsWith('https://example.com'));
    const page = await rdp.consoleFor(pageTab.actor, 'example.com');
    console.log('>>> In the Firefox window, on the example.com tab, press Alt+Shift+L twice (waiting up to 180s)...');
    let hosts = 0, hasShadow = false;
    for (let i = 0; i < 180; i++) {
      await sleep(1000);
      hosts = await rdp.eval(page, `document.querySelectorAll('#lqc-host').length`);
      if (hosts) { await sleep(4000); hosts = await rdp.eval(page, `document.querySelectorAll('#lqc-host').length`); hasShadow = await rdp.eval(page, `!!document.getElementById('lqc-host')?.shadowRoot?.querySelector('*')`); break; }
    }
    record(3, 'shortcut opens the modal; two presses leave exactly one host', hosts === 1 && hasShadow, `hosts=${hosts} shadow=${hasShadow}`);
  }

  const clipPayload = (tag, suffix) => ({ mode: 'clipper', url: `https://example.com/${suffix}`, title: `LQC ${LABEL} ${suffix}`, tags: [tag], newTags: [tag], notes: `automated checklist ${new Date().toISOString()}`, highlight: '' });

  if (want(4)) {
    try { const r = await bgEval(`handleSaveOp(${JSON.stringify(clipPayload('lqc-test', 'ff-http-clip'))}).then(() => 'saved')`); record(4, 'Web Clipper save over HTTP', r === 'saved', String(r)); }
    catch (e) { record(4, 'Web Clipper save over HTTP', false, e.message); }
  }
  if (want(5)) {
    try {
      const payload = { mode: 'tags', url: 'https://example.com/ff-http-tagprops', title: `LQC ${LABEL} tagprops`, tagName: 'testtag', fields: [{ name: 'rec-source', type: 'node', value: 'lqc-test-source' }] };
      const r = await bgEval(`handleSaveOp(${JSON.stringify(payload)}).then(() => 'saved')`); record(5, 'Tag Properties save over HTTP', r === 'saved', String(r));
    } catch (e) { record(5, 'Tag Properties save over HTTP', false, e.message); }
  }

  if (args.grant) {
    const { processDescriptor } = await rdp.request('root', 'getProcess', { id: 0 });
    let pc;
    try { const { form } = await rdp.request(processDescriptor.actor, 'getTarget'); pc = form.consoleActor; }
    catch (e) { pc = await rdp.consoleFor(processDescriptor.actor, ''); }
    const g = await rdp.eval(pc, `(async () => { const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs'); await ExtensionPermissions.add(${JSON.stringify(EXT_ID)}, { permissions: ['nativeMessaging'], origins: [], data_collection: [] }); const p = await ExtensionPermissions.get(${JSON.stringify(EXT_ID)}); return JSON.stringify(p); })()`);
    console.log('granted via ExtensionPermissions:', g);
    await sleep(500);
  }
  if (want(6)) {
    try {
      const granted = await optEval(`browser.permissions.contains({ permissions: ['nativeMessaging'] })`);
      await optEval(`browser.storage.local.set({ cliEnabled: true })`); await sleep(500);
      const det = await bgEval(`cliReady.then(r => JSON.stringify(r))`);
      const info = await bgEval(`cliReady.then(() => JSON.stringify({ name: activeTransport().name, reason: cliUnavailableReason }))`);
      const graphs = await bgEval(`handleOp({ op: 'listGraphs' }).then(g => JSON.stringify(g))`);
      const ok = granted && JSON.parse(info).name === 'cli' && String(graphs).includes(GRAPH);
      record(6, 'CLI transport active and lists graphs', ok, `granted=${granted} detect=${det} info=${info} graphs=${String(graphs).slice(0, 100)}`);
    } catch (e) { record(6, 'CLI transport active and lists graphs', false, e.message); }
  }
  const ensureCli = async () => {
    await optEval(`browser.storage.local.set({ cliEnabled: true })`); await sleep(500);
    const info = JSON.parse(await bgEval(`cliReady.then(() => JSON.stringify({ name: activeTransport().name, reason: cliUnavailableReason }))`));
    if (info.name !== 'cli') throw new Error('CLI transport not active: ' + info.reason);
  };
  if (want(7)) {
    try {
      await ensureCli();
      const r = await bgEval(`handleSaveOp(${JSON.stringify({ ...clipPayload('lqc-test', 'ff-cli-clip'), graph: GRAPH })}).then(() => 'saved')`);
      record(7, 'Web Clipper save over CLI', r === 'saved', String(r));
      const field = { name: 'rec-source', type: 'node', value: 'lqc-test-source' };
      const payload = { mode: 'tags', graph: GRAPH, url: 'https://example.com/ff-cli-tagprops', title: `LQC ${LABEL} cli tagprops`, tagName: 'testtag', fields: [field] };
      const r2 = await bgEval(`handleSaveOp(${JSON.stringify(payload)}).then(() => 'saved')`);
      record(7, 'Tag Properties save over CLI', r2 === 'saved', String(r2));
      if (args['kill-host']) {
        const p = bgEval(`handleSaveOp(${JSON.stringify({ ...clipPayload('lqc-test', 'ff-killed-mid-save'), graph: GRAPH })}).then(() => 'saved', e => 'ERR:' + e.message)`);
        await sleep(150); try { execSync('pkill -n -f lqc_host.py'); } catch { /* none */ }
        const first = await p;
        const second = await bgEval(`handleSaveOp(${JSON.stringify({ ...clipPayload('lqc-test', 'ff-after-kill'), graph: GRAPH })}).then(() => 'saved', e => 'ERR:' + e.message)`);
        record(7, 'host killed mid-save: that save fails, next reconnects', String(first).startsWith('ERR') && second === 'saved', `first=${first} second=${second}`);
      }
    } catch (e) { record(7, 'saves over CLI', false, e.message); }
  }

  if (want(9)) {
    try {
      const r = await optEval(`(async () => {
        const g = async (area) => (await browser.storage[area].get('logseqApiToken')).logseqApiToken ? 'set' : 'empty';
        const f = async () => (await browser.storage.local.get('tokenSynced')).tokenSynced;
        const out = { before: { local: await g('local'), sync: await g('sync') } };
        await setTokenSynced(true); out.on = { local: await g('local'), sync: await g('sync'), flag: await f() };
        await setTokenSynced(false); out.off = { local: await g('local'), sync: await g('sync'), flag: await f() };
        return JSON.stringify(out);
      })()`);
      const o = JSON.parse(r);
      const ok = o.before.local === 'set' && o.before.sync === 'empty' && o.on.local === 'empty' && o.on.sync === 'set' && o.on.flag === true && o.off.local === 'set' && o.off.sync === 'empty' && o.off.flag === false;
      record(9, 'token toggle moves between local and sync', ok, r);
    } catch (e) { record(9, 'token toggle', false, e.message); }
  }
  if (want(10)) {
    try {
      const r = await optEval(`(async () => {
        await browser.storage.local.remove(['logseqApiToken', 'tokenSynced']);
        await browser.storage.sync.set({ logseqApiToken: ${JSON.stringify(TOKEN)} });
        const t = await readToken(); const flag = (await browser.storage.local.get('tokenSynced')).tokenSynced;
        return JSON.stringify({ gotToken: t === ${JSON.stringify(TOKEN)}, flag });
      })()`);
      const o = JSON.parse(r);
      const http = await bgEval(`httpTransport.call('logseq.App.getCurrentGraph', []).then(() => 'ok', e => 'ERR:' + e.message)`);
      record(10, 'pre-toggle install keeps its synced token and saves over HTTP', o.gotToken && o.flag === true && http === 'ok', `${r} http=${http}`);
      await optEval(`setTokenSynced(false)`);
    } catch (e) { record(10, 'upgrade path', false, e.message); }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n== ${LABEL}: ${results.length - failed}/${results.length} checks passed ==`);
  console.log(JSON.stringify(results));
  sock.end(); process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('driver error:', e); process.exit(2); });
