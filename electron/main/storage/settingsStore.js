'use strict';

/**
 * Main-process settings disk store.
 *
 * Responsibilities:
 *  - Read settings from `<userData>/settings/settings.json` (or an injected path).
 *  - Fall back to canonical defaults when the file is missing, unreadable, or
 *    corrupted (invalid JSON), backing up the bad file to a `Corrupt/` dir.
 *  - Write settings atomically: a temp file is fully written + fsync'd, then
 *    renamed over the target (rename is atomic on the same filesystem).
 *
 * This module is intentionally free of any top-level `require('electron')`,
 * so it can be unit-tested under plain `node --test`. Electron is required
 * lazily (and only) when no explicit `settingsPath` is supplied.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  SETTINGS_SCHEMA_VERSION,
  createDefaultSettings,
  migrateSettings,
} = require('../../../shared/contracts/settings.ts');

const SETTINGS_FILENAME = 'settings.json';
const CORRUPT_DIRNAME = 'Corrupt';
const TMP_PREFIX = '.tmp';

/**
 * Resolve the default on-disk settings path using the running Electron app.
 * Lazily required so importing this module in a plain-Node test never touches
 * Electron internals.
 */
function getDefaultSettingsPath() {
  // eslint-disable-next-line global-require
  const electron = require('electron');
  const userData = electron.app.getPath('userData');
  return path.join(userData, 'settings', SETTINGS_FILENAME);
}

function resolveOptions(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const settingsPath =
    typeof options.settingsPath === 'string' && options.settingsPath.length > 0
      ? options.settingsPath
      : getDefaultSettingsPath();
  const corruptDir =
    typeof options.corruptDir === 'string' && options.corruptDir.length > 0
      ? options.corruptDir
      : path.join(path.dirname(settingsPath), CORRUPT_DIRNAME);
  return { settingsPath, corruptDir };
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/**
 * Move a corrupted settings file aside so it can be inspected and the app can
 * still launch from defaults. Best-effort: any failure is swallowed.
 */
function backupCorruptFile(filePath, corruptDir) {
  if (!fileExists(filePath)) return false;
  try {
    ensureParentDir(path.join(corruptDir, 'placeholder.tmp'));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(corruptDir, `settings.${stamp}.json`);
    fs.renameSync(filePath, dest);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically write `content` to `filePath`:
 *   1. ensure parent dir exists
 *   2. write to a unique temp file in the same directory
 *   3. fsync the temp file so the bytes are durable
 *   4. rename the temp file over the target (atomic on POSIX/Windows NTFS)
 * The temp file is always cleaned up; a crash between 3 and 4 leaves only the
 * harmless temp file, never a half-written target.
 */
function atomicWriteString(filePath, content) {
  ensureParentDir(filePath);
  const tmpPath = `${filePath}.pid${process.pid}.${Date.now()}${TMP_PREFIX}`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8' });
    const fd = fs.openSync(tmpPath, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fileExists(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

/**
 * Read settings from disk.
 *
 * @returns {{
 *   settings: import('../../shared/contracts/settings.ts').Settings,
 *   source: 'defaults' | 'file' | 'migrated',
 *   recovered: boolean,
 *   fromVersion: number,
 *   migrated: boolean,
 * }} `recovered` is true when a missing/unreadable/corrupt file forced a
 * fallback to defaults.
 */
function readSettings(opts) {
  const { settingsPath, corruptDir } = resolveOptions(opts);

  if (!fileExists(settingsPath)) {
    return {
      settings: createDefaultSettings(),
      source: 'defaults',
      recovered: false,
      fromVersion: 0,
      migrated: false,
    };
  }

  let rawText;
  try {
    rawText = fs.readFileSync(settingsPath, 'utf8');
  } catch {
    backupCorruptFile(settingsPath, corruptDir);
    return {
      settings: createDefaultSettings(),
      source: 'defaults',
      recovered: true,
      fromVersion: 0,
      migrated: false,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    backupCorruptFile(settingsPath, corruptDir);
    return {
      settings: createDefaultSettings(),
      source: 'defaults',
      recovered: true,
      fromVersion: 0,
      migrated: false,
    };
  }

  const { settings, migrated, fromVersion } = migrateSettings(parsed);
  return {
    settings,
    source: migrated ? 'migrated' : 'file',
    recovered: false,
    fromVersion,
    migrated,
  };
}

/**
 * Persist settings atomically. The payload is run through migration/normalize
 * so the on-disk document is always canonical (current schema version, all
 * defaults present). Never persists plaintext secrets — provider keys are
 * stored only as opaque `keyRef` references.
 *
 * @returns {{ settingsPath: string, settings: object }}
 */
function writeSettings(settings, opts) {
  const { settingsPath } = resolveOptions(opts);
  const { settings: normalized } = migrateSettings(settings);
  atomicWriteString(settingsPath, JSON.stringify(normalized, null, 2));
  return { settingsPath, settings: normalized };
}

module.exports = {
  SETTINGS_FILENAME,
  CORRUPT_DIRNAME,
  getDefaultSettingsPath,
  readSettings,
  writeSettings,
  atomicWriteString,
  SETTINGS_SCHEMA_VERSION,
};
