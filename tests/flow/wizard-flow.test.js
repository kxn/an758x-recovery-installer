'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createHarness, W } = require('./harness.js');

function makeZip(model, boardData) {
  const bl2 = new Uint8Array([1, 2, 3]);
  const fip = new Uint8Array([9, 8, 7, 6, 5]);
  const fb = new Uint8Array(0x20000);
  const files = {
    'images/bl2.bin': { size: bl2.length, sha256: W.sha256Bytes(bl2) },
    'images/fip.bin': { size: fip.length, sha256: W.sha256Bytes(fip) },
    'original/firstblock.bin': { size: fb.length, sha256: W.sha256Bytes(fb) },
  };
  const entries = [];
  for (const spec of boardData) {
    const data = new Uint8Array(spec.size);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    files[`board/${spec.target}.bin`] = { size: data.length, sha256: W.sha256Bytes(data) };
    entries.push({ path: `board/${spec.target}.bin`, data });
  }
  const manifest = {
    schema: 1,
    target: 'xg-040g-md',
    uboot_model: model,
    uboot_commit: 'a'.repeat(40),
    stock_commit: 'b'.repeat(40),
    boot_image_kind: 'preloader',
    files,
    board_data: boardData.map(spec => ({
      path: `board/${spec.target}.bin`,
      source_kind: 'mtd',
      source_name: spec.target,
      source_offset: null,
      target_volume: spec.target,
    })),
  };
  return W.buildZip([
    { path: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest)) },
    { path: 'images/bl2.bin', data: bl2 },
    { path: 'images/fip.bin', data: fip },
    { path: 'original/firstblock.bin', data: fb },
    ...entries,
  ]);
}

function zipFile(zip) {
  return new File([zip], 'backup.zip', { type: 'application/zip' });
}

async function inspect(h, zip) {
  h.el('wizardZip').files = [zipFile(zip)];
  await h.sandbox.__wizard.refresh();
  await h.sandbox.__wizard.inspect();
}

test('fresh device: rebuild, FIP, board data, verify, mark, then sysupgrade', async () => {
  const h = createHarness({});
  const zip = makeZip('Nokia XG-040G-MD', [
    { target: 'bosa', size: 8 },
    { target: 'ri', size: 8 },
  ]);
  await h.sandbox.__wizard.refresh();
  assert.strictEqual(h.el('wizardSysupgradeStep').hidden, true);
  assert.strictEqual(h.state.log.length, 0, 'no writes before inspect');

  await inspect(h, zip);
  assert.strictEqual(h.el('wizardPlanStep').hidden, false, 'plan shown after valid ZIP');

  h.el('wizardConfirm').checked = true;
  await h.sandbox.__wizard.install();

  const ops = h.state.log.filter(e => e.op === 'task').map(e => e.payload.operation);
  assert.strictEqual(ops[0], 'ubi-rebuild', 'rebuild comes first');
  assert.strictEqual(ops[1], 'flash-uboot', 'FIP second');
  assert.strictEqual(ops[2], 'flash-board-data', 'board data third');
  assert.strictEqual(ops[3], 'flash-board-data', 'board data fourth');
  assert.ok(ops.filter(op => op === 'env-set').length >= 3, 'env markers written');
  assert.strictEqual(h.state.env.wizard_done, '1');

  // Board data uploads were serialized: upload then task per volume.
  const uploads = h.state.log.filter(e => e.op === 'upload');
  assert.ok(uploads.length >= 3, 'FIP + two board uploads');
  assert.strictEqual(h.el('wizardSysupgradeStep').hidden, false);
});

test('refreshing a fresh device never rebuilds', async () => {
  const h = createHarness({});
  await h.sandbox.__wizard.refresh();
  const tasks = h.state.log.filter(e => e.op === 'task');
  assert.strictEqual(tasks.length, 0, 'refresh must not start any task');
});

test('base volumes exist without done flag: no rebuild, only mismatches written', async () => {
  const h = createHarness({
    storage: {
      targets: [
        { kind: 'ubi', name: 'fip', size: 0 },
        { kind: 'ubi', name: 'ubootenv', size: 0 },
        { kind: 'ubi', name: 'ubootenv2', size: 0 },
        { kind: 'ubi', name: 'bosa', size: 8 },
        { kind: 'ubi', name: 'ri', size: 8 },
      ],
    },
    volumes: {
      fip: new Uint8Array([9, 8, 7, 6, 5]),
      bosa: new Uint8Array(8).fill(1),
      ri: new Uint8Array(8).fill(2),
    },
  });
  const zip = makeZip('Nokia XG-040G-MD', [
    { target: 'bosa', size: 8 },
    { target: 'ri', size: 8 },
  ]);
  await inspect(h, zip);
  h.el('wizardConfirm').checked = true;
  await h.sandbox.__wizard.install();

  const ops = h.state.log.filter(e => e.op === 'task').map(e => e.payload.operation);
  assert.ok(!ops.includes('ubi-rebuild'), 'must not rebuild when base volumes exist');
  assert.ok(!ops.includes('flash-uboot'), 'FIP already matches, must not rewrite');
  // bosa (all 1s) and ri (all 2s) differ from the ZIP content (0..7):
  assert.strictEqual(ops.filter(op => op === 'flash-board-data').length, 2);
  assert.strictEqual(h.state.env.wizard_done, '1');
});

