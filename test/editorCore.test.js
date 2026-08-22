'use strict';

// DOC-05 — Editor core tests (plan §10.7/§10.8): the DocumentState↔ProseMirror
// binding in electron/main/documents/editorCore.js.
//
// Everything here runs headlessly under node:test against the REAL importer
// (a hand-built all-kinds DOCX fixture imported end-to-end) and the REAL
// DocumentProjectStore rooted in a throwaway tmpdir. A recording proxy wraps
// the real store so tests can observe the exact commit calls the binding
// makes without replacing persistence with a fake.
//
//   - load-time projection fidelity for every D1 block kind + inline marks;
//   - the SINGLE-MUTATION commit discipline: every accepted transaction —
//     typing, policy flips, structural splits, programmatic replaces —
//     persists as ONE validated candidate archive through ONE atomic
//     wholesale save (content, fingerprints, and policy deltas folded in);
//   - stale-transaction rejection and mid-commit failure injection with
//     zero-write assertions on every rejected path;
//   - selection-only transactions burn nothing;
//   - identity-only mutations: authorized span retiles persist a matching
//     candidate, foreign/moved identity and structural-attr drift reject
//     typed before any store interaction;
//   - structural edits (tr.split) remint duplicated ids and preserve
//     trusted protection on minted spans;
//   - programmatic replace is ONE undo step (library closeHistory), also
//     when adjacent to typing; empty replacement deletes;
//   - the mandatory paste boundary: payloads, foreign stamped fragments,
//     and raw transactions all sanitize + remint with destination context;
//   - §10.8 selectionGuard precedence, structural anchors, fail-closed
//     revision checks;
//   - editor invariant #4 (source edits flip freshness, never delete);
//   - log safety (no console call sites; no manuscript text emitted).
//   - undo at history bottom is a no-op; stale CAS conflicts propagate
//     CONFLICT and leave the binding untouched;
//   - §10.8 selectionGuard precedence and fail-closed revision checks;
//   - paste-fragment identity minting;
//   - editor invariant #4 (source edits flip freshness, never delete);
//   - log safety (no console call sites; no manuscript text emitted).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { makeZip, getFixture } = require('./fixtures/document-fixtures.js');
const { importDocument } = require('../electron/main/documents/import.js');
const { DocumentProjectStore } = require('../electron/main/documents/documentProjectStore.js');
const {
  SELECTION_SNAPSHOT_KIND,
  loadDocumentIntoEditor,
  createEditorBinding,
  selectionTextHash,
  preparePasteFragment,
} = require('../electron/main/documents/editorCore.js');
const {
  EDITOR_SCHEMA,
  SPAN_MARK,
  buildSourceDoc,
  spanMarkOf,
  styleFingerprintFor,
  traitsOfMarks,
} = require('../electron/main/documents/editorSchema.js');
const {
  clipboardPayload,
  fragmentFromPayload,
  payloadIsPrivateIdFree,
} = require('../electron/main/documents/editorClipboard.js');
const { BLOCK_KINDS } = require('../shared/contracts/documents.ts');
const { AppError } = require('../shared/contracts/errors.ts');
const { Fragment } = require('prosemirror-model');
const { TextSelection } = require('prosemirror-state');

// --- Shared fixtures and helpers ----------------------------------------------

let rootDir;
let store;

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vscript-editorcore-'));
}

const T0 = '2026-01-01T00:00:00.000Z';

function ensureStore() {
  if (!store) {
    rootDir = tmpRoot();
    store = new DocumentProjectStore({ baseDir: rootDir });
  }
  return store;
}

/** ProjectV3 payload for createDocumentProject (mirrors the DOC-02 tests). */
function documentProject(projectId, overrides = {}) {
  return {
    schemaVersion: 3,
    projectId,
    revision: '1',
    type: 'document',
    metadata: { name: 'Doc Project', sourceFileName: 'all-kinds.docx' },
    documentState: {
      sourceFileName: 'all-kinds.docx',
      title: 'Intro Heading',
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

/** DocumentArchive v1 wrapper around a normalized import. */
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

/**
 * One hand-built DOCX covering ALL nine D1 block kinds plus inline marks —
 * imported through the real importer so the editor is exercised against
 * genuine normalized output, not a synthetic archive.
 */
function buildAllKindsDocx() {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const para = (style, runsXml) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${runsXml}</w:p>`;
  const run = (text, rPr) =>
    `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
  const body =
    para('Heading1', run('Intro Heading')) +
    para('Quote', run('A quoted block.')) +
    para('ListParagraph', run('First list item')) +
    para('Verse', run('Verse line one')) +
    '<w:p></w:p>' +
    '<w:tbl>' +
    '<w:tr><w:tc><w:p>' + run('Col1') + '</w:p></w:tc><w:tc><w:p>' + run('Col2') + '</w:p></w:tc></w:tr>' +
    '<w:tr><w:tc><w:p>' + run('alpha') + '</w:p></w:tc><w:tc><w:p>' + run('beta') + '</w:p></w:tc></w:tr>' +
    '</w:tbl>' +
    para(null, run('Plain with ', null) + run('bold italic', '<w:b/><w:i/>') + run(' tail.', null)) +
    para('Heading2', run('Section two'));
  const documentXml = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<w:document ${W}><w:body>${body}</w:body></w:document>`,
    'utf8',
  );
  return makeZip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>', 'utf8') },
    { name: 'word/document.xml', data: documentXml },
  ]);
}

let allKindsDocPromise = null;
/** Memoized real import of the all-kinds fixture (same bytes every call). */
function allKindsDoc() {
  if (!allKindsDocPromise) {
    allKindsDocPromise = importDocument({
      buffer: buildAllKindsDocx(),
      fileName: 'all-kinds.docx',
      assetRef: 'asset://all-kinds.docx',
    });
  }
  return allKindsDocPromise;
}

/** Create a real store project from the all-kinds import; returns the archive. */
async function createAllKindsProject(projectId) {
  const doc = await allKindsDoc();
  const real = ensureStore();
  const created = real.createDocumentProject(documentProject(projectId), archiveFor(projectId, doc));
  return { doc, ...created };
}

/**
 * Wrap the REAL store in a recording proxy: every commit-path call is
 * forwarded unchanged and jotted down with its exact arguments, so tests can
 * assert on the binding's commit choreography without faking persistence.
 */
const RECORDED_METHODS = ['updateBlockText', 'setSpanPolicy', 'saveDocumentArchive'];
function recordingStore(realStore) {
  const calls = [];
  const wrapped = new Proxy(realStore, {
    get(target, prop) {
      if (RECORDED_METHODS.includes(prop)) {
        return (...args) => {
          calls.push({ method: prop, args });
          return target[prop](...args);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { store: wrapped, calls, callsOf: (method) => calls.filter((c) => c.method === method) };
}

/** Proxy a real store with one deterministic failure at the atomic save seam. */
function injectedSaveFailureStore(realStore, failure) {
  const calls = [];
  const wrapped = new Proxy(realStore, {
    get(target, prop) {
      if (prop === 'saveDocumentArchive') {
        return (...args) => {
          calls.push({ method: prop, args });
          throw failure;
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { store: wrapped, calls };
}

/** Absolute PM position occupied by a block node itself (before its content). */
function blockNodePos(doc, blockId) {
  return blockStart(doc, blockId) - 1;
}

/** Assert the canonical archive on disk and PM projection are byte-for-byte equivalent in shape. */
function assertPersistedProjection(binding, projectId, label = 'projection') {
  const persisted = ensureStore().loadDocumentArchive(projectId);
  assert.deepEqual(binding.doc.toJSON(), buildSourceDoc(persisted).toJSON(), label);
  assert.equal(binding.revision, readDiskRevision(projectId), `${label}: revision chain`);
  return persisted;
}

function readDiskRevision(projectId) {
  return JSON.parse(
    fs.readFileSync(path.join(ensureStore().baseDirPath(), projectId, 'project.json'), 'utf8'),
  ).revision;
}

/** Absolute PM position of a block's inline content start. */
function blockStart(doc, blockId) {
  let pos = 1; // first block's content begins at position 1
  for (let i = 0; i < doc.childCount; i++) {
    const block = doc.child(i);
    if (block.attrs.blockId === blockId) return pos;
    pos += block.nodeSize;
  }
  throw new Error(`block "${blockId}" is not in the projection`);
}

/** Comparable [spanId, text, start, end, traits] projection of a span list. */
function spanTuples(spans) {
  return spans.map(({ spanId, text, start, end, traits }) => ({ spanId, text, start, end, traits }));
}

// --- 1. Load-time projection fidelity ------------------------------------------

test('loadDocumentIntoEditor projects every D1 block kind with verbatim identity', async () => {
  const { doc } = await createAllKindsProject('roundtrip-project');

  // Shared projection check: node kinds/attrs carry the persisted identity
  // verbatim, spans project 1:1 onto stamped text nodes, text is exact.
  const assertRoundTrip = (archive) => {
    const pm = loadDocumentIntoEditor(archive);
    assert.equal(pm.type.name, 'doc');
    assert.equal(pm.childCount, archive.blocks.length);
    archive.blocks.forEach((block, i) => {
      const node = pm.child(i);
      assert.equal(node.type.name, block.kind, `kind of block #${i}`);
      assert.equal(node.attrs.blockId, block.blockId, `blockId of block #${i}`);
      assert.equal(node.attrs.part, block.part);
      assert.equal(node.attrs.index, block.index);
      assert.equal(node.attrs.level ?? null, block.level ?? null);
      assert.equal(node.attrs.page ?? null, block.page ?? null);
      assert.equal(node.attrs.styleFingerprint, block.styleFingerprint);
      assert.equal(node.textContent, block.text);

      // Spans project 1:1 onto stamped text nodes; the span mark carries the
      // verbatim spanId plus the resolved default policy.
      const textNodes = [];
      node.forEach((child) => {
        if (child.isText) textNodes.push(child);
      });
      assert.equal(textNodes.length, block.spans.length, `span count of block ${block.blockId}`);
      block.spans.forEach((span, j) => {
        const textNode = textNodes[j];
        assert.equal(textNode.text, span.text);
        const mark = spanMarkOf(textNode.marks);
        assert.ok(mark, `span mark present in ${block.blockId}/${span.spanId}`);
        assert.equal(mark.attrs.spanId, span.spanId);
        assert.equal(mark.attrs.policy, 'translate');
        assert.equal(mark.attrs.note, null);
        assert.deepEqual(traitsOfMarks(textNode.marks), span.traits);
      });
    });
    return pm;
  };

  // Import 1 — the all-kinds DOCX: eight of the nine kinds plus bold/italic
  // inline marks on its mixed paragraph.
  const archive1 = archiveFor('roundtrip-project', doc);
  assert.deepEqual(
    new Set(doc.blocks.map((b) => b.kind)),
    new Set(BLOCK_KINDS.filter((k) => k !== 'other')),
  );
  const pm = assertRoundTrip(archive1);
  const mixedIndex = doc.blocks.findIndex((b) => b.text === 'Plain with bold italic tail.');
  assert.ok(mixedIndex >= 0, 'mixed paragraph present');
  assert.deepEqual(traitsOfMarks(pm.child(mixedIndex).child(1).marks), { bold: true, italic: true });

  // Import 2 — the checked-in MD golden fixture contributes the remaining
  // `other` kind (its fenced code block). Together: every D1 kind projected.
  const mdDoc = await importDocument(getFixture('md'));
  assert.ok(mdDoc.blocks.some((b) => b.kind === 'other'), 'MD fixture carries the other kind');
  assertRoundTrip(archiveFor('roundtrip-project', mdDoc));
  assert.deepEqual(
    new Set([...doc.blocks, ...mdDoc.blocks].map((b) => b.kind)),
    new Set(BLOCK_KINDS),
  );
});
// --- 8a. Load/binding input preconditions --------------------------------------

