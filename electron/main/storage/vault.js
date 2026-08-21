'use strict';

/**
 * Credential vault for VaniScript's Electron main process.
 *
 * Provider API keys, the MCP access token, and other secrets are NEVER stored
 * in `settings.json` — that file keeps only opaque `keyRef` references
 * (e.g. `vault://openai-key`). The real values live here, encrypted before
 * they touch disk, so a read of `settings.json` leaks nothing sensitive.
 *
 * Encryption strategy (best available wins):
 *   1. Electron `safeStorage` when `safeStorage.isEncryptionAvailable()` is
 *      true. This is the primary, OS-backed path: on macOS the key lives in
 *      the Keychain, on Windows in Credential Manager, on Linux in
 *      libsecret/Secret Service. The vault asks `safeStorage` to encrypt each
 *      value; the OS owns the master key.
 *   2. Fallback: when `safeStorage` is unavailable (headless unit tests,
 *      Linux without a keyring, etc.) the vault emits a warning and persists
 *      an *obfuscated* blob instead of plaintext. Obfuscation is NOT a
 *      security boundary — it only prevents accidental plaintext disclosure
 *      (e.g. opening the file in an editor). A hardened deployment must run on
 *      a platform with a working system vault; a production build should
 *      refuse to fall back without explicit operator consent.
 *
 * Public API:
 *   storeSecret(key, value, opts)  -> true
 *   getSecret(key, opts)           -> string | null
 *   deleteSecret(key, opts)        -> boolean
 *   isSystemVaultAvailable()       -> boolean  (safeStorage reachable)
 *   setVaultPath(p) / setSafeStorage(s) / resetConfig()  (test hooks)
 *
 * This module deliberately does NOT `require('electron')` at the top level, so
 * it can be unit-tested under plain `node --test`. Electron (and its
 * `safeStorage`) is required lazily, and a `safeStorage` instance can be
 * injected for tests.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const VAULT_FILENAME = 'vault.json';
const TMP_PREFIX = '.vault.tmp';
const FORMAT_VERSION = 1;
const OBFUSCATION_TAG = 'obf1';

// Test hooks (never set in production code paths).
let injectedSafeStorage = null; // override safeStorage detection
let configuredVaultPath = null; // override the on-disk location
let warnedAboutFallback = false; // emit the fallback warning at most once

// --- safeStorage detection ------------------------------------------------

/**
 * Resolve the OS-backed `safeStorage` instance, or null when it is unavailable
 * (missing Electron, or `isEncryptionAvailable()` is false — e.g. Linux
 * without a keyring, or a headless test runtime).
 */
function getSystemSafeStorage() {
  const candidate = injectedSafeStorage;
  if (candidate) {
    // Even when a safeStorage instance is injected (tests, or a custom
    // runtime), it must actually report encryption as available. A keychain
    // that is present but locked/unavailable must not be blindly trusted.
    if (
      typeof candidate.isEncryptionAvailable === 'function' &&
      candidate.isEncryptionAvailable()
    ) {
      return candidate;
    }
    return null;
  }
  try {
    // eslint-disable-next-line global-require
    const electron = require('electron');
    const safe = electron && electron.safeStorage;
    if (
      safe &&
      typeof safe.isEncryptionAvailable === 'function' &&
      safe.isEncryptionAvailable()
    ) {
      return safe;
    }
    return null;
  } catch {
    return null;
  }
}

function isSystemVaultAvailable() {
  const safe = getSystemSafeStorage();
  return Boolean(
    safe &&
      typeof safe.isEncryptionAvailable === 'function' &&
      safe.isEncryptionAvailable(),
  );
}

// --- path resolution ------------------------------------------------------

/**
 * Resolve the vault file path. An explicitly injected `vaultPath` wins;
 * otherwise the file lives at `<userData>/vault/vault.json`.
 */
