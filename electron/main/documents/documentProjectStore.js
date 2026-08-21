'use strict';

// Document project persistence (DOC-02).
//
// Persists the editorial document lane on top of the P2.D6 atomic project
// store: a versioned `document.json` archive (normalized blocks/spans,
// preflight metadata, user edits, protection policies, undo recovery epoch)
// plus per-language translation archives keyed by normalized BCP-47 under
// `translations/`. Layout inside every project directory:
//
//   <baseDir>/<projectId>/project.json            ProjectV3 (P2.D6)
//   <baseDir>/<projectId>/document.json           DocumentArchive v1
//   <baseDir>/<projectId>/translations/<tag>.json TranslationArchive v1
//
// Concurrency discipline: every mutation runs as ONE serialized per-project
// transaction spanning BOTH durable writes — the ProjectV3 revision bump
// (the write lease via ProjectStore.saveProject) AND the atomic content
// rename (temp + fsync + rename), for document.json and translations/*.json
// alike. The full sequence, guarded by an in-process per-project mutex and
// scoped to the single-process Electron main (the documented deployment):
//
//   1. recover any pending mutation intent (see below),
//   2. compare-and-swap: on-disk revision must equal `expectedRevision`,
//   3. write-ahead intent: record the exact payload in
//      `<baseDir>/<projectId>.mutation-intent.json`,
//   4. bump the revision (lease taken),
//   5. compare-and-swap recheck immediately before committing,
//   6. atomically rename the content into place,
//   7. clear the intent.
//
// Creation (createDocumentProject) journals a PHASED intent and stages BOTH
// files in a sibling staging directory before anything exists in the store:
// write-ahead {phase:'prepared'} -> stage project.json (the lease, via the
// real saveProject) plus document.json inside the staging directory ->
// durable {phase:'leased'}, recording the SHA-256 of the staged project.json
// as the durable creation identity -> one-rename promotion -> clear the
// intent. Duplicate creates are refused (CONFLICT) under the exclusive
// section BEFORE any intent is written, the staging-path collision check is
// lstat-based (a DANGLING symlink collides too), and pre-lease recovery
// removes exactly the recorded staging directory — clearing the intent ONLY
// once the staging tree is verifiably gone — so an existing project is
// never touched and no partial state can ever appear at the final project
// path.
//
// Threat model (Human decision 2026-08-21): this store's deployment
// contract is a SINGLE-PROCESS Electron main, and hostile ARCHIVE CONTENT
// is in scope — malformed payloads fail loudly as typed CORRUPT_DATA,
// never guessed about. A concurrent EXTERNAL process mutating the store
// tree mid-operation is EXPLICITLY OUT of scope (transferred to the
// P3B.J1 / P4 hardening backlog): operations here are synchronous, so
// nothing can interleave inside this process, but each lstat/read/write/
// rename remains an individual syscall an external mutator could race
// between. The per-operation lstat confinement gates are therefore
// practical defense against PLANTED links and nodes — not a TOCTOU proof.
//
// Confinement on the staged paths: EVERY staged read, write, delete and
// rename — live create path AND recovery — re-runs the lstat gate over the
// staging root and the staged project directory immediately beforehand,
// promotion validates its staged SOURCE as well as its destination, and a
// planted link or foreign node anywhere along those prefixes is loud typed
// failure, never followed. Leased recovery treats a final project as its
// own promotion only when the staged directory is gone AND the final state
// carries the journaled creation identity: project.json hashing to the
// lease-time digest, document.json byte-identical to the journaled payload,
// and the parsed ProjectV3 proving type "document" with the intent's
// projectId — anything else there is a CONFLICT that preserves the intent
// and staged pair for manual resolution.
//
// A crash at any point therefore cannot silently drop a mutation or
// stale-commit it later: before the lease the intent is discarded (nothing
// happened); after the lease the next reader or writer REPLAYS the intent
// (idempotently) before observing state, so the interrupted edit always
// lands exactly once. Failures before the lease burn no revision. Content
// files are always complete JSON: partial writes never reach disk.
//
// editEpoch is a monotonic MARKER persisted across reopen: it tells DOC-05
// where pre-crash undo history ends so the editor can anchor a fresh undo
// stack. This store implements no full undo recovery itself — stack
// reconstruction from editBaselines is DOC-05 scope.
//
// Freshness (plan §10.9) is computed, never persisted as authoritative: each
// translation entry stores the SHA-256 of the source block text at translation
// time, and a block is stale iff that hash differs from the current block
// text. A source edit therefore flips only the edited block's translations
// stale and never deletes them (editor invariant #4).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError, createAppError } = require('../../../shared/contracts/errors.ts');
const {
  TRANSLATION_ARCHIVE_SCHEMA_VERSION,
  normalizeBcp47,
  isCanonicalSha256,
  validateDocumentArchive,
  validateTranslationArchive,
} = require('../../../shared/contracts/documents.ts');
const {
  ProjectStore,
  readRevision,
  fileExists,
  writeTempAtomic,
  cleanupTemp,
  sanitizeProjectId,
} = require('../projects/projectStore.js');

const DOCUMENT_FILE = 'document.json';
const TRANSLATIONS_DIR = 'translations';
const TRANSLATION_STATUSES = ['draft', 'needs-review', 'approved'];

function nowIso() {
  return new Date().toISOString();
}

/**
 * SHA-256 hex of a block's current source text — the freshness basis shared
 * by translation commits (`sourceHash`) and staleness checks (plan §10.9).
 */
function blockSourceHash(block) {
  return crypto.createHash('sha256').update(block.text, 'utf8').digest('hex');
}

/** Canonical SHA-256 hex over raw bytes — the durable creation identity. */
function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Compute the freshness/approval report for one language variant against the
 * current document archive (pure — safe for Renderer consumption over IPC).
 * Blocks without a translation entry are `missing`; entries whose stored
 * source hash no longer matches the current block text are `stale`.
 */
function computeFreshness(archive, translations) {
  const report = {
    language: translations.language,
    totalBlocks: archive.blocks.length,
    translated: 0,
    fresh: 0,
    stale: 0,
    missing: 0,
    approved: 0,
    needsReview: 0,
    blocks: {},
  };
  for (const block of archive.blocks) {
    const entry = translations.blocks[block.blockId];
    let info;
    if (!entry) {
      report.missing += 1;
      info = { freshness: 'missing', status: 'missing' };
    } else {
      report.translated += 1;
      const freshness = entry.sourceHash === blockSourceHash(block) ? 'fresh' : 'stale';
      if (freshness === 'fresh') report.fresh += 1;
      else report.stale += 1;
      if (entry.status === 'approved') report.approved += 1;
      if (entry.status === 'needs-review') report.needsReview += 1;
      info = { freshness, status: entry.status };
    }
    report.blocks[block.blockId] = info;
  }
  return report;
}

/**
 * Validate user-supplied replacement spans as an exact tiling of `text`:
 * contiguous, ordered, non-empty, text-faithful, and owned by `blockId`.
 * Returns deep copies so callers cannot mutate the store's state through the
 * input array.
 */
function validateSpanTiling(blockId, text, spans) {
  if (!Array.isArray(spans)) {
    throw createAppError('VALIDATION_FAILED', 'spans must be an array.');
  }
  const out = [];
  let prevEnd = 0;
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      throw createAppError('VALIDATION_FAILED', `spans[${i}] must be an object.`);
    }
    if (typeof s.spanId !== 'string' || s.spanId.length === 0) {
      throw createAppError('VALIDATION_FAILED', `spans[${i}].spanId is required.`);
    }
    if (s.blockId !== blockId) {
      throw createAppError('VALIDATION_FAILED', `spans[${i}].blockId must be "${blockId}".`);
    }
    if (!Number.isInteger(s.start) || !Number.isInteger(s.end)) {
      throw createAppError('VALIDATION_FAILED', `spans[${i}].start/end must be integers.`);
    }
    if (s.start !== prevEnd) {
      throw createAppError(
        'VALIDATION_FAILED',
        `spans[${i}] must start at offset ${prevEnd}, got ${s.start}.`,
      );
    }
    if (s.end <= s.start) {
      throw createAppError('VALIDATION_FAILED', `spans[${i}] must not be empty.`);
    }
    if (s.end > text.length) {
      throw createAppError('VALIDATION_FAILED', `spans[${i}].end exceeds text length.`);
    }
    if (typeof s.text !== 'string' || s.text !== text.slice(s.start, s.end)) {
      throw createAppError(
        'VALIDATION_FAILED',
        `spans[${i}].text must equal text.slice(${s.start}, ${s.end}).`,
      );
    }
    if (!s.traits || typeof s.traits !== 'object' || Array.isArray(s.traits)) {
      throw createAppError('VALIDATION_FAILED', `spans[${i}].traits must be an object.`);
    }
    out.push({
      spanId: s.spanId,
      blockId,
      text: s.text,
      start: s.start,
      end: s.end,
      traits: { ...s.traits },
    });
    prevEnd = s.end;
  }
  if (prevEnd !== text.length) {
    throw createAppError(
      'VALIDATION_FAILED',
      `spans must tile the full text (covered 0..${prevEnd} of ${text.length}).`,
    );
  }
  return out;
}

