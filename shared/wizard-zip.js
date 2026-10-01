/*
 * Shared backup ZIP v1 library for the AN758x wizard.
 *
 * Runs unchanged in:
 *   - the stock firmware page (an758x-stock2ubi, served over plain HTTP)
 *   - the Web U-Boot recovery page (uboot-an758x httpd)
 *   - Node.js host tests (`node --test tests/*.test.js`)
 *
 * Deliberately avoids `crypto.subtle` (not available on insecure origins) and
 * any other browser API that is missing in one of the two embeds. The file is
 * inlined into each page at build time; neither web server routes standalone
 * JS resources.
 *
 * ZIP constraints (backup ZIP v1):
 *   - STORE only (compression method 0); compressed entries are rejected
 *   - data descriptor is optional and must be consistent with the central
 *     directory when present
 *   - paths must be relative, `..`-free, not absolute, no backslashes, no
 *     drive letters, no duplicates, and NUL-free
 *   - total uncompressed size is limited by `options.maxTotalSize`
 *   - every extracted byte is checked against the local header CRC-32; file
 *     SHA-256s are checked by the caller via manifest.files
 */
'use strict';

const CRC_TABLE = (function () {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Bytes(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function sha256Bytes(bytes) {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const bitLenHi = Math.floor(bytes.length / 0x20000000);
  const bitLenLo = (bytes.length << 3) >>> 0;
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLenHi);
  dv.setUint32(padded.length - 4, bitLenLo);
  const w = new Uint32Array(64);
  for (let i = 0; i < padded.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = (w[t - 15] >>> 7 | w[t - 15] << 25) ^ (w[t - 15] >>> 18 | w[t - 15] << 14) ^ (w[t - 15] >>> 3);
      const s1 = (w[t - 2] >>> 17 | w[t - 2] << 15) ^ (w[t - 2] >>> 19 | w[t - 2] << 13) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const S1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  let hex = '';
  for (let i = 0; i < 8; i++) hex += H[i].toString(16).padStart(8, '0');
  return hex;
}

function sha256Hex(bytes) {
  if (typeof bytes === 'string') bytes = utf8Encode(bytes);
  return sha256Bytes(bytes);
}

/* --------------------------- UTF-8 helpers ----------------------------- */
/* The page may run in a bare WebView without TextEncoder/TextDecoder. */

function utf8Encode(text) {
  let size = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    size += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
  }
  const out = new Uint8Array(size);
  let pos = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      out[pos++] = code;
    } else if (code < 0x800) {
      out[pos++] = 0xc0 | (code >> 6);
      out[pos++] = 0x80 | (code & 0x3f);
    } else {
      out[pos++] = 0xe0 | (code >> 12);
      out[pos++] = 0x80 | ((code >> 6) & 0x3f);
      out[pos++] = 0x80 | (code & 0x3f);
    }
  }
  return out;
}

function utf8Decode(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i++) {
    const lead = bytes[i];
    if (lead < 0x80) {
      text += String.fromCharCode(lead);
    } else if ((lead & 0xe0) === 0xc0 && i + 1 < bytes.length) {
      text += String.fromCharCode(((lead & 0x1f) << 6) | (bytes[++i] & 0x3f));
    } else if ((lead & 0xf0) === 0xe0 && i + 2 < bytes.length) {
      text += String.fromCharCode(
        ((lead & 0x0f) << 12) | ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f));
    } else {
      text += String.fromCharCode(0xfffd);
    }
  }
  return text;
}

function sha256BytesAsync(bytes) {
  return Promise.resolve(sha256Bytes(bytes));
}

class WizardError extends Error {}

const MAX_FILE_BYTES = 64 * 1024 * 1024;   // sanity cap for a single entry
const DEFAULT_MAX_TOTAL = 16 * 1024 * 1024; // backup ZIP v1 limit

function isSafePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 512) return false;
  if (path.includes('\0') || path.includes('\\')) return false;
  if (path.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  if (path.split('/').includes('..')) return false;
  return true;
}

/* ------------------------------- reading ------------------------------- */

function validateLocalHeader(view, at, entry) {
  if (at + 30 > view.byteLength || view.getUint32(at, true) !== 0x04034b50) {
    throw new WizardError(`ZIP local header missing at offset ${at}`);
  }
  const method = view.getUint16(at + 8, true);
  const flags = view.getUint16(at + 6, true);
  const crc32 = view.getUint32(at + 14, true);
  const compressed = view.getUint32(at + 18, true);
  const uncompressed = view.getUint32(at + 22, true);
  const nameLen = view.getUint16(at + 26, true);
  const extraLen = view.getUint16(at + 28, true);
  if (method !== 0) throw new WizardError(`Compressed ZIP entry rejected (${entry.path})`);
  const start = at + 30 + nameLen + extraLen;
  if (start + compressed > view.byteLength) throw new WizardError('ZIP entry data runs past the end of the file');
  if (!(flags & 0x08)) {
    if (crc32 !== entry.crc32) throw new WizardError(`Local header CRC mismatch (${entry.path})`);
    if (compressed !== entry.compressed) throw new WizardError(`Local header size mismatch (${entry.path})`);
    if (uncompressed !== entry.size) throw new WizardError(`Local header size mismatch (${entry.path})`);
  }
  return { start, compressed };
}

