'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createBatchDomain } = require('../electron/main/batch/batchDomain.js');
const { createBatchWatcher, fingerprintFile } = require('../electron/main/batch/batchWatcher.js');
const {
  assertPathWithinRoot,
  assertSafePathSyntax,
  createFolderAccessAdapter,
} = require('../electron/main/batch/folderAccess.js');

function makeHarness(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vaniscript-batch-safety-'));
  const root = path.join(directory, 'profile-root');
  const outside = path.join(directory, 'outside-root');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const domain = createBatchDomain({ dbPath: path.join(directory, 'batch.sqlite') });
  domain.createProfile({
    profileId: options.profileId || 'safety-profile',
    name: 'Safety profile',
    sourcePath: root,
    recursive: true,
    enabled: true,
  });
  const handles = [];
  const watchFactory = (directoryPath, listener) => {
    const handle = new EventEmitter();
    handle.directoryPath = directoryPath;
    handle.listener = listener;
    handle.close = () => { handle.closed = true; };
    handles.push(handle);
    return handle;
  };
  const issues = [];
  const events = [];
  const watcher = createBatchWatcher({
    domain,
    watchFactory,
    debounceMs: 0,
    stabilitySamples: options.stabilitySamples === undefined ? 2 : options.stabilitySamples,
    stabilityIntervalMs: options.stabilityIntervalMs === undefined ? 0 : options.stabilityIntervalMs,
    stabilityAttempts: options.stabilityAttempts,
    stabilityRetries: options.stabilityRetries,
    reconciliationIntervalMs: null,
    sleep: options.sleep,
    hash: options.hash,
    onIssue: (issue) => issues.push(issue),
    onEvent: (event) => events.push(event),
  });
  t.after(async () => {
    await watcher.stop();
    domain.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, root, outside, domain, watcher, handles, issues, events };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function generatedToken(random, index) {
  return `node-${index}-${Math.floor(random() * 0xFFFFFF).toString(16).padStart(6, '0')}`;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

test('path confinement rejects traversal, backslash, controls, and symlink escapes', (t) => {
  const context = makeHarness(t);
  const nested = path.join(context.root, 'nested');
  fs.mkdirSync(nested);
  const outsideFile = path.join(context.outside, 'outside.m4a');
  fs.writeFileSync(outsideFile, 'outside');
  const escapeDir = path.join(context.root, 'escape-dir');
  const escapeFile = path.join(context.root, 'escape.m4a');
  fs.symlinkSync(context.outside, escapeDir, 'dir');
  fs.symlinkSync(outsideFile, escapeFile, 'file');

  assert.throws(() => assertSafePathSyntax('../outside.m4a'), (error) => error.code === 'PERMISSION_DENIED');
  assert.throws(() => assertSafePathSyntax('..\\outside.m4a'), (error) => error.code === 'PERMISSION_DENIED');
  assert.throws(() => assertSafePathSyntax('line\nfeed.m4a'), (error) => error.code === 'VALIDATION_FAILED');
  assert.throws(() => assertPathWithinRoot(context.root, path.join(context.directory, 'outside.m4a')), (error) => error.code === 'PERMISSION_DENIED');
  assert.throws(() => assertPathWithinRoot(context.root, path.join(escapeDir, 'outside.m4a')), (error) => error.code === 'PERMISSION_DENIED');
  assert.throws(() => assertPathWithinRoot(context.root, escapeFile), (error) => error.code === 'PERMISSION_DENIED');
  assert.throws(
    () => context.domain.updateProfile('safety-profile', { sourcePath: `${context.root}/../escape` }),
    (error) => error.code === 'PERMISSION_DENIED',
  );
  assert.throws(
    () => context.domain.updateProfile('safety-profile', { sourcePath: '..\\escape' }),
    (error) => error.code === 'PERMISSION_DENIED',
  );
  assert.throws(
    () => context.domain.enqueueJob({
      profileId: 'safety-profile',
      sourcePath: path.join(context.root, 'source.m4a'),
      outputPath: '../escape.txt',
    }),
    (error) => error.code === 'PERMISSION_DENIED',
  );
  const safe = assertPathWithinRoot(context.root, path.join(nested, 'new.m4a'), { allowMissing: true });
  assert.equal(safe.exists, false);
  assert.equal(safe.relativePath, 'nested/new.m4a');
});

test('seeded adversarial tree never enqueues a candidate outside its canonical profile root', async (t) => {
  const context = makeHarness(t);
  const random = seededRandom(0xD3A55EED);
  const outsideFile = path.join(context.outside, 'escape.m4a');
  fs.writeFileSync(outsideFile, 'outside payload');
  fs.symlinkSync(context.outside, path.join(context.root, 'linked-outside'), 'dir');
  fs.symlinkSync(outsideFile, path.join(context.root, 'linked-file.m4a'), 'file');

  for (let index = 0; index < 96; index += 1) {
    let current = context.root;
    const depth = 1 + Math.floor(random() * 8);
    for (let level = 0; level < depth; level += 1) {
      current = path.join(current, generatedToken(random, `${index}-${level}`));
      fs.mkdirSync(current, { recursive: true });
    }
    let fileName;
    if (index === 1) fileName = `nfc-e\u0301-${index}.m4a`;
    else if (index === 2) fileName = `nfd-e\u0301-${index}.m4a`;
    else if (index === 3) fileName = `control\n-${index}.m4a`;
    else if (index === 4) fileName = `control\u0001-${index}.m4a`;
    else fileName = `${index % 2 ? 'Case' : 'case'}-${index}.m4a`;
    fs.writeFileSync(path.join(current, fileName), `payload-${index % 7}`);
  }

  const caseDirectory = path.join(context.root, 'case-variants');
  fs.mkdirSync(caseDirectory);
  fs.writeFileSync(path.join(caseDirectory, 'Track.m4a'), 'case payload');
  fs.writeFileSync(path.join(caseDirectory, 'track.m4a'), 'case payload');
  const deep = path.join(context.root, ...Array.from({ length: 24 }, (_, index) => `deep-${index}`));
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'deep.m4a'), 'deep payload');

  const started = await context.watcher.start();
  const canonicalRoot = fs.realpathSync.native(context.root);
  const jobs = context.domain.listJobs();
  assert.ok(started.results.length === 1);
  assert.ok(jobs.length > 0);
  for (const job of jobs) {
    const canonicalSource = fs.realpathSync.native(job.sourcePath);
    assert.ok(isWithin(canonicalRoot, canonicalSource), `escaped candidate: ${job.sourcePath}`);
    assert.notEqual(canonicalSource, fs.realpathSync.native(outsideFile));
  }
  assert.ok(
    context.issues.some((issue) => issue.type === 'path-violation'),
    'unsafe symlink/control entries must surface path issues',
  );
  assert.ok(context.events.every((event) => isWithin(canonicalRoot, fs.realpathSync.native(event.job.sourcePath))));
});

test('same-content files in one profile intentionally dedupe by complete fingerprint', async (t) => {
  const context = makeHarness(t);
  const first = path.join(context.root, 'first.m4a');
  const second = path.join(context.root, 'second.m4a');
  fs.writeFileSync(first, 'identical payload');
  fs.writeFileSync(second, 'identical payload');
  const sameTimestamp = new Date(1700000000000);
  fs.utimesSync(first, sameTimestamp, sameTimestamp);
  fs.utimesSync(second, sameTimestamp, sameTimestamp);

  const result = await context.watcher.start();
  assert.equal(result.results[0].scanned, 2);
  assert.equal(context.domain.listJobs().length, 1);
  assert.equal(result.results[0].enqueued.length, 1);
  assert.equal(result.results[0].duplicateCount, 1);
  assert.ok(['first.m4a', 'second.m4a'].includes(path.basename(context.domain.listJobs()[0].sourcePath)));
});

test('rename during stability probe fails safe and emits a source issue', async (t) => {
  const source = { path: null, renamed: null };
  let didRename = false;
  const context = makeHarness(t, {
    stabilityAttempts: 2,
    stabilityIntervalMs: 1,
    sleep: async () => {
      if (!didRename) {
        didRename = true;
        fs.renameSync(source.path, source.renamed);
      }
    },
  });
  source.path = path.join(context.root, 'rename.m4a');
  source.renamed = path.join(context.root, 'rename-after-probe.m4a');
  fs.writeFileSync(source.path, 'rename me');

  await context.watcher.start();
  assert.equal(context.domain.listJobs().length, 0);
  assert.ok(context.issues.some((issue) => issue.type === 'source-unavailable' || issue.type === 'source-changed'));
});

test('delete during hash verification fails safe and emits a source issue', async (t) => {
  let sourcePath;
  const context = makeHarness(t, {
    hash: async () => {
      fs.unlinkSync(sourcePath);
      return 'a'.repeat(64);
    },
  });
  sourcePath = path.join(context.root, 'delete-during-hash.m4a');
  fs.writeFileSync(sourcePath, 'delete me');

  await context.watcher.start();
  assert.equal(context.domain.listJobs().length, 0);
  assert.ok(context.issues.some((issue) => issue.type === 'source-unavailable' || issue.type === 'source-changed'));
});

test('permission flip during recursive walk is surfaced without crashing', async (t) => {
  const context = makeHarness(t);
  const nested = path.join(context.root, 'permission-flip');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'later.m4a'), 'later');
  const started = await context.watcher.start();
  const originalReadDirectory = fs.readdirSync;
  const nestedCanonical = fs.realpathSync.native(nested);
  let flipped = false;
  fs.readdirSync = function patchedReadDirectory(directoryPath, options) {
    if (!flipped && path.resolve(directoryPath) === path.resolve(nestedCanonical)) {
      flipped = true;
      const error = new Error('permission revoked during walk');
      error.code = 'EACCES';
      throw error;
    }
    return originalReadDirectory.call(this, directoryPath, options);
  };
  try {
    await context.watcher.reconcileProfile('safety-profile', { generation: started.generation, reason: 'permission-flip' });
  } finally {
    fs.readdirSync = originalReadDirectory;
  }
  assert.equal(flipped, true);
  assert.ok(context.issues.some((issue) => issue.type === 'permission-lost' && issue.code === 'PERMISSION_DENIED'));
});

