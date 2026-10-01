'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'patches', 'stock2ubi', 'files', 'wizard-stock.js'), 'utf8'
);

test('stock page still offers the partition archive when device probing is unavailable', async () => {
  const elements = new Map();
  const document = {
    readyState: 'complete',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { hidden: true, textContent: '', className: '', addEventListener() {} });
      return elements.get(id);
    },
  };
  const sandbox = {
    self: {}, document, language: 'zh',
    words: { zh: { wizardUnavailable: '自动识别不可用' } },
    fetch: async () => ({ ok: false, status: 404 }),
  };
  vm.runInNewContext(source, sandbox);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get('wizard-panel').hidden, false);
  assert.equal(elements.get('wizard-fallback').hidden, false);
  assert.equal(elements.get('wizard-actions').hidden, true);
  assert.match(elements.get('wizard-reasons').textContent, /自动识别不可用/);

  const page = fs.readFileSync(path.join(__dirname, '..', 'patches', 'stock2ubi', '0001-stock2ubi-wizard-api-and-embedded-images.patch'), 'utf8');
  assert.match(page, /href="\/backup-all\.tar"/);
});