function parseZip(bytes, options) {
  const opts = options || {};
  const maxTotal = opts.maxTotalSize || DEFAULT_MAX_TOTAL;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new WizardError('ZIP end-of-central-directory record not found');
  const entryCount = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset + cdSize > bytes.length) throw new WizardError('ZIP central directory range is invalid');

  const entries = [];
  const paths = new Set();
  let total = 0;
  let at = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (at + 46 > cdOffset + cdSize) throw new WizardError('ZIP central directory is truncated');
    if (view.getUint32(at, true) !== 0x02014b50) throw new WizardError('ZIP central directory entry magic missing');
    const method = view.getUint16(at + 10, true);
    const crc32 = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const nameBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + at + 46, nameLen);
    let path = '';
    for (let i = 0; i < nameLen; i++) path += String.fromCharCode(nameBytes[i]);
    if (method !== 0) throw new WizardError(`Compressed ZIP entry rejected (${path})`);
    if (!isSafePath(path)) throw new WizardError(`Unsafe ZIP entry path (${path})`);
    if (paths.has(path)) throw new WizardError(`Duplicate ZIP entry path (${path})`);
    paths.add(path);
    total += size;
    if (size > MAX_FILE_BYTES || total > maxTotal) throw new WizardError('ZIP exceeds the backup size limit');
    if (localAt + 30 > bytes.length) throw new WizardError(`ZIP local header offset invalid (${path})`);
    const entry = { path, size, crc32, compressed, localAt };
    const span = validateLocalHeader(view, localAt, entry);
    entry.dataStart = span.start;
    entries.push(entry);
    at += 46 + nameLen + extraLen + commentLen;
  }

  const files = new Map();
  for (const entry of entries) {
    const data = new Uint8Array(bytes.buffer, bytes.byteOffset + entry.dataStart, entry.size);
    const actualCrc = crc32Bytes(data);
    if (actualCrc !== entry.crc32) throw new WizardError(`CRC mismatch (${entry.path})`);
    files.set(entry.path, data);
  }
  return { entries, files };
}

/* ------------------------------- writing ------------------------------- */

function localFileHeader(name, crc32, size) {
  const nameBytes = utf8Encode(name);
  const buffer = new ArrayBuffer(30);
  const view = new DataView(buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);          // version needed
  view.setUint16(6, 0x0800, true);      // UTF-8 flag (no data descriptor)
  view.setUint16(8, 0, true);           // STORE
  view.setUint16(10, 0, true);          // mod time
  view.setUint16(12, 0x21, true);       // mod date 1980-01-01
  view.setUint32(14, crc32, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true);
  return { header: new Uint8Array(buffer), name: nameBytes };
}

function centralDirectoryEntry(name, crc32, size, localAt) {
  const nameBytes = utf8Encode(name);
  const extra = new ArrayBuffer(46);
  const view = new DataView(extra);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);          // version made by
  view.setUint16(6, 20, true);          // version needed
  view.setUint16(8, 0x0800, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, 0x21, true);
  view.setUint32(16, crc32, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, nameBytes.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, localAt, true);
  return { record: new Uint8Array(extra), name: nameBytes };
}

function buildZip(files, options) {
  // files: array of {path, data} in the order they appear in the ZIP.
  const opts = options || {};
  const maxTotal = opts.maxTotalSize || DEFAULT_MAX_TOTAL;
  let total = 0;
  const parts = [];
  const central = [];
  const seen = new Set();
  let localAt = 0;
  for (const file of files) {
    const path = file.path;
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    if (!isSafePath(path)) throw new WizardError(`Unsafe ZIP entry path (${path})`);
    if (seen.has(path)) throw new WizardError(`Duplicate ZIP entry path (${path})`);
    seen.add(path);
    total += data.length;
    if (total > maxTotal) throw new WizardError('ZIP exceeds the backup size limit');
    const crc = crc32Bytes(data);
    const { header, name } = localFileHeader(path, crc, data.length);
    parts.push(header, name, data);
    const { record } = centralDirectoryEntry(path, crc, data.length, localAt);
    central.push(record, name);
    localAt += header.length + name.length + data.length;
  }
  const cdOffset = localAt;
  const cd = central.reduce((acc, part) => acc.concat(Array.from(part)), []);
  const eocd = new ArrayBuffer(22);
  const view = new DataView(eocd);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, files.length, true);
  view.setUint16(10, files.length, true);
  view.setUint32(12, cd.length, true);
  view.setUint32(16, cdOffset, true);
  const flat = parts.map(part => Array.from(part)).reduce((acc, part) => acc.concat(part), []);
  return new Uint8Array(flat.concat(cd, Array.from(new Uint8Array(eocd))));
}

