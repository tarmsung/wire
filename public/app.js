'use strict';

// ---------- Config ----------
const CHUNK_SIZE = 64 * 1024;           // 64 KB per data-channel message
const MAX_BUFFERED = 8 * 1024 * 1024;   // pause sending above 8 MB buffered
const BUFFER_LOW = 1 * 1024 * 1024;     // resume when buffer drains to 1 MB
const ACK_TIMEOUT = 30 * 1000;          // give up if the receiver never confirms a file
const STREAM_THRESHOLD = 256 * 1024 * 1024; // offer disk streaming for files >= 256 MB

// fmtBytes, fmtEta, sanitizePath, sanitizeName, crc32Update, buildZip come from
// wire-lib.js (loaded first) so they can be unit-tested outside the browser.
// STUN-only defaults; the server may replace iceServers with a set that also
// includes a TURN relay (see /ice + TURN_* env vars). Mutated in place so
// createPeerConnection() always reads the latest.
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};
// Pull the deploy's ICE config (adds TURN when configured) at startup.
fetch('/ice')
  .then((r) => r.json())
  .then((cfg) => {
    if (cfg && Array.isArray(cfg.iceServers) && cfg.iceServers.length) RTC_CONFIG.iceServers = cfg.iceServers;
  })
  .catch(() => {}); // offline/dev: keep the STUN defaults

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);
const screens = [
  'screen-role',
  'screen-sender-wait',
  'screen-receiver-join',
  'screen-sender-file',
  'screen-receiver-file',
];
function show(id) {
  screens.forEach((s) => $(s).classList.toggle('hidden', s !== id));
}
function setBanner(msg) {
  $('banner').textContent = msg || '';
  $('banner').classList.toggle('hidden', !msg);
}
// One painter for both progress bars (prefix 'send' or 'recv'). Guards the
// zero-size and zero-elapsed cases so we never show NaN% or "Infinity GB/s".
function paintProgress(prefix, done, total, startedAt) {
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 100;
  const elapsed = (performance.now() - startedAt) / 1000;
  const speed = elapsed > 0 ? done / elapsed : 0;
  $(`${prefix}ProgressFill`).style.width = `${pct.toFixed(1)}%`;
  $(`${prefix}ProgressPct`).textContent = `${Math.round(pct)}%`;
  $(`${prefix}ProgressSpeed`).textContent = speed > 0 ? `${fmtBytes(speed)}/s · ${fmtEta((total - done) / speed)}` : '';
}

// ---------- Link visualization ----------
// state: 'idle' | 'connecting' | 'connected' | 'transferring'
function setLink(state) {
  const local = $('nodeLocal');
  const remote = $('nodeRemote');
  const wire = $('wire');
  const label = $('linkStatusLabel');

  local.classList.toggle('on', state === 'connected' || state === 'transferring');
  local.classList.toggle('pending', state === 'connecting');
  remote.classList.toggle('on', state === 'connected' || state === 'transferring');
  remote.classList.toggle('pending', false);
  wire.classList.toggle('live', state === 'connected');
  wire.classList.toggle('active', state === 'transferring');
  wire.classList.toggle('rev', state === 'transferring' && role === 'receive');

  const text = {
    idle: 'not connected',
    connecting: 'connecting…',
    connected: 'connected',
    transferring: role === 'receive' ? 'receiving data' : 'sending data',
  };
  label.textContent = text[state] || '';
  label.className = state === 'connected' ? 'ok' : state === 'transferring' || state === 'connecting' ? 'busy' : '';
}

// ---------- Share address ----------
// Links containing "localhost" are useless on other devices. When the page is
// opened via localhost, ask the server for its LAN address and use that in
// shared links instead.
let shareBase = location.origin;
if (['localhost', '127.0.0.1'].includes(location.hostname)) {
  fetch('/lan')
    .then((r) => r.json())
    .then(({ host, port }) => {
      if (!host) return;
      shareBase = `http://${host}:${port}`;
      $('lanHint').textContent = `On another device: ${shareBase}`;
      $('lanHint').classList.remove('hidden');
    })
    .catch(() => {});
}

// ---------- State ----------
let ws = null;          // signaling socket
let pc = null;          // RTCPeerConnection
let dc = null;          // RTCDataChannel
let role = null;        // 'send' | 'receive'
let pendingCandidates = [];
let wasDeclined = false; // receiver was turned down; the follow-up peer-left is expected

