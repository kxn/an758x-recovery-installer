/*
 * Web U-Boot recovery wizard (uboot-an758x httpd-page).
 *
 * Implements PLAN sections 7 and 8 on top of the existing page helpers
 * (request/task/transfer/uploadFile/run are globals from the page script).
 *
 * State machine on every refresh:
 *   - a task is running          -> show progress, block uploads/writes
 *   - wizard_done=1 and the saved hashes/volumes match -> show sysupgrade
 *   - base volumes exist, no done flag -> ask for ZIP, compare, write only
 *     mismatches; never rebuild by default
 *   - only a stray `fip` volume, missing ubootenv/target volumes -> ask for
 *     ZIP, rebuild, then write
 *   - a valid `fit` volume exists -> keep boot-system / sysupgrade entries
 *
 * Order of operations once Start is pressed (never concurrent, single
 * upload buffer):
 *   1. ubi-rebuild (only when the plan says so), verify the volume set
 *   2. flash-uboot (FIP from the ZIP)
 *   3. flash-board-data for every board volume, one upload + task at a time
 *   4. read back every written volume and check SHA-256
 *   5. env-set wizard_target, wizard_fip_size/sha, wizard_bdN_sha,
 *      then wizard_done=1
 *   6. show the sysupgrade step
 *
 * The page runs over plain HTTP; all ZIP/CRC/SHA code comes from the shared
 * pure-JS library inlined next to this file (no crypto.subtle).
 */
