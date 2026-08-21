'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ProjectStore, sanitizeProjectId } = require('../electron/main/projects/projectStore.js');
const { AppError } = require('../shared/contracts/errors.ts');
const { validateProjectV3 } = require('../shared/contracts/projects.ts');

let rootDir;
let store;

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vscript-projstore-'));
}

function validMediaProject(overrides = {}) {
  return {
    schemaVersion: 3,
    projectId: 'proj-test-1',
    revision: '1',
    type: 'media',
    metadata: { name: 'Test', sourceFileName: 'audio.wav' },
    mediaState: {
      sourceFileName: 'audio.wav',
      durationSec: 12.5,
      sourceLang: 'en',
      targetLang: 'es',
      transcriptionProvider: 'whisper',
      translationProvider: 'llama',
      outputFormats: ['SRT'],
      chunks: [],
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    assets: [],
    ...overrides,
  };
}

before(() => {
  rootDir = tmpRoot();
  store = new ProjectStore({ baseDir: rootDir });
});

after(() => {
  try {
    fs.rmSync(rootDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('create: writes project.json atomically into a created project directory', () => {
  const saved = store.saveProject(validMediaProject(), undefined);

  const dir = path.join(rootDir, 'proj-test-1');
  assert.ok(fs.existsSync(dir), 'project directory created');
  const file = path.join(dir, 'project.json');
  assert.ok(fs.existsSync(file), 'project.json created');

  // No leftover temp files from the atomic write.
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'no temp files left behind');

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.projectId, 'proj-test-1');
  assert.equal(onDisk.schemaVersion, 3);

  // A fresh revision was minted and differs from the input revision.
  assert.equal(typeof saved.revision, 'string');
  assert.ok(saved.revision.length > 0);
  assert.notEqual(saved.revision, '1');
  assert.equal(saved.revision, onDisk.revision);
});

test('create: rejects overwrite of an existing project when no expectedRevision is given', () => {
  // First save created proj-test-1 in the prior test (same store/root).
  let threw = null;
  try {
    store.saveProject(validMediaProject({ metadata: { name: 'Again', sourceFileName: 'a.wav' } }), undefined);
  } catch (err) {
    threw = err;
  }
  assert.ok(threw instanceof AppError, 'throws an AppError');
  assert.equal(threw.code, 'CONFLICT', 'refuses overwrite without expectedRevision');
});

test('conflict: wrong expectedRevision -> CONFLICT AppError', () => {
  const current = store.loadProject('proj-test-1').revision;
  let threw = null;
  try {
    store.saveProject(validMediaProject(), 'this-is-not-the-revision');
  } catch (err) {
    threw = err;
  }
  assert.ok(threw instanceof AppError, 'throws an AppError');
  assert.equal(threw.code, 'CONFLICT', 'correct AppError code');
  assert.equal(current, store.loadProject('proj-test-1').revision, 'disk unchanged after conflict');
});

test('conflict: expectedRevision against a non-existent project -> CONFLICT', () => {
  let threw = null;
  try {
    store.saveProject(validMediaProject({ projectId: 'ghost' }), '9');
  } catch (err) {
    threw = err;
  }
  assert.ok(threw instanceof AppError);
  assert.equal(threw.code, 'CONFLICT');
  assert.throws(() => store.loadProject('ghost'), (e) => e.code === 'NOT_FOUND');
});

test('update: correct expectedRevision succeeds and bumps revision + updatedAt', () => {
  const loaded = store.loadProject('proj-test-1');
  const oldRev = loaded.revision;
  const oldUpdated = loaded.updatedAt;

  const saved = store.saveProject(validMediaProject(), oldRev);
  assert.notEqual(saved.revision, oldRev, 'revision advanced');
  assert.ok(saved.updatedAt >= oldUpdated, 'updatedAt advanced');
  assert.equal(saved.revision, store.loadProject('proj-test-1').revision, 'persisted revision matches');
});

test('load: NOT_FOUND AppError for missing project', () => {
  let threw = null;
  try {
    store.loadProject('does-not-exist');
  } catch (err) {
    threw = err;
  }
  assert.ok(threw instanceof AppError);
  assert.equal(threw.code, 'NOT_FOUND');
});

test('load: CORRUPT_DATA AppError for invalid JSON', () => {
  const dir = path.join(rootDir, 'corrupt-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), '{ not json', 'utf8');

  let threw = null;
  try {
    store.loadProject('corrupt-1');
  } catch (err) {
    threw = err;
  }
  assert.ok(threw instanceof AppError);
  assert.equal(threw.code, 'CORRUPT_DATA');
});

test('load: CORRUPT_DATA AppError for a non-v3 payload', () => {
  const dir = path.join(rootDir, 'bad-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ foo: 'bar' }), 'utf8');

  let threw = null;
  try {
    store.loadProject('bad-1');
  } catch (err) {
    threw = err;
  }
  assert.ok(threw instanceof AppError);
  assert.equal(threw.code, 'CORRUPT_DATA');
});

test('save: VALIDATION_FAILED AppError for an invalid payload', () => {
  let threw = null;
  try {
    store.saveProject({ projectId: 'x' }, undefined); // missing required fields
  } catch (err) {
    threw = err;
  }
  assert.ok(threw instanceof AppError, 'shared validateProjectV3 error surfaced');
  assert.equal(threw.code, 'VALIDATION_FAILED');
  assert.throws(() => store.loadProject('x'), (e) => e.code === 'NOT_FOUND');
});

test('security: path-traversal / unsafe projectId is rejected at save and load', () => {
  for (const badId of ['../escape', 'a/b', '..', 'space in id']) {
    assert.throws(() => sanitizeProjectId(badId), (e) => e.code === 'VALIDATION_FAILED');
    assert.throws(() => store.loadProject(badId), (e) => e.code === 'VALIDATION_FAILED');
  }
});

test('round-trip: save then load returns a normalized v3 value', () => {
  const original = validMediaProject({ projectId: 'round-trip-1', metadata: { name: 'RT', sourceFileName: 'rt.wav' } });
  const saved = store.saveProject(original, undefined);
  const loaded = store.loadProject('round-trip-1');

  const round = validateProjectV3(loaded);
  assert.ok(round.ok, 'loaded value still passes v3 validation');
  assert.equal(loaded.projectId, 'round-trip-1');
  assert.equal(loaded.revision, saved.revision);
  assert.equal(loaded.schemaVersion, 3);
});
