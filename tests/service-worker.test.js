'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chrome, dispatch } = require('./fake-browser');

// Load the background script with only `chrome` defined, as Chromium does.
globalThis.chrome = chrome;
delete globalThis.browser;
globalThis.fetch = async () => { throw new Error('offline'); };
const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'service-worker.js'), 'utf8');
vm.runInThisContext(src, { filename: 'service-worker.js' });

test('shim defines browser from chrome', () => {
  assert.equal(globalThis.browser, chrome);
});

test('LQC_TRANSPORT_INFO answers via sendResponse (AE1)', async () => {
  const r = await dispatch({ type: 'LQC_TRANSPORT_INFO' });
  assert.equal(r.name, 'http');
  assert.deepEqual(r.capabilities, { routeWrites: false, listGraphs: false, readSchemas: false });
  assert.match(r.reason, /not enabled/);
});

test('LQC_CLI_DETECT answers via sendResponse', async () => {
  const r = await dispatch({ type: 'LQC_CLI_DETECT' });
  assert.equal(r.available, false);
});

test('LQC_OP rejection surfaces as {ok:false,error}', async () => {
  const r = await dispatch({ type: 'LQC_OP', op: 'nope' });
  assert.equal(r.ok, false);
  assert.match(r.error, /CLI transport not available/);
});

test('LQC_API without a token reports the settings error', async () => {
  const r = await dispatch({ type: 'LQC_API', method: 'logseq.App.getCurrentGraph', args: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /No API token/);
});

test('unknown message types are left for other listeners', async () => {
  const r = await dispatch({ type: 'SOMETHING_ELSE' });
  assert.equal(r, undefined);
});
