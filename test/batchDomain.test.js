'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BATCH_DB_SCHEMA_VERSION,
  BatchDomain,
  createBatchDomain,
} = require('../electron/main/batch/batchDomain.js');

function makeTempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaniscript-batch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, dbPath: path.join(dir, 'batch.sqlite') };
}

function openDomain(t, dbPath) {
  const domain = createBatchDomain({ dbPath });
  t.after(() => domain.close());
  return domain;
}

function profileInput(overrides = {}) {
  return {
    profileId: 'profile-main',
    name: 'Lectures',
    sourcePath: '/Volumes/Media/Lectures',
    recursive: true,
    enabled: true,
    config: { language: 'en', model: 'local-small' },
    ...overrides,
  };
}

function jobInput(profileId, overrides = {}) {
  return {
    jobId: 'job-1',
    profileId,
    sourcePath: '/Volumes/Media/Lectures/one.m4a',
    outputPath: '/Volumes/Media/Lectures/one.txt',
    configSnapshot: { language: 'en', model: 'local-small' },
    sourceFingerprint: {
      sizeBytes: 42,
      mtimeMs: 1700000000000,
      sha256: 'a'.repeat(64),
    },
    ...overrides,
  };
}
test('shared batch contracts validate persisted shapes and reject malformed input', () => {
  const {
    validateBatchJob,
    validateBatchJobInput,
    validateBatchProfile,
    validateBatchProfileInput,
  } = require('../shared/contracts/batch.ts');
  const profile = profileInput();
  const createdAt = '2026-01-01T00:00:00.000Z';
  assert.equal(validateBatchProfileInput(profile).ok, true);
  assert.equal(validateBatchProfile({
    schemaVersion: 1,
    profileId: profile.profileId,
    name: profile.name,
    sourcePath: profile.sourcePath,
    accessRef: null,
    enabled: true,
    recursive: true,
    config: {},
    createdAt,
    updatedAt: createdAt,
  }).ok, true);
  assert.equal(validateBatchProfileInput({ ...profile, name: '' }).ok, false);
  assert.equal(validateBatchJobInput({ profileId: profile.profileId, sourcePath: '/tmp/a' }).ok, true);
  assert.equal(validateBatchJob({ schemaVersion: 1, state: 'bogus' }).ok, false);
});


test('fresh database applies forward-only migrations and enables WAL', (t) => {
  const { dbPath } = makeTempStore(t);
  const domain = openDomain(t, dbPath);

  assert.equal(domain.getSchemaVersion(), BATCH_DB_SCHEMA_VERSION);
  assert.deepEqual(domain.getSchemaMigrations().map((row) => row.version), [1, 2, 3]);
  assert.equal(domain.journalMode(), 'wal');
  assert.equal(fs.existsSync(dbPath), true);
});
test('plain-Node driver seam can force the built-in SQLite adapter', (t) => {
  const { dbPath } = makeTempStore(t);
  const domain = openDomain(t, dbPath);
  // The seam is useful when a system better-sqlite3 build has a different ABI
  // from Electron.  Node 26 supplies this adapter; Electron uses better-sqlite3.
  const sqliteDomain = createBatchDomain({ dbPath: `${dbPath}-node`, driver: 'node:sqlite' });
  t.after(() => sqliteDomain.close());
  assert.equal(sqliteDomain.driverKind, 'node:sqlite');
  sqliteDomain.createProfile(profileInput({ profileId: 'node-profile' }));
  assert.equal(sqliteDomain.listProfiles()[0].profileId, 'node-profile');
  domain.close();
});


