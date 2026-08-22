'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBatchDomain } = require('../electron/main/batch/batchDomain.js');
const {
  TEMPORARY_PREFIX,
  createBatchCompanionWriter,
  fingerprintFile,
} = require('../electron/main/batch/batchCompanionWriter.js');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaniscript-companion-'));
  const sourceName = options.sourceName || 'lecture.part.one.mp3';
  const sourcePath = path.join(root, sourceName);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, options.sourceBytes || Buffer.from('source media'));
  const dbPath = path.join(root, 'batch.sqlite');
  const domain = createBatchDomain({ dbPath });
  const profileId = options.profileId || 'profile-main';
  const jobId = options.jobId || 'job-main';
  domain.createProfile({ profileId, name: 'Lectures', sourcePath: root, recursive: true });
  const outputPath = `${sourcePath.slice(0, -path.extname(sourcePath).length)}.txt`;
  domain.enqueueJob({
    jobId,
    profileId,
    sourcePath,
    outputPath,
    configSnapshot: {},
  });
  domain.startJob(jobId);
  t.after(() => {
    try { domain.close(); } catch { /* already closed */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, sourcePath, outputPath, domain, profileId, jobId };
}

function tempEntries(root) {
  return fs.readdirSync(root).filter((name) => name.startsWith(TEMPORARY_PREFIX));
}

function write(fixtureValue, content, options = {}) {
  return createBatchCompanionWriter({ domain: fixtureValue.domain }).write({
    domain: fixtureValue.domain,
    jobId: fixtureValue.jobId,
    profileRoot: fixtureValue.root,
    sourcePath: fixtureValue.sourcePath,
    content,
    ...options,
  });
}

test('writes a derived companion atomically and records a byte fingerprint receipt', (t) => {
  const value = fixture(t);
  const result = write(value, 'first transcript');

  assert.equal(result.disposition, 'created');
  assert.equal(fs.realpathSync(result.outputPath), fs.realpathSync(value.outputPath));
  assert.deepEqual(result.outputFingerprint, {
    sizeBytes: Buffer.byteLength('first transcript'),
    sha256: 'e4b3c24822484efe8844b0fd6c16777dcb0f15605918a2a73979b45659670eab',
  });
  assert.equal(fs.readFileSync(value.outputPath, 'utf8'), 'first transcript');
  assert.equal(value.domain.getJob(value.jobId).state, 'done');
  const receipt = value.domain.getOutputReceipt(value.outputPath);
  assert.equal(receipt.jobId, value.jobId);
  assert.deepEqual(receipt.outputFingerprint, result.outputFingerprint);
  assert.equal(receipt.outputPath, result.outputPath);
  assert.deepEqual(tempEntries(value.root), []);
});
test('upgrades an existing v2 database with the receipt migration', (t) => {
  const value = fixture(t);
  const legacy = new (require('better-sqlite3'))(path.join(value.root, 'batch.sqlite'));
  legacy.exec(`
    DROP TABLE output_receipts;
    DELETE FROM schema_migrations WHERE version = 3;
  `);
  legacy.close();
  value.domain.close();

  const upgraded = createBatchDomain({ dbPath: path.join(value.root, 'batch.sqlite') });
  t.after(() => upgraded.close());
  assert.deepEqual(upgraded.getSchemaMigrations().map((row) => row.version), [1, 2, 3]);
  assert.equal(upgraded.getOutputReceipt(value.outputPath), null);
});

test('blocks a non-empty external collision and preserves the existing bytes', (t) => {
  const value = fixture(t);
  fs.writeFileSync(value.outputPath, 'user transcript');

  assert.throws(
    () => write(value, 'generated transcript'),
    (error) => error.code === 'OUTPUT_COLLISION',
  );
  assert.equal(value.domain.getJob(value.jobId).state, 'blockedOutputCollision');
  assert.equal(value.domain.transitionJob(value.jobId, 'pending').state, 'pending');
  assert.equal(fs.readFileSync(value.outputPath, 'utf8'), 'user transcript');
  assert.equal(value.domain.getOutputReceipt(value.outputPath), null);
  assert.deepEqual(tempEntries(value.root), []);
});

test('allows same-fingerprint generated replacement and updates the receipt owner', (t) => {
  const value = fixture(t);
  write(value, 'generated transcript');

  const secondJob = 'job-second';
  value.domain.enqueueJob({
    jobId: 'job-second',
    profileId: value.profileId,
    sourcePath: value.sourcePath,
    outputPath: value.outputPath,
    configSnapshot: {},
  });
  value.domain.startJob('job-second');

  const result = createBatchCompanionWriter({ domain: value.domain }).write({
    domain: value.domain,
    jobId: 'job-second',
    profileRoot: value.root,
    sourcePath: value.sourcePath,
    content: 'replacement transcript',
  });
  assert.equal(result.disposition, 'replacedGenerated');
  assert.equal(fs.readFileSync(value.outputPath, 'utf8'), 'replacement transcript');
  assert.equal(value.domain.getOutputReceipt(value.outputPath).jobId, 'job-second');
});

test('allows an empty pre-existing companion to be replaced', (t) => {
  const value = fixture(t);
  fs.writeFileSync(value.outputPath, '');
  const result = write(value, 'new transcript');

  assert.equal(result.disposition, 'replacedGenerated');
  assert.equal(value.domain.getJob(value.jobId).state, 'done');
  assert.equal(fs.readFileSync(value.outputPath, 'utf8'), 'new transcript');
});
test('preserves a zero-byte output that appears before a failed commit', (t) => {
  const value = fixture(t);
  assert.throws(
    () => write(value, 'failed transcript', {
      beforeCommit: () => fs.writeFileSync(value.outputPath, ''),
      beforeReceipt: () => { throw new Error('receipt failure'); },
    }),
    (error) => error.code === 'INTERNAL' && error.details && error.details.cause === 'receipt failure',
  );
  assert.equal(fs.existsSync(value.outputPath), true);
  assert.equal(fs.statSync(value.outputPath).size, 0);
  assert.deepEqual(tempEntries(value.root), []);
});

test('rejects traversal, output overrides, hidden names, and symlink sources/outputs', (t) => {
  const value = fixture(t);
  const escapePath = path.join(value.root, '..', `vaniscript-companion-escape-${process.pid}-${Date.now()}.txt`);
  assert.throws(
    () => write(value, 'text', { outputPath: escapePath }),
    (error) => error.code === 'PERMISSION_DENIED',
  );
  assert.equal(fs.existsSync(escapePath), false);

  assert.throws(
    () => write(value, 'text', { outputPath: path.join(value.root, 'other.txt') }),
    (error) => error.code === 'PERMISSION_DENIED',
  );

  const hidden = fixture(t, { sourceName: '.hidden.mp3', jobId: 'job-hidden' });
  assert.throws(
    () => write(hidden, 'text'),
    (error) => error.code === 'PERMISSION_DENIED',
  );

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vaniscript-outside-'));
  const linked = fixture(t, { sourceName: 'linked.mp3', jobId: 'job-linked' });
  fs.rmSync(linked.sourcePath);
  fs.symlinkSync(path.join(outside, 'outside.mp3'), linked.sourcePath);
  assert.throws(
    () => write(linked, 'text'),
    (error) => error.code === 'PERMISSION_DENIED',
  );
  const linkedOutput = fixture(t, { sourceName: 'linked-output.mp3', jobId: 'job-linked-output' });
  const outsideOutput = path.join(outside, 'outside-output.txt');
  fs.writeFileSync(outsideOutput, 'foreign output');
  fs.symlinkSync(outsideOutput, linkedOutput.outputPath);
  assert.throws(
    () => write(linkedOutput, 'text'),
    (error) => error.code === 'PERMISSION_DENIED',
  );
  fs.rmSync(outside, { recursive: true, force: true });
});

test('rolls back a renamed output when receipt insertion fails', (t) => {
  const value = fixture(t);
  value.domain.setFailureInjector((point) => {
    if (point === 'outputReceipt:before-insert') throw new Error('receipt injection');
  });

  assert.throws(
    () => write(value, 'transactional transcript'),
    (error) => error.code === 'INTERNAL' && error.details && error.details.cause === 'receipt injection',
  );
  value.domain.setFailureInjector(null);
  assert.equal(fs.existsSync(value.outputPath), false);
  assert.equal(value.domain.getOutputReceipt(value.outputPath), null);
  assert.equal(value.domain.getJob(value.jobId).state, 'running');
  assert.deepEqual(tempEntries(value.root), []);
});

test('cancellation after rename removes only this job output and all temporary files', (t) => {
  const value = fixture(t);
  let cancelled = false;
  assert.throws(
    () => write(value, 'cancelled transcript', {
      beforeReceipt: () => { cancelled = true; },
      isCancelled: () => cancelled,
    }),
    (error) => error.code === 'CANCELLED',
  );
  assert.equal(fs.existsSync(value.outputPath), false);
  assert.equal(value.domain.getOutputReceipt(value.outputPath), null);
  assert.deepEqual(tempEntries(value.root), []);
});

test('failed writes clean partial derivatives and preserve a prior generated output', (t) => {
  const value = fixture(t);
  write(value, 'prior generated transcript');
  const before = fs.readFileSync(value.outputPath, 'utf8');

  const secondJob = 'job-failed';
  value.domain.enqueueJob({
    jobId: secondJob,
    profileId: value.profileId,
    sourcePath: value.sourcePath,
    outputPath: value.outputPath,
    configSnapshot: {},
  });
  value.domain.startJob(secondJob);
  assert.throws(
    () => createBatchCompanionWriter({ domain: value.domain }).write({
      domain: value.domain,
      jobId: secondJob,
      profileRoot: value.root,
      sourcePath: value.sourcePath,
      content: 'failed transcript',
      beforeReceipt: () => { throw new Error('runner failed'); },
    }),
    (error) => error.code === 'INTERNAL' && error.details && error.details.cause === 'runner failed',
  );
  assert.equal(fs.readFileSync(value.outputPath, 'utf8'), before);
  assert.deepEqual(tempEntries(value.root), []);
});

test('derives multi-dot and NFC companions in the source parent', (t) => {
  const value = fixture(t, {
    sourceName: path.join('nested', 'Cafe\u0301.topic.part.mp3'),
    jobId: 'job-unicode',
  });
  const result = write(value, 'unicode transcript');
  assert.equal(fs.realpathSync(path.dirname(result.outputPath)), fs.realpathSync(path.dirname(value.sourcePath)));
  assert.equal(path.basename(result.outputPath).normalize('NFC'), 'Café.topic.part.txt');
  assert.equal(path.basename(result.outputPath).endsWith('.mp3'), false);
  assert.equal(fingerprintFile(result.outputPath).fingerprint.sizeBytes, Buffer.byteLength('unicode transcript'));
});
