'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createBatchDomain } = require('../electron/main/batch/batchDomain.js');
const { createBatchScheduler } = require('../electron/main/batch/batchScheduler.js');

function makeTempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaniscript-scheduler-'));
  // Defer removal until all handles opened by the test have been closed.
  t.after(() => t.after(() => fs.rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  })));
  return { dir, dbPath: path.join(dir, 'batch.sqlite') };
}

function openDomain(t, dbPath) {
  const domain = createBatchDomain({ dbPath });
  t.after(() => domain.close());
  return domain;
}

function profileInput(profileId = 'profile-main') {
  return {
    profileId,
    name: 'Lectures',
    sourcePath: `/tmp/${profileId}`,
    recursive: true,
    enabled: true,
    config: { language: 'en', model: 'local-small' },
  };
}

function jobInput(profileId, jobId, overrides = {}) {
  return {
    jobId,
    profileId,
    sourcePath: `/tmp/${profileId}/${jobId}.m4a`,
    outputPath: `/tmp/${profileId}/${jobId}.txt`,
    configSnapshot: { language: 'en', model: 'local-small' },
    sourceFingerprint: {
      sizeBytes: 42,
      mtimeMs: 1700000000000,
      sha256: 'a'.repeat(64),
    },
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, attempts = 20) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail('condition did not become true');
}

function recoveryWorkerSource() {
  return `
    'use strict';
    const { parentPort, workerData } = require('node:worker_threads');
    const { createBatchDomain } = require(workerData.modulePath);
    const domain = createBatchDomain({ dbPath: workerData.dbPath });
    const barrier = new Int32Array(workerData.barrier);
    parentPort.postMessage({ type: 'ready' });
    Atomics.wait(barrier, 1, 0);
    try {
      const entries = domain.recoverRunningJobs({ includeEvents: true });
      parentPort.postMessage({
        type: 'result',
        recovered: entries.map((entry) => entry.job),
        events: entries.flatMap((entry) => entry.events || []),
      });
    } catch (error) {
      parentPort.postMessage({
        type: 'error',
        error: { message: error && error.message ? error.message : String(error) },
      });
    } finally {
      domain.close();
    }
  `;
}

test('atomic claim is single-flight and records claim/start/complete events', async (t) => {
  const { dbPath } = makeTempStore(t);
  const domain = openDomain(t, dbPath);
  domain.createProfile(profileInput());
  domain.enqueueJob(jobInput('profile-main', 'job-1'));
  domain.enqueueJob(jobInput('profile-main', 'job-2'));
  const gate = deferred();
  let starts = 0;
  const scheduler = createBatchScheduler({
    domain,
    runJob: async () => {
      starts += 1;
      await gate.promise;
    },
  });

  const first = scheduler.runOnce();
  const second = scheduler.runOnce();
  await waitFor(() => scheduler.activeJob !== null);
  assert.equal(starts, 1);
  assert.equal(domain.getJob('job-1').state, 'running');
  assert.equal(domain.getJob('job-2').state, 'pending');
  gate.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.jobId, 'job-1');
  assert.equal(secondResult.jobId, 'job-1');
  assert.equal(domain.getJob('job-1').attempt, 1);
  assert.deepEqual(domain.listEvents('job-1').map((event) => event.eventType), [
    'job.enqueued',
    'job.claimed',
    'job.stateChanged',
    'job.started',
    'job.stateChanged',
    'job.completed',
  ]);
});

test('domain claim guard preserves one active job across scheduler instances', async (t) => {
  const { dbPath } = makeTempStore(t);
  const domain = openDomain(t, dbPath);
  domain.createProfile(profileInput());
  domain.enqueueJob(jobInput('profile-main', 'job-global-1'));
  domain.enqueueJob(jobInput('profile-main', 'job-global-2'));
  const gate = deferred();
  const firstScheduler = createBatchScheduler({
    domain,
    runJob: async () => gate.promise,
  });
  const secondScheduler = createBatchScheduler({
    domain,
    runJob: async () => {},
  });
  const first = firstScheduler.runOnce();
  await waitFor(() => firstScheduler.activeJob !== null);
  assert.equal(await secondScheduler.runOnce(), null);
  assert.equal(domain.getJob('job-global-2').state, 'pending');
  gate.resolve();
  await first;
  assert.equal(domain.getJob('job-global-1').state, 'done');
});

