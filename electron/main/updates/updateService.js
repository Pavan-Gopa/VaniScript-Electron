'use strict';

/**
 * UPD-01 — Update state machine, readiness blockers, quit preparation, receipts.
 *
 * No electron-updater and no real network.  Check/download/install talk to
 * injected seams so tests (and later UPD-02 adapters) own I/O.  Automatic
 * download/install is a hard default forbid: even a caller who passes
 * autoDownload/autoInstall still cannot bypass the explicit-action gate.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createAppError, isErrorCode } = require('../../../shared/contracts/errors.ts');
const {
  UPDATE_SCHEMA_VERSION,
  UPDATE_STATES,
  UPDATE_USER_ACTIONS,
  UPDATE_BLOCKER_CATEGORIES,
  UPDATE_BLOCKER_MESSAGES,
  UPDATE_QUIT_SUBSYSTEMS,
  ALLOWED_UPDATE_TRANSITIONS,
  UPDATE_ACTIONS_ALLOWED_FROM,
  createUpdatePresentation,
  isLegalUpdateAction,
  isLegalUpdateTransition,
  isUpdateBlockerCategory,
  validateUpdateDescriptor,
  validateUpdateFeed,
  validateUpdateReceipt,
} = require('../../../shared/contracts/updates.ts');

const DEFAULT_QUIT_TIMEOUT_MS = 5000;
const DEFAULT_REMIND_LATER_MS = 4 * 60 * 60 * 1000;
const RECEIPT_FILENAME = 'update-receipt.json';

const PROBE_ALIASES = Object.freeze({
  recordingPreview: 'recordingPreviewSave',
  recordingSave: 'recordingPreviewSave',
  transcriptTranslation: 'translation',
  documentTranslation: 'translation',
  shortsTranslation: 'translation',
  shortsRender: 'shortsRenderPlanning',
  shortsPlanning: 'shortsRenderPlanning',
  documentAutosave: 'documentRecovery',
  recoveryJournal: 'documentRecovery',
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error) {
  return error && typeof error.message === 'string' && error.message.length > 0
    ? error.message
    : String(error);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function parseVersionParts(value) {
  return String(value).split('.').map((part) => {
    const numeric = Number(part);
    return Number.isInteger(numeric) ? numeric : part;
  });
}

function compareIdentities(left, right) {
  const leftParts = parseVersionParts(left.version);
  const rightParts = parseVersionParts(right.version);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index] === undefined ? 0 : leftParts[index];
    const b = rightParts[index] === undefined ? 0 : rightParts[index];
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1;
    return String(a) < String(b) ? -1 : 1;
  }
  const leftBuild = Number(left.build);
  const rightBuild = Number(right.build);
  if (Number.isInteger(leftBuild) && Number.isInteger(rightBuild) && leftBuild !== rightBuild) {
    return leftBuild < rightBuild ? -1 : 1;
  }
  if (String(left.build) === String(right.build)) return 0;
  return String(left.build) < String(right.build) ? -1 : 1;
}

function identityIsNewer(candidate, current) {
  return compareIdentities(candidate, current) > 0;
}

function raceTimeout(promise, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs === Infinity) return promise;
  if (timeoutMs <= 0) {
    return Promise.reject(createAppError('CANCELLED', `${label} timed out.`, { timedOut: true }));
  }
  let timer = null;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(createAppError('CANCELLED', `${label} timed out.`, { timedOut: true }));
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function atomicWriteString(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.pid${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8' });
    const fd = fs.openSync(tmpPath, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup */
    }
    throw error;
  }
}

function defaultDownload(descriptor, { onProgress, signal } = {}) {
  if (signal && signal.aborted) {
    throw createAppError('CANCELLED', 'Download cancelled.');
  }
  const totalBytes = descriptor.sizeBytes > 0 ? descriptor.sizeBytes : 1;
  if (typeof onProgress === 'function') {
    onProgress({ receivedBytes: totalBytes, totalBytes, fraction: 1 });
  }
  return { artifactHash: descriptor.artifactHash, artifact: null };
}

function defaultVerify(descriptor, downloadResult) {
  const expected = descriptor && descriptor.artifactHash;
  const actual = downloadResult && downloadResult.artifactHash;
  if (expected && actual && expected !== actual) {
    return { ok: false, reason: 'artifact hash mismatch' };
  }
  return { ok: true };
}

function defaultInstall() {
  return { outcome: 'success' };
}