test('loadDocumentIntoEditor and createEditorBinding fail loud on malformed input', async () => {
  const minimal = { projectId: 'p', blocks: [{ blockId: 'b0', kind: 'paragraph', spans: [] }] };
  assert.throws(() => loadDocumentIntoEditor(null), TypeError);
  assert.throws(() => loadDocumentIntoEditor('nope'), TypeError);
  assert.throws(() => loadDocumentIntoEditor({ projectId: 'p' }), TypeError); // blocks missing
  assert.throws(
    () => loadDocumentIntoEditor({ blocks: [{ blockId: 'b0', kind: 'paragraph', spans: [] }] }),
    TypeError,
  ); // projectId missing
  assert.throws(
    () => loadDocumentIntoEditor({ projectId: 'p', blocks: [{ kind: 'paragraph', spans: [] }] }),
    TypeError,
  ); // blockId missing
  assert.throws(
    () => loadDocumentIntoEditor({ projectId: 'p', blocks: [{ blockId: 'b0', kind: 'stanza', spans: [] }] }),
    TypeError,
  ); // unknown kind
  assert.throws(
    () => loadDocumentIntoEditor({
      projectId: 'p',
      blocks: [{ blockId: 'b0', kind: 'tblock', spans: [{ spanId: 's0', blockId: 'b0', text: 'x', start: 0, end: 1, traits: {} }] }],
    }),
    TypeError,
    'translation-only tblock is not an editor BLOCK_KINDS projection',
  );
  assert.throws(
    () => loadDocumentIntoEditor({ projectId: 'p', blocks: [{ blockId: 'b0', kind: 'paragraph' }] }),
    TypeError,
  ); // spans missing
  // Zero blocks cannot project: the schema's typed error, never a silent empty doc.
  assert.throws(
    () => loadDocumentIntoEditor({ projectId: 'p', blocks: [] }),
    (err) => err instanceof AppError && err.code === 'VALIDATION_FAILED',
  );

  const real = ensureStore();
  assert.throws(() => createEditorBinding({ document: minimal, store: {}, revision: '1' }), TypeError);
  assert.throws(() => createEditorBinding({ document: minimal, store: { updateBlockText: () => {} } }), TypeError);
  assert.throws(
    () => createEditorBinding({ document: minimal, store: real, revision: 5 }),
    TypeError,
  ); // revision must be a string when provided
  // A valid minimal binding constructs and exposes the projection.
  const binding = createEditorBinding({ document: minimal, store: real, revision: '1' });
  assert.equal(binding.doc.childCount, 1);
  assert.equal(binding.revision, '1');
  assert.equal(binding.archive, minimal);
});

// --- 2. User typing commits -----------------------------------------------------

test('applyUserTransaction commits typed text per block with exact tiling', async () => {
  const { archive } = await createAllKindsProject('typing-project');
  const rec = recordingStore(ensureStore());
  const revision0 = readDiskRevision('typing-project');
  const binding = createEditorBinding({ document: archive, store: rec.store, revision: revision0 });

  // Type "XX" six characters into the mixed paragraph's first plain span.
  const P = 'b8';
  const pos = blockStart(binding.doc, P) + 6;
  const result = binding.applyUserTransaction(binding.state.tr.insertText('XX', pos));

  assert.equal(result.changed, true);
  const saves = rec.callsOf('saveDocumentArchive');
  assert.equal(saves.length, 1, 'exactly one wholesale save for one changed block');
  assert.equal(rec.calls.length, 1, 'the atomic transaction has one store write');
  const [pid, payload, expectedRevision] = saves[0].args;
  assert.equal(pid, 'typing-project');
  assert.equal(expectedRevision, revision0, 'commit CASes against the observed revision');
  const editedPayload = payload.blocks.find((b) => b.blockId === P);
  assert.deepEqual(
    spanTuples(editedPayload.spans),
    spanTuples([
      { spanId: 'b8-s0', text: 'Plain XXwith ', start: 0, end: 13, traits: {} },
      { spanId: 'b8-s1', text: 'bold italic', start: 13, end: 24, traits: { bold: true, italic: true } },
      { spanId: 'b8-s2', text: ' tail.', start: 24, end: 30, traits: {} },
    ]),
  );
  // Spans reaching the store are contract-normalized (policy metadata is
  // resolved into the projection marks, never shipped as span fields).
  for (const s of editedPayload.spans) {
    assert.deepEqual(Object.keys(s).sort(), ['blockId', 'end', 'spanId', 'start', 'text', 'traits']);
  }

  // Revision chain: store result feeds the binding and lands on disk.
  const persisted = ensureStore().loadDocumentArchive('typing-project');
  const diskRevision = readDiskRevision('typing-project');
  assert.equal(result.revision, diskRevision);
  assert.equal(binding.revision, diskRevision);

  // Persisted archive matches the projection exactly (invariant #1).
  assert.deepEqual(binding.doc.toJSON(), buildSourceDoc(persisted).toJSON());

  // First-edit-wins baseline captured as imported; epoch advanced once.
  const edited = persisted.blocks.find((b) => b.blockId === P);
  assert.deepEqual(spanTuples(edited.spans), spanTuples(editedPayload.spans));
  assert.equal(persisted.editBaselines[P].text, 'Plain with bold italic tail.');
  assert.equal(persisted.editEpoch, 1);
});