test('fingerprint includes stable size, mtime, and SHA-256 across repeated probes', async (t) => {
  const context = makeHarness(t);
  const source = path.join(context.root, 'stable.m4a');
  fs.writeFileSync(source, 'stable bytes');
  const first = await fingerprintFile(source, { root: context.root, samples: 2, attempts: 2, intervalMs: 0 });
  const second = await fingerprintFile(source, { root: context.root, samples: 2, attempts: 2, intervalMs: 0 });
  assert.deepEqual(second, first);
  assert.equal(first.sizeBytes, Buffer.byteLength('stable bytes'));
  assert.match(first.sha256, /^[0-9a-f]{64}$/);
});

// Keep the adapter choice executable: paths are canonical and the Darwin
// reference stays null because this Electron main process is unsandboxed.
test('Darwin folder adapter keeps canonical paths and injectable bookmark seam', (t) => {
  const context = makeHarness(t);
  const alias = `${context.root}-alias`;
  fs.symlinkSync(context.root, alias, 'dir');
  t.after(() => fs.rmSync(alias, { force: true }));
  const access = createFolderAccessAdapter('darwin').resolve(alias);
  assert.equal(access.canonicalPath, fs.realpathSync.native(context.root));
  assert.equal(access.accessRef, null);
  const injected = createFolderAccessAdapter('darwin', {
    accessReferenceFactory: (canonicalPath) => `bookmark:${canonicalPath}`,
  }).resolve(context.root);
  assert.equal(injected.accessRef, `bookmark:${fs.realpathSync.native(context.root)}`);
});
