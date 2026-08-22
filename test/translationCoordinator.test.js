'use strict';

// DOC-04 — Translation coordinator tests (plan §10.6).
//
// The coordinator drives per-chunk translation of a D3 ChunkPlan against a
// D2 DocumentProjectStore translation archive with NO network I/O: the
// `translate` function is the injected seam, so every fixture below uses a
// recording fake translator (echoing or scripted responses) and asserts on
// the observable contract only — the run/chunk progress snapshots, the
// requests seen by the fake, and the durable D2 archive contents.
//
// Covered here:
//   - local response validation and suspicion/status classification units;
//   - happy-path automatic batches: sequential per-chunk commits, revision
//     chain, progress reconciliation against the plan estimates, freshness;
//   - pause/resume without retranslating committed chunks; cancel keeping
//     committed work while discarding uncommitted responses;
//   - bounded repair (corrective context carried on the retry ask), thrown
//     provider errors failing immediately, repair exhaustion failing the
//     run after exactly MAX_REPAIR_ATTEMPTS re-asks;
//   - targeted intent: full-block fragments commit as drafts, partial
//     fragments are reported but never written, failures preserve the
//     previous variant;
//   - staleness: SOURCE_CHANGED re-hash drift and CONFLICT CAS rejection
//     never overwrite newer archive state;
//   - listener observability: synchronously attached listeners see every
//     post-attachment transition and exactly one terminal 'end'; ended runs
//     reject late drives.
// Review-1 hardening (P3A.D4):
//   - repeated same-block slices: tiling-strict offset-echo identity, the
//     full merge-commit path, and the reversal probe rejection;
//   - cancellation authoritative across failure/retry boundaries:
//     rejection-after-cancel, cancel-during-repair dispatch guard, unknown
//     (null) rejections surfacing as typed INTERNAL errors;
//   - commit/storage failures TERMINAL for the run: post-lease injection,
//     no later dispatch, WAL intent recovery and honest revision accounting;
//   - manual-chunk expansion over D3-split blocks committing whole drafts;
//   - suspicious automatic output landing needs-review; protected block and
//     span policies respected; per-successful-chunk revision chain;
//   - token snapshot semantics on partial and failed runs.
// Review-2 residual hardening (P3A.D4):
//   - cancellation precedence at the validating/committing boundaries:
//     cancel from a validating or committing progress update discards the
//     response before any write, and cancel beats stale classification;
//   - TranslationBlockStatus contract/runtime drift guard;
//   - fail-then-cancel clears the fatal error on the cancelled snapshot.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createTranslationCoordinator,
  MAX_REPAIR_ATTEMPTS,
  validateChunkResponse,
  suspicionOf,
  statusForBlock,
  RUN_STATES,
  CHUNK_DONE_STATUSES,
} = require('../electron/main/documents/translationCoordinator.js');
const {
  DocumentProjectStore,
  blockSourceHash,
} = require('../electron/main/documents/documentProjectStore.js');
const { createChunkPlan } = require('../electron/main/documents/chunkPlanner.js');
const { AppError, createAppError } = require('../shared/contracts/errors.ts');

// --- Fixtures -----------------------------------------------------------------

let rootDir;
let store;

test.before(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscript-transcoord-'));
  store = new DocumentProjectStore({ baseDir: rootDir });
});

test.after(() => {
  try {
    fs.rmSync(rootDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const T0 = '2026-01-01T00:00:00.000Z';
/** Canonical SHA-256 placeholder digest for language-variant meta. */
const META_HASH = 'aa'.repeat(32);

let blockCounter = 0;
/**
 * Deterministic valid block: one paragraph tiled by its single full-range
 * span (empty texts tile by zero spans), shaped like import output.
 */
function B(text, extra = {}) {
  blockCounter += 1;
  const blockId = extra.blockId ?? `b${blockCounter}`;
  return {
    blockId,
    kind: extra.kind ?? 'paragraph',
    part: 'main',
    index: extra.index ?? blockCounter - 1,
    styleFingerprint: 'fp',
    sourceHash: 'sh',
    text,
    spans:
      text.length === 0
        ? []
        : [{ spanId: `${blockId}-s0`, blockId, text, start: 0, end: text.length, traits: {} }],
  };
}

function documentProject(projectId) {
  return {
    schemaVersion: 3,
    projectId,
    revision: '1',
    type: 'document',
    metadata: { name: 'Doc Project', sourceFileName: 'sample.txt' },
    documentState: {
      sourceFileName: 'sample.txt',
      title: 'Fixture',
      sourceLang: 'en',
      targetLang: 'de',
      translationProvider: 'llama',
    },
    createdAt: T0,
    updatedAt: T0,
    assets: [],
  };
}

function archiveFor(projectId, blocks) {
  return {
    schemaVersion: 1,
    projectId,
    format: 'txt',
    title: 'Fixture',
    sourceAsset: { ref: 'asset://fixture', hash: 'a'.repeat(64), sizeBytes: 1, fileName: 'fixture.txt' },
    preflight: {
      format: 'txt',
      sizeBytes: 1,
      sourceHash: 'a'.repeat(64),
      words: 1,
      sections: 0,
      blocks: blocks.length,
      canImport: true,
      protectedContent: false,
      extractionAccuracy: 'high',
      warnings: [],
      limits: { sizeBytesLimit: 1024, exceeded: false },
    },
    blocks,
    editBaselines: {},
    blockPolicies: {},
    spanPolicies: {},
    editEpoch: 0,
    createdAt: T0,
    updatedAt: T0,
  };
}

function readRevision(projectId) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, projectId, 'project.json'), 'utf8')).revision;
}

/** Create a document project with a 'de' translation archive ready for runs. */
function setupProject(projectId, blocks) {
  store.createDocumentProject(documentProject(projectId), archiveFor(projectId, blocks));
  store.addLanguage(projectId, 'de', { provider: 'fake', sourceHash: META_HASH }, readRevision(projectId));
}

/** Plan over the given blocks; small budgets split prose into whole-block chunks. */
function planFor(blocks, maxTokensPerChunk) {
  return createChunkPlan({ blocks }, { maxTokensPerChunk, contextChars: 80 });
}

// Single-sentence paragraphs: ceil(len/4) tokens each, never split internally.
const PARA_5A = 'Alpha beta gamma.'; // 17 chars -> 5 tokens
const PARA_5B = 'Delta epsilon zeta.'; // 19 chars -> 5 tokens
const PARA_5C = 'Epsilon zeta eta.'; // 17 chars -> 5 tokens
const PARA_5D = 'Theta iota kappa.'; // 17 chars -> 5 tokens
const PARA_4A = 'Lambda mu nu xi.'; // 16 chars -> 4 tokens
const PARA_4B = 'Omicron pi rho.'; // 15 chars -> 4 tokens

/** Recording fake: echoes every sent segment back with a deterministic prefix. */
function echoTranslator() {
  const calls = [];
  const translate = async (request) => {
    calls.push(request);
    return {
      segments: request.segments.map((s) => ({
        blockId: s.blockId,
        charStart: s.charStart,
        charEnd: s.charEnd,
        text: `[de] ${s.text}`,
      })),
    };
  };
  return { translate, calls };
}

/**
 * Gated fake: records each call, then parks until `release()` lets it
 * produce the response — used to hold chunks mid-flight for control tests.
 */
function gatedTranslator(responseFor) {
  const calls = [];
  const resolvers = [];
  const translate = async (request) => {
    calls.push(request);
    await new Promise((resolve) => resolvers.push(resolve));
    return responseFor(request, calls.length);
  };
  return {
    translate,
    calls,
    async release(n = 1) {
      for (let i = 0; i < n; i += 1) {
        while (resolvers.length === 0) await new Promise((resolve) => setImmediate(resolve));
        resolvers.shift()();
      }
    },
  };
}

/** Scripted fake: pops queued responses, falling back to a valid echo. */
function scriptedTranslator(queue, fallback) {
  const calls = [];
  const translate = async (request) => {
    calls.push(request);
    const next = queue.shift();
    if (next) return typeof next === 'function' ? next(request, calls.length) : next;
    return fallback(request, calls.length);
  };
  return { translate, calls };
}

