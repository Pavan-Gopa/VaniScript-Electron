'use strict';

/**
 * BAT-02 — portable folder watcher and reconciliation service.
 *
 * fs.watch is used instead of a new dependency. Watchers are only a wake-up
 * signal; the authoritative state is the canonical-folder scan and the D1
 * transactional enqueue/deduplication API. This makes lost events and process
 * restarts safe while keeping stale generations harmless.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { createAppError } = require('../../../shared/contracts/errors.ts');
const {
  assertPathWithinRoot,
  assertSafePathSyntax,
  createFolderAccessAdapter,
  isPermissionError,
} = require('./folderAccess.js');

const SUPPORTED_EXTENSIONS = Object.freeze(['aac', 'aif', 'aiff', 'flac', 'm4a', 'mp3', 'wav']);
const TEMP_EXTENSIONS = Object.freeze(['.tmp', '.partial', '.part', '.crdownload', '.download']);
const DEFAULT_STABILITY_SAMPLES = 2;
const DEFAULT_STABILITY_INTERVAL_MS = 50;
const DEFAULT_STABILITY_ATTEMPTS = 8;
const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_RECONCILIATION_INTERVAL_MS = 60_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeExtensions(value) {
  const values = Array.isArray(value) && value.length > 0 ? value : SUPPORTED_EXTENSIONS;
  return new Set(values
    .filter((extension) => typeof extension === 'string')
    .map((extension) => extension.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean));
}

function isHiddenOrTemporaryName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.startsWith('.')) return true;
  const lower = name.toLowerCase();
  if (lower.endsWith('~') || TEMP_EXTENSIONS.some((extension) => lower.endsWith(extension))) return true;
  return path.extname(lower) === '.txt';
}

function isSupportedSource(filePath, extensions) {
  if (isHiddenOrTemporaryName(path.basename(filePath))) return false;
  return extensions.has(path.extname(filePath).slice(1).toLowerCase());
}

function isSameSnapshot(left, right) {
  return Boolean(left && right && left.sizeBytes === right.sizeBytes && left.mtimeMs === right.mtimeMs);
}

function snapshotFile(filePath, options = {}) {
  const confinedPath = options.root
    ? assertPathWithinRoot(options.root, filePath).canonicalPath
    : filePath;
  const stats = fs.lstatSync(confinedPath);
  if (stats.isSymbolicLink()) {
    throw createAppError('PERMISSION_DENIED', `Refusing to fingerprint symlink "${confinedPath}".`);
  }
  if (!stats.isFile()) return null;
  return { sizeBytes: stats.size, mtimeMs: stats.mtimeMs };
}

function issueType(error, context = 'folder') {
  if (isPermissionError(error)) return 'permission-lost';
  const code = error && typeof error === 'object' ? error.code : undefined;
  if (code === 'SOURCE_CHANGED') return 'source-changed';
  if (code === 'ENOENT' || code === 'NOT_FOUND') {
    return context === 'file' ? 'source-unavailable' : 'folder-unavailable';
  }
  if (code === 'PERMISSION_DENIED') return 'path-violation';
  return 'watcher-error';
}

function issueFromError(type, profile, error, generation, extra = {}) {
  const errorCode = error && typeof error === 'object' ? error.code : undefined;
  const code = ['PERMISSION_DENIED', 'NOT_FOUND', 'SOURCE_CHANGED', 'CORRUPT_DATA', 'VALIDATION_FAILED'].includes(errorCode)
    ? errorCode
    : isPermissionError(error)
      ? 'PERMISSION_DENIED'
      : 'INTERNAL';
  return {
    type,
    code,
    profileId: profile && profile.profileId,
    generation,
    path: (profile && profile.sourcePath) || extra.file || extra.directory,
    message: error instanceof Error ? error.message : String(error),
    ...extra,
  };
}

function profileExtensions(profile, override) {
  const configured = override
    || (profile.config && (profile.config.supportedExtensions || profile.config.allowedExtensions));
  return normalizeExtensions(configured);
}


function companionPath(sourcePath) {
  const extension = path.extname(sourcePath);
  const stem = extension ? sourcePath.slice(0, -extension.length) : sourcePath;
  return `${stem}.txt`;
}

function collectDirectories(root, recursive, onIssue = () => {}, profile, generation) {
  let confinedRoot;
  try {
    confinedRoot = assertPathWithinRoot(root, root);
  } catch (error) {
    onIssue(issueFromError(issueType(error), profile, error, generation, { directory: root }));
    return [];
  }
  const canonicalRoot = confinedRoot.canonicalPath;
  const directories = [canonicalRoot];
  if (!recursive) return directories;
  const pending = [canonicalRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      onIssue(issueFromError(issueType(error), profile, error, generation, { directory: current }));
      continue;
    }
    for (const entry of entries) {
      if (isHiddenOrTemporaryName(entry.name)) continue;
      let child;
      try {
        assertSafePathSyntax(entry.name, 'Folder entry name');
        child = path.join(current, entry.name);
        const confined = assertPathWithinRoot(canonicalRoot, child);
        const stat = fs.lstatSync(confined.absolutePath);
        if (stat.isSymbolicLink()) {
          throw createAppError('PERMISSION_DENIED', `Refusing symlink directory entry "${child}".`);
        }
        if (!stat.isDirectory()) continue;
        directories.push(confined.canonicalPath);
        pending.push(confined.canonicalPath);
      } catch (error) {
        onIssue(issueFromError('path-violation', profile, error, generation, { directory: child || current, file: child }));
      }
    }
  }
  return directories;
}

function collectCandidates(root, recursive, extensions, onIssue, profile, generation) {
  const candidates = [];
  let confinedRoot;
  try {
    confinedRoot = assertPathWithinRoot(root, root);
  } catch (error) {
    onIssue(issueFromError(issueType(error), profile, error, generation, { directory: root }));
    return candidates;
  }
  const pending = [confinedRoot.canonicalPath];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      onIssue(issueFromError(issueType(error), profile, error, generation, { directory: current }));
      continue;
    }
    for (const entry of entries) {
      if (isHiddenOrTemporaryName(entry.name)) continue;
      let child;
      try {
        assertSafePathSyntax(entry.name, 'Source entry name');
        child = path.join(current, entry.name);
        const confined = assertPathWithinRoot(confinedRoot.canonicalPath, child);
        const stat = fs.lstatSync(confined.absolutePath);
        if (stat.isSymbolicLink()) {
          throw createAppError('PERMISSION_DENIED', `Refusing symlink source entry "${child}".`);
        }
        if (stat.isDirectory()) {
          if (recursive) pending.push(confined.canonicalPath);
          continue;
        }
        if (stat.isFile() && isSupportedSource(confined.canonicalPath, extensions)) {
          candidates.push(confined.canonicalPath);
        }
      } catch (error) {
        onIssue(issueFromError('path-violation', profile, error, generation, { file: child || current }));
      }
    }
  }
  return candidates.sort();
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    let fd = null;
    try {
      const noFollow = fs.constants.O_NOFOLLOW || 0;
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      const stats = fs.fstatSync(fd);
      if (!stats.isFile()) {
        fs.closeSync(fd);
        reject(createAppError('PERMISSION_DENIED', `Fingerprint target is not a regular file: ${filePath}`));
        return;
      }
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(null, { fd, autoClose: true });
      stream.on('data', (chunk) => hash.update(chunk));
      stream.once('error', reject);
      stream.once('end', () => resolve(hash.digest('hex')));
    } catch (error) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // The stream owns a successfully opened descriptor.
        }
      }
      reject(error);
    }
  });
}

async function stableSnapshot(filePath, options = {}) {
  const samples = Math.max(2, Number.isInteger(options.samples) ? options.samples : DEFAULT_STABILITY_SAMPLES);
  const intervalMs = Math.max(0, Number.isFinite(options.intervalMs) ? options.intervalMs : DEFAULT_STABILITY_INTERVAL_MS);
  const attempts = Math.max(samples, Number.isInteger(options.attempts) ? options.attempts : DEFAULT_STABILITY_ATTEMPTS);
  const wait = typeof options.sleep === 'function' ? options.sleep : sleep;
  const reportError = (error) => {
    if (typeof options.onError === 'function') options.onError(error);
  };
  let previous = null;
  let unchanged = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let current;
    try {
      current = snapshotFile(filePath, options);
    } catch (error) {
      reportError(error);
      return null;
    }
    if (!current) {
      reportError(createAppError('SOURCE_CHANGED', `Source file is unavailable or not regular: ${filePath}`));
      return null;
    }
    unchanged = isSameSnapshot(previous, current) ? unchanged + 1 : 1;
    if (unchanged >= samples) return current;
    previous = current;
    if (intervalMs > 0) await wait(intervalMs);
  }
  reportError(createAppError('SOURCE_CHANGED', `Source file changed while waiting for stability: ${filePath}`));
  return null;
}

async function fingerprintFile(filePath, options = {}) {
  const retries = Math.max(1, Number.isInteger(options.retries) ? options.retries : 2);
  const reportError = (error) => {
    if (typeof options.onError === 'function') options.onError(error);
  };
  let changedDuringHash = false;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const stable = await stableSnapshot(filePath, options);
    if (!stable) return null;
    let sha256;
    try {
      sha256 = await (typeof options.hash === 'function' ? options.hash(filePath) : hashFile(filePath));
    } catch (error) {
      reportError(error);
      return null;
    }
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) {
      reportError(createAppError('CORRUPT_DATA', `SHA-256 fingerprint is invalid for ${filePath}`));
      return null;
    }
    let verified;
    try {
      verified = snapshotFile(filePath, options);
    } catch (error) {
      reportError(error);
      return null;
    }
    if (isSameSnapshot(stable, verified)) {
      return { sizeBytes: stable.sizeBytes, mtimeMs: stable.mtimeMs, sha256: sha256.toLowerCase() };
    }
    changedDuringHash = true;
  }
  if (changedDuringHash) {
    reportError(createAppError('SOURCE_CHANGED', `Source file changed during hashing: ${filePath}`));
  }
  return null;
}

class BatchWatcher {
  constructor(options = {}) {
    if (!options.domain || typeof options.domain.listProfiles !== 'function') {
      throw createAppError('VALIDATION_FAILED', 'BatchWatcher requires a BatchDomain instance.');
    }
    this.domain = options.domain;
    this.accessAdapter = options.accessAdapter || createFolderAccessAdapter(options.platform);
    this.watchFactory = options.watchFactory || ((directory, listener) => fs.watch(directory, { persistent: false }, listener));
    this.onIssue = typeof options.onIssue === 'function' ? options.onIssue : () => {};
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
    this.debounceMs = Math.max(0, Number.isFinite(options.debounceMs) ? options.debounceMs : DEFAULT_DEBOUNCE_MS);
    this.reconciliationIntervalMs = options.reconciliationIntervalMs === null
      ? null
      : Math.max(1, Number.isFinite(options.reconciliationIntervalMs)
        ? options.reconciliationIntervalMs
        : DEFAULT_RECONCILIATION_INTERVAL_MS);
    this.stability = {
      samples: options.stabilitySamples,
      intervalMs: options.stabilityIntervalMs,
      attempts: options.stabilityAttempts,
      retries: options.stabilityRetries,
      sleep: options.sleep,
      hash: options.hash,
    };
    this.supportedExtensions = options.supportedExtensions;
    this._generationCounter = 0;
    this._activeGeneration = null;
    this._profiles = new Map();
    this._watchers = new Map();
    this._pending = new Map();
    this._inFlight = new Map();
    this._interval = null;
  }

  get generation() {
    return this._activeGeneration;
  }

  get activeProfiles() {
    return [...this._profiles.values()].map((entry) => entry.profile);
  }

  _emitIssue(issue) {
    try {
      this.onIssue(issue);
    } catch {
      // Observers cannot break reconciliation or leave a watcher half-open.
    }
  }

  _emitEvent(event) {
    try {
      this.onEvent(event);
    } catch {
      // Event observers are informational and must not bypass the domain API.
    }
  }

  _isGenerationActive(generation) {
    return generation !== null && generation === this._activeGeneration;
  }

  _closeProfileWatchers(profileId) {
    const handles = this._watchers.get(profileId) || [];
    this._watchers.delete(profileId);
    for (const watcher of handles) {
      try {
        watcher.close();
      } catch {
        // Closing an already-revoked native watcher is harmless.
      }
    }
  }

  _closeAllWatchers() {
    for (const profileId of this._watchers.keys()) this._closeProfileWatchers(profileId);
  }

  _openProfileWatchers(entry, generation) {
    const { profile } = entry;
    const directories = collectDirectories(
      profile.sourcePath,
      profile.recursive,
      (issue) => this._emitIssue(issue),
      profile,
      generation,
    );
    const handles = [];
    for (const directory of directories) {
      try {
        const watcher = this.watchFactory(directory, (eventType, filename) => {
          this.handleFsEvent(profile.profileId, generation, eventType, filename);
        });
        if (!watcher || typeof watcher.close !== 'function') {
          throw createAppError('INTERNAL', 'Folder watcher factory returned an invalid watcher.');
        }
        if (typeof watcher.on === 'function') {
          watcher.on('error', (error) => {
            if (!this._isGenerationActive(generation)) return;
            this._emitIssue(issueFromError(issueType(error), profile, error, generation, { directory }));
          });
        }
        handles.push(watcher);
      } catch (error) {
        this._emitIssue(issueFromError(issueType(error), profile, error, generation, { directory }));
      }
    }
    if (handles.length > 0) this._watchers.set(profile.profileId, handles);
  }

  async start() {
    await this.stop();
    let persistedGeneration = 0;
    if (typeof this.domain.listWatcherGenerations === 'function') {
      try {
        persistedGeneration = this.domain
          .listWatcherGenerations()
          .reduce((maximum, row) => Math.max(maximum, row.generation), 0);
      } catch {
        persistedGeneration = 0;
      }
    }
    const generation = Math.max(this._generationCounter, persistedGeneration) + 1;
    this._generationCounter = generation;
    this._activeGeneration = generation;
    const results = [];

    let profiles;
    try {
      profiles = this.domain.listProfiles({ enabled: true });
    } catch (error) {
      this._emitIssue({ type: 'watcher-error', code: 'INTERNAL', generation, message: error.message || String(error) });
      return { generation, profiles: [], results };
    }

    for (const originalProfile of profiles) {
      let resolved;
      try {
        resolved = this.accessAdapter.resolve(originalProfile.sourcePath);
      } catch (error) {
        this._emitIssue(issueFromError(issueType(error), originalProfile, error, generation));
        continue;
      }
      let profile = originalProfile;
      if (resolved.canonicalPath !== originalProfile.sourcePath || resolved.accessRef !== originalProfile.accessRef) {
        try {
          profile = this.domain.updateProfile(originalProfile.profileId, {
            sourcePath: resolved.canonicalPath,
            accessRef: resolved.accessRef,
          });
        } catch (error) {
          this._emitIssue(issueFromError('watcher-error', originalProfile, error, generation));
          continue;
        }
      }
      const entry = { profile, access: resolved };
      this._profiles.set(profile.profileId, entry);
      if (typeof this.domain.recordWatcherGeneration === 'function') {
        try {
          this.domain.recordWatcherGeneration(profile.profileId, generation);
        } catch (error) {
          this._emitIssue(issueFromError('watcher-error', profile, error, generation));
          continue;
        }
      }
      this._openProfileWatchers(entry, generation);
      results.push(await this.reconcileProfile(profile.profileId, { generation, reason: 'initial' }));
    }

    if (this.reconciliationIntervalMs !== null) {
      this._interval = setInterval(() => {
        for (const profileId of this._profiles.keys()) this._schedule(profileId, generation, null, 'periodic');
      }, this.reconciliationIntervalMs);
      if (typeof this._interval.unref === 'function') this._interval.unref();
    }
    return { generation, profiles: this.activeProfiles, results };
  }

  async stop() {
    const retiredGeneration = this._activeGeneration;
    this._activeGeneration = null;
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
    this._closeAllWatchers();
    this._profiles.clear();
    for (const [key, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ignored: true, generation: retiredGeneration, reason: 'stopped' });
      this._pending.delete(key);
    }
    const inFlight = [...this._inFlight.values()];
    if (inFlight.length > 0) await Promise.allSettled(inFlight);
  }

  handleFsEvent(profileId, generation, eventType = 'change', filename = null) {
    if (!this._isGenerationActive(generation) || !this._profiles.has(profileId)) return false;
    const entry = this._profiles.get(profileId);
    let candidate = null;
    if (filename) {
      const name = Buffer.isBuffer(filename) ? filename.toString('utf8') : String(filename);
      try {
        assertSafePathSyntax(name, 'Watcher event filename');
        const candidateInput = path.isAbsolute(name)
          ? name
          : path.resolve(entry.profile.sourcePath, name);
        const confined = assertPathWithinRoot(entry.profile.sourcePath, candidateInput, { allowMissing: true });
        candidate = confined.exists ? confined.canonicalPath : confined.absolutePath;
      } catch (error) {
        this._emitIssue(issueFromError('path-violation', entry.profile, error, generation, { file: name }));
        return true;
      }
    }
    this._schedule(profileId, generation, candidate, eventType);
    return true;
  }

  _schedule(profileId, generation, sourcePath, reason) {
    if (!this._isGenerationActive(generation) || !this._profiles.has(profileId)) {
      return Promise.resolve({ ignored: true, generation, reason: 'stale-generation' });
    }
    const key = `${profileId}:${sourcePath || '<folder>'}`;
    const existing = this._pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.resolve({ ignored: true, generation, reason: 'debounced' });
    }
    let resolvePending;
    const promise = new Promise((resolve) => { resolvePending = resolve; });
    const timer = setTimeout(async () => {
      const pending = this._pending.get(key);
      if (!pending || pending.promise !== promise) return;
      this._pending.delete(key);
      try {
        resolvePending(await this.reconcileProfile(profileId, { generation, reason }));
      } catch (error) {
        resolvePending({ ignored: false, generation, error });
      }
    }, this.debounceMs);
    this._pending.set(key, { timer, promise, resolve: resolvePending });
    return promise;
  }

  async flush() {
    while (this._pending.size > 0 || this._inFlight.size > 0) {
      const pending = [...this._pending.values()].map((entry) => entry.promise);
      const inFlight = [...this._inFlight.values()];
      await Promise.allSettled([...pending, ...inFlight]);
    }
  }

  async reconcileProfile(profileId, options = {}) {
    const generation = options.generation === undefined ? this._activeGeneration : options.generation;
    if (!this._isGenerationActive(generation) || !this._profiles.has(profileId)) {
      return { ignored: true, generation, reason: 'stale-generation' };
    }
    const existing = this._inFlight.get(profileId);
    if (existing) return existing;
    const work = this._reconcileProfile(profileId, generation, options.reason || 'explicit');
    this._inFlight.set(profileId, work);
    try {
      return await work;
    } finally {
      if (this._inFlight.get(profileId) === work) this._inFlight.delete(profileId);
    }
  }

  async _reconcileProfile(profileId, generation, reason) {
    const entry = this._profiles.get(profileId);
    if (!entry || !this._isGenerationActive(generation)) return { ignored: true, generation, reason: 'stale-generation' };
    const { profile } = entry;
    const extensions = profileExtensions(profile, this.supportedExtensions);
    const candidates = collectCandidates(
      profile.sourcePath,
      profile.recursive,
      extensions,
      (issue) => this._emitIssue(issue),
      profile,
      generation,
    );
    const enqueued = [];
    let duplicateCount = 0;
    let unstableCount = 0;
    for (const candidatePath of candidates) {
      if (!this._isGenerationActive(generation)) return { ignored: true, generation, reason: 'stale-generation' };
      let confined;
      try {
        confined = assertPathWithinRoot(profile.sourcePath, candidatePath);
      } catch (error) {
        unstableCount += 1;
        this._emitIssue(issueFromError('path-violation', profile, error, generation, { file: candidatePath }));
        continue;
      }
      const sourcePath = confined.canonicalPath;
      const relativePath = confined.relativePath;
      if (!relativePath) {
        unstableCount += 1;
        this._emitIssue(issueFromError('path-violation', profile, createAppError('PERMISSION_DENIED', `Candidate path is not relative to profile root: ${sourcePath}`), generation, { file: sourcePath }));
        continue;
      }
      const sourceFingerprint = await fingerprintFile(sourcePath, {
        ...this.stability,
        root: profile.sourcePath,
        onError: (error) => {
          const type = error && error.code === 'SOURCE_CHANGED'
            ? 'source-changed'
            : issueType(error, 'file');
          this._emitIssue(issueFromError(type, profile, error, generation, { file: sourcePath }));
        },
      });
      if (!sourceFingerprint) {
        unstableCount += 1;
        continue;
      }
      const result = this.domain.enqueueJobIfFingerprintMissing({
        profileId,
        sourcePath,
        outputPath: companionPath(sourcePath),
        configSnapshot: profile.config || {},
        sourceFingerprint,
      });
      if (result.inserted) {
        enqueued.push(result.job);
        this._emitEvent({
          type: 'job-enqueued',
          profileId,
          generation,
          reason,
          relativePath,
          job: result.job,
        });
      } else {
        duplicateCount += 1;
      }
    }
    if (profile.recursive) this._refreshProfileWatchers(profile, generation);
    return {
      ignored: false,
      generation,
      profileId,
      reason,
      scanned: candidates.length,
      enqueued,
      duplicateCount,
      unstableCount,
    };
  }

  _refreshProfileWatchers(profile, generation) {
    if (!this._isGenerationActive(generation)) return;
    this._closeProfileWatchers(profile.profileId);
    this._openProfileWatchers({ profile }, generation);
  }
}

function createBatchWatcher(options) {
  return new BatchWatcher(options);
}

module.exports = {
  BatchWatcher,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_RECONCILIATION_INTERVAL_MS,
  DEFAULT_STABILITY_INTERVAL_MS,
  DEFAULT_STABILITY_SAMPLES,
  SUPPORTED_EXTENSIONS,
  companionPath,
  createBatchWatcher,
  fingerprintFile,
  isHiddenOrTemporaryName,
  isSupportedSource,
  stableSnapshot,
};
