'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createObservability } = require('../electron/main/observability.js');
const { createDefaultUsageLedger } = require('../shared/contracts/settings-runtime.js');

function store(settings, fail = false) {
  return {
    readSettings: () => {
      if (fail) throw new Error('SETTINGS_STACK /Users/private/settings.json');
      return settings;
    },
    writeSettings: () => {},
  };
}

test('diagnostics is an allowlisted projection with safe errors and no raw logs', () => {
  const settings = {
    schemaVersion: 2,
    api: {
      providers: {
        'gemini-cloud': {
          enabled: true,
          model: 'gemini-2.5-flash',
          keyRef: 'vault://secret-ref',
          transcriptionModel: 'gemini-2.5-flash',
          translationModel: 'gemini-2.5-flash',
        },
      },
      lastUsage: createDefaultUsageLedger(),
    },
    agents: { preferredAgent: 'codex', embeddedChatEnabled: true, localMcpEnabled: true, mcpPort: 19789, permissions: { read: true } },
    appearance: { theme: 'dark', density: 'compact', baseFontSize: 15, scale: 1.2, reduceMotion: true, highContrast: false },
    transcription: { defaultSourceLanguage: 'en', defaultTranscriptionProvider: 'gemini-cloud', defaultTranslationProvider: 'gemini-cloud', defaultTargetLanguage: 'fr' },
    chunking: { media: { targetDurationMinutes: 12, sliceMode: 'silence' }, document: { targetTokens: 2000 } },
  };
  const obs = createObservability({
    sink: () => {},
    settingsStore: store(settings),
    appInfo: { appVersion: '1.2.3', electronVersion: '30.0.0', platform: 'darwin', arch: 'arm64' },
    capabilities: { host: { platform: 'darwin', arch: 'arm64', audioLoopbackAvailable: true }, capabilities: { audio: { available: true, reasonCode: 'OK', backend: 'coreaudio' } } },
    models: { entries: [{ name: 'whisper-large-v3', runtime: 'mlx', role: 'asr', supported: true, path: '/Users/private/model.bin', checksum: 'CHECKSUM_MARKER' }] },
    logsAvailable: true,
  });
  obs.recordError(Object.assign(new Error('STACK_MARKER TRANSCRIPT_MARKER /Users/private'), { code: 'PROVIDER_ERROR', stack: 'STACK_MARKER' }), { category: 'provider', event: 'provider.failed', correlation: { requestId: 'request-1' } });
  const snapshot = obs.diagnostics.snapshot();
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.app.platform, 'darwin');
  assert.equal(snapshot.app.arch, 'arm64');
  assert.deepEqual(snapshot.capabilities.host, { platform: 'darwin', arch: 'arm64', audioLoopbackAvailable: true });
  assert.equal(snapshot.capabilities.entries.audio.available, true);
  assert.equal(snapshot.settings.providers[0].hasKey, true);
  assert.equal(snapshot.settings.providers[0].model, 'gemini-2.5-flash');
  assert.equal(snapshot.models.entries[0].modelId, 'whisper-large-v3');
  assert.equal(snapshot.models.entries[0].sizeBytes, undefined);
  assert.equal(snapshot.rawLogsIncluded, false);
  assert.equal(snapshot.logsAvailable, true);
  const serialized = JSON.stringify(snapshot);
  for (const marker of ['vault://secret-ref', 'CHECKSUM_MARKER', '/Users/private', 'STACK_MARKER', 'TRANSCRIPT_MARKER', 'secret-ref']) {
    assert.equal(serialized.includes(marker), false, `leaked ${marker}`);
  }
  assert.equal(snapshot.recentErrors[0].error.message, 'Provider request failed.');
  assert.equal(snapshot.recentErrors[0].correlation.requestId.length, 32);
});

test('diagnostics returns partial failures independently', () => {
  const obs = createObservability({
    sink: () => {},
    settingsStore: store({}, true),
    capabilities: () => { throw new Error('CAPABILITY_STACK'); },
    models: () => { throw new Error('MODEL_STACK'); },
    logsAvailable: () => { throw new Error('LOG_STACK'); },
    appInfo: () => { throw new Error('APP_STACK'); },
  });
  const snapshot = obs.diagnostics.snapshot();
  assert.deepEqual(snapshot.capabilities.host, { platform: process.platform, arch: process.arch, audioLoopbackAvailable: false });
  assert.deepEqual(snapshot.capabilities.entries, {});
  assert.equal(snapshot.rawLogsIncluded, false);
  assert.ok(snapshot.partialFailures.some((failure) => failure.component === 'settings'));
  assert.ok(snapshot.partialFailures.some((failure) => failure.component === 'capabilities'));
  assert.ok(snapshot.partialFailures.some((failure) => failure.component === 'models'));
  assert.ok(snapshot.partialFailures.some((failure) => failure.component === 'diagnostics'));
  assert.equal(JSON.stringify(snapshot).includes('CAPABILITY_STACK'), false);
  assert.equal(JSON.stringify(snapshot).includes('MODEL_STACK'), false);
});
test('diagnostics assembly fallback retains safe capabilities', () => {
  const obs = createObservability({
    sink: () => {},
    appInfo: new Proxy({}, {
      get() {
        throw new Error('APP_STACK');
      },
    }),
    capabilities: {
      host: { platform: 'darwin', arch: 'arm64', audioLoopbackAvailable: true },
      capabilities: { audio: { available: true } },
    },
  });
  const snapshot = obs.diagnostics.snapshot();
  assert.deepEqual(snapshot.capabilities.host, { platform: 'darwin', arch: 'arm64', audioLoopbackAvailable: true });
  assert.ok(snapshot.partialFailures.some((failure) => failure.code === 'ASSEMBLY_FAILED'));
  assert.equal(snapshot.rawLogsIncluded, false);
  assert.equal(JSON.stringify(snapshot).includes('APP_STACK'), false);
});