// Close a peer connection pair and mute its handlers first, so a stale
// onclose from a dying connection can't stamp over a newer one's UI state
function closePeer() {
  abortPendingSend('Connection closed.');
  abortLooseSink(); // discard any half-written incoming file
  if (dc) {
    dc.onopen = dc.onclose = dc.onmessage = null;
    try { dc.close(); } catch {}
    dc = null;
  }
  if (pc) {
    pc.onicecandidate = pc.onconnectionstatechange = pc.ondatachannel = null;
    try { pc.close(); } catch {}
    pc = null;
  }
  pendingCandidates = [];
}

// Close any live connection objects (socket, peer connection, channel) so a
// new flow starts clean — e.g. reloading with a stale #CODE, then clicking Send
function teardownConnection() {
  closePeer();
  if (ws) {
    ws.onclose = null; // intentional close — don't show the lost-server banner
    try { ws.close(); } catch {}
    ws = null;
  }
}

function resetAll() {
  teardownConnection();
  role = null;
  sendQueue = [];
  sending = false;
  batchTotal = 0;
  batchDone = 0;
  activeFolder = null;
  incomingMeta = null;
  receivedBuffers = [];
  // Release the blobs behind the download links
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  history.replaceState(null, '', location.pathname);
  setBanner('');
  setLink('idle');
  $('sendProgressArea').classList.add('hidden');
  $('pickArea').classList.remove('hidden');
  $('btnSendAnother').classList.add('hidden');
  $('recvProgressArea').classList.add('hidden');
  $('saveChoice').classList.add('hidden');
  $('waitingForFile').classList.remove('hidden');
  $('receivedFiles').innerHTML = '';
  $('sentFiles').innerHTML = '';
  $('btnJoin').disabled = false;
  hideJoinConfirm();
  wasDeclined = false;
  show('screen-role');
}

// ---------- Signaling ----------
function connectSignaling() {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('Could not reach the server.'));
    ws.onclose = () => {
      // Server restart or network blip while waiting: say so instead of
      // leaving "Waiting…" up forever. Once the data channel is open the
      // signaling socket no longer matters.
      if (!dc || dc.readyState !== 'open') {
        setBanner('Lost the connection to the server. Go back and start over.');
        setLink('idle');
        $('btnJoin').disabled = false;
      }
    };
    ws.onmessage = (ev) => handleSignalingMessage(JSON.parse(ev.data));
  });
}
function signal(data) {
  ws.send(JSON.stringify({ type: 'signal', data }));
}

async function handleSignalingMessage(msg) {
  switch (msg.type) {
    case 'created':
      $('roomCode').textContent = msg.code;
      history.replaceState(null, '', `#${msg.code}`);
      $('senderStatus').textContent = 'Waiting for the other person to join…';
      break;

    case 'peer-joined': // sender side: someone entered the code — ask before connecting,
      // so a guessed/brute-forced code can't silently start receiving files
      closePeer(); // a rejoining receiver means the old pair is dead — drop it
      $('copyBtns').classList.add('hidden');
      $('joinConfirm').classList.remove('hidden');
      $('senderStatus').textContent = 'Nothing is sent until you accept.';
      setLink('connecting');
      break;

    case 'joined': // receiver side: wait for the sender's offer
      closePeer();
      $('btnJoin').disabled = false;
      $('joinStatus').classList.remove('err');
      $('joinStatus').textContent = 'Waiting for connection…';
      setLink('connecting');
      pc = createPeerConnection();
      pc.ondatachannel = (ev) => {
        dc = ev.channel;
        setupDataChannel();
      };
      break;

    case 'signal':
      await handleSignal(msg.data);
      break;

    case 'peer-left':
      // Expected after a decline (the sender moves to a new room) — stay quiet
      if (wasDeclined) {
        wasDeclined = false;
        break;
      }
      // If they bailed while the accept prompt was up, go back to waiting
      if (role === 'send' && !$('joinConfirm').classList.contains('hidden')) {
        hideJoinConfirm();
        $('senderStatus').textContent = 'They left. Waiting for someone to join…';
        setLink('idle');
        break;
      }
      if (!dc || dc.readyState !== 'open') {
        setBanner('The other side disconnected.');
        setLink('idle');
      }
      break;

    case 'expired':
      // The code was never joined and timed out server-side — prompt a restart
      $('senderStatus').textContent = 'This code expired. Go back and start a new one.';
      setLink('idle');
      history.replaceState(null, '', location.pathname);
      break;

    case 'error':
      if (role === 'receive') {
        $('btnJoin').disabled = false;
        $('joinStatus').textContent = msg.message;
        $('joinStatus').classList.add('err');
        setLink('idle');
        history.replaceState(null, '', location.pathname); // drop a dead #CODE
      } else {
        setBanner(msg.message);
      }
      break;
  }
}