async function waitFor(predicate, label, render) {
  for (let i = 0; i < 5000; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${label}${render ? `: ${render()}` : ''}`);
}

// --- Response validation units ---------------------------------------------------

test('validateChunkResponse demands an exact ordered tiling of the sent segments', () => {
  const request = {
    segments: [
      { blockId: 'b1', charStart: 0, charEnd: 5, text: 'Hello' },
      { blockId: 'b2', charStart: 5, charEnd: 11, text: ' world' },
    ],
  };
  const ok = { segments: [{ blockId: 'b1', text: 'Hallo' }, { blockId: 'b2', text: 'Welt' }] };
  assert.deepEqual(validateChunkResponse(request, ok), { ok: true });
  // Echoed offsets matching the request are accepted.
  assert.deepEqual(
    validateChunkResponse(request, {
      segments: [
        { blockId: 'b1', charStart: 0, charEnd: 5, text: 'Hallo' },
        { blockId: 'b2', charStart: 5, charEnd: 11, text: 'Welt' },
      ],
    }),
    { ok: true },
  );

  // Non-object / array / missing segments payloads are rejected outright.
  assert.equal(validateChunkResponse(request, null).ok, false);
  assert.equal(validateChunkResponse(request, []).ok, false);
  assert.deepEqual(validateChunkResponse(request, {}), {
    ok: false,
    issues: ['response.segments must be an array.'],
  });

  // Fabricated extra segments fail with the expected-count issue.
  const fabricated = validateChunkResponse(request, {
    segments: [...ok.segments, { blockId: 'b3', text: 'Extra' }],
  });
  assert.equal(fabricated.ok, false);
  assert.deepEqual(fabricated.issues, ['expected exactly 2 segment(s), got 3 — do not add, drop, merge, or reorder segments.']);

  // Reordered segments are caught by the blockId echo requirement.
  const reordered = validateChunkResponse(request, {
    segments: [{ blockId: 'b2', text: 'Welt' }, { blockId: 'b1', text: 'Hallo' }],
  });
  assert.equal(reordered.ok, false);
  assert.deepEqual(reordered.issues, [
    'segments[0].blockId must echo "b1", got "b2".',
    'segments[1].blockId must echo "b2", got "b1".',
  ]);

  // Non-string text and wrong echoed offsets are collected per segment.
  const malformed = validateChunkResponse(request, {
    segments: [
      { blockId: 'b1', text: 42, charStart: 1, charEnd: 5 },
      { blockId: 'wrong', text: 'Welt', charEnd: 99 },
    ],
  });
  assert.equal(malformed.ok, false);
  assert.deepEqual(malformed.issues, [
    'segments[0].text must be a string.',
    'segments[0].charStart must be 0 when echoed.',
    'segments[1].blockId must echo "b2", got "wrong".',
    'segments[1].charEnd must be 11 when echoed.',
  ]);
});

// --- Suspicion heuristics and status policy units ---------------------------------

test('suspicionOf flags identical and blank targets; statusForBlock routes approval by intent', () => {
  // Empty source is never suspicious (empty target is its only valid translation).
  assert.equal(suspicionOf('', ''), null);
  assert.equal(suspicionOf('', 'anything'), null);
  assert.equal(suspicionOf('Hola', ''), 'blank');
  assert.equal(suspicionOf('Hola', '   '), 'blank');
  assert.equal(suspicionOf('Hola', 'Hola'), 'identical');
  // A genuinely different target is clean.
  assert.equal(suspicionOf('Hola', 'hallo'), null);
  assert.equal(suspicionOf('Hola', 'Adiós'), null);

  // Automatic mode auto-approves only locally-valid results.
  assert.equal(statusForBlock('automatic', null), 'approved');
  assert.equal(statusForBlock('automatic', 'identical'), 'needs-review');
  assert.equal(statusForBlock('automatic', 'blank'), 'needs-review');
  // Manual/targeted results are drafts; approval belongs to the review lane.
  assert.equal(statusForBlock('manual-chunk', null), 'draft');
  assert.equal(statusForBlock('manual-chunk', 'identical'), 'draft');
  assert.equal(statusForBlock('targeted', null), 'draft');
  assert.equal(statusForBlock('targeted', 'blank'), 'draft');
});

// --- Happy path: automatic batch over a multi-chunk plan ---------------------------

test('automatic batch commits sequentially, reconciles progress, and lands fresh approved translations', async () => {
  const blocks = [B(PARA_5A), B(PARA_5B), B(PARA_4A), B(PARA_4B)];
  const pid = 'coord-happy';
  setupProject(pid, blocks);

  // Budget 10 over 5+5+4+4 tokens yields two whole-block chunks.
  const plan = planFor(blocks, 10);
  assert.equal(plan.chunks.length, 2, 'fixture sanity: multi-chunk plan');
  for (const chunk of plan.chunks) {
    for (const slice of chunk.slices) {
      const block = blocks.find((b) => b.blockId === slice.blockId);
      assert.equal(slice.charStart, 0);
      assert.equal(slice.charEnd, block.text.length, 'fixture sanity: whole-block slices');
    }
  }

  const fake = echoTranslator();
  const coord = createTranslationCoordinator({ store, translate: fake.translate });
  const run = coord.startAutomatic({ projectId: pid, language: 'de', plan });
  assert.equal(run.state, 'preparing');

  const final = await run.promise;

  // Run-level outcome.
  assert.equal(final.state, 'completed');
  assert.equal(final.error, null);
  assert.equal(final.chunksTotal, 2);
  assert.equal(final.chunksDone, 2);
  assert.equal(final.blocksTotal, 4);
  assert.equal(final.blocksDone, 4);

  // Progress reconciles exactly against the plan estimates (§10.6).
  const estimateSum = plan.chunks.reduce((sum, c) => sum + c.tokenEstimate, 0);
  assert.equal(final.tokensTotal, estimateSum);
  assert.equal(final.tokensDone, estimateSum);
  assert.deepEqual(final.chunks.map((c) => c.chunkId), plan.chunks.map((c) => c.chunkId));
  for (const row of final.chunks) {
    assert.equal(row.status, 'committed');
    assert.equal(row.repairAttempts, 0);
    assert.deepEqual(row.blocks.map((b) => b.status), ['approved', 'approved']);
  }

  // One sequential call per chunk, in plan order, carrying the plan's slices.
  assert.equal(fake.calls.length, 2);
  plan.chunks.forEach((chunk, i) => {
    const request = fake.calls[i];
    assert.deepEqual(request, {
      runId: run.runId,
      chunkId: chunk.chunkId,
      targetLanguage: 'de',
      contextBefore: chunk.contextBefore,
      contextAfter: chunk.contextAfter,
      segments: chunk.slices.map((slice) => ({
        blockId: slice.blockId,
        charStart: slice.charStart,
        charEnd: slice.charEnd,
        text: blocks.find((b) => b.blockId === slice.blockId).text.slice(slice.charStart, slice.charEnd),
      })),
    });
  });

  // Committed translations landed in the D2 archive with sourceHash set…
  const archive = store.getTranslationArchive(pid, 'de');
  assert.equal(Object.keys(archive.blocks).length, 4);
  for (const block of blocks) {
    const entry = archive.blocks[block.blockId];
    assert.equal(entry.text, `[de] ${block.text}`);
    assert.equal(entry.sourceHash, blockSourceHash(block));
    assert.equal(entry.status, 'approved');
  }

  // …and computeFreshness marks every block fresh.
  const report = store.freshness(pid, 'de');
  assert.equal(report.fresh, 4);
  assert.equal(report.stale, 0);
  assert.equal(report.missing, 0);
  assert.equal(report.approved, 4);
  assert.equal(report.needsReview, 0);

  // The ended run left the coordinator registry.
  assert.equal(coord.getRun(run.runId), null);
});
// --- Pause/resume at a safe chunk boundary -----------------------------------------

test('pause mid-run parks at the next chunk boundary and resume completes without retranslating', async () => {
  const blocks = [B(PARA_5A), B(PARA_5B), B(PARA_4A), B(PARA_4B)];
  const pid = 'coord-pause';
  setupProject(pid, blocks);
  const plan = planFor(blocks, 10);
  assert.equal(plan.chunks.length, 2, 'fixture sanity: multi-chunk plan');

  const fake = echoTranslator();
  const coord = createTranslationCoordinator({ store, translate: fake.translate });
  const run = coord.startAutomatic({ projectId: pid, language: 'de', plan });

  // Pause synchronously at the first chunk boundary: the commit-phase update
  // carries chunk1's written rows, and the driver observes the flag at the
  // loop top BEFORE dispatching chunk2.
  let pausedHere = false;
  run.on('update', (snap) => {
    if (!pausedHere && snap.chunks[0]?.status === 'committed') {
      pausedHere = true;
      run.pause();
    }
  });
  await waitFor(() => run.state === 'paused', 'run to pause');
  assert.ok(pausedHere);

  // Exactly one chunk was sent; nothing re-sent, nothing pending dispatched.
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].chunkId, plan.chunks[0].chunkId);
  const pausedSnap = run.snapshot();
  assert.equal(pausedSnap.chunks[0].status, 'committed');
  assert.equal(pausedSnap.chunks[1].status, 'pending');
  // Mid-run progress reconciliation against the plan estimates.
  assert.equal(pausedSnap.chunksDone, 1);
  assert.equal(pausedSnap.blocksDone, 2);
  assert.equal(pausedSnap.tokensDone, plan.chunks[0].tokenEstimate);
  // tokensTotal is the FULL plan estimate regardless of progress; a partial
  // run always shows tokensDone < tokensTotal (TranslationProgressSnapshot).
  assert.equal(pausedSnap.tokensTotal, plan.chunks.reduce((sum, c) => sum + c.tokenEstimate, 0));
  assert.ok(pausedSnap.tokensDone < pausedSnap.tokensTotal);

  run.resume();
  const final = await run.promise;

  assert.equal(final.state, 'completed');
  assert.equal(final.error, null);
  assert.equal(final.chunksDone, 2);
  assert.equal(final.blocksDone, 4);
  // The call log proves already-committed chunks are never retranslated:
  // exactly one call per chunkId, in plan order.
  assert.deepEqual(
    fake.calls.map((c) => c.chunkId),
    plan.chunks.map((c) => c.chunkId),
  );
  const archive = store.getTranslationArchive(pid, 'de');
  for (const block of blocks) {
    assert.equal(archive.blocks[block.blockId].text, `[de] ${block.text}`);
    assert.equal(archive.blocks[block.blockId].sourceHash, blockSourceHash(block));
  }
});

// --- Cancel discards uncommitted work, keeps committed work -------------------------

test('cancel mid-run discards the in-flight response and pending chunks but keeps committed translations', async () => {
  const blocks = [
    B(PARA_5A),
    B(PARA_5B),
    B(PARA_5C),
    B(PARA_5D),
    B(PARA_4A),
    B(PARA_4B),
  ];
  const pid = 'coord-cancel';
  setupProject(pid, blocks);
  const plan = planFor(blocks, 10);
  assert.equal(plan.chunks.length, 3, 'fixture sanity: three-chunk plan');

  const fake = gatedTranslator((request) => ({
    segments: request.segments.map((s) => ({
      blockId: s.blockId,
      charStart: s.charStart,
      charEnd: s.charEnd,
      text: `[de] ${s.text}`,
    })),
  }));
  const coord = createTranslationCoordinator({ store, translate: fake.translate });
  const run = coord.startAutomatic({ projectId: pid, language: 'de', plan });

  fake.release(1); // chunk1 translates and commits
  await waitFor(() => fake.calls.length === 2, 'chunk2 to be dispatched');
  assert.equal(run.snapshot().chunks[0].status, 'committed');

  // Cancel while chunk2 is in flight: the driver observes the flag after the
  // current await — the in-flight response is discarded without commit.
  run.cancel();
  assert.ok(coord.getRun(run.runId) !== null, 'in-flight cancel settles only after the current await');
  fake.release(1);

  const final = await run.promise;
  assert.equal(final.state, 'cancelled');
  assert.equal(final.error, null);
  assert.deepEqual(
    final.chunks.map((c) => c.status),
    ['committed', 'cancelled', 'cancelled'],
  );
  assert.deepEqual(final.chunks[1].blocks, [
    { blockId: blocks[2].blockId, status: 'uncommitted' },
    { blockId: blocks[3].blockId, status: 'uncommitted' },
  ]);
  assert.equal(final.tokensDone, plan.chunks[0].tokenEstimate);

  // Committed chunk1 stays durable; uncommitted chunks wrote nothing.
  const archive = store.getTranslationArchive(pid, 'de');
  assert.equal(archive.blocks[blocks[0].blockId].text, `[de] ${PARA_5A}`);
  assert.equal(archive.blocks[blocks[1].blockId].text, `[de] ${PARA_5B}`);
  assert.equal(archive.blocks[blocks[2].blockId], undefined);
  assert.equal(archive.blocks[blocks[4].blockId], undefined);

  // Ended runs leave the registry and ignore late control calls.
  assert.equal(coord.getRun(run.runId), null);
  run.pause();
  run.resume();
  run.cancel();
  assert.equal(fake.calls.length, 2, 'late drives dispatch nothing');
});
// --- Repair flow: corrective context on the retry ask -------------------------------

test('a malformed response is repaired once with the issue list attached, then commits', async () => {
  const blocks = [B(PARA_5A), B(PARA_5B)];
  const pid = 'coord-repair';
  setupProject(pid, blocks);
  const plan = planFor(blocks, 1000);
  assert.equal(plan.chunks.length, 1, 'fixture sanity: single chunk');

  // First answer drops a segment; the retry echoes correctly.
  const fake = scriptedTranslator(
    [{ segments: [{ blockId: blocks[0].blockId, text: '[de] Alpha' }] }],
    (request) => ({
      segments: request.segments.map((s) => ({ blockId: s.blockId, text: `[de] ${s.text}` })),
    }),
  );
  const coord = createTranslationCoordinator({ store, translate: fake.translate });
  const run = coord.startAutomatic({ projectId: pid, language: 'de', plan });
  const final = await run.promise;

  assert.equal(final.state, 'completed');
  const [chunkRow] = final.chunks;
  assert.equal(chunkRow.status, 'committed');
  assert.equal(chunkRow.repairAttempts, 1);

  // Exactly one re-ask, carrying the structural issues as corrective context.
  assert.equal(fake.calls.length, 2);
  const expectedIssues = validateChunkResponse(fake.calls[0], {
    segments: [{ blockId: blocks[0].blockId, text: '[de] Alpha' }],
  }).issues;
  assert.ok(expectedIssues.length > 0);
  assert.deepEqual(fake.calls[1].repair, { attempt: 1, issues: expectedIssues });
  assert.deepEqual(fake.calls[1].segments, fake.calls[0].segments, 'retry re-sends the same slices');
  assert.deepEqual(chunkRow.blocks.map((b) => b.status), ['approved', 'approved']);

  const archive = store.getTranslationArchive(pid, 'de');
  assert.equal(archive.blocks[blocks[1].blockId].text, `[de] ${PARA_5B}`);
});

// --- Thrown provider errors fail immediately (non-repairable) -----------------------

test('a thrown provider error fails the chunk immediately without a repair ask; the run continues', async () => {
  const blocks = [
    B(PARA_5A),
    B(PARA_5B),
    B(PARA_4A),
    B(PARA_4B),
  ];
  const pid = 'coord-throw';
  setupProject(pid, blocks);
  const plan = planFor(blocks, 10);
  assert.equal(plan.chunks.length, 2, 'fixture sanity: multi-chunk plan');

  const boom = () => {
    throw createAppError('PROVIDER_ERROR', 'provider exploded');
  };
  const fake = scriptedTranslator([boom], (request) => ({
    segments: request.segments.map((s) => ({ blockId: s.blockId, text: `[de] ${s.text}` })),
  }));
  const coord = createTranslationCoordinator({ store, translate: fake.translate });
  const run = coord.startAutomatic({ projectId: pid, language: 'de', plan });
  const final = await run.promise;

  // Chunk1 failed after exactly ONE call — throws are not repairable asks.
  assert.equal(final.state, 'failed');
  assert.equal(fake.calls.length, 2, 'one call for each chunk, no repair retry');
  // tokensTotal stays the full plan estimate; the failed chunk's estimate
  // never lands in tokensDone (TranslationProgressSnapshot contract).
  assert.equal(final.tokensTotal, plan.chunks.reduce((sum, c) => sum + c.tokenEstimate, 0));
  assert.equal(final.tokensDone, plan.chunks[1].tokenEstimate);
  assert.equal(final.error.code, 'PROVIDER_ERROR');
  assert.match(final.error.message, /provider exploded/);
  assert.deepEqual(final.chunks[0].blocks.map((b) => b.status), ['failed', 'failed']);
  assert.equal(fake.calls.length, 2, 'one call for each chunk, no repair retry');
  assert.equal(fake.calls[0].chunkId, plan.chunks[0].chunkId);

  // The surviving chunk still committed its translations.
  const archive = store.getTranslationArchive(pid, 'de');
  assert.equal(archive.blocks[blocks[0].blockId], undefined);
  assert.equal(archive.blocks[blocks[2].blockId].text, `[de] ${PARA_4A}`);
  assert.equal(archive.blocks[blocks[3].blockId].status, 'approved');
});

// --- Repair exhaustion: bounded retries, then a loud terminal failure -----------------

test('a persistently malformed response is re-asked at most MAX_REPAIR_ATTEMPTS times, then fails the run', async () => {
  const blocks = [B(PARA_5A), B(PARA_5B)];
  const pid = 'coord-exhaust';
  setupProject(pid, blocks);
  const plan = planFor(blocks, 1000);

  // Every answer (queued and fallback) fabricates an extra segment.
  const badResponse = { segments: [{ blockId: 'x', text: '' }, { blockId: 'y', text: '' }, { blockId: 'z', text: '' }] };
  const fake = scriptedTranslator([badResponse, badResponse], () => badResponse);
  const coord = createTranslationCoordinator({ store, translate: fake.translate });
  const run = coord.startAutomatic({ projectId: pid, language: 'de', plan });
  const final = await run.promise;

  // Initial ask plus exactly MAX_REPAIR_ATTEMPTS bounded re-asks.
  assert.equal(fake.calls.length, 1 + MAX_REPAIR_ATTEMPTS);
  assert.deepEqual(fake.calls[1].repair.attempt, 1);
  assert.deepEqual(fake.calls[2].repair.attempt, MAX_REPAIR_ATTEMPTS);
  for (const call of fake.calls.slice(1)) {
    assert.ok(Array.isArray(call.repair.issues) && call.repair.issues.length > 0);
  }

  assert.equal(final.state, 'failed');
  assert.deepEqual(final.chunks.map((c) => c.status), ['failed']);
  assert.equal(final.chunks[0].repairAttempts, MAX_REPAIR_ATTEMPTS);
  assert.equal(final.error.code, 'PROVIDER_ERROR');
  assert.match(final.error.message, /still invalid after 2 repair attempt\(s\)/);

  // A failed response never touches the archive.
  const archive = store.getTranslationArchive(pid, 'de');
  assert.equal(Object.keys(archive.blocks).length, 0);
});
// --- Targeted intent: failures preserve the previous variant ------------------------

test('a failed targeted translation never touches the archive: the previous variant survives', async () => {
  const blocks = [B(PARA_5A), B(PARA_5B)];
  const pid = 'coord-targeted-fail';
  setupProject(pid, blocks);
  let rev = readRevision(pid);
  ({ revision: rev } = store.saveTranslations(pid, 'de', [
    { blockId: blocks[0].blockId, text: 'ALT text.', status: 'approved' },
  ], rev));
  const before = store.getTranslationArchive(pid, 'de').blocks[blocks[0].blockId];

  const fake = scriptedTranslator([(request) => {
    throw createAppError('PROVIDER_ERROR', 'selection provider down');
  }], () => ({ segments: [] }));
  const coord = createTranslationCoordinator({ store, translate: fake.translate });
  const run = coord.startTargeted({
    projectId: pid,
    language: 'de',
    fragments: [{ blockId: blocks[0].blockId }], // defaults to the whole block
  });
  const final = await run.promise;

  assert.equal(final.state, 'failed');
  assert.equal(final.error.code, 'PROVIDER_ERROR');
  assert.deepEqual(final.chunks[0].blocks, [{ blockId: blocks[0].blockId, status: 'failed' }]);
  assert.equal(final.blocksDone, 0);

  // Byte-for-byte the same variant as before the run — user text never blanked.
  const after = store.getTranslationArchive(pid, 'de').blocks[blocks[0].blockId];
  assert.deepEqual(after, before);
});

// --- Whole-block coverage guard: partial fragments are reported, never written -------

test('a partial targeted fragment cannot clobber the block: reported uncommitted, nothing written', async () => {
  const blocks = [B(PARA_5A), B(PARA_5B)];
  const pid = 'coord-targeted-partial';
  setupProject(pid, blocks);
  let rev = readRevision(pid);
  ({ revision: rev } = store.saveTranslations(pid, 'de', [
    { blockId: blocks[0].blockId, text: 'ALT text.', status: 'draft' },
  ], rev));

  const half = Math.floor(PARA_5A.length / 2);
  const fake = echoTranslator();
  const coord = createTranslationCoordinator({ store, translate: fake.translate });
  const run = coord.startTargeted({
    projectId: pid,
    language: 'de',
    fragments: [{ blockId: blocks[0].blockId, charStart: 0, charEnd: half }],
  });
  const final = await run.promise;

  // The work was done and reported per block — but a partial result can never
  // be spliced into the stored whole-block translation here.
  assert.equal(final.state, 'completed');
  assert.equal(final.chunks[0].status, 'committed');
  assert.deepEqual(final.chunks[0].blocks, [{ blockId: blocks[0].blockId, status: 'uncommitted' }]);
  // Only fully-tileable blocks count as writable progress.
  assert.equal(final.blocksTotal, 0);
  assert.equal(final.blocksDone, 0);

  const entry = store.getTranslationArchive(pid, 'de').blocks[blocks[0].blockId];
  assert.equal(entry.text, 'ALT text.', 'previous variant untouched');
  assert.equal(entry.status, 'draft');

  // The fragment WAS sent, exactly as selected.
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0].segments, [
    { blockId: blocks[0].blockId, charStart: 0, charEnd: half, text: PARA_5A.slice(0, half) },
  ]);
});

// --- Targeted full-block fragments commit through the archive as drafts --------------

test('a full-block targeted fragment commits as a draft through the normal archive path', async () => {
  const blocks = [B(PARA_4A), B(PARA_4B)];
  const pid = 'coord-targeted-full';
  setupProject(pid, blocks);

  const fake = echoTranslator();
  const coord = createTranslationCoordinator({ store, translate: fake.translate });
  const run = coord.startTargeted({
    projectId: pid,
    language: 'de',
    fragments: [{ blockId: blocks[0].blockId }],
  });
  const final = await run.promise;

  assert.equal(final.state, 'completed');
  assert.equal(final.error, null);
  assert.equal(final.blocksTotal, 1);
  assert.equal(final.blocksDone, 1);
  assert.deepEqual(final.chunks[0].blocks, [{ blockId: blocks[0].blockId, status: 'draft' }]);

  const entry = store.getTranslationArchive(pid, 'de').blocks[blocks[0].blockId];
  assert.equal(entry.text, `[de] ${PARA_4A}`);
  assert.equal(entry.sourceHash, blockSourceHash(blocks[0]));
  // Manual/targeted results are drafts; approval belongs to the review lane.
  assert.equal(entry.status, 'draft');

  // The untouched second block stays missing.
  const report = store.freshness(pid, 'de');
  assert.deepEqual(
    [report.blocks[blocks[0].blockId].freshness, report.blocks[blocks[1].blockId].freshness],
    ['fresh', 'missing'],
  );
});
// --- Stale responses: source drift is never overwritten ------------------------------

test('a response captured before a source edit is discarded as SOURCE_CHANGED, never committed', async () => {
  const blocks = [B(PARA_5A), B(PARA_5B)];
  const pid = 'coord-source-changed';
  setupProject(pid, blocks);
  const plan = planFor(blocks, 1000);

  const fake = gatedTranslator((request) => ({
    segments: request.segments.map((s) => ({ blockId: s.blockId, text: `[de] ${s.text}` })),
  }));
  const coord = createTranslationCoordinator({ store, translate: fake.translate });
  const run = coord.startAutomatic({ projectId: pid, language: 'de', plan });

  // Hold the chunk in flight, then edit its source underneath the run.
  await waitFor(() => fake.calls.length === 1, 'chunk to be dispatched');
  const revAfterEdit = store.updateBlockText(
    pid,
    blocks[0].blockId,
    'Edited source text.',
    readRevision(pid),
  ).revision;
  fake.release(1);

  const final = await run.promise;
  assert.equal(final.state, 'failed');
  assert.equal(final.chunks[0].status, 'stale');
  assert.deepEqual(final.chunks[0].blocks.map((b) => b.status), ['uncommitted', 'uncommitted']);
  assert.equal(final.error.code, 'SOURCE_CHANGED');
  assert.match(final.error.message, new RegExp(blocks[0].blockId));

  // The stale response wrote nothing and burned no revision.
  const archive = store.getTranslationArchive(pid, 'de');
  assert.equal(Object.keys(archive.blocks).length, 0);
  assert.equal(readRevision(pid), revAfterEdit);
  assert.equal(coord.getRun(run.runId), null);
});

// --- Stale responses: CAS conflict against interleaved archive writes -----------------

test('a commit anchored to a superseded revision conflicts and never overwrites newer archive state', async () => {
  const blocks = [B(PARA_5A), B(PARA_5B)];
  const pid = 'coord-conflict';
  setupProject(pid, blocks);
  const plan = planFor(blocks, 1000);

  const fake = gatedTranslator((request) => ({
    segments: request.segments.map((s) => ({ blockId: s.blockId, text: `[de] ${s.text}` })),
  }));
  const coord = createTranslationCoordinator({ store, translate: fake.translate });
  const run = coord.startAutomatic({ projectId: pid, language: 'de', plan });

  // Hold the chunk in flight, then interleave an external archive mutation.
  await waitFor(() => fake.calls.length === 1, 'chunk to be dispatched');
  const externalRev = store.saveTranslations(pid, 'de', [
    { blockId: blocks[0].blockId, text: 'External write.', status: 'approved' },
  ], readRevision(pid)).revision;
  fake.release(1);

  const final = await run.promise;
  assert.equal(final.state, 'failed');
  assert.equal(final.chunks[0].status, 'stale');
  assert.equal(final.error.code, 'CONFLICT');

  // The run's stale snapshot overwrote nothing: the external variant stands,
  // and the run's own block never appeared.
  const archive = store.getTranslationArchive(pid, 'de');
  assert.equal(archive.blocks[blocks[0].blockId].text, 'External write.');
  assert.equal(archive.blocks[blocks[0].blockId].status, 'approved');
  assert.equal(archive.blocks[blocks[1].blockId], undefined);
  assert.equal(readRevision(pid), externalRev);
  assert.equal(coord.getRun(run.runId), null);
});

// --- Listener observability and the ended-run guard -----------------------------------

test('synchronously attached listeners see every transition and exactly one end; ended runs reject late drives', async () => {
  const blocks = [B(PARA_5A), B(PARA_5B), B(PARA_4A), B(PARA_4B)];
  const pid = 'coord-listeners';
  setupProject(pid, blocks);
  const plan = planFor(blocks, 10);

  const fake = echoTranslator();
  const coord = createTranslationCoordinator({ store, translate: fake.translate });
  const run = coord.startAutomatic({ projectId: pid, language: 'de', plan });
  // The handle is live in 'preparing' the moment startAutomatic returns.
  assert.equal(run.state, 'preparing');

  const updates = [];
  const ends = [];
  run.on('update', (snap) => updates.push(snap.state));
  run.on('end', (snap) => ends.push(snap));

  const final = await run.promise;
  assert.equal(final.state, 'completed');

  // Every post-attachment transition was observed, in driver order: the
  // per-chunk phase mirrors (translating → validating → committing) with no
  // gaps, and the terminal transition arrives via 'end' only.
  assert.ok(updates.length >= 6, `phase updates observed, got ${updates.length}`);
  assert.equal(updates[0], 'translating');
  for (const state of updates) {
    assert.ok(RUN_STATES.has(state), `known run state: ${state}`);
  }
  assert.ok(updates.includes('validating'), 'per-chunk validating phase observable');
  assert.ok(updates.includes('committing'), 'per-chunk committing phase observable');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].state, 'completed');

  // After the run ended, late drives are rejected: no further events, no
  // registry entry, no additional translator calls.
  const updatesBefore = updates.length;
  const endsBefore = ends.length;
  run.resume();
  run.pause();
  run.cancel();
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updates.length, updatesBefore, 'no updates after end');
  assert.equal(ends.length, endsBefore, 'no second end');
  assert.equal(fake.calls.length, 2, 'no late dispatches');
  assert.equal(coord.getRun(run.runId), null);
});

// --- Repeated same-block slices: tiling-strict per-slice identity (review 1.1) ------

test('validateChunkResponse requires exact offset echoes to identify repeated same-block slices', () => {
  const request = {
    segments: [
      { blockId: 'b1', charStart: 0, charEnd: 3, text: 'abc' },
      { blockId: 'b1', charStart: 3, charEnd: 6, text: 'def' },
    ],
  };
  // A fully-echoed tiling is unambiguous and accepted.
  assert.deepEqual(
    validateChunkResponse(request, {
      segments: [
        { blockId: 'b1', charStart: 0, charEnd: 3, text: 'ABC' },
        { blockId: 'b1', charStart: 3, charEnd: 6, text: 'DEF' },
      ],
    }),
    { ok: true },
  );

  // Reviewer probe: same-block slices REVERSED while omitting the (otherwise
  // optional) offsets — blockId checks alone would pass and the positional
  // merge would scramble the block. The required offset echo makes this a
  // structural failure collected for the repair ask.
  const probe = validateChunkResponse(request, {
    segments: [
      { blockId: 'b1', text: 'DEF' },
      { blockId: 'b1', text: 'ABC' },
    ],
  });
  assert.equal(probe.ok, false);
  assert.deepEqual(probe.issues, [
    'segments[0].charStart must echo 0: block "b1" appears more than once in this chunk, so every segment must identify its slice by its exact offsets.',
    'segments[0].charEnd must echo 3: block "b1" appears more than once in this chunk, so every segment must identify its slice by its exact offsets.',
    'segments[1].charStart must echo 3: block "b1" appears more than once in this chunk, so every segment must identify its slice by its exact offsets.',
    'segments[1].charEnd must echo 6: block "b1" appears more than once in this chunk, so every segment must identify its slice by its exact offsets.',
  ]);

  // Reversal WITH offsets is caught by the existing mismatch check.
  const reversedEchoed = validateChunkResponse(request, {
    segments: [
      { blockId: 'b1', charStart: 3, charEnd: 6, text: 'DEF' },
      { blockId: 'b1', charStart: 0, charEnd: 3, text: 'ABC' },
    ],
  });
  assert.equal(reversedEchoed.ok, false);
});

test('repeated same-block slices merge and commit through the full path when offsets are echoed', async () => {
  const blocks = [B(PARA_5A), B(PARA_5B)];
  const pid = 'coord-repeat-commit';
  setupProject(pid, blocks);

  // Two fragments of ONE block: the request legitimately repeats a blockId.
  const fake = echoTranslator(); // echoes offsets → unambiguous per-slice identity
  const coord = createTranslationCoordinator({ store, translate: fake.translate });
  const run = coord.startTargeted({
    projectId: pid,
    language: 'de',
    fragments: [
      { blockId: blocks[0].blockId, charStart: 0, charEnd: 6 },
      { blockId: blocks[0].blockId, charStart: 6, charEnd: PARA_5A.length },
    ],
  });
  const final = await run.promise;

  assert.equal(final.state, 'completed');
  assert.equal(final.error, null);
  assert.equal(final.chunks[0].status, 'committed');
  assert.deepEqual(final.chunks[0].blocks, [{ blockId: blocks[0].blockId, status: 'draft' }]);
  assert.equal(final.blocksTotal, 1);
  assert.equal(final.blocksDone, 1);

  // The merged entry joins the slice translations in range order.
  const entry = store.getTranslationArchive(pid, 'de').blocks[blocks[0].blockId];
  assert.equal(entry.text, `[de] ${PARA_5A.slice(0, 6)}[de] ${PARA_5A.slice(6)}`);
  assert.equal(entry.sourceHash, blockSourceHash(blocks[0]));
  assert.equal(entry.status, 'draft');
});

test('a provider that reverses repeated same-block slices without echoing offsets never commits', async () => {
  const blocks = [B(PARA_5A), B(PARA_5B)];
  const pid = 'coord-repeat-probe';
  setupProject(pid, blocks);

  // The reviewer's exact probe on every attempt: reversed slices, offsets omitted.
  const fake = scriptedTranslator([], (request) => ({
    segments: request.segments
      .slice()
      .reverse()
      .map((s) => ({ blockId: s.blockId, text: `[de] ${s.text}` })),
  }));
  const coord = createTranslationCoordinator({ store, translate: fake.translate });
  const run = coord.startTargeted({
    projectId: pid,
    language: 'de',
    fragments: [
      { blockId: blocks[0].blockId, charStart: 0, charEnd: 6 },
      { blockId: blocks[0].blockId, charStart: 6, charEnd: PARA_5A.length },
    ],
  });
  const final = await run.promise;

  // Bounded repairs exhaust, then a loud typed failure — the scrambled merge
  // was never accepted, let alone committed approved with a fresh hash.
  assert.equal(final.state, 'failed');
  assert.equal(final.error.code, 'PROVIDER_ERROR');
  assert.match(final.error.message, /still invalid after 2 repair attempt\(s\)/);
  assert.equal(final.chunks[0].status, 'failed');
  assert.equal(final.chunks[0].repairAttempts, MAX_REPAIR_ATTEMPTS);
  assert.equal(fake.calls.length, 1 + MAX_REPAIR_ATTEMPTS);
  assert.equal(final.blocksDone, 0);
  assert.equal(store.getTranslationArchive(pid, 'de').blocks[blocks[0].blockId], undefined);
});

// --- Cancellation authoritative across failure/retry boundaries (review 1.2) --------

test('a provider rejection after cancel() settles the run cancelled, never as a failed chunk', async () => {
  const blocks = [B(PARA_5A), B(PARA_5B), B(PARA_4A), B(PARA_4B)];
  const pid = 'coord-cancel-reject';
  setupProject(pid, blocks);
  const plan = planFor(blocks, 10);
  assert.equal(plan.chunks.length, 2, 'fixture sanity: multi-chunk plan');

  // The translator's promise stays pending until THIS test rejects it.
  const calls = [];
  let rejectInFlight;
  const coord = createTranslationCoordinator({
    store,
    translate: (request) =>
      new Promise((_, reject) => {
        calls.push(request);
        rejectInFlight = reject;
      }),
  });
  const run = coord.startAutomatic({ projectId: pid, language: 'de', plan });
  await waitFor(() => calls.length === 1, 'chunk1 to be dispatched');
  run.cancel(); // cancel wins even though chunk1 is still in flight…
  rejectInFlight(createAppError('PROVIDER_ERROR', 'provider died after cancel')); // …and then rejects

  const final = await run.promise;
  assert.equal(final.state, 'cancelled');
  assert.equal(final.error, null, 'the provider rejection must not surface');
  assert.deepEqual(final.chunks.map((c) => c.status), ['cancelled', 'cancelled']);
  assert.deepEqual(final.chunks[0].blocks.map((b) => b.status), ['uncommitted', 'uncommitted']);
  assert.equal(calls.length, 1, 'no dispatch after cancel');
  assert.equal(Object.keys(store.getTranslationArchive(pid, 'de').blocks).length, 0);
  assert.equal(coord.getRun(run.runId), null);
});

test('cancel observed during the repairing phase fires no further provider call', async () => {
  const blocks = [B(PARA_5A), B(PARA_5B)];
  const pid = 'coord-cancel-repair';
  setupProject(pid, blocks);
  const plan = planFor(blocks, 1000);
  assert.equal(plan.chunks.length, 1, 'fixture sanity: single chunk');

  // Every response is structurally invalid → the run enters 'repairing'.
  const fake = gatedTranslator(() => ({ segments: [] }));
  const coord = createTranslationCoordinator({ store, translate: fake.translate });
  const run = coord.startAutomatic({ projectId: pid, language: 'de', plan });

  // Cancel synchronously from inside the 'repairing' phase update — before
  // the driver can loop around to dispatch the repair ask.
  let cancelledHere = false;
  run.on('update', (snap) => {
    if (!cancelledHere && snap.state === 'repairing') {
      cancelledHere = true;
      run.cancel();
    }
  });

  fake.release(1); // invalid response arrives → validating → repairing → cancel lands
  const final = await run.promise;

  assert.ok(cancelledHere, 'cancel was requested during repairing');
  assert.equal(final.state, 'cancelled');
  assert.equal(final.error, null);
  assert.equal(final.chunks[0].status, 'cancelled');
  assert.equal(fake.calls.length, 1, 'no repair ask dispatched after cancel was observed');
  assert.equal(coord.getRun(run.runId), null);
});

test('an unknown null rejection ends the run typed INTERNAL; duck-typed AppErrors keep their code', async () => {
  const blocks = [B(PARA_5A), B(PARA_5B)];
  const pid = 'coord-unknown-reject';
  setupProject(pid, blocks);
  const plan = planFor(blocks, 1000);

  // A raw null rejection used to crash `err.message` dereferencing and leave
  // the run promise unresolved; it must resolve as a typed terminal failure.
  const coord = createTranslationCoordinator({ store, translate: () => Promise.reject(null) });
  const run = coord.startAutomatic({ projectId: pid, language: 'de', plan });
  const final = await run.promise;

  assert.equal(final.state, 'failed');
  assert.equal(final.chunks[0].status, 'failed');
  assert.equal(final.error.code, 'INTERNAL');
  assert.match(final.error.message, /null/);
  assert.equal(Object.keys(store.getTranslationArchive(pid, 'de').blocks).length, 0);

  // Duck-typed AppError rejections preserve their typed code and message.
  const duckCoord = createTranslationCoordinator({
    store,
    translate: () => Promise.reject({ code: 'MODEL_UNAVAILABLE', message: 'local model busy' }),
  });
  const duckRun = duckCoord.startAutomatic({ projectId: pid, language: 'de', plan });
  const duckFinal = await duckRun.promise;
  assert.equal(duckFinal.state, 'failed');
  assert.equal(duckFinal.error.code, 'MODEL_UNAVAILABLE');
  assert.equal(duckFinal.error.message, 'local model busy');
});

// --- Review-2 residuals: boundary cancellation precedence, contract drift,
// --- fail-then-cancel error clearing --------------------------------------------

test('cancel from a validating progress update discards the valid response before commit', async () => {
  const blocks = [B(PARA_5A), B(PARA_5B)];
  const pid = 'coord-cancel-validating';
  setupProject(pid, blocks);
  const plan = planFor(blocks, 1000);
  assert.equal(plan.chunks.length, 1, 'fixture sanity: single chunk');
  const revBefore = readRevision(pid);

  const fake = echoTranslator();
  const coord = createTranslationCoordinator({ store, translate: fake.translate });
  const run = coord.startAutomatic({ projectId: pid, language: 'de', plan });

  // Cancel synchronously from inside the 'validating' phase update: the
  // provider response has already resolved, but it must never be accepted
  // into commit.
  let cancelledHere = false;
  run.on('update', (snap) => {
    if (!cancelledHere && snap.state === 'validating') {
      cancelledHere = true;
      run.cancel();
    }
  });

  const final = await run.promise;

  assert.ok(cancelledHere, 'cancel was requested during validating');
  assert.equal(final.state, 'cancelled');
  assert.equal(final.error, null);
  assert.equal(final.chunks[0].status, 'cancelled');
  assert.deepEqual(final.chunks[0].blocks.map((b) => b.status), ['uncommitted', 'uncommitted']);
  assert.equal(Object.keys(store.getTranslationArchive(pid, 'de').blocks).length, 0, 'nothing written');
  assert.equal(readRevision(pid), revBefore, 'no revision burned');
  assert.equal(coord.getRun(run.runId), null);
});

test('cancel from a committing progress update lets no write land', async () => {
  const blocks = [B(PARA_5A), B(PARA_5B)];
  const pid = 'coord-cancel-committing';
  setupProject(pid, blocks);
  const plan = planFor(blocks, 1000);
  assert.equal(plan.chunks.length, 1, 'fixture sanity: single chunk');
  const revBefore = readRevision(pid);

  const fake = echoTranslator();
  const coord = createTranslationCoordinator({ store, translate: fake.translate });
  const run = coord.startAutomatic({ projectId: pid, language: 'de', plan });

  // Cancel synchronously from inside the 'committing' phase update: the
  // write about to run must never land.
  let cancelledHere = false;
  run.on('update', (snap) => {
    if (!cancelledHere && snap.state === 'committing') {
      cancelledHere = true;
      run.cancel();
    }
  });

  const final = await run.promise;

  assert.ok(cancelledHere, 'cancel was requested during committing');
  assert.equal(final.state, 'cancelled');
  assert.equal(final.error, null);
  assert.equal(final.chunks[0].status, 'cancelled');
  assert.deepEqual(final.chunks[0].blocks.map((b) => b.status), ['uncommitted', 'uncommitted']);
  assert.equal(Object.keys(store.getTranslationArchive(pid, 'de').blocks).length, 0, 'nothing written');
  assert.equal(readRevision(pid), revBefore, 'no revision burned');
  assert.equal(coord.getRun(run.runId), null);
});

test('an authoritative cancel beats stale classification when SOURCE_CHANGED races the commit', async () => {
  const blocks = [B(PARA_5A), B(PARA_5B)];
  const pid = 'coord-cancel-stale';
  setupProject(pid, blocks);
  const plan = planFor(blocks, 1000);
  assert.equal(plan.chunks.length, 1, 'fixture sanity: single chunk');
  const revBefore = readRevision(pid);

  // The store wrapper cancels WHILE failing the write: the exact window in
  // which a stale verdict and an outstanding cancel coexist. Precedence
  // requires the cancel to win — cancelled terminal with the stale response
  // discarded, never failed wearing the stale error.
  let run;
  const coord = createTranslationCoordinator({
    store: {
      loadDocumentProject: (...args) => store.loadDocumentProject(...args),
      getTranslationArchive: (...args) => store.getTranslationArchive(...args),
      loadDocumentArchive: (...args) => store.loadDocumentArchive(...args),
      saveTranslations: (...args) => {
        run.cancel();
        throw createAppError(
          'SOURCE_CHANGED',
          `block "${blocks[0].blockId}" changed while the commit raced a cancel`,
        );
      },
    },
    translate: echoTranslator().translate,
  });
  run = coord.startAutomatic({ projectId: pid, language: 'de', plan });

  const final = await run.promise;

  assert.equal(final.state, 'cancelled');
  assert.equal(final.error, null, 'the stale verdict must not surface past an authoritative cancel');
  assert.equal(final.chunks[0].status, 'cancelled');
  assert.deepEqual(final.chunks[0].blocks.map((b) => b.status), ['uncommitted', 'uncommitted']);
  assert.equal(Object.keys(store.getTranslationArchive(pid, 'de').blocks).length, 0);
  assert.equal(readRevision(pid), revBefore);
  assert.equal(coord.getRun(run.runId), null);
});

test('fail-then-cancel ends cancelled with error cleared, never preserving the chunk failure', async () => {
  const blocks = [B(PARA_5A), B(PARA_5B), B(PARA_4A), B(PARA_4B)];
  const pid = 'coord-fail-then-cancel';
  setupProject(pid, blocks);
  const plan = planFor(blocks, 10);
  assert.equal(plan.chunks.length, 2, 'fixture sanity: two-chunk plan');

  // Chunk1's ask rejects: a non-terminal chunk failure sets run.error and
  // the driver continues. Cancelling from that very failure update must end
  // the run AUTHORITATIVELY cancelled — fatal error cleared on the
  // cancelled snapshot ("null unless the run failed"), not preserved.
  const calls = [];
  const coord = createTranslationCoordinator({
    store,
    translate: async (request) => {
      calls.push(request);
      if (calls.length === 1) {
        throw createAppError('PROVIDER_ERROR', 'chunk1 provider died');
      }
      return {
        segments: request.segments.map((s) => ({ blockId: s.blockId, text: `[de] ${s.text}` })),
      };
    },
  });
  const run = coord.startAutomatic({ projectId: pid, language: 'de', plan });
  let cancelledHere = false;
  run.on('update', (snap) => {
    if (!cancelledHere && snap.chunks.some((c) => c.status === 'failed')) {
      cancelledHere = true;
      run.cancel();
    }
  });

  const final = await run.promise;

  assert.ok(cancelledHere, 'cancel was requested after the chunk failure');
  assert.equal(final.state, 'cancelled');
  assert.equal(final.error, null, 'a cancelled snapshot carries no earlier fatal error');
  assert.deepEqual(final.chunks.map((c) => c.status), ['failed', 'cancelled']);
  assert.equal(calls.length, 1, 'the pending chunk was swept without another dispatch');
  assert.equal(Object.keys(store.getTranslationArchive(pid, 'de').blocks).length, 0);
  assert.equal(coord.getRun(run.runId), null);
});

test('TranslationBlockStatus stays aligned with every block status the coordinator emits', async () => {
  // Parse the typed union straight from the contract source so any drift
  // between documents.ts and runtime snapshots fails this suite loudly.
  const contractsSource = fs.readFileSync(
    path.join(__dirname, '..', 'shared', 'contracts', 'documents.ts'),
    'utf8',
  );
  const declared = new Set(
    [...contractsSource.match(/export type TranslationBlockStatus =([\s\S]*?);\n/)[1].matchAll(/'([a-z][a-z-]*)'/g)].map(
      (m) => m[1],
    ),
  );
  assert.ok(declared.size >= 6, 'fixture sanity: union members parsed');

  // Observed universe: EVERY block status on EVERY snapshot the runtime
  // emits for the fixture set below, which drives EVERY producer path
  // end-to-end — written rows (statusForBlock), reporting rows
  // ('buffered'/'uncommitted'/'protected'), cancellation discard rows
  // (_settleCancelledInFlight/_sweepPending), stale discard rows
  // (_commitPhase catch), and terminal failure rows (_failChunk /
  // _abortOnStorageFailure). Both intermediate 'update' snapshots AND the
  // terminal snapshots are accumulated, so a status that only ever shows
  // up mid-run — or only in a swept/discard row — is still caught.
  // start*() emit one synchronous 'preparing' update before returning (it
  // carries no block rows yet) and drive on a microtask, so a listener
  // attached right after the handle is returned sees every later snapshot.
  const observed = new Set();
  const collect = (snap) => {
    for (const chunk of snap.chunks) {
      for (const block of chunk.blocks) observed.add(block.status);
    }
  };
  /** Collect every 'update' snapshot of `run` plus its terminal snapshot. */
  const observe = async (run) => {
    run.on('update', collect);
    const final = await run.promise;
    collect(final); // the terminal snapshot rides 'end'/promise, not 'update'
    return final;
  };

  // approved — clean automatic commit (_commitChunk written row).
  {
    const blocks = [B(PARA_4A)];
    const pid = 'drift-approved';
    setupProject(pid, blocks);
    const coord = createTranslationCoordinator({ store, translate: echoTranslator().translate });
    const final = await observe(coord.startAutomatic({ projectId: pid, language: 'de', plan: planFor(blocks, 1000) }));
    // Path-specific pin: this fixture is the only producer of a WRITTEN
    // 'approved' row among these fixtures besides drift-cancel's committed
    // chunk — a statusForBlock mutation fails HERE even though the global
    // set equality stays unchanged.
    assert.deepEqual(
      final.chunks[0].blocks,
      [{ blockId: blocks[0].blockId, status: 'approved' }],
      'fixture sanity: automatic clean commit writes the approved row',
    );
  }

  // needs-review — suspicious automatic output (target echoes source verbatim).
  {
    const blocks = [B(PARA_4A)];
    const pid = 'drift-needs-review';
    setupProject(pid, blocks);
    const coord = createTranslationCoordinator({
      store,
      translate: async (request) => ({
        segments: request.segments.map((s) => ({ blockId: s.blockId, text: s.text })),
      }),
    });
    const final = await observe(coord.startAutomatic({ projectId: pid, language: 'de', plan: planFor(blocks, 1000) }));
    assert.deepEqual(
      final.chunks[0].blocks,
      [{ blockId: blocks[0].blockId, status: 'needs-review' }],
      'fixture sanity: verbatim echo lands the needs-review written row',
    );
  }

  // draft + buffered — manual-chunk expansion over a D3-split long block:
  // earlier expanded chunks report their slices 'buffered', the
  // last-touching chunk commits the merged whole-block 'draft'.
  {
    const longText = Array.from(
      { length: 6 },
      (_, i) => `Sentence number ${i + 1} of the long paragraph.`,
    ).join(' ');
    const blocks = [B(longText)];
    const pid = 'drift-manual-split';
    setupProject(pid, blocks);
    const plan = planFor(blocks, 10);
    assert.ok(plan.chunks.length >= 2, 'fixture sanity: split across chunks');
    const coord = createTranslationCoordinator({ store, translate: echoTranslator().translate });
    const final = await observe(
      coord.startManualChunk({ projectId: pid, language: 'de', plan, chunkId: plan.chunks[0].chunkId }),
    );
    assert.equal(final.state, 'completed', 'fixture sanity: manual expansion completed');
    // Path-specific pins: every intermediate expansion chunk buffers the
    // split block; ONLY the last-touching chunk writes — the MERGED
    // whole-block draft row.
    const longBlockId = blocks[0].blockId;
    for (const chunk of final.chunks.slice(0, -1)) {
      assert.deepEqual(
        chunk.blocks,
        [{ blockId: longBlockId, status: 'buffered' }],
        'fixture sanity: intermediate expansion chunks report buffered rows',
      );
    }
    assert.deepEqual(
      final.chunks[final.chunks.length - 1].blocks,
      [{ blockId: longBlockId, status: 'draft' }],
      'fixture sanity: last-touching chunk commits the merged whole-block draft',
    );
  }

  // draft + uncommitted — targeted intent, both producer shapes: a
  // full-block fragment writes a 'draft' row through the archive; a
  // partial fragment is reported ('uncommitted') but never written.
  {
    const blocks = [B(PARA_4A)];
    const pid = 'drift-targeted';
    setupProject(pid, blocks);
    const coord = createTranslationCoordinator({ store, translate: echoTranslator().translate });
    const full = await observe(
      coord.startTargeted({
        projectId: pid,
        language: 'de',
        fragments: [{ blockId: blocks[0].blockId }],
      }),
    );
    assert.equal(full.state, 'completed', 'fixture sanity: full-block fragment committed');
    assert.deepEqual(
      full.chunks[0].blocks,
      [{ blockId: blocks[0].blockId, status: 'draft' }],
      'fixture sanity: full-block fragment WRITES the draft row',
    );
    const partial = await observe(
      coord.startTargeted({
        projectId: pid,
        language: 'de',
        fragments: [
          { blockId: blocks[0].blockId, charStart: 0, charEnd: Math.floor(PARA_4A.length / 2) },
        ],
      }),
    );
    assert.equal(partial.state, 'completed', 'fixture sanity: partial fragment reported');
    assert.deepEqual(
      partial.chunks[0].blocks,
      [{ blockId: blocks[0].blockId, status: 'uncommitted' }],
      'fixture sanity: partial fragment REPORTS uncommitted without writing',
    );
  }

  // protected — protect block AND span policies in one automatic batch:
  // policy-covered slices are never sent and report 'protected'.
  {
    const b1 = B(PARA_5A);
    const b2 = B(PARA_5B);
    const pid = 'drift-protected';
    setupProject(pid, [b1, b2]);
    let rev = readRevision(pid);
    ({ revision: rev } = store.setBlockPolicy(pid, b1.blockId, { action: 'protect' }, rev));
    ({ revision: rev } = store.setSpanPolicy(pid, `${b2.blockId}-s0`, { action: 'protect' }, rev));
    const coord = createTranslationCoordinator({ store, translate: echoTranslator().translate });
    const final = await observe(
      coord.startAutomatic({ projectId: pid, language: 'de', plan: planFor([b1, b2], 1000) }),
    );
    assert.deepEqual(
      final.chunks[0].blocks.map((b) => b.status),
      ['protected', 'protected'],
      'fixture sanity: both protection policies reported',
    );
  }

  // failed — a throwing provider marks every block row failed (_failChunk).
  {
    const blocks = [B(PARA_4A)];
    const pid = 'drift-failed';
    setupProject(pid, blocks);
    const coord = createTranslationCoordinator({
      store,
      translate: () => Promise.reject(createAppError('PROVIDER_ERROR', 'boom')),
    });
    const final = await observe(
      coord.startAutomatic({ projectId: pid, language: 'de', plan: planFor(blocks, 1000) }),
    );
    assert.equal(final.state, 'failed', 'fixture sanity: provider throw failed the run');
    assert.deepEqual(
      final.chunks[0].blocks,
      [{ blockId: blocks[0].blockId, status: 'failed' }],
      'fixture sanity: provider throw marks rows failed (_failChunk)',
    );
  }

  // uncommitted — cancel mid-run: the in-flight response is discarded
  // (_settleCancelledInFlight) and pending chunks are swept, every touched
  // block of both reporting 'uncommitted'.
  {
    const blocks = [B(PARA_5A), B(PARA_5B), B(PARA_5C), B(PARA_5D), B(PARA_4A), B(PARA_4B)];
    const pid = 'drift-cancel';
    setupProject(pid, blocks);
    const plan = planFor(blocks, 10);
    assert.equal(plan.chunks.length, 3, 'fixture sanity: three-chunk plan');
    const fake = gatedTranslator((request) => ({
      segments: request.segments.map((s) => ({
        blockId: s.blockId,
        charStart: s.charStart,
        charEnd: s.charEnd,
        text: `[de] ${s.text}`,
      })),
    }));
    const coord = createTranslationCoordinator({ store, translate: fake.translate });
    const run = coord.startAutomatic({ projectId: pid, language: 'de', plan });
    run.on('update', collect); // attached pre-dispatch: no block-bearing snapshot missed
    fake.release(1); // chunk1 translates and commits
    await waitFor(() => fake.calls.length === 2, 'chunk2 to be dispatched');
    run.cancel(); // authoritative while chunk2 is in flight
    fake.release(1);
    const final = await run.promise;
    collect(final);
    assert.equal(final.state, 'cancelled', 'fixture sanity: mid-run cancel settled');
    assert.deepEqual(final.chunks.map((c) => c.status), ['committed', 'cancelled', 'cancelled']);
    assert.deepEqual(
      final.chunks[2].blocks.map((b) => b.status),
      ['uncommitted', 'uncommitted'],
      'fixture sanity: swept pending chunks carry discard rows',
    );
    // Path-specific pin: chunk1 was IN FLIGHT when cancel() fired — its
    // discard rows come from _settleCancelledInFlight's _uncommittedRows,
    // not the pending sweep asserted above.
    assert.deepEqual(
      final.chunks[1].blocks,
      [
        { blockId: blocks[2].blockId, status: 'uncommitted' },
        { blockId: blocks[3].blockId, status: 'uncommitted' },
      ],
      'fixture sanity: cancelled in-flight chunk carries discard rows (_settleCancelledInFlight)',
    );
  }

  // uncommitted — PAUSED-CANCEL: pause parks the driver at a chunk edge
  // (after the in-flight chunk settles), and cancelling FROM the paused
  // state takes cancel()'s synchronous paused-state sweep + finish — the
  // direct sweep call site, not _settleCancelledInFlight and not the
  // driver-loop check. Its swept discard rows join the observed universe.
  {
    const blocks = [B(PARA_5A), B(PARA_5B), B(PARA_5C), B(PARA_5D), B(PARA_4A), B(PARA_4B)];
    const pid = 'drift-paused-cancel';
    setupProject(pid, blocks);
    const plan = planFor(blocks, 10);
    assert.equal(plan.chunks.length, 3, 'fixture sanity: three-chunk plan');
    const fake = gatedTranslator((request) => ({
      segments: request.segments.map((s) => ({
        blockId: s.blockId,
        charStart: s.charStart,
        charEnd: s.charEnd,
        text: `[de] ${s.text}`,
      })),
    }));
    const coord = createTranslationCoordinator({ store, translate: fake.translate });
    const run = coord.startAutomatic({ projectId: pid, language: 'de', plan });
    run.on('update', collect); // attached pre-dispatch: no block-bearing snapshot missed
    await waitFor(() => fake.calls.length === 1, 'chunk1 to be dispatched');
    run.pause(); // parks at the next chunk edge; chunk1 settles through commit first
    fake.release(1);
    await waitFor(() => run.state === 'paused', 'driver parked at the chunk boundary');
    assert.equal(fake.calls.length, 1, 'fixture sanity: paused before chunk2 dispatch');
    run.cancel(); // FROM the paused state: synchronous sweep inside cancel()
    const final = await run.promise;
    collect(final); // swept rows join the observed universe
    assert.equal(final.state, 'cancelled', 'fixture sanity: paused-state cancel ended the run');
    assert.equal(final.error, null, 'fixture sanity: cancelled is not failed');
    assert.deepEqual(final.chunks.map((c) => c.status), ['committed', 'cancelled', 'cancelled']);
    assert.deepEqual(
      final.chunks[0].blocks,
      [
        { blockId: blocks[0].blockId, status: 'approved' },
        { blockId: blocks[1].blockId, status: 'approved' },
      ],
      'fixture sanity: committed chunk kept its approved rows across pause+cancel',
    );
    assert.deepEqual(
      final.chunks[1].blocks,
      [
        { blockId: blocks[2].blockId, status: 'uncommitted' },
        { blockId: blocks[3].blockId, status: 'uncommitted' },
      ],
      'fixture sanity: first swept chunk carries uncommitted rows',
    );
    assert.deepEqual(
      final.chunks[2].blocks,
      [
        { blockId: blocks[4].blockId, status: 'uncommitted' },
        { blockId: blocks[5].blockId, status: 'uncommitted' },
      ],
      'fixture sanity: second swept chunk carries uncommitted rows',
    );
  }

  // uncommitted — SOURCE_CHANGED staleness: a source edit under the
  // in-flight chunk makes its commit stale; the chunk AND every pending
  // chunk are swept with 'uncommitted' rows, and nothing is written.
  {
    const blocks = [B(PARA_5A), B(PARA_5B), B(PARA_5C), B(PARA_5D)];
    const pid = 'drift-stale';
    setupProject(pid, blocks);
    const plan = planFor(blocks, 10);
    assert.equal(plan.chunks.length, 2, 'fixture sanity: two-chunk plan');
    const fake = gatedTranslator((request) => ({
      segments: request.segments.map((s) => ({
        blockId: s.blockId,
        charStart: s.charStart,
        charEnd: s.charEnd,
        text: `[de] ${s.text}`,
      })),
    }));
    const coord = createTranslationCoordinator({ store, translate: fake.translate });
    const run = coord.startAutomatic({ projectId: pid, language: 'de', plan });
    run.on('update', collect); // attached pre-dispatch: no block-bearing snapshot missed
    await waitFor(() => fake.calls.length === 1, 'chunk1 to be dispatched');
    store.updateBlockText(pid, blocks[0].blockId, 'Edited source text.', readRevision(pid));
    fake.release(1);
    const final = await run.promise;
    collect(final);
    assert.equal(final.state, 'failed');
    assert.equal(final.error.code, 'SOURCE_CHANGED', 'fixture sanity: staleness detected');
    assert.equal(final.chunks[0].status, 'stale');
    assert.deepEqual(
      final.chunks[1].blocks.map((b) => b.status),
      ['uncommitted', 'uncommitted'],
      'fixture sanity: swept pending chunks carry discard rows',
    );
    // Path-specific pin: chunk0 went STALE at commit — its discard rows
    // come from the commit catch's _uncommittedRows, not the pending
    // sweep asserted above.
    assert.deepEqual(
      final.chunks[0].blocks,
      [
        { blockId: blocks[0].blockId, status: 'uncommitted' },
        { blockId: blocks[1].blockId, status: 'uncommitted' },
      ],
      'fixture sanity: stale in-flight chunk carries discard rows (commit-catch _uncommittedRows)',
    );
  }

  // failed — a post-lease storage failure TERMINATES the run
  // (_abortOnStorageFailure): the failing chunk and every pending chunk it
  // sweeps report 'failed' rows.
  {
    const blocks = [B(PARA_5A), B(PARA_5B), B(PARA_5C), B(PARA_5D), B(PARA_4A), B(PARA_4B)];
    const pid = 'drift-storage-fail';
    setupProject(pid, blocks);
    const plan = planFor(blocks, 10);
    assert.equal(plan.chunks.length, 3, 'fixture sanity: three-chunk plan');
    // Injection seam: the NEXT translation content write throws AFTER the
    // D2 lease (armed before the run, so chunk1's commit is the casualty).
    class FlakyStore extends DocumentProjectStore {
      constructor() {
        super({ baseDir: rootDir });
        this.failNextTranslationWrite = true;
      }
      _applyContentPlan(planArg) {
        if (this.failNextTranslationWrite && !planArg.unlink && planArg.filePath.endsWith('de.json')) {
          const err = new Error('injected post-lease EIO');
          err.code = 'EIO';
          throw err;
        }
        return super._applyContentPlan(planArg);
      }
    }
    const flaky = new FlakyStore();
    const coord = createTranslationCoordinator({ store: flaky, translate: echoTranslator().translate });
    const final = await observe(
      coord.startAutomatic({ projectId: pid, language: 'de', plan }),
    );
    assert.equal(final.state, 'failed', 'fixture sanity: storage failure aborted the run');
    assert.equal(final.error.code, 'INTERNAL');
    assert.deepEqual(
      final.chunks[0].blocks.map((b) => b.status),
      ['failed', 'failed'],
      'fixture sanity: failing chunk carries failed rows',
    );
    assert.ok(
      final.chunks.slice(1).every((c) => c.blocks.every((b) => b.status === 'uncommitted')),
      'fixture sanity: swept pending chunks carry discard rows (_sweepPending)',
    );
  }

  // Runtime ⊆ contract: every block status ever emitted — on ANY update or
  // terminal snapshot of ANY producer path above — must be representable.
  for (const status of [...observed].sort()) {
    assert.ok(
      declared.has(status),
      `emitted block status "${status}" is missing from TranslationBlockStatus`,
    );
  }

  // Contract ⊆ runtime — EXACT set equality between the declared union and
  // the OBSERVED runtime universe: a member no producer path emits anymore
  // (the union once carried an unused 'committed') fails just as loudly as
  // a missing member. No hand-written mirror list sits in between.
  assert.deepEqual(
    [...declared].sort(),
    [...observed].sort(),
    'TranslationBlockStatus drifted from the statuses the coordinator emits',
  );
});

// --- Commit/storage failures are TERMINAL for the run (review 1.3) -------------------

test('a post-lease commit/storage failure is terminal: no later dispatch, intent recoverable, honest accounting', async () => {
  const blocks = [
    B(PARA_5A),
    B(PARA_5B),
    B(PARA_5C),
    B(PARA_5D),
    B(PARA_4A),
    B(PARA_4B),
  ];
  const pid = 'coord-storage-fail';
  setupProject(pid, blocks);
  const plan = planFor(blocks, 10);
  assert.equal(plan.chunks.length, 3, 'fixture sanity: three-chunk plan');

  // Injection seam: the NEXT translation content write throws AFTER the D2
  // lease (revision already durably bumped; the WAL intent stays behind).
  class FlakyStore extends DocumentProjectStore {
    constructor() {
      super({ baseDir: rootDir });
      this.failNextTranslationWrite = false;
    }
    _applyContentPlan(planArg) {
      if (this.failNextTranslationWrite && !planArg.unlink && planArg.filePath.endsWith('de.json')) {
        this.failNextTranslationWrite = false;
        const err = new Error('injected post-lease EIO');
        err.code = 'EIO';
        throw err;
      }
      return super._applyContentPlan(planArg);
    }
  }
  const flaky = new FlakyStore();
  const fake = gatedTranslator((request) => ({
    segments: request.segments.map((s) => ({
      blockId: s.blockId,
      charStart: s.charStart,
      charEnd: s.charEnd,
      text: `[de] ${s.text}`,
    })),
  }));
  const coord = createTranslationCoordinator({ store: flaky, translate: fake.translate });
  const run = coord.startAutomatic({ projectId: pid, language: 'de', plan });

  await waitFor(() => fake.calls.length === 1, 'chunk1 to be dispatched');
  fake.release(1); // chunk1 translates and commits
  await waitFor(() => fake.calls.length === 2, 'chunk2 to be dispatched');
  flaky.failNextTranslationWrite = true;
  fake.release(1); // chunk2 translates fine but its COMMIT throws post-lease

  const final = await run.promise;

  // Terminal: typed error surfaced, failing chunk failed, pending work stopped.
  assert.equal(final.state, 'failed');
  assert.equal(final.error.code, 'INTERNAL');
  assert.match(final.error.message, /injected post-lease EIO/);
  assert.deepEqual(final.chunks.map((c) => c.status), ['committed', 'failed', 'failed']);
  assert.deepEqual(final.chunks[1].blocks.map((b) => b.status), ['failed', 'failed']);
  assert.deepEqual(final.chunks[2].blocks.map((b) => b.status), ['uncommitted', 'uncommitted']);
  assert.equal(fake.calls.length, 2, 'no provider dispatch after the storage failure');
  assert.equal(coord.getRun(run.runId), null);

  // Durable accounting: the post-lease crash retained its WAL intent and the
  // leased revision; the next project load replays the intent exactly once
  // (D2 recovery) without burning another revision.
  const intentPath = path.join(rootDir, `${pid}.mutation-intent.json`);
  assert.ok(fs.existsSync(intentPath), 'post-lease intent retained on disk');
  const leasedRevision = readRevision(pid);
  flaky.loadDocumentProject(pid);
  assert.equal(readRevision(pid), leasedRevision, 'recovery replays content, not another lease');
  assert.ok(!fs.existsSync(intentPath), 'intent cleared after recovery');
  const archive = flaky.getTranslationArchive(pid, 'de');
  for (const block of blocks.slice(0, 4)) {
    assert.equal(archive.blocks[block.blockId].text, `[de] ${block.text}`);
    assert.equal(archive.blocks[block.blockId].sourceHash, blockSourceHash(block));
  }
  assert.equal(archive.blocks[blocks[4].blockId], undefined, 'chunk3 never ran or wrote');
  assert.equal(archive.blocks[blocks[5].blockId], undefined);
});

// --- Manual-chunk expansion over D3-split blocks (review 1.4) ------------------------

test('startManualChunk expands a partial chunk of a split block and commits the whole merged draft', async () => {
  const longText = Array.from(
    { length: 6 },
    (_, i) => `Sentence number ${i + 1} of the long paragraph.`,
  ).join(' ');
  const block = B(longText);
  const pid = 'coord-manual-split';
  setupProject(pid, [block]);

  // Tiny budget forces D3 to split the paragraph across several chunks.
  const plan = planFor([block], 10);
  assert.ok(plan.chunks.length >= 3, 'fixture sanity: split into several chunks');
  const covered = plan.chunks
    .flatMap((c) => c.slices)
    .sort((a, b) => a.charStart - b.charStart);
  for (const slice of covered) assert.equal(slice.blockId, block.blockId);
  assert.equal(covered[0].charStart, 0, 'fixture sanity: tiling starts at 0');
  assert.equal(covered[covered.length - 1].charEnd, longText.length, 'fixture sanity: tiling covers all');

  const fake = echoTranslator();
  const coord = createTranslationCoordinator({ store, translate: fake.translate });
  const revBefore = Number(readRevision(pid));
  const run = coord.startManualChunk({
    projectId: pid,
    language: 'de',
    plan,
    chunkId: plan.chunks[0].chunkId, // only ONE slice of the split block
  });
  const final = await run.promise;

  // The run expanded to EVERY plan chunk carrying a slice of the block.
  assert.deepEqual(final.chunks.map((c) => c.chunkId), plan.chunks.map((c) => c.chunkId));
  assert.equal(fake.calls.length, plan.chunks.length, 'one ask per expanded chunk');
  assert.equal(final.state, 'completed');
  assert.equal(final.error, null);
  assert.equal(final.blocksTotal, 1);
  assert.equal(final.blocksDone, 1);
  // Earlier chunks buffered their slice; the last-touching chunk committed.
  assert.equal(final.chunks[0].blocks[0].status, 'buffered');
  assert.equal(final.chunks[final.chunks.length - 1].blocks[0].status, 'draft');

  // The WHOLE block translation landed as a draft — not just the slice the
  // requested chunk carried.
  const entry = store.getTranslationArchive(pid, 'de').blocks[block.blockId];
  const expected = covered.map((s) => `[de] ${longText.slice(s.charStart, s.charEnd)}`).join('');
  assert.equal(entry.text, expected);
  assert.equal(entry.sourceHash, blockSourceHash(block));
  assert.equal(entry.status, 'draft');

  // Exactly ONE durable commit for the whole expanded run; block is fresh.
  assert.equal(Number(readRevision(pid)), revBefore + 1);
  const report = store.freshness(pid, 'de');
  assert.equal(report.fresh, 1);
});

// --- Suspicious automatic output lands needs-review in the archive (review 1.5) -----

test('suspicious automatic output commits into the archive as needs-review, never approved', async () => {
  const blocks = [B(PARA_5A), B(PARA_4A)];
  const pid = 'coord-suspicious';
  setupProject(pid, blocks);
  const plan = planFor(blocks, 1000);
  assert.equal(plan.chunks.length, 1, 'fixture sanity: single chunk');

  // Provider echoes the source back verbatim → 'identical' suspicion.
  const fake = scriptedTranslator([], (request) => ({
    segments: request.segments.map((s) => ({ blockId: s.blockId, text: s.text })),
  }));
  const coord = createTranslationCoordinator({ store, translate: fake.translate });
  const run = coord.startAutomatic({ projectId: pid, language: 'de', plan });
  const final = await run.promise;

  assert.equal(final.state, 'completed');
  assert.equal(final.error, null);
  assert.equal(final.chunks[0].status, 'needs-review');
  assert.deepEqual(final.chunks[0].blocks.map((b) => b.status), ['needs-review', 'needs-review']);
  // Flagged work still counts as processed progress (done statuses).
  assert.equal(final.chunksDone, 1);
  assert.equal(final.blocksDone, 2);
  assert.equal(final.blocksTotal, 2);
  assert.equal(final.tokensDone, final.tokensTotal);

  const archive = store.getTranslationArchive(pid, 'de');
  assert.equal(archive.blocks[blocks[0].blockId].text, PARA_5A);
  assert.equal(archive.blocks[blocks[0].blockId].status, 'needs-review');
  assert.equal(archive.blocks[blocks[1].blockId].status, 'needs-review');
  const report = store.freshness(pid, 'de');
  assert.equal(report.needsReview, 2);
  assert.equal(report.approved, 0);
});

// --- Protected block/span policies respected during automatic commits (review 1.5) --

test('protected blocks and protected spans are never sent and never committed', async () => {
  const b1 = B(PARA_5A);
  const b2 = B(PARA_5B);
  const b3 = B(PARA_4A);
  const pid = 'coord-protected';
  setupProject(pid, [b1, b2, b3]);
  let rev = readRevision(pid);
  ({ revision: rev } = store.setBlockPolicy(pid, b2.blockId, { action: 'protect' }, rev));
  ({ revision: rev } = store.setSpanPolicy(pid, `${b3.blockId}-s0`, { action: 'protect' }, rev));

  const plan = planFor([b1, b2, b3], 1000);
  assert.equal(plan.chunks.length, 1, 'fixture sanity: single chunk');

  const fake = echoTranslator();
  const coord = createTranslationCoordinator({ store, translate: fake.translate });
  const run = coord.startAutomatic({ projectId: pid, language: 'de', plan });
  const final = await run.promise;

  assert.equal(final.state, 'completed');
  assert.equal(final.error, null);
  // Only the unprotected block ever reached the provider.
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0].segments, [
    { blockId: b1.blockId, charStart: 0, charEnd: PARA_5A.length, text: PARA_5A },
  ]);
  assert.deepEqual(final.chunks[0].blocks, [
    { blockId: b1.blockId, status: 'approved' },
    { blockId: b2.blockId, status: 'protected' },
    { blockId: b3.blockId, status: 'protected' },
  ]);
  // Protected content never counts as writable progress.
  assert.equal(final.blocksTotal, 1);
  assert.equal(final.blocksDone, 1);

  const archive = store.getTranslationArchive(pid, 'de');
  assert.equal(archive.blocks[b1.blockId].text, `[de] ${PARA_5A}`);
  assert.equal(archive.blocks[b1.blockId].status, 'approved');
  assert.equal(archive.blocks[b2.blockId], undefined, 'block-protected content untouched');
  assert.equal(archive.blocks[b3.blockId], undefined, 'span-protected content untouched');
  const report = store.freshness(pid, 'de');
  assert.equal(report.fresh, 1);
  assert.equal(report.missing, 2);
});

// --- Per-successful-chunk ProjectV3 revision chain (review 1.5) ----------------------

test('each successful chunk commit advances the project revision by exactly one', async () => {
  const blocks = [B(PARA_5A), B(PARA_5B), B(PARA_4A), B(PARA_4B)];
  const pid = 'coord-revision-chain';
  setupProject(pid, blocks);
  const plan = planFor(blocks, 10);
  assert.equal(plan.chunks.length, 2, 'fixture sanity: two-chunk plan');
  const revBefore = Number(readRevision(pid));

  const fake = echoTranslator();
  const coord = createTranslationCoordinator({ store, translate: fake.translate });
  const run = coord.startAutomatic({ projectId: pid, language: 'de', plan });
  const revisionsAtCommit = [];
  run.on('update', (snap) => {
    const done = snap.chunks.filter((c) => CHUNK_DONE_STATUSES.has(c.status)).length;
    if (done > revisionsAtCommit.length) revisionsAtCommit.push(Number(readRevision(pid)));
  });
  const final = await run.promise;

  assert.equal(final.state, 'completed');
  // One durable lease+commit per successful chunk: +1 each, no gaps, no burns.
  assert.deepEqual(revisionsAtCommit, [revBefore + 1, revBefore + 2]);
  assert.equal(Number(readRevision(pid)), revBefore + 2);
  assert.equal(final.chunksDone, 2);
});
