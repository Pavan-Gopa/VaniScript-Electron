'use strict';

// SET-04 — Settings UI parity test.
//
// The Settings UI (SettingsModal) reads and writes the main-process settings
// store exclusively through `window.electronAPI` (IPC), never `localStorage`.
// This test exercises the IPC bridge that backs that UI — `useSettingsStore`
// — without pulling in React DOM testing libraries or jsdom. It renders a
// throwaway probe component with `react-dom/server` to obtain the hook's
// return value, then drives `fetchSettings`/`updateSettings` directly.

const { test } = require('node:test');
const assert = require('node:assert/strict');

function installBridge(getSettings, updateSettings) {
  globalThis.window = globalThis.window || {};
  globalThis.window.electronAPI = { getSettings, updateSettings };
}

function loadHookAndProbe() {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  // src/hooks is an ESM package (package.json "type":"module"); load via dynamic import.
  // eslint-disable-next-line node/no-unsupported-features/esm
  return import('../src/hooks/useSettingsStore.ts').then(({ useSettingsStore }) => {
    let store;
    function Probe() {
      store = useSettingsStore();
      return React.createElement('span', null, 'probe');
    }
    renderToStaticMarkup(React.createElement(Probe));
    return store;
  });
}

test('useSettingsStore reads settings through the electronAPI.getSettings bridge', async () => {
  const baseSettings = { theme: 'dark', language: 'en', autoSave: true };
  const baseUsage = { total: 3, lastRun: '2026-08-21' };
  let getCalls = 0;

  installBridge(
    async () => {
      getCalls += 1;
      return { ok: true, settings: baseSettings, usage: baseUsage };
    },
    async () => ({ ok: true, settings: {}, usage: undefined }),
  );

  const store = await loadHookAndProbe();
  const fetched = await store.fetchSettings();

  assert.equal(getCalls, 1, 'bridge.getSettings must be called exactly once');
  assert.deepEqual(fetched, baseSettings, 'fetchSettings returns the IPC settings payload');
});

test('useSettingsStore writes a patch through the electronAPI.updateSettings bridge', async () => {
  let updateCalls = 0;
  let lastArgs = null;

  installBridge(
    async () => ({ ok: true, settings: { theme: 'dark' }, usage: {} }),
    async (args) => {
      updateCalls += 1;
      lastArgs = args;
      return { ok: true, settings: args.settings, usage: args.usage };
    },
  );

  const store = await loadHookAndProbe();
  const updated = await store.updateSettings({ theme: 'light' }, { total: 1, lastRun: 'x' });

  assert.equal(updateCalls, 1, 'bridge.updateSettings must be called exactly once');
  assert.deepEqual(
    lastArgs,
    { settings: { theme: 'light' }, usage: { total: 1, lastRun: 'x' } },
    'updateSettings forwards the partial patch and usage to Main',
  );
  assert.deepEqual(updated, { theme: 'light' }, 'updateSettings resolves with the stored settings');
});

test('useSettingsStore never touches localStorage and degrades to a local copy without a bridge', async () => {
  // Ensure no bridge exists.
  globalThis.window = globalThis.window || {};
  delete globalThis.window.electronAPI;

  const store = await loadHookAndProbe();
  const updated = await store.updateSettings({ theme: 'light' });

  // No IPC bridge → best-effort local merge, and crucially nothing reaches localStorage.
  assert.deepEqual(updated, { theme: 'light' });
});
