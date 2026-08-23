'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const { JSDOM } = require('jsdom');
require('tsx/cjs');

const STORE = '../src/stores/updatesStore.ts';
const PANEL = '../src/components/UpdatesPanel.tsx';

function descriptor(overrides = {}) {
  return {
    schemaVersion: 1,
    version: '2.0.0',
    build: '200',
    title: 'VaniScript 2',
    notes: 'A safer update.',
    critical: false,
    informational: false,
    publishDate: '2026-08-23T08:00:00.000Z',
    sizeBytes: 2 * 1024 * 1024,
    infoUrl: 'https://example.test/releases/2.0.0',
    platform: 'darwin',
    arch: 'arm64',
    channel: 'stable',
    artifactType: 'zip',
    artifactHash: 'sha256:private-feed-metadata',
    feedSignature: 'signed-feed-secret',
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    schemaVersion: 1,
    state: 'idle',
    currentVersion: '1.0.0',
    currentBuild: '100',
    channel: 'stable',
    platform: 'darwin',
    arch: 'arm64',
    descriptor: null,
    lastCheckedAt: null,
    download: null,
    error: null,
    skippedVersion: null,
    remindLaterUntil: null,
    lastAction: null,
    presentation: {
      emphasis: 'standard',
      critical: false,
      informational: false,
      autoDownload: false,
      autoInstall: false,
      showSkip: false,
      showRemind: false,
    },
    ...overrides,
  };
}

function createBridge(initialState, initialBlockers = []) {
  const calls = [];
  const bridge = {
    state: initialState,
    blockers: initialBlockers,
    receipt: null,
    capabilities: {
      available: true,
      platform: 'darwin',
      arch: 'arm64',
      backend: 'injected-squirrel-mac',
      installAvailable: true,
      installPolicy: 'in-app',
      userMessage: 'In-app update is available after explicit user confirmation.',
      artifactType: 'zip',
      acceptedArtifactTypes: ['zip', 'zip+json'],
    },
    calls,
    getState() {
      calls.push('getState');
      return this.state;
    },
    getReceipt() {
      calls.push('getReceipt');
      return this.receipt;
    },
    collectBlockers() {
      calls.push('collectBlockers');
      return this.blockers;
    },
    getCapabilities() {
      calls.push('getCapabilities');
      return this.capabilities;
    },
    checkNow() {
      calls.push('checkNow');
      this.state = state({ state: 'available', descriptor: descriptor() });
      return this.state;
    },
    downloadNow() {
      calls.push('downloadNow');
      this.state = state({
        state: 'readyToInstall',
        descriptor: descriptor(),
        download: { receivedBytes: 2 * 1024 * 1024, totalBytes: 2 * 1024 * 1024, fraction: 1 },
      });
      return this.state;
    },
    installNow() {
      calls.push('installNow');
      this.receipt = {
        schemaVersion: 1,
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
        fromBuild: '100',
        toBuild: '200',
        timestamp: '2026-08-23T09:00:00.000Z',
        channel: 'stable',
        outcome: 'success',
        artifactHash: 'sha256:main-only',
      };
      this.state = state({ state: 'idle' });
      return { state: this.state, receipt: this.receipt };
    },
    skipVersion() {
      calls.push('skipVersion');
      this.state = state({ state: 'idle', skippedVersion: '2.0.0' });
      return this.state;
    },
    remindLater() {
      calls.push('remindLater');
      this.state = state({ state: 'idle', remindLaterUntil: '2026-08-23T13:00:00.000Z' });
      return this.state;
    },
    cancelDownload() {
      calls.push('cancelDownload');
      this.state = state({ state: 'available', descriptor: descriptor() });
      return this.state;
    },
    retry() {
      calls.push('retry');
      this.state = state({ state: 'available', descriptor: descriptor() });
      return this.state;
    },
  };
  return bridge;
}

async function loadModules() {
  const storeModule = await import(STORE);
  const panelModule = require(PANEL);
  return { ...storeModule, ...panelModule };
}

