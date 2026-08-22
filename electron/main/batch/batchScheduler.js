'use strict';

/**
 * BAT-04 — single-flight batch scheduler and crash recovery.
 *
 * The scheduler intentionally knows no SQLite details.  Queue claims,
 * transitions, checkpoints, and durable events all go through BatchDomain;
 * the runner is an injected seam until the provider/model lanes are wired.
 */

const { createAppError } = require('../../../shared/contracts/errors.ts');

const DEFAULT_CHECKPOINT_KEY = 'transcribing';
const DEFAULT_RECOVERY_ERROR = 'Interrupted processing recovered after scheduler restart.';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error) {
  if (error && typeof error.message === 'string' && error.message.length > 0) return error.message;
  return String(error);
}

function isCancellation(error) {
  const message = typeof error === 'string'
    ? error
    : error && typeof error.message === 'string'
      ? error.message
      : '';
  return Boolean(
    error
    && (error.code === 'CANCELLED' || error.name === 'AbortError' || /cancel|abort/i.test(message)),
  );
}

function normalizeGeneration(value, fallback = 1) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw createAppError('VALIDATION_FAILED', 'Scheduler generation must be a positive safe integer.');
  }
  return value;
}

function normalizeResultDetails(result) {
  if (!isPlainObject(result)) return {};
  const details = {};
  for (const key of ['phase', 'progress', 'outputFingerprint']) {
    if (result[key] !== undefined) details[key] = result[key];
  }
  return details;
}

class BatchScheduler {
  constructor(options = {}) {
    if (!isPlainObject(options)) options = {};
    if (!options.domain || typeof options.domain.claimNextJob !== 'function') {
      throw createAppError('VALIDATION_FAILED', 'BatchScheduler requires a BatchDomain claim API.');
    }

    const runner = options.runner || options.jobRunner;
    const runJob = typeof options.runJob === 'function'
      ? options.runJob
      : runner && typeof runner.run === 'function'
        ? runner.run.bind(runner)
        : typeof runner === 'function'
          ? runner
          : null;
    if (!runJob) throw createAppError('VALIDATION_FAILED', 'BatchScheduler requires an injected job runner.');

    this.domain = options.domain;
    this.runJob = runJob;
    this.cancelRunner = typeof options.cancelJob === 'function'
      ? options.cancelJob
      : runner && typeof runner.cancel === 'function'
        ? runner.cancel.bind(runner)
        : typeof runJob.cancel === 'function'
          ? runJob.cancel.bind(runJob)
          : null;
    this.removePartialDerivatives = typeof options.removePartialDerivatives === 'function'
      ? options.removePartialDerivatives
      : typeof options.cleanupPartial === 'function'
        ? options.cleanupPartial
        : async () => {};
    this.readiness = typeof options.readiness === 'function'
      ? options.readiness
      : typeof options.isReady === 'function'
        ? options.isReady
        : async () => true;
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
    this.onIssue = typeof options.onIssue === 'function' ? options.onIssue : () => {};
    this.recoveryPolicy = options.recoveryPolicy === undefined ? 'retry' : options.recoveryPolicy;
    if (this.recoveryPolicy !== 'retry' && this.recoveryPolicy !== 'fail') {
      throw createAppError('VALIDATION_FAILED', 'Scheduler recoveryPolicy must be "retry" or "fail".');
    }
    this.checkpointKey = options.checkpointKey === undefined
      ? DEFAULT_CHECKPOINT_KEY
      : options.checkpointKey;
    if (typeof this.checkpointKey !== 'string' || this.checkpointKey.length === 0) {
      throw createAppError('VALIDATION_FAILED', 'Scheduler checkpointKey must be a non-empty string.');
    }
    this.pollIntervalMs = options.pollIntervalMs === undefined
      ? 0
      : options.pollIntervalMs;
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs < 0) {
      throw createAppError('VALIDATION_FAILED', 'Scheduler pollIntervalMs must be a non-negative number.');
    }
    this.generation = normalizeGeneration(options.generation, 1);