test('wrong model ZIP is rejected before any write', async () => {
  const h = createHarness({});
  const zip = makeZip('Nokia XG-040G-TF', [{ target: 'bosa', size: 8 }]);
  await inspect(h, zip);
  assert.strictEqual(h.el('wizardPlanStep').hidden, true, 'plan hidden on wrong model');
  assert.strictEqual(h.el('wizardZipReport').className, 'error');
  assert.match(h.el('wizardZipReport').textContent, /model/i);
  assert.strictEqual(h.state.log.filter(e => e.op === 'task').length, 0);
});

test('board size mismatch is rejected before any write', async () => {
  const h = createHarness({});
  const zip = makeZip('Nokia XG-040G-MD', [{ target: 'bosa', size: 16 }]);
  await inspect(h, zip);
  assert.strictEqual(h.el('wizardPlanStep').hidden, true);
  assert.strictEqual(h.state.log.filter(e => e.op === 'task').length, 0);
});

test('done flag jumps straight to sysupgrade only when saved hashes verify', async () => {
  // Real devices write wizard_done together with wizard_fip_sha; the page
  // must only trust the marker after the volumes match those hashes.
  const h = createHarness({
    env: { wizard_done: '1', wizard_target: 'xg-040g-md', wizard_fip_sha: 'f'.repeat(64) },
    storage: { targets: [{ kind: 'ubi', name: 'fit', size: 1 }] },
    volumes: {},
  });
  await h.sandbox.__wizard.refresh();
  // Mismatched hash: the marker is a hint, not proof — ZIP must be requested.
  assert.strictEqual(h.el('wizardZipStep').hidden, false, 'hash mismatch must ask for ZIP');

  // A correct hash verifies the completed state.
  const fip = new Uint8Array([9, 8, 7, 6, 5]);
  const h2 = createHarness({
    env: { wizard_done: '1', wizard_target: 'xg-040g-md', wizard_fip_sha: W.sha256Bytes(fip) },
    storage: { targets: [{ kind: 'ubi', name: 'fit', size: 1 }] },
    volumes: { fip },
  });
  await h2.sandbox.__wizard.refresh();
  assert.strictEqual(h2.el('wizardZipStep').hidden, true);
  assert.strictEqual(h2.el('wizardSysupgradeStep').hidden, false);
});

test('unmappable board data refuses to plan', async () => {
  const h = createHarness({});
  const zip = makeZip('Nokia XG-040G-MD', [
    { target: 'bosa', size: 8 },
    { target: 'ri', size: 8 },
  ]);
  h.state.device.board_data.push({ kind: 'ubi', target: 'extra', size: 8 });
  await inspect(h, zip);
  assert.strictEqual(h.el('wizardPlanStep').hidden, true, 'extra device volume refuses the plan');
  assert.strictEqual(h.state.log.filter(e => e.op === 'task').length, 0);
});

test('done flag with missing volumes falls back to asking for the ZIP', async () => {
  // Marker says done, but the flash was later erased: fip/board volumes are
  // gone. The page must not dead-end — it has to offer the ZIP step again.
  const h = createHarness({
    env: { wizard_done: '1', wizard_target: 'xg-040g-md' },
    storage: { targets: [] },
  });
  await h.sandbox.__wizard.refresh();
  assert.strictEqual(h.el('wizardZipStep').hidden, false, 'ZIP entry must be offered');
  assert.strictEqual(h.el('wizardSysupgradeStep').hidden, true, 'no sysupgrade without a fit volume');
});

test('chained tasks survive a transient busy (409) response', async () => {
  const h = createHarness({});
  const zip = makeZip('Nokia XG-040G-MD', [
    { target: 'bosa', size: 8 },
    { target: 'ri', size: 8 },
  ]);
  await inspect(h, zip);
  // Fail the very next task POST once, like a device that answers 409 busy.
  h.state.failNextTask = true;
  h.el('wizardConfirm').checked = true;
  await h.sandbox.__wizard.install();
  assert.strictEqual(h.state.env.wizard_done, '1', 'retry must eventually write the marker');
  assert.ok(h.state.log.some(e => e.op === 'busy409'), 'the busy path was exercised');
});

test('successful sysupgrade boots the new system automatically', async () => {
  const h = createHarness({
    env: { wizard_done: '1', wizard_target: 'xg-040g-md' },
    storage: { targets: [
      { kind: 'ubi', name: 'fip', size: 0 },
      { kind: 'ubi', name: 'ubootenv', size: 0 },
      { kind: 'ubi', name: 'ubootenv2', size: 0 },
      { kind: 'ubi', name: 'bosa', size: 8 },
      { kind: 'ubi', name: 'ri', size: 8 },
    ]},
    volumes: { fip: new Uint8Array([9, 8, 7, 6, 5]) },
  });
  const fip = new Uint8Array([9, 8, 7, 6, 5]);
  h.state.env.wizard_fip_sha = W.sha256Bytes(fip);
  await h.sandbox.__wizard.refresh();
  assert.strictEqual(h.el('wizardSysupgradeStep').hidden, false, 'sysupgrade step visible');
  // Click the flash button handler with a fake firmware file.
  const fake = new Blob([new Uint8Array([1, 2, 3])]);
  h.el('wizardFirmware').files = [fake];
  await h.el('wizardFlashButton').onclick();
  const ops = h.state.log.filter(e => e.op === 'task').map(e => e.payload.operation);
  assert.ok(ops.includes('flash'), 'sysupgrade flash task ran');
  assert.ok(ops.includes('boot-production'), 'boot-production follows a successful flash');
});
