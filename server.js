// Signaling server: serves the static page and relays WebRTC handshake
// messages between two peers in a room. File bytes NEVER pass through here.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Abuse limits. Signaling messages are tiny (the biggest legitimate one is an
// SDP offer, a few KB) and one person only needs a handful of rooms/sockets,
// so generous caps still stop floods and brute-forcing cold. Overridable via
// env so the test suite can use small values and short timers.
const num = (v, def) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : def);
const MAX_PAYLOAD = num(process.env.MAX_PAYLOAD, 16 * 1024);   // per WebSocket message
const MAX_ROOMS = num(process.env.MAX_ROOMS, 200);            // global cap on simultaneous transfers
const MAX_CONNS_PER_IP = num(process.env.MAX_CONNS_PER_IP, 20);
const MAX_FAILED_JOINS = num(process.env.MAX_FAILED_JOINS, 5); // then the socket is closed — stops code guessing
const HEARTBEAT_INTERVAL = num(process.env.HEARTBEAT_MS, 30 * 1000);
const ROOM_TTL = num(process.env.ROOM_TTL_MS, 15 * 60 * 1000); // drop a code nobody joined after 15 min
const ROOM_SWEEP_INTERVAL = num(process.env.ROOM_SWEEP_MS, 60 * 1000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

// ICE servers handed to the browser. STUN is free/public; TURN (the relay that
// rescues the ~10-15% of peers behind strict NATs) is optional and read from
// env so credentials live in the deploy config, not the repo. TURN_URL may be a
// comma-separated list (e.g. udp + tcp + tls variants).
function iceServers() {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  if (process.env.TURN_URL) {
    const turn = { urls: process.env.TURN_URL.split(',').map((s) => s.trim()).filter(Boolean) };
    if (process.env.TURN_USERNAME) turn.username = process.env.TURN_USERNAME;
    if (process.env.TURN_CREDENTIAL) turn.credential = process.env.TURN_CREDENTIAL;
    servers.push(turn);
  }
  return servers;
}

// First non-internal IPv4 address, so devices on the same network get a usable link
function lanAddress() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

// Loopback / RFC1918 / link-local ranges — /lan only answers callers that are
// already on this network, so the internal IP never leaks to the internet
function isPrivateAddress(addr) {
  const ip = String(addr || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1'
    || /^10\./.test(ip)
    || /^192\.168\./.test(ip)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    || /^169\.254\./.test(ip)
    || /^f[cd]/i.test(ip)    // fc00::/7 unique-local
    || /^fe80:/i.test(ip);   // link-local
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]); // allow UTF-8/space file names
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (urlPath === '/lan') {
    if (!isPrivateAddress(req.socket.remoteAddress)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ host: lanAddress(), port: PORT }));
  }
  if (urlPath === '/ice') {
    // ICE servers for the browser: always STUN, plus a TURN relay if one is
    // configured via env (kept out of source, set per-deploy). TURN credentials
    // necessarily reach the client — that's how WebRTC TURN works.
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ iceServers: iceServers() }));
  }
  if (urlPath === '/') urlPath = '/index.html';
  // Resolve inside ./public only — reject path traversal (the trailing path.sep
  // also rules out sibling dirs like "public-backup")
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });

// room code -> Set of sockets (max 2: sender + receiver)
const rooms = new Map();
// ip -> open socket count
const connsPerIp = new Map();

// Unambiguous alphabet: no 0/O, 1/I/L
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// A socket can only ever be in one room; pull it out (and tell its peer)
// before it creates or joins another, and when it disconnects
function leaveRoom(ws) {
  const code = ws.room;
  ws.room = null;
  const room = rooms.get(code);
  if (!room || !room.delete(ws)) return;
  for (const peer of room) send(peer, { type: 'peer-left' });
  if (room.size === 0) rooms.delete(code);
}

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress || 'unknown';
  const conns = connsPerIp.get(ip) || 0;
  if (conns >= MAX_CONNS_PER_IP) return ws.close(1013, 'Too many connections');
  connsPerIp.set(ip, conns + 1);
  ws.ip = ip;
  ws.isAlive = true;
  ws.failedJoins = 0;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'create': {
        leaveRoom(ws);
        if (rooms.size >= MAX_ROOMS) {
          return send(ws, { type: 'error', message: 'The server is busy. Try again in a minute.' });
        }
        const code = makeCode();
        const room = new Set([ws]);
        room.createdAt = Date.now(); // for the unjoined-room TTL sweep
        rooms.set(code, room);
        ws.room = code;
        send(ws, { type: 'created', code });
        break;
      }
      case 'join': {
        const code = String(msg.code || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room || room.size >= 2) {
          ws.failedJoins++;
          send(ws, {
            type: 'error',
            message: room ? 'Someone already joined this transfer.' : 'Code not found. Check it and try again.',
          });
          if (ws.failedJoins >= MAX_FAILED_JOINS) ws.close(1008, 'Too many join attempts');
          return;
        }
        leaveRoom(ws);
        room.add(ws);
        ws.room = code;
        send(ws, { type: 'joined' });
        for (const peer of room) if (peer !== ws) send(peer, { type: 'peer-joined' });
        break;
      }
      case 'signal': {
        // Blind relay of SDP offers/answers and ICE candidates to the other peer
        const room = rooms.get(ws.room);
        if (!room) return;
        for (const peer of room) if (peer !== ws) send(peer, { type: 'signal', data: msg.data });
        break;
      }
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
    const n = (connsPerIp.get(ws.ip) || 1) - 1;
    if (n <= 0) connsPerIp.delete(ws.ip);
    else connsPerIp.set(ws.ip, n);
  });
});

// Zombie sockets (sleeping laptops, dropped Wi-Fi) would hold rooms open
// forever; ping regularly and drop anything that doesn't answer
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL);

// A code that's created but never joined shouldn't live forever (the reviewer's
// note). Once someone joins, the room is a live transfer and the heartbeat keeps
// it honest; only lone, stale rooms get expired here.
const roomSweep = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.size < 2 && now - (room.createdAt || 0) > ROOM_TTL) {
      for (const peer of room) {
        send(peer, { type: 'expired' });
        peer.room = null;
      }
      rooms.delete(code);
    }
  }
}, ROOM_SWEEP_INTERVAL);

wss.on('close', () => { clearInterval(heartbeat); clearInterval(roomSweep); });

server.listen(PORT, () => {
  console.log(`P2P transfer app running:`);
  console.log(`  This computer:  http://localhost:${PORT}`);
  const lan = lanAddress();
  if (lan) console.log(`  Same network:   http://${lan}:${PORT}  <- use this on phones/other devices`);
});
