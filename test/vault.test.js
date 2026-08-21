'use strict';

// Unit tests for the credential vault (Electron/main/storage/vault.js).
//
// These run under plain `node --test` — no Electron runtime, no display, no
// packaged build. The OS-backed path is exercised with a mock `safeStorage`
// that performs real AES-GCM encryption (proving the vault defers to
// safeStorage rather than writing plaintext), and the no-keychain / unit-test
// fallback is forced deterministically with a `safeStorage` stub that reports
// `isEncryptionAvailable() === false`.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const vault = require('../electron/main/storage/vault');

// --- helpers --------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vs-vault-test-'));
}

function makeMockSafeStorage() {
  const key = crypto.randomBytes(32);
  const calls = { encrypt: 0, decrypt: 0 };
  return {
    calls,
    isEncryptionAvailable: () => true,
    encryptString: (s) => {
      calls.encrypt += 1;
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, enc]);
    },
    decryptString: (buf) => {
      calls.decrypt += 1;
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const enc = buf.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString(
        'utf8',
      );
    },
  };
}

function makeUnavailableSafeStorage() {
  return { isEncryptionAvailable: () => false };
}

let tmpDir;
let vaultPath;

beforeEach(() => {
  tmpDir = makeTempDir();
  vaultPath = path.join(tmpDir, 'vault.json');
  vault.resetConfig();
  vault.setVaultPath(vaultPath);
});

afterEach(() => {
  vault.resetConfig();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// --- import safety --------------------------------------------------------

test('module imports under plain node without requiring electron', () => {
  // Already required at top; if it threw, the file would not load at all.
  assert.equal(typeof vault.storeSecret, 'function');
  assert.equal(typeof vault.getSecret, 'function');
  assert.equal(typeof vault.deleteSecret, 'function');
  assert.equal(typeof vault.isSystemVaultAvailable, 'function');
});

// --- OS-backed (safeStorage) path -----------------------------------------

test('storeSecret + getSecret round-trip through safeStorage', () => {
  const safe = makeMockSafeStorage();
  vault.setSafeStorage(safe);

  assert.equal(vault.isSystemVaultAvailable(), true);

  vault.storeSecret('openai-key', 'sk-super-secret-value', { vaultPath });
  assert.equal(safe.calls.encrypt, 1, 'encryptString should be called once');

  const got = vault.getSecret('openai-key', { vaultPath });
  assert.equal(got, 'sk-super-secret-value');
  assert.equal(safe.calls.decrypt, 1, 'decryptString should be called once');
});

test('safeStorage path does NOT write plaintext to disk', () => {
  const safe = makeMockSafeStorage();
  vault.setSafeStorage(safe);

  const secret = 'sk-do-not-leak-me';
  vault.storeSecret('openai-key', secret, { vaultPath });

  const onDisk = fs.readFileSync(vaultPath, 'utf8');
  assert.equal(
    onDisk.includes(secret),
    false,
    'plaintext secret must not appear in the vault file',
  );
  assert.ok(
    onDisk.includes('"safeStorage"'),
    'vault should record the safeStorage backend',
  );
});

test('safeStorage path keeps secrets independent per key', () => {
  const safe = makeMockSafeStorage();
  vault.setSafeStorage(safe);

  vault.storeSecret('openai-key', 'value-a', { vaultPath });
  vault.storeSecret('grok-key', 'value-b', { vaultPath });

  assert.equal(vault.getSecret('openai-key', { vaultPath }), 'value-a');
  assert.equal(vault.getSecret('grok-key', { vaultPath }), 'value-b');

  // Overwriting one key does not disturb the other.
  vault.storeSecret('openai-key', 'value-a2', { vaultPath });
  assert.equal(vault.getSecret('openai-key', { vaultPath }), 'value-a2');
  assert.equal(vault.getSecret('grok-key', { vaultPath }), 'value-b');
});

test('getSecret returns null for an unknown key', () => {
  const safe = makeMockSafeStorage();
  vault.setSafeStorage(safe);
  vault.storeSecret('openai-key', 'value', { vaultPath });
  assert.equal(vault.getSecret('does-not-exist', { vaultPath }), null);
});

test('deleteSecret removes a secret and persists the change', () => {
  const safe = makeMockSafeStorage();
  vault.setSafeStorage(safe);

  vault.storeSecret('openai-key', 'value', { vaultPath });
  assert.equal(vault.deleteSecret('openai-key', { vaultPath }), true);
  assert.equal(vault.getSecret('openai-key', { vaultPath }), null);

  // Second delete is a no-op.
  assert.equal(vault.deleteSecret('openai-key', { vaultPath }), false);

  const onDisk = fs.readFileSync(vaultPath, 'utf8');
  assert.ok(!onDisk.includes('openai-key'), 'deleted key should be gone');
});

test('secret survives a process-style re-open (disk persistence)', () => {
  const safe = makeMockSafeStorage();
  vault.setSafeStorage(safe);
  vault.storeSecret('mcp-token', 'persisted-token', { vaultPath });

  // Drop injected state; re-inject the same mock to prove the bytes on disk
  // are decipherable — i.e. truly persisted, not held in memory.
  vault.resetConfig();
  vault.setVaultPath(vaultPath);
  vault.setSafeStorage(safe);

  assert.equal(vault.getSecret('mcp-token', { vaultPath }), 'persisted-token');
});

// --- keychain becoming unavailable (locked / removed at read time) -------

test('getSecret returns null (not crash) when keychain becomes unavailable after write', () => {
  // 1. Write a secret while a fully-functional safeStorage is present.
  const safe = makeMockSafeStorage();
  vault.setSafeStorage(safe);
  vault.storeSecret('openai-key', 'sk-super-secret-value', { vaultPath });
  assert.equal(safe.calls.encrypt, 1);

  // 2. Later the keychain is removed/locked: the injected instance reports
  //    isEncryptionAvailable() === false. Reading the safeStorage-encrypted
  //    record must gracefully return null instead of throwing.
  vault.setSafeStorage(makeUnavailableSafeStorage());
  assert.equal(vault.isSystemVaultAvailable(), false);

  assert.doesNotThrow(() => {
    const got = vault.getSecret('openai-key', { vaultPath });
    assert.equal(got, null, 'secret must be unrecoverable, not thrown');
  });
});

test('getSecret returns null (not crash) when keychain is present but locked', () => {
  // A locked keychain can still report isEncryptionAvailable() === true but
  // make decryptString() throw. The vault must recover gracefully.
  const locked = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s, 'utf8'),
    decryptString: () => {
      throw new Error('safeStorage: keychain is locked');
    },
  };

  // Write with a healthy mock so a real safeStorage record lands on disk.
  const healthy = makeMockSafeStorage();
  vault.setSafeStorage(healthy);
  vault.storeSecret('grok-key', 'locked-keychain-secret', { vaultPath });

  // Swap to the locked keychain before reading.
  vault.setSafeStorage(locked);
  assert.doesNotThrow(() => {
    const got = vault.getSecret('grok-key', { vaultPath });
    assert.equal(got, null, 'a locked keychain must yield null, not crash');
  });
});

