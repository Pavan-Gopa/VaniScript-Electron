'use strict';

// P3A.D7 — selection, find/replace, and proofreading primitives.
// The first tests use a small in-memory binding to isolate the D7 contract;
// the final test runs the same selection operation through real D5 + D2.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EditorState } = require('prosemirror-state');
const { history } = require('prosemirror-history');

const {
  captureSelectionSnapshot,
  applySelectionResponse,
  validateSnapshot,
  validateSelectionSnapshot,
  hashText,
} = require('../electron/main/documents/selectionOps.js');
const {
  scanMatches,
  previewReplaceAll,
  replaceAll,
} = require('../electron/main/documents/findReplace.js');
const {
  projectProofreadAlignment,
  computeHighlightRanges,
  alignSentences,
  sourceRefreshMergeReport,
} = require('../electron/main/documents/proofread.js');
const { buildSourceDoc } = require('../electron/main/documents/editorSchema.js');
const { createEditorBinding } = require('../electron/main/documents/editorCore.js');
const { importDocument } = require('../electron/main/documents/import.js');
const { DocumentProjectStore } = require('../electron/main/documents/documentProjectStore.js');
const { getFixture } = require('./fixtures/document-fixtures.js');

const T0 = '2026-01-01T00:00:00.000Z';

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function span(blockId, spanId, text, start = 0, traits = {}) {
  return { spanId, blockId, text, start, end: start + text.length, traits };
}

function archiveFixture() {
  const b0 = {
    blockId: 'b0', kind: 'paragraph', part: 'main', index: 0,
    styleFingerprint: 'fp0', sourceHash: hashText('one alpha two alpha'),
    text: 'one alpha two alpha',
    spans: [span('b0', 'b0-s0', 'one alpha two alpha')],
  };
  const b1 = {
    blockId: 'b1', kind: 'paragraph', part: 'main', index: 1,
    styleFingerprint: 'fp1', sourceHash: hashText('alpha SECRET alpha'),
    text: 'alpha SECRET alpha',
    spans: [span('b1', 'b1-s0', 'alpha '), span('b1', 'b1-s1', 'SECRET', 6), span('b1', 'b1-s2', ' alpha', 12)],
  };
  return {
    projectId: 'd7-fixture',
    blocks: [b0, b1],
    blockPolicies: {},
    spanPolicies: { 'b1-s1': { action: 'protect', note: 'fixture' } },
  };
}

function fakeBinding(initial, { fail = false } = {}) {
  const binding = {
    archive: copy(initial),
    revision: 'source-1',
    targetRevision: 'target-1',
    writes: 0,
    undoSteps: 0,
    state: null,
    selectionGuard(snapshot, expectedHash, expectedTarget, anchor) {
      if (snapshot.textHash !== expectedHash) return { ok: false, reason: 'selection-changed' };
      if (snapshot.sourceRevision !== this.revision) return { ok: false, reason: 'source-revision-moved' };
      if (snapshot.targetRevision !== expectedTarget) return { ok: false, reason: 'target-revision-moved' };
      if (anchor && anchor.blockId !== snapshot.blockId) return { ok: false, reason: 'selection-changed' };
      if (anchor && anchor.charStart !== undefined && anchor.charStart !== snapshot.charStart) return { ok: false, reason: 'selection-changed' };
      return { ok: true };
    },
    applyProgrammaticReplace(targets, textByBlock) {
      this.writes += 1;
      if (fail) throw new Error('injected atomic failure');
      for (const target of targets.slice().sort((a, b) => b.charStart - a.charStart)) {
        const block = this.archive.blocks.find((candidate) => candidate.blockId === target.blockId);
        const replacement = textByBlock[target.blockId];
        block.text = block.text.slice(0, target.charStart) + replacement + block.text.slice(target.charEnd);
        block.sourceHash = hashText(block.text);
      }
      this.undoSteps += 1;
      return { changed: true, archive: this.archive, revision: 'source-2' };
    },
    applyUserTransaction(transaction) {
      this.writes += 1;
      if (fail) throw new Error('injected atomic failure');
      this.state = this.state.apply(transaction);
      this.state.doc.forEach((node) => {
        const block = this.archive.blocks.find((candidate) => candidate.blockId === node.attrs.blockId);
        block.text = node.textContent;
        block.sourceHash = hashText(block.text);
      });
      this.undoSteps += 1;
      return { changed: true, archive: this.archive, revision: 'source-2' };
    },
  };
  binding.state = EditorState.create({ doc: buildSourceDoc(binding.archive), plugins: [history()] });
  return binding;
}