// --- 2b. Atomic failure injection -----------------------------------------------

test('CAS, disk, and validation failures leave disk, binding, and projection unchanged', async () => {
  const failures = [
    ['cas', new AppError('CONFLICT', 'injected CAS failure')],
    ['disk', new Error('injected disk failure')],
    ['validation', new AppError('VALIDATION_FAILED', 'injected validation failure')],
  ];

  for (const [kind, failure] of failures) {
    const pid = `atomic-failure-${kind}`;
    const { archive } = await createAllKindsProject(pid);
    const beforeDisk = structuredClone(ensureStore().loadDocumentArchive(pid));
    const beforeRevision = readDiskRevision(pid);
    const injected = injectedSaveFailureStore(ensureStore(), failure);
    const binding = createEditorBinding({
      document: archive,
      store: injected.store,
      revision: beforeRevision,
    });
    const beforeDoc = binding.doc.toJSON();

    assert.throws(
      () => binding.applyUserTransaction(binding.state.tr.insertText('FAIL', blockStart(binding.doc, 'b8') + 1)),
      (err) => err === failure,
      `${kind} failure propagates from the atomic save seam`,
    );
    assert.equal(injected.calls.length, 1, `${kind}: one candidate-save attempt`);
    assert.equal(binding.revision, beforeRevision, `${kind}: binding revision unchanged`);
    assert.equal(binding.archive, archive, `${kind}: canonical archive reference unchanged`);
    assert.deepEqual(binding.doc.toJSON(), beforeDoc, `${kind}: projection unchanged`);
    assert.deepEqual(
      ensureStore().loadDocumentArchive(pid),
      beforeDisk,
      `${kind}: no partial archive write`,
    );
    assert.equal(readDiskRevision(pid), beforeRevision, `${kind}: no revision burn`);
  }
});

// --- 3. Selection-only transactions ---------------------------------------------

test('selection-only transactions change nothing and burn no revision', async () => {
  const { archive } = await createAllKindsProject('selection-project');
  const rec = recordingStore(ensureStore());
  const revision0 = readDiskRevision('selection-project');
  const binding = createEditorBinding({ document: archive, store: rec.store, revision: revision0 });

  const docBefore = binding.doc.toJSON();
  const pos = blockStart(binding.doc, 'b2') + 3;
  const tr = binding.state.tr.setSelection(TextSelection.create(binding.state.doc, pos));
  const result = binding.applyUserTransaction(tr);

  assert.equal(result.changed, false);
  assert.deepEqual(result.archive, archive);
  assert.equal(result.revision, revision0);
  assert.equal(binding.revision, revision0);
  assert.equal(rec.calls.length, 0, 'no store writes for a selection-only dispatch');
  assert.equal(readDiskRevision('selection-project'), revision0);
  assert.deepEqual(binding.doc.toJSON(), docBefore, 'projection unchanged');
});

// --- 4. Span policy flips --------------------------------------------------------

test('a projection policy flip persists through one atomic archive save', async () => {
  const { archive } = await createAllKindsProject('policy-project');
  const rec = recordingStore(ensureStore());
  const revision0 = readDiskRevision('policy-project');
  const binding = createEditorBinding({ document: archive, store: rec.store, revision: revision0 });

  // Flip the quote's whole single span to protect-with-note via its mark.
  const from = blockStart(binding.doc, 'b1');
  const to = from + 'A quoted block.'.length;
  const spanMarkType = EDITOR_SCHEMA.marks[SPAN_MARK];
  const tr = binding.state.tr;
  tr.removeMark(from, to, spanMarkType);
  tr.addMark(from, to, spanMarkType.create({ spanId: 'b1-s0', policy: 'protect', note: 'proper noun' }));
  const result = binding.applyUserTransaction(tr);

  assert.equal(result.changed, true);
  const saves = rec.callsOf('saveDocumentArchive');
  assert.equal(saves.length, 1, 'policy delta folds into one archive save');
  assert.equal(rec.callsOf('setSpanPolicy').length, 0, 'legacy policy cascade is gone');
  assert.equal(rec.callsOf('updateBlockText').length, 0, 'content untouched');
  assert.equal(saves[0].args[2], revision0);
  assert.deepEqual(saves[0].args[1].spanPolicies['b1-s0'], { action: 'protect', note: 'proper noun' });

  // Policy writes are metadata: revision advances once, epoch never moves.
  const persisted = ensureStore().loadDocumentArchive('policy-project');
  assert.equal(result.revision, readDiskRevision('policy-project'));
  assert.notEqual(result.revision, revision0, 'the policy write advanced the lease');
  assert.deepEqual(persisted.spanPolicies['b1-s0'], { action: 'protect', note: 'proper noun' });
  assert.equal(persisted.editEpoch, 0);

  // The projection now resolves the effective policy through the span mark.
  assert.deepEqual(binding.doc.toJSON(), buildSourceDoc(persisted).toJSON());
});

// --- 5. Structural edits commit wholesale ---------------------------------------

test('tr.split commits wholesale, remints duplicated ids, and advances the epoch', async () => {
  const { archive } = await createAllKindsProject('split-project');
  const rec = recordingStore(ensureStore());
  const revision0 = readDiskRevision('split-project');
  const binding = createEditorBinding({ document: archive, store: rec.store, revision: revision0 });
  const originalIds = new Set(archive.blocks.map((b) => b.blockId));

  // Split the quote "A qu|oted block." — tr.split copies attrs, so both
  // halves momentarily carry blockId "b1" and span mark b1-s0.
  const from = blockStart(binding.doc, 'b1') + 4;
  const result = binding.applyUserTransaction(binding.state.tr.split(from));

  assert.equal(result.changed, true);
  const saves = rec.callsOf('saveDocumentArchive');
  assert.equal(saves.length, 1, 'structural change goes through ONE wholesale save');
  assert.equal(rec.callsOf('updateBlockText').length, 0);
  assert.equal(rec.callsOf('setSpanPolicy').length, 0);
  assert.equal(saves[0].args[2], revision0, 'wholesale save CASes against the observed revision');

  const persisted = ensureStore().loadDocumentArchive('split-project');
  assert.equal(persisted.blocks.length, archive.blocks.length + 1);
  const ids = persisted.blocks.map((b) => b.blockId);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate blockIds survive');

  // First half keeps the original identity; the copy gets a freshly minted,
  // collision-free id and its own span identity.
  const head = persisted.blocks.find((b) => b.blockId === 'b1');
  assert.deepEqual(
    head.spans.map((s) => s.text),
    ['A qu'],
  );
  assert.equal(head.spans[0].spanId, 'b1-s0', 'first occurrence keeps the trusted span');
  const tail = persisted.blocks.find((b) => b.text === 'oted block.');
  assert.ok(tail, 'split tail exists');
  assert.ok(!originalIds.has(tail.blockId), 'tail id freshly minted');
  assert.match(tail.blockId, /^b\d+$/, 'minted id follows the importer scheme');
  assert.equal(tail.kind, 'quote', 'split copies the node type');
  assert.deepEqual(
    tail.spans.map((s) => [s.spanId, s.text, s.traits]),
    [[`${tail.blockId}-s0`, 'oted block.', {}]],
    'duplicate-stamped text reminted under the new block',
  );

  // Wholesale save: one lease bump, epoch advanced exactly once, and the
  // projection matches what landed on disk.
  assert.notEqual(readDiskRevision('split-project'), revision0);
  assert.equal(result.revision, readDiskRevision('split-project'));
  assert.equal(persisted.editEpoch, 1);
  assert.deepEqual(binding.doc.toJSON(), buildSourceDoc(persisted).toJSON());

  // Undo maps back over the identity-sync step: the split reverts wholesale
  // to the exact pre-split archive, and the projection follows.
  const undoSplit = binding.undo();
  assert.equal(undoSplit.changed, true);
  const restored = ensureStore().loadDocumentArchive('split-project');
  assert.equal(restored.blocks.length, archive.blocks.length);
  assert.ok(
    restored.blocks.some((b) => b.blockId === 'b1' && b.text === 'A quoted block.'),
    'quote restored whole under its original identity',
  );
  assert.ok(!restored.blocks.some((b) => b.text === 'oted block.'), 'minted tail gone');
  assert.deepEqual(binding.doc.toJSON(), buildSourceDoc(restored).toJSON());
});

