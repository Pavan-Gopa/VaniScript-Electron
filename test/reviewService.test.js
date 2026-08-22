'use strict';

// DOC-06 — multi-language/review service tests.
//
// These tests exercise the service boundary over real D2 archives: approval
// transitions use the project revision CAS, queries derive stale/status rows
// from freshness, plans reconcile token estimates, and language management
// never crosses archive boundaries.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getFixture } = require('./fixtures/document-fixtures.js');
const { importDocument } = require('../electron/main/documents/import.js');
const { DocumentProjectStore } = require('../electron/main/documents/documentProjectStore.js');
const {
  createDocumentReviewService,
  filterReviewBlocks,
  filterReviewBlockIds,
  getReviewProgress,
} = require('../electron/main/documents/reviewService.js');
const { AppError } = require('../shared/contracts/errors.ts');

const T0 = '2026-01-01T00:00:00.000Z';
const META_HASH = 'aa'.repeat(32);

let rootDir;
let store;
let review;
let importedTxt;

function project(projectId) {
  return {
    schemaVersion: 3,
    projectId,
    revision: '1',
    type: 'document',
    metadata: { name: 'Review fixture', sourceFileName: 'sample.txt' },
    documentState: {
      sourceFileName: 'sample.txt',
      title: 'Review fixture',
      sourceLang: 'en',
      targetLang: 'de',
      translationProvider: 'fixture',
    },
    createdAt: T0,
    updatedAt: T0,
    assets: [],
  };
}

function archive(projectId) {
  return {
    schemaVersion: 1,
    projectId,
    format: importedTxt.format,
    title: importedTxt.title,
    sourceAsset: importedTxt.sourceAsset,
    preflight: importedTxt.preflight,
    blocks: importedTxt.blocks,
    editBaselines: {},
    blockPolicies: {},
    spanPolicies: {},
    editEpoch: 0,
    createdAt: T0,
    updatedAt: T0,
  };
}

function revision(projectId) {
  return JSON.parse(
    fs.readFileSync(path.join(rootDir, projectId, 'project.json'), 'utf8'),
  ).revision;
}

function bytes(projectId, language) {
  return fs.readFileSync(
    path.join(rootDir, projectId, 'translations', `${language}.json`),
  );
}

