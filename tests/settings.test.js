'use strict';
// Token / cliEnabled placement (R13-R15, KTD6): local by default, opt-in sync,
// one-time migration for installs that predate the toggle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chrome, dispatch } = require('./fake-browser');

globalThis.chrome = chrome;
delete globalThis.browser;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

// Minimal DOM so options.js can register its listeners at load.
const stubEl = () => ({ value: '', checked: false, hidden: false, className: '', textContent: '', style: {}, innerHTML: '', addEventListener() {}, querySelectorAll: () => [] });
globalThis.document = { addEventListener() {}, getElementById: () => stubEl(), querySelectorAll: () => [], createElement: stubEl };
globalThis.window = globalThis;

const load = (rel) => vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'extension', rel), 'utf8'), { filename: rel });
load('background/service-worker.js');
load('options/options.js'); // provides writeToken / setTokenSynced

const reset = () => { chrome.storage.sync._data.clear(); chrome.storage.local._data.clear(); };

test('fresh install: token written by options lands in local only (AE4)', async () => {
  reset();
  await writeToken('tok-1');
  assert.equal(chrome.storage.local._data.get('logseqApiToken'), 'tok-1');
  assert.equal(chrome.storage.sync._data.has('logseqApiToken'), false);
  assert.equal(await readToken(), 'tok-1');
});

test('toggle on moves token to sync and clears local; toggle off reverses (AE4)', async () => {
  reset();
  await writeToken('tok-2');
  await setTokenSynced(true);
  assert.equal(chrome.storage.sync._data.get('logseqApiToken'), 'tok-2');
  assert.equal(chrome.storage.local._data.has('logseqApiToken'), false);
  assert.equal(chrome.storage.local._data.get('tokenSynced'), true);
  assert.equal(await readToken(), 'tok-2');
  await writeToken('tok-2b'); // writes follow the toggle
  assert.equal(chrome.storage.sync._data.get('logseqApiToken'), 'tok-2b');
  await setTokenSynced(false);
  assert.equal(chrome.storage.local._data.get('logseqApiToken'), 'tok-2b');
  assert.equal(chrome.storage.sync._data.has('logseqApiToken'), false);
  assert.equal(chrome.storage.local._data.get('tokenSynced'), false);
});

test('existing install with token only in sync keeps working and shows as synced (F4/AE4)', async () => {
  reset();
  chrome.storage.sync._data.set('logseqApiToken', 'old-sync-token');
  assert.equal(await readToken(), 'old-sync-token');
  assert.equal(chrome.storage.local._data.get('tokenSynced'), true);
  assert.equal(chrome.storage.sync._data.get('logseqApiToken'), 'old-sync-token'); // left in place
  const r = await dispatch({ type: 'LQC_API', method: 'logseq.App.getCurrentGraph', args: [] });
  assert.equal(r.ok, true); // HTTP transport found the token
});

test('token in both areas: local wins while toggle is off', async () => {
  reset();
  chrome.storage.local._data.set('logseqApiToken', 'local-wins');
  chrome.storage.sync._data.set('logseqApiToken', 'stale-sync');
  assert.equal(await readToken(), 'local-wins');
  await setTokenSynced(false); // explicit "on this device" removes the stale copy
  assert.equal(chrome.storage.sync._data.has('logseqApiToken'), false);
});

test('cliEnabled set in sync by an old version migrates to local once', async () => {
  reset();
  chrome.storage.sync._data.set('cliEnabled', true);
  assert.equal(await readCliEnabled(), true);
  assert.equal(chrome.storage.local._data.get('cliEnabled'), true);
  assert.equal(chrome.storage.sync._data.has('cliEnabled'), false);
  chrome.storage.sync._data.set('cliEnabled', false); // a later stray sync value is ignored
  assert.equal(await readCliEnabled(), true);
});

test('second profile with sync on and toggle off sees no token', async () => {
  reset(); // sync store empty of tokens because profile A kept it local
  assert.equal(await readToken(), '');
  assert.equal(chrome.storage.sync._data.has('logseqApiToken'), false);
});

test('the duplicated settings helpers are byte-identical in both scripts (drift guard)', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', 'extension', rel), 'utf8');
  const extract = (src, name) => {
    const start = src.indexOf(`async function ${name}(`);
    assert.notEqual(start, -1, `${name} missing`);
    const end = src.indexOf('\n}\n', start);
    return src.slice(start, end + 3);
  };
  for (const name of ['readToken', 'readCliEnabled']) {
    assert.equal(extract(read('background/service-worker.js'), name), extract(read('options/options.js'), name), `${name} drifted`);
  }
});

test('profile B adopts a token profile A synced; A opting out leaves B unsynced, not broken', async () => {
  reset();
  chrome.storage.sync._data.set('logseqApiToken', 'from-A'); // A turned the toggle on
  assert.equal(await readToken(), 'from-A');                  // B adopts it
  assert.equal(chrome.storage.local._data.get('tokenSynced'), true);
  chrome.storage.sync._data.delete('logseqApiToken');         // A turned the toggle off
  assert.equal(await readToken(), '');                        // B has no token now...
  assert.equal(chrome.storage.local._data.get('tokenSynced'), false); // ...and shows as unsynced
  await writeToken('typed-on-B');
  assert.equal(chrome.storage.local._data.get('logseqApiToken'), 'typed-on-B');
  assert.equal(chrome.storage.sync._data.has('logseqApiToken'), false);
});

test('LQC_SAVE replies through sendResponse with the HTTP failure text', async () => {
  reset();
  await writeToken('tok');
  globalThis.fetch = async () => { throw new Error('offline'); };
  const r = await dispatch({ type: 'LQC_SAVE', payload: { mode: 'clipper', url: 'https://x', title: 'X', tags: [], notes: '', highlight: '' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /Could not reach Logseq|No API token/);
});
