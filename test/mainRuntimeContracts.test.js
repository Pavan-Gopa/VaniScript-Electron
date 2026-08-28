'use strict';

// P3E.D2 — Electron main runtime contract boundary.
//
// The shared contracts (errors / providers / settings) each have ONE runtime
// source (`shared/contracts/*-runtime.js`) plus a typed façade. The Electron
// main process startup boundary (providers/router.js,
// storage/settingsStore.js) must load those runtime entrypoints without any
// TypeScript loader, exactly like the packaged binary does under
// ELECTRON_RUN_AS_NODE.
//
// These tests drive the public load boundary and representative behavior of
// every module on that boundary — they never inspect implementation source.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const errorsRuntime = require('../shared/contracts/errors-runtime.js');
const providersRuntime = require('../shared/contracts/providers-runtime.js');
const settingsRuntime = require('../shared/contracts/settings-runtime.js');
const router = require('../electron/main/providers/router.js');
const settingsStore = require('../electron/main/storage/settingsStore.js');

// --- Runtime load boundary ---------------------------------------------------

test('startup contract runtimes are plain .js modules loadable via require', () => {
  for (const relative of [
    '../shared/contracts/errors-runtime.js',
    '../shared/contracts/providers-runtime.js',
    '../shared/contracts/settings-runtime.js',
    '../electron/main/providers/router.js',
    '../electron/main/storage/settingsStore.js',
  ]) {
    const resolved = require.resolve(relative);
    assert.match(resolved, /\.js$/, relative);
  }
  assert.equal(typeof router.invokeProvider, 'function');
  assert.equal(typeof settingsStore.readSettings, 'function');
});

