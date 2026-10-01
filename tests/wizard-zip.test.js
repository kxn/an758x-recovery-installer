'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const W = require('../shared/wizard-zip.js');

test('crc32 matches a known vector', () => {
  assert.strictEqual(W.crc32Bytes(new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39])), 0xcbf43926);
});

test('sha256 matches node crypto', () => {
  const data = crypto.randomBytes(12345);
  const ours = W.sha256Bytes(data);
  const theirs = crypto.createHash('sha256').update(data).digest('hex');
  assert.strictEqual(ours, theirs);
});

test('sha256 matches for empty and small inputs', () => {
  assert.strictEqual(W.sha256Bytes(new Uint8Array(0)), crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  assert.strictEqual(W.sha256Hex('abc'), crypto.createHash('sha256').update('abc').digest('hex'));
});

test('zip round trip preserves files and is STORE', () => {
  const a = new TextEncoder().encode('hello world');
  const b = crypto.randomBytes(70000);
  const zip = W.buildZip([
    { path: 'manifest.json', data: new TextEncoder().encode('{}') },
    { path: 'images/fip.bin', data: a },
    { path: 'board/bosa.bin', data: b }
  ]);
  // Signature is at offset 0; method field of first local header is at 8.
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.strictEqual(view.getUint32(0, true), 0x04034b50);
  assert.strictEqual(view.getUint16(8, true), 0);
  const parsed = W.parseZip(zip);
  assert.deepStrictEqual(Array.from(parsed.files.keys()).sort(),
    ['board/bosa.bin', 'images/fip.bin', 'manifest.json']);
  assert.deepStrictEqual(Array.from(parsed.files.get('images/fip.bin')), Array.from(a));
  assert.deepStrictEqual(Array.from(parsed.files.get('board/bosa.bin')), Array.from(b));
});

test('valid manifest round trips through a real ZIP', () => {
  const bl2 = crypto.randomBytes(4096);
  const fip = crypto.randomBytes(65536);
  const fb = new Uint8Array(0x20000);
  const bosa = new Uint8Array(0x40000);
  const manifest = {
    schema: 1,
    target: 'xg-040g-md',
    uboot_model: 'Nokia XG-040G-MD',
    uboot_commit: 'a'.repeat(40),
    stock_commit: 'b'.repeat(40),
    boot_image_kind: 'preloader',
    files: {
      'images/bl2.bin': { size: bl2.length, sha256: W.sha256Bytes(bl2) },
      'images/fip.bin': { size: fip.length, sha256: W.sha256Bytes(fip) },
      'original/firstblock.bin': { size: fb.length, sha256: W.sha256Bytes(fb) },
      'board/bosa.bin': { size: bosa.length, sha256: W.sha256Bytes(bosa) }
    },
    board_data: [
      { path: 'board/bosa.bin', source_kind: 'mtd', source_name: 'bosa', source_offset: null, target_volume: 'bosa' }
    ]
  };
  const zip = W.buildZip([
    { path: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest)) },
    { path: 'images/bl2.bin', data: bl2 },
    { path: 'images/fip.bin', data: fip },
    { path: 'original/firstblock.bin', data: fb },
    { path: 'board/bosa.bin', data: bosa }
  ]);
  const parsed = W.parseZip(zip);
  const back = W.parseManifestZipped(parsed.files);
  assert.strictEqual(back.target, 'xg-040g-md');
});

test('rejects a corrupted byte', () => {
  const zip = W.buildZip([{ path: 'a.bin', data: new Uint8Array([1, 2, 3, 4]) }]);
  zip[35] ^= 0xff; // inside the stored data (local header 30 bytes + 5-byte name)
  assert.throws(() => W.parseZip(zip), /CRC mismatch/);
});

test('rejects a wrong SHA in the manifest', () => {
  const data = new Uint8Array([9, 9, 9]);
  const manifest = {
    schema: 1, target: 't', uboot_model: 'm', uboot_commit: 'a'.repeat(40),
    stock_commit: 'b'.repeat(40), boot_image_kind: 'preloader',
    files: {
      'images/bl2.bin': { size: 3, sha256: '0'.repeat(64) },
      'images/fip.bin': { size: 3, sha256: W.sha256Bytes(data) },
      'original/firstblock.bin': { size: 3, sha256: W.sha256Bytes(data) }
    }
  };
  const zip = W.buildZip([
    { path: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest)) },
    { path: 'images/bl2.bin', data },
    { path: 'images/fip.bin', data },
    { path: 'original/firstblock.bin', data }
  ]);
  assert.throws(() => W.parseManifestZipped(W.parseZip(zip).files), /SHA-256 mismatch \(images\/bl2\.bin\)/);
});

test('rejects duplicate paths at build time', () => {
  assert.throws(() => W.buildZip([
    { path: 'a.bin', data: new Uint8Array([1]) },
    { path: 'a.bin', data: new Uint8Array([2]) }
  ]), /Duplicate/);
});

test('rejects unsafe paths', () => {
  assert.throws(() => W.buildZip([{ path: '../evil.bin', data: new Uint8Array([1]) }]), /Unsafe/);
  assert.throws(() => W.buildZip([{ path: '/abs.bin', data: new Uint8Array([1]) }]), /Unsafe/);
  assert.throws(() => W.buildZip([{ path: 'C:\\x.bin', data: new Uint8Array([1]) }]), /Unsafe/);
});

test('rejects a compressed entry', () => {
  const name = new TextEncoder().encode('x.bin');
  const data = new Uint8Array([1, 2, 3]);
  // Build a DEFLATE (method 8) local header + central directory by hand.
  const lh = new Uint8Array(30 + name.length);
  const v = new DataView(lh.buffer);
  v.setUint32(0, 0x04034b50, true); v.setUint16(8, 8, true);
  v.setUint32(14, W.crc32Bytes(data), true); v.setUint32(18, 3, true); v.setUint32(22, 3, true);
  v.setUint16(26, name.length, true);
  lh.set(name, 30);
  const cd = new Uint8Array(46 + name.length);
  const c = new DataView(cd.buffer);
  c.setUint32(0, 0x02014b50, true); c.setUint16(10, 8, true);
  c.setUint32(16, W.crc32Bytes(data), true); c.setUint32(20, 3, true); c.setUint32(24, 3, true);
  c.setUint16(28, name.length, true);
  cd.set(name, 46);
  const eocd = new Uint8Array(22);
  const e = new DataView(eocd.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, 1, true); e.setUint16(10, 1, true);
  e.setUint32(12, cd.length, true); e.setUint32(16, lh.length + data.length, true);
  const zip = new Uint8Array([...lh, ...data, ...cd, ...eocd]);
  assert.throws(() => W.parseZip(zip), /Compressed ZIP entry rejected/);
});

test('rejects a ZIP over the total size limit', () => {
  const chunk = new Uint8Array(1024 * 1024);
  const files = [];
  for (let i = 0; i < 17; i++) files.push({ path: `part${i}.bin`, data: chunk });
  assert.throws(() => W.buildZip(files, { maxTotalSize: 16 * 1024 * 1024 }), /size limit/);
});

test('rejects a ZIP whose manifest file is missing', () => {
  const zip = W.buildZip([{ path: 'other.bin', data: new Uint8Array([1]) }]);
  assert.throws(() => W.parseManifestZipped(W.parseZip(zip).files), /manifest\.json/);
});