// --- 6. Programmatic replace is ONE atomic undo step -----------------------------

test('multi-block applyProgrammaticReplace undoes as one step and isolates typing', async () => {
  const { archive } = await createAllKindsProject('replace-project');
  const rec = recordingStore(ensureStore());
  const binding = createEditorBinding({
    document: archive,
    store: rec.store,
    revision: readDiskRevision('replace-project'),
  });

  // (a) One call replaces two blocks; each whole-block target (no char range)
  // swaps the entire text while inheriting the block's leading span identity.
  const replaced = binding.applyProgrammaticReplace(
    [{ blockId: 'b0' }, { blockId: 'b1' }],
    { b0: 'AI HEADING', b1: 'AI QUOTE' },
    { origin: 'ai-replace' },
  );
  assert.equal(replaced.changed, true);
  let persisted = ensureStore().loadDocumentArchive('replace-project');
  assert.deepEqual(
    persisted.blocks.slice(0, 2).map((b) => [b.text, b.spans.map((s) => s.spanId)]),
    [
      ['AI HEADING', ['b0-s0']],
      ['AI QUOTE', ['b1-s0']],
    ],
  );
  assert.equal(replaced.revision, readDiskRevision('replace-project'));

  // ONE undo reverts BOTH blocks together (atomic step, invariant #5).
  const undone = binding.undo();
  assert.equal(undone.changed, true);
  persisted = ensureStore().loadDocumentArchive('replace-project');
  assert.deepEqual(
    persisted.blocks.slice(0, 2).map((b) => b.text),
    ['Intro Heading', 'A quoted block.'],
  );

  // (b) closeHistory isolation: typing right before the operation needs its
  // own undo — the programmatic step can never glue onto the typing group.
  const typePos = blockStart(binding.doc, 'b9') + 'Section two'.length;
  binding.applyUserTransaction(binding.state.tr.insertText(' (typed)', typePos));
  binding.applyProgrammaticReplace(
    [{ blockId: 'b0' }],
    { b0: 'SECOND AI PASS' },
    { origin: 'ai-replace' },
  );
  persisted = ensureStore().loadDocumentArchive('replace-project');
  assert.equal(persisted.blocks.find((b) => b.blockId === 'b0').text, 'SECOND AI PASS');
  assert.equal(persisted.blocks.find((b) => b.blockId === 'b9').text, 'Section two (typed)');

  const undoOp = binding.undo();
  assert.equal(undoOp.changed, true);
  persisted = ensureStore().loadDocumentArchive('replace-project');
  assert.equal(persisted.blocks.find((b) => b.blockId === 'b0').text, 'Intro Heading', 'undo reverts only the replace');
  assert.equal(persisted.blocks.find((b) => b.blockId === 'b9').text, 'Section two (typed)', 'typing survives the operation undo');

  const undoTyping = binding.undo();
  assert.equal(undoTyping.changed, true);
  persisted = ensureStore().loadDocumentArchive('replace-project');
  assert.equal(persisted.blocks.find((b) => b.blockId === 'b9').text, 'Section two', 'second undo reverts the typing');
  assert.deepEqual(binding.doc.toJSON(), buildSourceDoc(persisted).toJSON());

  // (c) A partial range carries only the range replacement text and inherits
  // the marks (span identity + traits) at the range start.
  binding.applyProgrammaticReplace(
    [{ blockId: 'b8', charStart: 12, charEnd: 16 }],
    { b8: 'ZZ' },
    { origin: 'retranslate' },
  );
  persisted = ensureStore().loadDocumentArchive('replace-project');
  const mixed = persisted.blocks.find((b) => b.blockId === 'b8');
  assert.equal(mixed.text, 'Plain with bZZitalic tail.');
  assert.deepEqual(
    spanTuples(mixed.spans),
    spanTuples([
      { spanId: 'b8-s0', text: 'Plain with ', start: 0, end: 11, traits: {} },
      { spanId: 'b8-s1', text: 'bZZitalic', start: 11, end: 20, traits: { bold: true, italic: true } },
      { spanId: 'b8-s2', text: ' tail.', start: 20, end: 26, traits: {} },
    ]),
  );

  // The reserved 'retranslate' origin is accepted alongside 'ai-replace'
  // (exercised above); every commit chained the store's returned revision.
  assert.equal(binding.revision, readDiskRevision('replace-project'));
});

test('closeHistory keeps an adjacent same-block programmatic operation out of typing undo', async () => {
  const pid = 'adjacent-history-project';
  const { archive } = await createAllKindsProject(pid);
  const binding = createEditorBinding({
    document: archive,
    store: ensureStore(),
    revision: readDiskRevision(pid),
  });
  const original = archive.blocks.find((b) => b.blockId === 'b8').text;
  const typePos = blockStart(binding.doc, 'b8') + original.length;
  binding.applyUserTransaction(binding.state.tr.insertText(' typed', typePos));
  const afterTyping = `${original} typed`;

  binding.applyProgrammaticReplace(
    [{ blockId: 'b8', charStart: original.length, charEnd: afterTyping.length }],
    { b8: 'PROGRAMMATIC' },
    { origin: 'ai-replace' },
  );
  assert.equal(
    ensureStore().loadDocumentArchive(pid).blocks.find((b) => b.blockId === 'b8').text,
    `${original}PROGRAMMATIC`,
  );

  const undoOperation = binding.undo();
  assert.equal(undoOperation.changed, true);
  assert.equal(
    ensureStore().loadDocumentArchive(pid).blocks.find((b) => b.blockId === 'b8').text,
    afterTyping,
    'first undo is the programmatic operation only',
  );
  const undoTyping = binding.undo();
  assert.equal(undoTyping.changed, true);
  assert.equal(
    ensureStore().loadDocumentArchive(pid).blocks.find((b) => b.blockId === 'b8').text,
    original,
    'second undo reverts adjacent typing',
  );
  assertPersistedProjection(binding, pid, 'adjacent closeHistory');
});

test('empty whole-block and partial replacements delete content and undo cleanly', async () => {
  const pid = 'empty-replacement-project';
  const { archive } = await createAllKindsProject(pid);
  const real = ensureStore();
  let revision = readDiskRevision(pid);
  real.addLanguage(pid, 'de', { provider: 'probe', sourceHash: archive.sourceAsset.hash }, revision);
  revision = readDiskRevision(pid);
  real.saveTranslations(pid, 'de', [{ blockId: 'b0', text: 'translated heading' }], revision);
  revision = readDiskRevision(pid);
  const binding = createEditorBinding({
    document: real.loadDocumentArchive(pid),
    store: real,
    revision,
  });
  const originalHeading = archive.blocks.find((b) => b.blockId === 'b0').text;

  const emptied = binding.applyProgrammaticReplace(
    [{ blockId: 'b0' }],
    { b0: '' },
    { origin: 'retranslate' },
  );
  assert.equal(emptied.changed, true);
  let persisted = ensureStore().loadDocumentArchive(pid);
  const emptyHeading = persisted.blocks.find((b) => b.blockId === 'b0');
  assert.equal(emptyHeading.text, '');
  assert.deepEqual(emptyHeading.spans, []);
  assert.equal(persisted.editEpoch, 1);
  assertPersistedProjection(binding, pid, 'whole-block empty replacement');
  let freshness = ensureStore().freshness(pid, 'de');
  assert.equal(freshness.blocks.b0.freshness, 'stale', 'empty source text makes translation stale');
  assert.equal(freshness.translated, 1, 'empty source edit does not delete translation');
  assert.equal(
    ensureStore().getTranslationArchive(pid, 'de').blocks.b0.text,
    'translated heading',
  );

  const undoWhole = binding.undo();
  assert.equal(undoWhole.changed, true);
  persisted = ensureStore().loadDocumentArchive(pid);
  assert.equal(persisted.blocks.find((b) => b.blockId === 'b0').text, originalHeading);
  freshness = ensureStore().freshness(pid, 'de');
  assert.equal(freshness.blocks.b0.freshness, 'fresh', 'undo restores source freshness');
  assertPersistedProjection(binding, pid, 'whole-block empty undo');

  const partial = binding.applyProgrammaticReplace(
    [{ blockId: 'b8', charStart: 11, charEnd: 22 }],
    { b8: '' },
    { origin: 'ai-replace' },
  );
  assert.equal(partial.changed, true);
  persisted = ensureStore().loadDocumentArchive(pid);
  assert.equal(
    persisted.blocks.find((b) => b.blockId === 'b8').text,
    'Plain with  tail.',
    'empty partial replacement deletes exactly the selected range',
  );
  assertPersistedProjection(binding, pid, 'partial empty replacement');

  const undoPartial = binding.undo();
  assert.equal(undoPartial.changed, true);
  assert.equal(
    ensureStore().loadDocumentArchive(pid).blocks.find((b) => b.blockId === 'b8').text,
    'Plain with bold italic tail.',
  );
  assertPersistedProjection(binding, pid, 'partial empty undo');
});

