/*
 * Outpost Duel — online signaling + static server
 * Serves index.html and relays the WebRTC handshake (offer/answer/hello) between
 * the two players. The actual game runs peer-to-peer, so this server only ever
 * touches small JSON messages — it is light and safe to host anywhere.
 *
 *   npm install    (installs 'ws')
 *   npm start      (defaults to PORT env or 8080)
 *
 * Rooms: a 4-6 char code with two "role" slots (host / guest). Any extra peer trying
 * to join the same role slot in an occupied room is refused. Messages sent from one
 * player are forwarded to the other (opposite) role only.
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const WEB_ROOT = path.resolve(__dirname, '..'); // folder that holds index.html

/* ----------------------------------------------------------- optional HTTPS ----*/
/* Provide TLS_CERT and TLS_KEY (paths to PEM files) to run HTTPS/WSS directly.
 * If you use a reverse proxy (Caddy/nginx/Render) you do NOT need these — the proxy
 * terminates TLS and your page URL decides ws vs wss automatically. */
const TLS_CERT = process.env.TLS_CERT || '';
const TLS_KEY = process.env.TLS_KEY || '';
function tryLoad(p) { try { return p ? fs.readFileSync(p) : null; } catch (e) { console.error('WARN: cannot read TLS file: ' + p); return null; } }
const TLS = (TLS_CERT && TLS_KEY && tryLoad(TLS_CERT) && tryLoad(TLS_KEY))
  ? { cert: tryLoad(TLS_CERT), key: tryLoad(TLS_KEY) }
  : null;

/* ----------------------------------------------------------- rate limiting ----*/
/* A rough per-IP limiter so a misbehaving tab can't spam the shared relay. */
const rate = new Map();
function allow(ip) {
  const now = Date.now();
  const e = rate.get(ip) || { n: 0, t: now };
  if (now - e.t > 10000) { e.n = 0; e.t = now; }
  e.n++;
  rate.set(ip, e);
  for (const [k, v] of rate) if (now - v.t > 30000) rate.delete(k);
  return e.n <= 120; // max 120 messages / 10 s
}

/* ------------------------------------------------------- optional TURN config ---*/
/* Strict NAT networks (many home/work routers) can only connect via a TURN relay.
 * Optional: TURN_URLS="turn:host:3478,turns:host:5349?transport=tcp" TURN_USER=x TURN_PASS=y
 */
const TURN_URLS = (process.env.TURN_URLS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
const TURN_USER = process.env.TURN_USER || '';
const TURN_PASS = process.env.TURN_PASS || '';

function iceServers() {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    // last-resort public TURN (best effort): gets you through mobile / symmetric NAT when STUN can't.
    { urls: ['turn:openrelay.metered.ca:80?transport=udp', 'turn:openrelay.metered.ca:80?transport=tcp', 'turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' },
  ];
  if (TURN_URLS.length) {
    const turn = { urls: TURN_URLS };
    if (TURN_USER) { turn.username = TURN_USER; turn.credential = TURN_PASS; }
    servers.push(turn);
  }
  return servers;
}

/* -------------------------------------------------------------- static files --- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg', '.webm': 'video/webm', '.ttf': 'font/ttf',
};

function resolvePath(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' ) p = '/index.html';
  const full = path.resolve(WEB_ROOT, '.' + path.sep + p);
  const rootOK = full === WEB_ROOT ||
    full.startsWith(WEB_ROOT + path.sep) ||
    full.startsWith(WEB_ROOT + '/');
  return rootOK ? full : null;
}

/* --------------------------------------------------------------- ws rooms ------- */
const rooms = new Map(); // code -> { host, guest, ts }
const codeRe = /^[A-Z0-9]{4,6}$/;
function otherRole(r) { return r === 'host' ? 'guest' : 'host'; }
function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { }
  }
}
function evict(ws) {
  for (const [code, room] of rooms) {
    let side = null;
    if (room.host === ws) side = 'host';
    else if (room.guest === ws) side = 'guest';
    if (!side) continue;
    room[side] = null;
    const other = room[otherRole(side)];
    if (other && other.readyState === WebSocket.OPEN) send(other, { type: 'peer_left' });
    if (!room.host && !room.guest) rooms.delete(code);
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 }); // 1 MB cap (SDP fits easily)
wss.on('connection', function (ws, req) {
  ws.isAlive = true;
  const ip = (req && (req.socket.remoteAddress || '')) || '';
  ws.on('pong', function () { ws.isAlive = true; });
  ws.on('message', function (raw) {
    if (String(ip) && !allow(ip)) { ws.terminate(); return; }
    let m = null;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m) return;
    if (m.type === 'join') {
      const code = String(m.room || '').toUpperCase();
      const role = m.role === 'host' ? 'host' : (m.role === 'guest' ? 'guest' : null);
      if (!codeRe.test(code) || !role) { send(ws, { type: 'err', msg: 'BAD_ROOM' }); return; }
      let room = rooms.get(code);
      if (!room) { room = { host: null, guest: null, ts: Date.now() }; rooms.set(code, room); }
      if (room[role]) { send(ws, { type: 'full' }); return; }
      ws.room = code; ws.role = role;
      room[role] = ws; room.ts = Date.now();
      send(ws, { type: 'joined', room: code, role: role });
      if (room.host && room.guest) {
        send(room.host, { type: 'peer' });
        send(room.guest, { type: 'peer' });
      }
    } else if (m.type === 'pub') {
      if (!ws.role) return; // must join first
      const room = rooms.get(String(m.room || '').toUpperCase());
      if (!room) return;
      const other = room[otherRole(ws.role)];
      if (other) send(other, { type: 'sig', msg: m.msg || {} });
    }
  });
  ws.on('close', function () { evict(ws); });
  ws.on('error', function () { evict(ws); });
});

/* heartbeats + room cleanup */
setInterval(function () {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { }
  }
}, 30000);
setInterval(function () {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!room.host && !room.guest) rooms.delete(code);
    else if (now - room.ts > 6000000) rooms.delete(code);
  }
}, 60000);

/* ------------------------------------------------------------------ http app ---- */
const handler = function (req, res) {
  const url = req.url || '/';
  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('ok');
    return;
  }
  if (url === '/api/ice' || url.indexOf('/api/ice?') === 0) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ servers: iceServers() }));
    return;
  }
  const file = resolvePath(url);
  if (!file) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return; }
  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
};

const server = TLS ? https.createServer(TLS, handler) : http.createServer(handler);

server.on('upgrade', function (req, socket, head) {
  let u = null;
  try { u = new URL(req.url, 'http://x'); } catch (e) { socket.destroy(); return; }
  if (u.pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, function (ws) { wss.emit('connection', ws, req); });
});

server.listen(PORT, function () {
  console.log('Outpost Duel online : ' + (TLS ? 'https://' : 'http://') + 'localhost:' + PORT + '  (serving ' + WEB_ROOT + ')');
  console.log('TURN : ' + (TURN_URLS.length ? TURN_URLS.join(', ') : 'none (STUN only)'));
});

/* graceful shutdown */
function shutdown() {
  console.log('\nShutting down…');
  for (const ws of wss.clients) { try { ws.close(1001, 'server shutdown'); } catch (e) { } }
  wss.close();
  server.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(0); }, 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);