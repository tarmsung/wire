'use strict';
// Unit tests for the transfer-critical pure logic (formatting, path hardening,
// CRC32, and the ZIP writer). No browser needed — wire-lib.js exports for Node.
const test = require('node:test');
const assert = require('node:assert');
const lib = require('../public/wire-lib.js');

const crc32 = (bytes) => (lib.crc32Update(0xFFFFFFFF, bytes) ^ 0xFFFFFFFF) >>> 0;

test('fmtBytes scales across units', () => {
  assert.equal(lib.fmtBytes(0), '0 B');
  assert.equal(lib.fmtBytes(512), '512 B');
  assert.equal(lib.fmtBytes(1024), '1.0 KB');
  assert.equal(lib.fmtBytes(1536), '1.5 KB');
  assert.equal(lib.fmtBytes(1024 ** 2), '1.0 MB');
  assert.equal(lib.fmtBytes(1024 ** 3), '1.00 GB');
});

test('fmtEta carries the remainder and guards bad input', () => {
  assert.equal(lib.fmtEta(0), '0s left');
  assert.equal(lib.fmtEta(45), '45s left');
  assert.equal(lib.fmtEta(59.9), '1m 0s left'); // the old "1m 60s left" bug
  assert.equal(lib.fmtEta(125), '2m 5s left');
  assert.equal(lib.fmtEta(Infinity), '');
  assert.equal(lib.fmtEta(-5), '');
});

test('sanitizePath neutralizes traversal, drive letters, leading slashes', () => {
  assert.equal(lib.sanitizePath('a/b/c.txt'), 'a/b/c.txt');
  assert.equal(lib.sanitizePath('../../evil.exe'), 'evil.exe');
  assert.equal(lib.sanitizePath('/etc/passwd'), 'etc/passwd');
  assert.equal(lib.sanitizePath('C:\\Windows\\system32\\x.dll'), 'Windows/system32/x.dll');
  assert.equal(lib.sanitizePath('a/../../b'), 'a/b');
});

test('sanitizeName reduces to a safe basename', () => {
  assert.equal(lib.sanitizeName('../../evil.exe'), 'evil.exe');
  assert.equal(lib.sanitizeName('folder/sub/report.pdf'), 'report.pdf');
  assert.equal(lib.sanitizeName(''), 'file');
});

test('crc32 matches the standard check value', () => {
  // CRC-32 of "123456789" is the well-known 0xCBF43926
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
});

test('buildZip writes a valid, byte-correct store archive', async () => {
  const enc = new TextEncoder();
  const a = enc.encode('hello world');
  const b = enc.encode('second file contents, a bit longer');
  const files = [
    { path: 'docs/a.txt', blob: new Blob([a]), crc: crc32(a) },
    { path: 'docs/sub/b.bin', blob: new Blob([b]), crc: crc32(b) },
  ];

  const buf = Buffer.from(await lib.buildZip(files).arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = new TextDecoder();

  const entries = [];
  let off = 0;
  while (off + 4 <= buf.length && dv.getUint32(off, true) === 0x04034b50) {
    const crc = dv.getUint32(off + 14, true) >>> 0;
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const start = off + 30 + nameLen + extraLen;
    entries.push({
      name: dec.decode(buf.subarray(off + 30, off + 30 + nameLen)),
      crc,
      data: buf.subarray(start, start + size),
    });
    off += 30 + nameLen + extraLen + size;
  }

  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'docs/a.txt');
  assert.equal(entries[1].name, 'docs/sub/b.bin');
  assert.equal(entries[0].data.toString(), 'hello world');
  assert.equal(entries[1].data.toString(), 'second file contents, a bit longer');
  assert.equal(entries[0].crc, files[0].crc);
  assert.equal(entries[1].crc, files[1].crc);

  // End-of-central-directory record: signature + entry count
  const eocd = new DataView(buf.buffer, buf.byteOffset + buf.length - 22, 22);
  assert.equal(eocd.getUint32(0, true), 0x06054b50);
  assert.equal(eocd.getUint16(10, true), 2);
});