test('an existing v1 database upgrades without losing rows', (t) => {
  const { dbPath } = makeTempStore(t);
  // Use the installed system-Node build to create the legacy fixture.  The
  // domain itself chooses its normal driver independently on reopen.
  const BetterSqlite3 = require('better-sqlite3');
  const legacy = new BetterSqlite3(dbPath);
  legacy.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations(version, applied_at) VALUES (1, '2026-01-01T00:00:00.000Z');
    CREATE TABLE folder_profiles(
      profile_id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      source_path TEXT NOT NULL,
      access_ref TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      recursive INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE batch_jobs(
      job_id TEXT PRIMARY KEY NOT NULL,
      profile_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE job_checkpoints(
      job_id TEXT NOT NULL,
      checkpoint_key TEXT NOT NULL,
      token TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(job_id, checkpoint_key)
    );
    CREATE TABLE job_events(
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    INSERT INTO folder_profiles(profile_id, name, source_path, enabled, recursive, created_at, updated_at)
      VALUES ('legacy-profile', 'Legacy', '/tmp/legacy', 1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO batch_jobs(job_id, profile_id, source_path, state, created_at, updated_at)
      VALUES ('legacy-job', 'legacy-profile', '/tmp/legacy/file.m4a', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO job_checkpoints(job_id, checkpoint_key, token, metadata_json, created_at, updated_at)
      VALUES ('legacy-job', 'transcribing', 'legacy-token', '{"chunk":1}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO job_events(job_id, event_type, payload_json, created_at)
      VALUES ('legacy-job', 'legacy.imported', '{"source":"v1"}', '2026-01-01T00:00:00.000Z');

  `);
  legacy.close();

  const domain = openDomain(t, dbPath);
  assert.equal(domain.getSchemaVersion(), 3);
  assert.equal(domain.getProfile('legacy-profile').recursive, false);
  assert.deepEqual(domain.getProfile('legacy-profile').config, {});
  const legacyJob = domain.getJob('legacy-job');
  assert.equal(legacyJob.state, 'pending');
  assert.equal(domain.getCheckpoint('legacy-job', 'transcribing').token, 'legacy-token');
  assert.equal(domain.listEvents('legacy-job')[0].eventType, 'legacy.imported');
  const raw = new (require('better-sqlite3'))(dbPath);
  assert.throws(() => raw.prepare('UPDATE job_events SET payload_json = ? WHERE event_id = 1').run('{}'), /append-only/);
  raw.close();
});

test('profile CRUD validates edges and refuses deletion with queued jobs', (t) => {
  const { dbPath } = makeTempStore(t);
  const domain = openDomain(t, dbPath);
  const created = domain.createProfile(profileInput());
  assert.equal(created.profileId, 'profile-main');
  assert.deepEqual(domain.listProfiles(), [created]);

  const updated = domain.updateProfile(created.profileId, {
    name: 'Updated Lectures',
    enabled: false,
    config: { language: 'sa' },
  });
  assert.equal(updated.name, 'Updated Lectures');
  assert.equal(updated.enabled, false);
  assert.deepEqual(updated.config, { language: 'sa' });
  assert.deepEqual(domain.listProfiles({ enabled: true }), []);
  assert.deepEqual(domain.listProfiles({ enabled: false }), [updated]);

  assert.throws(() => domain.createProfile(profileInput()), (error) => error.code === 'CONFLICT');
  domain.enqueueJob(jobInput(created.profileId));
  assert.throws(() => domain.deleteProfile(created.profileId), (error) => error.code === 'CONFLICT');
  assert.throws(() => domain.createProfile({ name: '', sourcePath: '/tmp/x' }), (error) => error.code === 'VALIDATION_FAILED');
});

test('paged jobs search escaped substrings across every filter field', (t) => {
  const { dbPath } = makeTempStore(t);
  const domain = openDomain(t, dbPath);
  domain.createProfile(profileInput());
  domain.enqueueJob(jobInput('profile-main', { jobId: 'job-alpha', sourcePath: '/Volumes/Media/Lectures/lecture.m4a' }));
  domain.enqueueJob(jobInput('profile-main', { jobId: 'job-beta', sourcePath: '/Volumes/Media/Other/100%_literal.m4a', outputPath: '/Volumes/Media/Other/100%_literal.txt' }));
  const page = domain.listJobs({ limit: 1, offset: 0, query: 'lecture' });
  assert.equal(page.length, 1);
  assert.equal(page[0].jobId, 'job-alpha');
  assert.equal(domain.countJobs({ query: 'lecture' }), 1);
  assert.equal(domain.listJobs({ query: '%' }).length, 1);
});

test('enqueue transaction rolls back a forced mid-write failure', (t) => {
  const { dbPath } = makeTempStore(t);
  const domain = openDomain(t, dbPath);
  domain.createProfile(profileInput());
  domain.setFailureInjector((point) => {
    if (point === 'job:after-insert') throw new Error('forced transaction failure');
  });

  assert.throws(() => domain.enqueueJob(jobInput('profile-main')), /forced transaction failure/);
  domain.setFailureInjector(null);
  assert.deepEqual(domain.listJobs(), []);

  // A retry with the same stable id succeeds because the failed transaction
  // left no partially inserted job/event behind.
  const job = domain.enqueueJob(jobInput('profile-main'));
  assert.equal(job.state, 'pending');
  assert.deepEqual(domain.listEvents(job.jobId).map((event) => event.eventType), ['job.enqueued']);
});

test('job state machine enforces pending → running → terminal states', (t) => {
  const { dbPath } = makeTempStore(t);
  const domain = openDomain(t, dbPath);
  domain.createProfile(profileInput());
  const pending = domain.enqueueJob(jobInput('profile-main'));

  assert.throws(() => domain.transitionJob(pending.jobId, 'done'), (error) => error.code === 'CONFLICT');
  assert.equal(domain.getJob(pending.jobId).state, 'pending');

  const running = domain.startJob(pending.jobId, { phase: 'transcribing', progress: 0.25 });
  assert.equal(running.state, 'running');
  assert.equal(running.attempt, 1);
  assert.equal(running.phase, 'transcribing');
  assert.equal(running.progress, 0.25);

  const done = domain.completeJob(pending.jobId, { outputFingerprint: 'b'.repeat(64) });
  assert.equal(done.state, 'done');
  assert.equal(done.progress, 1);
  assert.equal(done.completedAt !== null, true);
  assert.throws(() => domain.cancelJob(pending.jobId), (error) => error.code === 'CONFLICT');

  const failed = domain.enqueueJob(jobInput('profile-main', { jobId: 'job-failed' }));
  domain.startJob(failed.jobId);
  const failedDone = domain.failJob(failed.jobId, 'model unavailable');
  assert.equal(failedDone.state, 'failed');
  assert.equal(failedDone.lastError, 'model unavailable');

  const cancelled = domain.enqueueJob(jobInput('profile-main', { jobId: 'job-cancelled' }));
  assert.equal(domain.cancelJob(cancelled.jobId).state, 'cancelled');
});

test('checkpoint and append-only event log survive close and reopen', (t) => {
  const { dbPath } = makeTempStore(t);
  const first = createBatchDomain({ dbPath });
  first.createProfile(profileInput());
  const job = first.enqueueJob(jobInput('profile-main'));
  first.startJob(job.jobId);
  const checkpoint = first.saveCheckpoint(job.jobId, {
    checkpointKey: 'transcribing',
    token: 'resume-token-1',
    metadata: { chunk: 3, offset: 18 },
  });
  first.saveCheckpoint(job.jobId, 'transcribing', 'resume-token-2', { chunk: 4, offset: 1 });
  first.appendEvent(job.jobId, { eventType: 'worker.heartbeat', payload: { elapsedMs: 50 } });
  const beforeCloseEvents = first.listEvents(job.jobId);
  assert.equal(beforeCloseEvents.length, 5);
  assert.equal(beforeCloseEvents[0].eventType, 'job.enqueued');
  assert.equal(beforeCloseEvents.at(-1).eventType, 'worker.heartbeat');
  first.close();

  const second = openDomain(t, dbPath);
  assert.equal(second.getJob(job.jobId).state, 'running');
  assert.equal(second.getCheckpoint(job.jobId, 'transcribing').token, 'resume-token-2');
  assert.deepEqual(second.getCheckpoint(job.jobId, 'missing'), null);
  assert.equal(second.listCheckpoints(job.jobId).length, 1);
  const afterReopenEvents = second.listEvents(job.jobId);
  assert.equal(afterReopenEvents.length, beforeCloseEvents.length);
  assert.deepEqual(afterReopenEvents.map((event) => event.eventId), [1, 2, 3, 4, 5]);
  assert.deepEqual(afterReopenEvents.map((event) => event.eventType), [
    'job.enqueued',
    'job.stateChanged',
    'job.checkpointSaved',
    'job.checkpointSaved',
    'worker.heartbeat',
  ]);
  assert.equal(checkpoint.token, 'resume-token-1');
});

test('event listing is ordered, bounded, and rejects invalid jobs', (t) => {
  const { dbPath } = makeTempStore(t);
  const domain = openDomain(t, dbPath);
  domain.createProfile(profileInput());
  const job = domain.enqueueJob(jobInput('profile-main'));
  domain.appendEvent(job.jobId, { eventType: 'custom.one', payload: { n: 1 } });
  domain.appendEvent(job.jobId, { eventType: 'custom.two', payload: { n: 2 } });
  assert.deepEqual(domain.listEvents(job.jobId, { limit: 1 }).map((event) => event.eventType), ['job.enqueued']);
  assert.deepEqual(domain.listEvents(job.jobId, { afterEventId: 1 }).map((event) => event.eventType), ['custom.one', 'custom.two']);
  assert.throws(() => domain.listEvents('missing'), (error) => error.code === 'NOT_FOUND');
  assert.throws(() => domain.saveCheckpoint(job.jobId, { checkpointKey: '', token: 'x' }), (error) => error.code === 'VALIDATION_FAILED');
});

test('domain close is idempotent and blocks use-after-close', (t) => {
  const { dbPath } = makeTempStore(t);
  const domain = createBatchDomain({ dbPath });
  domain.close();
  domain.close();
  assert.throws(() => domain.getSchemaVersion(), (error) => error.code === 'CONFLICT');
});
