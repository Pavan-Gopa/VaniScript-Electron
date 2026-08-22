'use strict';

/**
 * BAT-01 — SQLite-backed batch domain.
 *
 * The module is intentionally Electron-free at import time.  Production uses
 * better-sqlite3 (rebuilt for Electron by the existing electron-rebuild tool),
 * while plain Node tests can use the same driver build or Node's node:sqlite
 * when the native ABI is unavailable.  The driver seam is limited to the
 * adapter below; domain mutations never depend on a renderer or on Electron's
 * app singleton except when resolving the default userData path.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { AppError, createAppError } = require('../../../shared/contracts/errors.ts');
const { assertSafePathSyntax } = require('./folderAccess.js');
const {
  BATCH_DB_SCHEMA_VERSION,
  BATCH_JOB_PHASES,
  BATCH_JOB_STATES,
  BATCH_SCHEMA_VERSION,
  validateBatchCheckpoint,
  validateBatchCheckpointInput,
  validateBatchEventInput,
  validateBatchEvent,
  validateBatchJob,
  validateBatchJobInput,
  validateBatchProfile,
  validateBatchProfileInput,
} = require('../../../shared/contracts/batch.ts');

const DEFAULT_MAX_ATTEMPTS = 3;
const BUSY_TIMEOUT_MS = 5000;
const BATCH_DB_FILENAME = 'batch.sqlite';

const ALLOWED_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['running', 'cancelled']),
  running: Object.freeze(['done', 'failed', 'cancelled']),
  done: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

const MIGRATIONS = Object.freeze({
  1: `
    CREATE TABLE IF NOT EXISTS folder_profiles (
      profile_id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      source_path TEXT NOT NULL,
      access_ref TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      recursive INTEGER NOT NULL DEFAULT 1 CHECK (recursive IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS batch_jobs (
      job_id TEXT PRIMARY KEY NOT NULL,
      profile_id TEXT NOT NULL REFERENCES folder_profiles(profile_id) ON DELETE CASCADE,
      source_path TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job_checkpoints (
      job_id TEXT NOT NULL REFERENCES batch_jobs(job_id) ON DELETE CASCADE,
      checkpoint_key TEXT NOT NULL,
      token TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (job_id, checkpoint_key)
    );

    CREATE TABLE IF NOT EXISTS job_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES batch_jobs(job_id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_batch_jobs_profile_state
      ON batch_jobs(profile_id, state, updated_at);
    CREATE INDEX IF NOT EXISTS idx_job_checkpoints_job
      ON job_checkpoints(job_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_job_events_job
      ON job_events(job_id, event_id);
  `,
  2: `
    ALTER TABLE folder_profiles ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE batch_jobs ADD COLUMN output_path TEXT;
    ALTER TABLE batch_jobs ADD COLUMN phase TEXT NOT NULL DEFAULT 'planning';
    ALTER TABLE batch_jobs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE batch_jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;
    ALTER TABLE batch_jobs ADD COLUMN progress REAL NOT NULL DEFAULT 0;
    ALTER TABLE batch_jobs ADD COLUMN config_snapshot_json TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE batch_jobs ADD COLUMN source_fingerprint_json TEXT;
    ALTER TABLE batch_jobs ADD COLUMN output_fingerprint TEXT;
    ALTER TABLE batch_jobs ADD COLUMN last_error TEXT;
    ALTER TABLE batch_jobs ADD COLUMN started_at TEXT;
    ALTER TABLE batch_jobs ADD COLUMN completed_at TEXT;

    CREATE INDEX IF NOT EXISTS idx_batch_jobs_state_updated
      ON batch_jobs(state, updated_at, job_id);
    CREATE TABLE IF NOT EXISTS watcher_generations (
      profile_id TEXT PRIMARY KEY NOT NULL REFERENCES folder_profiles(profile_id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK (generation > 0),
      updated_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS job_events_append_only_update
      BEFORE UPDATE ON job_events
      BEGIN
        SELECT RAISE(ABORT, 'job_events is append-only');
      END;
    CREATE TRIGGER IF NOT EXISTS job_events_append_only_delete
      BEFORE DELETE ON job_events
      BEGIN
        SELECT RAISE(ABORT, 'job_events is append-only');
      END;
  `,
});

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return crypto.randomUUID();
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function json(value, label) {
  try {
    return JSON.stringify(value === undefined ? {} : value);
  } catch (error) {
    throw createAppError('VALIDATION_FAILED', `${label} must be JSON-serializable.`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseJson(value, label, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    const parsed = JSON.parse(String(value));
    return parsed === null ? fallback : parsed;
  } catch (error) {
    throw createAppError('CORRUPT_DATA', `${label} contains invalid JSON.`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function requireId(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw createAppError('VALIDATION_FAILED', `${field} must be a non-empty string.`);
  }
  return value;
}

function boolInt(value) {
  return value ? 1 : 0;
}

function rowBool(value) {
  return Number(value) !== 0;
}

function rowsNumber(value) {
  if (typeof value === 'bigint') return Number(value);
  return Number(value || 0);
}

function normalizeSqlError(error, message) {
  if (error instanceof AppError) return error;
  const text = error && error.message ? String(error.message) : String(error);
  if (/constraint|unique|foreign key/i.test(text)) {
    return createAppError('CONFLICT', message || text, { cause: text });
  }
  return error;
}

/** better-sqlite3 adapter. */
function wrapBetterSqlite(raw) {
  return {
    kind: 'better-sqlite3',
    exec(sql) {
      raw.exec(sql);
    },
    prepare(sql) {
      const statement = raw.prepare(sql);
      return {
        run(...values) {
          return statement.run(...values);
        },
        get(...values) {
          return statement.get(...values);
        },
        all(...values) {
          return statement.all(...values);
        },
      };
    },
    transaction(fn) {
      return raw.transaction(fn)();
    },
    close() {
      raw.close();
    },
  };
}