// ---------- WebRTC ----------
function createPeerConnection() {
  const conn = new RTCPeerConnection(RTC_CONFIG);
  conn.onicecandidate = (ev) => {
    if (ev.candidate) signal({ candidate: ev.candidate });
  };
  conn.onconnectionstatechange = () => {
    if (conn.connectionState === 'failed') {
      setBanner('Direct connection failed — both networks may block peer-to-peer. A TURN relay is needed for this pair.');
      setLink('idle');
    }
  };
  return conn;
}

function hideJoinConfirm() {
  $('joinConfirm').classList.add('hidden');
  $('copyBtns').classList.remove('hidden');
}

// Sender accepted: now (and only now) build the connection and offer
$('btnAcceptPeer').onclick = async () => {
  hideJoinConfirm();
  $('senderStatus').textContent = 'Connecting…';
  pc = createPeerConnection();
  dc = pc.createDataChannel('file');
  setupDataChannel();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  signal({ sdp: pc.localDescription });
};

// Sender declined: tell the peer, then move to a fresh room so the old code
// (which the stranger knows) is dead no matter what they do
$('btnDeclinePeer').onclick = () => {
  signal({ rejected: true });
  hideJoinConfirm();
  $('senderStatus').textContent = 'Declined. Getting a new code…';
  setLink('idle');
  ws.send(JSON.stringify({ type: 'create' })); // server moves us out of the old room
};

async function handleSignal(data) {
  if (data.rejected) {
    // Receiver side: the sender turned us down
    wasDeclined = true;
    closePeer();
    $('btnJoin').disabled = false;
    $('joinStatus').textContent = 'The sender declined the connection.';
    $('joinStatus').classList.add('err');
    setLink('idle');
    return;
  }
  if (!pc) return; // no live handshake — stale or unexpected signal
  if (data.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    for (const c of pendingCandidates) await pc.addIceCandidate(c);
    pendingCandidates = [];
    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      signal({ sdp: pc.localDescription });
    }
  } else if (data.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
    else pendingCandidates.push(data.candidate);
  }
}

function setupDataChannel() {
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = BUFFER_LOW;
  dc.onopen = () => {
    setLink('connected');
    show(role === 'send' ? 'screen-sender-file' : 'screen-receiver-file');
  };
  dc.onclose = () => {
    abortPendingSend('Connection closed.'); // wake drainQueue so it can bail out
    setBanner('Connection closed.');
    setLink('idle');
  };
  dc.onmessage = (ev) => { handleIncoming(ev.data).catch(() => {}); };
}

// ---------- Sending ----------
// Jobs (single files or whole folders) go into a queue and stream one file at
// a time over the single data channel. Each file waits for the receiver's ack
// before the next starts, so "delivered" always means the receiver really has it.
let sendQueue = [];
let sending = false;
let batchTotal = 0;
let batchDone = 0;
let ackResolve = null;
let ackReject = null;
let readyResolve = null;
let readyReject = null;
let bufferLowResolve = null; // pending backpressure waiter, released on close

// Resolved by the receiver's ack, rejected on channel close / timeout — so
// drainQueue can never hang forever on a peer that silently vanished
function waitForAck() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ackResolve = ackReject = null;
      reject(new Error('The receiver never confirmed the file.'));
    }, ACK_TIMEOUT);
    ackResolve = () => { clearTimeout(timer); ackResolve = ackReject = null; resolve(); };
    ackReject = (err) => { clearTimeout(timer); ackResolve = ackReject = null; reject(err); };
  });
}

// Loose files wait for the receiver to signal it's ready before streaming, so
// it can open a disk file (which needs a user click) first. No timeout — the
// receiver may be waiting on a human to pick a save location; a dead channel
// still aborts it via abortPendingSend.
function waitForReady() {
  return new Promise((resolve, reject) => {
    readyResolve = () => { readyResolve = readyReject = null; resolve(); };
    readyReject = (err) => { readyResolve = readyReject = null; reject(err); };
  });
}