test('crash/restart recovery requeues exactly once and resumes checkpoint token', async (t) => {
  const { dbPath } = makeTempStore(t);
  const firstDomain = openDomain(t, dbPath);
  firstDomain.createProfile(profileInput());
  firstDomain.enqueueJob(jobInput('profile-main', 'job-crash', { maxAttempts: 3 }));
  const interrupted = deferred();
  const firstScheduler = createBatchScheduler({
    domain: firstDomain,
    runJob: async (_job, context) => {
      context.saveCheckpoint({ token: 'resume-token-1', metadata: { chunk: 2 } });
      await interrupted.promise;
    },
  });
  firstScheduler.runOnce();
  await waitFor(() => firstScheduler.activeJob !== null);
  assert.equal(firstDomain.getJob('job-crash').state, 'running');
  assert.equal(firstDomain.getCheckpoint('job-crash', 'transcribing').token, 'resume-token-1');
  await firstScheduler.stop();
  firstDomain.close();

  const secondDomain = openDomain(t, dbPath);
  assert.equal(secondDomain.getCheckpoint('job-crash', 'transcribing').token, 'resume-token-1');
  const seenEvents = [];
  const recovered = createBatchScheduler({
    domain: secondDomain,
    onEvent: (event) => seenEvents.push(event.eventType),
    runJob: async (_job, context) => {
      assert.equal(context.resumeToken, 'resume-token-1');
      assert.deepEqual(context.checkpoint.metadata, { chunk: 2 });
      return { outputFingerprint: 'b'.repeat(64) };
    },
  });
  const recoveredJobs = await recovered.recoverOnBoot();
  assert.deepEqual(recoveredJobs.map((job) => [job.jobId, job.state, job.attempt]), [['job-crash', 'pending', 1]]);
  assert.deepEqual(await recovered.recoverOnBoot(), []);
  const recoveredJob = await recovered.runOnce();
  assert.equal(recoveredJob.state, 'done');
  assert.equal(recoveredJob.attempt, 2);
  assert.equal(seenEvents.filter((type) => type === 'job.retryScheduled').length, 1);
  assert.equal(seenEvents.filter((type) => type === 'job.completed').length, 1);
  assert.equal(secondDomain.listEvents('job-crash').filter((event) => event.eventType === 'job.retryScheduled').length, 1);
});
test('concurrent recovery across separate domain handles emits exactly once', async (t) => {
  const { dbPath } = makeTempStore(t);
  const setup = openDomain(t, dbPath);
  setup.createProfile(profileInput());
  setup.enqueueJob(jobInput('profile-main', 'job-concurrent-recovery'));
  setup.startJob('job-concurrent-recovery');
  setup.close();

  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const workers = Array.from({ length: 2 }, () => new Worker(recoveryWorkerSource(), {
    eval: true,
    workerData: {
      dbPath,
      modulePath: path.resolve(__dirname, '../electron/main/batch/batchDomain.js'),
      barrier,
    },
  }));
  t.after(async () => {
    await Promise.all(workers.map((worker) => worker.terminate()));
  });

  const ready = workers.map((worker) => new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message && message.type === 'ready') {
        worker.off('error', reject);
        resolve();
      } else if (message && message.type === 'error') {
        reject(new Error(message.error && message.error.message));
      }
    };
    worker.on('message', onMessage);
    worker.once('error', reject);
  }));
  const results = workers.map((worker) => new Promise((resolve, reject) => {
    worker.on('message', (message) => {
      if (message && message.type === 'result') resolve(message);
      if (message && message.type === 'error') reject(new Error(message.error && message.error.message));
    });
    worker.once('error', reject);
  }));
  await Promise.all(ready);
  const barrierView = new Int32Array(barrier);
  Atomics.store(barrierView, 1, 1);
  Atomics.notify(barrierView, 1, 2);
  const recoveries = await Promise.all(results);
  const recoveredIds = recoveries.flatMap((result) => result.recovered.map((job) => job.jobId));
  const events = recoveries.flatMap((result) => result.events);
  const eventIds = events.map((event) => event.eventId);
  assert.equal(new Set(recoveredIds).size, recoveredIds.length);
  assert.equal(new Set(eventIds).size, eventIds.length);
  assert.equal(recoveredIds.filter((jobId) => jobId === 'job-concurrent-recovery').length, 1);
  assert.equal(events.filter((event) => event.eventType === 'job.retryScheduled').length, 1);

  const verify = openDomain(t, dbPath);
  assert.equal(verify.getJob('job-concurrent-recovery').state, 'pending');
  assert.equal(
    verify.listEvents('job-concurrent-recovery').filter((event) => event.eventType === 'job.retryScheduled').length,
    1,
  );
});

