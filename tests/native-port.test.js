'use strict';
// Native port resilience (R5, R6, AE3): a request in flight when the host dies
// fails with a clear error, and the next request reopens the port.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chrome, dispatch } = require('./fake-browser');

// Fake native host: answers version and graph list; can be killed from the test.
const ports = [];
chrome.runtime.connectNative = () => {
  const port = { onMessage: { _l: [], addListener(f) { this._l.push(f); } }, onDisconnect: { _l: [], addListener(f) { this._l.push(f); } }, error: null };
  port.postMessage = (msg) => {
    if (port.dead) throw new Error('Attempting to use a disconnected port object');
    const reply = (result) => setTimeout(() => port.onMessage._l.forEach((f) => f({ id: msg.id, ok: true, result })), 0);
    if (msg.cmd === 'version') return reply('logseq 0.1.0');
    if (msg.args?.[0] === 'graph' && msg.args?.[1] === 'list') {
      if (port.hang) return; // simulate a host that dies mid-request
      return reply(JSON.stringify({ status: 'ok', data: { graphs: ['Alpha', 'Beta'] } }));
    }
    reply(JSON.stringify({ status: 'ok', data: {} }));
  };
  port.kill = () => { port.dead = true; port.error = { message: 'host exited' }; port.onDisconnect._l.forEach((f) => f(port)); };
  ports.push(port);
  return port;
};

globalThis.chrome = chrome;
delete globalThis.browser;
globalThis.fetch = async () => { throw new Error('offline'); };
chrome.permissions._granted.add('nativeMessaging');
chrome.storage.local._data.set('cliEnabled', true);
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'service-worker.js'), 'utf8'), { filename: 'service-worker.js' });

test('CLI transport comes up on a cold worker and lists graphs', async () => {
  const info = await dispatch({ type: 'LQC_TRANSPORT_INFO' });
  assert.equal(info.name, 'cli');
  const r = await dispatch({ type: 'LQC_OP', op: 'listGraphs' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, ['Alpha', 'Beta']);
  assert.equal(ports.length, 1);
});

test('a request in flight when the host dies fails clearly; the next one reconnects (AE3)', async () => {
  const port = ports.at(-1);
  port.hang = true;
  const pending = dispatch({ type: 'LQC_OP', op: 'listGraphs' });
  await new Promise((r) => setTimeout(r, 5));
  port.kill();
  const failed = await pending;
  assert.equal(failed.ok, false);
  assert.match(failed.error, /host exited|disconnected/i);

  const r = await dispatch({ type: 'LQC_OP', op: 'listGraphs' });
  assert.equal(r.ok, true, r.error);
  assert.equal(ports.length, 2, 'a new port was opened for the next request');
});