function resolveCategory(raw) {
  if (isUpdateBlockerCategory(raw)) return raw;
  if (typeof raw === 'string' && Object.prototype.hasOwnProperty.call(PROBE_ALIASES, raw)) {
    return PROBE_ALIASES[raw];
  }
  return null;
}

function normalizeProbeResult(category, result) {
  if (result === false || result === null || result === undefined) return [];
  if (Array.isArray(result)) {
    return result.flatMap((entry) => normalizeProbeResult(category, entry));
  }
  if (result === true) {
    return [{ category, message: UPDATE_BLOCKER_MESSAGES[category] }];
  }
  if (typeof result === 'string' && result.length > 0) {
    return [{ category, message: result }];
  }
  if (isPlainObject(result)) {
    if (result.blocked === false) return [];
    const resolved = resolveCategory(result.category) || category;
    if (result.blocked === true || result.message || result.category) {
      return [{
        category: resolved,
        message: typeof result.message === 'string' && result.message.length > 0
          ? result.message
          : UPDATE_BLOCKER_MESSAGES[resolved],
        ...(result.details !== undefined ? { details: result.details } : {}),
      }];
    }
    return [{
      category,
      message: UPDATE_BLOCKER_MESSAGES[category],
      details: { reason: 'unrecognized_shape' },
    }];
  }
  if (result) {
    return [{
      category,
      message: UPDATE_BLOCKER_MESSAGES[category],
      details: { reason: 'unrecognized_shape' },
    }];
  }
  return [];
}

class UpdateService {
  constructor(options = {}) {
    if (!isPlainObject(options)) options = {};

    this.currentVersion = typeof options.currentVersion === 'string' && options.currentVersion.length > 0
      ? options.currentVersion
      : '1.0.0';
    this.currentBuild = typeof options.currentBuild === 'string' && options.currentBuild.length > 0
      ? options.currentBuild
      : '1';
    this.channel = options.channel === 'beta' ? 'beta' : 'stable';
    this.platform = typeof options.platform === 'string' && options.platform.length > 0
      ? options.platform
      : process.platform;
    this.arch = typeof options.arch === 'string' && options.arch.length > 0
      ? options.arch
      : process.arch;

    const transport = options.transport || options.feedTransport;
    if (typeof options.fetchFeed === 'function') {
      this.fetchFeed = options.fetchFeed;
    } else if (transport && typeof transport.fetch === 'function') {
      this.fetchFeed = transport.fetch.bind(transport);
    } else {
      this.fetchFeed = null;
    }

    this.downloadUpdate = typeof options.download === 'function' ? options.download : defaultDownload;
    this.verifyUpdate = typeof options.verify === 'function' ? options.verify : defaultVerify;
    this.installUpdate = typeof options.install === 'function' ? options.install : defaultInstall;
    this.assertFeedIntegrity = typeof options.assertFeedIntegrity === 'function'
      ? options.assertFeedIntegrity
      : null;
    this.requireFeedSignature = options.requireFeedSignature === true;
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.remindLaterMs = Number.isFinite(options.remindLaterMs) && options.remindLaterMs >= 0
      ? options.remindLaterMs
      : DEFAULT_REMIND_LATER_MS;
    this.quitTimeoutMs = Number.isFinite(options.quitTimeoutMs) && options.quitTimeoutMs >= 0
      ? options.quitTimeoutMs
      : DEFAULT_QUIT_TIMEOUT_MS;

    this.probes = isPlainObject(options.probes) ? options.probes : {};
    this.flushers = isPlainObject(options.flushers) ? options.flushers : {};
    this.batchScheduler = options.batchScheduler || null;
    this.batchDomain = options.batchDomain || null;

    this.receiptPath = typeof options.receiptPath === 'string' && options.receiptPath.length > 0
      ? options.receiptPath
      : null;
    this._receipt = null;

    this._state = 'idle';
    this._descriptor = null;
    this._download = null;
    this._error = null;
    this._lastCheckedAt = null;
    this._lastAction = null;
    this._skippedVersions = new Set(
      Array.isArray(options.skippedVersions)
        ? options.skippedVersions.filter((value) => typeof value === 'string' && value.length > 0)
        : typeof options.skippedVersion === 'string' && options.skippedVersion.length > 0
          ? [options.skippedVersion]
          : [],
    );
    this._skippedVersion = this._skippedVersions.size > 0
      ? Array.from(this._skippedVersions).at(-1)
      : null;
    this._remindLaterUntil = typeof options.remindLaterUntil === 'string' ? options.remindLaterUntil : null;
    this._generation = 0;
    this._abort = null;
    this._downloadResult = null;

    if (this.receiptPath) this._receipt = this._readReceiptFile();
    else if (options.receipt && validateUpdateReceipt(options.receipt).ok) {
      this._receipt = validateUpdateReceipt(options.receipt).value;
    }
  }