// Wake anything blocked inside drainQueue (ack, ready, or backpressure wait) so
// a dead channel aborts the batch instead of deadlocking the queue
function abortPendingSend(reason) {
  if (ackReject) ackReject(new Error(reason));
  if (readyReject) readyReject(new Error(reason));
  if (bufferLowResolve) {
    bufferLowResolve();
    bufferLowResolve = null;
  }
}

function queueFiles(files) {
  queueJobs(files.map((f) => ({ type: 'file', file: f })));
}
function queueFolder(name, entries) {
  // entries: [{ file, path }] where path is relative and includes the folder root
  if (entries.length) queueJobs([{ type: 'folder', name, entries }]);
}
function queueJobs(jobs) {
  if (!jobs.length) return;
  sendQueue.push(...jobs);
  batchTotal += jobs.reduce((n, j) => n + (j.type === 'folder' ? j.entries.length : 1), 0);
  if (!sending) drainQueue();
}

async function drainQueue() {
  sending = true;
  $('pickArea').classList.add('hidden');
  $('btnSendAnother').classList.add('hidden');
  $('sendProgressArea').classList.remove('hidden');

  let aborted = false;
  try {
    while (sendQueue.length && !aborted) {
      const job = sendQueue.shift();

      if (job.type === 'file') {
        // Loose files wait for the receiver to be ready (it may open a disk file first)
        if (!(await sendOne(job.file, null, batchDone + 1, batchTotal, true))) { aborted = true; break; }
        await waitForAck(); // receiver confirms this file
        batchDone++;
        addSentRow(job.file.name, `delivered ✓ ${fmtBytes(job.file.size)}`);

      } else {
        const totalSize = job.entries.reduce((n, e) => n + e.file.size, 0);
        dc.send(JSON.stringify({ kind: 'folder-start', folder: job.name, count: job.entries.length, totalSize }));
        for (const entry of job.entries) {
          // Folder members always buffer to memory (rebuilt as a zip) — no ready wait
          if (!(await sendOne(entry.file, entry.path, batchDone + 1, batchTotal, false))) { aborted = true; break; }
          await waitForAck();
          batchDone++;
        }
        if (aborted) break;
        dc.send(JSON.stringify({ kind: 'folder-end', folder: job.name }));
        addSentRow(`${job.name}/`, `${job.entries.length} files ✓ ${fmtBytes(totalSize)}`);
      }
    }
  } catch (err) {
    // Closed channel, unreadable file, or missing ack — abort the whole batch
    aborted = true;
    if (role === 'send') setBanner(err && err.message ? err.message : 'Transfer failed.');
  } finally {
    sending = false;
  }

  if (!aborted) {
    $('sendProgressState').textContent = batchTotal > 1 ? `all ${batchTotal} delivered ✓` : 'delivered ✓';
    $('btnSendAnother').classList.remove('hidden');
    setLink('connected');
  } else if (role === 'send') {
    // Don't dead-end the screen: bring the pick area back so the user can retry
    sendQueue = [];
    $('sendProgressState').textContent = 'failed';
    $('sendProgressSpeed').textContent = '';
    $('pickArea').classList.remove('hidden');
    setLink(dc && dc.readyState === 'open' ? 'connected' : 'idle');
  }
  batchTotal = 0;
  batchDone = 0;
}