// --- 7. Undo at history bottom ----------------------------------------------------

test('undo at the history bottom is a no-op that touches nothing', async () => {
  const { archive } = await createAllKindsProject('undobottom-project');
  const rec = recordingStore(ensureStore());
  const revision0 = readDiskRevision('undobottom-project');
  const binding = createEditorBinding({ document: archive, store: rec.store, revision: revision0 });

  const result = binding.undo();
  assert.equal(result.changed, false);
  assert.equal(result.archive, archive);
  assert.equal(result.revision, revision0);
  assert.equal(rec.calls.length, 0, 'no store writes when there is nothing to undo');
  assert.equal(readDiskRevision('undobottom-project'), revision0);
});

// --- 9. Stale CAS conflicts --------------------------------------------------------

test('a stale revision propagates CONFLICT and leaves the binding untouched', async () => {
  const pid = 'conflict-project';
  const { archive } = await createAllKindsProject(pid);
  const rec = recordingStore(ensureStore());
  const revision0 = readDiskRevision(pid);
  const binding = createEditorBinding({ document: archive, store: rec.store, revision: revision0 });

  // An external writer moves the lease behind the binding's back.
  ensureStore().setBlockPolicy(pid, 'b0', { action: 'protect' }, revision0);
  const moved = readDiskRevision(pid);
  assert.notEqual(moved, revision0);

  const docBefore = binding.doc.toJSON();
  const pos = blockStart(binding.doc, 'b8') + 2;
  assert.throws(
    () => binding.applyUserTransaction(binding.state.tr.insertText('X', pos)),
    (err) => err instanceof AppError && err.code === 'CONFLICT',
  );

  // Store-first discipline: the failed commit advanced nothing.
  assert.equal(binding.revision, revision0, 'binding revision unmoved');
  assert.equal(binding.archive, archive, 'canonical archive reference untouched');
  assert.deepEqual(binding.doc.toJSON(), docBefore, 'projection untouched');
  assert.equal(rec.callsOf('saveDocumentArchive').length, 1, 'the rejected CAS reached the one atomic store call');
  assert.equal(rec.callsOf('updateBlockText').length, 0, 'legacy cascade did not run');
  assert.equal(rec.callsOf('setSpanPolicy').length, 0, 'legacy cascade did not run');
  const onDisk = ensureStore().loadDocumentArchive(pid);
  assert.equal(onDisk.blocks.find((b) => b.blockId === 'b8').text, 'Plain with bold italic tail.');

  // Recovery path: reload from the store and retry with the fresh revision.
  const rebound = createEditorBinding({
    document: ensureStore().loadDocumentArchive(pid),
    store: rec.store,
    revision: moved,
  });
  const retry = rebound.applyUserTransaction(rebound.state.tr.insertText('X', blockStart(rebound.doc, 'b8') + 2));
  assert.equal(retry.changed, true);
  assert.equal(retry.revision, readDiskRevision(pid));
});

test('a transaction retained across a commit is rejected before any store interaction', async () => {
  const pid = 'stale-transaction-project';
  const { archive } = await createAllKindsProject(pid);
  const rec = recordingStore(ensureStore());
  const revision0 = readDiskRevision(pid);
  const binding = createEditorBinding({ document: archive, store: rec.store, revision: revision0 });
  const pos = blockStart(binding.doc, 'b8') + 2;
  const retained = binding.state.tr.insertText('first', pos);

  const first = binding.applyUserTransaction(retained);
  assert.equal(first.changed, true);
  const callsAfterFirst = rec.calls.length;
  const beforeSecondDoc = binding.doc.toJSON();
  const beforeSecondArchive = binding.archive;
  const beforeSecondRevision = binding.revision;
  const beforeSecondDisk = structuredClone(ensureStore().loadDocumentArchive(pid));

  assert.throws(
    () => binding.applyUserTransaction(retained),
    (err) => err instanceof AppError && err.code === 'CONFLICT',
  );
  assert.equal(rec.calls.length, callsAfterFirst, 'stale tr.before is rejected before saveDocumentArchive');
  assert.equal(binding.archive, beforeSecondArchive, 'canonical archive reference unchanged');
  assert.equal(binding.revision, beforeSecondRevision, 'revision unchanged');
  assert.deepEqual(binding.doc.toJSON(), beforeSecondDoc, 'projection unchanged');
  assert.deepEqual(ensureStore().loadDocumentArchive(pid), beforeSecondDisk, 'disk unchanged');
});

// --- 10. §10.8 selection guard ----------------------------------------------------

test('selectionGuard denies in contract precedence and fails closed', async () => {
  const pid = 'guard-project';
  await createAllKindsProject(pid);
  const real = ensureStore();
  const revision = readDiskRevision(pid);
  const binding = createEditorBinding({
    document: real.loadDocumentArchive(pid),
    store: real,
    revision,
  });

  const snapshot = {
    kind: SELECTION_SNAPSHOT_KIND,
    operationId: 'op-1',
    language: 'de',
    blockId: 'b0',
    textHash: selectionTextHash('Intro Heading'),
    textLength: 13,
    sourceRevision: revision,
    targetRevision: 'trg-1',
    createdAt: '2026-08-22T00:00:00.000Z',
    chunkId: null,
  };
  assert.deepEqual(binding.selectionGuard(snapshot, snapshot.textHash, 'trg-1'), { ok: true });

  // 1) A malformed snapshot denies typed — even with everything else wrong too.
  assert.deepEqual(
    binding.selectionGuard({ ...snapshot, kind: 'nope' }, 'wrong-hash', 'wrong-trg'),
    { ok: false, reason: 'invalid-snapshot' },
  );
  // A matching hash is not enough when identical text was selected in a
  // different block: the structural anchor must identify the same block.
  assert.deepEqual(
    binding.selectionGuard(snapshot, snapshot.textHash, 'trg-1', { blockId: 'b1' }),
    { ok: false, reason: 'selection-changed' },
  );
  const anchored = {
    ...snapshot,
    charStart: 0,
    charEnd: snapshot.textLength,
  };
  assert.deepEqual(
    binding.selectionGuard(
      anchored,
      anchored.textHash,
      'trg-1',
      { blockId: 'b0', charStart: 1, charEnd: 14 },
    ),
    { ok: false, reason: 'selection-changed' },
    'moved range denies even when text hash is unchanged',
  );
  assert.deepEqual(
    binding.selectionGuard(
      anchored,
      anchored.textHash,
      'trg-1',
      { blockId: 'b0', charStart: 0, charEnd: snapshot.textLength },
    ),
    { ok: true },
  );


  // 2) Selection hash moved beats a moved target revision.
  assert.deepEqual(
    binding.selectionGuard({ ...snapshot, textHash: selectionTextHash('edited') }, snapshot.textHash, 'wrong-trg'),
    { ok: false, reason: 'selection-changed' },
  );

  // 3) Source revision moved (stale capture) — before the target check.
  assert.deepEqual(
    binding.selectionGuard({ ...snapshot, sourceRevision: 'ancient' }, snapshot.textHash, 'wrong-trg'),
    { ok: false, reason: 'source-revision-moved' },
  );

  // 3b) Fail-closed: a binding with NO observed revision can never apply.
  const blind = createEditorBinding({ document: real.loadDocumentArchive(pid), store: real });
  assert.equal(blind.revision, null);
  assert.deepEqual(blind.selectionGuard(snapshot, snapshot.textHash, 'trg-1'), {
    ok: false,
    reason: 'source-revision-moved',
  });

  // 4) Only the translation-side revision may still move.
  assert.deepEqual(binding.selectionGuard(snapshot, snapshot.textHash, 'trg-2'), {
    ok: false,
    reason: 'target-revision-moved',
  });

  // Caller-side expectations are programmer input: non-strings fail loud.
  assert.throws(() => binding.selectionGuard(snapshot, 123, 'trg-1'), TypeError);
  assert.throws(() => binding.selectionGuard(snapshot, snapshot.textHash, undefined), TypeError);
});

