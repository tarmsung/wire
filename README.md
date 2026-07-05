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

## Before deploying for real use

- **HTTPS is required** — browsers only allow WebRTC + clipboard APIs on secure
  origins (localhost is exempt). Put this behind any TLS proxy (Caddy, nginx,
  Cloudflare) and the client automatically switches to `wss://`.
- **Add a TURN server** — roughly 10–15% of peer pairs (strict corporate NATs,
  some mobile carriers) cannot connect directly. A TURN server relays their
  traffic as a fallback. Options: self-host [coturn](https://github.com/coturn/coturn),
  or use a managed service (Twilio, Metered, Cloudflare Calls). Add the
  credentials to `RTC_CONFIG` in `public/app.js`.
- **Resume / integrity** — for flaky connections, add chunk sequence numbers
  and a hash check, and let the receiver request missing ranges.
- **Folder streaming** — single large files stream to disk, but folders are
  still assembled in memory as a zip. Streaming a folder to disk would mean
  writing the zip incrementally to the file stream.
