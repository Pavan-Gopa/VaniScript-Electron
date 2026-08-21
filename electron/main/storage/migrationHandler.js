'use strict';

/**
 * SET-03: one-shot legacy settings migration handler.
 *
 * The Renderer reads the legacy `localStorage` keys (`vs_settings_v1`,
 * `vs_usage_v1`), parses them, and invokes this handler with the raw payload.
 * This handler commits them to the Main-process disk settings store and the
 * credential vault, then returns an ack.
 *
 * Safety / rollback contract:
 *  - Secrets are extracted from the legacy payload and written to the vault
 *    first; the settings document (with opaque `keyRef` references) is written
 *    second.
 *  - If any step throws, every secret already written is rolled back and any
 *    previously-existing settings file is restored (or, if none existed, the
 *    freshly-created file is removed). The handler then returns `{ ok: false }`
 *    and the Renderer KEEPS `localStorage` intact for a retry on next launch.
 *  - On success the Renderer clears `localStorage`.
 *
 * The module is Electron-free at the top level so it can be unit-tested under
 * plain `node --test`. The vault's `safeStorage` is injected via `opts.safeStorage`
 * only in tests; production never sets it and falls back to real electron safeStorage.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const settingsStore = require('./settingsStore.js');
const vault = require('./vault.js');

// Secret-like key names. Bare `key` is only treated as a secret inside a
// provider context (otherwise it is far too likely to be a false positive).
const SECRET_KEY_RE = /^(api[_-]?key|access[_-]?token|token|secret|client[_-]?secret|password|bearer)$/i;

function isSecretKeyName(key, inProvider) {
  if (SECRET_KEY_RE.test(key)) return true;
  if (key === 'key' && inProvider) return true;
  return false;
}

function looksLikeProvider(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (
    'model' in value ||
    'enabled' in value ||
    'apiKey' in value ||
    'key' in value ||
    'token' in value ||
    'keyRef' in value ||
    'baseUrl' in value
  );
}

function sanitizeSegment(segment) {
  return String(segment).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Leniently coerce the legacy payload into a plain object.
 * Accepts an already-parsed object, or a JSON string (with a trailing scan for
 * the first `{...}` blob when the value is wrapped). Never throws on malformed
 * input — a parse failure simply yields `{}`.
 */
function coerceObject(input) {
  if (input == null) return {};
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.length === 0) return {};
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      // Fall back to scanning for the first JSON object blob.
      const start = trimmed.indexOf('{');
      const end = trimmed.lastIndexOf('}');
      if (start !== -1 && end > start) {
        try {
          const parsed = JSON.parse(trimmed.slice(start, end + 1));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch {
          /* ignore */
        }
      }
      return {};
    }
  }
  if (typeof input === 'object' && !Array.isArray(input)) return input;
  return {};
}

/**
 * Recursively walk `obj`, extracting secret-like values into `entries` (mutating
 * `obj` to replace them with opaque `vault://` references). Inside a provider
 * context the reference is also hoisted to `keyRef` so the settings schema keeps
 * it after normalization.
 */
function extractSecrets(obj, pathPrefix, entries, inProvider) {
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => extractSecrets(item, `${pathPrefix}[${index}]`, entries, false));
    return;
  }
  if (!obj || typeof obj !== 'object') return;
  for (const [key, value] of Object.entries(obj)) {
    if (isSecretKeyName(key, inProvider) && typeof value === 'string' && value.length > 0) {
      const vaultKey = `legacy:${sanitizeSegment(`${pathPrefix}.${key}`)}`;
      entries.push({ vaultKey, value });
      if (inProvider) {
        obj.keyRef = `vault://${vaultKey}`;
        delete obj[key];
      } else {
        obj[key] = `vault://${vaultKey}`;
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const childInProvider = inProvider || key === 'providers' || looksLikeProvider(value);
      extractSecrets(value, `${pathPrefix}.${key}`, entries, childInProvider);
    }
  }
}