async function sendOne(file, path, num, total, expectReady) {
  if (!dc || dc.readyState !== 'open') {
    setBanner('Connection lost.');
    return false;
  }
  const counter = total > 1 ? ` ${num}/${total}` : '';
  $('sendFileName').textContent = path || file.name;
  $('sendFileSize').textContent = fmtBytes(file.size);
  $('sendProgressFill').classList.remove('done');
  $('sendProgressFill').style.width = '0%';
  $('sendProgressPct').textContent = '0%';
  $('sendProgressState').textContent = `sending${counter}…`;
  setLink('transferring');

  dc.send(JSON.stringify({ kind: 'meta', name: file.name, size: file.size, mime: file.type || 'application/octet-stream', path: path || null }));

  // Loose files: hold until the receiver has its sink ready (memory or disk)
  if (expectReady) {
    $('sendProgressState').textContent = `waiting for receiver${counter}…`;
    await waitForReady();
    if (!dc || dc.readyState !== 'open') return false;
    $('sendProgressState').textContent = `sending${counter}…`;
  }

  const started = performance.now();
  let offset = 0;
  while (offset < file.size) {
    const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();

    // Backpressure: don't flood the channel faster than the network drains it.
    // abortPendingSend releases this waiter if the channel dies meanwhile.
    if (dc.bufferedAmount > MAX_BUFFERED) {
      await new Promise((r) => {
        bufferLowResolve = r;
        dc.addEventListener('bufferedamountlow', r, { once: true });
      });
      bufferLowResolve = null;
    }
    if (!dc || dc.readyState !== 'open') {
      setBanner('Connection lost mid-transfer.');
      return false;
    }

    dc.send(chunk);
    offset += chunk.byteLength;
    paintProgress('send', offset, file.size, started);
  }

  dc.send(JSON.stringify({ kind: 'done' }));
  $('sendProgressState').textContent = `sent${counter} — confirming…`;
  $('sendProgressSpeed').textContent = '';
  return true;
}

function addSentRow(name, statusText) {
  const row = document.createElement('div');
  row.className = 'file-row';
  const label = document.createElement('span');
  label.className = 'name';
  label.textContent = name;
  const status = document.createElement('span');
  status.className = 'ok';
  status.textContent = statusText;
  row.append(label, status);
  $('sentFiles').appendChild(row);
}

// ---------- Receiving ----------
let incomingMeta = null;
let receivedBuffers = [];   // folder members buffer here (rebuilt into a zip)
let receivedBytes = 0;
let recvStarted = 0;
let activeFolder = null;    // { name, count, totalSize, files: [{path, blob, crc}] }
let fileCrc = 0;
let objectUrls = [];        // download URLs to revoke on reset, so blobs get freed
let fileSink = null;        // where the current loose file's bytes go (memory or disk)
let writeChain = Promise.resolve(); // serializes async disk writes so they stay ordered

// A "sink" hides whether a loose file is buffered in memory (small files, or
// browsers without the File System Access API) or streamed straight to disk
// (large files on Chrome/Edge) — so the receive loop is identical either way.
function makeMemorySink(mime) {
  const buffers = [];
  return {
    mode: 'memory',
    write(chunk) { buffers.push(chunk); },
    async finish() { return new Blob(buffers, { type: mime }); }, // blob to download
    async abort() { buffers.length = 0; },
  };
}
function makeDiskSink(stream) {
  return {
    mode: 'disk',
    async write(chunk) { await stream.write(chunk); },
    async finish() { await stream.close(); return null; },        // already on disk
    async abort() { try { await stream.abort(); } catch {} },
  };
}
function supportsFileSystemAccess() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}
function sinkWrite(chunk) {
  // Chain writes so disk writes stay ordered and complete before we ack; memory
  // writes are synchronous so this is effectively free for them.
  writeChain = writeChain.then(() => fileSink && fileSink.write(chunk));
  writeChain.catch(() => {}); // real failure surfaces at flushSink()
}
function abortLooseSink() {
  if (fileSink) { try { fileSink.abort(); } catch {} fileSink = null; }
  writeChain = Promise.resolve();
}
async function abortLooseSinkAsync() {
  if (fileSink) { try { await fileSink.abort(); } catch {} fileSink = null; }
  writeChain = Promise.resolve();
}

// Decide where a loose file lands, then tell the sender we're ready. Large files
// on a supporting browser offer a "stream to disk" choice (which needs a click,
// so the sender waits); everything else goes to memory.
async function prepareLooseSink() {
  writeChain = Promise.resolve();
  fileSink = null;
  const meta = incomingMeta;
  // window.__wireStreamThresholdKB lets tests (and manual tuning) force the disk
  // path on small files; otherwise the 256 MB default applies.
  const threshold = window.__wireStreamThresholdKB ? window.__wireStreamThresholdKB * 1024 : STREAM_THRESHOLD;
  if (supportsFileSystemAccess() && meta.size >= threshold) {
    const handle = await promptForSaveHandle(meta);
    if (handle) {
      try {
        const stream = await handle.createWritable();
        fileSink = makeDiskSink(stream);
      } catch { fileSink = null; }
    }
  }
  if (!fileSink) fileSink = makeMemorySink(meta.mime);
  if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ kind: 'ready' }));
}

