'use strict';
// Integration tests for the signaling server: pairing, relay, and the abuse
// defenses (brute-force lockout, room cap, unjoined-room TTL). Each test runs a
// fresh server on its own port with env-tuned limits so they can't interfere.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

const SERVER = path.join(__dirname, '..', 'server.js');
let nextPort = 3200;

function startServer(env) {
  const port = nextPort++;
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const onData = (d) => {
      out += d.toString();
      if (out.includes('running')) { child.stdout.off('data', onData); resolve({ child, port }); }
    };
    child.stdout.on('data', onData);
    child.on('error', reject);
    setTimeout(() => reject(new Error('server did not start: ' + out)), 5000);
  });
}
function open(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((res, rej) => { ws.on('open', () => res(ws)); ws.on('error', rej); });
}
function next(ws) {
  return new Promise((res) => ws.once('message', (d) => res(JSON.parse(d.toString()))));
}
async function withServer(env, fn) {
  const { child, port } = await startServer(env);
  try { await fn(port); } finally { child.kill(); }
}

test('create returns a 6-char code', async () => {
  await withServer({}, async (port) => {
    const ws = await open(port);
    ws.send(JSON.stringify({ type: 'create' }));
    const msg = await next(ws);
    assert.equal(msg.type, 'created');
    assert.match(msg.code, /^[A-Z0-9]{6}$/);
    ws.close();
  });
});

test('join pairs peers and relays signals', async () => {
  await withServer({}, async (port) => {
    const a = await open(port);
    a.send(JSON.stringify({ type: 'create' }));
    const created = await next(a);

    const b = await open(port);
    const aNotified = next(a); // sender should hear peer-joined
    b.send(JSON.stringify({ type: 'join', code: created.code }));
    assert.equal((await next(b)).type, 'joined');
    assert.equal((await aNotified).type, 'peer-joined');

    const bGets = next(b);
    a.send(JSON.stringify({ type: 'signal', data: { sdp: 'offer-here' } }));
    const relayed = await bGets;
    assert.equal(relayed.type, 'signal');
    assert.deepEqual(relayed.data, { sdp: 'offer-here' });

    a.close(); b.close();
  });
});

test('brute-forcing join closes the socket after the cap', async () => {
  await withServer({ MAX_FAILED_JOINS: 3 }, async (port) => {
    const ws = await open(port);
    let errors = 0;
    ws.on('message', (d) => { if (JSON.parse(d.toString()).type === 'error') errors++; });
    const closed = new Promise((res) => ws.on('close', (code) => res(code)));
    for (let i = 0; i < 3; i++) ws.send(JSON.stringify({ type: 'join', code: 'ZZZZZZ' }));
    assert.equal(await closed, 1008);
    assert.ok(errors >= 1, 'should have received at least one error before the close');
  });
});

test('server refuses new rooms past MAX_ROOMS', async () => {
  await withServer({ MAX_ROOMS: 1 }, async (port) => {
    const a = await open(port);
    a.send(JSON.stringify({ type: 'create' }));
    assert.equal((await next(a)).type, 'created');

    const b = await open(port);
    b.send(JSON.stringify({ type: 'create' }));
    assert.equal((await next(b)).type, 'error');

    a.close(); b.close();
  });
});

test('unjoined rooms expire after the TTL', async () => {
  await withServer({ ROOM_TTL_MS: 200, ROOM_SWEEP_MS: 80 }, async (port) => {
    const ws = await open(port);
    ws.send(JSON.stringify({ type: 'create' }));
    assert.equal((await next(ws)).type, 'created');
    assert.equal((await next(ws)).type, 'expired'); // swept because nobody joined
    ws.close();
  });
});

test('re-creating frees the old code', async () => {
  await withServer({}, async (port) => {
    const a = await open(port);
    a.send(JSON.stringify({ type: 'create' }));
    const first = await next(a);
    a.send(JSON.stringify({ type: 'create' }));
    const second = await next(a);
    assert.notEqual(first.code, second.code);

    const b = await open(port);
    b.send(JSON.stringify({ type: 'join', code: first.code }));
    assert.equal((await next(b)).type, 'error'); // old code is gone

    a.close(); b.close();
  });
});
