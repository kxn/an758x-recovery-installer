/* Complete main-area ROM recovery through the upstream flash-all API. */
'use strict';
(function () {
  Object.assign(words.zh, {
    romTitle: '恢复原厂完整 ROM',
    romHint: '选择从本机原厂系统下载的整片 Flash 主数据备份，大小必须与 Flash 容量完全一致。请选择原始 .bin 文件。',
    romWarning: '将覆盖引导程序、系统和板级数据。恢复期间请勿断电。',
    romConfirmLabel: '我确认这是这台机器的原厂完整 ROM 备份，未附带 OOB、未跳过坏块压缩。',
    romStart: '上传并恢复', romReboot: '重启进入原厂系统',
    romNeedConfirm: '请先确认备份属于这台机器。',
    romUnavailable: '这版 U-Boot 未声明支持完整 ROM 恢复。',
    romSize: 'ROM 大小必须等于 Flash 主数据容量',
    romDone: 'ROM 已写入并逐块回读校验通过。可以重启进入原厂系统。',
    romFailed: '恢复失败。如果已经开始擦写，请保持设备通电，先保存错误信息。',
    erase: '擦除中', write: '写入中', verify: '回读校验中'
  });
  Object.assign(words.en, {
    romTitle: 'Restore complete stock ROM',
    romHint: 'Select the complete main-area Flash backup downloaded from this device on stock firmware. The size must equal Flash capacity. Use the original .bin file.',
    romWarning: 'This overwrites the bootloader, firmware and board data. Do not power off during restoration.',
    romConfirmLabel: 'This is the original complete ROM backup of this device, without OOB or packed bad-block gaps.',
    romStart: 'Upload and restore', romReboot: 'Reboot into stock firmware',
    romNeedConfirm: 'Confirm that the backup belongs to this device.',
    romUnavailable: 'This U-Boot build does not advertise complete ROM restoration.',
    romSize: 'ROM size must equal Flash main-area capacity',
    romDone: 'ROM written and verified block by block. You can reboot into stock firmware.',
    romFailed: 'Restoration failed. If writing has started, keep the device powered and save the error details.',
    erase: 'Erasing', write: 'Writing', verify: 'Verifying readback'
  });
  applyLanguage();

  async function describe() {
    const device = await request('/api/device');
    text('romDevice', device.model + ' · Flash ' + bytes(device.flash_bytes) +
      ' · RAM ' + bytes(device.ram_bytes));
    return device;
  }

  async function restore() {
    // Refresh geometry inside run(): no other upload/task may use the buffer.
    const device = await describe();
    if (device.flash_all !== true) throw new Error(t('romUnavailable'));
    const file = el('romImage').files[0];
    if (!file) throw new Error(t('choose'));
    if (!device.flash_bytes || file.size !== device.flash_bytes) {
      throw new Error(t('romSize') + ': ' + file.size + ' / ' + device.flash_bytes + ' B');
    }
    if (!el('romConfirm').checked) throw new Error(t('romNeedConfirm'));
    text('romResult', '');
    try {
      // Send the File directly: no 256 MiB arrayBuffer/ZIP copy in the browser.
      const id = await uploadFile(el('romImage'), '/api/upload-all-flash');
      if (!Number.isSafeInteger(id)) throw new Error('Invalid upload_id');
      await task({ operation: 'flash-all', upload_id: id });
      el('wizard').hidden = true;
      el('romRestoreButton').hidden = true;
      el('romImage').hidden = true;
      el('romConfirm').disabled = true;
      text('romResult', t('romDone'));
      el('romRebootButton').hidden = false;
    } catch (error) {
      text('romResult', t('romFailed') + '\n' + error.message);
      throw error;
    }
  }

  el('romRestoreButton').onclick = () => run(restore);
  el('romRebootButton').onclick = () => run(async () => {
    rebooting = true;
    await task({ operation: 'reset' });
  });
  describe().catch(() => {});
})();