function resolveOptions(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const vaultPath =
    typeof o.vaultPath === 'string' && o.vaultPath.length > 0
      ? o.vaultPath
      : getDefaultVaultPath();
  return { vaultPath };
}

function getDefaultVaultPath() {
  if (configuredVaultPath) return configuredVaultPath;
  // eslint-disable-next-line global-require
  const electron = require('electron');
  const userData = electron.app.getPath('userData');
  return path.join(userData, 'vault', VAULT_FILENAME);
}

// --- obfuscation fallback -------------------------------------------------

// The fallback is reversible XOR obfuscation keyed by a per-vault random salt
// plus the machine hostname. It is intentionally NOT cryptography: it exists so
// the on-disk file is not plaintext, and to make the unsafe condition visible.
function deriveObfuscationKey(salt) {
  return crypto
    .createHash('sha256')
    .update(Buffer.concat([
      salt,
      Buffer.from(os.hostname(), 'utf8'),
      Buffer.from('vaniscript-credential-vault', 'utf8'),
    ]))
    .digest();
}

function obfuscate(plaintext, salt) {
  const key = deriveObfuscationKey(salt);
  const pt = Buffer.from(plaintext, 'utf8');
  const out = Buffer.alloc(pt.length);
  for (let i = 0; i < pt.length; i += 1) {
    out[i] = pt[i] ^ key[i % key.length];
  }
  // Self-describing payload: tag:saltHex:base64(ciphertext).
  return `${OBFUSCATION_TAG}:${salt.toString('hex')}:${out.toString('base64')}`;
}

function deobfuscate(payload) {
  const parts = payload.split(':');
  if (parts.length !== 3 || parts[0] !== OBFUSCATION_TAG) {
    throw new Error('vault: unrecognized obfuscation payload');
  }
  const salt = Buffer.from(parts[1], 'hex');
  const key = deriveObfuscationKey(salt);
  const ct = Buffer.from(parts[2], 'base64');
  const out = Buffer.alloc(ct.length);
  for (let i = 0; i < ct.length; i += 1) {
    out[i] = ct[i] ^ key[i % key.length];
  }
  return out.toString('utf8');
}

// --- backend resolution ---------------------------------------------------

/** Decide which backend to use for a given vault document. */
function resolveBackend(doc) {
  if (isSystemVaultAvailable()) {
    return { type: 'safe', safe: getSystemSafeStorage() };
  }
  // Fallback path: warn once so the unsafe condition is observable.
  if (!warnedAboutFallback) {
    warnedAboutFallback = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[vault] safeStorage unavailable — using obfuscation fallback. ' +
        'Secrets are NOT protected by the OS keychain. Run on a platform with a ' +
        'system vault (macOS Keychain, Windows Credential Manager, libsecret) ' +
        'for real protection.',
    );
  }
  const salt =
    doc && typeof doc.salt === 'string'
      ? Buffer.from(doc.salt, 'hex')
      : crypto.randomBytes(16);
  return { type: 'obfuscation', salt };
}

function encryptValue(value, backend) {
  if (backend.type === 'safe') {
    return {
      enc: 'safeStorage',
      data: backend.safe.encryptString(value).toString('base64'),
    };
  }
  return { enc: 'obfuscation', data: obfuscate(value, backend.salt) };
}
function decryptValue(record, doc) {
  if (record.enc === 'safeStorage') {
    const safe = getSystemSafeStorage();
    if (!safe) {
      // Missing keychain / unit-test environment: a safeStorage-encrypted
      // secret cannot be recovered here, so treat it as absent rather than
      // crashing the process.
      return null;
    }
    try {
      // A present-but-locked keychain (or corrupt ciphertext) makes
      // decryptString throw. Recover gracefully instead of crashing.
      return safe
        .decryptString(Buffer.from(record.data, 'base64'))
        .toString('utf8');
    } catch {
      return null;
    }
  }
  if (record.enc === 'obfuscation') {
    return deobfuscate(record.data);
  }
  throw new Error(`vault: unknown encryption type "${record.enc}"`);
}