// --- 11. Paste identity minting ---------------------------------------------------

test('clipboard sanitization always remints foreign identity and preserves text nodes', () => {
  const bold = EDITOR_SCHEMA.marks.bold.create();
  const fragment = Fragment.fromArray([
    EDITOR_SCHEMA.nodes.paragraph.create(null, EDITOR_SCHEMA.text('pasted bold', [bold])),
    EDITOR_SCHEMA.nodes.paragraph.create(null, EDITOR_SCHEMA.text('second para')),
  ]);

  const out = preparePasteFragment(fragment);
  assert.ok(out instanceof Fragment);
  assert.equal(out.childCount, 2);

  // Minted ids follow the importer scheme, are unique per block, and every
  // text run carries a translate-policy span mark; traits survive.
  const seen = new Set();
  out.forEach((block) => {
    assert.match(block.attrs.blockId, /^b\d+$/);
    assert.ok(!seen.has(block.attrs.blockId), `unique blockId ${block.attrs.blockId}`);
    seen.add(block.attrs.blockId);
    block.forEach((child) => {
      if (!child.isText) return;
      const mark = spanMarkOf(child.marks);
      assert.ok(mark, 'minted span mark present');
      assert.equal(mark.attrs.spanId, `${block.attrs.blockId}-s0`);
      assert.equal(mark.attrs.policy, 'translate');
    });
  });
  assert.deepEqual(traitsOfMarks(out.child(0).child(0).marks), { bold: true });
  assert.equal(out.child(0).textContent, 'pasted bold');

  // A foreign fully stamped fragment is sanitized, not accepted as an
  // identity fast path: private attrs/marks are absent from the payload and
  // the rebuilt fragment, then trusted ids are newly minted.
  const spanMark = EDITOR_SCHEMA.marks[SPAN_MARK].create({
    spanId: 'x1-s0',
    policy: 'protect',
    note: 'private note',
  });
  const stamped = Fragment.fromArray([
    EDITOR_SCHEMA.nodes.paragraph.create(
      { blockId: 'x1', part: 'main', index: 99, styleFingerprint: 'private-fp' },
      EDITOR_SCHEMA.text('already stamped', [spanMark]),
    ),
  ]);
  const payload = clipboardPayload(stamped);
  assert.equal(payload.text, 'already stamped');
  assert.ok(payloadIsPrivateIdFree(payload), 'clipboard payload contains no private ids or policy');
  assert.doesNotMatch(JSON.stringify(payload), /x1|x1-s0|private note|private-fp/);
  const clean = fragmentFromPayload(payload);
  assert.equal(clean.child(0).attrs.blockId, '');
  assert.equal(clean.child(0).textContent, 'already stamped');
  assert.equal(spanMarkOf(clean.child(0).child(0).marks), null);
  const reminted = preparePasteFragment(stamped);
  assert.notEqual(reminted, stamped, 'foreign stamped fragment is rebuilt');
  assert.notEqual(reminted.child(0).attrs.blockId, 'x1');
  assert.notEqual(spanMarkOf(reminted.child(0).child(0).marks).attrs.spanId, 'x1-s0');
  assert.equal(reminted.child(0).textContent, 'already stamped');
  assert.equal(spanMarkOf(reminted.child(0).child(0).marks).attrs.policy, 'translate');

  // Bare text nodes are valid clipboard input and must retain their text.
  const textOnly = EDITOR_SCHEMA.text('bare text', [bold]);
  const textPayload = clipboardPayload(textOnly);
  assert.equal(textPayload.text, 'bare text');
  assert.ok(payloadIsPrivateIdFree(textPayload));
  const textFragment = fragmentFromPayload(textPayload);
  assert.equal(textFragment.child(0).textContent, 'bare text');
  assert.deepEqual(traitsOfMarks(textFragment.child(0).child(0).marks), { bold: true });

  // Garbage fails loud.
  assert.throws(() => preparePasteFragment(null), TypeError);
  assert.throws(() => preparePasteFragment('text'), TypeError);
  assert.throws(() => preparePasteFragment([]), TypeError);
});

test('applyPaste sanitizes raw fragments and uses destination policy for minted spans', async () => {
  const pid = 'paste-boundary-project';
  const { archive } = await createAllKindsProject(pid);
  const real = ensureStore();
  let revision = readDiskRevision(pid);
  real.setBlockPolicy(pid, 'b8', { action: 'protect', note: 'destination' }, revision);
  revision = readDiskRevision(pid);
  const binding = createEditorBinding({
    document: real.loadDocumentArchive(pid),
    store: real,
    revision,
  });

  const foreignSpan = EDITOR_SCHEMA.marks[SPAN_MARK].create({
    spanId: 'foreign-s99',
    policy: 'translate',
    note: 'foreign',
  });
  const foreign = Fragment.fromArray([
    EDITOR_SCHEMA.nodes.paragraph.create(
      { blockId: 'foreign-block', part: 'main', index: 99, styleFingerprint: 'foreign' },
      EDITOR_SCHEMA.text(' PASTED', [foreignSpan]),
    ),
  ]);
  const b8Node = binding.doc.child(
    Array.from({ length: binding.doc.childCount }, (_, i) => i).find(
      (i) => binding.doc.child(i).attrs.blockId === 'b8',
    ),
  );
  const at = blockStart(binding.doc, 'b8') + b8Node.textContent.length;
  const pasted = binding.applyPaste(foreign, at);
  assert.equal(pasted.changed, true);
  let persisted = assertPersistedProjection(binding, pid, 'raw applyPaste');
  const pastedBlock = persisted.blocks.find((b) => b.blockId === 'b8');
  assert.match(pastedBlock.text, /PASTED/);
  assert.ok(
    pastedBlock.spans.every((span) => span.spanId !== 'foreign-s99'),
    'foreign span identity never reaches the archive',
  );
  let pastedNode;
  binding.doc.forEach((block) => {
    if (block.attrs.blockId !== 'b8') return;
    block.forEach((child) => {
      if (child.isText && child.text.includes('PASTED')) pastedNode = child;
    });
  });
  assert.ok(pastedNode, 'pasted text remains a text node');
  assert.equal(spanMarkOf(pastedNode.marks).attrs.policy, 'protect');
  assert.equal(spanMarkOf(pastedNode.marks).attrs.note, 'destination');

  // A bare text node follows the same real paste boundary and retains all text.
  const bare = EDITOR_SCHEMA.text(' bare', [EDITOR_SCHEMA.marks.bold.create()]);
  const secondAt = blockStart(binding.doc, 'b8') + binding.doc.child(
    Array.from({ length: binding.doc.childCount }, (_, i) => i).find(
      (i) => binding.doc.child(i).attrs.blockId === 'b8',
    ),
  ).textContent.length;
  binding.applyPaste(bare, secondAt);
  persisted = assertPersistedProjection(binding, pid, 'bare-text applyPaste');
  assert.match(persisted.blocks.find((b) => b.blockId === 'b8').text, /PASTED bare$/);
});

