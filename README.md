# Wire — P2P file transfer

Send a file from one browser to another — even across countries — without the
file ever being uploaded to a server. The file streams directly between the two
computers over a WebRTC data channel; the server only relays the tiny
connection-setup handshake (a few KB).

## Run it

```
npm install
npm start
```

Open http://localhost:3000 in two browsers:

1. **Sender** clicks *Send a file* → gets a 6-character code (or a copyable
   link that auto-joins).
2. **Receiver** clicks *Receive a file* and enters the code (or just opens the
   link).
3. The sender sees an **Accept / Decline** prompt naming that someone entered
   the code. Nothing connects and no files move until they accept — declining
   issues a fresh code, so a guessed or brute-forced code gets nothing.
4. Once the wire shows *connected*, the sender drops in files — or a whole
   folder — and they stream across with live progress, speed, and ETA. The
   receiver clicks *Save* per item, and the sender can keep sending more over
   the same connection.

Folders are walked recursively on the sender's side and rebuilt on the
receiver's side as a single `.zip` (assembled in the browser, store method)
with the directory structure preserved. Limit: no ZIP64 support, so a folder
must stay under 4 GB.

## How it works

- **server.js** — static file host + WebSocket signaling. It pairs two peers by
  room code and blindly relays their SDP offers/answers and ICE candidates.
  File bytes never pass through it.
- **public/app.js** — WebRTC logic. The sender reads the file in 64 KB slices
  and sends them over an `RTCDataChannel`, pausing when the channel's send
  buffer exceeds 8 MB (backpressure) so memory stays flat.
- **public/wire-lib.js** — the DOM-free, transfer-critical helpers (byte/ETA
  formatting, path sanitizing, CRC32, the ZIP writer). Split out so they can be
  unit-tested in Node without a browser.
- **STUN** (Google's free public servers) lets peers discover their public
  addresses to punch through typical home/office NATs.

### Large files stream to disk

Small files are buffered in memory and offered as a download link. For a single
file at or above 256 MB, on browsers with the File System Access API
(Chrome/Edge), the receiver is prompted to pick a save location and the bytes
are written **straight to disk** as they arrive — memory stays flat regardless
of file size. The sender waits for a "ready" signal before streaming, so nothing
is sent until the receiver's save target is set up. Browsers without the API (or
if the user declines) fall back to the in-memory path. (Folders are always
rebuilt in memory as a zip, so the multi-GB caveat still applies to them.)

### Abandoned codes expire

A code that's created but never joined is swept after 15 minutes (the sender is
told to start over). Once someone joins, the room is a live transfer kept honest
by a 30-second ping/pong heartbeat that drops dead sockets.

## Tests

```
npm test
```

Runs the Node test suite (`test/`): unit tests for the pure helpers (formatting,
path sanitizing, CRC32, and a byte-for-byte ZIP round-trip) and integration
tests that spin up the signaling server and exercise pairing, signal relay,
the brute-force lockout, the room cap, and TTL expiry.

## Deploying

The server holds live WebSocket connections, so it needs a host that runs a
persistent Node process (not a static/serverless host).

### One-click on Render (free, HTTPS included)

This repo ships a [`render.yaml`](render.yaml) blueprint. In Render: **New →
Blueprint**, point it at this repo, and it builds and serves the app at
`https://<name>.onrender.com` — WebSockets and TLS work out of the box, no
domain to buy. (Free web services cold-start after idle; the first request may
take ~30s.) The same blueprint works for a paid plan if you outgrow the free tier.

You don't need to own a domain: a platform subdomain (Render/Railway/Fly.io) or
a tunnel (Cloudflare Tunnel, ngrok) gives you HTTPS for free. A custom domain is
only needed for a branded URL or when self-hosting on a raw VPS behind Caddy.

### Self-hosting on a VPS

Three things run on the box (config files in [`deploy/`](deploy/)):

1. **The Node server** (`server.js`) — serves the web app and relays signaling.
   Run it under systemd with [`deploy/wire.service`](deploy/wire.service).
2. **Caddy** — HTTPS reverse proxy with an automatic Let's Encrypt cert; config
   in [`deploy/Caddyfile`](deploy/Caddyfile).
3. **coturn** — optional TURN relay; example in
   [`deploy/turnserver.conf`](deploy/turnserver.conf).

Assuming Ubuntu/Debian:

```bash
# DNS first: point wirelink.online (A record) at the VPS public IP.

# 1. Node + the app
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo useradd --system --home /opt/wire wire
sudo git clone https://github.com/tarmsung/wire.git /opt/wire
cd /opt/wire && sudo npm ci --omit=dev && sudo chown -R wire:wire /opt/wire
sudo cp deploy/wire.service /etc/systemd/system/wire.service
sudo systemctl daemon-reload && sudo systemctl enable --now wire   # listens on :3000

# 2. Caddy for HTTPS (auto cert for wirelink.online)
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
# (add Caddy's apt repo per caddyserver.com/docs/install, then:)
sudo apt-get install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

That's the whole app live at `https://wirelink.online`. TURN (step 3) is
optional — see below.

### Adding a TURN relay

Direct peer-to-peer fails for roughly 10–15% of pairs (strict corporate NATs,
some mobile carriers). A TURN server relays those as a fallback. The server
reads TURN config from env and hands it to the browser via `/ice` — so
credentials live in the deploy config, never in the repo:

| Env var | Example |
|---|---|
| `TURN_URL` | `turn:relay.metered.ca:80` (comma-separate for multiple URLs) |
| `TURN_USERNAME` | your relay username |
| `TURN_CREDENTIAL` | your relay credential |

Leave them unset to run STUN-only. Get free credentials from
[Metered.ca](https://www.metered.ca/tools/openrelay/), or self-host
[coturn](https://github.com/coturn/coturn). On Render, set these under the
service's **Environment** tab (the blueprint leaves them blank for you to fill).

### Why HTTPS matters

The peer-to-peer transfer itself works over plain `http://` on a LAN. But a
public deployment should use HTTPS: the **disk-streaming** and **clipboard**
features require a secure context, and TLS keeps the signaling private. Any of
the hosts above provide it automatically; the client auto-switches to `wss://`.

## Later / nice-to-have

- **Resume / integrity** — for flaky connections, add chunk sequence numbers
  and a hash check, and let the receiver request missing ranges.
- **Folder streaming** — single large files stream to disk, but folders are
  still assembled in memory as a zip. Streaming a folder to disk would mean
  writing the zip incrementally to the file stream.
