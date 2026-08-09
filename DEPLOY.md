# Outpost Duel — go online

**This repo is already live (public):**
- Repository: https://github.com/cos-fred/outpost-duel
- Play now in any browser: **https://cos-fred.github.io/outpost-duel/**

That URL is GitHub Pages (static). It serves the game to everyone and signaling
auto-falls back to the free public MQTT broker, so two people anywhere can duel with
STUN hole-punching. The sections below explain how to also run *your own* signaling
server (needed for strict-NAT routers via TURN, and full platform independence).

Everything needed to run the game on ONE server so two people on different
networks can duel, is in this repo:

| Piece                | Where                                   | What it does                                    |
|----------------------|-----------------------------------------|-------------------------------------------------|
| Game (front-end)     | `index.html`                            | The whole game, plays P2P over WebRTC           |
| Signaling server     | `server/` (Node.js + `ws`)              | Only relays the tiny handshake (offer/answer)   |
| ICE / TURN config    | served at `/api/ice` by the server      | Tells browsers how to reach each other through NAT |

The actual duel (positions + events) travels **directly between the two players** over
WebRTC data channels — the server never carries gameplay, so latency stays minimal and
cost is trivial.

---

## 1. Run locally (test with two browsers / laptops on the same LAN)

```bash
cd server
npm install       # installs 'ws'
npm start         # listens on http://localhost:8080  (or use PORT=3000 npm start)
```

> Opening `index.html` directly (double-click) also works as an offline/fallback path —
> it automatically switches to the public MQTT broker instead of your server.

Open `http://localhost:8080/` in two tabs (or two machines). Host creates a room,
guest enters the 5-letter code → both press **Launch Duel**.

### TLS / HTTPS
- **Easiest**: terminate TLS at a reverse proxy (Caddy, nginx, Render/Railway do it for you).
  The game picks `wss://` automatically from `location.protocol`, so nothing to configure.
- **Direct HTTPS without a proxy**: set `TLS_CERT` and `TLS_KEY` to PEM file paths
  (e.g. from Let's Encrypt). The server then listens with HTTPS+WSS itself.
- `GET /healthz` returns `ok` for load balancers and uptime checks.

### Tests (CI-friendly)
```bash
npm test         # spawns the server on an ephemeral port and verifies
                 # static serving, /api/ice, traversal guard, room join/relay/refusal/peer_left
```

## 2. Put it online (deploy the server folder)

The Node app serves both the static files AND the signaling — one deployment is all you need.

### Option A — Render (fastest free)
1. Push this folder to GitHub.
2. Render → **New → Web Service**, connect the repo.
3. Build command: `npm install`  (set `Build Command` to `npm install`)
4. Start command: `npm start`
5. Done. You get `https://your-app.onrender.com`.

### Option B — Railway / Fly.io
- Railway: New → GitHub repo → `npm run start`. Same thing.
- Fly: `fly launch` at repo root (uses `server/index.js`? set `cmd = "cd server && npm install && npm start"` or move files).

### Option C — any VPS (Ubuntu):
```bash
cd server
npm install
sudo npm install -g pm2
PORT=80 pm2 start index.js --name outpost-duel
pm2 save
```
(Then an HTTPS proxy like nginx + certbot, OR set the process to run behind Caddy.)

> **Cloudflare note:** if you proxy through Cloudflare, temporarily enable
> WebSockets (Performance → Network) or point A/AAAA directly at your box.

## 3. How the two players get together
- One player clicks **HOST DUEL** → a 5-letter room code + **Copy** button.
- The other player opens the same URL → **JOIN DUEL** → **Paste** (or type) the code → **Join**.
- Both press **Launch Duel**. First to 5 kills wins.

If the game sees your own server (`/ws`) unavailable, it auto-falls back to the public
MQTT relay so it still works — but for real use, keep your server up.

## 4. NAT & TURN (make sure even strict networks connect)

- **Default**: the browser gathers _STUN_ server-reflexive candidates — this works for
  most home routers (both sides direct).
- **Strict/symmetric NAT** (some office routers, mobile hotspots, CG-NAT) blocks direct
  connections. Fix: run a **TURN** relay and tell the server about it:
  ```bash
  TURN_URLS="turn:turn.yourdomain.com:3478,turns:turn.yourdomain.com:5349?transport=tcp" \
  TURN_USER=youruser TURN_PASS=yourpass npm start
  ```
  The server exposes this at `/api/ice` and the game uses it automatically.
  Free ways to get a TURN server: run **Coturn** on your VPS (has a TLS cert) or use
  a metered relay (openrelay). Coturn quick start:
  ```bash
  apt install coturn
  turnserver -a -u youruser:yourpass -r yourdomain.com --realm yourdomain.com
  ```

## 5. Security / housekeeping (already built in)
- Room codes end up in a `Map` in memory; rooms expire after idle.
- Signaling only ever gets the handshake — real game traffic is directly P2P.
- Optional next step (when you go public): HTTPS (required for screenshare clarity),
  botproof codes, add rate limits, and switch hits to server-authoritative for fairness.

The one thing that cannot be auto-free: **TURN**. If you do nothing, playing between
two *ordinary home internet connections* works out of the box because STUN + hole
punching is enough. Only add a TURN server if a friend on a very restricted network
can't connect.