/** Read + parse a JSON file, mapping I/O and syntax failures to CORRUPT_DATA. */
function readJsonFile(filePath, corruptMessage) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw createAppError('CORRUPT_DATA', `${corruptMessage} (${err.message})`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw createAppError('CORRUPT_DATA', `${corruptMessage} (invalid JSON: ${err.message})`);
  }
}

/**
 * lstat that never follows symlinks: null when the path is absent, the
 * stat otherwise. Unexpected I/O failures become CORRUPT_DATA — a staged
 * or final path that cannot even be inspected is never guessed about.
 */
function lstatSafe(filePath, label) {
  try {
    return fs.lstatSync(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw createAppError('CORRUPT_DATA', `${label} is unreadable (${err.message}).`);
  }
}

// --- Per-project transaction machinery ---------------------------------------

/** Suffix for the write-ahead intent file, a sibling of the project dir. */
const MUTATION_INTENT_SUFFIX = '.mutation-intent.json';
// v2 added the explicit durable phase ('prepared' | 'leased') plus the
// recorded staging directory; v3 adds `projectSha256` — the SHA-256 of the
// staged project.json at lease time, the durable creation identity leased
// recovery proves final-state ownership with. Each bump makes older or
// ambiguous create intents loudly malformed instead of guessed.
const MUTATION_INTENT_VERSION = 3;
/** Suffix of the sibling staging directory a journaled creation builds in. */
const CREATE_STAGING_SUFFIX = '.create-staging';

/**
 * In-process per-project mutexes keyed by the project directory. Every
 * current mutation is synchronous, so the fast path below acquires and
 * releases around one synchronous call — no microtask hop, synchronous
 * throws preserved for callers. If an effect ever returns a thenable (an
 * fs.promises port, say), the lock is held until it settles and later
 * callers queue behind it: exactly the revision-write/content-write
 * interleaving a bare optimistic lease cannot prevent.
 */
const projectLocks = new Map();

function releaseProjectLock(projectKey, lock) {
  const next = lock.queue.shift();
  if (next) {
    next();
    return;
  }
  lock.busy = false;
  if (projectLocks.get(projectKey) === lock) projectLocks.delete(projectKey);
}

function runUncontended(projectKey, fn) {
  let lock = projectLocks.get(projectKey);
  if (!lock) {
    lock = { busy: false, queue: [] };
    projectLocks.set(projectKey, lock);
  }
  lock.busy = true;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      result.then(
        () => releaseProjectLock(projectKey, lock),
        () => releaseProjectLock(projectKey, lock),
      );
      return result;
    }
    releaseProjectLock(projectKey, lock);
    return result;
  } catch (err) {
    releaseProjectLock(projectKey, lock);
    throw err;
  }
}

/**
 * Run `fn` in an exclusive critical section keyed by `projectKey`.
 * Exported for tests — the serialization guarantee is load-bearing.
 */
function runProjectExclusive(projectKey, fn) {
  const lock = projectLocks.get(projectKey);
  if (lock && lock.busy) {
    // Reachable only while an async holder owns the section.
    return new Promise((resolve, reject) => {
      // `resolve` accepts plain values and thenables alike, so both sync and
      // async queued fns settle this promise correctly.
      lock.queue.push(() => {
        try {
          resolve(runUncontended(projectKey, fn));
        } catch (err) {
          reject(err);
        }
      });
    });
  }
  return runUncontended(projectKey, fn);
}

/** Source-asset identity compare (immutable per plan invariant #6). */
function sameSourceAsset(a, b) {
  return (
    a.ref === b.ref && a.hash === b.hash && a.sizeBytes === b.sizeBytes && a.fileName === b.fileName
  );
}

/**
 * Atomic, revision-guarded document project store. See the module header for
 * the on-disk layout and concurrency model.
 */
class DocumentProjectStore {
  /**
   * @param {{ baseDir?: string, projectStore?: ProjectStore }} [options]
   *   Injected store root / underlying project store. When omitted, the real
   *   `userData/projects` root is resolved lazily from Electron.
   */
  constructor(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    this.projectStore =
      opts.projectStore instanceof ProjectStore
        ? opts.projectStore
        : new ProjectStore({ baseDir: opts.baseDir });
  }

  baseDirPath() {
    return this.projectStore.baseDirPath();
  }

  projectDirPath(projectId) {
    return path.join(this.baseDirPath(), sanitizeProjectId(projectId));
  }

  documentPath(projectId) {
    return path.join(this.projectDirPath(projectId), DOCUMENT_FILE);
  }

  translationsDirPath(projectId) {
    return path.join(this.projectDirPath(projectId), TRANSLATIONS_DIR);
  }

  translationPath(projectId, language) {
    // Canonical BCP-47 tags are `[A-Za-z0-9-]+` (no dots, no separators), so
    // the stem cannot traverse; the assert is defense in depth.
    if (!/^[A-Za-z0-9-]+$/.test(language) || language.includes('..')) {
      throw createAppError('VALIDATION_FAILED', `Unsafe language tag: "${language}".`);
    }
    return path.join(this.translationsDirPath(projectId), `${language}.json`);
  }

  // --- Creation / load ------------------------------------------------------

