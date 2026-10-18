'use strict';
// Minimal in-memory stand-in for the `chrome.*` extension API, enough to load
// extension/background/service-worker.js and extension/options/options.js in
// Node and drive their message listeners and storage code. Only the `chrome`
// global is defined, so the shim (`globalThis.browser ??= chrome`) is exercised.

function makeArea(name) {
  const data = new Map();
  const area = {
    _name: name,
    _data: data,
    async get(keys) {
      if (keys == null) return Object.fromEntries(data);
      if (typeof keys === 'string') return data.has(keys) ? { [keys]: data.get(keys) } : {};
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (data.has(k)) out[k] = data.get(k);
        return out;
      }
      const out = {};
      for (const [k, dflt] of Object.entries(keys)) out[k] = data.has(k) ? data.get(k) : dflt;
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: data.get(k), newValue: v };
        data.set(k, v);
      }
      for (const fn of chrome.storage.onChanged._listeners) fn(changes, name);
    },
    async remove(keys) {
      const changes = {};
      for (const k of [].concat(keys)) { changes[k] = { oldValue: data.get(k) }; data.delete(k); }
      for (const fn of chrome.storage.onChanged._listeners) fn(changes, name);
    },
  };
  return area;
}

function event() {
  const listeners = [];
  return { _listeners: listeners, addListener: (fn) => listeners.push(fn) };
}

const chrome = {
  runtime: {
    onMessage: event(),
    connectNative() { throw new Error('no native host in tests'); },
    getURL: (p) => `chrome-extension://test/${p}`,
    sendMessage: async () => undefined,
  },
  storage: { sync: makeArea('sync'), local: makeArea('local'), onChanged: event() },
  permissions: {
    _granted: new Set(),
    async contains({ permissions }) { return permissions.every((p) => chrome.permissions._granted.has(p)); },
    async request({ permissions }) { permissions.forEach((p) => chrome.permissions._granted.add(p)); return true; },
  },
  commands: { onCommand: event() },
  action: { onClicked: event() },
  tabs: { query: async () => [], sendMessage: async () => {}, create: async () => {} },
  scripting: { executeScript: async () => {} },
};

// Deliver a message to the background listeners the way the browser does:
// a listener that returns true will call sendResponse later; the first
// response wins. Resolves with the response (or undefined if nobody answers).
function dispatch(message) {
  return new Promise((resolve) => {
    let answered = false;
    const sendResponse = (r) => { if (!answered) { answered = true; resolve(r); } };
    let keepOpen = false;
    for (const fn of chrome.runtime.onMessage._listeners) {
      const r = fn(message, { id: 'test' }, sendResponse);
      if (r === true) keepOpen = true;
    }
    if (!keepOpen) setTimeout(() => sendResponse(undefined), 20);
  });
}

module.exports = { chrome, dispatch };