function renderPanel(UpdatesPanel, store) {
  const markup = ReactDOMServer.renderToStaticMarkup(
    React.createElement(UpdatesPanel, { store }),
  );
  const dom = new JSDOM(`<!doctype html><main>${markup}</main>`);
  return { markup, dom, root: dom.window.document };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('updates store mirrors the D1 FSM and disables illegal actions', async () => {
  const { createUpdatesStore } = await loadModules();
  const bridge = createBridge(state());
  const store = createUpdatesStore(bridge);
  await store.refresh();

  assert.equal(store.getState().state, 'idle');
  assert.equal(store.getState().actions.checkNow, true);
  assert.equal(store.getState().actions.downloadNow, false);
  await store.downloadNow();
  assert.deepEqual(bridge.calls.filter((call) => call === 'downloadNow'), []);

  await store.checkNow();
  assert.equal(store.getState().state, 'available');
  assert.equal(store.getState().actions.downloadNow, true);
  assert.equal(store.getState().actions.installNow, false);
  await store.downloadNow();
  assert.equal(store.getState().state, 'readyToInstall');
  assert.equal(store.getState().actions.installNow, true);
  assert.equal(store.getState().descriptor.artifactHash, undefined);
  assert.equal(store.getState().descriptor.feedSignature, undefined);

  for (const lifecycle of ['checking', 'upToDate', 'available', 'downloading', 'verifying', 'readyToInstall', 'installing', 'failed']) {
    bridge.state = state({
      state: lifecycle,
      descriptor: lifecycle === 'upToDate' ? null : descriptor(),
      download: ['downloading', 'verifying', 'readyToInstall'].includes(lifecycle)
        ? { receivedBytes: 1, totalBytes: 2, fraction: 0.5 }
        : null,
    });
    await store.refresh();
    assert.equal(store.getState().state, lifecycle);
  }
  bridge.state = state({
    state: 'readyToInstall',
    descriptor: descriptor(),
    download: { receivedBytes: 2 * 1024 * 1024, totalBytes: 2 * 1024 * 1024, fraction: 1 },
  });
  await store.refresh();
  assert.equal(store.getState().actions.installNow, true);
  await store.installNow();
  assert.equal(store.getState().state, 'idle');
  assert.equal(store.getState().receipt.toVersion, '2.0.0');
  assert.deepEqual(
    bridge.calls.filter((call) => ['checkNow', 'downloadNow', 'installNow'].includes(call)),
    ['checkNow', 'downloadNow', 'installNow'],
  );
});

test('critical emphasis never bypasses blockers and requires a second install action after clearing them', async () => {
  const { createUpdatesStore, UpdatesPanel } = await loadModules();
  const criticalDescriptor = descriptor({ critical: true, title: 'Urgent security update' });
  const bridge = createBridge(
    state({ state: 'readyToInstall', descriptor: criticalDescriptor }),
    [{ category: 'recording', message: 'Microphone capture is active.' }],
  );
  const store = createUpdatesStore(bridge);
  await store.refresh();
  assert.equal(store.getState().presentation.emphasis, 'critical');
  assert.equal(store.getState().actions.installNow, false);

  const first = renderPanel(UpdatesPanel, store);
  assert.ok(first.root.querySelector('[data-testid="updates-critical"]'));
  assert.match(first.root.querySelector('[data-testid="updates-blockers"]').textContent, /Recording/);
  assert.match(first.root.querySelector('[data-testid="updates-blockers"]').textContent, /Microphone capture is active/);
  assert.equal(first.root.querySelector('[data-testid="updates-install"]').disabled, true);
  await store.installNow();
  assert.equal(bridge.calls.includes('installNow'), false);

  bridge.blockers = [];
  await store.refreshBlockers();
  assert.equal(store.getState().actions.installNow, true);
  await store.installNow();
  assert.equal(bridge.calls.includes('installNow'), true);
  first.dom.window.close();
});

test('TAMPERED errors and details surface without leaking feed metadata', async () => {
  const { createUpdatesStore, UpdatesPanel } = await loadModules();
  const bridge = createBridge(state({ state: 'available', descriptor: descriptor() }));
  bridge.downloadNow = () => {
    bridge.calls.push('downloadNow');
    bridge.state = state({ state: 'failed', descriptor: descriptor() });
    const error = new Error('Feed signature does not match.');
    error.code = 'TAMPERED';
    error.details = { reason: 'signature mismatch', feedSignature: 'do-not-render' };
    throw error;
  };
  const store = createUpdatesStore(bridge);
  await store.refresh();
  await store.downloadNow();

  assert.equal(store.getState().state, 'failed');
  assert.equal(store.getState().error.code, 'TAMPERED');
  assert.equal(store.getState().error.details.feedSignature, '[redacted]');
  assert.equal(store.getState().actions.installNow, false);
  await store.installNow();
  assert.equal(bridge.calls.filter((call) => call === 'installNow').length, 0);
  const rendered = renderPanel(UpdatesPanel, store);
  assert.match(rendered.markup, /Update rejected: tampered feed or artifact/);
  assert.match(rendered.markup, /signature mismatch/);
  assert.doesNotMatch(rendered.markup, /do-not-render/);
  assert.equal(rendered.root.querySelector('[data-testid="updates-install"]').disabled, true);
  rendered.dom.window.close();
});

test('skip, remind-later, cancel, retry, and receipt actions stay explicit and wired one-to-one', async () => {
  const { createUpdatesStore, UpdatesPanel } = await loadModules();
  const bridge = createBridge(state({ state: 'available', descriptor: descriptor() }));
  const store = createUpdatesStore(bridge);
  await store.refresh();
  await store.skipVersion();
  assert.equal(store.getState().state, 'idle');
  assert.equal(bridge.calls.at(-1), 'skipVersion');

  bridge.state = state({ state: 'available', descriptor: descriptor() });
  await store.refresh();
  await store.remindLater();
  assert.equal(bridge.calls.at(-1), 'remindLater');

  bridge.state = state({ state: 'downloading', descriptor: descriptor() });
  await store.refresh();
  await store.cancelDownload();
  assert.equal(bridge.calls.at(-1), 'cancelDownload');

  bridge.state = state({ state: 'failed', descriptor: descriptor() });
  await store.refresh();
  await store.retry();
  assert.equal(bridge.calls.at(-1), 'retry');

  bridge.state = state({ state: 'idle' });
  bridge.receipt = {
    schemaVersion: 1,
    fromVersion: '1.0.0',
    toVersion: '2.0.0',
    fromBuild: '100',
    toBuild: '200',
    timestamp: '2026-08-23T09:00:00.000Z',
    channel: 'stable',
    outcome: 'failed',
    artifactHash: 'sha256:main-only',
  };
  await store.refresh();
  const rendered = renderPanel(UpdatesPanel, store);
  assert.match(rendered.root.querySelector('[data-testid="updates-receipt"]').textContent, /1\.0\.0.*2\.0\.0.*failed/);
  rendered.dom.window.close();
});

test('bridge absence is rendered as honest deferred state', async () => {
  const { createUpdatesStore, UpdatesPanel, UPDATE_BRIDGE_DEFERRED } = await loadModules();
  const store = createUpdatesStore();
  await store.refresh();
  assert.equal(store.getState().bridgeStatus, 'deferred');
  assert.equal(store.getState().bridgeMessage, UPDATE_BRIDGE_DEFERRED);
  const rendered = renderPanel(UpdatesPanel, store);
  assert.match(rendered.markup, /Update bridge is not exposed/);
  assert.equal(rendered.root.querySelector('[data-testid="updates-check"]').disabled, true);
  rendered.dom.window.close();
});

test('Main UPDATE_BLOCKED reasons resync blockers and refuse a repeated install', async () => {
  const { createUpdatesStore, UpdatesPanel } = await loadModules();
  const bridge = createBridge(state({ state: 'readyToInstall', descriptor: descriptor() }));
  bridge.installNow = () => {
    bridge.calls.push('installNow');
    bridge.state = state({ state: 'readyToInstall', descriptor: descriptor() });
    const error = new Error('Main refused the install.');
    error.code = 'UPDATE_BLOCKED';
    error.details = {
      kind: 'blockers',
      reasons: [{ category: 'projectSaveFailure', message: 'Project save did not finish.' }],
    };
    throw error;
  };
  const store = createUpdatesStore(bridge);
  await store.refresh();
  await store.installNow();

  assert.equal(store.getState().state, 'readyToInstall');
  assert.equal(store.getState().error.code, 'UPDATE_BLOCKED');
  assert.equal(store.getState().blockers.length, 1);
  assert.equal(store.getState().blockers[0].label, 'Project save failure');
  assert.equal(store.getState().actions.installNow, false);
  assert.equal(bridge.calls.filter((call) => call === 'installNow').length, 1);

  await store.installNow();
  assert.equal(bridge.calls.filter((call) => call === 'installNow').length, 1);
  const rendered = renderPanel(UpdatesPanel, store);
  assert.match(rendered.root.querySelector('[data-testid="updates-blockers"]').textContent, /Project save failure/);
  assert.match(rendered.root.querySelector('[data-testid="updates-blockers"]').textContent, /Project save did not finish/);
  assert.equal(rendered.root.querySelector('[data-testid="updates-install"]').disabled, true);
  rendered.dom.window.close();
});

test('quit-prep failure labels subsystem reasons and never reads an install receipt', async () => {
  const { createUpdatesStore, UpdatesPanel } = await loadModules();
  const bridge = createBridge(state({ state: 'readyToInstall', descriptor: descriptor() }));
  bridge.installNow = () => {
    bridge.calls.push('installNow');
    const error = new Error('Install refused because quit preparation did not complete.');
    error.code = 'UPDATE_BLOCKED';
    error.details = {
      kind: 'quit-prep',
      reasons: [{ subsystem: 'sqlite', message: 'WAL checkpoint timed out.', outcome: 'timeout' }],
    };
    throw error;
  };
  const store = createUpdatesStore(bridge);
  await store.refresh();
  const receiptReadsBeforeInstall = bridge.calls.filter((call) => call === 'getReceipt').length;
  await store.installNow();

  assert.equal(bridge.calls.filter((call) => call === 'installNow').length, 1);
  assert.equal(bridge.calls.filter((call) => call === 'getReceipt').length, receiptReadsBeforeInstall);
  assert.equal(store.getState().receipt, null);
  assert.equal(store.getState().state, 'readyToInstall');
  assert.equal(store.getState().actions.installNow, false);
  const rendered = renderPanel(UpdatesPanel, store);
  const blockers = rendered.root.querySelector('[data-testid="updates-blockers"]').textContent;
  assert.match(blockers, /Sqlite save preparation/);
  assert.match(blockers, /WAL checkpoint timed out/);
  assert.match(blockers, /timeout/);
  assert.equal(rendered.root.querySelector('[data-testid="updates-install"]').disabled, true);
  rendered.dom.window.close();
});

test('invoke-command failure envelopes unwrap into typed errors without fake success', async () => {
  const { createUpdatesStore } = await loadModules();
  const originalWindow = global.window;
  const calls = [];
  global.window = {
    electronAPI: {
      invoke(channel) {
        calls.push(channel);
        if (channel === 'updates:state') return { ok: true, value: state() };
        if (channel === 'updates:blockers') return { ok: true, value: [] };
        if (channel === 'updates:receipt') return { ok: true, value: null };
        if (channel === 'updates:capabilities') return { ok: true, value: null };
        if (channel === 'updates:check') {
          return {
            ok: false,
            error: {
              code: 'PROVIDER_ERROR',
              message: 'Update feed is unavailable.',
              details: { phase: 'check' },
            },
          };
        }
        throw new Error(`Unexpected invoke channel: ${channel}`);
      },
    },
  };

  try {
    const store = createUpdatesStore();
    await store.refresh();
    await store.checkNow();
    assert.equal(calls.filter((channel) => channel === 'updates:check').length, 1);
    assert.equal(store.getState().state, 'idle');
    assert.equal(store.getState().error.code, 'PROVIDER_ERROR');
    assert.equal(store.getState().error.message, 'Update feed is unavailable.');
    assert.deepEqual(store.getState().error.details, { phase: 'check' });
    assert.equal(store.getState().actions.downloadNow, false);
  } finally {
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
  }
});

test('an older refresh response cannot overwrite a newer update snapshot', async () => {
  const { createUpdatesStore } = await loadModules();
  const older = deferred();
  const newer = deferred();
  let reads = 0;
  const bridge = {
    getState() {
      reads += 1;
      return reads === 1 ? older.promise : newer.promise;
    },
  };
  const store = createUpdatesStore(bridge);
  const olderRefresh = store.refresh();
  const newerRefresh = store.refresh();

  newer.resolve(state({
    state: 'upToDate',
    currentVersion: '2.0.0',
    currentBuild: '200',
    lastCheckedAt: '2026-08-23T10:00:00.000Z',
  }));
  await newerRefresh;
  assert.equal(store.getState().state, 'upToDate');
  assert.equal(store.getState().currentVersion, '2.0.0');

  older.resolve(state({
    state: 'available',
    currentVersion: '1.0.0',
    currentBuild: '100',
    descriptor: descriptor({ version: '1.5.0', build: '150' }),
    lastCheckedAt: '2026-08-23T09:00:00.000Z',
  }));
  await olderRefresh;
  assert.equal(store.getState().state, 'upToDate');
  assert.equal(store.getState().currentVersion, '2.0.0');
  assert.equal(store.getState().descriptor, null);
  assert.equal(store.getState().loading, false);
});

test('download action results and explicit refreshes surface current long-download progress', async () => {
  const { createUpdatesStore, UpdatesPanel } = await loadModules();
  const bridge = createBridge(state({ state: 'available', descriptor: descriptor({ sizeBytes: 40 * 1024 * 1024 }) }));
  bridge.downloadNow = () => {
    bridge.calls.push('downloadNow');
    bridge.state = state({
      state: 'downloading',
      descriptor: descriptor({ sizeBytes: 40 * 1024 * 1024 }),
      download: { receivedBytes: 10 * 1024 * 1024, totalBytes: 40 * 1024 * 1024, fraction: 0.25 },
    });
    return bridge.state;
  };
  const store = createUpdatesStore(bridge);
  await store.refresh();
  await store.downloadNow();

  const first = renderPanel(UpdatesPanel, store);
  assert.match(first.root.querySelector('[data-testid="updates-progress"]').textContent, /25%/);
  assert.equal(first.root.querySelector('[aria-label="25% downloaded"]') !== null, true);
  assert.equal(first.root.querySelector('[data-testid="updates-cancel"]').disabled, false);
  assert.equal(first.root.querySelector('[data-testid="updates-install"]').disabled, true);
  first.dom.window.close();

  bridge.state = state({
    state: 'downloading',
    descriptor: descriptor({ sizeBytes: 40 * 1024 * 1024 }),
    download: { receivedBytes: 30 * 1024 * 1024, totalBytes: 40 * 1024 * 1024, fraction: 0.75 },
  });
  await store.refresh();
  const second = renderPanel(UpdatesPanel, store);
  assert.match(second.root.querySelector('[data-testid="updates-progress"]').textContent, /75%/);
  assert.equal(second.root.querySelector('[aria-label="75% downloaded"]') !== null, true);
  second.dom.window.close();
});

test('rapid double install issues only one bridge command while blocker collection is pending', async () => {
  const { createUpdatesStore } = await loadModules();
  const bridge = createBridge(state({ state: 'readyToInstall', descriptor: descriptor() }));
  const store = createUpdatesStore(bridge);
  await store.refresh();

  const blockers = deferred();
  bridge.collectBlockers = () => {
    bridge.calls.push('collectBlockers');
    return blockers.promise;
  };
  const firstInstall = store.installNow();
  const secondInstall = store.installNow();
  blockers.resolve([]);
  await Promise.all([firstInstall, secondInstall]);

  assert.equal(
    bridge.calls.filter((call) => call === 'installNow').length,
    1,
    'renderer must serialize install commands before awaiting blocker collection',
  );
});