  /**
   * Create a new document project as ONE journaled transaction spanning the
   * `project.json` + `document.json` pair (same discipline as `_mutate`),
   * staged OUTSIDE the final project directory:
   *
   *   duplicate check -> write-ahead intent {phase:'prepared'} -> stage
   *   project.json (the lease, via the real saveProject) + document.json
   *   in the sibling staging directory -> durable {phase:'leased'} ->
   *   one-rename promotion into the store -> clear the intent
   *
   * The explicit phase makes pre-lease and post-lease unambiguous for
   * recovery: 'prepared' discards exactly the recorded staging directory
   * and the intent — an EXISTING project (document or media) is never
   * touched; 'leased' rolls forward (complete the staged pair if needed,
   * promote, clean up). Because staging happens outside the store, no
   * partial state can ever appear at the final project path: a type=document
   * project.json only ever materializes together with its archive, in one
   * atomic rename.
   *
   * Duplicate detection runs BEFORE any intent is written: an existing
   * project.json (any type), a non-empty target directory, or a colliding
   * staging path is a CONFLICT — a retried create can never journal an
   * intent that recovery might misread as a lease over foreign state.
   *
   * @returns {{ project: object, archive: object }} both as persisted.
   * @throws {AppError} VALIDATION_FAILED for invalid/mismatched payloads,
   *   CONFLICT when the project (or the staging location) already exists.
   */
  createDocumentProject(project, archive) {
    if (!project || typeof project !== 'object' || project.type !== 'document') {
      throw createAppError('VALIDATION_FAILED', 'createDocumentProject requires a type:"document" project.');
    }
    const validatedArchive = this._validateArchive(archive, project.projectId);
    // sanitizeProjectId validates without transforming, so this is exactly
    // the id saveProject will normalize to — needed upfront for paths and
    // the intent's targetFile.
    const projectId = sanitizeProjectId(project.projectId);
    const stamped = {
      ...validatedArchive,
      projectId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const content = JSON.stringify(stamped, null, 2);
    const projectDir = this.projectDirPath(projectId);
    const stagingDir = this._creationStagingPath(projectId);
    // The id saveProject will normalize to (sanitizeProjectId validates
    // without transforming), so the staged project directory is predictable.
    const stagedProjectDir = path.join(stagingDir, projectId);

    return runProjectExclusive(projectDir, () => {
      // Step 1 of every transaction: recover any interrupted predecessor
      // before observing state.
      this._recoverPendingMutation(projectId);
      // Duplicate detection BEFORE any journal state exists. Post-recovery
      // there is nothing of ours left behind, so anything present is
      // foreign state that creation must refuse, never overwrite.
      if (fileExists(path.join(projectDir, 'project.json'))) {
        throw createAppError('CONFLICT', `Project "${projectId}" already exists.`);
      }
      if (fs.existsSync(projectDir) && fs.readdirSync(projectDir).length > 0) {
        throw createAppError(
          'CONFLICT',
          `Project directory "${projectId}" already exists and is not empty.`,
        );
      }
      // lstat, NOT existsSync: a DANGLING symlink at the staging path must
      // collide too (typed CONFLICT) — existsSync follows links and misses
      // exactly that case, and staging would follow the link once its
      // target ever appears. A path that cannot even be inspected is
      // CORRUPT_DATA from lstatSafe, never guessed about.
      if (lstatSafe(stagingDir, `Creation staging path "${stagingDir}"`) !== null) {
        throw createAppError(
          'CONFLICT',
          `Creation staging path for project "${projectId}" already exists.`,
        );
      }

      const intentPath = this._intentPath(projectId);
      const writeCreateIntent = (phase, projectSha256) =>
        this._writeJsonAtomic(intentPath, {
          version: MUTATION_INTENT_VERSION,
          projectId,
          action: 'create',
          phase,
          stagingDir: path.relative(this.baseDirPath(), stagingDir),
          targetFile: DOCUMENT_FILE,
          content,
          // Only the leased flip carries the durable creation identity;
          // at 'prepared' time nothing is staged to hash yet.
          ...(projectSha256 === undefined ? {} : { projectSha256 }),
          createdAt: nowIso(),
        });
      // Write-ahead BEFORE any store content exists: a crash from here on
      // leaves durable evidence recovery understands.
      writeCreateIntent('prepared');

      let savedProject;
      let leased = false;
      try {
        // Confinement gate immediately before the first staged write: every
        // component down to the (absent) staging root is verified real, so
        // saveProject can never materialize through a planted link.
        this._assertCreationStagingIntegrity(stagingDir, stagedProjectDir);
        // Stage the lease with the REAL saveProject machinery, rooted at
        // the staging directory: project.json (with its fresh revision)
        // and document.json both materialize outside the store.
        savedProject = this._stagingProjectStore(stagingDir).saveProject(project, undefined);
        // Re-run the gate before EACH subsequent staged operation — the
        // staged archive write, the identity read, the promotion rename
        // and the residue delete all re-verify both prefixes.
        this._assertCreationStagingIntegrity(stagingDir, stagedProjectDir);
        this._applyContentPlan({
          filePath: path.join(stagedProjectDir, DOCUMENT_FILE),
          content,
        });
        // The identity read is a staged READ like any other: re-run the
        // confinement gate immediately beforehand, so a link planted in
        // the content-plan window is refused here instead of followed.
        this._assertCreationStagingIntegrity(stagingDir, stagedProjectDir);
        // Durable creation identity (v3): digest the staged project.json
        // bytes exactly as written — leased recovery proves ownership of
        // the final state against precisely these bytes.
        const projectSha256 = sha256Hex(
          fs.readFileSync(path.join(stagedProjectDir, 'project.json')),
        );
        // Durable phase flip AFTER the staged lease: from here recovery
        // must roll forward, never discard.
        writeCreateIntent('leased', projectSha256);
        leased = true;
        this._assertCreationStagingIntegrity(stagingDir, stagedProjectDir);
        this._promoteStagedCreation(stagedProjectDir, projectDir);
      } catch (err) {
        if (!leased) {
          // Still 'prepared': nothing was promised to the store. Remove
          // exactly the creation-owned residue; the caller may retry.
          this._discardCreationResidue(stagingDir, intentPath);
        }
        // Leased failures KEEP the intent: recovery rolls the promotion
        // forward (same crash semantics as _mutate).
        throw err;
      }
      // Promotion committed: best-effort cleanup of the (now empty) staging
      // root and the intent. A crash in this window is repaired idempotently
      // by recovery (leased intent + existing project.json -> cleanup only).
      try {
        // Last gated staged operation of the live path: the residue delete
        // also runs only through a verified-real staging root (the staged
        // project dir itself was renamed away and passes vacuously).
        this._assertCreationStagingIntegrity(stagingDir, stagedProjectDir);
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      try {
        fs.unlinkSync(intentPath);
      } catch {
        /* best effort: a leftover leased intent replays as cleanup only */
      }
      return { project: savedProject, archive: stamped };
    });
  }

  /** Sibling staging directory where a journaled creation is built. */
  _creationStagingPath(projectId) {
    return `${this.projectDirPath(projectId)}${CREATE_STAGING_SUFFIX}`;
  }

  /**
   * Project store rooted at a creation staging directory: the staged lease
   * goes through the exact same saveProject validation/revision machinery
   * as a store write, but materializes outside the final project path.
   * Internal seam — tests inject lease failures here.
   */
  _stagingProjectStore(stagingDir) {
    return new ProjectStore({ baseDir: stagingDir });
  }

  /**
   * Live-create confinement gate, re-run IMMEDIATELY before every staged
   * read/write/delete/rename on the create path: both the staging root and
   * the staged project directory must be real directories below the store.
   * Absent paths pass vacuously (creation materializes them); a planted
   * symbolic link or foreign node anywhere along either prefix is loud
   * CORRUPT_DATA, never followed. Practical defense against planted links
   * and nodes — not a TOCTOU proof (see the module header threat model).
   */
  _assertCreationStagingIntegrity(stagingDir, stagedProjectDir) {
    const label = 'Creation staging';
    if (!this._assertRealDirectoryBelow(this.baseDirPath(), stagingDir, label)) {
      return false;
    }
    return this._assertRealDirectoryBelow(stagingDir, stagedProjectDir, label);
  }

  /**
   * Promotion commit of a staged creation: ONE atomic directory rename from
   * the staging area into the store. Both the success path and creation
   * recovery funnel through this method, and tests inject crashes at exactly
   * this boundary. BOTH endpoints are lstat-guarded first (confinement): the
   * staged SOURCE must be our own real directory — never a planted link or
   * foreign node — and the final path must not be a symbolic link or any
   * other non-directory, so the rename can never move or land on a path the
   * store does not own.
   */
  _promoteStagedCreation(stagedProjectDir, projectDir) {
    const source = lstatSafe(stagedProjectDir, `Staged project "${stagedProjectDir}"`);
    if (!source || source.isSymbolicLink() || !source.isDirectory()) {
      throw createAppError(
        'CORRUPT_DATA',
        `Staged project "${stagedProjectDir}" is ${
          !source ? 'missing' : source.isSymbolicLink() ? 'a symbolic link' : 'not a directory'
        }; refusing to promote through it.`,
      );
    }
    const existing = lstatSafe(projectDir, `Final project path "${projectDir}"`);
    if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
      throw createAppError(
        'CORRUPT_DATA',
        `Final project path "${projectDir}" is ${
          existing.isSymbolicLink() ? 'a symbolic link' : 'not a directory'
        }; refusing to promote through it.`,
      );
    }
    fs.renameSync(stagedProjectDir, projectDir);
  }

  /**
   * Pre-lease abort of a journaled creation: remove exactly the
   * creation-owned paths — the recorded staging directory first, and the
   * intent ONLY once the entire staging tree is verifiably gone. A failed
   * or partial removal RETAINS the intent and surfaces a CORRUPT_DATA
   * cleanup failure, so the next recovery retries the discard instead of
   * orphaning residue behind a cleared intent (which would poison same-id
   * retries with an unrecoverable staging collision). Never touches the
   * final project path.
   */
  _discardCreationResidue(stagingDir, intentPath) {
    if (stagingDir) {
      const present = this._assertRealDirectoryBelow(
        this.baseDirPath(),
        stagingDir,
        'Creation staging',
      );
      if (present) {
        let removalError = null;
        try {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        } catch (err) {
          removalError = err;
        }
        const leftover =
          removalError ||
          lstatSafe(stagingDir, `Creation staging residue "${stagingDir}"`);
        if (leftover) {
          throw createAppError(
            'CORRUPT_DATA',
            `Creation staging residue at "${stagingDir}" could not be removed${
              removalError ? ` (${removalError.message})` : ''
            }; the creation intent is retained and the next recovery retries the cleanup.`,
          );
        }
      }
    }
    try {
      fs.unlinkSync(intentPath);
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        throw createAppError(
          'CORRUPT_DATA',
          `Creation intent "${intentPath}" could not be cleared (${err.message}); it is retained and the next recovery retries.`,
        );
      }
    }
  }