'use strict';
(function () {
  const W = self.An758xWizardZip;
  if (!W) return;

  const MAX_ZIP_TOTAL = 16 * 1024 * 1024;
  const SEQUENCE = ['images/fip.bin']; // board volumes follow device order

  let device = null;
  let storage = null;
  let env = null;
  let zipFiles = null;
  let manifest = null;
  let plan = null;

  const g = id => el(id);

  async function readZip(file) {
    if (!file) throw new Error(t('choose'));
    if (file.size > MAX_ZIP_TOTAL) throw new Error(t('wizardZipTooLarge'));
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = W.parseZip(bytes, { maxTotalSize: MAX_ZIP_TOTAL });
    const man = W.parseManifestZipped(parsed.files);
    return { files: parsed.files, manifest: man };
  }

  function boardVolumes(man) { return (man.board_data || []).map(b => b.target_volume); }

  let savedHashesOk = false;

  async function verifySavedHashes() {
    // PLAN section 8: the wizard_* variables are hints, not proof. Trust
    // wizard_done=1 only when the stored hashes match the volumes on the
    // device. Any failure means "ask for the ZIP again".
    const expected = [];
    if (env.wizard_fip_sha) expected.push({ target: 'fip', sha: env.wizard_fip_sha });
    for (let i = 0; i < 4; i++) {
      const sha = env['wizard_bd' + i + '_sha'];
      if (sha) {
        const spec = (device.board_data || [])[i];
        if (!spec) return false;
        expected.push({ target: spec.target, sha });
      }
    }
    if (expected.length === 0) return false;
    try {
      for (const item of expected) {
        const have = await volumeSha(item.target);
        if (have !== item.sha) return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  async function wizardRefresh() {
    try {
      const [d, s, e] = await Promise.all([
        request('/api/device'), request('/api/storage'), request('/api/env')
      ]);
      device = d; storage = s; env = e;
    } catch (e) {
      return; // device not reachable yet; the page monitor handles that
    }
    savedHashesOk = env.wizard_done === '1' && await verifySavedHashes();
    renderWizard();
  }

  function volumeNames() {
    return new Set((storage.targets || [])
      .filter(v => v.kind === 'ubi')
      .map(v => v.name));
  }

  function hasValidFit() {
    return (storage.targets || []).some(v => v.kind === 'ubi' && v.name === 'fit');
  }

  function renderWizard() {
    const stateBlock = g('wizardStateBlock');
    const zipStep = g('wizardZipStep');
    const planStep = g('wizardPlanStep');
    const progressStep = g('wizardProgressStep');
    const sysupgradeStep = g('wizardSysupgradeStep');

    const names = volumeNames();
    const boardData = device.board_data || [];
    const boardNames = boardData.map(b => b.target);
    const hasBase = names.has('fip') && names.has('ubootenv') &&
      boardNames.length > 0 && boardNames.every(n => names.has(n));
    const strayFip = names.has('fip') && (!names.has('ubootenv') ||
      boardNames.some(n => !names.has(n)));
    const envDone = env.wizard_done === '1' && savedHashesOk;

    stateBlock.textContent = envDone
      ? t('wizardStateDone') + (env.wizard_target ? ' (' + env.wizard_target + ')' : '')
      : hasBase
        ? t('wizardStatePartial')
        : strayFip
          ? t('wizardStateStray')
          : t('wizardStateFresh');

    if (envDone) {
      // Saved markers are only hints (PLAN 8). A completed wizard goes
      // straight to the sysupgrade step; a `fit` volume is only created by
      // the sysupgrade upload, so its absence is expected here. If the base
      // volumes the marker refers to are gone (flash was erased after the
      // marker was written), fall back to asking for the ZIP instead of
      // leaving a dead end.
      const completed = hasBase || hasValidFit();
      planStep.hidden = true;
      progressStep.hidden = true;
      sysupgradeStep.hidden = !completed;
      zipStep.hidden = completed;
      return;
    }

    // After an install that finished writing but whose tail verification
    // could not run, keep the sysupgrade entry visible next to the ZIP step
    // so "validate again" is one click away.
    if (hasBase) {
      sysupgradeStep.hidden = !hasValidFit();
      planStep.hidden = true;
      progressStep.hidden = true;
      zipStep.hidden = false;
      return;
    }

    sysupgradeStep.hidden = !hasValidFit();
    zipStep.hidden = false;
    planStep.hidden = true;
    progressStep.hidden = true;
  }

  async function inspectZip() {
    const file = g('wizardZip').files[0];
    const report = g('wizardZipReport');
    try {
      const result = await readZip(file);
      zipFiles = result.files;
      manifest = result.manifest;

      // Model check: the ZIP must target this U-Boot build.
      if (manifest.uboot_model !== device.model) {
        throw new Error(t('wizardWrongModel') + ': ' + manifest.uboot_model + ' ≠ ' + device.model);
      }

      // Board volumes must match /api/device.board_data exactly (names and
      // sizes). The device side is the authority; the manifest may not
      // decide write targets by itself.
      const boardData = device.board_data || [];
      const wanted = boardVolumes(manifest);
      if (boardData.length === 0) {
        throw new Error(t('wizardNoLayout'));
      }
      if (wanted.length === 0) {
        throw new Error(t('wizardNoBoardData'));
      }
      if (wanted.length !== boardData.length) {
        throw new Error(t('wizardBoardCount'));
      }
      const byName = new Map(boardData.map(b => [b.target, b]));
      for (const target of wanted) {
        const spec = byName.get(target);
        if (!spec) throw new Error(t('wizardBoardMissing') + ': ' + target);
        const item = manifest.board_data.find(b => b.target_volume === target);
        const data = zipFiles.get(item.path);
        if (!data) throw new Error(t('wizardBoardFile') + ': ' + item.path);
        if (spec.size !== data.length) {
          throw new Error(t('wizardBoardSize') + ': ' + target);
        }
      }

      plan = await buildPlan();
      report.textContent = t('wizardZipOk');
      report.className = 'muted';
      g('wizardPlanStep').hidden = false;
      g('wizardPlan').textContent = plan.text;
      g('wizardPowerWarning').textContent = t('wizardPowerWarning');
    } catch (e) {
      report.textContent = e.message;
      report.className = 'error';
      plan = null;
      g('wizardPlanStep').hidden = true;
    }
  }

  async function taskRetry(payload, retries) {
    // The device serializes tasks and can answer 409 while a previous
    // task's download is still being drained. Retry briefly instead of
    // failing the whole sequence; each retry polls first.
    const attempts = retries === undefined ? 5 : retries;
    for (let i = 0; i < attempts; i++) {
      try {
        return await task(payload);
      } catch (e) {
        if (i === attempts - 1) throw e;
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
    }
  }

  async function volumeSha(target) {
    // Back up the volume and download it back in segments; hash locally.
    const s = await task({ operation: 'backup', kind: 'ubi', target });
    const parts = [];
    const total = s.download_size;
    const segment = 4 * 1024 * 1024;
    for (let offset = 0; offset < total; offset += segment) {
      const length = Math.min(segment, total - offset);
      parts.push(await transfer('/api/download/' + s.download_id + '/' + offset + '/' + length, null, 'blob', offset, total));
    }
    const blob = new Blob(parts, { type: 'application/octet-stream' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return W.sha256Bytes(bytes);
  }

  async function buildPlan() {
    const names = volumeNames();
    const boardData = device.board_data || [];
    const boardNames = boardData.map(b => b.target);
    const hasBase = names.has('fip') && names.has('ubootenv') &&
      boardNames.length > 0 && boardNames.every(n => names.has(n));
    const strayFip = names.has('fip') && (!names.has('ubootenv') ||
      boardNames.some(n => !names.has(n)));

    const plan = { rebuild: false, fip: true, boards: [], text: [] };

    if (strayFip || !names.has('fip')) {
      plan.rebuild = true;
      plan.text.push(t('wizardPlanRebuild'));
    } else {
      plan.text.push(t('wizardPlanNoRebuild'));
      // Compare the existing FIP volume against the ZIP; only write when
      // different (never rebuild again by default).
      const fipSha = await volumeSha('fip');
      const zipSha = manifest.files['images/fip.bin'].sha256;
      plan.fip = fipSha !== zipSha;
      plan.text.push(plan.fip ? t('wizardPlanFip') : t('wizardPlanFipSkip'));
    }

    for (const spec of boardData) {
      const item = manifest.board_data.find(b => b.target_volume === spec.target);
      const data = zipFiles.get(item.path);
      const zipSha = W.sha256Bytes(data);
      let write = true;
      if (!plan.rebuild && names.has(spec.target)) {
        const haveSha = await volumeSha(spec.target);
        write = haveSha !== zipSha;
      }
      plan.boards.push({ target: spec.target, path: item.path, sha: zipSha, write });
      plan.text.push((write ? t('wizardPlanBoard') : t('wizardPlanBoardSkip')) + ' ' + spec.target);
    }

    plan.text = plan.text.join('\n');
    return plan;
  }

  function blobToFileShim(bytes, name) {
    // uploadFile() only uses input.files[0]; a Blob satisfies it even where
    // the File constructor is unavailable.
    return new Blob([bytes], { type: 'application/octet-stream' });
  }

  async function writeVolumeFromZip(operation, target, zipPath) {
    const data = zipFiles.get(zipPath);
    const blob = blobToFileShim(data, zipPath);
    const input = { files: [blob] };
    const uploadId = await uploadFile(input);
    if (operation === 'flash-board-data') {
      await taskRetry({ operation, target, upload_id: uploadId });
    } else {
      await taskRetry({ operation, upload_id: uploadId });
    }
  }

  async function wizardInstall() {
    if (!plan) throw new Error(t('wizardNoZip'));
    if (!g('wizardConfirm').checked) throw new Error(t('wizardNeedConfirm'));
    g('wizardPlanStep').hidden = true;
    g('wizardZipStep').hidden = true;
    g('wizardProgressStep').hidden = false;
    const progress = g('wizardProgress');
    progress.textContent = '';

    const step = text => { progress.textContent += text + '\n'; };

    if (plan.rebuild) {
      step(t('wizardStepRebuild'));
      await taskRetry({ operation: 'ubi-rebuild' });
      const s = await request('/api/storage');
      storage = s;
      const names = volumeNames();
      const boardNames = (device.board_data || []).map(b => b.target);
      if (!names.has('fip') || !names.has('ubootenv') ||
        boardNames.some(n => !names.has(n))) {
        throw new Error(t('wizardRebuildIncomplete'));
      }
    }

    if (plan.fip) {
      step(t('wizardStepFip'));
      await writeVolumeFromZip('flash-uboot', null, 'images/fip.bin');
    }

    for (const item of plan.boards) {
      if (!item.write) continue;
      step(t('wizardStepBoard') + ' ' + item.target);
      await writeVolumeFromZip('flash-board-data', item.target, item.path);
    }

    // Read back every written volume and check its SHA before recording
    // completion (empty volumes would otherwise look "present").
    step(t('wizardStepVerify'));
    const fipSha = manifest.files['images/fip.bin'].sha256;
    const readFip = await volumeSha('fip');
    if (readFip !== fipSha) throw new Error(t('wizardVerifyFail') + ': fip');
    const bdShas = [];
    for (const item of plan.boards) {
      const readSha = await volumeSha(item.target);
      if (readSha !== item.sha) throw new Error(t('wizardVerifyFail') + ': ' + item.target);
      bdShas.push(readSha);
    }

    step(t('wizardStepMark'));
    await taskRetry({ operation: 'env-set', name: 'wizard_target', value: manifest.target });
    await taskRetry({ operation: 'env-set', name: 'wizard_fip_size', value: String(zipFiles.get('images/fip.bin').length) });
    await taskRetry({ operation: 'env-set', name: 'wizard_fip_sha', value: fipSha });
    for (let i = 0; i < 4 && i < bdShas.length; i++) {
      await taskRetry({ operation: 'env-set', name: 'wizard_bd' + i + '_sha', value: bdShas[i] });
    }
    await taskRetry({ operation: 'env-set', name: 'wizard_done', value: '1' });

    step(t('wizardDone'));
    step(t('wizardDoneHint'));
    // Refresh everything, including the saved-hash verification, so the
    // completed state is only shown when the markers match the device.
    await wizardRefresh();
    if (!savedHashesOk) {
      // The writes themselves already verified byte-for-byte above; the
      // tail verification just re-read the same volumes. When it could not
      // complete (e.g. a busy device), say so plainly instead of silently
      // returning to the ZIP step: the volumes are written, re-validate to
      // reach the sysupgrade step.
      step(t('wizardTailIncomplete'));
    }
  }

  g('wizardInspect').onclick = () => run(inspectZip);
  g('wizardStart').onclick = () => run(wizardInstall);
  g('wizardFlashButton').onclick = () => run(async () => {
    const uploadId = await uploadFile(g('wizardFirmware'));
    await taskRetry({ operation: 'flash', upload_id: uploadId });
    // Flash verified by the backend; boot the new system right away.
    g('wizardRebootNote').hidden = false;
    // The boot-production task resets the device; polling ends when the
    // connection drops (the page monitor handles that), so awaiting it is
    // fine — the reboot note stays visible until then.
    await taskRetry({ operation: 'boot-production' });
  });

  // The first script runs refresh() before this file is evaluated; re-run
  // the wizard render whenever the device catalog changes.
  const originalRefresh = self.refresh;
  self.refresh = async function () {
    await originalRefresh();
    await wizardRefresh();
  };
  wizardRefresh();

  // Host-test hook: exposes the state machine without changing page behavior.
  self.__wizard = {
    refresh: wizardRefresh,
    inspect: inspectZip,
    install: wizardInstall,
    readZip,
    buildPlan,
  };
})();
