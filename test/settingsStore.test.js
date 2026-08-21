'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../electron/main/storage/settingsStore.js');
const { SETTINGS_SCHEMA_VERSION, createDefaultSettings } = require('../shared/contracts/settings.ts');

function tmpSettingsPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-store-'));
  return path.join(dir, 'settings', 'settings.json');
}

test('missing file falls back to defaults without crashing', () => {
  const settingsPath = tmpSettingsPath();
  const result = store.readSettings({ settingsPath });

  assert.deepEqual(result.settings, createDefaultSettings());
  assert.equal(result.source, 'defaults');
  assert.equal(result.recovered, false);
  assert.equal(result.migrated, false);
  assert.equal(fs.existsSync(settingsPath), false);
});

test('corrupted JSON recovers to defaults and backs up the bad file', () => {
  const settingsPath = tmpSettingsPath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, '{ this is : not valid json,,,', 'utf8');

  const result = store.readSettings({ settingsPath });

  assert.deepEqual(result.settings, createDefaultSettings());
  assert.equal(result.recovered, true);
  assert.equal(result.source, 'defaults');

  // The bad file is moved into a Corrupt/ directory, not left in place.
  const corruptDir = path.join(path.dirname(settingsPath), 'Corrupt');
  assert.equal(fs.existsSync(settingsPath), false, 'corrupt file removed from main path');
  const backups = fs.existsSync(corruptDir)
    ? fs.readdirSync(corruptDir).filter((f) => f.startsWith('settings.'))
    : [];
  assert.ok(backups.length >= 1, 'corrupt file backed up');
});

test('empty file (invalid JSON) recovers to defaults', () => {
  const settingsPath = tmpSettingsPath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, '', 'utf8');

  const result = store.readSettings({ settingsPath });
  assert.equal(result.recovered, true);
  assert.deepEqual(result.settings, createDefaultSettings());
});

test('partial valid settings are merged with defaults', () => {
  const settingsPath = tmpSettingsPath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      appearance: { theme: 'dark', baseFontSize: 18 },
    }),
    'utf8',
  );

  const result = store.readSettings({ settingsPath });

  assert.equal(result.source, 'file');
  assert.equal(result.recovered, false);
  assert.equal(result.migrated, false);
  assert.equal(result.settings.appearance.theme, 'dark');
  assert.equal(result.settings.appearance.baseFontSize, 18);
  // Untouched fields fall back to defaults.
  assert.equal(result.settings.appearance.reduceMotion, false);
  assert.equal(result.settings.transcription.defaultTargetLanguage, 'en');
  assert.deepEqual(result.settings.api, createDefaultSettings().api);
});

test('unversioned file is migrated to the current schema version', () => {
  const settingsPath = tmpSettingsPath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  // Legacy shape: no schemaVersion field at all.
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ appearance: { theme: 'light' } }),
    'utf8',
  );

  const result = store.readSettings({ settingsPath });

  assert.equal(result.migrated, true);
  assert.equal(result.fromVersion, 0);
  assert.equal(result.settings.schemaVersion, SETTINGS_SCHEMA_VERSION);
  assert.equal(result.source, 'migrated');
  assert.equal(result.settings.appearance.theme, 'light');
});

test('invalid enum/type values are coerced to defaults without throwing', () => {
  const settingsPath = tmpSettingsPath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ appearance: { theme: 'neon', baseFontSize: 'big' } }),
    'utf8',
  );

  const result = store.readSettings({ settingsPath });
  // Invalid enum -> default 'system'; invalid number -> default 14.
  assert.equal(result.settings.appearance.theme, 'system');
  assert.equal(result.settings.appearance.baseFontSize, 14);
});

test('writeSettings persists a canonical document atomically', () => {
  const settingsPath = tmpSettingsPath();
  const custom = createDefaultSettings();
  custom.appearance.theme = 'dark';
  custom.transcription.defaultTargetLanguage = 'de';
  custom.api.favoriteModels = ['gpt-4o'];

  const written = store.writeSettings(custom, { settingsPath });

  assert.equal(written.settingsPath, settingsPath);
  assert.equal(fs.existsSync(settingsPath), true);
  // On-disk file is canonical: current schema version, all defaults present.
  const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(onDisk.schemaVersion, SETTINGS_SCHEMA_VERSION);
  assert.equal(onDisk.appearance.theme, 'dark');
  assert.equal(onDisk.transcription.defaultTargetLanguage, 'de');
  assert.deepEqual(onDisk.api.favoriteModels, ['gpt-4o']);
  assert.equal(onDisk.appearance.reduceMotion, false);
});

test('atomic write leaves no temp file behind', () => {
  const settingsPath = tmpSettingsPath();
  store.writeSettings(createDefaultSettings(), { settingsPath });

  const dir = path.dirname(settingsPath);
  const leftover = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftover, [], 'no leftover temp files');
});

test('write then read simulates a restart and preserves persisted values', () => {
  const settingsPath = tmpSettingsPath();

  // First "session": user changes a setting and we persist it.
  const edited = createDefaultSettings();
  edited.appearance.theme = 'light';
  edited.updates.channel = 'beta';
  store.writeSettings(edited, { settingsPath });

  // Second "session" (fresh read, as if the app relaunched): must reflect the
  // persisted values, not revert to defaults.
  const reopened = store.readSettings({ settingsPath });
  assert.equal(reopened.source, 'file');
  assert.equal(reopened.recovered, false);
  assert.equal(reopened.settings.appearance.theme, 'light');
  assert.equal(reopened.settings.updates.channel, 'beta');
  // Fields the user never touched remain at defaults.
  assert.equal(reopened.settings.appearance.density, 'comfortable');
});

test('writeSettings normalizes a partial payload before persisting', () => {
  const settingsPath = tmpSettingsPath();
  // Pass only a fragment; the store must fill defaults and stamp the version.
  store.writeSettings({ glossary: { protectedTermsPolicy: 'preserve' } }, { settingsPath });

  const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(onDisk.schemaVersion, SETTINGS_SCHEMA_VERSION);
  assert.equal(onDisk.glossary.protectedTermsPolicy, 'preserve');
  assert.equal(onDisk.glossary.languageScoped, true); // default filled
  assert.ok(typeof onDisk.appearance === 'object');
});

test('provider secrets are never persisted as plaintext', () => {
  const settingsPath = tmpSettingsPath();
  store.writeSettings(
    {
      api: {
        providers: {
          openai: { id: 'openai', enabled: true, keyRef: 'vault://openai-key', model: 'gpt-4o' },
        },
      },
    },
    { settingsPath },
  );

  const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const provider = onDisk.api.providers.openai;
  assert.equal(provider.keyRef, 'vault://openai-key');
  assert.equal('key' in provider, false, 'no plaintext key field');
  assert.equal('apiKey' in provider, false);
});
