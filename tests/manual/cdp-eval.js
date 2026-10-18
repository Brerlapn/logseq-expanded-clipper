'use strict';
// node cdp-eval.js <port> <target: sw|opt|page:<urlprefix>> <expression>
const http = require('node:http');
const [port, target, expr] = process.argv.slice(2);
const getJson = (p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
(async () => {
  const { webSocketDebuggerUrl } = await getJson('/json/version');
  const ws = new WebSocket(webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { result: { targetInfos } } = await send('Target.getTargets');
  let t;
  if (target === 'sw') t = targetInfos.find((x) => x.url.includes('/background/service-worker.js'));
  else if (target === 'opt') t = targetInfos.find((x) => x.url.includes('/options/options.html'));
  else t = targetInfos.find((x) => x.url.startsWith(target.slice(5)));
  if (!t) { console.log('targets:', targetInfos.map((x) => x.type + ' ' + x.url).join('\n')); process.exit(1); }
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
  console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? r, null, 0));
  ws.close();
})();
