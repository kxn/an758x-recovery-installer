/*
 * Stock-firmware wizard page (an758x-stock2ubi).
 *
 * Flow (PLAN section 6):
 *   1. GET /api/wizard: show target, image hashes, probe evidence and the
 *      match result (match / partial / conflict).
 *   2. "Create backup ZIP": fetch /api/image/bl2, /api/image/fip, the
 *      first-block range and every board-data partition in order, hash each
 *      one, assemble the v1 STORE ZIP with the shared library and download
 *      it. Every fetch is length-checked; truncation or hashing failure
 *      aborts without producing a ZIP.
 *   3. User confirms the ZIP is saved locally, types `yes`.
 *   4. POST /api/flash-embedded — a single call into install::flash() with
 *      the embedded images, guarded by the same FLASH_IN_PROGRESS lock as
 *      /api/flash.
 *
 * The device page is served over plain HTTP, so the ZIP/SHA/CRC code is the
 * shared pure-JS library inlined by the build (no crypto.subtle).
 */
'use strict';
(function () {
  const W = self.An758xWizardZip;

  const MAX_ZIP_TOTAL = 16 * 1024 * 1024;
  const t = key => words[language][key] || key;

  const el = id => document.getElementById(id);
  let meta = null;
  let evidence = null;
  let building = false;

  async function fetchBytes(url, expected) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (expected !== undefined && buffer.byteLength !== expected) {
      throw new Error(`GET ${url}: got ${buffer.byteLength} bytes, expected ${expected}`);
    }
    return new Uint8Array(buffer);
  }

  function hashOf(bytes) { return W.sha256Bytes(bytes); }

  function setStatus(text, cls) {
    const status = el('wizard-status');
    status.textContent = text;
    status.className = cls || '';
  }

  function bytes(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MiB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KiB';
    return n + ' B';
  }

  function renderWizard(meta) {
    const panel = el('wizard-panel');
    const target = el('wizard-target');
    const model = el('wizard-model');
    const matchRow = el('wizard-match');
    const reasons = el('wizard-reasons');
    const actions = el('wizard-actions');
    const fallback = el('wizard-fallback');

    target.textContent = meta.target + ' / ' + meta.boot_image_kind;
    model.textContent = meta.uboot_model;
    const match = (evidence && evidence.match) || 'partial';
    matchRow.textContent = t('match_' + match);
    matchRow.className = 'wizard-' + match;
    reasons.textContent = (evidence && evidence.reasons || []).join(' · ') || '—';
    panel.hidden = false;
    // Confirmed device: the one-click backup + flash flow. Unconfirmed:
    // only the full-ROM download is offered; no writes are possible.
    const confirmed = match !== 'conflict' && meta.auto_ok === true;
    actions.hidden = !confirmed;
    fallback.hidden = confirmed;
  }

  function showFallback() {
    el('wizard-target').textContent = '—';
    el('wizard-model').textContent = '—';
    el('wizard-match').textContent = t('wizardUnavailable');
    el('wizard-match').className = 'wizard-partial';
    el('wizard-reasons').textContent = t('wizardUnavailable');
    el('wizard-panel').hidden = false;
    el('wizard-actions').hidden = true;
    el('wizard-fallback').hidden = false;
  }

  async function refreshWizard() {
    try {
      const response = await fetch('/api/wizard', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      meta = await response.json();
      evidence = {
        match: meta.match,
        reasons: meta.reasons,
        mtd: meta.evidence && meta.evidence.mtd,
        found: meta.found,
        dtb_model: meta.evidence && meta.evidence.dtb_model,
        kernel_release: meta.evidence && meta.evidence.kernel_release,
        model_unconfirmed: meta.model_unconfirmed === true
      };
      renderWizard(meta);
    } catch (_) {
      showFallback();
    }
  }

  // Board-data spec lines from /api/wizard, in the profile's order.
  function boardSpecs() {
    return (meta && meta.board_data) || [];
  }

  function firstBlockSpec() {
    const mtd = evidence && evidence.mtd || [];
    // The first block lives on the partition covering physical offset 0;
    // prefer the lowest index among them.
    const candidates = mtd.filter(p => p.offset === 0);
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.index - b.index);
    return candidates[0];
  }

  async function downloadBlob(bytes, name) {
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  async function buildZip() {
    if (!W) { setStatus(t('wizardUnavailable'), 'error'); return; }
    if (building) return;
    building = true;
    el('wizard-zip').disabled = true;
    setStatus(t('working'), '');
    try {
      const entries = [];
      let total = 0;
      const bl2 = await fetchBytes('/api/image/bl2');
      total += bl2.length;
      const fip = await fetchBytes('/api/image/fip');
      total += fip.length;
      entries.push(
        { path: 'images/bl2.bin', data: bl2 },
        { path: 'images/fip.bin', data: fip }
      );

      const first = firstBlockSpec();
      let firstblock = null;
      if (first) {
        firstblock = await fetchBytes(
          `/api/backup-range/${first.index}/0/${first.erase_size}`
        );
        total += firstblock.length;
        entries.push({ path: 'original/firstblock.bin', data: firstblock });
      } else {
        throw new Error(t('noFirstBlock'));
      }

      const boardEntries = [];
      for (const spec of boardSpecs()) {
        if (spec.source_kind !== 'mtd') {
          throw new Error(t('unsupportedSource', spec.target_volume));
        }
        const found = (evidence.found || []).find(f => f.target_volume === spec.target_volume);
        if (!found || found.mtd_index === undefined || found.read_length === undefined) {
          throw new Error(t('missingPartition', spec.target_volume));
        }
        // The restore side (Web U-Boot flash-board-data) accepts an upload
        // only when its length equals the DTB volume size exactly. A source
        // partition whose size differs would produce a ZIP the recovery page
        // rejects; refuse to build it (the manual page still works).
        if (found.size_ok !== true || found.read_length !== spec.target_size) {
          throw new Error(t('partitionSizeMismatch', spec.target_volume));
        }
        const data = await fetchBytes(
          `/backup/${found.mtd_index}`,
          found.read_length
        );
        total += data.length;
        entries.push({ path: `board/${spec.target_volume}.bin`, data });
        boardEntries.push({
          path: `board/${spec.target_volume}.bin`,
          source_kind: spec.source_kind,
          source_name: (spec.source_names || [])[0] || null,
          source_offset: null,
          target_volume: spec.target_volume
        });
      }

      if (total > MAX_ZIP_TOTAL) {
        throw new Error(t('zipTooLarge'));
      }

      const files = {};
      for (const entry of entries) {
        files[entry.path] = { size: entry.data.length, sha256: hashOf(entry.data) };
      }
      const manifest = {
        schema: 1,
        target: meta.target,
        uboot_model: meta.uboot_model,
        uboot_commit: meta.uboot_commit,
        stock_commit: meta.stock_commit,
        boot_image_kind: meta.boot_image_kind,
        files,
        board_data: boardEntries
      };
      const zip = W.buildZip(
        [
          { path: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest)) },
          ...entries
        ],
        { maxTotalSize: MAX_ZIP_TOTAL }
      );
      await downloadBlob(zip, `${meta.target}-recovery-backup.zip`);
      setStatus(t('zipReady'), 'ok');
      el('wizard-confirm').hidden = false;
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      building = false;
      el('wizard-zip').disabled = false;
    }
  }

  async function flashEmbedded() {
    if (building) return;
    if (el('wizard-yes').value.trim() !== 'yes') {
      setStatus(t('needYes'), 'error');
      return;
    }
    let confirmed = window.confirm(t('flashConfirm'));
    if (!confirmed) return;
    if (evidence && evidence.model_unconfirmed) {
      confirmed = window.confirm(t('modelUnconfirmedConfirm', meta.uboot_model));
      if (!confirmed) return;
    }
    building = true;
    el('wizard-flash').disabled = true;
    setStatus(t('working'), '');
    try {
      const response = await fetch('/api/flash-embedded', { method: 'POST' });
      const body = await response.text();
      let message = body;
      try { message = JSON.parse(body).message; } catch (_) {}
      if (response.ok) {
        setStatus(message, 'ok');
        el('wizard-flash').disabled = true; // rebooting
        el('wizard-reboot-note').hidden = false;
      } else {
        setStatus(message || `HTTP ${response.status}`, 'error');
      }
    } catch (_) {
      setStatus(t('network'), 'error');
    } finally {
      building = false;
    }
  }

  function bind() {
    el('wizard-zip').addEventListener('click', buildZip);
    el('wizard-flash').addEventListener('click', flashEmbedded);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { bind(); refreshWizard(); });
  } else {
    bind(); refreshWizard();
  }
})();
