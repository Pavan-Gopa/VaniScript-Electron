'use strict';

const fs = require('fs');
const path = require('path');

const {
  SHORTS_EXPORT_CONTRACT,
  isSafeString,
  deepCloneDeepFreeze,
  shortsExportFileName,
  validateShortsExportSnapshot,
} = require('../shared/shorts-export-contract.js');
const SAFE_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function isCancellationError(error) {
  return error?.code === 'EXPORT_CANCELLED'
    || error?.code === 'CANCELLED'
    || error?.name === 'AbortError'
    || error?.name === 'RenderCancelledError'
    || error?.message === 'render_cancelled'
    || error?.message === 'Export cancelled';
}

function createCancellationError() {
  const error = new Error('Export cancelled');
  error.code = 'EXPORT_CANCELLED';
  error.name = 'RenderCancelledError';
  return error;
}

function createFailureError(result) {
  if (result instanceof Error) return result;
  const error = new Error(result?.error || result?.message || 'HyperFrames render failed.');
  if (result?.errorCode || result?.code) error.code = result.errorCode || result.code;
  if (result?.stderr) error.stderr = result.stderr;
  return error;
}

function errorCode(error) {
  const value = error?.errorCode || error?.code;
  return isSafeString(value) ? value : undefined;
}

function eventText(value, fallback = '') {
  const text = typeof value === 'string' ? value : fallback;
  return text.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 2000);
}
function errorMessage(error, fallback) {
  const value = error?.message || error?.error || error;
  return typeof value === 'string' ? value : fallback;
}

function normalizeOutputPath(outputPath) {
  const resolved = path.resolve(outputPath);
  if (!path.isAbsolute(resolved)) throw new TypeError('Output path must resolve to an absolute path.');
  return resolved;
}