test('identity-only mutations canonicalize trusted retiles while structural attrs reject typed', async () => {
  const identityPid = 'identity-only-project';
  const { archive: identityArchive } = await createAllKindsProject(identityPid);
  const identityRec = recordingStore(ensureStore());
  const identityBinding = createEditorBinding({
    document: identityArchive,
    store: identityRec.store,
    revision: readDiskRevision(identityPid),
  });
  const spanMarkType = EDITOR_SCHEMA.marks[SPAN_MARK];
  const spanFrom = blockStart(identityBinding.doc, 'b8') + 11;
  const spanTo = spanFrom + 'bold italic'.length;
  const identityTr = identityBinding.state.tr;
  identityTr.removeMark(spanFrom, spanTo, spanMarkType);
  identityTr.addMark(
    spanFrom,
    spanTo,
    spanMarkType.create({ spanId: 'foreign-span', policy: 'translate', note: null }),
  );
  const identityBeforeText = identityBinding.doc.child(
    Array.from({ length: identityBinding.doc.childCount }, (_, i) => i).find(
      (i) => identityBinding.doc.child(i).attrs.blockId === 'b8',
    ),
  ).textContent;
  const identityResult = identityBinding.applyUserTransaction(identityTr);
  assert.equal(identityResult.changed, true, 'authorized minting-shaped identity drift is persisted');
  assert.equal(identityRec.callsOf('saveDocumentArchive').length, 1);
  assert.equal(identityRec.callsOf('updateBlockText').length, 0);
  const identityPersisted = assertPersistedProjection(identityBinding, identityPid, 'identity-only retile');
  const identityBlock = identityPersisted.blocks.find((b) => b.blockId === 'b8');
  assert.equal(identityBlock.text, identityBeforeText, 'identity-only mutation did not alter content');
  assert.ok(identityBlock.spans.every((span) => span.spanId !== 'foreign-span'));
  assert.equal(identityPersisted.editEpoch, 1, 'identity-only retile advances canonical epoch');

  const attrsPid = 'attrs-only-project';
  const { archive: attrsArchive } = await createAllKindsProject(attrsPid);
  const attrsRec = recordingStore(ensureStore());
  const attrsBinding = createEditorBinding({
    document: attrsArchive,
    store: attrsRec.store,
    revision: readDiskRevision(attrsPid),
  });
  const attrsBeforeDoc = attrsBinding.doc.toJSON();
  const attrsBeforeArchive = structuredClone(ensureStore().loadDocumentArchive(attrsPid));
  const nodePos = blockNodePos(attrsBinding.doc, 'b8');
  const attrsNode = attrsBinding.doc.nodeAt(nodePos);
  const attrsTr = attrsBinding.state.tr.setNodeMarkup(
    nodePos,
    null,
    { ...attrsNode.attrs, page: 99 },
  );
  assert.throws(
    () => attrsBinding.applyUserTransaction(attrsTr),
    (err) => err instanceof AppError && err.code === 'VALIDATION_FAILED',
    'structural attr drift is a typed rejection',
  );
  assert.equal(attrsRec.calls.length, 0, 'attrs-only rejection occurs before the store');

  assert.equal(attrsBinding.revision, readDiskRevision(attrsPid));
  assert.deepEqual(attrsBinding.doc.toJSON(), attrsBeforeDoc);
  assert.deepEqual(ensureStore().loadDocumentArchive(attrsPid), attrsBeforeArchive);
});
test('every accepted editor transaction leaves persisted archive equal to projection', async () => {
  const pid = 'projection-equality-project';
  const { archive } = await createAllKindsProject(pid);
  const binding = createEditorBinding({
    document: archive,
    store: ensureStore(),
    revision: readDiskRevision(pid),
  });

  binding.applyUserTransaction(
    binding.state.tr.insertText('!', blockStart(binding.doc, 'b8') + 'Plain with bold italic tail.'.length),
  );
  assertPersistedProjection(binding, pid, 'typing equality');

  const policyFrom = blockStart(binding.doc, 'b1');
  const policyTo = policyFrom + 'A quoted block.'.length;
  const policyTr = binding.state.tr;
  policyTr.removeMark(policyFrom, policyTo, EDITOR_SCHEMA.marks[SPAN_MARK]);
  policyTr.addMark(
    policyFrom,
    policyTo,
    EDITOR_SCHEMA.marks[SPAN_MARK].create({ spanId: 'b1-s0', policy: 'protect', note: 'equality' }),
  );
  binding.applyUserTransaction(policyTr);
  assertPersistedProjection(binding, pid, 'policy equality');

  binding.applyUserTransaction(binding.state.tr.split(blockStart(binding.doc, 'b2') + 5));
  assertPersistedProjection(binding, pid, 'split equality');

  binding.applyProgrammaticReplace(
    [{ blockId: 'b0' }],
    { b0: 'EQUALITY REPLACE' },
    { origin: 'ai-replace' },
  );
  assertPersistedProjection(binding, pid, 'programmatic equality');

  const paste = Fragment.fromArray([
    EDITOR_SCHEMA.nodes.paragraph.create(null, EDITOR_SCHEMA.text(' paste')),
  ]);
  const b9Index = Array.from({ length: binding.doc.childCount }, (_, i) => i).find(
    (i) => binding.doc.child(i).attrs.blockId === 'b9',
  );
  const b9End = blockStart(binding.doc, 'b9') + binding.doc.child(b9Index).textContent.length;
  binding.applyPaste(paste, b9End);
  assertPersistedProjection(binding, pid, 'paste equality');

  assert.equal(binding.undo().changed, true);
  assertPersistedProjection(binding, pid, 'paste undo equality');
  assert.equal(binding.undo().changed, true);
  assertPersistedProjection(binding, pid, 'programmatic undo equality');
  assert.equal(binding.undo().changed, true);
  assertPersistedProjection(binding, pid, 'split undo equality');
});

test('protected split preserves effective protection on minted duplicate spans', async () => {
  const pid = 'protected-split-project';
  await createAllKindsProject(pid);
  const real = ensureStore();
  let revision = readDiskRevision(pid);
  real.setBlockPolicy(pid, 'b1', { action: 'protect', note: 'trusted quote' }, revision);
  revision = readDiskRevision(pid);
  const binding = createEditorBinding({
    document: real.loadDocumentArchive(pid),
    store: real,
    revision,
  });
  const result = binding.applyUserTransaction(
    binding.state.tr.split(blockStart(binding.doc, 'b1') + 4),
  );
  assert.equal(result.changed, true);
  const persisted = assertPersistedProjection(binding, pid, 'protected split');
  const tail = persisted.blocks.find((b) => b.text === 'oted block.');
  assert.ok(tail, 'protected split tail exists');
  assert.deepEqual(persisted.blockPolicies.b1, { action: 'protect', note: 'trusted quote' });
  assert.deepEqual(persisted.spanPolicies[tail.spans[0].spanId], {
    action: 'protect',
    note: 'trusted quote',
  });
  let observedTailMark;
  binding.doc.forEach((block) => {
    if (block.attrs.blockId !== tail.blockId) return;
    block.forEach((child) => {
      if (child.isText) observedTailMark = spanMarkOf(child.marks);
    });
  });
  assert.equal(observedTailMark.attrs.policy, 'protect');
  assert.equal(observedTailMark.attrs.note, 'trusted quote');
});

// --- 12. Invariant #4 — source edits flip freshness, never delete ------------------

test('a source edit flips translations stale without deleting them', async () => {
  const pid = 'freshness-project';
  const txtDoc = await importDocument(getFixture('txt'));
  const created = ensureStore().createDocumentProject(
    documentProject(pid, {
      metadata: { name: 'Freshness', sourceFileName: 'sample.txt' },
      documentState: {
        sourceFileName: 'sample.txt',
        title: txtDoc.title,
        sourceLang: 'en',
        targetLang: 'de',
        translationProvider: 'llama',
      },
    }),
    archiveFor(pid, txtDoc),
  );
  let revision = readDiskRevision(pid);

  ensureStore().addLanguage(pid, 'de', { provider: 'probe', sourceHash: txtDoc.sourceAsset.hash }, revision);
  revision = readDiskRevision(pid);
  ensureStore().saveTranslations(pid, 'de', [{ blockId: 'b0', text: 'Hallo Welt!' }], revision);

  const before = ensureStore().freshness(pid, 'de');
  assert.equal(before.blocks.b0.freshness, 'fresh');
  assert.equal(before.blocks.b1.freshness, 'missing');
  assert.equal(before.stale, 0);

  // The user edits block b0 through the editor binding (bound to the state
  // as it stands AFTER the language/translation setup writes).
  const rec = recordingStore(ensureStore());
  const binding = createEditorBinding({
    document: ensureStore().loadDocumentArchive(pid),
    store: rec.store,
    revision: readDiskRevision(pid),
  });
  const endOfB0 = blockStart(binding.doc, 'b0') + 'Hello world.'.length;
  const result = binding.applyUserTransaction(binding.state.tr.insertText(' Again', endOfB0));
  assert.equal(result.changed, true);

  // The edit flipped b0's translation stale; the entry itself survived.
  const after = ensureStore().freshness(pid, 'de');
  assert.equal(after.blocks.b0.freshness, 'stale');
  assert.equal(after.stale, 1);
  assert.equal(after.translated, 1);
  const deArchive = ensureStore().getTranslationArchive(pid, 'de');
  assert.equal(deArchive.blocks.b0.text, 'Hallo Welt!', 'translation not deleted');
  assert.equal(deArchive.blocks.b0.status, 'draft');
  // And the persisted archive carries the edited source text.
  assert.equal(ensureStore().loadDocumentArchive(pid).blocks.find((b) => b.blockId === 'b0').text, 'Hello world. Again');
});

