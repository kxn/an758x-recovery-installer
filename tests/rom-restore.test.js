'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../patches/uboot/files/rom-restore.js'), 'utf8');

function harness(overrides = {}) {
  const elements = {};
  const el = id => elements[id] ||= { hidden: false, checked: false, files: [], textContent: '' };
  const state = {
    device: { model: 'Nokia XG-040G-MF', flash_bytes: 268435456, ram_bytes: 536870912, flash_all: true, ...overrides },
    log: [], error: null, failUpload: false, failWrite: false,
  };
  const words = { zh: {}, en: {} };
  const sandbox = {
    words, el, text: (id, value) => { el(id).textContent = value; },
    t: key => words.en[key] || key, applyLanguage() {}, bytes: String, rebooting: false,
    request: async url => {
      assert.equal(url, '/api/device');
      return state.device;
    },
    uploadFile: async (input, url) => {
      state.log.push({ op: 'upload', url, file: input.files[0] });
      if (state.failUpload) throw new Error('HTTP 400 · Cannot reserve RAM');
      return 7;
    },
    task: async payload => {
      state.log.push({ op: 'task', ...payload });
      if (state.failWrite) throw new Error('verify failed at 0x20000');
    },
    run: async fn => {
      try { await fn(); } catch (error) { state.error = error.message; }
    },
  };
  vm.runInNewContext(source, sandbox);
  // A File-like object intentionally has no arrayBuffer(): restoring a large
  // ROM must send it directly without copying the entire backup into JS RAM.
  el('romImage').files = [{ size: 268435456, name: 'mtd16.bin' }];
  el('romConfirm').checked = true;
  el('romRebootButton').hidden = true;
  return { state, el, sandbox };
}

test('whole-ROM recovery uploads directly, uses flash-all, and offers reboot only after success', async () => {
  const h = harness();
  await h.el('romRestoreButton').onclick();
  assert.equal(h.state.error, null);
  assert.equal(h.state.log[0].url, '/api/upload-all-flash');
  assert.deepEqual(h.state.log[1], { op: 'task', operation: 'flash-all', upload_id: 7 });
  assert.equal(h.el('wizard').hidden, true);
  assert.equal(h.el('romRebootButton').hidden, false);
  assert.equal(h.state.log.length, 2, 'no UBI rebuild, env save or automatic reset');
});

test('partial and OOB-sized images are rejected before upload', async () => {
  for (const size of [131072, 268435457]) {
    const h = harness();
    h.el('romImage').files[0].size = size;
    await h.el('romRestoreButton').onclick();
    assert.match(h.state.error, /size/i);
    assert.equal(h.state.log.length, 0);
  }
});

test('same-device confirmation is required before upload', async () => {
  const h = harness();
  h.el('romConfirm').checked = false;
  await h.el('romRestoreButton').onclick();
  assert.match(h.state.error, /confirm/i);
  assert.equal(h.state.log.length, 0);
});

test('an API without advertised support is rejected before upload', async () => {
  const h = harness({ flash_all: undefined });
  await h.el('romRestoreButton').onclick();
  assert.match(h.state.error, /does not advertise/i);
  assert.equal(h.state.log.length, 0);
});

test('failed upload never starts a write or offers reboot', async () => {
  const h = harness();
  h.state.failUpload = true;
  await h.el('romRestoreButton').onclick();
  assert.match(h.state.error, /HTTP 400.*RAM/);
  assert.equal(h.state.log.filter(e => e.op === 'task').length, 0);
  assert.equal(h.el('romRebootButton').hidden, true);
});

test('failed write preserves the offset and offers no reboot', async () => {
  const h = harness();
  h.state.failWrite = true;
  await h.el('romRestoreButton').onclick();
  assert.match(h.el('romResult').textContent, /keep the device powered/);
  assert.match(h.el('romResult').textContent, /0x20000/);
  assert.equal(h.el('romRebootButton').hidden, true);
});

test('successful restoration can reset without writing environment or rebuilding UBI', async () => {
  const h = harness();
  await h.el('romRestoreButton').onclick();
  await h.el('romRebootButton').onclick();
  assert.deepEqual(h.state.log.at(-1), { op: 'task', operation: 'reset' });
  assert.equal(h.sandbox.rebooting, true);
});