/** Node 22+/26 node:sqlite adapter used when a native ABI cannot load. */
function wrapNodeSqlite(raw) {
  return {
    kind: 'node:sqlite',
    exec(sql) {
      raw.exec(sql);
    },
    prepare(sql) {
      const statement = raw.prepare(sql);
      return {
        run(...values) {
          return statement.run(...values);
        },
        get(...values) {
          return statement.get(...values);
        },
        all(...values) {
          return statement.all(...values);
        },
      };
    },
    transaction(fn) {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          raw.exec('ROLLBACK');
        } catch {
          // Preserve the original mutation error.
        }
        throw error;
      }
    },
    close() {
      raw.close();
    },
  };
}

function wrapInjectedDatabase(raw, kind = 'injected') {
  if (!raw || typeof raw.exec !== 'function' || typeof raw.prepare !== 'function') {
    throw createAppError('CAPABILITY_UNAVAILABLE', 'The injected batch database driver is invalid.');
  }
  if (typeof raw.transaction === 'function' && typeof raw.close === 'function') {
    return {
      kind,
      exec: (sql) => raw.exec(sql),
      prepare: (sql) => raw.prepare(sql),
      transaction: (fn) => {
        const result = raw.transaction(fn);
        return typeof result === 'function' ? result() : result;
      },
      close: () => raw.close(),
    };
  }
  throw createAppError(
    'CAPABILITY_UNAVAILABLE',
    'The injected batch database driver must expose exec, prepare, transaction, and close.',
  );
}