test('recovery respects maxAttempts and reaches terminal failure exactly once', async (t) => {
  const { dbPath } = makeTempStore(t);
  const domain = openDomain(t, dbPath);
  domain.createProfile(profileInput());
  domain.enqueueJob(jobInput('profile-main', 'job-terminal', { maxAttempts: 1 }));
  domain.startJob('job-terminal');
  const events = [];
  const scheduler = createBatchScheduler({
    domain,
    onEvent: (event) => events.push(event.eventType),
    runJob: async () => {},
  });
  const first = await scheduler.recoverOnBoot();
  assert.deepEqual(first.map((job) => [job.state, job.attempt]), [['failed', 1]]);
  assert.deepEqual(await scheduler.recoverOnBoot(), []);
  assert.equal(domain.getJob('job-terminal').completedAt !== null, true);
  assert.equal(events.filter((type) => type === 'job.failed').length, 1);
  assert.equal(domain.listEvents('job-terminal').filter((event) => event.eventType === 'job.failed').length, 1);
});

test('recovery fail policy terminalizes an interrupted job below its retry budget', async (t) => {
  const { dbPath } = makeTempStore(t);
  const domain = openDomain(t, dbPath);
  domain.createProfile(profileInput());
  domain.enqueueJob(jobInput('profile-main', 'job-policy', { maxAttempts: 3 }));
  domain.startJob('job-policy');
  const scheduler = createBatchScheduler({ domain, recoveryPolicy: 'fail', runJob: async () => {} });
  const [job] = await scheduler.recoverOnBoot();
  assert.equal(job.state, 'failed');
  assert.equal(job.attempt, 1);
  assert.equal(domain.listEvents('job-policy').filter((event) => event.eventType === 'job.retryScheduled').length, 0);
});

test('runner failure retries while attempts remain and fails on the terminal attempt', async (t) => {
  const { dbPath } = makeTempStore(t);
  const domain = openDomain(t, dbPath);
  domain.createProfile(profileInput());
  domain.enqueueJob(jobInput('profile-main', 'job-retry', { maxAttempts: 3 }));
  const scheduler = createBatchScheduler({ domain, runJob: async () => { throw new Error('provider down'); } });
  const first = await scheduler.runOnce();
  assert.equal(first.state, 'pending');
  assert.equal(first.attempt, 1);
  const second = await scheduler.runOnce();
  assert.equal(second.state, 'pending');
  assert.equal(second.attempt, 2);
  const third = await scheduler.runOnce();
  assert.equal(third.state, 'failed');
  assert.equal(third.attempt, 3);
  assert.equal(domain.listEvents('job-retry').filter((event) => event.eventType === 'job.retryScheduled').length, 2);
  assert.equal(domain.listEvents('job-retry').filter((event) => event.eventType === 'job.failed').length, 1);
});

test('readiness denial leaves the queue pending and performs no claim', async (t) => {
  const { dbPath } = makeTempStore(t);
  const domain = openDomain(t, dbPath);
  domain.createProfile(profileInput());
  domain.enqueueJob(jobInput('profile-main', 'job-not-ready'));
  let checks = 0;
  const scheduler = createBatchScheduler({
    domain,
    readiness: () => { checks += 1; return false; },
    runJob: async () => {},
  });
  const result = await scheduler.runOnce();
  assert.deepEqual(result, { status: 'not-ready' });
  assert.equal(checks, 1);
  assert.equal(domain.getJob('job-not-ready').state, 'pending');
  assert.equal(domain.listEvents('job-not-ready').filter((event) => event.eventType === 'job.claimed').length, 0);
});