  /**
   * Staged-path confinement: walk EVERY component below `belowDir` along
   * `target` with lstat — any existing component must be a REAL directory,
   * never a symbolic link and never a file. Returns true when `target`
   * itself exists as a real directory, false when it is absent; a planted
   * link or foreign non-directory throws CORRUPT_DATA so the escape is
   * reported without ever being followed.
   */
  _assertRealDirectoryBelow(belowDir, target, label) {
    const base = path.resolve(belowDir);
    const rel = path.relative(base, path.resolve(target));
    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw createAppError('CORRUPT_DATA', `${label} path "${target}" escapes the store root.`);
    }
    let acc = base;
    for (const part of rel.split(path.sep)) {
      acc = path.join(acc, part);
      const st = lstatSafe(acc, `${label} path component "${acc}"`);
      if (st === null) return false;
      if (st.isSymbolicLink()) {
        throw createAppError(
          'CORRUPT_DATA',
          `${label} path component "${acc}" is a symbolic link; refusing to follow it.`,
        );
      }
      if (!st.isDirectory()) {
        throw createAppError('CORRUPT_DATA', `${label} path component "${acc}" is not a directory.`);
      }
    }
    return true;
  }

  /**
   * No-follow regular-file read for ownership observations: null when the
   * node is absent; CORRUPT_DATA when it is a symbolic link or otherwise
   * not a regular file (never OPENED — reading a FIFO would hang recovery,
   * a link would escape the store); the raw bytes otherwise.
   */
  _readRegularFileGuarded(filePath, label) {
    const st = lstatSafe(filePath, label);
    if (st === null) return null;
    if (st.isSymbolicLink() || !st.isFile()) {
      throw createAppError(
        'CORRUPT_DATA',
        `${label} is ${st.isSymbolicLink() ? 'a symbolic link' : 'not a regular file'}; refusing to read it.`,
      );
    }
    return fs.readFileSync(filePath);
  }

  /**
   * Own-post-promotion proof for leased recovery — the durable creation
   * identity recorded at lease time. Our promotion renames the staged pair
   * into place untouched, so a completed creation is provable from three
   * facts about the final state, ALL required:
   *   1. project.json hashes to the journaled lease digest (`projectSha256`,
   *      the staged project.json bytes at lease time) — a foreign project
   *      carrying only a byte-matching archive sidecar fails here;
   *   2. document.json is byte-identical (Buffer equality) to the journaled
   *      payload;
   *   3. the parsed project proves type "document" with the intent's
   *      projectId.
   * Both nodes are observed through `_readRegularFileGuarded` first: absent
   * nodes merely fail the proof, while planted links/FIFOs are never read.
   * Anything readable-but-divergent simply fails the proof and the caller
   * reports the foreign/diverged CONFLICT with the intent retained.
   */
  _finalStateMatchesIntent(projectDir, intent) {
    const projectBytes = this._readRegularFileGuarded(
      path.join(projectDir, 'project.json'),
      `Final project.json of project "${intent.projectId}"`,
    );
    if (projectBytes === null || sha256Hex(projectBytes) !== intent.projectSha256) {
      return false;
    }
    const archiveBytes = this._readRegularFileGuarded(
      path.join(projectDir, DOCUMENT_FILE),
      `Final archive of project "${intent.projectId}"`,
    );
    if (archiveBytes === null || !archiveBytes.equals(Buffer.from(intent.content, 'utf8'))) {
      return false;
    }
    let parsed;
    try {
      parsed = JSON.parse(projectBytes.toString('utf8'));
    } catch {
      return false;
    }
    return (
      !!parsed &&
      typeof parsed === 'object' &&
      parsed.type === 'document' &&
      parsed.projectId === intent.projectId
    );
  }

  /**
   * Load a document project with its archive.
   *
   * Recovery runs BEFORE the project is observed: a crashed creation that
   * is leased but not yet promoted has no project.json on disk yet, and the
   * very next open must complete it rather than report NOT_FOUND.
   *
   * @throws {AppError} NOT_FOUND, CORRUPT_DATA (project or archive broken),
   *   VALIDATION_FAILED when the project is not a document project.
   */
  loadDocumentProject(projectId) {
    runProjectExclusive(this.projectDirPath(projectId), () =>
      this._recoverPendingMutation(projectId),
    );
    const project = this.projectStore.loadProject(projectId);
    if (project.type !== 'document') {
      throw createAppError(
        'VALIDATION_FAILED',
        `Project "${projectId}" is not a document project.`,
      );
    }
    const archive = this._loadDocumentArchive(projectId);
    // Reopen exhaustiveness: EVERY persisted translation sibling must be a
    // readable, valid, identity-matched archive — a corrupt or foreign
    // sibling fails the whole reopen instead of surfacing later as silent
    // data loss on the affected language.
    this.listLanguages(projectId);
    return { project, archive };
  }

  /** Load and validate just the document archive. */
  loadDocumentArchive(projectId) {
    return this._loadDocumentArchive(projectId);
  }

  // --- Document archive mutations -------------------------------------------

  /**
   * Persist a (possibly fully rebuilt) document archive. Timestamps are
   * stamped here; the project revision is bumped first (see class docs).
   *
   * @returns {{ archive: object, revision: string, project: object }}
   */
  saveDocumentArchive(projectId, archive, expectedRevision) {
    const validated = this._validateArchive(archive, projectId);
    // Wholesale saves must respect the persisted invariants (load-compare):
    // editEpoch never decreases and the source asset identity never changes.
    // The wholesale path doubles as the REPAIR path — when the current
    // archive is unreadable there is nothing to compare against, and any
    // valid archive may be restored.
    let currentArchive = null;
    try {
      currentArchive = this.loadDocumentArchive(projectId);
    } catch (err) {
      if (!(err instanceof AppError) || (err.code !== 'CORRUPT_DATA' && err.code !== 'NOT_FOUND')) {
        throw err;
      }
    }
    if (currentArchive) {
      if (validated.editEpoch < currentArchive.editEpoch) {
        throw createAppError(
          'VALIDATION_FAILED',
          `editEpoch regression: ${validated.editEpoch} < persisted ${currentArchive.editEpoch}; epochs are monotonic.`,
        );
      }
      if (!sameSourceAsset(validated.sourceAsset, currentArchive.sourceAsset)) {
        throw createAppError(
          'VALIDATION_FAILED',
          'sourceAsset is immutable; re-importing a source requires a new document project.',
        );
      }
    }
    const stamped = { ...validated, updatedAt: nowIso() };
    return this._mutate(
      projectId,
      expectedRevision,
      {
        filePath: this.documentPath(projectId),
        content: JSON.stringify(stamped, null, 2),
      },
      () => ({ archive: stamped }),
    );
  }

  /**
   * Apply a source edit to one block: replace its text (and optionally its
   * span tiling), record the imported baseline exactly once, and advance the
   * undo recovery epoch. Translations are never touched here — they simply
   * compute stale against the new text hash (§10.9).
   *
   * `opts.spans`, when given, must tile `text` exactly (see
   * `validateSpanTiling`); when omitted, the block becomes a single plain
   * span. The block's `styleFingerprint` is preserved: fingerprint maintenance
   * for trait-changing edits belongs to the editorial layer (DOC-05).
   *
   * @returns {{ archive: object, revision: string, project: object, block: object }}
   */
  updateBlockText(projectId, blockId, text, expectedRevision, opts = {}) {
    if (typeof blockId !== 'string' || blockId.length === 0) {
      throw createAppError('VALIDATION_FAILED', 'blockId must be a non-empty string.');
    }
    if (typeof text !== 'string') {
      throw createAppError('VALIDATION_FAILED', 'text must be a string.');
    }
    // Build and validate the next archive BEFORE taking the write lease, so a
    // rejected request never burns a revision. Any interleaved mutation bumps
    // the project revision, which makes the lease guard below reject this
    // stale build — the pre-build is therefore race-free.
    const archive = this._loadDocumentArchive(projectId);
    const index = archive.blocks.findIndex((b) => b.blockId === blockId);
    if (index < 0) {
      throw createAppError(
        'NOT_FOUND',
        `Block "${blockId}" not found in document project "${projectId}".`,
      );
    }
    const original = archive.blocks[index];
    const spans =
      opts.spans !== undefined
        ? validateSpanTiling(blockId, text, opts.spans)
        : text.length === 0
          ? []
          : [
              {
                spanId: `${blockId}-s0`,
                blockId,
                text,
                start: 0,
                end: text.length,
                traits: {},
              },
            ];
    const updated = { ...original, text, spans };
    const blocks = [...archive.blocks];
    blocks[index] = updated;

    const editBaselines = { ...archive.editBaselines };
    if (editBaselines[blockId] === undefined) {
      // First edit wins: keep the block exactly as imported for later
      // merge reports / diffs (§10.9 source refresh).
      editBaselines[blockId] = structuredClone(original);
    }

    const stamped = {
      ...this._validateArchive(
        {
          ...archive,
          blocks,
          editBaselines,
          editEpoch: archive.editEpoch + 1,
        },
        projectId,
      ),
      updatedAt: nowIso(),
    };

    return this._mutate(
      projectId,
      expectedRevision,
      {
        filePath: this.documentPath(projectId),
        content: JSON.stringify(stamped, null, 2),
      },
      () => ({ archive: stamped, block: updated }),
    );
  }

  /**
   * Set (or clear with `null`) a block's translation/protection policy.
   * Policy changes are metadata, not source edits: the edit epoch is unchanged.
   */
  setBlockPolicy(projectId, blockId, policy, expectedRevision) {
    if (typeof blockId !== 'string' || blockId.length === 0) {
      throw createAppError('VALIDATION_FAILED', 'blockId must be a non-empty string.');
    }
    const archive = this._loadDocumentArchive(projectId);
    if (!archive.blocks.some((b) => b.blockId === blockId)) {
      throw createAppError('NOT_FOUND', `Block "${blockId}" not found in project "${projectId}".`);
    }
    const stamped = this._archiveWithPolicies(archive, projectId, blockId, policy, null);
    return this._mutate(
      projectId,
      expectedRevision,
      {
        filePath: this.documentPath(projectId),
        content: JSON.stringify(stamped, null, 2),
      },
      () => ({ archive: stamped }),
    );
  }

  /**
   * Set (or clear with `null`) a span's translation/protection policy.
   * The span must exist in the current working-copy blocks.
   */
  setSpanPolicy(projectId, spanId, policy, expectedRevision) {
    if (typeof spanId !== 'string' || spanId.length === 0) {
      throw createAppError('VALIDATION_FAILED', 'spanId must be a non-empty string.');
    }
    const archive = this._loadDocumentArchive(projectId);
    const owner = archive.blocks.some((b) => b.spans.some((s) => s.spanId === spanId));
    if (!owner) {
      throw createAppError('NOT_FOUND', `Span "${spanId}" not found in project "${projectId}".`);
    }
    const stamped = this._archiveWithPolicies(archive, projectId, null, policy, spanId);
    return this._mutate(
      projectId,
      expectedRevision,
      {
        filePath: this.documentPath(projectId),
        content: JSON.stringify(stamped, null, 2),
      },
      () => ({ archive: stamped }),
    );
  }


  // --- Language variants ------------------------------------------------------

  /**
   * Add a target language: creates a NEW empty translation archive for the
   * normalized BCP-47 tag. Existing language files are never read or written
   * on this path (isolation invariant, plan §10.5). Deletion confirmation and
   * export/backup UX live in the UI layer (D4); the store exposes
   * `removeLanguage(..., { backupDir })` for the confirmed action.
   *
   * The target-absence precondition is a TRANSACTION precondition: it is
   * evaluated inside the exclusive section AFTER pending-mutation recovery,
   * so an archive replayed from a crashed prior mutation surfaces as CONFLICT
   * instead of being overwritten by the fresh skeleton.
   *
   * @param meta {import('../../../shared/contracts/documents.ts').LanguageVariantMeta}
   * @returns {{ archive: object, revision: string, project: object }}
   */
  addLanguage(projectId, language, meta, expectedRevision) {
    const normalized = this._normalizeLanguage(language);
    const skeleton = {
      schemaVersion: TRANSLATION_ARCHIVE_SCHEMA_VERSION,
      projectId,
      language: normalized,
      meta: {
        provider: meta && typeof meta === 'object' ? meta.provider : undefined,
        model: meta && typeof meta === 'object' ? meta.model : undefined,
        profile: meta && typeof meta === 'object' ? meta.profile : undefined,
        promptVersion: meta && typeof meta === 'object' ? meta.promptVersion : undefined,
        glossaryRevision: meta && typeof meta === 'object' ? meta.glossaryRevision : undefined,
        sourceHash: meta && typeof meta === 'object' ? meta.sourceHash : undefined,
      },
      blocks: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const validated = this._validateTranslation(skeleton);
    const targetPath = this.translationPath(projectId, normalized);
    return this._mutate(
      projectId,
      expectedRevision,
      { filePath: targetPath, content: JSON.stringify(validated, null, 2) },
      () => ({ archive: validated }),
      undefined,
      () => {
        if (fileExists(targetPath)) {
          throw createAppError(
            'CONFLICT',
            `Language "${normalized}" already exists for project "${projectId}".`,
          );
        }
      },
    );
  }

  /**
   * Remove a language variant. With `opts.backupDir`, the raw archive file is
   * copied there first (byte-faithful backup; removal aborts if the backup
   * fails). Clearing the active view-state language is handled automatically.
   *
   * BOTH the target-existence check and the backup are TRANSACTION
   * preconditions: they run inside the exclusive section AFTER pending-
   * mutation recovery, so the existence verdict and the backed-up bytes
   * always describe the POST-replay world — a crashed prior mutation for
   * this language is replayed first, and the backup captures exactly the
   * bytes the unlink will remove (never stale ones). The plan is built from
   * the precondition result, so the durable intent records the backup path.
   * A backup failure throws before any intent, lease, or unlink — the
   * removal aborts atomically.
   *
   * @returns {{ revision: string, project: object, language: string }}
   */
  removeLanguage(projectId, language, expectedRevision, opts = {}) {
    const normalized = this._normalizeLanguage(language);
    const targetPath = this.translationPath(projectId, normalized);
    const patch = {};
    return this._mutate(
      projectId,
      expectedRevision,
      (backup) => ({ filePath: targetPath, unlink: true, backupFile: backup && backup.backupFile }),
      () => ({ language: normalized }),
      patch,
      () => {
        if (!fileExists(targetPath)) {
          throw createAppError(
            'NOT_FOUND',
            `No translation archive for language "${normalized}" in project "${projectId}".`,
          );
        }
        let backupFile;
        if (opts.backupDir != null) {
          fs.mkdirSync(opts.backupDir, { recursive: true });
          backupFile = path.join(opts.backupDir, `${normalized}.json`);
          fs.copyFileSync(targetPath, backupFile);
        }
        const loaded = this.projectStore.loadProject(projectId);
        if (loaded.activeTranslationLanguage === normalized) {
          patch.activeTranslationLanguage = undefined;
        }
        return { backupFile };
      },
    );
  }

  /** Load one language variant (normalized tag accepted case-insensitively). */
  getTranslationArchive(projectId, language) {
    const normalized = this._normalizeLanguage(language);
    return this._readValidatedTranslation(
      this.translationPath(projectId, normalized),
      normalized,
      projectId,
    );
  }

  /**
   * List language variants from the translations directory (the directory is
   * the source of truth — adding/removing a language is exactly a file
   * create/delete). Sorted by language tag.
   */
  listLanguages(projectId) {
    if (!fileExists(path.join(this.projectDirPath(projectId), 'project.json'))) {
      throw createAppError('NOT_FOUND', `Project "${projectId}" not found.`);
    }
    const dir = this.translationsDirPath(projectId);
    runProjectExclusive(this.projectDirPath(projectId), () =>
      this._recoverPendingMutation(projectId),
    );
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      // An absent translations directory is a valid empty state; any other
      // I/O failure means the store cannot be trusted and must be loud.
      if (err && err.code === 'ENOENT') return [];
      throw createAppError(
        'CORRUPT_DATA',
        `Translations directory of project "${projectId}" is unreadable (${err.message}).`,
      );
    }
    return names
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => {
        // The FILE STEM is the naming authority: the payload must agree with
        // it (and with the project) or the sibling is corrupt.
        const stem = f.slice(0, -'.json'.length);
        const archive = this._readValidatedTranslation(path.join(dir, f), stem, projectId);
        return {
          language: stem,
          meta: archive.meta,
          createdAt: archive.createdAt,
          updatedAt: archive.updatedAt,
          blockCount: Object.keys(archive.blocks).length,
        };
      });
  }

  /**
   * Upsert block translations into one language variant. Entries are
   * `{ blockId, text?, sourceHash?, status?, updatedAt? }`. Freshness rules
   * (plan §10.9):
   *   - TEXT commit (`text` supplied): the stored hash is the SHA-256 of the
   *     block's CURRENT source text — so plain retranslations are fresh by
   *     construction — unless the caller supplies an explicit canonical
   *     `sourceHash` (validated snapshot hash for async commits).
   *   - STATUS-ONLY update (no `text`): text and hash are kept untouched
   *     (`{ blockId, status: 'approved' }` is the approval path).
   *   - `sourceHash` WITHOUT `text` is rejected: a hash belongs to a text
   *     commit; non-canonical hashes are always rejected.
   *
   * @returns {{ archive: object, revision: string, project: object }}
   */
  saveTranslations(projectId, language, entries, expectedRevision) {
    const normalized = this._normalizeLanguage(language);
    if (!Array.isArray(entries) || entries.length === 0) {
      throw createAppError('VALIDATION_FAILED', 'entries must be a non-empty array.');
    }
    // Pre-build the merged archive before taking the write lease (rejected
    // requests must not burn a revision; the lease guard rejects stale builds).
    const docArchive = this._loadDocumentArchive(projectId);
    const blocksById = new Map(docArchive.blocks.map((b) => [b.blockId, b]));
    const translation = this._readValidatedTranslation(
      this.translationPath(projectId, normalized),
      normalized,
      projectId,
    );

    const blocks = { ...translation.blocks };
    const stamp = nowIso();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw createAppError('VALIDATION_FAILED', `entries[${i}] must be an object.`);
      }
      const { blockId, text, sourceHash, status, updatedAt } = entry;
      if (typeof blockId !== 'string' || blockId.length === 0) {
        throw createAppError('VALIDATION_FAILED', `entries[${i}].blockId is required.`);
      }
      const block = blocksById.get(blockId);
      if (!block) {
        throw createAppError(
          'VALIDATION_FAILED',
          `entries[${i}] references unknown blockId "${blockId}".`,
        );
      }
      const previous = blocks[blockId];
      let nextText;
      let nextHash;
      if (text !== undefined) {
        // Text commit — never inherit the previous hash: it described the
        // OLD translation against possibly-old source text.
        if (typeof text !== 'string') {
          throw createAppError('VALIDATION_FAILED', `entries[${i}].text must be a string.`);
        }
        nextText = text;
        if (sourceHash !== undefined) {
          // Explicit snapshot hash (async commits against a captured state).
          if (!isCanonicalSha256(sourceHash)) {
            throw createAppError(
              'VALIDATION_FAILED',
              `entries[${i}].sourceHash must be a canonical SHA-256 digest (lowercase 64-char hex).`,
            );
          }
          nextHash = sourceHash;
        } else {
          nextHash = blockSourceHash(block);
        }
      } else {
        // Status-only update — keep text and the recorded hash.
        if (sourceHash !== undefined) {
          throw createAppError(
            'VALIDATION_FAILED',
            `entries[${i}]: sourceHash requires text; status-only updates keep the recorded hash.`,
          );
        }
        nextText = previous?.text;
        nextHash = previous?.sourceHash;
        if (typeof nextText !== 'string') {
          throw createAppError(
            'VALIDATION_FAILED',
            `entries[${i}]: text is required for a new translation of "${blockId}".`,
          );
        }
      }
      const nextStatus = status !== undefined ? status : previous?.status ?? 'draft';
      if (!TRANSLATION_STATUSES.includes(nextStatus)) {
        throw createAppError('VALIDATION_FAILED', `entries[${i}].status invalid: ${nextStatus}`);
      }
      blocks[blockId] = {
        blockId,
        text: nextText,
        sourceHash: nextHash,
        status: nextStatus,
        updatedAt: updatedAt ?? stamp,
      };
    }

    const stamped = this._validateTranslation({
      ...translation,
      blocks,
      updatedAt: stamp,
    });
    return this._mutate(
      projectId,
      expectedRevision,
      {
        filePath: this.translationPath(projectId, normalized),
        content: JSON.stringify(stamped, null, 2),
      },
      () => ({ archive: stamped }),
    );
  }

  /**
   * Replace one language variant wholesale. This is the repair path for a
   * corrupt archive (the upsert path in `saveTranslations` must merge into
   * what is on disk, so it cannot repair unreadable files) and the bulk
   * commit path for a coordinator holding a complete variant in memory.
   * The archive's `language`/`projectId` must match the target.
   */
  saveTranslationArchive(projectId, language, archive, expectedRevision) {
    const normalized = this._normalizeLanguage(language);
    const validated = this._validateTranslation(archive);
    if (validated.projectId !== projectId || validated.language !== normalized) {
      throw createAppError(
        'VALIDATION_FAILED',
        `Archive identity (${validated.projectId}/${validated.language}) does not match target (${projectId}/${normalized}).`,
      );
    }
    const stamped = { ...validated, updatedAt: nowIso() };
    return this._mutate(
      projectId,
      expectedRevision,
      {
        filePath: this.translationPath(projectId, normalized),
        content: JSON.stringify(stamped, null, 2),
      },
      () => ({ archive: stamped }),
    );
  }

  /**
   * Switch the active language (view state only, plan §10.5): touches only
   * `project.json`, never any translation archive. The language must exist.
   */
  setActiveLanguage(projectId, language, expectedRevision) {
    const normalized = this._normalizeLanguage(language);
    this.getTranslationArchive(projectId, normalized); // NOT_FOUND when absent
    return this._mutate(
      projectId,
      expectedRevision,
      null,
      () => ({}),
      { activeTranslationLanguage: normalized },
    );
  }

  // --- Freshness --------------------------------------------------------------

  /**
   * Computed freshness/approval report for one language (plan §10.9). Pure
   * data — safe to ship to the Renderer for review filters and markers.
   */
  freshness(projectId, language) {
    const archive = this._loadDocumentArchive(projectId);
    const translation = this.getTranslationArchive(projectId, language);
    return computeFreshness(archive, translation);
  }

  // --- Internals ----------------------------------------------------------------

  /** Normalize + validate a language tag argument. */
  _normalizeLanguage(language) {
    const normalized = normalizeBcp47(language);
    if (!normalized) {
      throw createAppError(
        'VALIDATION_FAILED',
        `Invalid BCP-47 language tag: ${JSON.stringify(language)}.`,
      );
    }
    return normalized;
  }

  /** Validate an archive payload and pin it to `projectId`. */
  _validateArchive(archive, projectId) {
    const result = validateDocumentArchive(archive);
    if (!result.ok) throw result.error;
    if (result.value.projectId !== projectId) {
      throw createAppError(
        'VALIDATION_FAILED',
        `Archive projectId "${result.value.projectId}" does not match project "${projectId}".`,
      );
    }
    return result.value;
  }

  /** Validate a translation archive payload (canonical language enforced). */
  _validateTranslation(translation) {
    const result = validateTranslationArchive(translation);
    if (!result.ok) throw result.error;
    return result.value;
  }

  _loadDocumentArchive(projectId) {
    runProjectExclusive(this.projectDirPath(projectId), () =>
      this._recoverPendingMutation(projectId),
    );
    const filePath = this.documentPath(projectId);
    if (!fileExists(filePath)) {
      if (!fileExists(path.join(this.projectDirPath(projectId), 'project.json'))) {
        throw createAppError('NOT_FOUND', `Project "${projectId}" not found.`);
      }
      throw createAppError(
        'CORRUPT_DATA',
        `Document archive missing for project "${projectId}".`,
      );
    }
    // READ path: a parseable-but-invalid archive is CORRUPT_DATA, not a
    // caller-validation failure — the bytes on disk are what is broken.
    const parsed = readJsonFile(filePath, `Document archive of project "${projectId}" is unreadable`);
    const result = validateDocumentArchive(parsed);
    if (!result.ok) {
      throw createAppError(
        'CORRUPT_DATA',
        `Document archive of project "${projectId}" failed validation: ${result.error.message}`,
      );
    }
    const archive = result.value;
    if (archive.projectId !== projectId) {
      throw createAppError(
        'CORRUPT_DATA',
        `Document archive of project "${projectId}" carries foreign identity "${archive.projectId}".`,
      );
    }
    return archive;
  }

  /**
   * Read + validate one translation archive with full identity verification:
   * the payload must belong to `projectId` and carry the language named by
   * the file stem it was read from (the directory is the naming authority).
   * Parse/validate/identity failures on this READ path are CORRUPT_DATA.
   */
  _readValidatedTranslation(filePath, stem, projectId) {
    runProjectExclusive(this.projectDirPath(projectId), () =>
      this._recoverPendingMutation(projectId),
    );
    if (!fileExists(filePath)) {
      throw createAppError(
        'NOT_FOUND',
        `No translation archive for language "${stem}" in project "${projectId}".`,
      );
    }
    const parsed = readJsonFile(
      filePath,
      `Translation archive "${stem}" of project "${projectId}" is unreadable`,
    );
    const result = validateTranslationArchive(parsed);
    if (!result.ok) {
      throw createAppError(
        'CORRUPT_DATA',
        `Translation archive "${stem}" of project "${projectId}" failed validation: ${result.error.message}`,
      );
    }
    const archive = result.value;
    if (archive.projectId !== projectId || archive.language !== stem) {
      throw createAppError(
        'CORRUPT_DATA',
        `Translation archive "${stem}" of project "${projectId}" carries foreign identity (${archive.projectId}/${archive.language}).`,
      );
    }
    return archive;
  }

  /** Build the next document archive payload after a policy change (no write). */
  _archiveWithPolicies(archive, projectId, blockId, policy, spanId) {
    const key = blockId ?? spanId;
    const field = blockId != null ? 'blockPolicies' : 'spanPolicies';
    const policies = { ...archive[field] };
    if (policy === null) delete policies[key];
    else policies[key] = policy;
    return {
      ...this._validateArchive({ ...archive, [field]: policies }, projectId),
      updatedAt: nowIso(),
    };
  }

  /**
   * The content side of a mutation plan: atomic rename for writes (temp +
   * fsync + rename), idempotent removal for unlinks. Also the replay path
   * for recovered intents and the failure-injection seam for tests.
   */
  _applyContentPlan(plan) {
    if (plan.unlink) {
      fs.rmSync(plan.filePath, { force: true });
      return;
    }
    const tmpPath = writeTempAtomic(plan.filePath, plan.content);
    try {
      fs.renameSync(tmpPath, plan.filePath);
    } catch (err) {
      cleanupTemp(tmpPath);
      throw err;
    }
  }

  /** Write-ahead intent file path: a sibling of the project directory. */
  _intentPath(projectId) {
    return path.join(this.baseDirPath(), `${sanitizeProjectId(projectId)}${MUTATION_INTENT_SUFFIX}`);
  }

  /**
   * Replay or discard a crashed mutation's write-ahead intent. MUST run
   * inside the per-project critical section. Classification:
   *   - write/unlink intent, on-disk revision === intent.expectedRevision
   *       -> the lease was never taken; discard (nothing happened).
   *   - write/unlink intent, revision differs
   *       -> the lease WAS taken; roll the intent forward (idempotent
   *          commit of fully pre-validated content), then clear it.
   *   - creation intent, phase 'prepared'
   *       -> the staged lease was never durably promised; remove exactly the
   *          recorded staging directory, then the intent (cleared only once
   *          the staging tree is verifiably gone). An EXISTING project —
   *          document or media — is never touched.
   *   - creation intent, phase 'leased'
   *       -> roll forward: complete the staged pair if the crash preceded
   *          it, promote with one rename, then clean up. An existing final
   *          project counts as THIS creation only when the staged directory
   *          is gone AND the final state carries the journaled creation
   *          identity — project.json hashing to `projectSha256`, archive
   *          bytes identical to `content`, parsed type "document" with the
   *          intent's projectId; a foreign project at the final path is a
   *          CONFLICT preserving intent and staged pair.
   * Readers and writers alike recover before observing state, so a crash
   * between two durable writes is repaired by whichever access comes next
   * — a mixed crash can neither silently drop nor stale-commit. Creation
   * intents carry an explicit durable phase precisely so pre-lease and
   * post-lease can never be confused; a phase-less create intent is
   * malformed (CORRUPT_DATA), never guessed from surrounding state.
   */
  _recoverPendingMutation(projectId) {
    const intentPath = this._intentPath(projectId);
    if (!fileExists(intentPath)) return;
    const projectDir = this.projectDirPath(projectId);
    const intent = readJsonFile(intentPath, `Mutation intent of project "${projectId}" is unreadable`);
    const isCreate = !!intent && intent.action === 'create';
    if (
      !intent ||
      typeof intent !== 'object' ||
      intent.version !== MUTATION_INTENT_VERSION ||
      intent.projectId !== projectId ||
      // Creation intents are phased journals (see above); write/unlink
      // intents compare against their recorded pre-lease revision.
      (isCreate
        ? // A leased creation must additionally carry its canonical durable
          // creation identity — anything else is malformed, never guessed.
          intent.phase === 'leased'
          ? !isCanonicalSha256(intent.projectSha256)
          : intent.phase !== 'prepared'
        : typeof intent.expectedRevision !== 'string') ||
      (intent.action !== 'write' && intent.action !== 'unlink' && !isCreate) ||
      typeof intent.targetFile !== 'string' ||
      (isCreate && typeof intent.content !== 'string')
    ) {
      throw createAppError(
        'CORRUPT_DATA',
        `Mutation intent of project "${projectId}" is malformed.`,
      );
    }
    if (isCreate) {
      this._recoverCreationIntent(projectId, intent, intentPath);
      return;
    }
    const targetPath = path.resolve(projectDir, intent.targetFile);
    if (!targetPath.startsWith(projectDir + path.sep)) {
      throw createAppError(
        'CORRUPT_DATA',
        `Mutation intent of project "${projectId}" targets a path outside the project.`,
      );
    }
    const projectFilePath = path.join(projectDir, 'project.json');
    if (!fileExists(projectFilePath)) {
      // The project is gone; nothing is protected by keeping the intent.
      try {
        fs.unlinkSync(intentPath);
      } catch {
        /* best effort */
      }
      return;
    }
    const current = readRevision(projectFilePath).revision;
    if (current === null) {
      throw createAppError(
        'CORRUPT_DATA',
        `Project "${projectId}" is unreadable while a mutation intent is pending.`,
      );
    }
    const leased = current !== intent.expectedRevision;
    if (leased) {
      // Roll forward — verbatim, idempotent, exactly what the crashed
      // writer had already validated and leased.
      if (intent.action !== 'unlink' && typeof intent.content !== 'string') {
        throw createAppError(
          'CORRUPT_DATA',
          `Mutation intent of project "${projectId}" lacks its payload.`,
        );
      }
      this._applyContentPlan(
        intent.action === 'unlink'
          ? { filePath: targetPath, unlink: true }
          : { filePath: targetPath, content: intent.content },
      );
    }
    try {
      fs.unlinkSync(intentPath);
    } catch {
      /* best effort: a leftover intent replays harmlessly */
    }
  }

  /**
   * Recovery for a phased creation intent. The recorded staging directory
   * must resolve to exactly this project's own sibling staging path — any
   * other value is a malformed intent, never a directory recovery deletes.
   *
   * Before ANY staged read/write/delete/rename, every path component of
   * the staging root AND of the staged project directory is lstat-verified:
   * a symlinked or non-directory component is loud CORRUPT_DATA with the
   * intent and residue kept intact — the escape is never followed. The
   * final project path is likewise observed only through an lstat guard: a
   * planted link or non-directory there is a CONFLICT, never read through.
   * Leased recovery additionally distinguishes OWN post-promotion state
   * from a FOREIGN collision: our promotion is provable only when the
   * staged project directory is gone AND the final state carries the full
   * journaled creation identity (see `_finalStateMatchesIntent`); anything
   * else at the final path is a CONFLICT that preserves everything for
   * manual resolution.
   */
  _recoverCreationIntent(projectId, intent, intentPath) {
    const expectedStaging = path.resolve(this._creationStagingPath(projectId));
    const stagingDir =
      typeof intent.stagingDir === 'string'
        ? path.resolve(this.baseDirPath(), intent.stagingDir)
        : null;
    if (stagingDir === null || stagingDir !== expectedStaging) {
      throw createAppError(
        'CORRUPT_DATA',
        `Creation intent of project "${projectId}" records a foreign staging path.`,
      );
    }
    // Confinement gate shared by every staged operation below.
    const label = `Creation staging of project "${projectId}"`;
    const stagingPresent = this._assertRealDirectoryBelow(this.baseDirPath(), stagingDir, label);
    const stagedProjectDir = path.join(stagingDir, projectId);
    const stagedPresent = stagingPresent
      ? this._assertRealDirectoryBelow(stagingDir, stagedProjectDir, label)
      : false;

    if (intent.phase === 'prepared') {
      // The staged lease was never durably promised: discard the intent and
      // its residue without touching whatever exists at the project path.
      this._discardCreationResidue(stagingDir, intentPath);
      return;
    }

    const projectDir = this.projectDirPath(projectId);
    // Observe the final path ONLY through the lstat guard: a planted
    // symbolic link or non-directory there is a foreign collision — typed
    // failure with the intent (and any staged residue) retained — never
    // followed and never read through.
    const finalStat = lstatSafe(projectDir, `Final project path "${projectDir}"`);
    if (finalStat && (finalStat.isSymbolicLink() || !finalStat.isDirectory())) {
      throw createAppError(
        'CONFLICT',
        `Creation intent of project "${projectId}" collides with ${
          finalStat.isSymbolicLink() ? 'a symbolic link' : 'a non-directory'
        } at the final path; the intent and staged creation are preserved for manual resolution.`,
      );
    }
    const finalPresent = finalStat !== null;
    if (stagedPresent && finalPresent) {
      // Our promotion renames the staged directory AWAY in the same atomic
      // step that creates the final project — both existing at once can
      // only mean a FOREIGN project appeared at the final path.
      throw createAppError(
        'CONFLICT',
        `Creation intent of project "${projectId}" collides with a foreign project at the final path; the intent and staged creation are preserved for manual resolution.`,
      );
    }
    if (!stagedPresent) {
      if (!finalPresent) {
        throw createAppError(
          'CORRUPT_DATA',
          `Creation intent of project "${projectId}" is leased but its staged project is missing.`,
        );
      }
      if (!this._finalStateMatchesIntent(projectDir, intent)) {
        // A project exists at the final path whose bytes do not carry the
        // journaled creation identity: a foreign document/media project or
        // diverged state. Dropping the intent here would silently lose
        // the creation.
        throw createAppError(
          'CONFLICT',
          `Creation intent of project "${projectId}" does not match the project at the final path (foreign or diverged state); the intent is preserved for manual resolution.`,
        );
      }
      // Leased AND promoted (crash in the post-promote cleanup window):
      // the store holds exactly the created pair — finish the cleanup only.
      this._discardCreationResidue(stagingDir, intentPath);
      return;
    }
    // Roll forward: the staged pair is still pending and the final path is
    // free. A staged archive that is not a regular file is never promoted.
    const stagedDocPath = path.join(stagedProjectDir, DOCUMENT_FILE);
    const stagedDoc = lstatSafe(stagedDocPath, `Staged archive "${stagedDocPath}"`);
    if (stagedDoc && (stagedDoc.isSymbolicLink() || !stagedDoc.isFile())) {
      throw createAppError(
        'CORRUPT_DATA',
        `Staged archive of project "${projectId}" is ${
          stagedDoc.isSymbolicLink() ? 'a symbolic link' : 'not a regular file'
        }; refusing to promote it.`,
      );
    }
    if (!stagedDoc) {
      // Crash between the staged lease and the staged archive: the intent
      // carries the exact validated payload.
      this._applyContentPlan({ filePath: stagedDocPath, content: intent.content });
    }
    this._promoteStagedCreation(stagedProjectDir, projectDir);
    this._discardCreationResidue(stagingDir, intentPath);
  }

  /**
   * Shared mutation discipline — one serialized per-project transaction:
   *
   *   recover pending intent -> precondition -> CAS(expectedRevision)
   *   -> write-ahead intent -> revision bump (lease) -> CAS recheck
   *   -> atomic content commit -> clear intent
   *
   * `plan` describes the content side effect: `{ filePath, content }` for a
   * JSON write, `{ filePath, unlink: true }` for a removal, `null` when only
   * `project.json` changes. It may also be a FUNCTION of the precondition
   * result — for plans that depend on state only observable after recovery
   * (removeLanguage backs up the RECOVERED archive bytes and records the
   * backup path in its plan). `buildResult(newRevision)` assembles the
   * caller-facing value after the commit. `precondition`, when given, runs
   * inside the exclusive section immediately AFTER recovery and MAY return
   * a value handed to a function-plan — a state check (e.g. target
   * absence) must see the post-replay world, never the pre-replay one, and
   * a thrown precondition error aborts the transaction before any intent,
   * lease, or content side effect (backup-failure atomicity). Failures
   * BEFORE the lease leave no trace and burn no revision; failures AFTER it
   * keep the intent on disk so the very next reader or writer replays the
   * mutation (crash semantics).
   */
  _mutate(projectId, expectedRevision, plan, buildResult, projectPatch, precondition) {
    if (expectedRevision == null) {
      throw createAppError(
        'VALIDATION_FAILED',
        `expectedRevision is required to mutate document project "${projectId}".`,
      );
    }
    const projectDir = this.projectDirPath(projectId);
    return runProjectExclusive(projectDir, () => {
      this._recoverPendingMutation(projectId);
      // The precondition sees the POST-replay world; its result feeds a
      // function-plan, so plan data (e.g. a backup path) is computed after
      // recovery and the durable intent records it.
      const preconditionResult = precondition ? precondition() : undefined;
      const resolvedPlan = typeof plan === 'function' ? plan(preconditionResult) : plan;
      const projectFilePath = path.join(projectDir, 'project.json');
      if (!fileExists(projectFilePath)) {
        throw createAppError('NOT_FOUND', `Project "${projectId}" not found.`);
      }
      // CAS #1 — acquire the write lease only from the observed revision.
      const current = readRevision(projectFilePath).revision;
      if (current !== expectedRevision) {
        throw createAppError(
          'CONFLICT',
          `Revision conflict for project "${projectId}": expected "${expectedRevision}" but found "${current ?? 'none'}".`,
          { expectedRevision, currentRevision: current },
        );
      }
      const loaded = this.projectStore.loadProject(projectId);
      if (loaded.type !== 'document') {
        throw createAppError(
          'VALIDATION_FAILED',
          `Project "${projectId}" is not a document project.`,
        );
      }

      const intentPath = this._intentPath(projectId);
      if (resolvedPlan) {
        // Write-ahead: the exact payload is durable BEFORE the lease, so a
        // crash after step 4 always leaves replayable evidence.
        this._writeJsonAtomic(intentPath, {
          version: MUTATION_INTENT_VERSION,
          projectId,
          expectedRevision: current,
          action: resolvedPlan.unlink ? 'unlink' : 'write',
          targetFile: path.relative(projectDir, resolvedPlan.filePath),
          content: resolvedPlan.unlink ? null : resolvedPlan.content,
          // Present only when the plan preserved the original bytes
          // (removeLanguage backup); ignored by recovery, durable support
          // evidence for auditors.
          backupFile: resolvedPlan.backupFile,
          createdAt: nowIso(),
        });
      }
      let saved;
      let leased = false;
      try {
        saved = this.projectStore.saveProject(
          projectPatch ? { ...loaded, ...projectPatch } : loaded,
          current,
        );
        leased = true;
        // CAS #2 — the lease must still be ours the instant content lands.
        const recheck = readRevision(projectFilePath).revision;
        if (recheck !== saved.revision) {
          throw createAppError(
            'CONFLICT',
            `Lease lost for project "${projectId}" before content commit ("${recheck}" != "${saved.revision}").`,
            { expectedRevision: saved.revision, currentRevision: recheck },
          );
        }
        if (resolvedPlan) {
          this._applyContentPlan(resolvedPlan);
        }
      } catch (err) {
        if (!leased && resolvedPlan) {
          // Lease never taken: abort cleanly — nothing to replay, and the
          // caller may retry with the SAME revision.
          try {
            fs.unlinkSync(intentPath);
          } catch {
            /* ignore */
          }
        }
        throw err;
      }
      if (resolvedPlan) {
        try {
          fs.unlinkSync(intentPath);
        } catch {
          /* best effort: leftover intents replay harmlessly */
        }
      }
      return { revision: saved.revision, project: saved, ...buildResult(saved.revision) };
    });
  }

  /** Atomic JSON file write: unique temp file + fsync + rename (POSIX/NTFS). */
  _writeJsonAtomic(filePath, value) {
    const tmpPath = writeTempAtomic(filePath, JSON.stringify(value, null, 2));
    try {
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      cleanupTemp(tmpPath);
      throw err;
    }
  }
}

/** Convenience factory mirroring the other store factories. */
function createDocumentProjectStore(options) {
  return new DocumentProjectStore(options);
}

module.exports = {
  DocumentProjectStore,
  createDocumentProjectStore,
  // transaction primitive, exported for tests (lock semantics are load-bearing)
  runProjectExclusive,
  // pure helpers, shared with the coordinator/tests
  blockSourceHash,
  computeFreshness,
  MUTATION_INTENT_SUFFIX,
  MUTATION_INTENT_VERSION,
  CREATE_STAGING_SUFFIX,
  DOCUMENT_FILE,
  TRANSLATIONS_DIR,
};
