const test = require('node:test');
const assert = require('node:assert/strict');
const {
  migrateProject,
  validateProjectV3,
  isProjectV3,
  PROJECT_SCHEMA_VERSION,
} = require('../shared/contracts/projects.ts');
const { AppError, isAppError } = require('../shared/contracts/errors.ts');

const VALIDATION_FAILED = 'VALIDATION_FAILED';
const ok = (fn = () => true) => (err) => isAppError(err) && err.code === VALIDATION_FAILED && fn(err);

// --- Fixtures ---------------------------------------------------------------

const legacyV1Flat = {
  id: 'legacy-1',
  name: 'Lecture Week 1',
  sourceFileName: 'lecture.wav',
  sourceFile: '/tmp/lecture.wav',
  durationSec: 120,
  sourceLang: 'en',
  targetLang: 'es',
  transcriptionProvider: 'gemini',
  translationProvider: 'openai',
  outputFormats: ['SRT', 'VTT'],
  chunks: [
    {
      index: 0,
      filePath: 'a.wav',
      durationSec: 10,
      startSec: 0,
      endSec: 10,
      original: 'hi',
      translated: 'hola',
      status: 'done',
      approved: true,
    },
  ],
  currentChunkIndex: 0,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-02T00:00:00.000Z',
};

const legacyV2Wrapped = {
  schemaVersion: 2,
  projectId: 'legacy-2',
  name: 'Interview',
  media: {
    sourceFileName: 'int.mp4',
    durationSec: 300,
    sourceLang: 'en',
    targetLang: 'fr',
    transcriptionProvider: 'whisper',
    translationProvider: 'gemini',
    outputFormats: ['SRT'],
    chunks: [],
    currentChunkIndex: 0,
  },
  createdAt: '2024-03-01T00:00:00.000Z',
  updatedAt: '2024-03-01T00:00:00.000Z',
};

const validV3Media = {
  schemaVersion: 3,
  projectId: 'p3',
  revision: '7',
  type: 'media',
  mediaState: {
    sourceFile: null,
    sourceFileName: 'a.wav',
    durationSec: 5,
    sourceLang: 'en',
    targetLang: 'de',
    transcriptionProvider: 'x',
    translationProvider: 'y',
    outputFormats: ['SRT'],
    chunks: [],
    currentChunkIndex: 0,
  },
  metadata: { name: 'A', sourceFileName: 'a.wav' },
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  assets: [],
};

const validV3Document = {
  schemaVersion: 3,
  projectId: 'pd',
  revision: '1',
  type: 'document',
  documentState: {
    sourceFileName: 'doc.pdf',
    title: 'My Doc',
    sourceLang: 'en',
    targetLang: 'es',
    translationProvider: 'openai',
  },
  metadata: { name: 'My Doc', sourceFileName: 'doc.pdf' },
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

// --- Tests ------------------------------------------------------------------

test('PROJECT_SCHEMA_VERSION is 3', () => {
  assert.equal(PROJECT_SCHEMA_VERSION, 3);
});

test('migrates a v1 flat media session to v3', () => {
  const p = migrateProject(legacyV1Flat);
  assert.equal(p.schemaVersion, 3);
  assert.equal(p.type, 'media');
  assert.equal(p.projectId, 'legacy-1');
  assert.equal(p.revision, '1');
  const ms = p.mediaState;
  assert.equal(ms.sourceFileName, 'lecture.wav');
  assert.equal(ms.sourceFile, '/tmp/lecture.wav');
  assert.equal(ms.durationSec, 120);
  assert.equal(ms.sourceLang, 'en');
  assert.equal(ms.targetLang, 'es');
  assert.deepEqual(ms.outputFormats, ['SRT', 'VTT']);
  assert.equal(ms.chunks.length, 1);
  assert.equal(p.metadata.name, 'Lecture Week 1');
  assert.equal(p.createdAt, '2024-01-01T00:00:00.000Z');
});

test('migrates a v2 wrapped media session to v3', () => {
  const p = migrateProject(legacyV2Wrapped);
  assert.equal(p.schemaVersion, 3);
  assert.equal(p.type, 'media');
  assert.equal(p.projectId, 'legacy-2');
  assert.equal(p.mediaState.sourceFileName, 'int.mp4');
  assert.equal(p.mediaState.durationSec, 300);
  assert.equal(p.mediaState.targetLang, 'fr');
});

test('migrates a legacy document project to v3 document variant', () => {
  const legacyDoc = {
    schemaVersion: 1,
    id: 'doc-1',
    name: 'Paper',
    title: 'Paper',
    type: 'document',
    sourceFileName: 'paper.pdf',
    sourceLang: 'en',
    targetLang: 'es',
    translationProvider: 'openai',
  };
  const p = migrateProject(legacyDoc);
  assert.equal(p.type, 'document');
  assert.equal(p.projectId, 'doc-1');
  assert.equal(p.documentState.title, 'Paper');
  assert.equal(p.documentState.targetLang, 'es');
});

test('passes an already-valid v3 media project through unchanged', () => {
  const p = migrateProject(validV3Media);
  assert.equal(p.schemaVersion, 3);
  assert.equal(p.type, 'media');
  assert.equal(p.projectId, 'p3');
  assert.equal(p.revision, '7');
  assert.equal(p.mediaState.sourceFileName, 'a.wav');
});

test('passes an already-valid v3 document project through unchanged', () => {
  const p = migrateProject(validV3Document);
  assert.equal(p.type, 'document');
  assert.equal(p.documentState.title, 'My Doc');
});

test('round-trips: migrated output validates as v3', () => {
  for (const fixture of [legacyV1Flat, legacyV2Wrapped, validV3Media, validV3Document]) {
    const p = migrateProject(fixture);
    const re = validateProjectV3(p);
    assert.ok(re.ok, `expected valid v3 for ${fixture.id ?? fixture.projectId}`);
    if (re.ok) assert.ok(isProjectV3(re.value));
  }
});

test('validateProjectV3 returns ok:false (AppError) for malformed input', () => {
  const re = validateProjectV3({ type: 'media' });
  assert.equal(re.ok, false);
  if (!re.ok) {
    assert.ok(isAppError(re.error));
    assert.equal(re.error.code, VALIDATION_FAILED);
  }
});

test('rejects null payloads', () => {
  assert.throws(() => migrateProject(null), ok((e) => e instanceof AppError));
});

test('rejects array payloads', () => {
  assert.throws(() => migrateProject([]), ok());
});

test('rejects a v3 media project missing mediaState', () => {
  const bad = { ...validV3Media };
  delete bad.mediaState;
  assert.throws(() => migrateProject(bad), ok());
});

test('rejects a v3 media project missing mediaState.sourceFileName', () => {
  const bad = JSON.parse(JSON.stringify(validV3Media));
  delete bad.mediaState.sourceFileName;
  assert.throws(() => migrateProject(bad), ok());
});

test('rejects a newer schemaVersion (downgrade guard)', () => {
  const future = { ...validV3Media, schemaVersion: 4 };
  assert.throws(
    () => migrateProject(future),
    (e) => isAppError(e) && e.code === VALIDATION_FAILED,
  );
});

test('rejects a document project missing required documentState fields', () => {
  const bad = {
    schemaVersion: 3,
    projectId: 'pd',
    revision: '1',
    type: 'document',
    documentState: { sourceFileName: '', title: '', sourceLang: '', targetLang: '', translationProvider: '' },
    metadata: { name: 'x', sourceFileName: 'x' },
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
  assert.throws(() => migrateProject(bad), ok());
});