// --- fallback (no keychain / unit test) path ------------------------------

test('fallback obfuscation round-trips when safeStorage is unavailable', () => {
  vault.setSafeStorage(makeUnavailableSafeStorage());
  assert.equal(vault.isSystemVaultAvailable(), false);

  vault.storeSecret('openai-key', 'plain-secret-value', { vaultPath });
  assert.equal(
    vault.getSecret('openai-key', { vaultPath }),
    'plain-secret-value',
  );
});

test('fallback does not store plaintext and warns exactly once', () => {
  vault.setSafeStorage(makeUnavailableSafeStorage());

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);

  try {
    vault.storeSecret('openai-key', 'not-plaintext-please', { vaultPath });
    // Second op should not emit a second warning.
    vault.getSecret('openai-key', { vaultPath });
  } finally {
    console.warn = origWarn;
  }

  const onDisk = fs.readFileSync(vaultPath, 'utf8');
  assert.equal(
    onDisk.includes('not-plaintext-please'),
    false,
    'fallback must not write plaintext',
  );
  assert.ok(onDisk.includes('"obfuscation"'), 'backend should be obfuscation');
  assert.equal(warnings.length, 1, 'fallback warning emitted exactly once');
  assert.ok(warnings[0].includes('safeStorage unavailable'));
});

test('fallback works (no crash) with NO safeStorage injected at all', () => {
  // No setSafeStorage call: relies on lazy require('electron') returning an
  // unavailable-safeStorage (or throwing), exactly like a headless test run.
  vault.storeSecret('openai-key', 'headless-value', { vaultPath });
  assert.equal(
    vault.getSecret('openai-key', { vaultPath }),
    'headless-value',
  );
  assert.equal(vault.deleteSecret('openai-key', { vaultPath }), true);
});

// --- corrupt / missing file handling --------------------------------------

test('getSecret on a missing vault returns null without throwing', () => {
  assert.equal(vault.getSecret('any-key', { vaultPath }), null);
});

test('corrupt vault file is backed up and treated as empty (no crash)', () => {
  fs.writeFileSync(vaultPath, '{ this is : not valid json ', { mode: 0o600 });
  // Should not throw; missing key -> null.
  assert.equal(vault.getSecret('any-key', { vaultPath }), null);
  // A corrupt backup should exist alongside.
  const siblings = fs.readdirSync(tmpDir);
  assert.ok(
    siblings.some((f) => f.startsWith('vault.json.corrupt.')),
    'corrupt vault should be backed up',
  );
});

// --- input validation -----------------------------------------------------

test('storeSecret rejects an empty key', () => {
  assert.throws(
    () => vault.storeSecret('', 'value', { vaultPath }),
    /key must be a non-empty string/,
  );
});

test('storeSecret rejects a non-string value', () => {
  assert.throws(
    () => vault.storeSecret('openai-key', 12345, { vaultPath }),
    /value must be a string/,
  );
});

test('getSecret/deleteSecret reject an empty key', () => {
  assert.throws(
    () => vault.getSecret('', { vaultPath }),
    /key must be a non-empty string/,
  );
  assert.throws(
    () => vault.deleteSecret('', { vaultPath }),
    /key must be a non-empty string/,
  );
});
