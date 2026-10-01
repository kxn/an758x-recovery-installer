'use strict';
/*
 * Mock-API harness that runs the recovery wizard (patches/uboot/files/
 * wizard-uboot.js) against a fake device, recording every task/upload so
 * tests can assert the exact operation order PLAN sections 7 and 8 demand.
 */
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const W = require('../../shared/wizard-zip.js');

const WIZARD_SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'patches', 'uboot', 'files', 'wizard-uboot.js'),
  'utf8'
);

function makeElement() {
  const element = {
    hidden: false,
    textContent: '',
    className: '',
    checked: false,
    value: '',
    files: [],
    onclick: null,
    onchange: null,
    addEventListener() {},
    setAttribute() {},
  };
  return element;
}

function createHarness(initial) {
  const state = {
    device: initial.device || {
      model: 'Nokia XG-040G-MD',
      version: 'test',
      ram_bytes: 0,
      flash_bytes: 0,
      ubi: true,
      rebuild: true,
      board_data: [
        { kind: 'ubi', target: 'bosa', size: 8 },
        { kind: 'ubi', target: 'ri', size: 8 },
      ],
    },
    storage: initial.storage || { targets: [] },
    env: initial.env || {},
    volumes: initial.volumes || {},
    log: [],
    uploads: [],
    failNextTask: false,
    nextUploadId: 1,
    backupTarget: null,
  };

  const elements = {};
  const el = id => elements[id] || (elements[id] = makeElement());

  const words = new Proxy({}, {
    get: (_target, key) => (typeof key === 'string' ? key : undefined),
  });
  const language = 'en';
  const t = key => words[key] || key;

  async function request(url, options) {
    const opts = options || {};
    if (url === '/api/task' && opts.method === 'POST' && state.failNextTask) {
      state.failNextTask = false;
      state.log.push({ op: 'busy409' });
      throw new Error('busy');
    }
    if (url === '/api/device') return state.device;
    if (url === '/api/storage') return state.storage;
    if (url === '/api/env') return state.env;
    if (url === '/api/task' && !opts.method) {
      // waitTask polls the current task state.
      return { id: 1, state: 'done', code: 0, output: '', busy: false };
    }
    if (url === '/api/task' && opts.method === 'POST') {
      const payload = JSON.parse(opts.body);
      state.log.push({ op: 'task', payload });
      const result = await applyTask(payload);
      return { id: 1, state: 'done', code: 0, output: '', ...result };
    }
    throw new Error(`unexpected request ${url}`);
  }

  async function applyTask(payload) {
    switch (payload.operation) {
      case 'ubi-rebuild': {
        const targets = [
          { kind: 'ubi', name: 'fip', size: 0 },
          { kind: 'ubi', name: 'ubootenv', size: 0 },
          { kind: 'ubi', name: 'ubootenv2', size: 0 },
        ];
        for (const spec of state.device.board_data) {
          targets.push({ kind: 'ubi', name: spec.target, size: spec.size });
        }
        state.storage = { targets };
        for (const spec of state.device.board_data) state.volumes[spec.target] = new Uint8Array(spec.size);
        state.volumes.fip = new Uint8Array(0);
        break;
      }
      case 'flash-uboot': {
        const upload = state.uploads.find(u => u.id === payload.upload_id);
        if (!upload) throw new Error('upload_id not found');
        state.volumes.fip = upload.data;
        break;
      }
      case 'flash-board-data': {
        const upload = state.uploads.find(u => u.id === payload.upload_id);
        if (!upload) throw new Error('upload_id not found');
        state.volumes[payload.target] = upload.data;
        break;
      }
      case 'backup': {
        state.backupTarget = payload.target;
        const data = state.volumes[payload.target] || new Uint8Array(0);
        return { download_id: 1, download_size: data.length };
      }
      case 'env-set': {
        state.env[payload.name] = payload.value;
        break;
      }
      case 'flash': {
        state.log.push({ op: 'sysupgrade' });
        break;
      }
      case 'boot-production': {
        state.log.push({ op: 'bootProduction' });
        break;
      }
      default:
        throw new Error(`unexpected operation ${payload.operation}`);
    }
    return {};
  }

  async function task(payload) {
    return request('/api/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  async function transfer(url, _body, responseType, _base, _total) {
    // url: /api/download/<id>/<offset>/<length>
    const parts = url.split('/');
    const length = Number(parts[parts.length - 1]);
    const data = state.volumes[state.backupTarget] || new Uint8Array(0);
    state.log.push({ op: 'download', target: state.backupTarget, length });
    return new Blob([data.slice(0, length)]);
  }

  async function uploadFile(input, _url) {
    const file = input.files[0];
    const data = new Uint8Array(await file.arrayBuffer());
    const id = state.nextUploadId++;
    state.uploads.push({ id, data });
    state.log.push({ op: 'upload', id, size: data.length });
    return id;
  }

  async function run(fn) {
    state.lastError = null;
    try {
      await fn();
    } catch (error) {
      state.lastError = error;
    }
  }

  const sandbox = {
    self: null,
    console,
    words,
    language,
    t,
    el,
    request,
    task,
    transfer,
    uploadFile,
    run,
    File,
    Blob,
    Uint8Array,
    TextEncoder,
    TextDecoder,
    Promise,
    setTimeout,
    refresh: async () => {
      state.log.push({ op: 'pageRefresh' });
    },
  };
  sandbox.self = sandbox;
  sandbox.An758xWizardZip = W;

  const context = vm.createContext(sandbox);
  vm.runInContext(WIZARD_SRC, context, { filename: 'wizard-uboot.js' });

  return {
    state,
    el,
    sandbox,
    async refresh() {
      await sandbox.refresh();
    },
    // The wizard replaced sandbox.refresh to chain pageRefresh -> wizardRefresh.
  };
}

module.exports = { createHarness, W };
