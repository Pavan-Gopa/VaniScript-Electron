'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createBatchDomain } = require('../electron/main/batch/batchDomain.js');
const { createBatchWatcher } = require('../electron/main/batch/batchWatcher.js');
const { createFolderAccessAdapter } = require('../electron/main/batch/folderAccess.js');

function makeContext(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vaniscript-watchers-'));
  const dbPath = path.join(directory, 'batch.sqlite');
  const sourcePath = path.join(directory, 'source');
  fs.mkdirSync(sourcePath);
  const domain = createBatchDomain({ dbPath });
  const profile = domain.createProfile({
    profileId: 'profile-watch',
    name: 'Watched folder',
    sourcePath: options.profilePath || sourcePath,
    recursive: options.recursive === undefined ? true : options.recursive,
    enabled: true,
    config: options.config || {},
  });
  const watcherHandles = [];
  const watchFactory = options.watchFactory || ((directoryPath, listener) => {
    const emitter = new EventEmitter();
    emitter.directoryPath = directoryPath;
    emitter.listener = listener;
    emitter.close = () => { emitter.closed = true; };
    watcherHandles.push(emitter);
    return emitter;
  });
  const issues = [];
  const events = [];
  const watcher = createBatchWatcher({
    domain,
    watchFactory,
    debounceMs: options.debounceMs === undefined ? 2 : options.debounceMs,
    stabilitySamples: options.stabilitySamples === undefined ? 2 : options.stabilitySamples,
    stabilityIntervalMs: options.stabilityIntervalMs === undefined ? 1 : options.stabilityIntervalMs,
    stabilityAttempts: options.stabilityAttempts,
    stabilityRetries: options.stabilityRetries,
    reconciliationIntervalMs: options.reconciliationIntervalMs === undefined ? null : options.reconciliationIntervalMs,
    sleep: options.sleep,
    accessAdapter: options.accessAdapter,
    onIssue: (issue) => issues.push(issue),
    onEvent: (event) => events.push(event),
  });
  t.after(async () => {
    await watcher.stop();
    domain.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, sourcePath, domain, profile, watcher, watcherHandles, issues, events };
}

function emitFsEvent(handles, directoryPath, eventType, filename) {
  const watcher = handles.find((handle) => handle.directoryPath === directoryPath && !handle.closed);
  assert.ok(watcher, `no active watcher for ${directoryPath}`);
  watcher.listener(eventType, filename);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('duplicate watcher events enqueue one job by profile-scoped source fingerprint', async (t) => {
  const context = makeContext(t);
  const source = path.join(context.sourcePath, 'lecture.m4a');
  fs.writeFileSync(source, 'stable audio');

  const started = await context.watcher.start();
  assert.equal(context.domain.listJobs().length, 1);
  assert.equal(context.events.filter((event) => event.type === 'job-enqueued').length, 1);

  const canonicalRoot = context.domain.getProfile('profile-watch').sourcePath;
  emitFsEvent(context.watcherHandles, canonicalRoot, 'change', 'lecture.m4a');
  emitFsEvent(context.watcherHandles, canonicalRoot, 'change', 'lecture.m4a');
  await context.watcher.flush();

  assert.equal(context.domain.listJobs().length, 1);
  assert.equal(started.generation, context.watcher.generation);
});

test('events from a retired watcher generation are ignored', async (t) => {
  const context = makeContext(t);
  fs.writeFileSync(path.join(context.sourcePath, 'lecture.m4a'), 'stable audio');

  const first = await context.watcher.start();
  await context.watcher.stop();
  const second = await context.watcher.start();

  assert.equal(context.watcher.handleFsEvent('profile-watch', first.generation, 'change', 'lecture.m4a'), false);
  await context.watcher.flush();
  assert.equal(context.watcher.generation, second.generation);
  assert.equal(context.domain.listJobs().length, 1);
  assert.equal(context.domain.getWatcherGeneration('profile-watch').generation, second.generation);
});

test('a changing file does not emit a job until stability samples agree', async (t) => {
  const context = makeContext(t, { stabilityAttempts: 2 });
  const source = path.join(context.sourcePath, 'lecture.m4a');
  fs.writeFileSync(source, 'first write');
  let changeDuringProbe = true;
  context.watcher = createBatchWatcher({
    domain: context.domain,
    watchFactory: (directoryPath, listener) => {
      const emitter = new EventEmitter();
      emitter.directoryPath = directoryPath;
      emitter.listener = listener;
      emitter.close = () => { emitter.closed = true; };
      context.watcherHandles.push(emitter);
      return emitter;
    },
    debounceMs: 0,
    stabilitySamples: 2,
    stabilityIntervalMs: 1,
    stabilityAttempts: 2,
    reconciliationIntervalMs: null,
    sleep: async () => {
      if (changeDuringProbe) {
        fs.appendFileSync(source, 'second write');
        changeDuringProbe = false;
      }
    },
    onIssue: (issue) => context.issues.push(issue),
    onEvent: (event) => context.events.push(event),
  });
  t.after(async () => context.watcher.stop());

  await context.watcher.start();
  assert.equal(context.domain.listJobs().length, 0);

  await context.watcher.reconcileProfile('profile-watch', {
    generation: context.watcher.generation,
    reason: 'stable-retry',
  });
  assert.equal(context.domain.listJobs().length, 1);
});

test('hidden, temporary, and companion text files are ignored', async (t) => {
  const context = makeContext(t);
  fs.writeFileSync(path.join(context.sourcePath, 'visible.m4a'), 'audio');
  fs.writeFileSync(path.join(context.sourcePath, '.hidden.m4a'), 'hidden');
  fs.writeFileSync(path.join(context.sourcePath, 'partial.tmp'), 'partial');
  fs.writeFileSync(path.join(context.sourcePath, 'visible.txt'), 'companion');
  fs.mkdirSync(path.join(context.sourcePath, '.hidden-dir'));
  fs.writeFileSync(path.join(context.sourcePath, '.hidden-dir', 'nested.m4a'), 'hidden');

  await context.watcher.start();
  assert.deepEqual(context.domain.listJobs().map((job) => path.basename(job.sourcePath)), ['visible.m4a']);
});

test('periodic reconciliation finds a missed file and remains exactly-once', async (t) => {
  const context = makeContext(t);
  const started = await context.watcher.start();
  const source = path.join(context.sourcePath, 'missed.wav');
  fs.writeFileSync(source, 'missed event');

  const first = await context.watcher.reconcileProfile('profile-watch', {
    generation: started.generation,
    reason: 'periodic',
  });
  const second = await context.watcher.reconcileProfile('profile-watch', {
    generation: started.generation,
    reason: 'periodic',
  });

  assert.equal(first.enqueued.length, 1);
  assert.equal(second.duplicateCount, 1);
  assert.equal(context.domain.listJobs().length, 1);
});

test('permission loss is surfaced as a watcher issue event', async (t) => {
  const context = makeContext(t, {
    accessAdapter: {
      resolve() {
        const error = new Error('folder permission revoked');
        error.code = 'PERMISSION_DENIED';
        throw error;
      },
    },
  });

  const result = await context.watcher.start();
  assert.deepEqual(result.profiles, []);
  assert.equal(context.issues.length, 1);
  assert.equal(context.issues[0].type, 'permission-lost');
  assert.equal(context.issues[0].code, 'PERMISSION_DENIED');
});

test('folder access stores a canonical real path and platform adapter remains injectable', (t) => {
  const context = makeContext(t);
  const alias = `${context.sourcePath}-alias`;
  fs.symlinkSync(context.sourcePath, alias, 'dir');
  t.after(() => fs.rmSync(alias, { force: true }));

  const access = createFolderAccessAdapter('darwin').resolve(alias);
  assert.equal(access.canonicalPath, fs.realpathSync.native(context.sourcePath));
  assert.equal(access.accessRef, null);
});