function getDefaultDbPath() {
  // Resolve Electron lazily so importing and testing this module under plain
  // Node never requires an Electron runtime.
  let electron;
  try {
    // eslint-disable-next-line global-require
    electron = require('electron');
  } catch (error) {
    throw createAppError('CAPABILITY_UNAVAILABLE', 'Electron app userData is unavailable outside Electron.', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!electron.app || typeof electron.app.getPath !== 'function') {
    throw createAppError('CAPABILITY_UNAVAILABLE', 'Electron app is not ready to resolve userData.');
  }
  return path.join(electron.app.getPath('userData'), 'batch', BATCH_DB_FILENAME);
}

function resolveDbPath(options) {
  if (options && typeof options.dbPath === 'string' && options.dbPath.length > 0) {
    return options.dbPath;
  }
  return getDefaultDbPath();
}

function openDatabase(dbPath, injectedDriver) {
  if (injectedDriver) {
    if (injectedDriver === 'better-sqlite3') {
      try {
        // eslint-disable-next-line global-require
        const BetterSqlite3 = require('better-sqlite3');
        return { adapter: wrapBetterSqlite(new BetterSqlite3(dbPath)), kind: 'better-sqlite3' };
      } catch (error) {
        throw createAppError('CAPABILITY_UNAVAILABLE', 'The requested better-sqlite3 driver could not be loaded.', {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (injectedDriver === 'node:sqlite') {
      try {
        // eslint-disable-next-line global-require
        const { DatabaseSync } = require('node:sqlite');
        return { adapter: wrapNodeSqlite(new DatabaseSync(dbPath)), kind: 'node:sqlite' };
      } catch (error) {
        throw createAppError('CAPABILITY_UNAVAILABLE', 'The requested node:sqlite driver could not be loaded.', {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (typeof injectedDriver === 'function') {
      return { adapter: wrapInjectedDatabase(injectedDriver(dbPath)), kind: 'injected' };
    }
    if (typeof injectedDriver.open === 'function') {
      return { adapter: wrapInjectedDatabase(injectedDriver.open(dbPath)), kind: 'injected' };
    }
    return { adapter: wrapInjectedDatabase(injectedDriver), kind: 'injected' };
  }

  if (dbPath !== ':memory:') {
    try {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    } catch (error) {
      throw createAppError('CORRUPT_DATA', `Cannot create batch database directory for ${dbPath}.`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let nativeLoadError = null;
  try {
    // eslint-disable-next-line global-require
    const BetterSqlite3 = require('better-sqlite3');
    return { adapter: wrapBetterSqlite(new BetterSqlite3(dbPath)), kind: 'better-sqlite3' };
  } catch (error) {
    nativeLoadError = error;
  }

  try {
    // Node 20 (Electron 34) intentionally has no node:sqlite; this branch is
    // for plain Node test runners and future runtimes with the built-in API.
    // eslint-disable-next-line global-require
    const { DatabaseSync } = require('node:sqlite');
    return { adapter: wrapNodeSqlite(new DatabaseSync(dbPath)), kind: 'node:sqlite' };
  } catch (builtinError) {
    throw createAppError(
      'CAPABILITY_UNAVAILABLE',
      'No SQLite driver is available. Install better-sqlite3 and run electron-rebuild.',
      {
        betterSqlite3: nativeLoadError && nativeLoadError.message,
        nodeSqlite: builtinError && builtinError.message,
      },
    );
  }
}

function configureDatabase(adapter) {
  adapter.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
  `);
}

function applyMigrations(adapter) {
  adapter.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const currentRow = adapter.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
  const current = currentRow && currentRow.version != null ? rowsNumber(currentRow.version) : 0;
  if (!Number.isInteger(current) || current < 0 || current > BATCH_DB_SCHEMA_VERSION) {
    throw createAppError('CORRUPT_DATA', `Unsupported batch schema version ${String(current)}.`);
  }

  for (let version = current + 1; version <= BATCH_DB_SCHEMA_VERSION; version += 1) {
    const sql = MIGRATIONS[version];
    if (!sql) throw createAppError('INTERNAL', `Missing batch migration ${version}.`);
    adapter.transaction(() => {
      adapter.exec(sql);
      adapter.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(version, nowIso());
    });
  }
  // D1 databases may already be marked v2 before BAT-02 added this table.
  // Keep that upgrade path idempotent without changing the serialized schema
  // version consumed by the existing D1 contract.
  adapter.exec(`
    CREATE TABLE IF NOT EXISTS watcher_generations (
      profile_id TEXT PRIMARY KEY NOT NULL REFERENCES folder_profiles(profile_id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK (generation > 0),
      updated_at TEXT NOT NULL
    );
  `);
}

function validateOrThrow(result) {
  if (!result.ok) throw result.error;
  return result.value;
}

function profileFromRow(row) {
  if (!row) return null;
  const value = {
    schemaVersion: BATCH_SCHEMA_VERSION,
    profileId: row.profile_id,
    name: row.name,
    sourcePath: row.source_path,
    accessRef: row.access_ref == null ? null : row.access_ref,
    enabled: rowBool(row.enabled),
    recursive: rowBool(row.recursive),
    config: parseJson(row.config_json, 'folder_profiles.config_json', {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return validateOrThrow(validateBatchProfile(value));
}

function fingerprintFromRow(row) {
  return parseJson(row.source_fingerprint_json, 'batch_jobs.source_fingerprint_json', null);
}

function jobFromRow(row) {
  if (!row) return null;
  const value = {
    schemaVersion: BATCH_SCHEMA_VERSION,
    jobId: row.job_id,
    profileId: row.profile_id,
    sourcePath: row.source_path,
    outputPath: row.output_path == null ? null : row.output_path,
    state: row.state,
    phase: row.phase,
    attempt: rowsNumber(row.attempt),
    maxAttempts: rowsNumber(row.max_attempts),
    progress: Number(row.progress),
    configSnapshot: parseJson(row.config_snapshot_json, 'batch_jobs.config_snapshot_json', {}),
    sourceFingerprint: fingerprintFromRow(row),
    outputFingerprint: row.output_fingerprint == null ? null : row.output_fingerprint,
    lastError: row.last_error == null ? null : row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at == null ? null : row.started_at,
    completedAt: row.completed_at == null ? null : row.completed_at,
  };
  return validateOrThrow(validateBatchJob(value));
}

function checkpointFromRow(row) {
  if (!row) return null;
  const value = {
    schemaVersion: BATCH_SCHEMA_VERSION,
    jobId: row.job_id,
    checkpointKey: row.checkpoint_key,
    token: row.token,
    metadata: parseJson(row.metadata_json, 'job_checkpoints.metadata_json', {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return validateOrThrow(validateBatchCheckpoint(value));
}

function eventFromRow(row) {
  if (!row) return null;
  const value = {
    schemaVersion: BATCH_SCHEMA_VERSION,
    eventId: rowsNumber(row.event_id),
    jobId: row.job_id,
    eventType: row.event_type,
    payload: parseJson(row.payload_json, 'job_events.payload_json', {}),
    createdAt: row.created_at,
  };
  return validateOrThrow(validateBatchEvent(value));
}

function assertPlainRecord(value, field) {
  if (!isPlainObject(value)) throw createAppError('VALIDATION_FAILED', `${field} must be an object.`);
  json(value, field);
  return value;
}

function validateLimit(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 10000) {
    throw createAppError('VALIDATION_FAILED', 'limit must be an integer between 1 and 10000.');
  }
  return value;
}

function validateOffset(value) {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw createAppError('VALIDATION_FAILED', 'offset must be a non-negative integer.');
  }
  return value;
}

class BatchDomain {
  constructor(options = {}) {
    if (!isPlainObject(options)) options = {};
    this.dbPath = resolveDbPath(options);
    const opened = openDatabase(this.dbPath, options.driver);
    this.driverKind = opened.kind;
    this._db = opened.adapter;
    this._closed = false;
    this._failureInjector = typeof options.failureInjector === 'function' ? options.failureInjector : null;
    try {
      configureDatabase(this._db);
      applyMigrations(this._db);
    } catch (error) {
      try {
        this._db.close();
      } catch {
        // Preserve the migration error.
      }
      throw normalizeSqlError(error, 'Batch database migration failed.');
    }
  }

  _assertOpen() {
    if (this._closed) throw createAppError('CONFLICT', 'Batch database is closed.');
  }

  _inject(point, context) {
    if (this._failureInjector) this._failureInjector(point, context);
  }

  _transaction(fn) {
    this._assertOpen();
    return this._db.transaction(fn);
  }

  _runMutation(fn, message) {
    try {
      return this._transaction(fn);
    } catch (error) {
      const normalized = normalizeSqlError(error, message);
      if (normalized instanceof Error) throw normalized;
      throw error;
    }
  }

  setFailureInjector(injector) {
    if (injector !== null && injector !== undefined && typeof injector !== 'function') {
      throw createAppError('VALIDATION_FAILED', 'failureInjector must be a function or null.');
    }
    this._failureInjector = injector || null;
    return this;
  }

  getSchemaVersion() {
    this._assertOpen();
    const row = this._db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
    return row && row.version != null ? rowsNumber(row.version) : 0;
  }

  getSchemaMigrations() {
    this._assertOpen();
    return this._db
      .prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version ASC')
      .all()
      .map((row) => ({ version: rowsNumber(row.version), appliedAt: row.applied_at }));
  }

  journalMode() {
    this._assertOpen();
    const row = this._db.prepare('PRAGMA journal_mode').get();
    if (!row) return null;
    const key = Object.keys(row)[0];
    return key ? String(row[key]).toLowerCase() : null;
  }

  createProfile(input) {
    const validated = validateOrThrow(validateBatchProfileInput(input));
    const profileId = validated.profileId || newId();
    const createdAt = nowIso();
    const profile = validateOrThrow(validateBatchProfile({
      schemaVersion: BATCH_SCHEMA_VERSION,
      profileId,
      name: validated.name,
      sourcePath: assertSafePathSyntax(validated.sourcePath, 'profile.sourcePath'),
      accessRef: validated.accessRef === undefined ? null : validated.accessRef,
      enabled: validated.enabled === undefined ? true : validated.enabled,
      recursive: validated.recursive === undefined ? true : validated.recursive,
      config: validated.config || {},
      createdAt,
      updatedAt: createdAt,
    }));

    return this._runMutation(() => {
      try {
        this._db.prepare(`
          INSERT INTO folder_profiles(
            profile_id, name, source_path, access_ref, enabled, recursive,
            config_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          profile.profileId,
          profile.name,
          profile.sourcePath,
          profile.accessRef,
          boolInt(profile.enabled),
          boolInt(profile.recursive),
          json(profile.config, 'profile.config'),
          profile.createdAt,
          profile.updatedAt,
        );
        this._inject('profile:after-insert', profile);
        return profileFromRow(this._db.prepare('SELECT * FROM folder_profiles WHERE profile_id = ?').get(profile.profileId));
      } catch (error) {
        throw normalizeSqlError(error, `Profile "${profile.profileId}" already exists.`);
      }
    }, 'Batch profile creation failed.');
  }

  getProfile(profileId) {
    requireId(profileId, 'profileId');
    this._assertOpen();
    const row = this._db.prepare('SELECT * FROM folder_profiles WHERE profile_id = ?').get(profileId);
    if (!row) throw createAppError('NOT_FOUND', `Batch profile "${profileId}" not found.`, { profileId });
    return profileFromRow(row);
  }

  listProfiles(options = {}) {
    if (!isPlainObject(options)) throw createAppError('VALIDATION_FAILED', 'profile list options must be an object.');
    const limit = validateLimit(options.limit, 1000);
    const offset = validateOffset(options.offset);
    this._assertOpen();
    if (options.enabled !== undefined && typeof options.enabled !== 'boolean') {
      throw createAppError('VALIDATION_FAILED', 'enabled filter must be boolean.');
    }
    const where = options.enabled === undefined ? '' : 'WHERE enabled = ?';
    const values = options.enabled === undefined ? [limit, offset] : [boolInt(options.enabled), limit, offset];
    const rows = this._db
      .prepare(`SELECT * FROM folder_profiles ${where} ORDER BY created_at ASC, profile_id ASC LIMIT ? OFFSET ?`)
      .all(...values);
    return rows.map(profileFromRow);
  }
  recordWatcherGeneration(profileId, generation) {
    requireId(profileId, 'profileId');
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw createAppError('VALIDATION_FAILED', 'watcher generation must be a positive safe integer.');
    }
    return this._runMutation(() => {
      const profile = this._db.prepare('SELECT profile_id FROM folder_profiles WHERE profile_id = ?').get(profileId);
      if (!profile) throw createAppError('NOT_FOUND', `Batch profile "${profileId}" not found.`, { profileId });
      const updatedAt = nowIso();
      this._db.prepare(`
        INSERT INTO watcher_generations(profile_id, generation, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(profile_id) DO UPDATE SET generation = excluded.generation, updated_at = excluded.updated_at
      `).run(profileId, generation, updatedAt);
      return { profileId, generation, updatedAt };
    }, 'Watcher generation update failed.');
  }

  getWatcherGeneration(profileId) {
    requireId(profileId, 'profileId');
    this._assertOpen();
    const row = this._db.prepare(`
      SELECT profile_id, generation, updated_at
      FROM watcher_generations
      WHERE profile_id = ?
    `).get(profileId);
    if (!row) return null;
    return { profileId: row.profile_id, generation: rowsNumber(row.generation), updatedAt: row.updated_at };
  }

  listWatcherGenerations() {
    this._assertOpen();
    return this._db
      .prepare('SELECT profile_id, generation, updated_at FROM watcher_generations ORDER BY profile_id ASC')
      .all()
      .map((row) => ({ profileId: row.profile_id, generation: rowsNumber(row.generation), updatedAt: row.updated_at }));
  }


  updateProfile(profileId, patch) {
    requireId(profileId, 'profileId');
    if (!isPlainObject(patch)) throw createAppError('VALIDATION_FAILED', 'profile patch must be an object.');
    const allowed = ['name', 'sourcePath', 'accessRef', 'enabled', 'recursive', 'config'];
    for (const key of Object.keys(patch)) {
      if (!allowed.includes(key)) throw createAppError('VALIDATION_FAILED', `Unsupported profile field "${key}".`);
    }

    return this._runMutation(() => {
      const existing = this._db.prepare('SELECT * FROM folder_profiles WHERE profile_id = ?').get(profileId);
      if (!existing) throw createAppError('NOT_FOUND', `Batch profile "${profileId}" not found.`, { profileId });
      const current = profileFromRow(existing);
      const sourcePath = assertSafePathSyntax(
        patch.sourcePath === undefined ? current.sourcePath : patch.sourcePath,
        'profile.sourcePath',
      );
      const candidate = validateOrThrow(validateBatchProfile({
        ...current,
        name: patch.name === undefined ? current.name : patch.name,
        sourcePath,
        accessRef: patch.accessRef === undefined ? current.accessRef : patch.accessRef,
        enabled: patch.enabled === undefined ? current.enabled : patch.enabled,
        recursive: patch.recursive === undefined ? current.recursive : patch.recursive,
        config: patch.config === undefined ? current.config : patch.config,
        updatedAt: nowIso(),
      }));
      this._db.prepare(`
        UPDATE folder_profiles
        SET name = ?, source_path = ?, access_ref = ?, enabled = ?, recursive = ?,
            config_json = ?, updated_at = ?
        WHERE profile_id = ?
      `).run(
        candidate.name,
        candidate.sourcePath,
        candidate.accessRef,
        boolInt(candidate.enabled),
        boolInt(candidate.recursive),
        json(candidate.config, 'profile.config'),
        candidate.updatedAt,
        profileId,
      );
      this._inject('profile:after-update', candidate);
      return profileFromRow(this._db.prepare('SELECT * FROM folder_profiles WHERE profile_id = ?').get(profileId));
    }, 'Batch profile update failed.');
  }

  deleteProfile(profileId) {
    requireId(profileId, 'profileId');
    return this._runMutation(() => {
      const existing = this._db.prepare('SELECT profile_id FROM folder_profiles WHERE profile_id = ?').get(profileId);
      if (!existing) throw createAppError('NOT_FOUND', `Batch profile "${profileId}" not found.`, { profileId });
      const jobs = this._db.prepare('SELECT COUNT(*) AS count FROM batch_jobs WHERE profile_id = ?').get(profileId);
      if (rowsNumber(jobs && jobs.count) > 0) {
        throw createAppError('CONFLICT', `Batch profile "${profileId}" has queued jobs and cannot be deleted.`, { profileId });
      }
      this._db.prepare('DELETE FROM folder_profiles WHERE profile_id = ?').run(profileId);
      this._inject('profile:after-delete', { profileId });
      return true;
    }, 'Batch profile deletion failed.');
  }

  _prepareJob(input) {
    const validated = validateOrThrow(validateBatchJobInput(input));
    const sourcePath = assertSafePathSyntax(validated.sourcePath, 'job.sourcePath');
    const outputPath = validated.outputPath === undefined || validated.outputPath === null
      ? null
      : assertSafePathSyntax(validated.outputPath, 'job.outputPath');
    const jobId = validated.jobId || newId();
    const createdAt = nowIso();
    return validateOrThrow(validateBatchJob({
      schemaVersion: BATCH_SCHEMA_VERSION,
      jobId,
      profileId: validated.profileId,
      sourcePath,
      outputPath,
      state: 'pending',
      phase: 'planning',
      attempt: 0,
      maxAttempts: validated.maxAttempts || DEFAULT_MAX_ATTEMPTS,
      progress: 0,
      configSnapshot: validated.configSnapshot || {},
      sourceFingerprint: validated.sourceFingerprint || null,
      outputFingerprint: null,
      lastError: null,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      completedAt: null,
    }));
  }

  _insertJob(job) {
    const profile = this._db.prepare('SELECT profile_id FROM folder_profiles WHERE profile_id = ?').get(job.profileId);
    if (!profile) throw createAppError('NOT_FOUND', `Batch profile "${job.profileId}" not found.`, { profileId: job.profileId });
    try {
      this._db.prepare(`
        INSERT INTO batch_jobs(
          job_id, profile_id, source_path, output_path, state, phase, attempt,
          max_attempts, progress, config_snapshot_json, source_fingerprint_json,
          output_fingerprint, last_error, started_at, completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        job.jobId,
        job.profileId,
        job.sourcePath,
        job.outputPath,
        job.state,
        job.phase,
        job.attempt,
        job.maxAttempts,
        job.progress,
        json(job.configSnapshot, 'job.configSnapshot'),
        job.sourceFingerprint === null ? null : json(job.sourceFingerprint, 'job.sourceFingerprint'),
        job.outputFingerprint,
        job.lastError,
        job.startedAt,
        job.completedAt,
        job.createdAt,
        job.updatedAt,
      );
    } catch (error) {
      throw normalizeSqlError(error, `Batch job "${job.jobId}" already exists.`);
    }
    this._inject('job:after-insert', job);
    this._insertEvent(job.jobId, 'job.enqueued', { state: job.state }, job.createdAt);
    return jobFromRow(this._db.prepare('SELECT * FROM batch_jobs WHERE job_id = ?').get(job.jobId));
  }

  enqueueJob(input) {
    const job = this._prepareJob(input);
    return this._runMutation(() => this._insertJob(job), 'Batch job enqueue failed.');
  }

  /**
   * Insert a source job only when this profile has not seen the same complete
   * source fingerprint. Same-content files in one profile intentionally share
   * one job (the D2 adjudication); each candidate still keeps its canonical
   * sourcePath and watcher relativePath until this dedupe decision, while
   * identical content across profiles remains independent.
   */
  enqueueJobIfFingerprintMissing(input) {
    const job = this._prepareJob(input);
    return this._runMutation(() => {
      if (job.sourceFingerprint !== null) {
        const fingerprintJson = json(job.sourceFingerprint, 'job.sourceFingerprint');
        const existing = this._db.prepare(`
          SELECT * FROM batch_jobs
          WHERE profile_id = ? AND source_fingerprint_json = ?
          ORDER BY created_at ASC, job_id ASC
          LIMIT 1
        `).get(job.profileId, fingerprintJson);
        if (existing) return { inserted: false, job: jobFromRow(existing) };
      }
      return { inserted: true, job: this._insertJob(job) };
    }, 'Batch deduplicated job enqueue failed.');
  }

  getJob(jobId) {
    requireId(jobId, 'jobId');
    this._assertOpen();
    const row = this._db.prepare('SELECT * FROM batch_jobs WHERE job_id = ?').get(jobId);
    if (!row) throw createAppError('NOT_FOUND', `Batch job "${jobId}" not found.`, { jobId });
    return jobFromRow(row);
  }

  listJobs(options = {}) {
    if (!isPlainObject(options)) throw createAppError('VALIDATION_FAILED', 'job list options must be an object.');
    const limit = validateLimit(options.limit, 1000);
    const offset = validateOffset(options.offset);
    if (options.state !== undefined && !BATCH_JOB_STATES.includes(options.state)) {
      throw createAppError('VALIDATION_FAILED', 'state filter is not supported.');
    }
    if (options.profileId !== undefined) requireId(options.profileId, 'profileId');
    this._assertOpen();
    const clauses = [];
    const values = [];
    if (options.state !== undefined) {
      clauses.push('state = ?');
      values.push(options.state);
    }
    if (options.profileId !== undefined) {
      clauses.push('profile_id = ?');
      values.push(options.profileId);
    }
    values.push(limit, offset);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this._db
      .prepare(`SELECT * FROM batch_jobs ${where} ORDER BY created_at ASC, job_id ASC LIMIT ? OFFSET ?`)
      .all(...values);
    return rows.map(jobFromRow);
  }

  transitionJob(jobId, nextState, details = {}) {
    requireId(jobId, 'jobId');
    if (!BATCH_JOB_STATES.includes(nextState)) {
      throw createAppError('VALIDATION_FAILED', `Unsupported batch job state "${String(nextState)}".`);
    }
    if (!isPlainObject(details)) throw createAppError('VALIDATION_FAILED', 'transition details must be an object.');
    const allowedDetailKeys = ['phase', 'progress', 'error', 'outputFingerprint'];
    for (const key of Object.keys(details)) {
      if (!allowedDetailKeys.includes(key)) throw createAppError('VALIDATION_FAILED', `Unsupported transition field "${key}".`);
    }
    if (details.phase !== undefined && !BATCH_JOB_PHASES.includes(details.phase)) {
      throw createAppError('VALIDATION_FAILED', 'transition phase is not supported.');
    }
    if (details.progress !== undefined && (typeof details.progress !== 'number' || !Number.isFinite(details.progress) || details.progress < 0 || details.progress > 1)) {
      throw createAppError('VALIDATION_FAILED', 'transition progress must be between 0 and 1.');
    }
    if (details.outputFingerprint !== undefined && (typeof details.outputFingerprint !== 'string' || details.outputFingerprint.length === 0)) {
      throw createAppError('VALIDATION_FAILED', 'transition outputFingerprint must be a non-empty string.');
    }

    return this._runMutation(() => {
      const row = this._db.prepare('SELECT * FROM batch_jobs WHERE job_id = ?').get(jobId);
      if (!row) throw createAppError('NOT_FOUND', `Batch job "${jobId}" not found.`, { jobId });
      const current = jobFromRow(row);
      if (!ALLOWED_TRANSITIONS[current.state].includes(nextState)) {
        throw createAppError('CONFLICT', `Cannot transition batch job "${jobId}" from ${current.state} to ${nextState}.`, {
          jobId,
          from: current.state,
          to: nextState,
        });
      }
      if (nextState === 'failed' && (typeof details.error !== 'string' || details.error.length === 0)) {
        throw createAppError('VALIDATION_FAILED', 'A failed job requires a non-empty error.');
      }
      if (details.error !== undefined && (typeof details.error !== 'string' || details.error.length === 0)) {
        throw createAppError('VALIDATION_FAILED', 'transition error must be a non-empty string.');
      }

      const updatedAt = nowIso();
      const next = {
        ...current,
        state: nextState,
        phase: details.phase === undefined ? current.phase : details.phase,
        progress: details.progress === undefined ? current.progress : details.progress,
        outputFingerprint: details.outputFingerprint === undefined ? current.outputFingerprint : details.outputFingerprint,
        lastError: nextState === 'failed'
          ? details.error
          : nextState === 'running' || nextState === 'done' || nextState === 'cancelled'
            ? null
            : current.lastError,
        attempt: nextState === 'running' ? current.attempt + 1 : current.attempt,
        startedAt: nextState === 'running' ? updatedAt : current.startedAt,
        completedAt: ['done', 'failed', 'cancelled'].includes(nextState) ? updatedAt : null,
        updatedAt,
      };
      if (nextState === 'done') next.progress = 1;
      const validatedNext = validateOrThrow(validateBatchJob(next));
      this._db.prepare(`
        UPDATE batch_jobs
        SET state = ?, phase = ?, attempt = ?, progress = ?, output_fingerprint = ?,
            last_error = ?, started_at = ?, completed_at = ?, updated_at = ?
        WHERE job_id = ?
      `).run(
        validatedNext.state,
        validatedNext.phase,
        validatedNext.attempt,
        validatedNext.progress,
        validatedNext.outputFingerprint,
        validatedNext.lastError,
        validatedNext.startedAt,
        validatedNext.completedAt,
        validatedNext.updatedAt,
        jobId,
      );
      this._inject('job:after-state-update', { before: current, after: validatedNext });
      this._insertEvent(jobId, 'job.stateChanged', {
        from: current.state,
        to: validatedNext.state,
        attempt: validatedNext.attempt,
        ...(validatedNext.lastError ? { error: validatedNext.lastError } : {}),
      }, updatedAt);
      return jobFromRow(this._db.prepare('SELECT * FROM batch_jobs WHERE job_id = ?').get(jobId));
    }, 'Batch job state transition failed.');
  }

  startJob(jobId, details = {}) {
    return this.transitionJob(jobId, 'running', details);
  }

  completeJob(jobId, details = {}) {
    return this.transitionJob(jobId, 'done', details);
  }

  failJob(jobId, error) {
    return this.transitionJob(jobId, 'failed', { error });
  }

  cancelJob(jobId) {
    return this.transitionJob(jobId, 'cancelled');
  }

  _insertEvent(jobId, eventType, payload, createdAt = nowIso()) {
    const idResult = this._db.prepare(`
      INSERT INTO job_events(job_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(jobId, eventType, json(payload, 'event.payload'), createdAt);
    const eventId = rowsNumber(idResult && idResult.lastInsertRowid);
    return eventFromRow(this._db.prepare('SELECT * FROM job_events WHERE event_id = ?').get(eventId));
  }

  appendEvent(jobId, input) {
    requireId(jobId, 'jobId');
    const validated = validateOrThrow(validateBatchEventInput(input));
    const eventType = validated.eventType;
    const payload = validated.payload;

    return this._runMutation(() => {
      const job = this._db.prepare('SELECT job_id FROM batch_jobs WHERE job_id = ?').get(jobId);
      if (!job) throw createAppError('NOT_FOUND', `Batch job "${jobId}" not found.`, { jobId });
      const event = this._insertEvent(jobId, eventType, payload);
      this._inject('event:after-insert', event);
      return event;
    }, 'Batch event append failed.');
  }

  listEvents(jobId, options = {}) {
    requireId(jobId, 'jobId');
    if (!isPlainObject(options)) throw createAppError('VALIDATION_FAILED', 'event list options must be an object.');
    const limit = validateLimit(options.limit, 1000);
    if (options.afterEventId !== undefined && (!Number.isInteger(options.afterEventId) || options.afterEventId < 0)) {
      throw createAppError('VALIDATION_FAILED', 'afterEventId must be a non-negative integer.');
    }
    this.getJob(jobId);
    const afterEventId = options.afterEventId === undefined ? 0 : options.afterEventId;
    const rows = this._db.prepare(`
      SELECT * FROM job_events
      WHERE job_id = ? AND event_id > ?
      ORDER BY event_id ASC
      LIMIT ?
    `).all(jobId, afterEventId, limit);
    return rows.map(eventFromRow);
  }

  saveCheckpoint(jobId, input, token, metadata) {
    requireId(jobId, 'jobId');
    const candidate = typeof input === 'string'
      ? { checkpointKey: input, token, metadata }
      : input;
    const validated = validateOrThrow(validateBatchCheckpointInput(candidate));

    return this._runMutation(() => {
      const job = this._db.prepare('SELECT job_id FROM batch_jobs WHERE job_id = ?').get(jobId);
      if (!job) throw createAppError('NOT_FOUND', `Batch job "${jobId}" not found.`, { jobId });
      const existing = this._db.prepare(`
        SELECT * FROM job_checkpoints WHERE job_id = ? AND checkpoint_key = ?
      `).get(jobId, validated.checkpointKey);
      const updatedAt = nowIso();
      if (existing) {
        this._db.prepare(`
          UPDATE job_checkpoints
          SET token = ?, metadata_json = ?, updated_at = ?
          WHERE job_id = ? AND checkpoint_key = ?
        `).run(
          validated.token,
          json(validated.metadata, 'checkpoint.metadata'),
          updatedAt,
          jobId,
          validated.checkpointKey,
        );
      } else {
        this._db.prepare(`
          INSERT INTO job_checkpoints(job_id, checkpoint_key, token, metadata_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          jobId,
          validated.checkpointKey,
          validated.token,
          json(validated.metadata, 'checkpoint.metadata'),
          updatedAt,
          updatedAt,
        );
      }
      const checkpoint = checkpointFromRow(this._db.prepare(`
        SELECT * FROM job_checkpoints WHERE job_id = ? AND checkpoint_key = ?
      `).get(jobId, validated.checkpointKey));
      this._inject('checkpoint:after-write', checkpoint);
      this._insertEvent(jobId, 'job.checkpointSaved', {
        checkpointKey: checkpoint.checkpointKey,
      }, updatedAt);
      return checkpoint;
    }, 'Batch checkpoint save failed.');
  }

  getCheckpoint(jobId, checkpointKey = 'default') {
    requireId(jobId, 'jobId');
    requireId(checkpointKey, 'checkpointKey');
    this._assertOpen();
    const row = this._db.prepare(`
      SELECT * FROM job_checkpoints WHERE job_id = ? AND checkpoint_key = ?
    `).get(jobId, checkpointKey);
    return checkpointFromRow(row);
  }

  listCheckpoints(jobId) {
    requireId(jobId, 'jobId');
    this.getJob(jobId);
    return this._db
      .prepare('SELECT * FROM job_checkpoints WHERE job_id = ? ORDER BY updated_at ASC, checkpoint_key ASC')
      .all(jobId)
      .map(checkpointFromRow);
  }

  close() {
    if (this._closed) return;
    this._db.close();
    this._closed = true;
  }
}

function createBatchDomain(options) {
  return new BatchDomain(options);
}

module.exports = {
  ALLOWED_TRANSITIONS,
  BATCH_DB_FILENAME,
  BATCH_DB_SCHEMA_VERSION,
  BatchDomain,
  createBatchDomain,
  getDefaultDbPath,
};