test('error runtime serializes, guards, and validates AppErrors', () => {
  const { ERROR_CODES, AppError, createAppError, isErrorCode, isAppError, validateAppError } =
    errorsRuntime;

  assert.ok(ERROR_CODES.includes('PROVIDER_ERROR'));
  assert.ok(isErrorCode('VALIDATION_FAILED'));
  assert.equal(isErrorCode('NOT_A_CODE'), false);

  const err = createAppError('NOT_FOUND', 'missing chunk', { chunkIndex: 3 });
  assert.ok(err instanceof AppError);
  assert.equal(err.name, 'AppError');
  assert.deepEqual(err.toJSON(), {
    code: 'NOT_FOUND',
    message: 'missing chunk',
    details: { chunkIndex: 3 },
  });

  assert.ok(isAppError(err));
  // Structural acceptance survives a lost prototype across serialization.
  assert.ok(isAppError(JSON.parse(JSON.stringify(err))));

  const validated = validateAppError({ code: 'CONFLICT', message: 'clash', details: null });
  assert.equal(validated.ok, true);
  assert.ok(validated.value instanceof AppError);

  const rejected = validateAppError({ code: 'BOGUS', message: 'x' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /known error codes/);
});

test('settings runtime defaults, normalizes, and migrates', () => {
  const { SETTINGS_SCHEMA_VERSION, createDefaultSettings, normalizeSettings, migrateSettings } =
    settingsRuntime;

  assert.equal(SETTINGS_SCHEMA_VERSION, 2);

  const defaults = createDefaultSettings();
  assert.equal(defaults.agents.permissions.mutate, false);
  assert.equal(defaults.appearance.theme, 'system');
  // Fresh clone per call: callers can never poison the canonical defaults.
  defaults.transcription.defaultTargetLanguage = 'zz';
  assert.equal(createDefaultSettings().transcription.defaultTargetLanguage, 'en');

  const repaired = normalizeSettings({
    appearance: { theme: 'neon', baseFontSize: 9999 },
    transcription: { defaultTargetLanguage: 42 },
  });
  assert.equal(repaired.appearance.theme, 'system');
  assert.equal(repaired.appearance.baseFontSize, 72, 'numeric fields clamp to their maximum');
  assert.equal(repaired.transcription.defaultTargetLanguage, 'en');

  const legacy = migrateSettings({ agents: { preferredAgent: 'qwen' } });
  assert.equal(legacy.fromVersion, 0);
  assert.equal(legacy.migrated, true);
  assert.equal(legacy.settings.schemaVersion, SETTINGS_SCHEMA_VERSION);
  assert.equal(legacy.settings.agents.preferredAgent, 'qwen');
  const legacyV1 = migrateSettings({
    schemaVersion: 1,
    api: { lastUsage: { 'gemini-cloud': { sessions: 2, inputTokens: 5 } } },
  });
  assert.equal(legacyV1.fromVersion, 1);
  assert.equal(legacyV1.migrated, true);
  assert.equal(legacyV1.settings.schemaVersion, 2);
  assert.equal(legacyV1.settings.api.lastUsage.requests, 2);
});

test('provider runtime publishes the bridge command consumed by the router', () => {
  assert.equal(providersRuntime.PROVIDER_INVOKE_COMMAND, 'provider:invoke');
  assert.equal(router.PROVIDER_INVOKE_COMMAND, providersRuntime.PROVIDER_INVOKE_COMMAND);
});

// --- Router behavior over the runtime contracts ------------------------------

const GEMINI_SETTINGS = () => ({
  api: {
    providers: {
      gemini: { id: 'gemini', enabled: true, keyRef: 'vault://gemini', translationModel: 'gemini-flash' },
    },
  },
});

test('router resolves a keyed cloud route from settings plus vault seam', async () => {
  const route = await router.resolveRoute(
    { providerId: 'gemini', purpose: 'translation', prompt: 'translate this' },
    { readSettings: GEMINI_SETTINGS, getSecret: () => 'secret-key' },
  );
  assert.equal(route.model, 'gemini-flash');
  assert.equal(
    route.url,
    'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent('gemini-flash') +
      ':generateContent',
  );
  assert.deepEqual(route.headers, {
    'content-type': 'application/json',
    'x-goog-api-key': 'secret-key',
  });
  assert.equal('apiKey' in route, false, 'public route projection never carries the key');
});

test('router rejects unknown providers with a structured AppError', async () => {
  await assert.rejects(
    router.resolveRoute(
      { providerId: 'nope', prompt: 'hi' },
      { readSettings: () => ({ api: { providers: {} } }), getSecret: () => null },
    ),
    (err) => {
      assert.ok(router.isAppError(err));
      assert.equal(err.code, 'PROVIDER_ERROR');
      return true;
    },
  );
});

test('router honors self-hostable overrides but never redirects pinned hosts', async () => {
  const deps = {
    readSettings: () => ({
      api: {
        providers: {
          ollama: { id: 'ollama', enabled: true, model: 'llama3' },
          custom: { id: 'custom', enabled: true, model: 'text-embedder', keyRef: 'vault://custom' },
        },
      },
    }),
    getSecret: () => 'secret-key',
  };

  const local = await router.resolveRoute(
    { providerId: 'ollama', prompt: 'hi', baseUrl: 'http://127.0.0.1:11435' },
    deps,
  );
  assert.match(local.url, /^http:\/\/127\.0\.0\.1:11435\/api\/chat/);

  const custom = await router.resolveRoute(
    { providerId: 'custom', prompt: 'hi', baseUrl: 'https://attacker.example' },
    deps,
  );
  assert.match(custom.url, /^https:\/\/api\.openai\.com\//, 'untrusted baseUrl is ignored');
});

test('router redacts secrets from surfaced text', () => {
  assert.equal(router.redactSecret('key sk-abc123 tail', 'sk-abc123'), 'key *** tail');
  assert.equal(router.redactSecret('nothing here', ''), 'nothing here');
});

// --- Settings disk store over the runtime contract ---------------------------

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaniscript-settings-'));
  return { dir, settingsPath: path.join(dir, 'settings.json') };
}

test('settings store reads defaults, persists canonically, and recovers corruption', () => {
  const { settingsPath, dir } = makeTempStore();
  const opts = { settingsPath, corruptDir: path.join(dir, 'Corrupt') };

  // Missing file falls back to canonical defaults.
  let result = settingsStore.readSettings(opts);
  assert.equal(result.source, 'defaults');
  assert.equal(result.recovered, false);
  assert.equal(result.settings.schemaVersion, settingsStore.SETTINGS_SCHEMA_VERSION);
  assert.equal(settingsStore.SETTINGS_SCHEMA_VERSION, 2);

  // Partial writes persist as fully normalized documents.
  settingsStore.writeSettings(
    { agents: { preferredAgent: 'grok' }, api: { providers: { openai: { enabled: true } } } },
    opts,
  );
  result = settingsStore.readSettings(opts);
  assert.equal(result.source, 'file');
  assert.equal(result.settings.agents.preferredAgent, 'grok');
  assert.equal(result.settings.api.providers.openai.enabled, true);
  assert.equal(result.settings.updates.channel, 'stable', 'defaults fill untouched sections');
  assert.equal(result.settings.agents.permissions.destructive, false);

  // Corrupt payloads are backed aside and the app keeps running on defaults.
  fs.writeFileSync(settingsPath, '{"agents": truncated');
  result = settingsStore.readSettings(opts);
  assert.equal(result.recovered, true);
  assert.equal(result.source, 'defaults');
  assert.equal(fs.existsSync(settingsPath), false, 'corrupt file was moved away');
  assert.match(fs.readdirSync(opts.corruptDir)[0], /^settings\./);
});
