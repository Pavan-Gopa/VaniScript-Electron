'use strict';

// DOC-02 — Document project persistence tests.
//
// Covers the observable persistence contracts on top of the P2.D6 atomic
// project store: save/reopen fidelity (structure, edits, policies, approval,
// undo recovery epoch), per-language archive isolation (adding a language
// never touches existing archives — byte-wise), hash-based freshness
// propagation, revision-guarded mutations, corrupt/partial archive recovery,
// and bundle export/import round-trips with checksum verification.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const archiver = require('archiver');

const { getFixture } = require('./fixtures/document-fixtures.js');
const { importDocument } = require('../electron/main/documents/import.js');
const {
  DocumentProjectStore,
  runProjectExclusive,
  blockSourceHash,
  computeFreshness,
  MUTATION_INTENT_SUFFIX,
  MUTATION_INTENT_VERSION,
  CREATE_STAGING_SUFFIX,
  DOCUMENT_FILE,
  TRANSLATIONS_DIR,
} = require('../electron/main/documents/documentProjectStore.js');
const {
  exportProjectBundle,
  importProjectBundle,
  BUNDLE_FORMAT,
} = require('../electron/main/projects/bundle.js');
const { AppError } = require('../shared/contracts/errors.ts');
const {
  normalizeBcp47,
  validateDocumentArchive,
  validateNormalizedDocument,
  validateTranslationArchive,
  TRANSLATION_ARCHIVE_SCHEMA_VERSION,
} = require('../shared/contracts/documents.ts');

let rootDir;
let store;

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vscript-docstore-'));
}

const T0 = '2026-01-01T00:00:00.000Z';

// Canonical 64-hex SHA-256 placeholder digests for provenance/hash fixtures.
const META_HASH = 'aa'.repeat(32);
const OTHER_HASH = 'bb'.repeat(32);

let importedTxt;
/** Canonical (validated) import — raw import objects carry explicit undefined keys. */
let importedBlocks;

function documentProject(projectId, overrides = {}) {
  return {
    schemaVersion: 3,
    projectId,
    revision: '1',
    type: 'document',
    metadata: { name: 'Doc Project', sourceFileName: 'sample.txt' },
    documentState: {
      sourceFileName: 'sample.txt',
      title: 'Hello world.',
      sourceLang: 'en',
      targetLang: 'de',
      translationProvider: 'llama',
    },
    createdAt: T0,
    updatedAt: T0,
    assets: [],
    ...overrides,
  };
}

function archiveFor(projectId, doc, overrides = {}) {
  return {
    schemaVersion: 1,
    projectId,
    format: doc.format,
    title: doc.title,
    sourceAsset: doc.sourceAsset,
    preflight: doc.preflight,
    blocks: doc.blocks,
    editBaselines: {},
    blockPolicies: {},
    spanPolicies: {},
    editEpoch: 0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function createTxtProject(projectId) {
  return store.createDocumentProject(documentProject(projectId), archiveFor(projectId, importedTxt));
}

function readProjectRevision(projectId) {
  return JSON.parse(
    fs.readFileSync(path.join(rootDir, projectId, 'project.json'), 'utf8'),
  ).revision;
}

function translationBytes(projectId, language) {
  return fs.readFileSync(path.join(rootDir, projectId, TRANSLATIONS_DIR, `${language}.json`));
}

function errorCode(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AppError, `expected AppError, got ${err}`);
    return err.code;
  }
  return null;
}

/** errorCode with the full error surfaced — for message-shape assertions. */
function thrownError(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AppError, `expected AppError, got ${err}`);
    return err;
  }
  return null;
}

/** Sibling staging directory where a journaled creation is built. */
function stagingPathFor(projectId) {
  return path.join(rootDir, `${projectId}${CREATE_STAGING_SUFFIX}`);
}

function intentPathFor(projectId) {
  return path.join(rootDir, `${projectId}${MUTATION_INTENT_SUFFIX}`);
}

/** Hand-write a durable creation intent exactly as the store journals it. */
function writeCreateIntentFile(projectId, intent) {
  fs.writeFileSync(
    intentPathFor(projectId),
    JSON.stringify(
      {
        version: MUTATION_INTENT_VERSION,
        projectId,
        action: 'create',
        targetFile: DOCUMENT_FILE,
        stagingDir: path.relative(rootDir, stagingPathFor(projectId)),
        ...intent,
      },
      null,
      2,
    ),
  );
}

/**
 * Directories OUTSIDE the store root, for symlink-escape fixtures;
 * removed in test.after.
 */
const externalDirs = [];
function externalTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscript-escape-'));
  externalDirs.push(dir);
  return dir;
}

/** Hand-build a COMPLETE leased staged pair exactly as the store stages it. */
function stageCompletePair(projectId, content) {
  fs.mkdirSync(path.join(stagingPathFor(projectId), projectId), { recursive: true });
  fs.writeFileSync(
    path.join(stagingPathFor(projectId), projectId, 'project.json'),
    JSON.stringify(documentProject(projectId), null, 2),
  );
  fs.writeFileSync(path.join(stagingPathFor(projectId), projectId, DOCUMENT_FILE), content);
}

async function makeArchivedZip(outPath, entries) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    for (const [name, content] of Object.entries(entries)) {
      archive.append(Buffer.isBuffer(content) ? content : Buffer.from(content), { name });
    }
    archive.finalize();
  });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** sha256 over the bytes of a file on disk — lease-identity fixtures. */
function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

test.before(async () => {
  rootDir = tmpRoot();
  store = new DocumentProjectStore({ baseDir: rootDir });
  importedTxt = await importDocument(getFixture('txt'));
  importedBlocks = validateNormalizedDocument(importedTxt).value.blocks;
});

