'use strict';

// Pure, DOM-free helpers shared by the browser client (loaded as globals via a
// <script> tag) and the Node test suite (required as a module). Keeping them
// here means the transfer-critical logic — formatting, path sanitizing, the
// CRC32 and ZIP writer — can be unit-tested without a browser.
(function (root) {
  // ---------- Formatting ----------
  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }
  function fmtEta(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '';
    const total = Math.ceil(seconds);
    if (total < 60) return `${total}s left`;
    return `${Math.floor(total / 60)}m ${total % 60}s left`;
  }

  // ---------- Path hardening ----------
  // The peer controls names and paths, so treat them as hostile: strip drive
  // letters, leading slashes, ".." segments, and normalize backslashes before
  // they become zip entries or download names.
  function sanitizePath(p) {
    return String(p)
      .replace(/\\/g, '/')
      .split('/')
      .filter((seg) => seg && seg !== '.' && seg !== '..' && !/^[a-z]:$/i.test(seg))
      .join('/');
  }
  function sanitizeName(name) {
    return sanitizePath(name).split('/').pop() || 'file';
  }

  // ---------- CRC32 (needed for ZIP entries) ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32Update(crc, bytes) {
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return crc >>> 0;
  }

  // ---------- Minimal ZIP writer (store method, no compression) ----------
  // Rebuilds a received folder as a single .zip the browser can download, with
  // the directory structure preserved in the entry paths. Limit: no ZIP64, so
  // individual files and the archive must stay under 4 GB.
  // files: [{ path: string, blob: Blob, crc: number }]
  function buildZip(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;

    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    for (const f of files) {
      const nameBytes = enc.encode(f.path);
      const size = f.blob.size; // actual received bytes, not the declared size

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);  // local file header signature
      local.setUint16(4, 20, true);          // version needed
      local.setUint16(6, 0x0800, true);      // flags: UTF-8 file names
      local.setUint16(8, 0, true);           // method: store
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, f.crc, true);
      local.setUint32(18, size, true);       // compressed size (= raw, stored)
      local.setUint32(22, size, true);       // uncompressed size
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);          // extra field length
      parts.push(local.buffer, nameBytes, f.blob);

      const cent = new DataView(new ArrayBuffer(46));
      cent.setUint32(0, 0x02014b50, true);   // central directory signature
      cent.setUint16(4, 20, true);           // version made by
      cent.setUint16(6, 20, true);           // version needed
      cent.setUint16(8, 0x0800, true);
      cent.setUint16(10, 0, true);
      cent.setUint16(12, dosTime, true);
      cent.setUint16(14, dosDate, true);
      cent.setUint32(16, f.crc, true);
      cent.setUint32(20, size, true);
      cent.setUint32(24, size, true);
      cent.setUint16(28, nameBytes.length, true);
      cent.setUint32(42, offset, true);      // offset of local header
      central.push(cent.buffer, nameBytes);

      offset += 30 + nameBytes.length + size;
    }

    let centralSize = 0;
    for (const c of central) centralSize += c.byteLength;
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);     // end-of-central-directory signature
    eocd.setUint16(8, files.length, true);
    eocd.setUint16(10, files.length, true);
    eocd.setUint32(12, centralSize, true);
    eocd.setUint32(16, offset, true);        // central directory starts after all file data
    parts.push(...central, eocd.buffer);

    return new Blob(parts, { type: 'application/zip' });
  }

  const api = { fmtBytes, fmtEta, sanitizePath, sanitizeName, CRC_TABLE, crc32Update, buildZip };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node (tests)
  else Object.assign(root, api);                                            // browser (globals)
})(typeof window !== 'undefined' ? window : globalThis);