  get state() {
    return this._state;
  }

  getState() {
    return {
      schemaVersion: UPDATE_SCHEMA_VERSION,
      state: this._state,
      currentVersion: this.currentVersion,
      currentBuild: this.currentBuild,
      channel: this.channel,
      platform: this.platform,
      arch: this.arch,
      descriptor: cloneJson(this._descriptor),
      lastCheckedAt: this._lastCheckedAt,
      download: cloneJson(this._download),
      error: cloneJson(this._error),
      skippedVersion: this._skippedVersion,
      remindLaterUntil: this._remindLaterUntil,
      lastAction: this._lastAction,
      presentation: createUpdatePresentation(this._descriptor),
    };
  }

  getReceipt() {
    return cloneJson(this._receipt) || null;
  }

  collectBlockers() {
    const blockers = [];
    const seen = new Set();
    const push = (entry) => {
      if (!entry || !isUpdateBlockerCategory(entry.category)) return;
      const key = `${entry.category}:${entry.message}`;
      if (seen.has(key)) return;
      seen.add(key);
      blockers.push(entry);
    };

    for (const category of UPDATE_BLOCKER_CATEGORIES) {
      const probe = this.probes[category];
      if (typeof probe !== 'function') continue;
      try {
        normalizeProbeResult(category, probe()).forEach(push);
      } catch (error) {
        push({
          category,
          message: errorMessage(error),
          details: { probeFailed: true },
        });
      }
    }

    for (const [alias, category] of Object.entries(PROBE_ALIASES)) {
      const probe = this.probes[alias];
      if (typeof probe !== 'function') continue;
      try {
        normalizeProbeResult(category, probe()).forEach(push);
      } catch (error) {
        push({
          category,
          message: errorMessage(error),
          details: { probeFailed: true },
        });
      }
    }

    if (typeof this.probes.batchCurrentJob !== 'function') {
      const job = this.batchScheduler && this.batchScheduler.activeJob;
      if (job) {
        push({
          category: 'batchCurrentJob',
          message: job.jobId
            ? `Batch job ${job.jobId} is currently running.`
            : UPDATE_BLOCKER_MESSAGES.batchCurrentJob,
          details: { jobId: job.jobId || null },
        });
      }
    }

    return blockers;
  }

  /** Negative budgets are rejected; zero is valid and yields an immediate not-ready timeout. */
  async prepareForUpdateTermination(timeoutMs) {
    const budget = timeoutMs === undefined ? this.quitTimeoutMs : timeoutMs;
    if (!Number.isFinite(budget) || budget < 0) {
      throw createAppError('VALIDATION_FAILED', 'prepareForUpdateTermination timeoutMs must be a non-negative number.');
    }

    const outcomes = {
      settings: 'skipped',
      projects: 'skipped',
      sqlite: 'skipped',
      recovery: 'skipped',
    };
    const errors = {};
    const started = Date.now();

    for (const subsystem of UPDATE_QUIT_SUBSYSTEMS) {
      const flusher = this._flusherFor(subsystem);
      if (typeof flusher !== 'function') continue;
      const remaining = budget - (Date.now() - started);
      if (remaining <= 0) {
        outcomes[subsystem] = 'timeout';
        errors[subsystem] = `${subsystem} timed out.`;
        continue;
      }
      try {
        await raceTimeout(Promise.resolve().then(() => flusher()), remaining, subsystem);
        outcomes[subsystem] = 'ok';
      } catch (error) {
        const timedOut = Boolean(error && error.details && error.details.timedOut);
        outcomes[subsystem] = timedOut ? 'timeout' : 'failed';
        errors[subsystem] = errorMessage(error);
      }
    }

    const timedOut = UPDATE_QUIT_SUBSYSTEMS.some((name) => outcomes[name] === 'timeout');
    const failed = UPDATE_QUIT_SUBSYSTEMS.some((name) => outcomes[name] === 'failed' || outcomes[name] === 'timeout');
    return {
      schemaVersion: UPDATE_SCHEMA_VERSION,
      ready: !failed,
      timedOut,
      timeoutMs: budget,
      outcomes,
      errors,
    };
  }