// Show the save prompt and resolve with a file handle (disk) or null (memory).
// showSaveFilePicker must run inside the click, so it's called from onclick.
function promptForSaveHandle(meta) {
  return new Promise((resolve) => {
    $('saveChoiceText').textContent =
      `Incoming: ${meta.name} (${fmtBytes(meta.size)}). Stream it straight to disk, or keep it in memory?`;
    $('saveChoice').classList.remove('hidden');
    const cleanup = () => {
      $('saveChoice').classList.add('hidden');
      $('btnChooseSave').onclick = null;
      $('btnKeepMemory').onclick = null;
    };
    $('btnChooseSave').onclick = async () => {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: meta.name });
        cleanup();
        resolve(handle);
      } catch {
        cleanup();
        resolve(null); // cancelled picker → fall back to memory
      }
    };
    $('btnKeepMemory').onclick = () => { cleanup(); resolve(null); };
  });
}

function addSavedRow(name, size) {
  const row = document.createElement('div');
  row.className = 'file-row';
  const label = document.createElement('span');
  label.className = 'name';
  label.textContent = name;
  const status = document.createElement('span');
  status.className = 'ok';
  status.textContent = `saved to disk ✓ (${fmtBytes(size)})`;
  row.append(label, status);
  $('receivedFiles').appendChild(row);
}

