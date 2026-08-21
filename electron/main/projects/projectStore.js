'use strict';

/**
 * Atomic, revision-guarded project store (VaniScript Electron Migration Plan
 * §6.1 + P2/PROJ-02).
 *
 * Responsibilities:
 *   - Persist a strict `ProjectV3` to
 *     `<baseDir>/<projectId>/project.json` (one directory per project, exactly
 *     as section 6.1 lays out: `projects/<project-id>/project.json`).
 *   - Validate every payload through the shared `validateProjectV3` contract
 *     before it touches disk, so only canonical v3 documents are persisted.
 *   - Enforce optimistic concurrency: `saveProject(project, expectedRevision)`
 *     refuses to overwrite when `expectedRevision` does not match the revision
 *     currently on disk, throwing an `AppError` with code `CONFLICT`.
 *   - Write atomically via a unique temp file + fsync + rename, so a crash
 *     mid-write leaves at most a harmless temp file, never a half-written
 *     `project.json`.
 *
 * Testability: the on-disk root is injectable via `{ baseDir }`. When omitted,
 * the real Electron `userData/projects` path is resolved lazily, so importing
 * this module under plain Node (tests) never requires the `electron` runtime.
 */

const fs = require('node:fs');
const path = require('node:path');

const { AppError, createAppError } = require('../../../shared/contracts/errors.ts');
const { validateProjectV3 } = require('../../../shared/contracts/projects.ts');

const TMP_SUFFIX = '.tmp';
/** Allowed characters for a project directory segment (no path separators). */
const PROJECT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

let revisionSeq = 0;

/**
 * Resolve the default store root from the running Electron app. Lazily required
 * so importing this module in a plain-Node test never touches Electron internals.
 */
function getDefaultBaseDir() {
  // eslint-disable-next-line global-require
  const electron = require('electron');
  return path.join(electron.app.getPath('userData'), 'projects');
}

/** Reject path-traversal / unsafe project ids before building a path. */
function sanitizeProjectId(projectId) {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw createAppError('VALIDATION_FAILED', 'projectId must be a non-empty string.');
  }
  if (!PROJECT_ID_PATTERN.test(projectId) || projectId.includes('..')) {
    throw createAppError(
      'VALIDATION_FAILED',
      `Invalid projectId "${projectId}": only A-Za-z0-9 . _ - are allowed and ".." is forbidden.`,
    );
  }
  return projectId;
}

function projectPath(baseDir, projectId) {
  return path.join(baseDir, sanitizeProjectId(projectId), 'project.json');
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
 * Read only the persisted revision of an existing project file. Returns
 * `{ revision: null }` when the file is absent or unreadable, so a save can
 * recreate/correct a missing or corrupt file (collision/recovery path).
 */
function readRevision(filePath) {
  if (!fileExists(filePath)) return { revision: null };
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { revision: null };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.revision === 'string') {
      return { revision: parsed.revision };
    }
    return { revision: null };
  } catch {
    return { revision: null };
  }
}

/**
 * Enforce optimistic concurrency.
 *   - `expectedRevision` provided: the on-disk revision must equal it
 *     (rejects both stale updates and writes against a non-existent project).
 *   - `expectedRevision` omitted/null: creation intent — rejected when a
 *     project already exists, so nothing is silently overwritten.
 */
function enforceRevision(expectedRevision, currentRevision, projectId) {
  if (expectedRevision != null) {
    if (currentRevision !== expectedRevision) {
      throw createAppError(
        'CONFLICT',
        `Revision conflict for project "${projectId}": expected "${expectedRevision}" but found "${currentRevision ?? 'none'}"`,
        { expectedRevision, currentRevision },
      );
    }
    return;
  }
  if (currentRevision != null) {
    throw createAppError(
      'CONFLICT',
      `Project "${projectId}" already exists; pass its current revision to overwrite.`,
      { currentRevision },
    );
  }
}

/** Monotonically increasing, process-unique revision token. */
function generateRevision() {
  revisionSeq += 1;
  return `${Date.now().toString(36)}-${revisionSeq.toString(36)}`;
}

/**
 * Write `content` to a unique temp file in the target's directory and fsync it.
 * The caller renames the returned path to commit (atomic on POSIX/NTFS).
 *
 * @returns {string} the temp file path.
 */