test('pause, pause-after-current, and resume have deterministic queue behavior', async (t) => {
  const { dbPath } = makeTempStore(t);
  const domain = openDomain(t, dbPath);
  domain.createProfile(profileInput());
  domain.enqueueJob(jobInput('profile-main', 'job-pause-1'));
  domain.enqueueJob(jobInput('profile-main', 'job-pause-2'));
  const gate = deferred();
  const scheduler = createBatchScheduler({
    domain,
    runJob: async (job) => {
      if (job.jobId === 'job-pause-1') await gate.promise;
    },
  });
  scheduler.pause();
  assert.equal(await scheduler.runOnce(), null);
  assert.equal(domain.getJob('job-pause-1').state, 'pending');

  await scheduler.start({ recover: false });
  await waitFor(() => scheduler.activeJob && scheduler.activeJob.jobId === 'job-pause-1');
  const pauseAfter = scheduler.pauseAfterCurrent();
  gate.resolve();
  await pauseAfter;
  await scheduler.waitForIdle({ includePending: false });
  assert.equal(domain.getJob('job-pause-1').state, 'done');
  assert.equal(domain.getJob('job-pause-2').state, 'pending');
  assert.equal(scheduler.mode, 'stopped');

  scheduler.resume();
  await scheduler.waitForIdle();
  assert.equal(domain.getJob('job-pause-2').state, 'done');
});

test('drain processes the old queue before a generation restart re-arms', async (t) => {
  const { dbPath } = makeTempStore(t);
  const domain = openDomain(t, dbPath);
  domain.createProfile(profileInput());
  domain.enqueueJob(jobInput('profile-main', 'job-generation-1'));
  domain.enqueueJob(jobInput('profile-main', 'job-generation-2'));
  const generations = [];
  const scheduler = createBatchScheduler({
    domain,
    generation: 4,
    runJob: async (_job, context) => { generations.push(context.generation); },
  });
  const drained = await scheduler.drain();
  assert.deepEqual(drained, { drained: true, pending: 0, generation: 4 });
  assert.deepEqual(generations, [4, 4]);
  assert.equal(await scheduler.restart({ generation: 5 }), 5);
  domain.enqueueJob(jobInput('profile-main', 'job-generation-3'));
  const result = await scheduler.runOnce();
  assert.equal(result.state, 'done');
  assert.deepEqual(generations, [4, 4, 5]);
});

test('cancel running job invokes cooperative hook once, cleans partial derivatives, and terminalizes', async (t) => {
  const { dbPath } = makeTempStore(t);
  const domain = openDomain(t, dbPath);
  domain.createProfile(profileInput());
  domain.enqueueJob(jobInput('profile-main', 'job-cancel'));
  const cancelled = deferred();
  const cleanup = [];
  let cancelHooks = 0;
  const scheduler = createBatchScheduler({
    domain,
    removePartialDerivatives: async (job, details) => cleanup.push([job.jobId, details.reason]),
    runJob: async (_job, context) => {
      context.onCancel(() => {
        cancelHooks += 1;
        cancelled.resolve();
      });
      await cancelled.promise;
    },
  });
  const run = scheduler.runOnce();
  await waitFor(() => scheduler.activeJob !== null);
  const firstCancel = scheduler.cancel('job-cancel');
  const secondCancel = scheduler.cancel('job-cancel');
  const [result, secondResult] = await Promise.all([firstCancel, secondCancel]);
  await run;
  assert.equal(result.state, 'cancelled');
  assert.equal(secondResult.state, 'cancelled');
  assert.equal(cancelHooks, 1);
  assert.deepEqual(cleanup, [['job-cancel', 'cancelled']]);
  assert.equal(domain.listEvents('job-cancel').filter((event) => event.eventType === 'job.cancelled').length, 1);
});

test('pending cancellation is terminal and does not invoke the runner', async (t) => {
  const { dbPath } = makeTempStore(t);
  const domain = openDomain(t, dbPath);
  domain.createProfile(profileInput());
  domain.enqueueJob(jobInput('profile-main', 'job-cancel-pending'));
  let runs = 0;
  const scheduler = createBatchScheduler({ domain, runJob: async () => { runs += 1; } });
  const result = await scheduler.cancel('job-cancel-pending');
  assert.equal(result.state, 'cancelled');
  assert.equal(runs, 0);
  assert.equal(domain.listEvents('job-cancel-pending').filter((event) => event.eventType === 'job.cancelled').length, 1);
});