test.after(() => {
  try {
    fs.rmSync(rootDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  for (const dir of externalDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// --- Creation / reopen fidelity ------------------------------------------------

test('create + reopen preserves structure, preflight and source asset', () => {
  const { project, archive } = createTxtProject('proj-fidelity');

  const dir = path.join(rootDir, 'proj-fidelity');
  assert.ok(fs.existsSync(path.join(dir, 'project.json')));
  assert.ok(fs.existsSync(path.join(dir, DOCUMENT_FILE)));
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.includes('.tmp')),
    [],
    'no temp files left behind',
  );

  const reopened = store.loadDocumentProject('proj-fidelity');
  assert.equal(reopened.project.revision, project.revision);
  assert.deepEqual(reopened.archive, archive);
  assert.equal(reopened.archive.format, 'txt');
  assert.equal(reopened.archive.title, 'Hello world.');
  assert.equal(reopened.archive.sourceAsset.ref, 'asset://golden/txt');
  assert.equal(reopened.archive.preflight.blocks, 2);
  assert.deepEqual(
    reopened.archive.blocks.map((b) => b.text),
    ['Hello world.', 'Second paragraph here.'],
  );
  // Stable identity + style fingerprints survive the round trip untouched.
  assert.deepEqual(
    reopened.archive.blocks.map((b) => [b.blockId, b.styleFingerprint, b.sourceHash]),
    importedBlocks.map((b) => [b.blockId, b.styleFingerprint, b.sourceHash]),
  );
});

test('create rejects duplicates, non-document projects and mismatched archives', () => {
  assert.equal(errorCode(() => createTxtProject('proj-fidelity')), 'CONFLICT');
  assert.equal(
    errorCode(() =>
      store.createDocumentProject(
        documentProject('proj-media-x', { type: 'media' }),
        archiveFor('proj-media-x', importedTxt),
      ),
    ),
    'VALIDATION_FAILED',
  );
  const mismatched = archiveFor('other-id', importedTxt);
  assert.equal(
    errorCode(() => store.createDocumentProject(documentProject('proj-mm'), mismatched)),
    'VALIDATION_FAILED',
  );
  const badSchema = archiveFor('proj-bs', importedTxt, { schemaVersion: 99 });
  assert.equal(
    errorCode(() => store.createDocumentProject(documentProject('proj-bs'), badSchema)),
    'VALIDATION_FAILED',
  );
});

test('loadDocumentProject rejects missing and media projects', () => {
  assert.equal(errorCode(() => store.loadDocumentProject('ghost-doc')), 'NOT_FOUND');

  // A real media project in the same store must not open as a document project.
  store.projectStore.saveProject(
    {
      ...documentProject('proj-media-real', { type: 'media' }),
      mediaState: {
        sourceFileName: 'a.wav',
        durationSec: 5,
        sourceLang: 'en',
        targetLang: 'de',
        transcriptionProvider: 'whisper',
        translationProvider: 'llama',
        outputFormats: ['SRT'],
        chunks: [],
      },
    },
    undefined,
  );
  assert.equal(errorCode(() => store.loadDocumentProject('proj-media-real')), 'VALIDATION_FAILED');
});

// --- Edits, baselines, policies, undo epoch --------------------------------------

test('source edits persist with baseline, spans and undo epoch', () => {
  createTxtProject('proj-edits');
  let rev = readProjectRevision('proj-edits');

  const first = store.updateBlockText('proj-edits', 'b0', 'Hello edited world.', rev);
  rev = first.revision;
  assert.equal(first.archive.editEpoch, 1);
  assert.equal(first.block.text, 'Hello edited world.');
  assert.deepEqual(first.block.spans, [
    { spanId: 'b0-s0', blockId: 'b0', text: 'Hello edited world.', start: 0, end: 19, traits: {} },
  ]);

  store.updateBlockText('proj-edits', 'b0', 'Hello final world.', rev, {
    spans: [
      { spanId: 'b0-s0', blockId: 'b0', text: 'Hello ', start: 0, end: 6, traits: {} },
      { spanId: 'b0-s1', blockId: 'b0', text: 'final', start: 6, end: 11, traits: { bold: true } },
      { spanId: 'b0-s2', blockId: 'b0', text: ' world.', start: 11, end: 18, traits: {} },
    ],
  });

  const reopened = store.loadDocumentArchive('proj-edits');
  assert.equal(reopened.editEpoch, 2);
  assert.equal(reopened.blocks[0].text, 'Hello final world.');
  assert.equal(reopened.blocks[0].spans[1].traits.bold, true);
  // The baseline is the FIRST imported state, not intermediate edits.
  assert.deepEqual(reopened.editBaselines.b0, importedBlocks[0]);
  // Untouched blocks are unchanged.
  assert.deepEqual(reopened.blocks[1], importedBlocks[1]);
});

test('span replacement validates exact tiling', () => {
  createTxtProject('proj-tiling');
  let rev = readProjectRevision('proj-tiling');

  ({ revision: rev } = store.updateBlockText('proj-tiling', 'b1', 'abc def', rev, {
    spans: [
      { spanId: 'b1-s0', blockId: 'b1', text: 'abc ', start: 0, end: 4, traits: {} },
      { spanId: 'b1-s1', blockId: 'b1', text: 'def', start: 4, end: 7, traits: { italic: true } },
    ],
  }));
  assert.equal(store.loadDocumentArchive('proj-tiling').blocks[1].spans.length, 2);

  const bad = (label, spans) =>
    assert.equal(
      errorCode(() => store.updateBlockText('proj-tiling', 'b1', 'abc def', rev, { spans })),
      'VALIDATION_FAILED',
      label,
    );
  bad('gap', [{ spanId: 's', blockId: 'b1', text: 'abc', start: 0, end: 3, traits: {} }]);
  bad('overlap', [
    { spanId: 's0', blockId: 'b1', text: 'abcd', start: 0, end: 4, traits: {} },
    { spanId: 's1', blockId: 'b1', text: 'def', start: 3, end: 7, traits: {} },
  ]);
  bad('short cover', [
    { spanId: 's0', blockId: 'b1', text: 'abc ', start: 0, end: 4, traits: {} },
    { spanId: 's1', blockId: 'b1', text: 'de', start: 4, end: 6, traits: {} },
  ]);
  bad('text mismatch', [
    { spanId: 's0', blockId: 'b1', text: 'xyz ', start: 0, end: 4, traits: {} },
    { spanId: 's1', blockId: 'b1', text: 'def', start: 4, end: 7, traits: {} },
  ]);
  bad('foreign block', [
    { spanId: 's0', blockId: 'b0', text: 'abc ', start: 0, end: 4, traits: {} },
    { spanId: 's1', blockId: 'b1', text: 'def', start: 4, end: 7, traits: {} },
  ]);
  // Rejected requests leave the revision untouched (validation precedes the lease).
  assert.equal(readProjectRevision('proj-tiling'), rev);
  assert.equal(errorCode(() => store.updateBlockText('proj-tiling', 'nope', 'x', rev)), 'NOT_FOUND');
});

test('block/span policies persist and can be cleared', () => {
  createTxtProject('proj-policy');
  let rev = readProjectRevision('proj-policy');

  rev = store.setBlockPolicy('proj-policy', 'b1', { action: 'protect', note: 'mantra' }, rev).revision;
  rev = store.setSpanPolicy('proj-policy', 'b0-s0', { action: 'protect' }, rev).revision;

  let archive = store.loadDocumentArchive('proj-policy');
  assert.deepEqual(archive.blockPolicies.b1, { action: 'protect', note: 'mantra' });
  assert.deepEqual(archive.spanPolicies['b0-s0'], { action: 'protect' });

  rev = store.setBlockPolicy('proj-policy', 'b1', null, rev).revision;
  archive = store.loadDocumentArchive('proj-policy');
  assert.equal(archive.blockPolicies.b1, undefined);
  assert.deepEqual(archive.spanPolicies['b0-s0'], { action: 'protect' });

  assert.equal(errorCode(() => store.setBlockPolicy('proj-policy', 'ghost', null, rev)), 'NOT_FOUND');
  assert.equal(errorCode(() => store.setSpanPolicy('proj-policy', 'ghost-span', null, rev)), 'NOT_FOUND');
  assert.equal(
    errorCode(() => store.setBlockPolicy('proj-policy', 'b0', { action: 'burn' }, rev)),
    'VALIDATION_FAILED',
  );
});

// --- Revision discipline -----------------------------------------------------------

test('mutations are revision-guarded', () => {
  createTxtProject('proj-rev');
  const rev1 = readProjectRevision('proj-rev');

  assert.equal(
    errorCode(() => store.updateBlockText('proj-rev', 'b0', 'x', 'stale-revision')),
    'CONFLICT',
  );
  assert.equal(
    errorCode(() => store.updateBlockText('proj-rev', 'b0', 'x', undefined)),
    'VALIDATION_FAILED',
    'expectedRevision is mandatory for mutations',
  );
  assert.equal(
    errorCode(() => store.addLanguage('proj-rev', 'de', { provider: 'p', sourceHash: META_HASH }, undefined)),
    'VALIDATION_FAILED',
  );
  assert.equal(
    errorCode(() => store.updateBlockText('missing-project', 'b0', 'x', 'r1')),
    'NOT_FOUND',
  );

  const { revision: rev2 } = store.updateBlockText('proj-rev', 'b0', 'Hello again.', rev1);
  assert.notEqual(rev2, rev1);
  // The old revision is now stale for every subsequent mutation. The
  // wholesale fixture carries the CURRENT epoch so the revision conflict —
  // not an epoch-regression rejection — is what surfaces.
  const currentEpoch = store.loadDocumentArchive('proj-rev').editEpoch;
  assert.equal(
    errorCode(() =>
      store.saveDocumentArchive(
        'proj-rev',
        archiveFor('proj-rev', importedTxt, { editEpoch: currentEpoch }),
        rev1,
      ),
    ),
    'CONFLICT',
  );
  assert.equal(readProjectRevision('proj-rev'), rev2);
});

// --- Language variants ---------------------------------------------------------------

test('adding a second language never mutates the first (byte-wise)', () => {
  createTxtProject('proj-lang');
  let rev = readProjectRevision('proj-lang');

  ({ revision: rev } = store.addLanguage('proj-lang', 'de', {
    provider: 'llama',
    model: 'qwen2.5-14b',
    profile: 'literary',
    promptVersion: 'pv7',
    glossaryRevision: 'g3',
    sourceHash: importedTxt.sourceAsset.hash,
  }, rev));

  ({ revision: rev } = store.saveTranslations('proj-lang', 'de', [
    { blockId: 'b0', text: 'Hallo Welt.', status: 'approved' },
    { blockId: 'b1', text: 'Zweiter Absatz hier.' },
  ], rev));

  const deBefore = translationBytes('proj-lang', 'de');

  // Adding fr must not touch de.json — byte-for-byte.
  ({ revision: rev } = store.addLanguage('proj-lang', 'fr', { provider: 'gemini', sourceHash: importedTxt.sourceAsset.hash }, rev));
  assert.ok(translationBytes('proj-lang', 'de').equals(deBefore), 'de.json byte-identical after adding fr');

  ({ revision: rev } = store.saveTranslations('proj-lang', 'fr', [{ blockId: 'b0', text: 'Bonjour le monde.' }], rev));
  assert.ok(translationBytes('proj-lang', 'de').equals(deBefore), 'de.json byte-identical after fr commit');

  const languages = store.listLanguages('proj-lang');
  assert.deepEqual(languages.map((l) => l.language), ['de', 'fr']);
  assert.equal(languages[0].blockCount, 2);
  assert.equal(languages[0].meta.model, 'qwen2.5-14b');
  assert.equal(languages[0].meta.promptVersion, 'pv7');
  assert.equal(languages[1].blockCount, 1);

  const de = store.getTranslationArchive('proj-lang', 'de');
  assert.equal(de.blocks.b0.status, 'approved');
  assert.equal(de.blocks.b1.status, 'draft');

  assert.equal(errorCode(() => store.addLanguage('proj-lang', 'de', { provider: 'x', sourceHash: META_HASH }, rev)), 'CONFLICT');
  assert.equal(errorCode(() => store.addLanguage('proj-lang', 'not a tag!', { provider: 'x', sourceHash: META_HASH }, rev)), 'VALIDATION_FAILED');
  assert.equal(errorCode(() => store.addLanguage('proj-lang', 'pt-BR', { provider: undefined, sourceHash: META_HASH }, rev)), 'VALIDATION_FAILED');

  // Case-insensitive access normalizes to the canonical tag/file.
  assert.equal(store.getTranslationArchive('proj-lang', 'DE').language, 'de');
  store.addLanguage('proj-lang', 'EN-us', { provider: 'openai', sourceHash: META_HASH }, rev);
  assert.ok(fs.existsSync(path.join(rootDir, 'proj-lang', TRANSLATIONS_DIR, 'en-US.json')));
});

test('active language switching is view-state only', () => {
  createTxtProject('proj-active');
  let rev = readProjectRevision('proj-active');
  ({ revision: rev } = store.addLanguage('proj-active', 'de', { provider: 'llama', sourceHash: META_HASH }, rev));
  const deBefore = translationBytes('proj-active', 'de');

  const { project, revision } = store.setActiveLanguage('proj-active', 'DE', rev);
  assert.equal(project.activeTranslationLanguage, 'de');
  assert.ok(translationBytes('proj-active', 'de').equals(deBefore), 'switching active language does not touch archives');

  assert.equal(errorCode(() => store.setActiveLanguage('proj-active', 'fr', revision)), 'NOT_FOUND');
});

test('removeLanguage deletes, backs up and clears active view state', () => {
  createTxtProject('proj-rm');
  let rev = readProjectRevision('proj-rm');
  ({ revision: rev } = store.addLanguage('proj-rm', 'de', { provider: 'llama', sourceHash: META_HASH }, rev));
  ({ revision: rev } = store.addLanguage('proj-rm', 'fr', { provider: 'llama', sourceHash: META_HASH }, rev));
  ({ revision: rev } = store.setActiveLanguage('proj-rm', 'de', rev));

  const backupDir = path.join(rootDir, 'proj-rm-backups');
  const deBefore = translationBytes('proj-rm', 'de');
  ({ revision: rev } = store.removeLanguage('proj-rm', 'de', rev, { backupDir }));

  assert.ok(!fs.existsSync(path.join(rootDir, 'proj-rm', TRANSLATIONS_DIR, 'de.json')));
  assert.ok(fs.readFileSync(path.join(backupDir, 'de.json')).equals(deBefore), 'backup is byte-faithful');
  assert.equal(store.loadDocumentProject('proj-rm').project.activeTranslationLanguage, undefined);
  assert.deepEqual(store.listLanguages('proj-rm').map((l) => l.language), ['fr']);

  assert.equal(errorCode(() => store.removeLanguage('proj-rm', 'de', rev)), 'NOT_FOUND');
});

// --- N1: removeLanguage existence/backup are POST-recovery preconditions ---

test('removeLanguage after a crashed translation commit backs up the RECOVERED bytes', () => {
  const id = 'proj-rm-recovered';
  createTxtProject(id);
  let rev = readProjectRevision(id);
  ({ revision: rev } = store.addLanguage(id, 'de', { provider: 'llama', sourceHash: META_HASH }, rev));

  // Genuine post-lease crash: a wholesale de.json commit takes the lease,
  // then dies before the rename — intent durable, NEWER content pending,
  // de.json still holding the OLD bytes.
  const newerDe = {
    schemaVersion: TRANSLATION_ARCHIVE_SCHEMA_VERSION,
    projectId: id,
    language: 'de',
    meta: { provider: 'llama', sourceHash: META_HASH },
    blocks: {
      b0: {
        blockId: 'b0',
        text: 'Hallo NEU.',
        sourceHash: blockSourceHash(importedBlocks[0]),
        status: 'approved',
        updatedAt: T0,
      },
    },
    createdAt: T0,
    updatedAt: T0,
  };
  const original = store._applyContentPlan.bind(store);
  store._applyContentPlan = (plan) => {
    if (!plan.unlink && path.basename(plan.filePath) === 'de.json') {
      throw new Error('simulated crash before translation commit');
    }
    return original(plan);
  };
  let threw = false;
  try {
    store.saveTranslationArchive(id, 'de', newerDe, rev);
  } catch (err) {
    threw = /simulated crash/.test(err.message);
  } finally {
    store._applyContentPlan = original;
  }
  assert.ok(threw, 'translation commit failed as injected');
  const intentPayload = JSON.parse(fs.readFileSync(intentPathFor(id), 'utf8'));
  const freshRev = readProjectRevision(id);
  assert.notEqual(freshRev, rev, 'the lease was taken');

  // removeLanguage evaluates AFTER recovery replays the crashed commit:
  // the backup must hold the RECOVERED archive — never the stale pre-crash
  // bytes — and the removal proceeds against the recovered state.
  const backupDir = path.join(rootDir, `${id}-backups`);
  const { revision: rmRev } = store.removeLanguage(id, 'de', freshRev, { backupDir });

  assert.equal(
    fs.readFileSync(path.join(backupDir, 'de.json'), 'utf8'),
    intentPayload.content,
    'backup contains the RECOVERED bytes exactly',
  );
  assert.ok(!fs.existsSync(path.join(rootDir, id, TRANSLATIONS_DIR, 'de.json')), 'language removed');
  assert.deepEqual(store.listLanguages(id).map((l) => l.language), []);
  assert.notEqual(rmRev, freshRev, 'the removal took its own lease');
});

test('a pending unlink intent is consumed before removeLanguage reports NOT_FOUND', () => {
  const id = 'proj-rm-pending-unlink';
  createTxtProject(id);
  let rev = readProjectRevision(id);
  ({ revision: rev } = store.addLanguage(id, 'fr', { provider: 'llama', sourceHash: META_HASH }, rev));
  const frPath = path.join(rootDir, id, TRANSLATIONS_DIR, 'fr.json');

  // Post-lease crash of a removeLanguage: the unlink intent is durable but
  // fr.json is still on disk (the writer died before its unlink).
  const original = store._applyContentPlan.bind(store);
  store._applyContentPlan = (plan) => {
    if (plan.unlink && plan.filePath === frPath) {
      throw new Error('simulated crash before unlink commit');
    }
    return original(plan);
  };
  let threw = false;
  try {
    store.removeLanguage(id, 'fr', rev);
  } catch (err) {
    threw = /simulated crash/.test(err.message);
  } finally {
    store._applyContentPlan = original;
  }
  assert.ok(threw, 'unlink failed as injected');
  assert.ok(fs.existsSync(intentPathFor(id)), 'unlink intent survived the crash');
  assert.ok(fs.existsSync(frPath), 'fr.json still present before recovery');
  const freshRev = readProjectRevision(id);

  // The existence verdict is POST-replay: recovery consumes the crashed
  // unlink first, so removeLanguage reports NOT_FOUND instead of removing
  // an already-removed language a second time.
  assert.equal(errorCode(() => store.removeLanguage(id, 'fr', freshRev)), 'NOT_FOUND');
  assert.ok(!fs.existsSync(intentPathFor(id)), 'crashed intent consumed by recovery');
  assert.ok(!fs.existsSync(frPath), 'replayed removal stands');
});

test('removeLanguage aborts atomically when the backup fails', () => {
  const id = 'proj-rm-backup-fail';
  createTxtProject(id);
  store.addLanguage(id, 'de', { provider: 'llama', sourceHash: META_HASH }, readProjectRevision(id));
  const rev = readProjectRevision(id);
  const deBefore = translationBytes(id, 'de');

  // A backup location that cannot be created (a FILE is in the way) aborts
  // the whole transaction BEFORE any intent, lease, or unlink.
  const blocker = path.join(rootDir, `${id}-backup-blocker`);
  fs.writeFileSync(blocker, 'not a directory');
  assert.throws(
    () => store.removeLanguage(id, 'de', rev, { backupDir: path.join(blocker, 'nested') }),
    /ENOTDIR|EEXIST/,
  );
  assert.ok(translationBytes(id, 'de').equals(deBefore), 'archive untouched');
  assert.equal(readProjectRevision(id), rev, 'no revision burned');
  assert.ok(!fs.existsSync(intentPathFor(id)), 'no intent written');
});

// --- Freshness -------------------------------------------------------------------

test('freshness: only the edited block flips stale; translations survive', () => {
  createTxtProject('proj-fresh');
  let rev = readProjectRevision('proj-fresh');
  ({ revision: rev } = store.addLanguage('proj-fresh', 'de', { provider: 'llama', sourceHash: META_HASH }, rev));
  ({ revision: rev } = store.saveTranslations('proj-fresh', 'de', [
    { blockId: 'b0', text: 'Hallo Welt.', status: 'approved' },
    { blockId: 'b1', text: 'Zweiter Absatz hier.' },
  ], rev));

  const before = store.freshness('proj-fresh', 'de');
  assert.deepEqual(
    [before.totalBlocks, before.translated, before.fresh, before.stale, before.missing, before.approved],
    [2, 2, 2, 0, 0, 1],
  );

  ({ revision: rev } = store.updateBlockText('proj-fresh', 'b0', 'Hello edited world.', rev));
  const after = store.freshness('proj-fresh', 'de');
  assert.deepEqual([after.fresh, after.stale, after.missing], [1, 1, 0], 'only the edited block goes stale');
  assert.equal(after.blocks.b0.freshness, 'stale');
  assert.equal(after.blocks.b0.status, 'approved', 'staleness does not clear approval');
  assert.equal(after.blocks.b1.freshness, 'fresh');

  // Invariant #4: a source edit marks stale but never deletes the translation.
  const de = store.getTranslationArchive('proj-fresh', 'de');
  assert.equal(de.blocks.b0.text, 'Hallo Welt.');

  // A brand-new language starts entirely missing.
  store.addLanguage('proj-fresh', 'es', { provider: 'anthropic', sourceHash: META_HASH }, rev);
  const es = store.freshness('proj-fresh', 'es');
  assert.deepEqual([es.translated, es.missing], [0, 2]);
});

test('approval keeps the original translation-time source hash', () => {
  createTxtProject('proj-approve');
  let rev = readProjectRevision('proj-approve');
  ({ revision: rev } = store.addLanguage('proj-approve', 'de', { provider: 'llama', sourceHash: META_HASH }, rev));
  ({ revision: rev } = store.saveTranslations('proj-approve', 'de', [{ blockId: 'b0', text: 'Hallo Welt.' }], rev));

  const stored = store.getTranslationArchive('proj-approve', 'de').blocks.b0;
  assert.equal(stored.sourceHash, blockSourceHash(importedBlocks[0]));

  ({ revision: rev } = store.saveTranslations('proj-approve', 'de', [{ blockId: 'b0', status: 'approved' }], rev));
  const approved = store.getTranslationArchive('proj-approve', 'de').blocks.b0;
  assert.equal(approved.status, 'approved');
  assert.equal(approved.text, 'Hallo Welt.', 'status-only updates keep text');
  assert.equal(approved.sourceHash, stored.sourceHash, 'status-only updates keep the hash');

  assert.equal(
    errorCode(() => store.saveTranslations('proj-approve', 'de', [{ blockId: 'ghost' }], rev)),
    'VALIDATION_FAILED',
  );
  assert.equal(
    errorCode(() => store.saveTranslations('proj-approve', 'de', [], rev)),
    'VALIDATION_FAILED',
  );
});

test('computeFreshness is a pure function over validated archives', () => {
  const archive = archiveFor('proj-pure', importedTxt);
  const translations = {
    schemaVersion: 1,
    projectId: 'proj-pure',
    language: 'de',
    meta: { provider: 'llama', sourceHash: META_HASH },
    blocks: {
      b0: { blockId: 'b0', text: 'Hallo', sourceHash: blockSourceHash(importedBlocks[0]), status: 'approved', updatedAt: T0 },
      b1: { blockId: 'b1', text: 'Veraltet', sourceHash: OTHER_HASH, status: 'needs-review', updatedAt: T0 },
    },
    createdAt: T0,
    updatedAt: T0,
  };
  const report = computeFreshness(archive, translations);
  assert.equal(report.language, 'de');
  assert.equal(report.fresh, 1);
  assert.equal(report.stale, 1);
  assert.equal(report.needsReview, 1);
  assert.equal(report.blocks.b1.freshness, 'stale');
});

// --- Corrupt / partial archive recovery ---------------------------------------------

test('corrupt document.json is detected and repairable through the revision path', () => {
  createTxtProject('proj-corrupt');
  const docPath = path.join(rootDir, 'proj-corrupt', DOCUMENT_FILE);

  fs.writeFileSync(docPath, 'not json {{{');
  assert.equal(errorCode(() => store.loadDocumentProject('proj-corrupt')), 'CORRUPT_DATA');

  fs.writeFileSync(docPath, '{"schemaVersion": 1, "blo'); // truncated write
  assert.equal(errorCode(() => store.loadDocumentArchive('proj-corrupt')), 'CORRUPT_DATA');

  // Recovery: wholesale save under the intact project revision.
  const rev = readProjectRevision('proj-corrupt');
  store.saveDocumentArchive('proj-corrupt', archiveFor('proj-corrupt', importedTxt), rev);
  assert.equal(store.loadDocumentArchive('proj-corrupt').blocks.length, 2);
});

test('corrupt translation archive is detected and repairable wholesale', () => {
  createTxtProject('proj-tcorrupt');
  let rev = readProjectRevision('proj-tcorrupt');
  ({ revision: rev } = store.addLanguage('proj-tcorrupt', 'de', { provider: 'llama', sourceHash: META_HASH }, rev));
  const dePath = path.join(rootDir, 'proj-tcorrupt', TRANSLATIONS_DIR, 'de.json');
  fs.writeFileSync(dePath, '{"schemaVersion": 1, "lang');

  assert.equal(errorCode(() => store.getTranslationArchive('proj-tcorrupt', 'de')), 'CORRUPT_DATA');
  assert.equal(errorCode(() => store.listLanguages('proj-tcorrupt')), 'CORRUPT_DATA');
  // The upsert path cannot merge into an unreadable file…
  assert.equal(
    errorCode(() => store.saveTranslations('proj-tcorrupt', 'de', [{ blockId: 'b0', text: 'x' }], rev)),
    'CORRUPT_DATA',
  );
  // …but the wholesale path repairs it (failed requests burned no revision).
  const repaired = store.saveTranslationArchive('proj-tcorrupt', 'de', {
    schemaVersion: 1,
    projectId: 'proj-tcorrupt',
    language: 'de',
    meta: { provider: 'llama', sourceHash: META_HASH },
    blocks: {},
    createdAt: T0,
    updatedAt: T0,
  }, rev);
  // Wholesale save is write-through (mirrors saveDocumentArchive): it also
  // restores a previously deleted variant without requiring existence.
  const restored = store.saveTranslationArchive('proj-tcorrupt', 'fr', {
    schemaVersion: 1, projectId: 'proj-tcorrupt', language: 'fr', meta: { provider: 'x', sourceHash: META_HASH },
    blocks: {}, createdAt: T0, updatedAt: T0,
  }, repaired.revision);
  assert.equal(restored.archive.language, 'fr');
  assert.deepEqual(store.listLanguages('proj-tcorrupt').map((l) => l.language), ['de', 'fr']);
});

test('corrupt project.json surfaces CORRUPT_DATA from the project store path', () => {
  createTxtProject('proj-pcorrupt');
  fs.writeFileSync(path.join(rootDir, 'proj-pcorrupt', 'project.json'), '{oops');
  assert.equal(errorCode(() => store.loadDocumentProject('proj-pcorrupt')), 'CORRUPT_DATA');
});

test('restart with a fresh store instance sees identical state', () => {
  createTxtProject('proj-restart');
  const before = store.loadDocumentProject('proj-restart');

  const restarted = new DocumentProjectStore({ baseDir: rootDir });
  const after = restarted.loadDocumentProject('proj-restart');
  assert.deepEqual(after, before);
  assert.deepEqual(restarted.listLanguages('proj-restart'), []);
});

// --- Bundle round-trip ------------------------------------------------------------------

test('bundle export/import round-trip preserves everything and verifies checksums', async () => {
  const id = 'proj-bundle';
  createTxtProject(id);
  let rev = readProjectRevision(id);
  ({ revision: rev } = store.updateBlockText(id, 'b0', 'Hello shipped world.', rev));
  ({ revision: rev } = store.setBlockPolicy(id, 'b1', { action: 'protect', note: 'fixed' }, rev));
  ({ revision: rev } = store.addLanguage(id, 'de', { provider: 'llama', model: 'm1', sourceHash: META_HASH }, rev));
  ({ revision: rev } = store.saveTranslations(id, 'de', [
    { blockId: 'b0', text: 'Hallo Welt.', status: 'approved' },
    { blockId: 'b1', text: 'Zweiter Absatz hier.' },
  ], rev));
  ({ revision: rev } = store.addLanguage(id, 'fr', { provider: 'gemini', sourceHash: META_HASH }, rev));
  store.setActiveLanguage(id, 'de', rev);

  const originalArchive = store.loadDocumentArchive(id);
  const originalDe = store.getTranslationArchive(id, 'de');

  const outPath = path.join(rootDir, `${id}.vsbundle`);
  const { manifest } = await exportProjectBundle(id, outPath, { store: store.projectStore });
  const entryPaths = manifest.entries.map((e) => e.path).sort();
  // Bundle entries are relative to the project directory (see bundle.js).
  assert.ok(entryPaths.includes('document.json'), 'manifest covers the document archive');
  assert.ok(entryPaths.includes('translations/de.json'), 'manifest covers language archives');
  assert.ok(entryPaths.includes('translations/fr.json'));

  const otherRoot = tmpRoot();
  try {
    const otherStore = new DocumentProjectStore({ baseDir: otherRoot });
    const imported = await importProjectBundle(outPath, { store: otherStore.projectStore });
    assert.equal(imported.projectId, id);

    const reopened = otherStore.loadDocumentProject(id);
    assert.deepEqual(reopened.archive, originalArchive, 'document archive survives the round trip');
    assert.deepEqual(otherStore.getTranslationArchive(id, 'de'), originalDe, 'translation archive survives');
    assert.equal(reopened.project.activeTranslationLanguage, 'de');
    assert.deepEqual(otherStore.freshness(id, 'de').blocks.b0, { freshness: 'fresh', status: 'approved' });
  } finally {
    fs.rmSync(otherRoot, { recursive: true, force: true });
  }

  // Tampered payload + genuine manifest -> checksum mismatch rejection.
  const dir = path.join(rootDir, id);
  const tamperedDocument = Buffer.from(
    fs.readFileSync(path.join(dir, DOCUMENT_FILE), 'utf8').replace('Hello shipped world.', 'TAMPERED TEXT'),
  );
  const entries = {
    'project.json': fs.readFileSync(path.join(dir, 'project.json')),
    'document.json': tamperedDocument,
    'translations/de.json': fs.readFileSync(path.join(dir, TRANSLATIONS_DIR, 'de.json')),
  };
  // Manifest checksums/sizes are computed over the REAL on-disk files, so the
  // tampered document.json entry must trip verification at import.
  const genuineManifest = {
    format: BUNDLE_FORMAT,
    schemaVersion: 3,
    algorithm: 'sha256',
    createdAt: new Date().toISOString(),
    projectId: id,
    entries: Object.entries(entries).map(([entryPath]) => {
      const real = entryPath.endsWith('document.json')
        ? fs.readFileSync(path.join(dir, DOCUMENT_FILE))
        : entries[entryPath];
      return { path: entryPath, size: real.length, checksum: sha256(real) };
    }),
  };
  const tamperedPath = path.join(rootDir, `${id}-tampered.vsbundle`);
  await makeArchivedZip(tamperedPath, {
    'manifest.json': JSON.stringify(genuineManifest),
    ...entries,
  });
  const tamperRoot = tmpRoot();
  try {
    await assert.rejects(
      () =>
        importProjectBundle(tamperedPath, {
          store: new DocumentProjectStore({ baseDir: tamperRoot }).projectStore,
        }),
      (err) => err instanceof AppError && err.code === 'INVALID_BUNDLE' && /Checksum mismatch/.test(err.message),
    );
  } finally {
    fs.rmSync(tamperRoot, { recursive: true, force: true });
  }
});

// --- Contract-level units ------------------------------------------------------------

test('normalizeBcp47 canonicalizes tags and rejects invalid ones', () => {
  assert.deepEqual(
    ['EN-us', 'de', 'DE', 'zh-hans-cn', 'sr-latn-rs', 'en-x-foo', 'pt-BR'].map(normalizeBcp47),
    ['en-US', 'de', 'de', 'zh-Hans-CN', 'sr-Latn-RS', 'en-x-foo', 'pt-BR'],
  );
  assert.deepEqual(
    ['', 'e', 'toolongtag9', 'bad_tag', 'en-', '-en', 'en..US', null, 42].map((t) => normalizeBcp47(t)),
    Array(9).fill(null),
  );
});

test('normalizeBcp47 is context-aware: extensions, private use, grandfathered, underscores', () => {
  // Extension keys AND their subtags are lowercase (finding: en-u-CA-Gregory).
  assert.deepEqual(
    ['en-u-ca-gregory', 'EN-U-CA-GREGORY', 'es-t-en-US'].map(normalizeBcp47),
    ['en-u-ca-gregory', 'en-u-ca-gregory', 'es-t-en-us'],
  );
  // Whole-tag private use normalizes; leading singleton `x` is accepted.
  assert.deepEqual(
    ['x-private', 'X-Private', 'x-klingon-tv'].map(normalizeBcp47),
    ['x-private', 'x-private', 'x-klingon-tv'],
  );
  // Grandfathered policy: irregular `i-*` forms rejected; legacy tags that
  // match the regular grammar pass through stably.
  assert.deepEqual(
    ['i-klingon', 'sgn-BE-FR', 'art-lojban'].map(normalizeBcp47),
    [null, 'sgn-BE-FR', 'art-lojban'],
  );
  // Numeric region/variant subtags keep digits; variants lowercase.
  assert.deepEqual(
    ['de-Latn-1996', 'sl-rozaj-biske'].map(normalizeBcp47),
    ['de-Latn-1996', 'sl-rozaj-biske'],
  );
  // Underscore aliases are never accepted — callers convert `_` to `-`.
  assert.equal(normalizeBcp47('en_US'), null);
});

test('archive validators enforce strict shapes', () => {
  const valid = archiveFor('proj-v', importedTxt);
  assert.equal(validateDocumentArchive(valid).ok, true);
  assert.equal(validateDocumentArchive({ ...valid, schemaVersion: 2 }).ok, false);
  assert.equal(validateDocumentArchive({ ...valid, editEpoch: -1 }).ok, false);
  assert.equal(validateDocumentArchive({ ...valid, editEpoch: 1.5 }).ok, false);
  assert.equal(
    validateDocumentArchive({ ...valid, blocks: [...valid.blocks, importedBlocks[0]] }).ok,
    false,
    'duplicate blockIds rejected',
  );
  assert.equal(
    validateDocumentArchive({ ...valid, blockPolicies: { b0: { action: 'explode' } } }).ok,
    false,
  );
  assert.equal(
    validateDocumentArchive({ ...valid, preflight: { ...valid.preflight, canImport: 'yes' } }).ok,
    false,
  );

  const tValid = {
    schemaVersion: 1,
    projectId: 'proj-v',
    language: 'de',
    meta: { provider: 'llama', sourceHash: META_HASH },
    blocks: { b0: { blockId: 'b0', text: 't', sourceHash: META_HASH, status: 'draft', updatedAt: T0 } },
    createdAt: T0,
    updatedAt: T0,
  };
  assert.equal(validateTranslationArchive(tValid).ok, true);
  assert.equal(validateTranslationArchive({ ...tValid, language: 'DE' }).ok, false, 'non-canonical tag rejected');
  assert.equal(
    validateTranslationArchive({ ...tValid, blocks: { b1: tValid.blocks.b0 } }).ok,
    false,
    'key/blockId mismatch rejected',
  );
  assert.equal(
    validateTranslationArchive({ ...tValid, blocks: { b0: { ...tValid.blocks.b0, status: 'nope' } } }).ok,
    false,
  );
  // meta.sourceHash has NO sentinel: it is required and must be canonical.
  assert.equal(validateTranslationArchive({ ...tValid, meta: { provider: 'llama' } }).ok, false);
  assert.equal(
    validateTranslationArchive({ ...tValid, meta: { provider: 'llama', sourceHash: 'deadbeef' } }).ok,
    false,
    'non-canonical provenance hash rejected',
  );
});

test('shared validator enforces exact span tiling on every block', () => {
  const valid = archiveFor('proj-tiling-v', importedTxt);
  const block = { ...valid.blocks[0] };
  const withBlock = (b) => ({ ...valid, blocks: [b, ...valid.blocks.slice(1)] });
  const text = block.text;

  // Gap: span stops short of the text end.
  assert.equal(
    validateDocumentArchive(withBlock({ ...block, spans: [{ ...block.spans[0], end: text.length - 1 }] })).ok,
    false,
    'short coverage rejected',
  );
  // Fractional offset.
  assert.equal(
    validateDocumentArchive(withBlock({ ...block, spans: [{ ...block.spans[0], end: 3.5 }] })).ok,
    false,
    'fractional offsets rejected',
  );
  // Empty span.
  assert.equal(
    validateDocumentArchive(
      withBlock({ ...block, spans: [{ ...block.spans[0], start: 0, end: 0, text: '' }] }),
    ).ok,
    false,
    'empty spans rejected',
  );
  // Foreign block ownership.
  assert.equal(
    validateDocumentArchive(withBlock({ ...block, spans: [{ ...block.spans[0], blockId: 'other' }] })).ok,
    false,
    'foreign span ownership rejected',
  );
  // Duplicate span ids.
  assert.equal(
    validateDocumentArchive(
      withBlock({
        ...block,
        spans: [
          { spanId: 'dup', blockId: block.blockId, text: text.slice(0, 2), start: 0, end: 2, traits: {} },
          { spanId: 'dup', blockId: block.blockId, text: text.slice(2), start: 2, end: text.length, traits: {} },
        ],
      }),
    ).ok,
    false,
    'duplicate spanIds rejected',
  );
  // Text-unfaithful span.
  assert.equal(
    validateDocumentArchive(withBlock({ ...block, spans: [{ ...block.spans[0], text: 'wrong' }] })).ok,
    false,
    'unfaithful span text rejected',
  );
  // Multi-span exact tiling passes; empty text requires zero spans.
  const tiled = [
    { spanId: 't0', blockId: block.blockId, text: text.slice(0, 5), start: 0, end: 5, traits: { bold: true } },
    { spanId: 't1', blockId: block.blockId, text: text.slice(5), start: 5, end: text.length, traits: {} },
  ];
  assert.equal(validateDocumentArchive(withBlock({ ...block, spans: tiled })).ok, true);
  assert.equal(
    validateDocumentArchive(withBlock({ ...block, text: '', spans: [] })).ok,
    true,
    'empty text is tiled by zero spans',
  );
  assert.equal(
    validateDocumentArchive(withBlock({ ...block, text: '', spans: tiled })).ok,
    false,
    'spans over empty text rejected',
  );
});

// --- Serialized transactions, intents, crash replay (findings 1, 10) -------------

test('per-project mutex serializes overlapping holders and preserves sync throws', async () => {
  const order = [];
  const first = runProjectExclusive('lock-a', async () => {
    order.push('a-start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('a-end');
    return 'a';
  });
  const second = runProjectExclusive('lock-a', () => {
    order.push('b');
    return 'b';
  });
  assert.equal(await first, 'a');
  assert.equal(await second, 'b');
  assert.deepEqual(order, ['a-start', 'a-end', 'b'], 'queued holder waits for the async owner');

  // Synchronous fast path: no microtask hop, synchronous throws preserved.
  assert.throws(() => runProjectExclusive('lock-b', () => { throw new Error('boom'); }), /boom/);
  assert.equal(runProjectExclusive('lock-b', () => 42), 42);
});

function injectContentFailure(store, message) {
  const original = store._applyContentPlan.bind(store);
  store._applyContentPlan = (plan) => {
    if (!plan.unlink && path.basename(plan.filePath) === DOCUMENT_FILE) {
      throw new Error(message);
    }
    return original(plan);
  };
  return () => {
    store._applyContentPlan = original;
  };
}

test('crash between lease and content commit replays durably from the intent', () => {
  createTxtProject('proj-crash');
  const rev = readProjectRevision('proj-crash');
  const docPath = path.join(rootDir, 'proj-crash', DOCUMENT_FILE);
  const intentPath = path.join(rootDir, `proj-crash${MUTATION_INTENT_SUFFIX}`);
  const beforeBytes = fs.readFileSync(docPath);

  const restore = injectContentFailure(store, 'simulated crash between lease and commit');
  let threw = false;
  try {
    store.updateBlockText('proj-crash', 'b0', 'Interrupted edit.', rev);
  } catch (err) {
    threw = /simulated crash/.test(err.message);
  } finally {
    restore();
  }
  assert.ok(threw, 'content commit failed as injected');

  // The lease advanced, the content is untouched, and the write-ahead intent
  // survived — durable evidence of the interrupted mutation.
  assert.notEqual(readProjectRevision('proj-crash'), rev, 'lease was taken');
  assert.ok(fs.readFileSync(docPath).equals(beforeBytes), 'content untouched before replay');
  assert.ok(fs.existsSync(intentPath), 'intent file survived the simulated crash');

  // The next observer (a plain reader here) replays the intent before
  // observing state: the interrupted edit lands, the intent clears.
  const reopened = store.loadDocumentProject('proj-crash');
  assert.equal(reopened.archive.blocks[0].text, 'Interrupted edit.');
  assert.ok(!fs.existsSync(intentPath), 'intent cleared after replay');
});

test('crash before the lease is taken discards the intent and burns no revision', () => {
  createTxtProject('proj-abort');
  const rev = readProjectRevision('proj-abort');
  const intentPath = path.join(rootDir, `proj-abort${MUTATION_INTENT_SUFFIX}`);
  const originalSave = store.projectStore.saveProject.bind(store.projectStore);
  store.projectStore.saveProject = () => {
    throw new Error('simulated crash before lease');
  };
  let threw = false;
  try {
    store.updateBlockText('proj-abort', 'b0', 'Never applied.', rev);
  } catch (err) {
    threw = /simulated crash/.test(err.message);
  } finally {
    store.projectStore.saveProject = originalSave;
  }
  assert.ok(threw, 'lease acquisition failed as injected');

  // Nothing happened: no durable intent may survive, the revision did not
  // move, and the SAME revision retries cleanly.
  assert.ok(!fs.existsSync(intentPath), 'intent discarded when the lease was never taken');
  assert.equal(readProjectRevision('proj-abort'), rev, 'revision not burned');
  store.updateBlockText('proj-abort', 'b0', 'Applied on retry.', rev);
  assert.equal(store.loadDocumentArchive('proj-abort').blocks[0].text, 'Applied on retry.');
});

test('a mutation interrupted mid-transaction is not lost to the next writer', () => {
  createTxtProject('proj-interleave');
  const rev1 = readProjectRevision('proj-interleave');

  // Writer A crashes between its lease and its commit...
  const restore = injectContentFailure(store, 'writer A crashed mid-transaction');
  try {
    store.updateBlockText('proj-interleave', 'b0', 'Writer A edit.', rev1);
    assert.fail('writer A should have failed');
  } catch {
    /* expected */
  } finally {
    restore();
  }

  // ...writer B then proceeds with the FRESH revision. Recovery must replay
  // A's leased intent BEFORE B's own rewrite, or B would clobber A forever.
  const rev2 = readProjectRevision('proj-interleave');
  store.setBlockPolicy('proj-interleave', 'b1', { action: 'protect' }, rev2);

  const archive = store.loadDocumentArchive('proj-interleave');
  assert.equal(archive.blocks[0].text, 'Writer A edit.', "writer A's mutation was not dropped");
  assert.deepEqual(archive.blockPolicies.b1, { action: 'protect' }, "writer B's mutation applied");
  assert.equal(archive.editBaselines.b0.text, importedBlocks[0].text, 'baseline intact');
});

test('fresh-revision addLanguage retry conflicts with the recovered archive instead of overwriting it', () => {
  const id = 'proj-addlang-retry';
  createTxtProject(id);
  const rev = readProjectRevision(id);

  // Genuine crash: a wholesale translations commit takes the lease, then
  // dies before the de.json rename — intent durable, translation file
  // absent on disk.
  const fullDeArchive = {
    schemaVersion: TRANSLATION_ARCHIVE_SCHEMA_VERSION,
    projectId: id,
    language: 'de',
    meta: { provider: 'llama', sourceHash: META_HASH },
    blocks: {
      b0: {
        blockId: 'b0',
        text: 'Hallo Welt.',
        sourceHash: blockSourceHash(importedBlocks[0]),
        status: 'approved',
        updatedAt: T0,
      },
      b1: {
        blockId: 'b1',
        text: 'Zweiter Absatz.',
        sourceHash: blockSourceHash(importedBlocks[1]),
        status: 'draft',
        updatedAt: T0,
      },
    },
    createdAt: T0,
    updatedAt: T0,
  };
  const original = store._applyContentPlan.bind(store);
  store._applyContentPlan = (plan) => {
    if (!plan.unlink && path.basename(plan.filePath) === 'de.json') {
      throw new Error('simulated crash before translation commit');
    }

    return original(plan);
  };
  let threw = false;
  try {
    store.saveTranslationArchive(id, 'de', fullDeArchive, rev);
  } catch (err) {
    threw = /simulated crash/.test(err.message);
  } finally {
    store._applyContentPlan = original;
  }
  assert.ok(threw, 'translations commit failed as injected');

  const dePath = path.join(rootDir, id, TRANSLATIONS_DIR, 'de.json');
  const intentPath = path.join(rootDir, `${id}${MUTATION_INTENT_SUFFIX}`);
  assert.ok(!fs.existsSync(dePath), 'content commit never landed');
  assert.ok(fs.existsSync(intentPath), 'intent survived the crash');
  const freshRev = readProjectRevision(id);
  assert.notEqual(freshRev, rev, 'the lease was taken');
  const intentPayload = JSON.parse(fs.readFileSync(intentPath, 'utf8'));

  // Fresh-revision retry via addLanguage: the target-absence check is a
  // TRANSACTION precondition, evaluated AFTER recovery replays the crashed
  // archive — so the retry must CONFLICT, never skeleton-overwrite it.
  assert.equal(
    errorCode(() =>
      store.addLanguage(id, 'de', { provider: 'llama', sourceHash: META_HASH }, freshRev),
    ),
    'CONFLICT',
  );

  // The replayed archive is preserved byte-wise; the conflicted retry burned
  // no revision (it failed before its own lease).
  assert.ok(!fs.existsSync(intentPath), 'recovery consumed the intent');
  assert.equal(fs.readFileSync(dePath, 'utf8'), intentPayload.content, 'replayed bytes intact');
  const recovered = store.getTranslationArchive(id, 'de');
  assert.equal(recovered.blocks.b0.text, 'Hallo Welt.');
  assert.equal(recovered.blocks.b0.status, 'approved');
  assert.equal(readProjectRevision(id), freshRev, 'no revision burned by the conflicted retry');
});

test('crash between the creation commits completes the pair on the next access', () => {
  const id = 'proj-create-crash';
  // Crash at the promotion boundary: both files are staged OUTSIDE the
  // store, the intent is durably 'leased', and no project directory exists
  // at the final path yet.
  const original = store._promoteStagedCreation.bind(store);
  store._promoteStagedCreation = () => {
    throw new Error('simulated crash between creation commits');
  };
  let threw = false;
  try {
    store.createDocumentProject(documentProject(id), archiveFor(id, importedTxt));
  } catch (err) {
    threw = /simulated crash/.test(err.message);
  } finally {
    store._promoteStagedCreation = original;
  }
  assert.ok(threw, 'promotion failed as injected');

  // Crash state: staged pair complete, leased intent durable, and the
  // store itself untouched — exactly what roll-forward exists for.
  const docPath = path.join(rootDir, id, DOCUMENT_FILE);
  const intentPath = intentPathFor(id);
  const stagingDir = stagingPathFor(id);
  assert.ok(fs.existsSync(path.join(stagingDir, id, 'project.json')), 'staged lease was taken');
  assert.ok(fs.existsSync(path.join(stagingDir, id, DOCUMENT_FILE)), 'staged archive exists');
  assert.ok(!fs.existsSync(path.join(rootDir, id)), 'final project directory absent before recovery');
  const intent = JSON.parse(fs.readFileSync(intentPath, 'utf8'));
  assert.equal(intent.action, 'create');
  assert.equal(intent.phase, 'leased');
  assert.match(
    String(intent.projectSha256),
    /^[0-9a-f]{64}$/,
    'the leased intent carries the durable creation identity',
  );

  // The very next access rolls the promotion forward: identical bytes land,
  // staging area and intent clear, reopen is stable.
  const reopened = store.loadDocumentProject(id);
  assert.equal(fs.readFileSync(docPath, 'utf8'), intent.content, 'replayed byte-wise');
  assert.deepEqual(reopened.archive, JSON.parse(intent.content));
  assert.ok(!fs.existsSync(stagingDir), 'staging area removed after promotion');
  assert.ok(!fs.existsSync(intentPath), 'intent cleared after completion');
  assert.deepEqual(store.listLanguages(id), []);
  const restarted = new DocumentProjectStore({ baseDir: rootDir });
  assert.equal(restarted.loadDocumentArchive(id).title, 'Hello world.');
});

test('crash before the creation lease discards the intent and leaves no residue', () => {
  const id = 'proj-create-abort';
  const intentPath = intentPathFor(id);
  const stagingDir = stagingPathFor(id);
  const original = store._stagingProjectStore.bind(store);
  store._stagingProjectStore = () => ({
    saveProject() {
      throw new Error('simulated crash before creation lease');
    },
  });
  let threw = false;
  try {
    store.createDocumentProject(documentProject(id), archiveFor(id, importedTxt));
  } catch (err) {
    threw = /simulated crash/.test(err.message);
  } finally {
    store._stagingProjectStore = original;
  }
  assert.ok(threw, 'lease acquisition failed as injected');

  // Nothing happened: no intent survives, no staging area, no project
  // directory, and a retry with the same id succeeds cleanly.
  assert.ok(!fs.existsSync(intentPath), 'intent discarded when the lease was never taken');
  assert.ok(!fs.existsSync(stagingDir), 'no staging residue');
  assert.ok(!fs.existsSync(path.join(rootDir, id)), 'no project directory residue');
  createTxtProject(id);
  assert.equal(store.loadDocumentProject(id).archive.title, 'Hello world.');
});
test('project.json without its archive and without an intent fails loudly', () => {
  // Defined behavior for tampered state outside the journal: no intent
  // means nothing to replay — reopen must fail loudly, never fabricate an
  // empty archive for a type=document project.
  const id = 'proj-orphan';
  createTxtProject(id);
  fs.rmSync(path.join(rootDir, id, DOCUMENT_FILE));
  assert.equal(errorCode(() => store.loadDocumentProject(id)), 'CORRUPT_DATA');
});

// --- N2/N3: phased creation intents, staged residue, duplicate safety --------

test('a prepared create intent over an existing document project is discarded without touching it', () => {
  const id = 'proj-create-dup-doc';
  createTxtProject(id);
  const docPath = path.join(rootDir, id, DOCUMENT_FILE);
  const docBefore = fs.readFileSync(docPath);
  const revBefore = readProjectRevision(id);
  const intentPath = intentPathFor(id);
  const stagingDir = stagingPathFor(id);

  // Durable state of a duplicate create that hard-crashed after journaling
  // its prepared intent and staging some bytes: real FS, foreign payload.
  fs.mkdirSync(path.join(stagingDir, id), { recursive: true });
  fs.writeFileSync(path.join(stagingDir, id, DOCUMENT_FILE), '{"new":true}');
  writeCreateIntentFile(id, { phase: 'prepared', content: '{"new":true}' });

  // Recovery discards the intent and its residue; the existing project is
  // intact BYTE-WISE and its revision never moved.
  store.loadDocumentProject(id);
  assert.ok(fs.readFileSync(docPath).equals(docBefore), 'existing document.json unchanged byte-wise');
  assert.equal(readProjectRevision(id), revBefore, 'existing project revision untouched');
  assert.ok(!fs.existsSync(intentPath), 'prepared intent discarded');
  assert.ok(!fs.existsSync(stagingDir), 'staged residue discarded');

  // The duplicate create itself is refused BEFORE any intent is written.
  assert.equal(errorCode(() => createTxtProject(id)), 'CONFLICT');
  assert.ok(!fs.existsSync(intentPath), 'duplicate create wrote no intent');
});

test('a prepared create intent over a media project never materializes a document archive', () => {
  const id = 'proj-create-dup-media';
  store.projectStore.saveProject(
    {
      ...documentProject(id, { type: 'media' }),
      mediaState: {
        sourceFileName: 'a.wav',
        durationSec: 5,
        sourceLang: 'en',
        targetLang: 'de',
        transcriptionProvider: 'whisper',
        translationProvider: 'llama',
        outputFormats: ['SRT'],
        chunks: [],
      },
    },
    undefined,
  );
  const intentPath = intentPathFor(id);
  const stagingDir = stagingPathFor(id);

  // Same crashed-duplicate state, but over a MEDIA project: staged
  // document.json residue plus a prepared intent.
  fs.mkdirSync(path.join(stagingDir, id), { recursive: true });
  fs.writeFileSync(path.join(stagingDir, id, DOCUMENT_FILE), '{"new":true}');
  writeCreateIntentFile(id, { phase: 'prepared', content: '{"new":true}' });

  // listLanguages triggers recovery for a non-document project: the media
  // project must survive with NO document.json ever appearing.
  assert.deepEqual(store.listLanguages(id), []);
  assert.ok(!fs.existsSync(path.join(rootDir, id, DOCUMENT_FILE)), 'no document.json ever appeared');
  assert.ok(fs.existsSync(path.join(rootDir, id, 'project.json')), 'media project untouched');
  assert.ok(!fs.existsSync(intentPath), 'prepared intent discarded');
  assert.ok(!fs.existsSync(stagingDir), 'staged residue discarded');
  assert.equal(errorCode(() => createTxtProject(id)), 'CONFLICT');
});

test('a leased create intent whose promotion already happened clears idempotently', () => {
  const id = 'proj-create-promoted';
  createTxtProject(id);
  const docPath = path.join(rootDir, id, DOCUMENT_FILE);
  const docBefore = fs.readFileSync(docPath);

  // Crash window between promotion and intent clear: a leased intent plus
  // an empty staging root over the fully promoted project. The journaled
  // payload IS the promoted bytes — that identity is what makes this
  // provably OUR post-promotion state under the ownership check.
  fs.mkdirSync(stagingPathFor(id), { recursive: true });
  writeCreateIntentFile(id, {
    phase: 'leased',
    content: fs.readFileSync(docPath, 'utf8'),
    // v3: the identity of the REAL promoted project.json — exactly what
    // makes recovery accept this state as our own completed promotion.
    projectSha256: sha256File(path.join(rootDir, id, 'project.json')),
  });

  store.loadDocumentProject(id); // recovery: cleanup only
  assert.ok(fs.readFileSync(docPath).equals(docBefore), 'promoted project untouched');
  assert.ok(!fs.existsSync(intentPathFor(id)), 'intent cleared');
  assert.ok(!fs.existsSync(stagingPathFor(id)), 'staging root removed');
});

test('a phase-less legacy create intent is malformed, never guessed', () => {
  const id = 'proj-create-legacy';
  createTxtProject(id);
  const docPath = path.join(rootDir, id, DOCUMENT_FILE);
  const docBefore = fs.readFileSync(docPath);

  // The pre-Fix3 ambiguity itself: action 'create' without a durable phase.
  // The old recovery treated ANY existing project.json as a lease; now this
  // is loud CORRUPT_DATA with nothing touched or consumed.
  writeCreateIntentFile(id, { phase: 'prepared', content: '{"tampered":true}' });
  const raw = JSON.parse(fs.readFileSync(intentPathFor(id), 'utf8'));
  delete raw.phase;
  fs.writeFileSync(intentPathFor(id), JSON.stringify(raw, null, 2));

  assert.equal(errorCode(() => store.loadDocumentProject(id)), 'CORRUPT_DATA');
  assert.ok(fs.readFileSync(docPath).equals(docBefore), 'archive untouched by ambiguous intent');
  assert.ok(fs.existsSync(intentPathFor(id)), 'malformed intent preserved for diagnosis');
});

test('a failure with real staged residue discards every creation-owned byte', () => {
  const id = 'proj-create-staged-abort';
  const intentPath = intentPathFor(id);
  const stagingDir = stagingPathFor(id);

  // Fail exactly at the durable 'prepared' -> 'leased' flip: by then the
  // staging area holds the REAL staged project.json + document.json bytes.
  let sawStagedResidue = false;
  const originalWrite = store._writeJsonAtomic.bind(store);
  store._writeJsonAtomic = (filePath, value) => {
    if (value && value.phase === 'leased') {
      sawStagedResidue = fs.existsSync(path.join(stagingDir, id, DOCUMENT_FILE));
      throw new Error('simulated crash at the lease phase flip');
    }
    return originalWrite(filePath, value);
  };
  let threw = false;
  try {
    store.createDocumentProject(documentProject(id), archiveFor(id, importedTxt));
  } catch (err) {
    threw = /simulated crash/.test(err.message);
  } finally {
    store._writeJsonAtomic = originalWrite;
  }
  assert.ok(threw, 'phase flip failed as injected');
  assert.ok(sawStagedResidue, 'precondition: real staged archive existed at failure time');

  // The abort removed ALL creation-owned residue — the staging tree and the
  // intent — and the final project directory was never created.
  assert.ok(!fs.existsSync(stagingDir), 'staging residue fully removed');
  assert.ok(!fs.existsSync(intentPath), 'prepared intent discarded');
  assert.ok(!fs.existsSync(path.join(rootDir, id)), 'final project directory never created');

  // Same-id retry succeeds cleanly.
  createTxtProject(id);
  assert.equal(store.loadDocumentProject(id).archive.title, 'Hello world.');
});

test('a hard-crashed prepared creation leaves zero residue after recovery and retries cleanly', () => {
  const id = 'proj-create-hardcrash';
  const intentPath = intentPathFor(id);
  const stagingDir = stagingPathFor(id);

  // Durable crash state exactly as a hard kill mid-staging would leave it:
  // a prepared intent plus a HALF-WRITTEN staging area (temp file AND a
  // staged project.json), with no final project directory anywhere.
  fs.mkdirSync(path.join(stagingDir, id), { recursive: true });
  fs.writeFileSync(path.join(stagingDir, id, 'project.json.pid4711.tmp'), '{"partial":');
  fs.writeFileSync(
    path.join(stagingDir, id, 'project.json'),
    JSON.stringify(documentProject(id), null, 2),
  );
  writeCreateIntentFile(id, {
    phase: 'prepared',
    content: JSON.stringify(archiveFor(id, importedTxt), null, 2),
  });

  // Any next access runs recovery first: the prepared intent is discarded
  // with ALL of its residue; nothing is promoted into the store.
  assert.equal(errorCode(() => store.loadDocumentProject(id)), 'NOT_FOUND');
  assert.ok(!fs.existsSync(stagingDir), 'staging residue (incl. temp file) fully removed');
  assert.ok(!fs.existsSync(intentPath), 'prepared intent discarded');
  assert.ok(!fs.existsSync(path.join(rootDir, id)), 'final project directory still absent');

  // Same-id retry succeeds cleanly.
  createTxtProject(id);
  assert.equal(store.loadDocumentProject(id).archive.title, 'Hello world.');
});

// --- Reviewer4 adversarial recovery hardening: A1 staged-path confinement,
// A2 residue/intent ordering, A3 foreign-collision ownership ---------------

test('recovery refuses a symlinked staging root instead of promoting through it', () => {
  const id = 'proj-a1-root-link';
  const external = externalTmp();
  const externalProject = path.join(external, id);
  fs.mkdirSync(externalProject);
  fs.writeFileSync(path.join(externalProject, 'project.json'), '{"external":"project"}');
  fs.writeFileSync(path.join(externalProject, DOCUMENT_FILE), '{"external":"archive"}');

  // The reviewer repro, verbatim: a durably LEASED intent whose staging
  // root is a symlink to a complete staged pair OUTSIDE the store.
  fs.symlinkSync(external, stagingPathFor(id), 'dir');
  // Identity placeholder: the confinement gate refuses before ownership is
  // ever consulted.
  writeCreateIntentFile(id, { phase: 'leased', content: '{"external":"archive"}', projectSha256: META_HASH });
  const intentBefore = fs.readFileSync(intentPathFor(id));

  const err = thrownError(() => store.loadDocumentProject(id));
  assert.equal(err && err.code, 'CORRUPT_DATA');
  assert.match(err.message, /symbolic link/);

  // The escape was never followed: the external pair still sits outside,
  // nothing was renamed into the store, and the intent survives untouched.
  assert.ok(
    fs.existsSync(path.join(externalProject, DOCUMENT_FILE)),
    'external staged bytes still at their external path',
  );
  assert.ok(!fs.existsSync(path.join(rootDir, id)), 'nothing promoted into the store');
  assert.ok(
    fs.lstatSync(stagingPathFor(id)).isSymbolicLink(),
    'link itself left for human resolution',
  );
  assert.ok(fs.existsSync(intentPathFor(id)), 'intent retained');
  assert.ok(fs.readFileSync(intentPathFor(id)).equals(intentBefore), 'intent byte-identical');
});

test('recovery refuses a symlinked staged project directory inside a genuine staging tree', () => {
  const id = 'proj-a1-child-link';
  const external = externalTmp();
  const externalProject = path.join(external, id);
  fs.mkdirSync(externalProject);
  fs.writeFileSync(path.join(externalProject, 'project.json'), '{"external":"project"}');
  fs.writeFileSync(path.join(externalProject, DOCUMENT_FILE), '{"external":"archive"}');

  // Genuine staging root, but the staged PROJECT directory inside it is a
  // planted symlink — promotion would move the EXTERNAL directory.
  fs.mkdirSync(stagingPathFor(id));
  fs.symlinkSync(externalProject, path.join(stagingPathFor(id), id), 'dir');
  writeCreateIntentFile(id, { phase: 'leased', content: '{"external":"archive"}', projectSha256: META_HASH });

  const err = thrownError(() => store.loadDocumentProject(id));
  assert.equal(err && err.code, 'CORRUPT_DATA');
  assert.match(err.message, /symbolic link/);
  assert.ok(fs.existsSync(path.join(externalProject, 'project.json')), 'external project unmoved');
  assert.ok(
    !fs.existsSync(path.join(rootDir, id)),
    'external directory never renamed into the store',
  );
  assert.ok(fs.existsSync(intentPathFor(id)), 'intent retained');
});

test('prepared recovery refuses a symlinked staging root without deleting through it', () => {
  const id = 'proj-a1-prepared-link';
  const external = externalTmp();
  fs.writeFileSync(path.join(external, 'keep.txt'), 'outside');

  // Even the DELETE path is gated: a symlinked staging root is rejected as
  // CORRUPT_DATA instead of removing anything along or behind the link.
  fs.symlinkSync(external, stagingPathFor(id), 'dir');
  writeCreateIntentFile(id, { phase: 'prepared', content: '{}' });

  const err = thrownError(() => store.loadDocumentProject(id));
  assert.equal(err && err.code, 'CORRUPT_DATA');
  assert.match(err.message, /symbolic link/);
  assert.ok(fs.existsSync(path.join(external, 'keep.txt')), 'external directory untouched');
  assert.ok(fs.lstatSync(stagingPathFor(id)).isSymbolicLink(), 'link left in place');
  assert.ok(fs.existsSync(intentPathFor(id)), 'prepared intent retained for human resolution');
});

test('recovery refuses to promote a staged archive that is a symbolic link', () => {
  const id = 'proj-a1-doc-link';
  const external = externalTmp();
  const externalFile = path.join(external, 'document.json');
  fs.writeFileSync(externalFile, '{"external":"archive"}');

  fs.mkdirSync(path.join(stagingPathFor(id), id), { recursive: true });
  fs.writeFileSync(
    path.join(stagingPathFor(id), id, 'project.json'),
    JSON.stringify(documentProject(id), null, 2),
  );
  fs.symlinkSync(externalFile, path.join(stagingPathFor(id), id, DOCUMENT_FILE), 'file');
  writeCreateIntentFile(id, { phase: 'leased', content: '{"external":"archive"}', projectSha256: META_HASH });

  const err = thrownError(() => store.loadDocumentProject(id));
  assert.equal(err && err.code, 'CORRUPT_DATA');
  assert.match(err.message, /symbolic link/);
  assert.equal(fs.readFileSync(externalFile, 'utf8'), '{"external":"archive"}', 'external file untouched');
  assert.ok(!fs.existsSync(path.join(rootDir, id)), 'staged tree never promoted');
  assert.ok(fs.existsSync(intentPathFor(id)), 'intent retained');
});

test('a failed residue cleanup retains the intent and heals on the next recovery', () => {
  const id = 'proj-a2-chmod';
  const intentPath = intentPathFor(id);
  const stagingDir = stagingPathFor(id);

  // Durable prepared-crash state with real staged bytes...
  fs.mkdirSync(path.join(stagingDir, id), { recursive: true });
  fs.writeFileSync(path.join(stagingDir, id, DOCUMENT_FILE), '{"partial":true}');
  writeCreateIntentFile(id, { phase: 'prepared', content: '{"partial":true}' });

  // ...whose staging root resists removal (chmod probe, EPERM family).
  fs.chmodSync(stagingDir, 0o500);
  try {
    const err = thrownError(() => store.loadDocumentProject(id));
    assert.equal(err && err.code, 'CORRUPT_DATA');
    assert.match(err.message, /retained/);
    // THE ordering contract: residue AND intent survive TOGETHER — a
    // partial cleanup may never orphan residue behind a cleared intent.
    assert.ok(fs.existsSync(stagingDir), 'staging residue still present');
    assert.ok(fs.existsSync(intentPath), 'intent retained alongside the residue');
  } finally {
    fs.chmodSync(stagingDir, 0o700);
  }

  // The very next recovery finishes the discard, and the same-id retry
  // path is fully functional again.
  assert.equal(errorCode(() => store.loadDocumentProject(id)), 'NOT_FOUND');
  assert.ok(!fs.existsSync(stagingDir), 'residue removed by the retried cleanup');
  assert.ok(!fs.existsSync(intentPath), 'intent cleared only once the residue was gone');
  createTxtProject(id);
  assert.equal(store.loadDocumentProject(id).archive.title, 'Hello world.');
});

test('leased recovery detects a foreign document project instead of dropping the creation', () => {
  const id = 'proj-a3-foreign-doc';
  // FOREIGN document project at the final path (restored backup, id
  // collision, another tool): real bytes that are provably not ours.
  store.projectStore.saveProject(
    documentProject(id, { metadata: { name: 'Foreign Doc', sourceFileName: 'foreign.txt' } }),
    undefined,
  );
  const finalDocPath = path.join(rootDir, id, DOCUMENT_FILE);
  fs.writeFileSync(finalDocPath, '{"foreign":true}');
  const foreignProjectBytes = fs.readFileSync(path.join(rootDir, id, 'project.json'));

  // Complete leased staged pair for OUR creation alongside it.
  const content = JSON.stringify(archiveFor(id, importedTxt), null, 2);
  stageCompletePair(id, content);
  writeCreateIntentFile(id, {
    phase: 'leased',
    content,
    projectSha256: sha256File(path.join(stagingPathFor(id), id, 'project.json')),
  });

  const err = thrownError(() => store.loadDocumentProject(id));
  assert.equal(err && err.code, 'CONFLICT');
  assert.match(err.message, /foreign/);
  // EVERYTHING preserved: the foreign project byte-wise, the staged pair,
  // and the intent.
  assert.ok(
    fs.readFileSync(path.join(rootDir, id, 'project.json')).equals(foreignProjectBytes),
    'foreign project untouched',
  );
  assert.equal(fs.readFileSync(finalDocPath, 'utf8'), '{"foreign":true}', 'foreign archive untouched');
  assert.equal(
    fs.readFileSync(path.join(stagingPathFor(id), id, DOCUMENT_FILE), 'utf8'),
    content,
    'staged archive preserved',
  );
  assert.ok(fs.existsSync(path.join(stagingPathFor(id), id, 'project.json')), 'staged lease preserved');
  assert.ok(fs.existsSync(intentPathFor(id)), 'intent preserved');

  // Once the human removes the foreign occupant, the very next access
  // rolls OUR creation forward — nothing was lost by the conflict.
  fs.rmSync(path.join(rootDir, id), { recursive: true, force: true });
  const reopened = store.loadDocumentProject(id);
  assert.equal(reopened.archive.title, 'Hello world.');
  assert.equal(fs.readFileSync(finalDocPath, 'utf8'), content, 'creation landed byte-wise');
  assert.ok(!fs.existsSync(stagingPathFor(id)));
  assert.ok(!fs.existsSync(intentPathFor(id)));
});

test('leased recovery detects a foreign media project instead of dropping the creation', () => {
  const id = 'proj-a3-foreign-media';
  store.projectStore.saveProject(
    {
      ...documentProject(id, { type: 'media' }),
      mediaState: {
        sourceFileName: 'a.wav',
        durationSec: 5,
        sourceLang: 'en',
        targetLang: 'de',
        transcriptionProvider: 'whisper',
        translationProvider: 'llama',
        outputFormats: ['SRT'],
        chunks: [],
      },
    },
    undefined,
  );
  const foreignProjectBytes = fs.readFileSync(path.join(rootDir, id, 'project.json'));

  const content = JSON.stringify(archiveFor(id, importedTxt), null, 2);
  stageCompletePair(id, content);
  writeCreateIntentFile(id, {
    phase: 'leased',
    content,
    projectSha256: sha256File(path.join(stagingPathFor(id), id, 'project.json')),
  });

  // Any recovery-triggering access surfaces the collision loudly.
  const err = thrownError(() => store.listLanguages(id));
  assert.equal(err && err.code, 'CONFLICT');
  assert.match(err.message, /foreign/);
  // The media project is untouched, NO document.json ever appears at its
  // path, and the staged pair + intent remain for manual resolution.
  assert.ok(
    fs.readFileSync(path.join(rootDir, id, 'project.json')).equals(foreignProjectBytes),
    'media project untouched',
  );
  assert.ok(!fs.existsSync(path.join(rootDir, id, DOCUMENT_FILE)), 'no document.json materialized');
  assert.ok(fs.existsSync(path.join(stagingPathFor(id), id, 'project.json')), 'staged lease preserved');
  assert.ok(fs.existsSync(intentPathFor(id)), 'intent preserved');
});

// --- Reviewer5 adversarial round: B1 live-path confinement, B2 guarded
// final-path observation, B3 durable creation identity ownership ---------

test('live create refuses a dangling staging-root symlink without following it', () => {
  const id = 'proj-b1-dangling-staging';
  const danglingTarget = path.join(externalTmp(), 'never-materializes');
  fs.symlinkSync(danglingTarget, stagingPathFor(id), 'dir');

  // The old existsSync preflight followed links and returned false here,
  // missing the dangling link entirely. The lstat preflight collides
  // typed, before any intent exists and without staging through the link.
  const err = thrownError(() => createTxtProject(id));
  assert.equal(err && err.code, 'CONFLICT');
  assert.match(err.message, /staging path .* already exists/);
  assert.ok(!fs.existsSync(danglingTarget), 'dangling target never materialized');
  assert.ok(fs.lstatSync(stagingPathFor(id)).isSymbolicLink(), 'link left for human resolution');
  assert.ok(!fs.existsSync(intentPathFor(id)), 'no intent was journaled through the link');

  // Removing the planted link restores the normal create path.
  fs.unlinkSync(stagingPathFor(id));
  createTxtProject(id);
  assert.equal(store.loadDocumentProject(id).archive.title, 'Hello world.');
});

test('_promoteStagedCreation validates its staged SOURCE against planted links', () => {
  const id = 'proj-b1-source-link';
  const external = externalTmp();
  fs.writeFileSync(path.join(external, 'keep.txt'), 'outside');
  stageCompletePair(id, JSON.stringify(archiveFor(id, importedTxt), null, 2));

  // Planted swap just before promotion: OUR staged project directory is
  // replaced by a link to an external directory. Promotion must refuse to
  // move anything but our own real staged directory.
  const stagedDir = path.join(stagingPathFor(id), id);
  fs.rmSync(stagedDir, { recursive: true });
  fs.symlinkSync(external, stagedDir, 'dir');
  const finalDir = path.join(rootDir, id);

  const err = thrownError(() => store._promoteStagedCreation(stagedDir, finalDir));
  assert.equal(err && err.code, 'CORRUPT_DATA');
  assert.match(err.message, /symbolic link/);
  assert.ok(fs.existsSync(path.join(external, 'keep.txt')), 'external target unmoved');
  assert.ok(!fs.existsSync(finalDir), 'nothing was renamed into the store');

  // A MISSING staged source refuses loudly too — never an empty promote.
  fs.rmSync(stagedDir, { recursive: true, force: true });
  const missing = thrownError(() => store._promoteStagedCreation(stagedDir, finalDir));
  assert.equal(missing && missing.code, 'CORRUPT_DATA');
  assert.match(missing.message, /missing/);
});

test('live create re-gates the staged identity read against a mid-flight planted link', () => {
  const id = 'proj-b1-identity-read-link';
  const external = externalTmp();
  const externalProject = path.join(external, id);
  const foreignBytes = '{"planted":"escape"}';
  fs.mkdirSync(externalProject);
  fs.writeFileSync(path.join(externalProject, 'project.json'), foreignBytes);
  const stagedDir = path.join(stagingPathFor(id), id);

  // Plant the swap INSIDE the live window: _applyContentPlan runs strictly
  // AFTER the pre-write gate has verified both prefixes and strictly BEFORE
  // the identity readFileSync, so only a gate re-run immediately before
  // that read can catch this link — every earlier one already passed.
  const originalApply = store._applyContentPlan.bind(store);
  store._applyContentPlan = (plan) => {
    originalApply(plan);
    if (plan.filePath === path.join(stagedDir, DOCUMENT_FILE)) {
      // Replace OUR staged project directory with a link to an escape
      // carrying its own project.json: an un-gated identity read would
      // silently digest FOREIGN bytes and lease them as creation identity.
      fs.rmSync(stagedDir, { recursive: true });
      fs.symlinkSync(externalProject, stagedDir, 'dir');
    }
  };

  let err;
  try {
    err = thrownError(() => createTxtProject(id));
  } finally {
    store._applyContentPlan = originalApply;
  }
  assert.ok(err, 'the planted identity read must fail loudly');
  assert.equal(err && err.code, 'CORRUPT_DATA');
  assert.match(err.message, /symbolic link/);

  // Nothing was followed or leased through the link: the failure happened
  // before the lease, so no intent survives, the staging tree — link
  // included — is fully discarded, and the escape bytes were never opened.
  assert.ok(!fs.existsSync(intentPathFor(id)), 'no intent journaled through the link');
  assert.ok(!fs.existsSync(stagingPathFor(id)), 'staging residue fully discarded');
  assert.equal(
    fs.readFileSync(path.join(externalProject, 'project.json'), 'utf8'),
    foreignBytes,
    'escape target never read or modified',
  );
  assert.ok(!fs.existsSync(path.join(rootDir, id)), 'nothing promoted into the store');

  // The same id creates normally once the attack window is closed.
  createTxtProject(id);
  assert.equal(store.loadDocumentProject(id).archive.title, 'Hello world.');
});

test('leased recovery refuses a symlinked final project even when its bytes fully match', () => {
  const id = 'proj-b2-final-link';
  const content = JSON.stringify(archiveFor(id, importedTxt), null, 2);

  // No staged dir remains: the decision must come from the FINAL path
  // alone. The escape carries a byte-matching archive AND a project.json
  // hashing to the true lease digest — archive-bytes-only ownership
  // followed this link and accepted it as our own completed promotion.
  const external = externalTmp();
  const externalProject = path.join(external, id);
  fs.mkdirSync(externalProject);
  fs.writeFileSync(
    path.join(externalProject, 'project.json'),
    JSON.stringify(documentProject(id), null, 2),
  );
  fs.writeFileSync(path.join(externalProject, DOCUMENT_FILE), content);
  fs.symlinkSync(externalProject, path.join(rootDir, id), 'dir');
  writeCreateIntentFile(id, {
    phase: 'leased',
    content,
    projectSha256: sha256File(path.join(externalProject, 'project.json')),
  });
  const intentBefore = fs.readFileSync(intentPathFor(id));

  const err = thrownError(() => store.loadDocumentProject(id));
  assert.equal(err && err.code, 'CONFLICT');
  assert.match(err.message, /symbolic link/);
  assert.ok(fs.lstatSync(path.join(rootDir, id)).isSymbolicLink(), 'final link untouched');
  assert.ok(
    fs.existsSync(path.join(externalProject, DOCUMENT_FILE)),
    'external bytes never consumed as our promotion',
  );
  assert.ok(!fs.existsSync(stagingPathFor(id)), 'no staged residue invented');
  assert.ok(
    fs.readFileSync(intentPathFor(id)).equals(intentBefore),
    'intent retained byte-identical',
  );
});

test('a FIFO final archive node fails CORRUPT_DATA instead of hanging recovery', () => {
  const id = 'proj-b2-final-fifo';
  const content = JSON.stringify(archiveFor(id, importedTxt), null, 2);
  fs.mkdirSync(path.join(rootDir, id), { recursive: true });
  const finalProjectPath = path.join(rootDir, id, 'project.json');
  fs.writeFileSync(finalProjectPath, JSON.stringify(documentProject(id), null, 2));
  const fifoPath = path.join(rootDir, id, DOCUMENT_FILE);
  execFileSync('mkfifo', [fifoPath]);
  writeCreateIntentFile(id, {
    phase: 'leased',
    content,
    // Strongest forgery: the true lease digest of the final project.json —
    // only the archive NODE is hostile. Ownership proof must never OPEN it.
    projectSha256: sha256File(finalProjectPath),
  });

  const err = thrownError(() => store.loadDocumentProject(id));
  assert.equal(err && err.code, 'CORRUPT_DATA');
  assert.match(err.message, /not a regular file/);
  assert.ok(fs.lstatSync(fifoPath).isFIFO(), 'FIFO untouched');
  assert.ok(fs.existsSync(intentPathFor(id)), 'intent retained');
});

test('a symlinked final archive node is refused instead of read through', () => {
  const id = 'proj-b2-final-doclink';
  const externalDoc = path.join(externalTmp(), 'document.json');
  fs.writeFileSync(externalDoc, '{}');
  fs.mkdirSync(path.join(rootDir, id), { recursive: true });
  const finalProjectPath = path.join(rootDir, id, 'project.json');
  fs.writeFileSync(finalProjectPath, JSON.stringify(documentProject(id), null, 2));
  fs.symlinkSync(externalDoc, path.join(rootDir, id, DOCUMENT_FILE), 'file');
  writeCreateIntentFile(id, {
    phase: 'leased',
    content: JSON.stringify(archiveFor(id, importedTxt), null, 2),
    projectSha256: sha256File(finalProjectPath),
  });

  const err = thrownError(() => store.loadDocumentProject(id));
  assert.equal(err && err.code, 'CORRUPT_DATA');
  assert.match(err.message, /symbolic link/);
  assert.equal(fs.readFileSync(externalDoc, 'utf8'), '{}', 'external node never read');
  assert.ok(fs.existsSync(intentPathFor(id)), 'intent retained');
});

test('ownership needs the leased project.json identity, not archive bytes alone', () => {
  const id = 'proj-b3-foreign-doc-same-archive';
  const content = JSON.stringify(archiveFor(id, importedTxt), null, 2);

  // Foreign DOC project whose document.json is BYTE-IDENTICAL to the
  // journaled payload but whose project.json is not our staged lease.
  store.projectStore.saveProject(
    documentProject(id, { metadata: { name: 'Foreign Doc', sourceFileName: 'other.txt' } }),
    undefined,
  );
  fs.writeFileSync(path.join(rootDir, id, DOCUMENT_FILE), content);
  writeCreateIntentFile(id, {
    phase: 'leased',
    content,
    projectSha256: sha256(Buffer.from(JSON.stringify(documentProject(id), null, 2))),
  });
  const foreignProjectBefore = fs.readFileSync(path.join(rootDir, id, 'project.json'));

  // Archive bytes alone used to prove ownership here, silently dropping
  // the creation intent over a foreign project. Now: CONFLICT, all kept.
  const err = thrownError(() => store.loadDocumentProject(id));
  assert.equal(err && err.code, 'CONFLICT');
  assert.match(err.message, /does not match|foreign/);
  assert.ok(
    fs.readFileSync(path.join(rootDir, id, 'project.json')).equals(foreignProjectBefore),
    'foreign project untouched',
  );
  assert.equal(
    fs.readFileSync(path.join(rootDir, id, DOCUMENT_FILE), 'utf8'),
    content,
    'sidecar untouched',
  );
  assert.ok(fs.existsSync(intentPathFor(id)), 'creation intent preserved');
});

test('a media project with a byte-matching document.json sidecar stays a foreign collision', () => {
  const id = 'proj-b3-media-sidecar';
  const content = JSON.stringify(archiveFor(id, importedTxt), null, 2);
  store.projectStore.saveProject(
    {
      ...documentProject(id, { type: 'media' }),
      mediaState: {
        sourceFileName: 'a.wav',
        durationSec: 5,
        sourceLang: 'en',
        targetLang: 'de',
        transcriptionProvider: 'whisper',
        translationProvider: 'llama',
        outputFormats: ['SRT'],
        chunks: [],
      },
    },
    undefined,
  );
  // Forged sidecar: exactly the journaled payload under a type:"media"
  // project. Archive-bytes-only ownership accepted this as a completed
  // creation and discarded the intent.
  const sidecarPath = path.join(rootDir, id, DOCUMENT_FILE);
  fs.writeFileSync(sidecarPath, content);
  writeCreateIntentFile(id, {
    phase: 'leased',
    content,
    projectSha256: sha256(Buffer.from(JSON.stringify(documentProject(id), null, 2))),
  });

  const err = thrownError(() => store.listLanguages(id));
  assert.equal(err && err.code, 'CONFLICT');
  assert.match(err.message, /does not match|foreign/);
  assert.equal(fs.readFileSync(sidecarPath, 'utf8'), content, 'forged sidecar left as evidence');
  assert.ok(fs.existsSync(intentPathFor(id)), 'creation intent preserved');
});

// --- Validation classification & exhaustiveness (finding 4) ----------------------

test('parseable-but-invalid archives are CORRUPT_DATA on every read path', () => {
  createTxtProject('proj-semcorrupt');
  const docPath = path.join(rootDir, 'proj-semcorrupt', DOCUMENT_FILE);
  const good = store.loadDocumentArchive('proj-semcorrupt');

  // Gap tiling: parseable JSON, semantically invalid.
  const gapped = structuredClone(good);
  gapped.blocks[0].spans[0].end -= 1;
  fs.writeFileSync(docPath, JSON.stringify(gapped, null, 2));
  assert.notEqual(errorCode(() => store.loadDocumentProject('proj-semcorrupt')), 'VALIDATION_FAILED');
  assert.equal(errorCode(() => store.loadDocumentProject('proj-semcorrupt')), 'CORRUPT_DATA');

  // Fractional offsets likewise.
  const fractional = structuredClone(good);
  fractional.blocks[0].spans[0].end -= 0.5;
  fs.writeFileSync(docPath, JSON.stringify(fractional, null, 2));
  assert.equal(errorCode(() => store.loadDocumentArchive('proj-semcorrupt')), 'CORRUPT_DATA');

  fs.writeFileSync(docPath, JSON.stringify(good, null, 2)); // restore

  // Invalid translation sibling fails the whole reopen and both listings.
  store.addLanguage('proj-semcorrupt', 'de', { provider: 'llama', sourceHash: META_HASH }, readProjectRevision('proj-semcorrupt'));
  const dePath = path.join(rootDir, 'proj-semcorrupt', TRANSLATIONS_DIR, 'de.json');
  const goodDe = JSON.parse(fs.readFileSync(dePath, 'utf8'));
  fs.writeFileSync(dePath, JSON.stringify({ ...goodDe, blocks: { b0: { ...goodDe.blocks.b0, status: 'nope' } } }, null, 2));
  assert.equal(errorCode(() => store.getTranslationArchive('proj-semcorrupt', 'de')), 'CORRUPT_DATA');
  assert.equal(errorCode(() => store.listLanguages('proj-semcorrupt')), 'CORRUPT_DATA');
  assert.equal(
    errorCode(() => store.loadDocumentProject('proj-semcorrupt')),
    'CORRUPT_DATA',
    'reopen validates ALL translation siblings',
  );
});

test('translation identity mismatches are CORRUPT_DATA (foreign payload or stem)', () => {
  createTxtProject('proj-identity');
  store.addLanguage('proj-identity', 'de', { provider: 'llama', sourceHash: META_HASH }, readProjectRevision('proj-identity'));
  const dePath = path.join(rootDir, 'proj-identity', TRANSLATIONS_DIR, 'de.json');
  const originalBytes = fs.readFileSync(dePath);
  const expectAllCorrupt = () => {
    assert.equal(errorCode(() => store.getTranslationArchive('proj-identity', 'de')), 'CORRUPT_DATA');
    assert.equal(errorCode(() => store.listLanguages('proj-identity')), 'CORRUPT_DATA');
    assert.equal(errorCode(() => store.loadDocumentProject('proj-identity')), 'CORRUPT_DATA');
  };

  // Foreign project payload inside our file.
  const foreignProject = JSON.parse(originalBytes.toString('utf8'));
  foreignProject.projectId = 'some-other-project';
  fs.writeFileSync(dePath, JSON.stringify(foreignProject, null, 2));
  expectAllCorrupt();
  fs.writeFileSync(dePath, originalBytes);

  // Payload language disagreeing with the file stem (stem is authoritative).
  const foreignStem = JSON.parse(originalBytes.toString('utf8'));
  foreignStem.language = 'fr';
  fs.writeFileSync(dePath, JSON.stringify(foreignStem, null, 2));
  expectAllCorrupt();
  fs.writeFileSync(dePath, originalBytes);

  // Restored: everything green again.
  assert.equal(store.getTranslationArchive('proj-identity', 'de').language, 'de');
  assert.deepEqual(store.listLanguages('proj-identity').map((l) => l.language), ['de']);
});

test('listLanguages distinguishes an absent translations dir from an unreadable one', (t) => {
  createTxtProject('proj-listing');
  assert.deepEqual(store.listLanguages('proj-listing'), [], 'absent dir is a valid empty state');

  store.addLanguage('proj-listing', 'de', { provider: 'llama', sourceHash: META_HASH }, readProjectRevision('proj-listing'));
  const dir = path.join(rootDir, 'proj-listing', TRANSLATIONS_DIR);
  fs.chmodSync(dir, 0o000);
  try {
    let caught = null;
    try {
      store.listLanguages('proj-listing');
    } catch (err) {
      caught = err;
    }
    if (!caught) return t.skip('filesystem permissions not enforced for this uid');
    assert.equal(caught.code, 'CORRUPT_DATA', 'I/O failure never silently becomes []');
  } finally {
    fs.chmodSync(dir, 0o755);
  }
  assert.deepEqual(store.listLanguages('proj-listing').map((l) => l.language), ['de']);
});

// --- Provenance completeness & canonical hashes (findings 5, 6) ------------------

test('provenance persists complete via validated sentinels; hashes must be canonical', () => {
  createTxtProject('prov-proj');
  let rev = readProjectRevision('prov-proj');

  // Minimal meta: unrecorded fields persist as explicit sentinels.
  ({ revision: rev } = store.addLanguage('prov-proj', 'de', { provider: 'llama', sourceHash: META_HASH }, rev));
  assert.deepEqual(store.getTranslationArchive('prov-proj', 'de').meta, {
    provider: 'llama',
    model: 'unknown',
    profile: 'unknown',
    promptVersion: 'unknown',
    glossaryRevision: 'unknown',
    sourceHash: META_HASH,
  });

  // Explicit values persist verbatim.
  ({ revision: rev } = store.addLanguage('prov-proj', 'fr', {
    provider: 'gemini', model: 'm2', profile: 'lit', promptVersion: 'pv9', glossaryRevision: 'g7', sourceHash: OTHER_HASH,
  }, rev));
  assert.deepEqual(store.getTranslationArchive('prov-proj', 'fr').meta, {
    provider: 'gemini', model: 'm2', profile: 'lit', promptVersion: 'pv9', glossaryRevision: 'g7', sourceHash: OTHER_HASH,
  });

  // Non-canonical provenance hashes are rejected outright.
  assert.equal(
    errorCode(() => store.addLanguage('prov-proj', 'es', { provider: 'x', sourceHash: 'deadbeef' }, rev)),
    'VALIDATION_FAILED',
  );

  // A non-canonical per-block hash on disk makes the archive unreadable.
  const dePath = path.join(rootDir, 'prov-proj', TRANSLATIONS_DIR, 'de.json');
  const parsed = JSON.parse(fs.readFileSync(dePath, 'utf8'));
  parsed.blocks.b0 = { blockId: 'b0', text: 'x', sourceHash: 'deadbeef', status: 'draft', updatedAt: T0 };
  fs.writeFileSync(dePath, JSON.stringify(parsed, null, 2));
  assert.equal(errorCode(() => store.getTranslationArchive('prov-proj', 'de')), 'CORRUPT_DATA');
});

// --- Freshness semantics (finding 7) ----------------------------------------------

test('freshness semantics distinguish text commits from status-only ops', () => {
  createTxtProject('proj-freshsem');
  let rev = readProjectRevision('proj-freshsem');
  const originalHash = blockSourceHash(importedBlocks[0]);
  const hexOf = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

  const freshnessOf = () => store.freshness('proj-freshsem', 'de').blocks.b0.freshness;
  ({ revision: rev } = store.addLanguage('proj-freshsem', 'de', { provider: 'llama', sourceHash: originalHash }, rev));
  ({ revision: rev } = store.saveTranslations('proj-freshsem', 'de', [{ blockId: 'b0', text: 'Hallo Welt.' }], rev));
  assert.equal(freshnessOf(), 'fresh');

  // Edited source -> stale.
  ({ revision: rev } = store.updateBlockText('proj-freshsem', 'b0', 'Edited source.', rev));
  assert.equal(freshnessOf(), 'stale');

  // Plain retranslation recomputes against the CURRENT source -> fresh.
  ({ revision: rev } = store.saveTranslations('proj-freshsem', 'de', [{ blockId: 'b0', text: 'Neu.' }], rev));
  assert.equal(freshnessOf(), 'fresh', 'plain retranslation does not inherit the old hash');

  // Retranslation with an EXPLICIT STALE snapshot hash -> stale (async path).
  ({ revision: rev } = store.saveTranslations('proj-freshsem', 'de', [
    { blockId: 'b0', text: 'Nochmal.', sourceHash: originalHash },
  ], rev));
  assert.equal(freshnessOf(), 'stale', 'explicit stale snapshot hash wins over auto-rehash');

  // Retranslation with the explicit CURRENT snapshot hash -> fresh again.
  ({ revision: rev } = store.saveTranslations('proj-freshsem', 'de', [
    { blockId: 'b0', text: 'Nochmal.', sourceHash: hexOf('Edited source.') },
  ], rev));
  assert.equal(freshnessOf(), 'fresh', 'explicit current snapshot hash accepted');

  // Status-only approval keeps text AND hash.
  ({ revision: rev } = store.saveTranslations('proj-freshsem', 'de', [{ blockId: 'b0', status: 'approved' }], rev));
  assert.equal(freshnessOf(), 'fresh');
  assert.equal(store.getTranslationArchive('proj-freshsem', 'de').blocks.b0.status, 'approved');

  // Reverting the source re-stales until retranslated against the revert.
  ({ revision: rev } = store.updateBlockText('proj-freshsem', 'b0', importedBlocks[0].text, rev));
  assert.equal(freshnessOf(), 'stale');
  ({ revision: rev } = store.saveTranslations('proj-freshsem', 'de', [{ blockId: 'b0', text: 'Zurück.' }], rev));
  assert.equal(freshnessOf(), 'fresh', 'reverted source retranslates fresh');

  // Empty-text commits are legal text commits hashed against current source.
  ({ revision: rev } = store.saveTranslations('proj-freshsem', 'de', [{ blockId: 'b1', text: '' }], rev));
  assert.equal(store.freshness('proj-freshsem', 'de').blocks.b1.freshness, 'fresh');

  // Contract violations.
  assert.equal(
    errorCode(() => store.saveTranslations('proj-freshsem', 'de', [{ blockId: 'b1', sourceHash: hexOf('x') }], rev)),
    'VALIDATION_FAILED',
    'sourceHash without text rejected',
  );
  assert.equal(
    errorCode(() => store.saveTranslations('proj-freshsem', 'de', [
      { blockId: 'b1', text: 'y', sourceHash: 'deadbeef' },
    ], rev)),
    'VALIDATION_FAILED',
    'non-canonical explicit hash rejected',
  );
});

// --- Epoch monotonicity & source asset immutability (finding 8) -------------------

test('wholesale saves enforce epoch monotonicity and sourceAsset immutability', () => {
  createTxtProject('proj-immutable');
  let rev = readProjectRevision('proj-immutable');
  ({ revision: rev } = store.updateBlockText('proj-immutable', 'b0', 'Edited.', rev));
  const archive = store.loadDocumentArchive('proj-immutable');
  assert.equal(archive.editEpoch, 1);

  assert.equal(
    errorCode(() => store.saveDocumentArchive('proj-immutable', { ...archive, editEpoch: 0 }, rev)),
    'VALIDATION_FAILED',
    'epoch regression rejected',
  );
  assert.equal(
    errorCode(() =>
      store.saveDocumentArchive('proj-immutable', {
        ...archive,
        sourceAsset: { ...archive.sourceAsset, hash: sha256(Buffer.from('different-bytes')) },
      }, rev),
    ),
    'VALIDATION_FAILED',
    'sourceAsset mutation rejected',
  );

  // Equal epoch + identical asset is accepted (metadata-only rewrites).
  ({ revision: rev } = store.saveDocumentArchive('proj-immutable', archive, rev));

  // Repair path: an unreadable current archive has nothing to compare
  // against, so restoring any valid archive stays possible.
  fs.writeFileSync(path.join(rootDir, 'proj-immutable', DOCUMENT_FILE), '{broken');
  store.saveDocumentArchive(
    'proj-immutable',
    archiveFor('proj-immutable', importedTxt, { editEpoch: 0 }),
    rev,
  );
  assert.equal(store.loadDocumentArchive('proj-immutable').blocks.length, 2);
});

// --- Bundle import exhaustiveness (findings 4, 10) --------------------------------

test('bundle import rejects checksum-valid but semantically corrupt siblings', async () => {
  const id = 'proj-bsb';
  createTxtProject(id);
  let rev = readProjectRevision(id);
  ({ revision: rev } = store.addLanguage(id, 'de', { provider: 'llama', sourceHash: META_HASH }, rev));
  ({ revision: rev } = store.saveTranslations(id, 'de', [{ blockId: 'b0', text: 'Hallo Welt.' }], rev));

  const dir = path.join(rootDir, id);
  const projectJson = fs.readFileSync(path.join(dir, 'project.json'));
  const documentJson = fs.readFileSync(path.join(dir, DOCUMENT_FILE));
  const deJson = fs.readFileSync(path.join(dir, TRANSLATIONS_DIR, 'de.json'));
  const buildZip = async (outPath, entries) => {
    // Manifest checksums are GENUINE — computed over the exact (bad) bytes.
    const manifest = {
      format: BUNDLE_FORMAT,
      schemaVersion: 3,
      algorithm: 'sha256',
      createdAt: new Date().toISOString(),
      projectId: id,
      entries: Object.keys(entries).map((p) => ({
        path: p,
        size: entries[p].length,
        checksum: sha256(entries[p]),
      })),
    };
    await makeArchivedZip(outPath, { 'manifest.json': JSON.stringify(manifest), ...entries });
  };

  const attemptImport = async (zipPath) => {
    const targetRoot = tmpRoot();
    try {
      return await importProjectBundle(zipPath, {
        store: new DocumentProjectStore({ baseDir: targetRoot }).projectStore,
      });
    } finally {
      fs.rmSync(targetRoot, { recursive: true, force: true });
    }
  };

  // Sibling A: payload language disagrees with its file stem.
  const stemMismatch = Buffer.from(
    JSON.stringify({ ...JSON.parse(deJson.toString('utf8')), language: 'fr' }, null, 2),
  );
  const mismatchPath = path.join(rootDir, `${id}-stem.vsbundle`);
  await buildZip(mismatchPath, {
    'project.json': projectJson,
    [DOCUMENT_FILE]: documentJson,
    'translations/de.json': stemMismatch,
  });
  await assert.rejects(attemptImport(mismatchPath), (err) => err instanceof AppError && err.code === 'CORRUPT_DATA');

  // Sibling B: parseable-but-invalid document archive (broken tiling).
  const invalidDoc = JSON.parse(documentJson.toString('utf8'));
  invalidDoc.blocks[0].spans[0].end -= 1;
  const invalidPath = path.join(rootDir, `${id}-tile.vsbundle`);
  await buildZip(invalidPath, {
    'project.json': projectJson,
    [DOCUMENT_FILE]: Buffer.from(JSON.stringify(invalidDoc, null, 2)),
    'translations/de.json': deJson,
  });
  await assert.rejects(attemptImport(invalidPath), (err) => err instanceof AppError && err.code === 'CORRUPT_DATA');
});

test('checksum-valid document bundles without their document archive are rejected before promotion', async () => {
  const id = 'proj-nodoc-bundle';
  createTxtProject(id);
  let rev = readProjectRevision(id);
  ({ revision: rev } = store.addLanguage(id, 'fr', { provider: 'llama', sourceHash: META_HASH }, rev));

  const dir = path.join(rootDir, id);
  const projectJson = fs.readFileSync(path.join(dir, 'project.json'));
  const frJson = fs.readFileSync(path.join(dir, TRANSLATIONS_DIR, 'fr.json'));
  // document.json is deliberately OMITTED; manifest checksums stay GENUINE
  // over the exact bytes shipped, so checksum verification passes and the
  // document-lane check is what must stop the import.
  const buildZip = async (outPath, entries) => {
    const manifest = {
      format: BUNDLE_FORMAT,
      schemaVersion: 3,
      algorithm: 'sha256',
      createdAt: new Date().toISOString(),
      projectId: id,
      entries: Object.keys(entries).map((p) => ({
        path: p,
        size: entries[p].length,
        checksum: sha256(entries[p]),
      })),
    };
    await makeArchivedZip(outPath, { 'manifest.json': JSON.stringify(manifest), ...entries });
  };
  const attemptImport = async (zipPath) => {
    const targetRoot = tmpRoot();
    try {
      await assert.rejects(
        () =>
          importProjectBundle(zipPath, {
            store: new DocumentProjectStore({ baseDir: targetRoot }).projectStore,
          }),
        (err) =>
          err instanceof AppError && err.code === 'CORRUPT_DATA' && /document\.json/.test(err.message),
      );
      // Rejection happened BEFORE safeMoveDirectory: nothing was promoted.
      assert.ok(!fs.existsSync(path.join(targetRoot, id)), 'nothing was promoted');
    } finally {
      fs.rmSync(targetRoot, { recursive: true, force: true });
    }
  };

  // A translations lane without its document archive cannot stand alone.
  const orphanPath = path.join(rootDir, `${id}-orphan.vsbundle`);
  await buildZip(orphanPath, { 'project.json': projectJson, 'translations/fr.json': frJson });
  await attemptImport(orphanPath);

  // A type=document bundle requires the archive even with no lanes at all.
  const barePath = path.join(rootDir, `${id}-bare.vsbundle`);
  await buildZip(barePath, { 'project.json': projectJson });
  await attemptImport(barePath);
});

// --- Unicode span boundaries (finding 3) -------------------------------------------

test('surrogate-pair spans follow the documented UTF-16 code-unit rule', () => {
  createTxtProject('proj-emoji');
  let rev = readProjectRevision('proj-emoji');
  const emojiText = 'a😀b'; // UTF-16 length 4: 'a' + surrogate pair + 'b'
  assert.equal(emojiText.length, 4);

  ({ revision: rev } = store.updateBlockText('proj-emoji', 'b0', emojiText, rev, {
    spans: [
      { spanId: 'b0-s0', blockId: 'b0', text: 'a', start: 0, end: 1, traits: {} },
      { spanId: 'b0-s1', blockId: 'b0', text: '😀', start: 1, end: 3, traits: { bold: true } },
      { spanId: 'b0-s2', blockId: 'b0', text: 'b', start: 3, end: 4, traits: {} },
    ],
  }));
  const reopened = store.loadDocumentArchive('proj-emoji');
  assert.equal(reopened.blocks[0].text, emojiText);
  assert.equal(reopened.blocks[0].spans[1].text, '😀');
  assert.equal(reopened.blocks[0].spans[1].traits.bold, true);

  // A split INSIDE the surrogate pair is legal per the documented rule:
  // integrity comes from slice equality, not code-point alignment.
  const high = '\uD83D';
  const low = '\uDE00';
  store.updateBlockText('proj-emoji', 'b0', `${high}${low}x`, rev, {
    spans: [
      { spanId: 'b0-s0', blockId: 'b0', text: high, start: 0, end: 1, traits: {} },
      { spanId: 'b0-s1', blockId: 'b0', text: `${low}x`, start: 1, end: 3, traits: {} },
    ],
  });
  assert.equal(store.loadDocumentArchive('proj-emoji').blocks[0].spans[0].text, high);

  // Shared validator: faithful splits pass, unfaithful slices fail.
  const base = archiveFor('proj-emoji-v', importedTxt);
  const emojiBlock = { ...importedBlocks[0], text: '😀' };
  assert.equal(
    validateDocumentArchive({
      ...base,
      blocks: [{ ...emojiBlock, spans: [
        { spanId: 's0', blockId: emojiBlock.blockId, text: high, start: 0, end: 1, traits: {} },
        { spanId: 's1', blockId: emojiBlock.blockId, text: low, start: 1, end: 2, traits: {} },
      ] }],
    }).ok,
    true,
    'faithful surrogate split accepted',
  );
  assert.equal(
    validateDocumentArchive({
      ...base,
      blocks: [{ ...emojiBlock, spans: [
        { spanId: 's0', blockId: emojiBlock.blockId, text: low, start: 0, end: 1, traits: {} },
        { spanId: 's1', blockId: emojiBlock.blockId, text: high, start: 1, end: 2, traits: {} },
      ] }],
    }).ok,
    false,
    'unfaithful surrogate slice rejected',
  );
});