async function handleIncoming(data) {
  if (typeof data === 'string') {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return; // garbage from the peer — ignore
    }

    if (msg.kind === 'folder-start') {
      if (typeof msg.folder !== 'string') return;
      const name = sanitizeName(msg.folder);
      const count = Number.isFinite(msg.count) && msg.count >= 0 ? msg.count : 0;
      const totalSize = Number.isFinite(msg.totalSize) && msg.totalSize >= 0 ? msg.totalSize : 0;
      activeFolder = { name, count, totalSize, files: [] };
      $('waitingForFile').classList.add('hidden');
      $('recvProgressArea').classList.remove('hidden');
      $('recvFileName').textContent = `${name}/`;
      $('recvFileSize').textContent = `${count} files · ${fmtBytes(totalSize)}`;

    } else if (msg.kind === 'folder-end') {
      if (activeFolder) {
        const zip = buildZip(activeFolder.files);
        addReceivedFile(`${activeFolder.name}.zip`, zip, `${activeFolder.count} files`);
        activeFolder = null;
        $('recvProgressFill').classList.add('done');
        $('recvProgressState').textContent = 'received';
        $('recvProgressSpeed').textContent = '';
        setLink('connected');
      }

    } else if (msg.kind === 'meta') {
      if (typeof msg.name !== 'string' || !Number.isFinite(msg.size) || msg.size < 0) return;
      incomingMeta = {
        name: sanitizeName(msg.name),
        size: msg.size,
        mime: typeof msg.mime === 'string' ? msg.mime : 'application/octet-stream',
        path: typeof msg.path === 'string' ? sanitizePath(msg.path) || null : null,
      };
      receivedBytes = 0;
      recvStarted = performance.now();
      const folderMember = !!(activeFolder && incomingMeta.path);
      $('waitingForFile').classList.add('hidden');
      $('recvProgressArea').classList.remove('hidden');
      $('recvFileName').textContent = incomingMeta.path || incomingMeta.name;
      $('recvFileSize').textContent = fmtBytes(incomingMeta.size);
      $('recvProgressFill').classList.remove('done');
      $('recvProgressFill').style.width = '0%';
      $('recvProgressPct').textContent = '0%';

      if (folderMember) {
        // Folder members always buffer to memory (later zipped); sender streams
        // immediately without waiting for a ready signal.
        receivedBuffers = [];
        fileCrc = 0xFFFFFFFF;
        $('recvProgressState').textContent = `receiving ${activeFolder.files.length + 1}/${activeFolder.count}…`;
        setLink('transferring');
      } else {
        // Loose/single file: choose memory vs disk, then signal 'ready'. The
        // sender is holding until we do.
        $('recvProgressState').textContent = 'preparing…';
        await prepareLooseSink();
        if (!incomingMeta) return; // reset/aborted while the save prompt was open
        $('recvProgressState').textContent =
          fileSink && fileSink.mode === 'disk' ? 'receiving to disk…' : 'receiving…';
        setLink('transferring');
      }

    } else if (msg.kind === 'done') {
      if (!incomingMeta) return; // 'done' with no announced file — ignore

      if (activeFolder && incomingMeta.path) {
        // Folder member: verify, then hold it until folder-end zips everything
        const blob = new Blob(receivedBuffers, { type: incomingMeta.mime });
        receivedBuffers = [];
        if (blob.size !== incomingMeta.size) {
          incomingMeta = null;
          $('recvProgressState').textContent = 'incomplete — transfer failed';
          $('recvProgressSpeed').textContent = '';
          setLink('connected');
          return; // no ack — sender aborts via timeout
        }
        activeFolder.files.push({ path: incomingMeta.path, blob, crc: (fileCrc ^ 0xFFFFFFFF) >>> 0 });
        incomingMeta = null;
        if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ kind: 'ack' }));
        return;
      }

      // Loose/single file via sink: drain writes, verify byte count, finalize
      let ok = false;
      try {
        await writeChain;
        ok = receivedBytes === incomingMeta.size;
      } catch { ok = false; }
      if (!ok) {
        await abortLooseSinkAsync();
        incomingMeta = null;
        $('recvProgressState').textContent = 'incomplete — transfer failed';
        $('recvProgressSpeed').textContent = '';
        setLink('connected');
        return; // no ack
      }
      let blob;
      try {
        blob = await fileSink.finish(); // Blob (memory) or null (disk, already saved)
      } catch {
        fileSink = null;
        incomingMeta = null;
        $('recvProgressState').textContent = 'could not save — transfer failed';
        setLink('connected');
        return; // no ack
      }
      const name = incomingMeta.name;
      const bytes = receivedBytes;
      fileSink = null;
      if (blob) addReceivedFile(name, blob);   // memory: offer a download link
      else addSavedRow(name, bytes);           // disk: already written
      $('recvProgressFill').classList.add('done');
      $('recvProgressState').textContent = blob ? 'received' : 'saved to disk ✓';
      $('recvProgressSpeed').textContent = '';
      setLink('connected');
      incomingMeta = null;
      if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ kind: 'ack' }));

    } else if (msg.kind === 'ack') {
      // Sender side: receiver confirmed it has the whole file — release the queue
      $('sendProgressFill').classList.add('done');
      $('sendProgressFill').style.width = '100%';
      $('sendProgressPct').textContent = '100%';
      if (ackResolve) ackResolve();

    } else if (msg.kind === 'ready') {
      // Sender side: receiver's sink is set up — start streaming this file
      if (readyResolve) readyResolve();
    }
    // any other kind: not part of the protocol — ignore
    return;
  }

  // binary chunk
  if (!incomingMeta) return; // chunk with no announced file — drop it
  receivedBytes += data.byteLength;
  if (activeFolder && incomingMeta.path) {
    receivedBuffers.push(data);
    fileCrc = crc32Update(fileCrc, new Uint8Array(data)); // zip needs a CRC per file
  } else {
    sinkWrite(data);
  }
  paintProgress('recv', receivedBytes, incomingMeta.size, recvStarted);
}

function addReceivedFile(name, blob, note) {
  const row = document.createElement('div');
  row.className = 'file-row';
  const label = document.createElement('span');
  label.className = 'name';
  label.textContent = name;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  objectUrls.push(link.href);
  link.download = name;
  link.textContent = note ? `Save · ${note} (${fmtBytes(blob.size)})` : `Save (${fmtBytes(blob.size)})`;
  row.append(label, link);
  $('receivedFiles').appendChild(row);
}

// ---------- UI wiring ----------
$('btnSend').onclick = async () => {
  teardownConnection();
  history.replaceState(null, '', location.pathname);
  role = 'send';
  show('screen-sender-wait');
  $('senderStatus').textContent = 'Requesting a code…';
  setBanner('');
  try {
    await connectSignaling();
    ws.send(JSON.stringify({ type: 'create' }));
  } catch (e) {
    $('senderStatus').textContent = e.message;
  }
};

$('btnReceive').onclick = () => {
  teardownConnection();
  history.replaceState(null, '', location.pathname);
  role = 'receive';
  show('screen-receiver-join');
  $('codeInput').value = '';
  $('joinStatus').textContent = '';
  setBanner('');
  $('codeInput').focus();
};