function partialPathFor(finalPath, jobId) {
  return path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.${jobId}.partial`);
}

function rejectedStart(errorCodeValue, message, extra = {}) {
  return {
    success: false,
    error: message,
    errorCode: errorCodeValue,
    message,
    ...extra,
  };
}

function defaultRemovePath(filePath) {
  fs.rmSync(filePath, { recursive: true, force: true });
}

function defaultAtomicCommit(partialPath, finalPath) {
  // link(2) creates the destination without replacing an externally-created
  // final path; both files are in the same output directory by construction.
  fs.linkSync(partialPath, finalPath);
  try {
    fs.unlinkSync(partialPath);
  } catch (error) {
    // The final link is still owned by this session and cleanup will remove it.
    error.ownedFinalPath = finalPath;
    throw error;
  }
}

function createHyperFramesExportCoordinator(options = {}) {
  const {
    app,
    log = console,
    sendEvent = options.emit || options.onEvent || (() => {}),
    getFfmpegPath,
    ffmpegPath,
    userDataPath,
    getUserDataPath,
    runtimeRoot,
    renderShortClip,
    renderShortClipWithHyperFrames,
    render,
    renderClip,
    removePath = options.cleanupPath || options.remove || defaultRemovePath,
    cleanupSession = options.cleanupSession || (typeof options.cleanup === 'function' ? options.cleanup : null),
    atomicCommit = options.renamePartial || options.commitPartial || defaultAtomicCommit,
  } = options;
  const renderFunction = renderShortClip || renderShortClipWithHyperFrames || renderClip || render || function defaultRender(...args) {
    const renderer = require('./hyperframes-renderer');
    return renderer.renderShortClipWithHyperFrames(...args);
  };
  const registry = new Map();
  let activeJobId = null;

  function getRootPath() {
    if (runtimeRoot) return path.resolve(runtimeRoot);
    const base = typeof getUserDataPath === 'function'
      ? getUserDataPath()
      : userDataPath || app?.getPath?.('userData');
    if (!isSafeString(base)) throw new Error('Main userData path is unavailable.');
    return path.join(path.resolve(base), 'HyperFramesRuntime');
  }

  function safeSend(event) {
    try {
      const result = sendEvent(event);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (_error) {
      // A closed renderer must not interrupt render or cleanup ownership.
    }
  }

  function emitProgress(session, payload = {}, expectedClipIndex = null) {
    if (session.terminalEmitted) return;
    if (expectedClipIndex !== null && session.activeClipIndex !== expectedClipIndex) return;
    const progressPayload = payload && typeof payload === 'object' ? payload : {};
    const clipIndex = expectedClipIndex !== null
      ? expectedClipIndex
      : session.activeClipIndex ?? 0;
    const producerProgress = Number(progressPayload.progress);
    const progress = Number.isFinite(producerProgress) ? Math.min(1, Math.max(0, producerProgress)) : 0;
    const overall = Math.min(1, Math.max(0, (clipIndex + progress) / session.total));
    session.lastProgress = Math.max(session.lastProgress, overall);
    session.sequence += 1;
    safeSend({
      jobId: session.jobId,
      sequence: session.sequence,
      kind: 'progress',
      clipIndex,
      completed: session.completed,
      current: clipIndex + 1,
      total: session.total,
      progress: session.lastProgress,
      stage: isSafeString(progressPayload.stage, true) ? eventText(progressPayload.stage, 'render') : 'render',
      message: isSafeString(progressPayload.message, true) ? eventText(progressPayload.message) : '',
    });
  }

  function emitStarting(session) {
    if (session.terminalEmitted) return;
    session.sequence = 1;
    safeSend({
      jobId: session.jobId,
      sequence: 1,
      kind: 'starting',
      clipIndex: 0,
      completed: 0,
      current: 1,
      total: session.total,
      progress: 0,
      stage: 'prepare',
      message: 'Preparing render job',
    });
  }

  function emitTerminal(session, state, failure, cleanupComplete) {
    if (session.terminalEmitted) return session.terminalEvent;
    session.terminalEmitted = true;
    const success = state === 'succeeded';
    const event = {
      jobId: session.jobId,
      sequence: session.sequence + 1,
      kind: 'terminal',
      state,
      progress: success ? 1 : session.lastProgress,
      total: session.total,
      completed: session.completed,
      outputs: success ? session.snapshot.clips.map((clip) => clip.outputPath) : [],
      message: success
        ? 'Export complete'
        : state === 'cancelled'
          ? 'Export cancelled'
          : eventText(errorMessage(failure, 'HyperFrames export failed.'), 'HyperFrames export failed.'),
      cleanupComplete: !!cleanupComplete,
    };
    const code = errorCode(failure);
    if (!success && code) event.errorCode = code;
    if (state === 'failed' && session.activeClipIndex !== null && session.activeClipIndex !== undefined) {
      event.failedClipIndex = session.activeClipIndex;
      event.failedStableID = session.snapshot.clips[session.activeClipIndex]?.stableID;
    }
    session.sequence = event.sequence;
    session.terminalEvent = deepCloneDeepFreeze(event);
    safeSend(session.terminalEvent);
    return session.terminalEvent;
  }

  function canonicalizeSnapshot(snapshot) {
    const cloned = deepCloneDeepFreeze(snapshot);
    const clips = cloned.clips.map((clip) => ({
      ...clip,
      outputPath: normalizeOutputPath(clip.outputPath),
    }));
    const canonical = {
      ...cloned,
      clips,
    };
    const validation = validateShortsExportSnapshot(canonical);
    if (!validation.ok) throw new TypeError(validation.issues.map((issue) => `${issue.code} at ${issue.path}: ${issue.message}`).join('; '));
    return deepCloneDeepFreeze(canonical);
  }

  function preflight(snapshot) {
    const finalPaths = new Set();
    const partialPaths = new Set();
    const outputParents = new Set();
    const sourcePath = path.resolve(snapshot.source.inputVideoPath);
    for (const clip of snapshot.clips) {
      const finalPath = normalizeOutputPath(clip.outputPath);
      if (finalPath === sourcePath) {
        return rejectedStart('INVALID_OUTPUT_PATH', 'Output path must differ from the source input path.');
      }
      if (path.basename(finalPath) !== clip.fileName) {
        return rejectedStart('INVALID_RENDER_SNAPSHOT', `Output path does not end with filename: ${clip.fileName}.`);
      }
      if (finalPaths.has(finalPath)) return rejectedStart('DUPLICATE_OUTPUT_PATH', `Output path occurs more than once: ${finalPath}.`);
      finalPaths.add(finalPath);
      const parent = path.dirname(finalPath);
      outputParents.add(parent);
      try {
        if (!fs.statSync(parent).isDirectory()) return rejectedStart('INVALID_OUTPUT_DIRECTORY', `Output directory is not a directory: ${parent}.`);
      } catch (_error) {
        return rejectedStart('INVALID_OUTPUT_DIRECTORY', `Output directory does not exist: ${parent}.`);
      }
      if (fs.existsSync(finalPath)) return rejectedStart('OUTPUT_EXISTS', `Output already exists: ${finalPath}.`);
      const partialPath = partialPathFor(finalPath, snapshot.jobId);
      if (partialPaths.has(partialPath)) return rejectedStart('DUPLICATE_PARTIAL_PATH', `Partial output path occurs more than once: ${partialPath}.`);
      if (fs.existsSync(partialPath)) return rejectedStart('OUTPUT_PARTIAL_EXISTS', `Partial output already exists: ${partialPath}.`);
      partialPaths.add(partialPath);
    }
    if (!isSafeString(snapshot.source.inputVideoPath)) {
      return rejectedStart('INVALID_SOURCE_PATH', 'Source input video path must be a non-empty path.');
    }
    return { ok: true, finalPaths, partialPaths, outputParents };
  }

  async function removePaths(paths) {
    const errors = [];
    for (const filePath of paths) {
      try {
        const result = await removePath(filePath);
        if (result === false) throw new Error(`Cleanup refused path: ${filePath}`);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  async function cleanup(session, preserveOutputs) {
    if (cleanupSession) {
      try {
        const result = await cleanupSession({
          session,
          preserveOutputs,
          partialPaths: [...session.partialPaths],
          ownedFinalPaths: [...session.ownedFinalPaths],
          runtimeDir: session.runtimeDir,
        });
        return result === false ? [new Error('Injected cleanup refused the session.')] : [];
      } catch (error) {
        return [error];
      }
    }

    const paths = [...session.partialPaths];
    if (!preserveOutputs) paths.push(...session.ownedFinalPaths);
    if (session.runtimeCreated) paths.push(session.runtimeDir);
    return removePaths(paths);
  }

  async function runSession(session) {
    let state = 'succeeded';
    let failure = null;
    try {
      fs.mkdirSync(path.dirname(session.runtimeDir), { recursive: true });
      fs.mkdirSync(session.runtimeDir);
      session.runtimeCreated = true;
      emitStarting(session);
      for (let index = 0; index < session.snapshot.clips.length; index += 1) {
        const clip = session.snapshot.clips[index];
        session.activeClipIndex = index;
        if (session.cancelRequested) throw createCancellationError();
        const partialPath = partialPathFor(clip.outputPath, session.jobId);
        session.partialPaths.add(partialPath);
        let result;
        try {
          result = await Promise.resolve(renderFunction({
            app,
            project: clip.project,
            inputVideoPath: session.snapshot.source.inputVideoPath,
            outputPath: partialPath,
            format: session.snapshot.options.format,
            qualityPreset: session.snapshot.options.qualityPreset,
            ffmpegPath: typeof getFfmpegPath === 'function' ? getFfmpegPath() : ffmpegPath,
            log,
            abortSignal: session.controller.signal,
            runtimeDir: session.runtimeDir,
            runtimeChildDir: session.runtimeDir,
            onProgress: (payload) => emitProgress(session, payload, index),
          }));
        } catch (error) {
          throw error;
        }
        if (session.cancelRequested || session.controller.signal.aborted || result?.cancelled) throw createCancellationError();
        if (result && result.success === false) throw createFailureError(result);
        if (!fs.existsSync(partialPath)) {
          const missing = new Error(`Renderer did not create partial output: ${partialPath}`);
          missing.code = 'OUTPUT_MISSING';
          throw missing;
        }
        if (session.cancelRequested || session.controller.signal.aborted) throw createCancellationError();
        try {
          atomicCommit(partialPath, clip.outputPath);
        } catch (error) {
          if (error?.ownedFinalPath === clip.outputPath) session.ownedFinalPaths.add(clip.outputPath);
          throw error;
        }
        session.partialPaths.delete(partialPath);
        session.ownedFinalPaths.add(clip.outputPath);
        session.completed = index + 1;
        session.activeClipIndex = index;
        emitProgress(session, {
          clipIndex: index,
          progress: 1,
          stage: 'complete',
          message: `Completed clip ${index + 1} of ${session.total}`,
        }, index);
        session.activeClipIndex = null;
      }
      if (session.cancelRequested || session.controller.signal.aborted) throw createCancellationError();
      // Commit success before asynchronous cleanup so a late cancel cannot
      // delete already-committed user outputs.
      state = 'succeeded';
      session.state = state;
      session.lastProgress = 1;
    } catch (error) {
      failure = error;
      if (session.cancelRequested || session.controller.signal.aborted || isCancellationError(error)) {
        state = 'cancelled';
        failure = null;
        // Keep the registered session in cancelling state until cleanup has
        // settled; repeated cancel requests remain idempotent in that window.
        session.state = 'cancelling';
      } else {
        state = 'failed';
        session.state = state;
      }
    } finally {
      let cleanupErrors = await cleanup(session, state === 'succeeded');
      if (cleanupErrors.length > 0) {
        // A cleanup failure is never reported as a clean success/cancel. If a
        // successful batch left runtime/output residue, make a best effort to
        // restore atomic batch semantics before reporting the visible failure.
        if (state === 'succeeded') {
          const retryErrors = await cleanup(session, false);
          cleanupErrors = cleanupErrors.concat(retryErrors);
        }
        state = 'failed';
        failure = new Error(errorMessage(cleanupErrors[0], 'HyperFrames export cleanup failed.'));
        failure.code = 'CLEANUP_FAILED';
        session.state = state;
      }
      if (state === 'cancelled' && cleanupErrors.length === 0) session.state = 'cancelled';
      const terminal = emitTerminal(session, state, failure, cleanupErrors.length === 0);
      registry.delete(session.jobId);
      if (activeJobId === session.jobId) activeJobId = null;
      return terminal;
    }
  }

  function start(snapshot) {
    const validation = validateShortsExportSnapshot(snapshot);
    if (!validation.ok) {
      const message = validation.issues.map((issue) => `${issue.code} at ${issue.path}: ${issue.message}`).join('; ');
      return rejectedStart('INVALID_RENDER_SNAPSHOT', `Invalid render snapshot: ${message}`, { issues: validation.issues });
    }
    let canonical;
    try {
      canonical = canonicalizeSnapshot(snapshot);
    } catch (error) {
      return rejectedStart('INVALID_RENDER_SNAPSHOT', `Invalid render snapshot: ${errorMessage(error, 'snapshot normalization failed')}`);
    }
    if (!SAFE_JOB_ID_PATTERN.test(canonical.jobId)) {
      return rejectedStart('INVALID_RENDER_SNAPSHOT', 'Render snapshot jobId must be a safe path segment.');
    }
    if (activeJobId) {
      if (activeJobId === canonical.jobId) return rejectedStart('EXPORT_DUPLICATE', `Export job ${canonical.jobId} is already active.`);
      return rejectedStart('EXPORT_BUSY', `Export job ${activeJobId} is already active.`);
    }
    const check = preflight(canonical);
    if (!check.ok) return check;
    let runtimeDir;
    try {
      runtimeDir = path.join(getRootPath(), canonical.jobId);
      if (fs.existsSync(runtimeDir)) return rejectedStart('RUNTIME_COLLISION', `Runtime directory already exists: ${runtimeDir}.`);
    } catch (error) {
      return rejectedStart('INVALID_RUNTIME_DIRECTORY', errorMessage(error, 'Unable to resolve HyperFrames runtime directory.'));
    }

    const controller = new AbortController();
    const session = {
      jobId: canonical.jobId,
      snapshot: canonical,
      controller,
      state: 'running',
      cancelRequested: false,
      sequence: 0,
      lastProgress: 0,
      activeClipIndex: null,
      runtimeDir,
      partialPaths: new Set(),
      ownedFinalPaths: new Set(),
      terminalEmitted: false,
      runtimeCreated: false,
      completed: 0,
      total: canonical.clips.length,
      promise: null,
      terminalEvent: null,
    };
    registry.set(session.jobId, session);
    activeJobId = session.jobId;
    session.promise = runSession(session);
    return session.promise;
  }

  function cancel(payload = {}) {
    const jobId = typeof payload === 'string' ? payload : payload?.jobId;
    const session = registry.get(typeof jobId === 'string' ? jobId : '');
    if (!session) {
      return {
        success: false,
        accepted: false,
        state: 'not_found',
        errorCode: 'EXPORT_NOT_FOUND',
        error: 'No active HyperFrames export job.',
      };
    }
    if (session.state === 'running') {
      session.cancelRequested = true;
      session.state = 'cancelling';
      try { session.controller.abort(new Error('Export cancelled')); } catch (_error) { session.controller.abort(); }
      return { success: true, accepted: true, state: 'cancelling' };
    }
    if (session.state === 'cancelling') return { success: true, accepted: true, state: 'cancelling' };
    return { success: false, accepted: false, state: session.state };
  }

  return {
    start,
    exportShorts: start,
    cancel,
    cancelExport: cancel,
    getSession: (jobId) => registry.get(jobId),
    getRegistry: () => registry,
    getActiveJobId: () => activeJobId,
  };
}

const createHyperFramesExportSession = createHyperFramesExportCoordinator;

module.exports = {
  SHORTS_EXPORT_CONTRACT,
  validateShortsExportSnapshot,
  deepCloneDeepFreeze,
  shortsExportFileName,
  createHyperFramesExportCoordinator,
  createHyperFramesExportSession,
};