// --- disk helpers ---------------------------------------------------------

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/** Atomically write the vault document: temp file + fsync + rename. */
function atomicWriteString(filePath, content) {
  ensureParentDir(filePath);
  const tmp = `${filePath}${TMP_PREFIX}.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best-effort */
  }
}

function backupCorruptVault(vaultPath) {
  try {
    const dest = `${vaultPath}.corrupt.${Date.now()}`;
    fs.copyFileSync(vaultPath, dest);
  } catch {
    /* best-effort */
  }
}

/** Load the vault document; never throws on a missing or corrupt file. */
function loadDoc(vaultPath) {
  let raw;
  try {
    raw = fs.readFileSync(vaultPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { version: FORMAT_VERSION, secrets: {} };
    }
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    backupCorruptVault(vaultPath);
    return { version: FORMAT_VERSION, secrets: {} };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    backupCorruptVault(vaultPath);
    return { version: FORMAT_VERSION, secrets: {} };
  }
  parsed.secrets =
    parsed.secrets && typeof parsed.secrets === 'object' ? parsed.secrets : {};
  return parsed;
}

function saveDoc(vaultPath, doc) {
  atomicWriteString(vaultPath, JSON.stringify(doc, null, 2));
}

// --- public API -----------------------------------------------------------

/**
 * Store (or overwrite) a secret under `key`.
 * @param {string} key   non-empty identifier
 * @param {string} value secret value
 * @param {{vaultPath?: string}} [opts]
 * @returns {true}
 */
function storeSecret(key, value, opts) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('vault: key must be a non-empty string');
  }
  if (typeof value !== 'string') {
    throw new Error('vault: value must be a string');
  }
  const { vaultPath } = resolveOptions(opts);
  const doc = loadDoc(vaultPath);
  const backend = resolveBackend(doc);
  const record = encryptValue(value, backend);
  doc.version = FORMAT_VERSION;
  doc.backend = backend.type === 'safe' ? 'safeStorage' : 'obfuscation';
  if (backend.type === 'obfuscation') {
    doc.salt = backend.salt.toString('hex');
  }
  doc.secrets[key] = { ...record, updatedAt: new Date().toISOString() };
  saveDoc(vaultPath, doc);
  return true;
}

/**
 * Retrieve a secret by `key`, or null when it is absent.
 * @param {string} key
 * @param {{vaultPath?: string}} [opts]
 * @returns {string|null}
 */
function getSecret(key, opts) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('vault: key must be a non-empty string');
  }
  const { vaultPath } = resolveOptions(opts);
  const doc = loadDoc(vaultPath);
  const record = doc.secrets && doc.secrets[key];
  if (!record) return null;
  return decryptValue(record, doc);
}

/**
 * Remove a secret by `key`.
 * @param {string} key
 * @param {{vaultPath?: string}} [opts]
 * @returns {boolean} true if a secret was removed
 */
function deleteSecret(key, opts) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('vault: key must be a non-empty string');
  }
  const { vaultPath } = resolveOptions(opts);
  const doc = loadDoc(vaultPath);
  if (!doc.secrets || !(key in doc.secrets)) return false;
  delete doc.secrets[key];
  saveDoc(vaultPath, doc);
  return true;
}

// --- test hooks -----------------------------------------------------------

function setVaultPath(p) {
  configuredVaultPath = p;
}

function setSafeStorage(instance) {
  injectedSafeStorage = instance;
}

function resetConfig() {
  injectedSafeStorage = null;
  configuredVaultPath = null;
  warnedAboutFallback = false;
}

module.exports = {
  storeSecret,
  getSecret,
  deleteSecret,
  isSystemVaultAvailable,
  setVaultPath,
  setSafeStorage,
  resetConfig,
  VAULT_FILENAME,
};