    this._running = false;
    this._paused = false;
    this._pauseAfterCurrent = false;
    this._active = null;
    this._claimPromise = null;
    this._pumpPromise = null;
    this._wakeTimer = null;
    this._restartPromise = null;
    this._waiters = new Set();
  }

  get activeJob() {
    return this._active ? this._active.job : null;
  }

  get isRunning() {
    return this._running;
  }

  get isPaused() {
    return this._paused;
  }

  get mode() {
    if (this._pauseAfterCurrent) return 'pause-after-current';
    if (this._paused) return 'paused';
    if (this._running) return 'running';
    return 'stopped';
  }

  _emitEvent(event) {
    if (!event) return;
    try {
      this.onEvent(event);
    } catch (error) {
      this._emitIssue(error);
    }
  }

  _emitIssue(error) {
    try {
      this.onIssue(error);
    } catch {
      // Observers must not stop queue progress or recovery.
    }
  }

  _emitEvents(events) {
    if (!Array.isArray(events)) return;
    for (const event of events) this._emitEvent(event);
  }

  _appendEvent(jobId, eventType, payload) {
    const event = this.domain.appendEvent(jobId, { eventType, payload });
    this._emitEvent(event);
    return event;
  }

  async _isReady() {
    try {
      return (await this.readiness()) === true;
    } catch (error) {
      this._emitIssue(error);
      return false;
    }
  }

  /** Recover only rows left running by an earlier scheduler/process. */
  async recoverOnBoot(options = {}) {
    if (!isPlainObject(options)) throw createAppError('VALIDATION_FAILED', 'Scheduler recovery options must be an object.');
    const policy = options.policy === undefined ? this.recoveryPolicy : options.policy;
    const error = options.error === undefined ? DEFAULT_RECOVERY_ERROR : options.error;
    const requestedLiveJobIds = options.liveJobIds === undefined ? [] : options.liveJobIds;
    if (!Array.isArray(requestedLiveJobIds) || requestedLiveJobIds.some((jobId) => typeof jobId !== 'string' || jobId.length === 0)) {
      throw createAppError('VALIDATION_FAILED', 'Scheduler liveJobIds must be an array of non-empty strings.');
    }
    const liveJobIds = new Set(requestedLiveJobIds);
    if (this._active) liveJobIds.add(this._active.job.jobId);
    const result = this.domain.recoverRunningJobs({
      policy,
      error,
      liveJobIds: [...liveJobIds],
      includeEvents: true,
    });
    const entries = Array.isArray(result) ? result : [];
    for (const entry of entries) this._emitEvents(entry && entry.events);
    return entries.map((entry) => entry && entry.job ? entry.job : entry);
  }

  recover(options = {}) {
    return this.recoverOnBoot(options);
  }

  async start(options = {}) {
    if (this._running) return this;
    if (!isPlainObject(options)) throw createAppError('VALIDATION_FAILED', 'Scheduler start options must be an object.');
    if (options.recover !== false) await this.recoverOnBoot(options);
    this._running = true;
    this._paused = false;
    this._pauseAfterCurrent = false;
    this._kick();
    return this;
  }

  /** Run one claim/execute cycle. Concurrent calls share one in-flight cycle. */
  runOnce() {
    if (this._claimPromise) return this._claimPromise;
    const promise = this._runOnceInternal();
    const tracked = promise.finally(() => {
      if (this._claimPromise === tracked) this._claimPromise = null;
      this._notifyWaiters();
    });
    this._claimPromise = tracked;
    tracked.catch((error) => this._emitIssue(error));
    return tracked;
  }

  async _runOnceInternal() {
    if (this._paused || this._pauseAfterCurrent) return null;
    if (this._active) return this._active.promise;
    if (!(await this._isReady())) return { status: 'not-ready' };
    const claimedResult = this.domain.claimNextJob({ includeEvents: true });
    const wrappedClaim = claimedResult && Object.prototype.hasOwnProperty.call(claimedResult, 'job');
    const claimed = wrappedClaim ? claimedResult.job : claimedResult;
    if (!claimed) return null;
    if (wrappedClaim) this._emitEvents(claimedResult.events);
    return this._execute(claimed);
  }

  _kick() {
    if (!this._running || this._paused || this._pumpPromise) return this._pumpPromise;
    const pump = this._pump();
    const tracked = pump.finally(() => {
      if (this._pumpPromise === tracked) this._pumpPromise = null;
      this._notifyWaiters();
    });
    this._pumpPromise = tracked;
    tracked.catch((error) => this._emitIssue(error));
    return tracked;
  }

  async _pump() {
    while (this._running && !this._paused) {
      if (this._pauseAfterCurrent && !this._active) {
        this._running = false;
        this._pauseAfterCurrent = false;
        break;
      }
      const result = await this.runOnce();
      if (!result) break;
      if (result.status === 'not-ready') {
        this._scheduleWake();
        break;
      }
    }
  }

  _scheduleWake() {
    if (!this._running || this._paused || this.pollIntervalMs <= 0 || this._wakeTimer) return;
    this._wakeTimer = setTimeout(() => {
      this._wakeTimer = null;
      this._kick();
    }, this.pollIntervalMs);
    if (typeof this._wakeTimer.unref === 'function') this._wakeTimer.unref();
  }

  wake() {
    if (this._wakeTimer) {
      clearTimeout(this._wakeTimer);
      this._wakeTimer = null;
    }
    this._kick();
    return this;
  }

  pause() {
    this._paused = true;
    clearTimeout(this._wakeTimer);
    this._wakeTimer = null;
    return this;
  }

  resume() {
    this._paused = false;
    this._pauseAfterCurrent = false;
    this._running = true;
    this._kick();
    return this;
  }

  async pauseAfterCurrent() {
    this._pauseAfterCurrent = true;
    this._paused = false;
    if (!this._active) {
      this._running = false;
      this._pauseAfterCurrent = false;
      return null;
    }
    const result = await this._active.promise;
    if (this._pumpPromise) await this._pumpPromise;
    return result;
  }

  /** Process all currently pending work, then stop claiming. */
  async drain() {
    this._running = true;
    this._paused = false;
    this._pauseAfterCurrent = false;
    const pump = this._kick();
    if (pump) await pump;
    this._running = false;
    clearTimeout(this._wakeTimer);
    this._wakeTimer = null;
    const pending = this.domain.listJobs({ state: 'pending' });
    return { drained: pending.length === 0, pending: pending.length, generation: this.generation };
  }

  /** Drain old-generation work before arming a new scheduler generation. */
  async restart(options = {}) {
    if (this._restartPromise) return this._restartPromise;
    if (!isPlainObject(options)) throw createAppError('VALIDATION_FAILED', 'Scheduler restart options must be an object.');
    this._restartPromise = (async () => {
      const drained = await this.drain();
      if (!drained.drained) {
        throw createAppError('CAPABILITY_UNAVAILABLE', 'Scheduler generation restart requires a drained queue.', drained);
      }
      const nextGeneration = normalizeGeneration(options.generation, this.generation + 1);
      if (nextGeneration <= this.generation) {
        throw createAppError('CONFLICT', 'Scheduler generation must increase on restart.', {
          current: this.generation,
          requested: nextGeneration,
        });
      }
      this.generation = nextGeneration;
      this._running = true;
      this._paused = false;
      this._pauseAfterCurrent = false;
      this._kick();
      return this.generation;
    })().finally(() => {
      this._restartPromise = null;
    });
    return this._restartPromise;
  }

  reconfigure(options = {}) {
    return this.restart(options);
  }

  async cancel(jobId) {
    if (typeof jobId !== 'string' || jobId.length === 0) {
      throw createAppError('VALIDATION_FAILED', 'jobId must be a non-empty string.');
    }
    const active = this._active && this._active.job.jobId === jobId ? this._active : null;
    if (!active) {
      const job = this.domain.getJob(jobId);
      if (job.state !== 'pending') return job;
      const cancelled = this.domain.cancelJob(jobId);
      this._appendEvent(jobId, 'job.cancelled', { reason: 'user' });
      this.wake();
      return cancelled;
    }

    if (active.cancelRequested) return active.promise;
    active.cancelRequested = true;
    active.controller.abort();
    if (active.cancelHook) {
      try {
        await active.cancelHook();
      } catch (error) {
        this._emitIssue(error);
      }
    } else if (this.cancelRunner) {
      try {
        await this.cancelRunner(active.job, active.context);
      } catch (error) {
        this._emitIssue(error);
      }
    }
    return active.promise;
  }

  async _execute(job) {
    const controller = new AbortController();
    const active = {
      job,
      controller,
      cancelRequested: false,
      cancelHook: null,
      context: null,
      promise: null,
    };
    this._active = active;
    active.promise = this._executeJob(active);
    return active.promise;
  }

  async _executeJob(active) {
    const { job } = active;
    let started = false;
    try {
      const checkpoint = this.domain.getCheckpoint(job.jobId, this.checkpointKey);
      const saveCheckpoint = (input, token, metadata) => {
        let candidate;
        if (typeof input === 'string') {
          candidate = { checkpointKey: this.checkpointKey, token: input, metadata: metadata || {} };
        } else if (isPlainObject(input)) {
          candidate = {
            ...input,
            checkpointKey: input.checkpointKey || this.checkpointKey,
          };
        } else {
          throw createAppError('VALIDATION_FAILED', 'checkpoint must be a token or object.');
        }
        const saved = this.domain.saveCheckpoint(job.jobId, candidate);
        const events = this.domain.listEvents(job.jobId, { limit: 1 });
        this._emitEvents(events);
        return saved;
      };
      const context = {
        job,
        generation: this.generation,
        checkpoint,
        resumeToken: checkpoint ? checkpoint.token : null,
        signal: active.controller.signal,
        isCancelled: () => active.cancelRequested,
        onCancel: (handler) => {
          if (typeof handler !== 'function') throw createAppError('VALIDATION_FAILED', 'cancel handler must be a function.');
          active.cancelHook = handler;
          return () => {
            if (active.cancelHook === handler) active.cancelHook = null;
          };
        },
        checkpointState: checkpoint,
        saveCheckpoint,
        writeCheckpoint: saveCheckpoint,
      };
      active.context = context;
      this._appendEvent(job.jobId, 'job.started', {
        attempt: job.attempt,
        generation: this.generation,
        resumed: Boolean(checkpoint),
      });
      started = true;
      const result = await this.runJob(job, context);
      if (active.cancelRequested) return this._finishCancellation(active);
      const completed = this.domain.completeJob(job.jobId, normalizeResultDetails(result));
      this._appendEvent(job.jobId, 'job.completed', {
        attempt: completed.attempt,
        generation: this.generation,
      });
      return completed;
    } catch (error) {
      if (!started) throw error;
      if (active.cancelRequested || isCancellation(error)) return this._finishCancellation(active);
      return this._finishFailure(active, error);
    } finally {
      if (this._active === active) this._active = null;
      if (this._running && !this._paused && !this._pauseAfterCurrent) this._kick();
      this._notifyWaiters();
    }
  }

  async _finishCancellation(active) {
    let cleanupError = null;
    try {
      await this.removePartialDerivatives(active.job, {
        reason: 'cancelled',
        generation: this.generation,
      });
    } catch (error) {
      cleanupError = error;
      this._emitIssue(error);
    }
    const current = this.domain.getJob(active.job.jobId);
    if (current.state !== 'running') return current;
    const cancelled = this.domain.cancelJob(current.jobId);
    this._appendEvent(cancelled.jobId, 'job.cancelled', {
      reason: 'user',
      ...(cleanupError ? { cleanupError: errorMessage(cleanupError) } : {}),
    });
    return cancelled;
  }

  async _finishFailure(active, error) {
    const message = errorMessage(error);
    const current = this.domain.getJob(active.job.jobId);
    if (current.state !== 'running') return current;
    if (current.attempt < current.maxAttempts) {
      const retry = this.domain.transitionJob(current.jobId, 'pending', { error: message });
      this._appendEvent(current.jobId, 'job.retryScheduled', {
        attempt: retry.attempt,
        nextAttempt: retry.attempt + 1,
        maxAttempts: retry.maxAttempts,
        error: message,
      });
      return retry;
    }
    const failed = this.domain.failJob(current.jobId, message);
    this._appendEvent(current.jobId, 'job.failed', {
      attempt: failed.attempt,
      maxAttempts: failed.maxAttempts,
      error: message,
    });
    return failed;
  }

  waitForIdle(options = {}) {
    if (!isPlainObject(options)) throw createAppError('VALIDATION_FAILED', 'waitForIdle options must be an object.');
    const includePending = options.includePending !== false;
    const isIdle = () => {
      if (this._active || this._pumpPromise || this._claimPromise) return false;
      if (!includePending) return true;
      return this.domain.listJobs({ state: 'pending' }).length === 0;
    };
    if (isIdle()) return Promise.resolve();
    return new Promise((resolve) => this._waiters.add({ resolve, includePending }));
  }

  _notifyWaiters() {
    for (const waiter of this._waiters) {
      const pending = waiter.includePending ? this.domain.listJobs({ state: 'pending' }).length : 0;
      if (!this._active && !this._pumpPromise && !this._claimPromise && pending === 0) {
        this._waiters.delete(waiter);
        waiter.resolve();
      }
    }
  }

  async stop(options = {}) {
    if (!isPlainObject(options)) throw createAppError('VALIDATION_FAILED', 'Scheduler stop options must be an object.');
    this._running = false;
    this._paused = true;
    this._pauseAfterCurrent = false;
    clearTimeout(this._wakeTimer);
    this._wakeTimer = null;
    if (options.cancelCurrent && this._active) await this.cancel(this._active.job.jobId);
    if (options.waitForCurrent && this._active) await this._active.promise;
    if (options.waitForPump && this._pumpPromise) await this._pumpPromise;
    return this;
  }

  close(options = {}) {
    return this.stop(options);
  }
}

function createBatchScheduler(options) {
  return new BatchScheduler(options);
}

module.exports = {
  BatchScheduler,
  createBatchScheduler,
  DEFAULT_CHECKPOINT_KEY,
  DEFAULT_RECOVERY_ERROR,
};