/**
 * Core migration routine — pure and synchronous.
 *
 * @param {MigrateLegacyRequest} payload
 * @param {{
 *   settingsPath?: string,
 *   vaultPath?: string,
 *   safeStorage?: object|null
 * }} [opts] override paths (tests) and optional safeStorage injection (tests).
 * @returns {MigrateLegacyResult}
 */
function handleMigrateLegacy(payload, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const settingsPath =
    typeof options.settingsPath === 'string' && options.settingsPath.length > 0 ? options.settingsPath : undefined;
  const vaultPath =
    typeof options.vaultPath === 'string' && options.vaultPath.length > 0 ? options.vaultPath : undefined;

  // Inject a (test-only) safeStorage backend if requested; restore afterwards so
  // production callers / neighbouring tests are untouched.
  const injected = 'safeStorage' in options;
  if (injected) {
    vault.setSafeStorage(options.safeStorage != null ? options.safeStorage : null);
  }

  const legacySettings = coerceObject(payload && payload.settings);
  const legacyUsage = coerceObject(payload && payload.usage);

  // Best-effort shape normalization for common legacy layouts.
  if (legacySettings.providers && !legacySettings.api) {
    legacySettings.api = { providers: legacySettings.providers };
    delete legacySettings.providers;
  }
  if (legacyUsage && typeof legacyUsage === 'object') {
    legacySettings.api = legacySettings.api && typeof legacySettings.api === 'object' ? legacySettings.api : {};
    legacySettings.api.lastUsage = legacyUsage;
  }

  // Extract secrets → vault, replace with opaque refs in the settings object.
  const secretEntries = [];
  extractSecrets(legacySettings, 'settings', secretEntries, false);

  const hadSettingsFile = settingsPath ? fs.existsSync(settingsPath) : false;
  let prevSettingsRaw = null;
  if (hadSettingsFile) {
    try {
      prevSettingsRaw = fs.readFileSync(settingsPath, 'utf8');
    } catch {
      prevSettingsRaw = null;
    }
  }

  const vaultOpts = vaultPath ? { vaultPath } : undefined;
  const writtenVaultKeys = [];

  try {
    for (const { vaultKey, value } of secretEntries) {
      vault.storeSecret(vaultKey, value, vaultOpts);
      writtenVaultKeys.push(vaultKey);
    }

    const result = settingsStore.writeSettings(legacySettings, settingsPath ? { settingsPath } : undefined);
    const committed = JSON.stringify(result.settings, null, 2);
    const checksum = crypto.createHash('sha256').update(committed).digest('hex');

    return {
      ok: true,
      summary: {
        settingsPath: result.settingsPath,
        vaultPath: vaultPath || '',
        migratedKeys: writtenVaultKeys,
        checksum,
      },
    };
  } catch (err) {
    // Roll back: delete any secrets we committed and restore the settings file.
    for (const vaultKey of writtenVaultKeys) {
      try {
        vault.deleteSecret(vaultKey, vaultOpts);
      } catch {
        /* best-effort */
      }
    }
    if (settingsPath) {
      try {
        if (hadSettingsFile && prevSettingsRaw !== null) {
          fs.writeFileSync(settingsPath, prevSettingsRaw, 'utf8');
        } else if (!hadSettingsFile) {
          try {
            fs.unlinkSync(settingsPath);
          } catch {
            /* best-effort */
          }
        }
      } catch {
        /* best-effort */
      }
    }

    const errorCode = err && err.code === 'ENOENT' ? 'CORRUPT_DATA' : 'INTERNAL';
    return {
      ok: false,
      error: err && err.message ? String(err.message) : String(err),
      errorCode,
    };
  } finally {
    if (injected) {
      vault.setSafeStorage(null);
    }
  }
}

module.exports = { handleMigrateLegacy, coerceObject, extractSecrets };