/* ------------------------------- manifest ------------------------------- */

const REQUIRED_KEYS = ['schema', 'target', 'uboot_model', 'uboot_commit', 'stock_commit', 'boot_image_kind'];

function validateManifest(manifest, files) {
  if (!manifest || typeof manifest !== 'object') throw new WizardError('Manifest is missing');
  if (manifest.schema !== 1) throw new WizardError(`Unsupported manifest schema ${manifest.schema}`);
  for (const key of REQUIRED_KEYS) {
    if (key === 'schema') continue;
    if (!manifest[key] || typeof manifest[key] !== 'string') throw new WizardError(`Manifest is missing ${key}`);
  }
  if (manifest.boot_image_kind !== 'preloader' && manifest.boot_image_kind !== 'firstblock') {
    throw new WizardError(`Unknown boot_image_kind ${manifest.boot_image_kind}`);
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.uboot_commit)) throw new WizardError('Invalid uboot_commit');
  if (!/^[0-9a-f]{40}$/.test(manifest.stock_commit)) throw new WizardError('Invalid stock_commit');
  if (!manifest.files || typeof manifest.files !== 'object') throw new WizardError('Manifest is missing files');
  const required = ['images/bl2.bin', 'images/fip.bin', 'original/firstblock.bin'];
  for (const path of required) {
    const entry = manifest.files[path];
    if (!entry || typeof entry.size !== 'number' || !/^[0-9a-f]{64}$/.test(entry.sha256 || '')) {
      throw new WizardError(`Manifest entry missing or invalid (${path})`);
    }
    const data = files.get(path);
    if (!data) throw new WizardError(`ZIP is missing manifest file ${path}`);
    if (data.length !== entry.size) throw new WizardError(`Size mismatch (${path})`);
    if (sha256Bytes(data) !== entry.sha256) throw new WizardError(`SHA-256 mismatch (${path})`);
  }
  for (const path of Object.keys(manifest.files)) {
    if (!files.has(path)) throw new WizardError(`Manifest lists ${path}, which is not in the ZIP`);
  }
  for (const path of files.keys()) {
    if (path !== 'manifest.json' && !manifest.files[path]) throw new WizardError(`ZIP entry ${path} is not in the manifest`);
  }
  if (Array.isArray(manifest.board_data)) {
    const boardPaths = new Set();
    for (const item of manifest.board_data) {
      if (!item || typeof item !== 'object') throw new WizardError('Invalid board_data entry');
      if (!isSafePath(item.path || '')) throw new WizardError(`Unsafe board_data path (${item.path})`);
      if (boardPaths.has(item.path)) throw new WizardError(`Duplicate board_data path (${item.path})`);
      boardPaths.add(item.path);
      if (!manifest.files[item.path]) throw new WizardError(`Board data ${item.path} is missing from files`);
      if (item.source_kind !== 'mtd' && item.source_kind !== 'ubi') throw new WizardError(`Unknown board data source kind (${item.path})`);
      if (!item.source_name) throw new WizardError(`Board data ${item.path} is missing source_name`);
      if (!item.target_volume) throw new WizardError(`Board data ${item.path} is missing target_volume`);
    }
  }
  return manifest;
}

function parseManifestZipped(zipFiles, options) {
  const bytes = zipFiles.get('manifest.json');
  if (!bytes) throw new WizardError('manifest.json is missing from the ZIP');
  const text = utf8Decode(bytes);
  let manifest;
  try { manifest = JSON.parse(text); }
  catch (e) { throw new WizardError('manifest.json is not valid JSON'); }
  validateManifest(manifest, zipFiles);
  return manifest;
}

const api = {
  crc32Bytes,
  sha256Bytes,
  sha256Hex,
  sha256BytesAsync,
  parseZip,
  buildZip,
  validateManifest,
  parseManifestZipped,
  WizardError,
  MAX_FILE_BYTES,
  DEFAULT_MAX_TOTAL,
  isSafePath
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') self.An758xWizardZip = api;
if (typeof globalThis !== 'undefined') globalThis.An758xWizardZip = api;
