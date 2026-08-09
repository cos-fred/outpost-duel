/*
 * server/test.js — self-contained integration test (no dependencies beyond 'ws').
 *
 *   npm test
 *
 * Spawns the server on an ephemeral port, then checks:
 *   - /healthz, /api/ice, static index.html, path-traversal guard
 *   - WebSocket signaling: room join, peer notification, offer/answer relay,
 *     full-room refusal for a third player, peer_left on disconnect.
 * Exits 0 only if every check passes.
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');

function rawGet(path, port) {
  return new Promise((resolve) => {
    const r = http.request({ host: 'localhost', port, path, method: 'GET' }, (rs) => {
      rs.resume();
      resolve(rs.statusCode || 0);
    });
    r.on('error', () => resolve(0));
    r.end();
  });
}

const ROOM = 'AB12C';
const PORT = 11899;
let failures = 0;

function fail(msg) { failures++; console.error('FAIL:', msg); }
function ok(msg) { console.log('ok -', msg); }

function timeout(ms) { return new Promise((_, j) => setTimeout(() => j(new Error('timeout (' + ms + 'ms)')), ms)); }

(async () => {
  const server = spawn(process.execPath, ['index.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });

  // ---- wait for /healthz ------------------------------------------------------
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { const r = await fetch('http://localhost:' + PORT + '/healthz'); if (r.ok) up = true; }
    catch (e) { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (!up) { console.error('server never came up'); process.exit(1); }
  ok('/healthz responds');

  // ---- static + ice + traversal ------------------------------------------------
  const home = await (await fetch('http://localhost:' + PORT + '/')).text();
  /<script/.test(home) ? ok('index.html served (has script tags)') : fail('index.html content missing');

  const ice = await (await fetch('http://localhost:' + PORT + '/api/ice')).json();
  Array.isArray(ice.servers) && ice.servers.length >= 3 ? ok('/api/ice returns ' + ice.servers.length + ' STUN/TURN servers') : fail('/api/ice bad: ' + JSON.stringify(ice));

  const trav = await rawGet('/../../../../../../../Windows/System32/drivers/etc/hosts', PORT);
  if (trav === 403) ok('path traversal blocked (403)'); else fail('path traversal not blocked, got ' + trav);

  // ---- websocket signaling -----------------------------------------------------
  function conn(role) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://localhost:' + PORT + '/ws');
      const c = { ws, events: [], sigs: [] };
      ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room: ROOM, role }));
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        c.events.push(m.type);
        if (m.type === 'joined') resolve(c);
        else if (m.type === 'sig') c.sigs.push(m.msg);
      };
      ws.onerror = () => reject(new Error(role + ' ws error'));
      setTimeout(() => reject(new Error(role + ' join timeout')), 4000);
    });
  }
  function expectEvent(ws, type, ms) {
    return Promise.race([
      timeout(ms || 3000).then(() => { throw new Error('no ' + type); }),
      new Promise((res) => {
        const h = (e) => { const m = JSON.parse(e.data); if (m.type === type) { ws.removeEventListener('message', h); res(m); } };
        ws.addEventListener('message', h);
      }),
    ]);
  }

  // bad room code rejected
  const bad = new WebSocket('ws://localhost:' + PORT + '/ws');
  const badPromise = expectEvent(bad, 'err');
  bad.onopen = () => bad.send(JSON.stringify({ type: 'join', room: 'x1', role: 'host' }));
  const badMsg = await badPromise;
  badMsg.msg === 'BAD_ROOM' ? ok('invalid room code rejected') : fail('bad room: ' + badMsg.msg);
  bad.close();

  const host = await conn('host');
  host.ws.send(JSON.stringify({ type: 'pub', room: ROOM, msg: { t: 'hello' } }));
  const guest = await conn('guest');
  ok('host and guest both joined');

  await Promise.all([expectEvent(host.ws, 'peer'), expectEvent(guest.ws, 'peer')]);
  ok('both sides notified "peer"');

  guest.ws.send(JSON.stringify({ type: 'pub', room: ROOM, msg: { t: 'answer', s: 'ANS', c: [] } }));
  const ans = await Promise.race([
    expectEvent(host.ws, 'sig').then(() => host.sigs[host.sigs.length - 1]),
    timeout(2500),
  ]);
  ans && ans.t === 'answer' && ans.s === 'ANS'
    ? ok('answer relayed to host')
    : fail('answer relay failed: ' + JSON.stringify(ans));

  // third guest on same code => refused
  const third = new WebSocket('ws://localhost:' + PORT + '/ws');
  const fullPromise = expectEvent(third, 'full');
  third.onopen = () => third.send(JSON.stringify({ type: 'join', room: ROOM, role: 'guest' }));
  const full = await fullPromise;
  full.type === 'full' ? ok('third seat refused (room full)') : fail('room not full');
  third.close();

  // host disconnects => guest notified
  host.ws.close();
  await expectEvent(guest.ws, 'peer_left');
  ok('peer_left delivered on disconnect');

  guest.ws.close();

  // ---- shutdown ----------------------------------------------------------------
  server.kill('SIGTERM');
  await Promise.race([new Promise((r) => server.on('exit', r)), timeout(4000)]);
  ok('server shut down cleanly');

  if (failures) { console.error(failures + ' check(s) FAILED'); process.exit(1); }
  console.log('ALL TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('TEST CRASH:', e.message); process.exit(1); });