function projectFixture(projectId, doc) {
  return {
    schemaVersion: 3,
    projectId,
    revision: '1',
    type: 'document',
    metadata: { name: 'D7', sourceFileName: 'sample.txt' },
    documentState: { sourceFileName: 'sample.txt', title: doc.title, sourceLang: 'en', targetLang: 'de', translationProvider: 'test' },
    createdAt: T0,
    updatedAt: T0,
    assets: [],
  };
}

function archiveFor(projectId, doc) {
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
  };
}

test('selection snapshot capture is deterministic and carries block fragments/source hashes', () => {
  const document = archiveFixture();
  const options = {
    document,
    operationId: 'op-1', language: 'DE', chunkId: 'c-1',
    fragments: [{ blockId: 'b0', charStart: 4, charEnd: 9 }],
    sourceRevision: 'source-1', targetRevision: 'target-1', createdAt: T0,
  };
  const first = captureSelectionSnapshot(options);
  const second = captureSelectionSnapshot(options);
  assert.deepEqual(first, second);
  assert.equal(first.language, 'de');
  assert.equal(first.blockFragments[0].text, 'alpha');
  assert.equal(first.sourceHashes.b0, hashText(document.blocks[0].text));
});

test('selection snapshot requires operationId through validation, guard, and apply', () => {
  const binding = fakeBinding(archiveFixture());
  const snapshot = captureSelectionSnapshot({
    document: binding.archive,
    operationId: 'typed-op',
    language: 'en',
    blockId: 'b0',
    charStart: 4,
    charEnd: 9,
    sourceRevision: 'source-1',
    targetRevision: 'target-1',
    createdAt: T0,
  });
  assert.equal(validateSelectionSnapshot(snapshot), true);
  const missingOperationId = { ...snapshot };
  delete missingOperationId.operationId;
  assert.equal(validateSelectionSnapshot(missingOperationId), false);
  for (const field of ['language', 'chunkId']) {
    const missing = { ...snapshot };
    delete missing[field];
    assert.equal(validateSelectionSnapshot(missing), false);
    assert.equal(
      applySelectionResponse({ binding, snapshot: missing, expectedTargetRevision: 'target-1', response: { text: 'INVALID' } }).reason,
      'invalid-snapshot',
    );
  }
  assert.equal(
    applySelectionResponse({
      binding,
      snapshot: missingOperationId,
      expectedTargetRevision: 'target-1',
      response: { text: 'INVALID' },
    }).reason,
    'invalid-snapshot',
  );
  assert.equal(binding.writes, 0);
  const applied = applySelectionResponse({
    binding,
    snapshot,
    expectedTargetRevision: 'target-1',
    response: { text: 'VALID' },
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.operationId, 'typed-op');
});

test('both selection validator paths require the complete snapshot shape', () => {
  const archive = archiveFixture();
  const binding = createEditorBinding({
    document: archive,
    revision: 'source-1',
    store: { saveDocumentArchive() { throw new Error('guard test must not commit'); } },
  });
  const snapshot = captureSelectionSnapshot({
    document: archive,
    operationId: 'validator-op',
    language: 'en',
    chunkId: null,
    blockId: 'b0',
    charStart: 4,
    charEnd: 9,
    sourceRevision: 'source-1',
    targetRevision: 'target-1',
    createdAt: T0,
  });
  assert.equal(validateSnapshot(snapshot), true);
  assert.deepEqual(binding.selectionGuard(snapshot, snapshot.textHash, 'target-1'), { ok: true });

  const malformedFragments = copy(snapshot);
  malformedFragments.blockFragments[0].text = 'omega';
  assert.equal(validateSnapshot(malformedFragments), false);
  assert.deepEqual(
    binding.selectionGuard(malformedFragments, snapshot.textHash, 'target-1'),
    { ok: false, reason: 'invalid-snapshot' },
  );

  const malformedHashes = copy(snapshot);
  delete malformedHashes.sourceHashes.b0;
  assert.equal(validateSnapshot(malformedHashes), false);
  assert.deepEqual(
    binding.selectionGuard(malformedHashes, snapshot.textHash, 'target-1'),
    { ok: false, reason: 'invalid-snapshot' },
  );
});

test('stale selection responses deny with zero writes for edited, moved, and revision-mismatched selections', () => {
  const original = archiveFixture();
  const snapshot = captureSelectionSnapshot({
    document: original, operationId: 'op-stale', language: 'en', blockId: 'b0', charStart: 4, charEnd: 9,
    sourceRevision: 'source-1', targetRevision: 'target-1', createdAt: T0,
  });
  const edited = fakeBinding(original);
  edited.archive.blocks[0].text = 'one omega two alpha';
  assert.equal(applySelectionResponse({ binding: edited, snapshot, expectedTargetRevision: 'target-1', response: { text: 'X' } }).reason, 'selection-changed');
  assert.equal(edited.writes, 0);

  // The selected text stays equal, but an unrelated edit changes the touched
  // block's full hash; the documented deny reason is selection-changed.
  const hashMoved = fakeBinding(original);
  hashMoved.archive.blocks[0].text = 'one alpha two BETA';
  assert.equal(
    applySelectionResponse({ binding: hashMoved, snapshot, expectedTargetRevision: 'target-1', response: { text: 'X' } }).reason,
    'selection-changed',
  );
  assert.equal(hashMoved.writes, 0);

  const moved = fakeBinding(original);
  assert.equal(
    applySelectionResponse({
      binding: moved,
      snapshot,
      expectedTargetRevision: 'target-1',
      expectedAnchor: { blockId: 'b0', charStart: 0, charEnd: 5 },
      response: { text: 'X' },
    }).reason,
    'selection-changed',
  );
  assert.equal(moved.writes, 0);

  const revision = fakeBinding(original);
  revision.revision = 'source-2';
  assert.equal(applySelectionResponse({ binding: revision, snapshot, expectedTargetRevision: 'target-1', response: { text: 'X' } }).reason, 'source-revision-moved');
  assert.equal(revision.writes, 0);

  const target = fakeBinding(original);
  assert.equal(applySelectionResponse({ binding: target, snapshot, expectedTargetRevision: 'target-2', response: { text: 'X' } }).reason, 'target-revision-moved');
  assert.equal(target.writes, 0);
});

test('accepted selection response returns exact range and one atomic operation', () => {
  const binding = fakeBinding(archiveFixture());
  const snapshot = captureSelectionSnapshot({
    document: binding.archive, operationId: 'op-ok', language: 'en', blockId: 'b0', charStart: 4, charEnd: 9,
    sourceRevision: 'source-1', targetRevision: 'target-1', createdAt: T0,
  });
  const result = applySelectionResponse({ binding, snapshot, expectedTargetRevision: 'target-1', response: { text: 'BETA' } });
  assert.equal(result.applied, true);
  assert.deepEqual(result.changedRange, { blockId: 'b0', charStart: 4, charEnd: 8 });
  assert.deepEqual(result.rangeDetails[0], {
    blockId: 'b0', charStart: 4, charEnd: 8, originalCharStart: 4, originalCharEnd: 9, oldLength: 5, newLength: 4,
  });
  assert.equal(binding.writes, 1);
  assert.equal(binding.undoSteps, 1);
  assert.equal(binding.archive.blocks[0].text, 'one BETA two alpha');
  assert.equal(binding.archive.blocks[0].spans[0].spanId, 'b0-s0');
});

test('replace preview counts allowed matches and never returns protected spans', () => {
  const archive = archiveFixture();
  const matches = scanMatches(archive, 'alpha');
  assert.deepEqual(matches.map(({ blockId, charStart }) => [blockId, charStart]), [['b0', 4], ['b0', 14], ['b1', 0], ['b1', 13]]);
  const preview = previewReplaceAll({ archive, query: 'alpha', replacement: 'A' });
  assert.equal(preview.count, 4);
  assert.equal(archive.blocks[1].text, 'alpha SECRET alpha');
});

test('find/replace covers case, word, regex, overlap, protected-edge, and empty branches', () => {
  const blocks = [{ blockId: 'matcher', text: 'Alpha alpha alphabet _alpha alpha2 alpha' }];
  assert.deepEqual(
    scanMatches(blocks, 'alpha', { caseSensitive: false }).map(({ charStart }) => charStart),
    [0, 6, 12, 22, 28, 35],
  );
  assert.deepEqual(
    scanMatches(blocks, 'alpha', { caseSensitive: true }).map(({ charStart }) => charStart),
    [6, 12, 22, 28, 35],
  );
  assert.deepEqual(
    scanMatches(blocks, 'alpha', { caseSensitive: false, wholeWord: true }).map(({ charStart }) => charStart),
    [0, 6, 35],
  );

  const regexArchive = {
    blocks: [{ blockId: 'regex', text: 'item-42 item-7' }],
    spanPolicies: {},
    blockPolicies: {},
  };
  const regexPreview = previewReplaceAll({
    archive: regexArchive,
    query: '(item)-(\\d+)',
    replacement: '$1:$2 [$&]',
    options: { regex: true },
  });
  assert.equal(regexPreview.count, 2);
  assert.deepEqual(regexPreview.matches.map((match) => match.replacement), ['item:42 [item-42]', 'item:7 [item-7]']);

  const overlap = scanMatches([{ blockId: 'overlap', text: 'aaaa' }], 'aaa');
  assert.deepEqual(overlap.map(({ charStart, charEnd }) => [charStart, charEnd]), [[0, 3]]);

  const protectedEdgeArchive = {
    blocks: [{
      blockId: 'edge',
      text: 'alphaalpha',
      spans: [span('edge', 'edge-protected', 'alpha', 0)],
    }],
    spanPolicies: { 'edge-protected': { action: 'protect' } },
    blockPolicies: {},
  };
  const edgeMatches = scanMatches(protectedEdgeArchive, 'alpha');
  assert.deepEqual(edgeMatches.map(({ charStart, charEnd }) => [charStart, charEnd]), [[5, 10]]);
  assert.equal(previewReplaceAll({ archive: protectedEdgeArchive, query: 'alpha', replacement: 'A' }).count, 1);

  const emptyBinding = fakeBinding(archiveFixture());
  const emptyResult = replaceAll({ binding: emptyBinding, query: 'alpha', replacement: '' });
  assert.equal(emptyResult.count, 4);
  assert.deepEqual(emptyBinding.archive.blocks.map((block) => block.text), ['one  two ', ' SECRET ']);
});

test('successful replaceAll keeps protected text unchanged while replacing allowed matches', () => {
  const binding = fakeBinding(archiveFixture());
  const result = replaceAll({ binding, query: 'alpha', replacement: 'A' });
  assert.equal(result.count, 4);
  assert.equal(binding.writes, 1);
  assert.equal(binding.archive.blocks[0].text, 'one A two A');
  assert.equal(binding.archive.blocks[1].text, 'A SECRET A');
});

test('replaceAll is one transaction and an injected failure leaves zero partial writes', () => {
  const original = archiveFixture();
  const binding = fakeBinding(original, { fail: true });
  const initialPmText = binding.state.doc.textContent;
  assert.throws(() => replaceAll({ binding, query: 'alpha', replacement: 'A' }), /injected atomic failure/);
  assert.equal(binding.writes, 1);
  assert.deepEqual(binding.archive.blocks.map((block) => block.text), ['one alpha two alpha', 'alpha SECRET alpha']);
  assert.equal(binding.state.doc.textContent, initialPmText);
});

test('replaceAll keeps real PM state unchanged when archive persistence throws', async () => {
  const fixture = getFixture('txt');
  const doc = await importDocument({ buffer: fixture.buffer, fileName: fixture.fileName, assetRef: fixture.assetRef });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vscript-d7-rollback-'));
  const store = new DocumentProjectStore({ baseDir: root });
  const projectId = 'd7-rollback';
  const created = store.createDocumentProject(projectProject(projectId, doc), archiveFor(projectId, doc));
  const throwingStore = new Proxy(store, {
    get(target, property) {
      if (property === 'saveDocumentArchive') {
        return () => { throw new Error('injected archive failure'); };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const binding = createEditorBinding({ document: created.archive, store: throwingStore, revision: created.project.revision });
  const initialPmText = binding.state.doc.textContent;
  const initialArchiveText = binding.archive.blocks.map((block) => block.text);
  assert.throws(() => replaceAll({ binding, query: 'Hello', replacement: 'REPLACED' }), /injected archive failure/);
  assert.equal(binding.state.doc.textContent, initialPmText);
  assert.deepEqual(binding.archive.blocks.map((block) => block.text), initialArchiveText);
  assert.deepEqual(store.loadDocumentArchive(projectId).blocks.map((block) => block.text), initialArchiveText);
});

test('proofread alignment and highlights consume mixed D6 freshness/status rows', () => {
  const document = archiveFixture();
  const translation = {
    language: 'de',
    blocks: {
      b0: { blockId: 'b0', text: 'eins alpha zwei alpha', sourceHash: hashText(document.blocks[0].text), status: 'approved' },
      b1: { blockId: 'b1', text: 'alpha GEHEIM alpha', sourceHash: 'stale-hash', status: 'needs-review' },
    },
  };
  const plan = { chunks: [{ chunkId: 'c-1', slices: [{ blockId: 'b0', charStart: 0, charEnd: 19, tokenEstimate: 5 }, { blockId: 'b1', charStart: 0, charEnd: 18, tokenEstimate: 5 }] }] };
  const freshness = { blocks: { b0: { freshness: 'fresh', status: 'approved' }, b1: { freshness: 'stale', status: 'needs-review' } } };
  const alignment = projectProofreadAlignment({ document, translation, plan, freshness });
  assert.equal(alignment.length, 2);
  assert.deepEqual(alignment.map((row) => [row.blockId, row.freshness, row.status]), [['b0', 'fresh', 'approved'], ['b1', 'stale', 'needs-review']]);
  const highlights = computeHighlightRanges(alignment, { blockId: 'b1', charStart: 0, charEnd: 5, side: 'source' });
  assert.equal(highlights.length, 1);
  assert.deepEqual(highlights[0].range, { start: 0, end: 5 });
  assert.deepEqual(highlights[0].counterpartRange, { start: 0, end: 5 });
});

test('proofread highlights proportionally project partial selections across split slices', () => {
  const sourceText = 'abcdefghijABCDEFGHIJ';
  const targetText = '1234567890123456789012345678901234567890';
  const document = {
    blocks: [{ blockId: 'split', text: sourceText }],
  };
  const alignment = projectProofreadAlignment({
    document,
    translation: {
      language: 'de',
      blocks: { split: { blockId: 'split', text: targetText, sourceHash: hashText(sourceText), status: 'approved' } },
    },
    plan: {
      chunks: [
        { chunkId: 'left', slices: [{ blockId: 'split', charStart: 0, charEnd: 10 }] },
        { chunkId: 'right', slices: [{ blockId: 'split', charStart: 10, charEnd: 20 }] },
      ],
    },
    freshness: { blocks: { split: { freshness: 'fresh', status: 'approved' } } },
  });
  const highlights = computeHighlightRanges(alignment, { blockId: 'split', charStart: 5, charEnd: 15, side: 'source' });
  assert.deepEqual(
    highlights.map(({ range, counterpartRange }) => ({ range, counterpartRange })),
    [
      { range: { start: 5, end: 10 }, counterpartRange: { start: 10, end: 20 } },
      { range: { start: 10, end: 15 }, counterpartRange: { start: 20, end: 30 } },
    ],
  );
});

test('source refresh merge report identifies stale and realigned language entries', () => {
  const oldSource = 'A source sentence.';
  const newSource = 'A revised source sentence.';
  const oldHash = hashText(oldSource);
  const newHash = hashText(newSource);
  const report = sourceRefreshMergeReport({
    blockId: 'b0', oldSource, newSource,
    translations: [
      { language: 'de', blocks: { b0: { sourceHash: oldHash, status: 'draft' } } },
      { language: 'fr', blocks: { b0: { sourceHash: newHash, status: 'approved' } } },

      { language: 'es', blocks: { b0: { sourceHash: 'other', status: 'needs-review' } } },
    ],
  });
  assert.deepEqual(report.staleLanguages, ['de']);
  assert.deepEqual(report.realignedLanguages, ['fr']);
  assert.equal(report.translations.find((row) => row.language === 'es').after, 'stale');
  assert.equal(report.unchangedRanges[0].oldStart, 0);
});

test('proofread alignment retains missing translations with empty counterparts and null sentence tails', () => {
  const sourceText = 'Missing source sentence.';
  const document = { blocks: [{ blockId: 'missing', text: sourceText }] };
  const alignment = projectProofreadAlignment({
    document,
    translation: { language: 'de', blocks: {} },
    freshness: { blocks: {} },
  });
  assert.equal(alignment.length, 1);
  assert.equal(alignment[0].status, 'missing');
  assert.equal(alignment[0].freshness, null);
  assert.deepEqual(alignment[0].targetRange, { start: 0, end: 0 });
  assert.equal(alignment[0].targetText, '');
  assert.equal(alignment[0].sentences.length, 1);
  assert.equal(alignment[0].sentences[0].targetRange, null);
  assert.equal(alignment[0].sentences[0].targetText, '');

  const highlights = computeHighlightRanges(alignment, {
    blockId: 'missing',
    charStart: 0,
    charEnd: 7,
    side: 'source',
  });
  assert.equal(highlights.length, 1);
  assert.deepEqual(highlights[0].counterpartRange, { start: 0, end: 0 });
  assert.deepEqual(
    computeHighlightRanges(
      [{ blockId: 'missing', sourceRange: { start: 0, end: 7 }, targetRange: null }],
      { blockId: 'missing', charStart: 0, charEnd: 7, side: 'source' },
    ),
    [],
  );

  assert.deepEqual(
    alignSentences('Source sentence. Untranslated tail.', 'Target sentence.').map((row) => row.targetRange),
    [{ start: 0, end: 16 }, null],
  );
});

test('real createEditorBinding + D2 store applies selection once and undo restores it', async () => {
  const fixture = getFixture('txt');
  const doc = await importDocument({ buffer: fixture.buffer, fileName: fixture.fileName, assetRef: fixture.assetRef });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vscript-d7-'));
  const store = new DocumentProjectStore({ baseDir: root });
  const projectId = 'd7-real';
  const created = store.createDocumentProject(projectProject(projectId, doc), archiveFor(projectId, doc));
  const calls = [];
  const recordingStore = new Proxy(store, {
    get(target, property) {
      if (property === 'saveDocumentArchive') return (...args) => { calls.push(args); return target.saveDocumentArchive(...args); };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const binding = createEditorBinding({ document: created.archive, store: recordingStore, revision: created.project.revision });
  const block = binding.archive.blocks[0];
  const snapshot = captureSelectionSnapshot({
    document: binding.archive, operationId: 'real-op', language: 'de', blockId: block.blockId, charStart: 0, charEnd: 5,
    sourceRevision: binding.revision, targetRevision: 'target-1', createdAt: T0,
  });
  const result = applySelectionResponse({ binding, snapshot, expectedTargetRevision: 'target-1', response: { text: 'HELLO' } });
  assert.equal(result.applied, true);
  // R3: the guarded operation's ID survives the D5 transaction commit audit.
  assert.equal(result.audit.operationId, snapshot.operationId);
  assert.equal(calls.length, 1);
  assert.equal(store.loadDocumentArchive(projectId).blocks[0].text.slice(0, 5), 'HELLO');
  assert.equal(store.loadDocumentArchive(projectId).blocks[0].spans[0].spanId, block.spans[0].spanId);
  const undone = binding.undo();
  assert.equal(undone.changed, true);
  assert.equal(store.loadDocumentArchive(projectId).blocks[0].text.slice(0, 5), block.text.slice(0, 5));
});

function projectProject(projectId, doc) {
  return projectFixture(projectId, doc);
}