function writeTempAtomic(filePath, content) {
  ensureParentDir(filePath);
  const tmpPath = `${filePath}.pid${process.pid}.${Date.now()}${TMP_SUFFIX}`;
  fs.writeFileSync(tmpPath, content, { encoding: 'utf8' });
  const fd = fs.openSync(tmpPath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return tmpPath;
}

/** Remove a temp file best-effort (used on abort/cleanup). */
function cleanupTemp(tmpPath) {
  try {
    if (tmpPath && fileExists(tmpPath)) fs.unlinkSync(tmpPath);
  } catch {
    /* ignore cleanup failure */
  }
}

/**
 * Atomic, revision-guarded project store.
 */
class ProjectStore {
  /**
   * @param {{ baseDir?: string }} [options] Injected store root. When omitted,
   * the real `userData/projects` path is resolved lazily from Electron.
   */
  constructor(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    this.baseDir = (typeof opts.baseDir === 'string' && opts.baseDir.length > 0)
      ? opts.baseDir
      : null;
  }

  /** Lazily resolve the store root; never touches Electron on import. */
  baseDirPath() {
    return this.baseDir != null ? this.baseDir : getDefaultBaseDir();
  }

  /**
   * Persist a v3 project atomically with optimistic concurrency.
   *
   * @param {unknown} project A `ProjectV3` (or structurally compatible) payload.
   * @param {string|null|undefined} expectedRevision The revision the caller
   *   believes is current. Omit/use null to create a new project (rejected if
   *   one already exists).
   * @returns {import('../../../shared/contracts/projects.ts').ProjectV3} the
   *   saved, normalized project carrying a freshly generated `revision`.
   * @throws {AppError} code `VALIDATION_FAILED` for an invalid payload,
   *   `CONFLICT` when the revision guard fails.
   */
  saveProject(project, expectedRevision) {
    const result = validateProjectV3(project);
    if (!result.ok) throw result.error;
    const validated = result.value;

    const filePath = projectPath(this.baseDirPath(), validated.projectId);

    const before = readRevision(filePath);
    enforceRevision(expectedRevision, before.revision, validated.projectId);

    const newRevision = generateRevision();
    const saved = {
      ...validated,
      revision: newRevision,
      updatedAt: new Date().toISOString(),
    };
    const content = JSON.stringify(saved, null, 2);

    // Close the interleaved-write race: re-read the on-disk revision right
    // before committing. If it moved since we validated, abort with CONFLICT
    // rather than silently overwriting another writer's work.
    const tmpPath = writeTempAtomic(filePath, content);
    try {
      const pre = readRevision(filePath);
      if (pre.revision !== before.revision) {
        throw createAppError(
          'CONFLICT',
          `Project "${validated.projectId}" revision changed during save ("${pre.revision}" != "${before.revision}").`,
          { expectedRevision: before.revision, currentRevision: pre.revision },
        );
      }
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      cleanupTemp(tmpPath);
      throw err;
    }

    return saved;
  }

  /**
   * Load and validate a persisted project.
   *
   * @param {string} projectId
   * @returns {import('../../../shared/contracts/projects.ts').ProjectV3}
   * @throws {AppError} code `NOT_FOUND` when absent, `CORRUPT_DATA` when the
   *   file is unreadable or fails v3 validation.
   */
  loadProject(projectId) {
    const filePath = projectPath(this.baseDirPath(), projectId);

    if (!fileExists(filePath)) {
      throw createAppError('NOT_FOUND', `Project "${projectId}" not found.`, { projectId });
    }

    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      throw createAppError('CORRUPT_DATA', `Cannot read project "${projectId}".`, {
        projectId,
        cause: err.message,
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw createAppError('CORRUPT_DATA', `Project "${projectId}" is not valid JSON.`, {
        projectId,
        cause: err.message,
      });
    }

    const result = validateProjectV3(parsed);
    if (!result.ok) {
      throw createAppError(
        'CORRUPT_DATA',
        `Project "${projectId}" failed v3 validation: ${result.error.message}`,
        { projectId, details: result.error.details },
      );
    }

    return result.value;
  }
}

/** Convenience factory mirroring the `settingsStore` style. */
function createProjectStore(options) {
  return new ProjectStore(options);
}

/** Default singleton backed by the Electron userData directory. */
const defaultProjectStore = new ProjectStore();

module.exports = {
  ProjectStore,
  createProjectStore,
  getDefaultBaseDir,
  defaultProjectStore,
  // exported for tests / reuse (documentProjectStore shares the atomic
  // temp+fsync+rename discipline for document.json and translations/*.json)
  sanitizeProjectId,
  readRevision,
  fileExists,
  writeTempAtomic,
  cleanupTemp,
};
