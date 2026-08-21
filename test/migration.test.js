// SET-03 — one-shot legacy `localStorage` → Main disk store migration.
//
// Covers the two acceptance pillars:
//   1. The handshake succeeds: legacy settings + extracted secrets land in the
//      Main-process disk store (`settings.json`) and credential vault, and the
//      Renderer clears `localStorage`.
//   2. On failure (e.g. vault locked) nothing is committed and `localStorage`
//      is retained untouched for a safe retry on next launch.
//
// The handler is Electron-free at the top level, so these run under plain
// `node --test`. The orchestration test injects seams (no browser / React).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handleMigrateLegacy } = require('../electron/main/storage/migrationHandler.js');
const vault = require('../electron/main/storage/vault.js');
const { runLegacySettingsMigration } = require('../src/stores/migrationStore.ts');

// Mirror the handler's secret-key derivation so we can address the vault entry.
function legacyVaultKey(secretPath) {
  return 'legacy:' + secretPath.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function lockedSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: () => {
      throw new Error('vault locked');
    },
    decryptString: () => {
      throw new Error('vault locked');
    },
  };
}

test('handler migrates legacy settings to disk store + vault (success)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-mig-'));
  const settingsPath = path.join(tmp, 'settings.json');
  const vaultPath = path.join(tmp, 'vault', 'vault.json');

  const payload = {
    settings: {
      providers: { openai: { apiKey: 'sk-secret-123', model: 'gpt-4' } },
      theme: 'dark',
    },
    usage: { transcriptions: 3 },
  };

  const result = handleMigrateLegacy(payload, { settingsPath, vaultPath });

  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(settingsPath), 'settings file must be written');

  const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  // Secret must NOT be stored inline...
  assert.equal(written.api?.providers?.openai?.apiKey, undefined);
  // ...and must be replaced by an opaque vault reference (hoisted as keyRef).
  assert.ok(
    written.api?.providers?.openai?.keyRef?.startsWith('vault://legacy:'),
    'expected a vault:// keyRef on the provider',
  );

  // The secret is recoverable from the vault under its deterministic key.
  const vaultKey = legacyVaultKey('settings.api.providers.openai.apiKey');
  assert.equal(vault.getSecret(vaultKey, { vaultPath }), 'sk-secret-123');

  // Receipt: checksum + resolved path.
  assert.ok(result.summary?.checksum && /^[0-9a-f]{64}$/.test(result.summary.checksum));
  assert.equal(result.summary?.settingsPath, settingsPath);
  assert.equal(result.summary?.vaultPath, vaultPath);
});

test('handler rolls back and fails when the vault is locked (no commit)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-mig-'));
  const settingsPath = path.join(tmp, 'settings.json');
  const vaultPath = path.join(tmp, 'vault', 'vault.json');

  const payload = {
    settings: { providers: { openai: { apiKey: 'sk-secret-123', model: 'gpt-4' } } },
  };

  const result = handleMigrateLegacy(payload, {
    settingsPath,
    vaultPath,
    safeStorage: lockedSafeStorage(),
  });

  assert.equal(result.ok, false, 'migration must report failure');
  assert.ok(!fs.existsSync(settingsPath), 'settings file must NOT be committed on failure');

  const vaultKey = legacyVaultKey('settings.api.providers.openai.apiKey');
  assert.equal(
    vault.getSecret(vaultKey, { vaultPath }),
    null,
    'partially-written secret must be rolled back',
  );

  // sanity: the injected safeStorage must not leak past the call.
  assert.equal(vault.isSystemVaultAvailable(), false);
});

test('handler preserves a pre-existing settings file on failure', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-mig-'));
  const settingsPath = path.join(tmp, 'settings.json');
  const vaultPath = path.join(tmp, 'vault', 'vault.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ existing: true }));

  const payload = {
    settings: { providers: { openai: { apiKey: 'sk-secret-123' } } },
  };

  const result = handleMigrateLegacy(payload, {
    settingsPath,
    vaultPath,
    safeStorage: lockedSafeStorage(),
  });

  assert.equal(result.ok, false);
  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(after, { existing: true }, 'pre-existing settings must survive a failed migration');
});

test('orchestration clears localStorage on success', async () => {
  let cleared = 0;
  const res = await runLegacySettingsMigration({
    hasLegacy: () => true,
    readLegacy: () => ({ settings: { theme: 'dark' }, usage: { count: 1 } }),
    send: async () => ({ ok: true }),
    clearLegacy: () => {
      cleared += 1;
    },
    onStatus: () => {},
  });

  assert.equal(res.status, 'migrated');
  assert.equal(cleared, 1, 'localStorage must be cleared exactly once on success');
});

test('orchestration retains localStorage on failure', async () => {
  let cleared = 0;
  const res = await runLegacySettingsMigration({
    hasLegacy: () => true,
    readLegacy: () => ({ settings: {} }),
    send: async () => ({ ok: false, errorCode: 'VAULT_LOCKED', error: 'vault locked' }),
    clearLegacy: () => {
      cleared += 1;
    },
    onStatus: () => {},
  });

  assert.equal(res.status, 'failed');
  assert.equal(res.detail, 'vault locked');
  assert.equal(cleared, 0, 'localStorage must NOT be cleared on failure (retry next launch)');
});

test('orchestration skips when there is no legacy data', async () => {
  let cleared = 0;
  const res = await runLegacySettingsMigration({
    hasLegacy: () => false,
    readLegacy: () => ({}),
    send: async () => ({ ok: true }),
    clearLegacy: () => {
      cleared += 1;
    },
    onStatus: () => {},
  });

  assert.equal(res.status, 'skipped');
  assert.equal(cleared, 0, 'nothing to clear when there is no legacy data');
});