function appError(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${error}`);
    return error;
  }
  return null;
}

function createProject(projectId) {
  store.createDocumentProject(project(projectId), archive(projectId));
  return revision(projectId);
}

function addAndFill(projectId, language = 'de') {
  let rev = createProject(projectId);
  ({ revision: rev } = store.addLanguage(projectId, language, {
    provider: 'fixture-provider',
    model: 'fixture-model',
    profile: 'literary',
    promptVersion: 'prompt-7',
    glossaryRevision: 'glossary-3',
    sourceHash: META_HASH,
  }, rev));
  const blocks = importedTxt.blocks;
  ({ revision: rev } = store.saveTranslations(projectId, language, [
    { blockId: blocks[0].blockId, text: 'Erster Zieltext.' },
    { blockId: blocks[1].blockId, text: 'Zweiter Zieltext.', status: 'needs-review' },
  ], rev));
  return rev;
}

test.before(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscript-review-'));
  store = new DocumentProjectStore({ baseDir: rootDir });
  review = createDocumentReviewService({ store });
  importedTxt = await importDocument(getFixture('txt'));
});

test.after(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('approval lifecycle is per-language and revision guarded', () => {
  let rev = addAndFill('review-lifecycle');
  const [first, second] = importedTxt.blocks;

  let result = review.approveBlock('review-lifecycle', 'DE', first.blockId, rev);
  assert.equal(result.previousStatus, 'draft');
  assert.equal(result.status, 'approved');
  assert.equal(result.changed, true);
  rev = result.revision;
  assert.equal(store.getTranslationArchive('review-lifecycle', 'de').blocks[first.blockId].status, 'approved');

  result = review.revokeBlock('review-lifecycle', 'de', first.blockId, rev);
  assert.equal(result.previousStatus, 'approved');
  assert.equal(result.status, 'needs-review');
  rev = result.revision;
  assert.equal(store.getTranslationArchive('review-lifecycle', 'de').blocks[first.blockId].status, 'needs-review');

  result = review.approveBlock('review-lifecycle', 'de', second.blockId, rev);
  assert.equal(result.previousStatus, 'needs-review');
  rev = result.revision;
  assert.equal(store.getTranslationArchive('review-lifecycle', 'de').blocks[second.blockId].status, 'approved');

  result = review.setBlockNeedsReview('review-lifecycle', 'de', second.blockId, rev);
  assert.equal(result.previousStatus, 'approved');
  assert.equal(result.status, 'needs-review');
  rev = result.revision;
  assert.equal(store.getTranslationArchive('review-lifecycle', 'de').blocks[second.blockId].status, 'needs-review');

  const conflict = appError(() => review.approveBlock('review-lifecycle', 'de', first.blockId, 'stale-revision'));
  assert.equal(conflict.code, 'CONFLICT');
  assert.equal(revision('review-lifecycle'), rev);

  assert.equal(
    appError(() => review.revokeBlock('review-lifecycle', 'de', first.blockId, rev)).code,
    'VALIDATION_FAILED',
    'revoke only accepts approved rows',
  );
  assert.equal(
    appError(() => review.approveBlock('review-lifecycle', 'de', 'missing-block', rev)).code,
    'NOT_FOUND',
  );
});

test('setBlockNeedsReview is idempotent without rewriting archive bytes', () => {
  const projectId = 'review-idempotent';
  let rev = addAndFill(projectId);
  const blockId = importedTxt.blocks[1].blockId;
  const before = bytes(projectId, 'de');
  const first = review.setBlockNeedsReview(projectId, 'de', blockId, rev);
  rev = first.revision;
  const afterFirst = bytes(projectId, 'de');
  const second = review.setBlockNeedsReview(projectId, 'de', blockId, rev);
  assert.equal(second.changed, false);
  assert.equal(second.revision, rev);
  assert.ok(afterFirst.equals(bytes(projectId, 'de')));
  assert.ok(before.equals(afterFirst), 'status was already needs-review');
});

test('filters combine freshness and status deterministically', () => {
  const projectId = 'review-filters';
  let rev = addAndFill(projectId);
  const [first, second] = importedTxt.blocks;
  ({ revision: rev } = review.approveBlock(projectId, 'de', first.blockId, rev));
  // Change only the first source block after approval: it remains approved but
  // is stale, while the second is fresh and needs-review.
  ({ revision: rev } = store.updateBlockText(projectId, first.blockId, 'Changed source.', rev));

  const report = store.freshness(projectId, 'de');
  assert.deepEqual(filterReviewBlockIds(report, 'All'), [first.blockId, second.blockId]);
  assert.deepEqual(filterReviewBlockIds(report, 'Needs Review'), [second.blockId]);
  assert.deepEqual(filterReviewBlockIds(report, 'stale'), [first.blockId]);
  assert.deepEqual(filterReviewBlockIds(report, 'Approved'), [first.blockId]);
  assert.deepEqual(filterReviewBlocks(report, 'stale'), [
    { blockId: first.blockId, freshness: 'stale', status: 'approved' },
  ]);

  const state = review.getLanguageReviewState(projectId, 'de');
  assert.equal(state.freshness.blocks[first.blockId].freshness, 'stale');
  assert.equal(state.progress.stale, 1);
  assert.equal(state.progress.statusCounts.approved, 1);
  assert.equal(state.progress.statusCounts.needsReview, 1);
});

test('progress reconciles D3 token estimates and reports status counts', () => {
  const report = {
    language: 'de',
    blocks: {
      b0: { freshness: 'fresh', status: 'approved' },
      b1: { freshness: 'stale', status: 'needs-review' },
      b2: { freshness: 'fresh', status: 'draft' },
      b3: { freshness: 'missing', status: 'missing' },
    },
  };
  const plan = {
    chunks: [
      {
        tokenEstimate: 7,
        slices: [
          { blockId: 'b0', tokenEstimate: 3 },
          { blockId: 'b1', tokenEstimate: 4 },
        ],
      },
      {
        tokenEstimate: 5,
        slices: [{ blockId: 'b2', tokenEstimate: 5 }],
      },
    ],
  };
  const progress = getReviewProgress(report, plan);
  assert.deepEqual(progress.statusCounts, {
    draft: 1,
    needsReview: 1,
    approved: 1,
    missing: 1,
  });
  assert.equal(progress.translated, 3);
  assert.equal(progress.stale, 1);
  assert.equal(progress.blocksDone, 3);
  assert.equal(progress.tokensDone, 12);
  assert.equal(progress.tokensTotal, 12);
  assert.deepEqual(progress.tokenProgress, { done: 12, total: 12 });

  const withoutPlan = getReviewProgress(report);
  assert.equal(withoutPlan.tokensDone, null);
  assert.equal(withoutPlan.tokensTotal, null);
  assert.equal(withoutPlan.tokenProgress, null);
});

test('language state exposes provenance and active-language view state', () => {
  const projectId = 'review-state';
  let rev = addAndFill(projectId);
  ({ revision: rev } = review.addLanguage(projectId, 'fr', {
    provider: 'second-provider',
    model: 'second-model',
    profile: 'literal',
    promptVersion: 'prompt-8',
    glossaryRevision: 'glossary-4',
    sourceHash: META_HASH,
  }, rev));
  const frBefore = bytes(projectId, 'fr');
  ({ revision: rev } = review.setActiveLanguage(projectId, 'FR', rev));
  const state = review.getReviewState(projectId, 'fr');
  assert.equal(state.activeLanguage, 'fr');
  assert.equal(state.isActive, true);
  assert.equal(state.provenance.provider, 'second-provider');
  assert.equal(state.variant.meta.promptVersion, 'prompt-8');
  assert.deepEqual(state.languages, ['de', 'fr']);
  assert.ok(frBefore.equals(bytes(projectId, 'fr')), 'active switch does not mutate archive');

  const deBefore = bytes(projectId, 'de');
  ({ revision: rev } = store.saveTranslations(projectId, 'fr', [
    { blockId: importedTxt.blocks[0].blockId, text: 'Bonjour.' },
  ], rev));
  assert.ok(deBefore.equals(bytes(projectId, 'de')), 'writing fr does not mutate de');

  const tabs = review.getActiveLanguageViewState(projectId);
  assert.deepEqual(tabs, {
    activeLanguage: 'fr',
    languages: ['de', 'fr'],
    hasActiveLanguage: true,
  });
});

test('language removal requires confirmation and preserves optional backup contract', () => {
  const projectId = 'review-remove';
  let rev = addAndFill(projectId);
  ({ revision: rev } = review.addLanguage(projectId, 'fr', {
    provider: 'second-provider',
    sourceHash: META_HASH,
  }, rev));
  const backupDir = path.join(rootDir, 'review-remove-backup');
  const frBefore = bytes(projectId, 'fr');

  const confirmation = review.requestLanguageRemoval(projectId, 'fr', { backupDir });
  assert.equal(confirmation.requiresConfirmation, true);
  assert.equal(confirmation.action, 'remove-language');
  assert.equal(confirmation.language, 'fr');
  assert.equal(confirmation.expectedRevision, rev);
  assert.equal(
    appError(() => review.removeLanguage(projectId, 'fr', rev, { backupDir })).code,
    'VALIDATION_FAILED',
  );
  assert.ok(frBefore.equals(bytes(projectId, 'fr')), 'unconfirmed removal is a no-op');

  const result = review.removeLanguage(projectId, 'fr', rev, { confirmed: true, backupDir });
  assert.equal(result.language, 'fr');
  assert.equal(result.backupFile, path.join(backupDir, 'fr.json'));
  assert.ok(!fs.existsSync(path.join(rootDir, projectId, 'translations', 'fr.json')));
  assert.ok(fs.readFileSync(path.join(backupDir, 'fr.json')).equals(frBefore));
  assert.ok(fs.existsSync(path.join(rootDir, projectId, 'translations', 'de.json')));
});