// --- 13. Log safety ----------------------------------------------------------------

test('the editor core never logs, and emits no manuscript content at runtime', async () => {
  // Static: no console call sites anywhere in the module.
  const moduleSrc = fs.readFileSync(
    require.resolve('../electron/main/documents/editorCore.js'),
    'utf8',
  );
  assert.doesNotMatch(moduleSrc, /console\s*\.\s*(log|info|warn|error|debug|trace|dir|dirxml|table)\s*\(/);

  // Runtime: wrap every console emitter, run a full editing session including
  // error paths, and verify nothing reaches the console at all.
  const pid = 'logsafety-project';
  await createAllKindsProject(pid);
  const real = ensureStore();
  const revision = readDiskRevision(pid);
  const captured = [];
  const originals = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    originals[level] = console[level];
    console[level] = (...args) => captured.push(args.map(String).join(' '));
  }
  try {
    const binding = createEditorBinding({ document: real.loadDocumentArchive(pid), store: real, revision });
    binding.applyUserTransaction(binding.state.tr.insertText('X', blockStart(binding.doc, 'b8') + 1));
    binding.applyProgrammaticReplace([{ blockId: 'b0' }], { b0: 'REPLACED HEADING TEXT' }, { origin: 'ai-replace' });
    binding.undo();
    try {
      binding.applyProgrammaticReplace([{ blockId: 'ghost-block' }], {}, { origin: 'ai-replace' });
    } catch { /* precondition TypeError expected */ }
    try {
      binding.applyUserTransaction(binding.state.tr.insertText('Y', blockStart(binding.doc, 'b8') + 1));
    } catch { /* stale CAS expected after undo rewrote nothing? no-op undo keeps revision valid */ }
    binding.selectionGuard(
      { kind: 'bad' },
      selectionTextHash('Intro Heading'),
      'trg-1',
    );
    preparePasteFragment(Fragment.fromArray([
      EDITOR_SCHEMA.nodes.paragraph.create(null, EDITOR_SCHEMA.text('paste me')),
    ]));
    selectionTextHash('SELECTION PAYLOAD TEXT');
  } finally {
    for (const [level, fn] of Object.entries(originals)) console[level] = fn;
  }

  assert.equal(captured.length, 0, 'console stayed silent for the whole session');
  // Belt over suspenders: even if something had logged, no manuscript text
  // may ever appear in emitted output.
  for (const secret of [
    'Plain with bold italic tail.',
    'REPLACED HEADING TEXT',
    'Intro Heading',
    'SELECTION PAYLOAD TEXT',
    'paste me',
  ]) {
    assert.ok(
      !captured.some((line) => line.includes(secret)),
      `manuscript text leaked to console: ${secret}`,
    );
  }
});

// --- 8b. applyProgrammaticReplace input preconditions -----------------------------

test('applyProgrammaticReplace rejects malformed programmer input before any write', async () => {
  const pid = 'preconditions-project';
  const { archive } = await createAllKindsProject(pid);
  const rec = recordingStore(ensureStore());
  const revision0 = readDiskRevision(pid);
  const binding = createEditorBinding({ document: archive, store: rec.store, revision: revision0 });

  const okTargets = [{ blockId: 'b0' }];
  const throws = (targets, textByBlock, meta) =>
    assert.throws(
      () => binding.applyProgrammaticReplace(targets, textByBlock, meta),
      TypeError,
    );

  throws([], { b0: 'x' }, { origin: 'ai-replace' }); // empty targets
  throws([{ blockId: 'ghost' }], { ghost: 'x' }, { origin: 'ai-replace' }); // unknown blockId
  throws([null], {}, { origin: 'ai-replace' }); // target not an object
  throws([{ blockId: '' }], {}, { origin: 'ai-replace' }); // empty blockId
  throws(okTargets, {}, { origin: 'ai-replace' }); // missing textByBlock entry
  throws(okTargets, { b0: 'x', extra: 'y' }, { origin: 'ai-replace' }); // unmatched key
  throws(okTargets, { b0: 42 }, { origin: 'ai-replace' }); // non-string replacement
  throws(okTargets, { b0: 'x' }, {}); // missing origin
  throws(okTargets, { b0: 'x' }, { origin: 'user' }); // user is not programmatic
  throws(okTargets, { b0: 'x' }, { origin: 'nonsense' }); // unknown origin
  throws([{ blockId: 'b0', charStart: -1 }], { b0: 'x' }, { origin: 'ai-replace' });
  throws(
    [{ blockId: 'b0', charStart: 0, charEnd: 'Intro Heading'.length + 1 }],
    { b0: 'x' },
    { origin: 'ai-replace' },
  ); // range beyond the block
  throws(
    [{ blockId: 'b0', charStart: 5, charEnd: 2 }],
    { b0: 'x' },
    { origin: 'ai-replace' },
  ); // inverted range

  // Every rejection happened before any store interaction: no revision burn,
  // no projection drift.
  assert.equal(rec.calls.length, 0);
  assert.equal(binding.revision, revision0);
  assert.equal(readDiskRevision(pid), revision0);
});

// --- 5b. In-block minting without structure change --------------------------------

test('unstamped in-block replacement mints span identity through the atomic archive path', async () => {
  const pid = 'minting-project';
  const { archive } = await createAllKindsProject(pid);
  const rec = recordingStore(ensureStore());
  const binding = createEditorBinding({
    document: archive,
    store: rec.store,
    revision: readDiskRevision(pid),
  });

  // Paste-like replace of the middle span with UNSTAMPED text (no span mark):
  // identity is minted at commit time, block count unchanged.
  const from = blockStart(binding.doc, 'b8') + 11;
  const tr = binding.state.tr.replaceWith(from, from + 'bold italic'.length, EDITOR_SCHEMA.text('BRAZEN'));
  const result = binding.applyUserTransaction(tr);

  assert.equal(result.changed, true);
  assert.equal(rec.callsOf('saveDocumentArchive').length, 1, 'one atomic archive commit');
  assert.equal(rec.callsOf('updateBlockText').length, 0, 'legacy per-block path is gone');

  const persisted = ensureStore().loadDocumentArchive(pid);
  const mixed = persisted.blocks.find((b) => b.blockId === 'b8');
  assert.equal(mixed.text, 'Plain with BRAZEN tail.');
  assert.deepEqual(
    spanTuples(mixed.spans),
    spanTuples([
      { spanId: 'b8-s0', text: 'Plain with ', start: 0, end: 11, traits: {} },
      { spanId: 'b8-s3', text: 'BRAZEN', start: 11, end: 17, traits: {} },
      { spanId: 'b8-s2', text: ' tail.', start: 17, end: 23, traits: {} },
    ]),
    'fresh span id minted into the vacated slot',
  );
  assert.deepEqual(binding.doc.toJSON(), buildSourceDoc(persisted).toJSON());
  assert.equal(result.revision, readDiskRevision(pid));
  // The persisted fingerprint now describes the new trait shape exactly.
  assert.equal(
    mixed.styleFingerprint,
    styleFingerprintFor('paragraph', null, mixed.spans),
  );

  // And undo restores the pre-paste content exactly.
  const undone = binding.undo();
  assert.equal(undone.changed, true);
  const restoredBlock = ensureStore().loadDocumentArchive(pid).blocks.find((b) => b.blockId === 'b8');
  assert.equal(restoredBlock.text, 'Plain with bold italic tail.');
  assert.deepEqual(restoredBlock.spans.map((s) => [s.text, s.traits]), [
    ['Plain with ', {}],
    ['bold italic', { bold: true, italic: true }],
    [' tail.', {}],
  ]);
});