  async checkNow() {
    this._assertAction('checkNow');
    this._lastAction = 'checkNow';
    this._error = null;
    this._download = null;
    this._transition('checking');
    const generation = this._beginOperation();

    try {
      if (typeof this.fetchFeed !== 'function') {
        throw createAppError('VALIDATION_FAILED', 'UpdateService requires an injected feed transport.');
      }
      const query = {
        currentVersion: this.currentVersion,
        currentBuild: this.currentBuild,
        channel: this.channel,
        platform: this.platform,
        arch: this.arch,
      };
      const raw = await this.fetchFeed(query);
      if (!this._isCurrent(generation)) return this.getState();
      const feed = this._normalizeFeed(raw);
      this._lastCheckedAt = this.now().toISOString();
      const selected = this._selectUpdate(feed.updates);
      if (!selected) {
        this._descriptor = null;
        this._transition('upToDate');
        return this.getState();
      }
      this._descriptor = selected;
      this._transition('available');
      return this.getState();
    } catch (error) {
      if (!this._isCurrent(generation)) return this.getState();
      this._fail(error);
      throw this._rethrow(error);
    }
  }

  async downloadNow() {
    this._assertAction('downloadNow');
    if (!this._descriptor) {
      throw createAppError('VALIDATION_FAILED', 'downloadNow requires an available update descriptor.');
    }
    this._lastAction = 'downloadNow';
    this._error = null;
    this._transition('downloading');
    const generation = this._beginOperation();
    const controller = new AbortController();
    this._abort = controller;
    const totalBytes = this._descriptor.sizeBytes > 0 ? this._descriptor.sizeBytes : 1;
    this._download = { receivedBytes: 0, totalBytes, fraction: 0 };

    try {
      const result = await this.downloadUpdate(this._descriptor, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (!this._isCurrent(generation) || this._state !== 'downloading') return;
          const received = Number(progress && progress.receivedBytes) || 0;
          const total = Number(progress && progress.totalBytes) || totalBytes;
          this._download = {
            receivedBytes: received,
            totalBytes: total,
            fraction: total > 0 ? Math.min(1, received / total) : 0,
          };
        },
      });
      if (!this._isCurrent(generation)) return this.getState();
      this._downloadResult = result || null;
      this._transition('verifying');
      const verification = await this.verifyUpdate(this._descriptor, result || {});
      if (!this._isCurrent(generation)) return this.getState();
      if (!verification || verification.ok === false) {
        throw createAppError(
          'CORRUPT_DATA',
          (verification && verification.reason) || 'Downloaded update failed verification.',
        );
      }
      this._download = { receivedBytes: totalBytes, totalBytes, fraction: 1 };
      this._transition('readyToInstall');
      return this.getState();
    } catch (error) {
      if (!this._isCurrent(generation)) return this.getState();
      if (error && (error.code === 'CANCELLED' || (this._abort && this._abort.signal.aborted))) {
        this._download = null;
        this._transition('available');
        return this.getState();
      }
      this._fail(error);
      throw this._rethrow(error);
    } finally {
      if (this._isCurrent(generation)) this._abort = null;
    }
  }

  async installNow() {
    this._assertAction('installNow');
    if (!this._descriptor) {
      throw createAppError('VALIDATION_FAILED', 'installNow requires a ready update descriptor.');
    }
    this._lastAction = 'installNow';

    const blockers = this.collectBlockers();
    if (blockers.length > 0) {
      throw createAppError('UPDATE_BLOCKED', 'Install refused while readiness blockers are present.', {
        kind: 'blockers',
        reasons: blockers,
      });
    }

    const preparation = await this.prepareForUpdateTermination(this.quitTimeoutMs);
    if (!preparation.ready) {
      throw createAppError('UPDATE_BLOCKED', 'Install refused because quit preparation did not complete.', {
        kind: 'quit-prep',
        reasons: Object.entries(preparation.errors).map(([subsystem, message]) => ({
          subsystem,
          message,
          outcome: preparation.outcomes[subsystem],
        })),
        preparation,
      });
    }

    this._error = null;
    this._transition('installing');
    const generation = this._beginOperation();
    try {
      const installed = await this.installUpdate(this._descriptor, {
        artifact: this._downloadResult,
      });
      if (!this._isCurrent(generation)) return this.getState();
      const outcome = installed && installed.outcome === 'failed' ? 'failed' : 'success';
      const receipt = this._writeReceipt(outcome);
      if (outcome === 'failed') {
        throw createAppError('INTERNAL', 'Update installation reported failure.', { receipt });
      }
      this._descriptor = null;
      this._download = null;
      this._downloadResult = null;
      this._transition('idle');
      return { state: this.getState(), receipt };
    } catch (error) {
      if (!this._isCurrent(generation)) return this.getState();
      if (!this._receipt || this._receipt.outcome !== 'failed') {
        try {
          this._writeReceipt('failed');
        } catch {
          /* receipt failure is secondary to the install error */
        }
      }
      this._fail(error);
      throw this._rethrow(error);
    }
  }

  skipVersion() {
    this._assertAction('skipVersion');
    this._lastAction = 'skipVersion';
    if (this._descriptor) {
      this._skippedVersions.add(this._descriptor.version);
      this._skippedVersion = this._descriptor.version;
    }
    this._descriptor = null;
    this._download = null;
    this._downloadResult = null;
    this._error = null;
    this._transition('idle');
    return this.getState();
  }

  remindLater() {
    this._assertAction('remindLater');
    this._lastAction = 'remindLater';
    this._remindLaterUntil = new Date(this.now().getTime() + this.remindLaterMs).toISOString();
    this._descriptor = null;
    this._download = null;
    this._downloadResult = null;
    this._error = null;
    this._transition('idle');
    return this.getState();
  }

  cancelDownload() {
    this._assertAction('cancelDownload');
    this._lastAction = 'cancelDownload';
    this._generation += 1;
    if (this._abort) this._abort.abort();
    this._abort = null;
    this._download = null;
    this._downloadResult = null;
    this._error = null;
    this._transition('available');
    return this.getState();
  }

  async retry() {
    this._assertAction('retry');
    const action = this._lastAction;
    if (action === 'downloadNow' && this._descriptor) {
      this._error = null;
      this._transition('available');
      return this.downloadNow();
    }
    if (action === 'installNow' && this._descriptor) {
      this._error = null;
      this._transition('readyToInstall');
      return this.installNow();
    }
    this._error = null;
    this._transition('idle');
    return this.checkNow();
  }

  _flusherFor(subsystem) {
    if (typeof this.flushers[subsystem] === 'function') return this.flushers[subsystem];
    if (subsystem === 'sqlite' && this.batchDomain && typeof this.batchDomain.checkpointWal === 'function') {
      return () => this.batchDomain.checkpointWal();
    }
    return null;
  }

  _assertAction(action) {
    if (!isLegalUpdateAction(this._state, action)) {
      throw createAppError('CONFLICT', `Action ${action} is not legal from state ${this._state}.`, {
        from: this._state,
        action,
        allowedFrom: UPDATE_ACTIONS_ALLOWED_FROM[action],
      });
    }
  }

  _transition(next) {
    if (!isLegalUpdateTransition(this._state, next)) {
      throw createAppError('CONFLICT', `Illegal update transition ${this._state} -> ${next}.`, {
        from: this._state,
        to: next,
        allowed: ALLOWED_UPDATE_TRANSITIONS[this._state],
      });
    }
    this._state = next;
  }

  _beginOperation() {
    this._generation += 1;
    return this._generation;
  }

  _isCurrent(generation) {
    return generation === this._generation;
  }

  _normalizeError(error) {
    const originalCode = error && error.code;
    const message = errorMessage(error);
    if (isErrorCode(originalCode)) {
      return {
        code: originalCode,
        message,
        ...(error && error.details !== undefined ? { details: error.details } : {}),
      };
    }
    if (typeof originalCode === 'string') {
      return {
        code: 'INTERNAL',
        message,
        details: { originalCode, originalMessage: message },
      };
    }
    return {
      code: 'INTERNAL',
      message,
      ...(error && error.details !== undefined ? { details: error.details } : {}),
    };
  }

  _fail(error) {
    this._error = this._normalizeError(error);
    if (this._state !== 'failed') this._transition('failed');
  }

  _rethrow(error) {
    if (error && error.name === 'AppError' && isErrorCode(error.code)) return error;
    const normalized = this._normalizeError(error);
    return createAppError(normalized.code, normalized.message, normalized.details);
  }

  _inspectFeed(raw) {
    if (this.requireFeedSignature) {
      const signature = raw && typeof raw === 'object' ? raw.signature || raw.feedSignature : null;
      if (typeof signature !== 'string' || signature.length === 0) {
        throw createAppError('CORRUPT_DATA', 'Update feed is missing a required signature.');
      }
    }
    if (this.assertFeedIntegrity) {
      const verdict = this.assertFeedIntegrity(raw);
      if (verdict === false || (verdict && verdict.ok === false)) {
        throw createAppError(
          'CORRUPT_DATA',
          (verdict && (verdict.reason || verdict.message)) || 'Update feed failed integrity check.',
          verdict && typeof verdict === 'object' ? verdict : { ok: false },
        );
      }
    }
  }

  _normalizeFeed(raw) {
    this._inspectFeed(raw);
    if (raw === null || raw === undefined) {
      return { schemaVersion: UPDATE_SCHEMA_VERSION, channel: this.channel, updates: [], signature: null };
    }
    if (Array.isArray(raw)) {
      const updates = raw.map((entry, index) => {
        const result = validateUpdateDescriptor(entry);
        if (!result.ok) {
          throw createAppError('CORRUPT_DATA', `Feed update[${index}] is invalid.`, {
            cause: result.error.message,
          });
        }
        return result.value;
      });
      return { schemaVersion: UPDATE_SCHEMA_VERSION, channel: this.channel, updates, signature: null };
    }
    if (isPlainObject(raw) && Array.isArray(raw.updates)) {
      const result = validateUpdateFeed(raw);
      if (!result.ok) throw result.error;
      return result.value;
    }
    if (isPlainObject(raw) && raw.version) {
      const result = validateUpdateDescriptor(raw);
      if (!result.ok) throw createAppError('CORRUPT_DATA', result.error.message);
      return {
        schemaVersion: UPDATE_SCHEMA_VERSION,
        channel: result.value.channel,
        updates: [result.value],
        signature: raw.signature || result.value.feedSignature,
      };
    }
    throw createAppError('CORRUPT_DATA', 'Update feed payload is not a recognized document.');
  }

  _selectUpdate(updates) {
    const current = { version: this.currentVersion, build: this.currentBuild };
    let selected = null;
    for (const candidate of updates) {
      if (candidate.channel && candidate.channel !== this.channel) continue;
      if (candidate.platform && candidate.platform !== this.platform) continue;
      if (candidate.arch && candidate.arch !== this.arch) continue;
      if (this._skippedVersions.has(candidate.version)) continue;
      if (!identityIsNewer(candidate, current)) continue;
      if (!selected || identityIsNewer(candidate, selected)) selected = candidate;
    }
    return selected;
  }

  _writeReceipt(outcome) {
    const descriptor = this._descriptor;
    const timestamp = this.now().toISOString();
    const receipt = {
      schemaVersion: UPDATE_SCHEMA_VERSION,
      fromVersion: this.currentVersion,
      toVersion: descriptor ? descriptor.version : this.currentVersion,
      fromBuild: this.currentBuild,
      toBuild: descriptor ? descriptor.build : this.currentBuild,
      timestamp,
      channel: this.channel,
      outcome,
      artifactHash: descriptor ? descriptor.artifactHash : null,
    };
    const validated = validateUpdateReceipt(receipt);
    if (!validated.ok) throw validated.error;
    this._receipt = validated.value;
    if (this.receiptPath) {
      atomicWriteString(this.receiptPath, `${JSON.stringify(validated.value, null, 2)}\n`);
    }
    return cloneJson(this._receipt);
  }

  _readReceiptFile() {
    try {
      if (!this.receiptPath || !fs.existsSync(this.receiptPath)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.receiptPath, 'utf8'));
      const validated = validateUpdateReceipt(parsed);
      return validated.ok ? validated.value : null;
    } catch {
      return null;
    }
  }
}

function createUpdateService(options) {
  return new UpdateService(options);
}

module.exports = {
  UpdateService,
  createUpdateService,
  RECEIPT_FILENAME,
  DEFAULT_QUIT_TIMEOUT_MS,
  DEFAULT_REMIND_LATER_MS,
  UPDATE_STATES,
  UPDATE_USER_ACTIONS,
  UPDATE_BLOCKER_CATEGORIES,
  ALLOWED_UPDATE_TRANSITIONS,
  UPDATE_ACTIONS_ALLOWED_FROM,
  isLegalUpdateTransition,
  isLegalUpdateAction,
  compareUpdateIdentities: compareIdentities,
};