async function joinRoom(code) {
  if (code.length !== 6) {
    $('joinStatus').textContent = 'Enter the full 6-character code.';
    $('joinStatus').classList.add('err');
    return;
  }
  teardownConnection(); // drop any half-open socket from a previous attempt
  $('btnJoin').disabled = true;
  $('joinStatus').classList.remove('err');
  $('joinStatus').textContent = 'Connecting…';
  try {
    await connectSignaling();
    ws.send(JSON.stringify({ type: 'join', code }));
  } catch (e) {
    $('btnJoin').disabled = false;
    $('joinStatus').textContent = e.message;
    $('joinStatus').classList.add('err');
  }
}

$('btnJoin').onclick = () => joinRoom($('codeInput').value.trim().toUpperCase());
$('codeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btnJoin').click();
});
$('codeInput').addEventListener('input', () => {
  $('codeInput').value = $('codeInput').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

// Copy helpers — clipboard API needs a secure origin, so fall back to
// execCommand for plain-http LAN addresses (e.g. on a phone)
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}
async function copyWithFeedback(btn, text) {
  await copyText(text);
  const prev = btn.textContent;
  btn.textContent = 'Copied ✓';
  setTimeout(() => (btn.textContent = prev), 1400);
}
$('btnCopyCode').onclick = (e) => copyWithFeedback(e.target, $('roomCode').textContent);
$('btnCopyLink').onclick = (e) => copyWithFeedback(e.target, `${shareBase}/#${$('roomCode').textContent}`);
$('roomCode').onclick = () => copyWithFeedback($('btnCopyCode'), $('roomCode').textContent);

// File picking
const dropZone = $('dropZone');
const fileInput = $('fileInput');
dropZone.onclick = () => fileInput.click();
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag');

  // webkitGetAsEntry lets us tell folders from files in a drop
  const entries = [...(e.dataTransfer.items || [])]
    .map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry())
    .filter(Boolean);

  if (!entries.some((en) => en.isDirectory)) {
    queueFiles([...e.dataTransfer.files]);
    return;
  }

  const looseFiles = [];
  for (const entry of entries) {
    if (entry.isDirectory) {
      queueFolder(entry.name, await collectDirEntries(entry, ''));
    } else {
      looseFiles.push(await new Promise((res, rej) => entry.file(res, rej)));
    }
  }
  queueFiles(looseFiles);
});

// Recursively walk a dropped directory, keeping relative paths for the zip
async function collectDirEntries(dirEntry, base) {
  const reader = dirEntry.createReader();
  const children = [];
  // readEntries returns results in batches; keep calling until it's empty
  while (true) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    children.push(...batch);
  }
  const out = [];
  for (const child of children) {
    if (child.isDirectory) {
      out.push(...await collectDirEntries(child, `${base}${dirEntry.name}/`));
    } else {
      const file = await new Promise((res, rej) => child.file(res, rej));
      out.push({ file, path: `${base}${dirEntry.name}/${child.name}` });
    }
  }
  return out;
}

fileInput.addEventListener('change', () => {
  queueFiles([...fileInput.files]);
  fileInput.value = '';
});

const folderInput = $('folderInput');
$('btnPickFolder').onclick = () => folderInput.click();
folderInput.addEventListener('change', () => {
  const files = [...folderInput.files];
  if (files.length) {
    // webkitRelativePath is "root/sub/file.txt" — root segment names the folder
    const name = files[0].webkitRelativePath.split('/')[0];
    queueFolder(name, files.map((f) => ({ file: f, path: f.webkitRelativePath })));
  }
  folderInput.value = '';
});

$('btnSendAnother').onclick = () => {
  $('sendProgressArea').classList.add('hidden');
  $('btnSendAnother').classList.add('hidden');
  $('pickArea').classList.remove('hidden');
};

['backFromSenderWait', 'backFromReceiverJoin', 'backFromSenderFile', 'backFromReceiverFile']
  .forEach((id) => ($(id).onclick = resetAll));

// Opened via a shared link (#CODE) → jump straight into the receiver flow
const hash = location.hash.slice(1).toUpperCase();
if (/^[A-Z0-9]{6}$/.test(hash)) {
  role = 'receive';
  show('screen-receiver-join');
  $('codeInput').value = hash;
  joinRoom(hash);
}

setLink('idle');
