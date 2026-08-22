// DOC-03 — Semantic chunk planner tests (plan §10.4, §10.6, §20).
//
// The §20 gate is "stable block chunk plans" proven by "deterministic
// fixtures": every fixture below is hand-computed (token estimates, slice
// ranges, contexts, chunk ids) and asserted with deep equality, plus
// cross-cutting invariants — determinism (two runs deep-equal), coverage
// (every block exactly once, split ranges partitioning the block text),
// budget respected except documented atomic exceptions, bounded context
// windows, and id stability under unrelated edits. Integration runs the
// planner over real imported documents (DOC-01 fixtures).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  createChunkPlan,
  estimateTokens,
  resolveChunkPlannerOptions,
} = require('../electron/main/documents/chunkPlanner.js');
const {
  validateChunkPlan,
  isChunkPlan,
  isChunkPlanForSource,
  validateChunkPlanAgainstSource,
  deriveChunkPlanId,
  DEFAULT_CHUNK_PLANNER_OPTIONS,
} = require('../shared/contracts/documents.ts');
const { getFixture } = require('./fixtures/document-fixtures.js');
const { importDocument } = require('../electron/main/documents/import.js');

// --- Helpers -----------------------------------------------------------------

/** Mirrors the documented chunkId derivation (PlanChunk TSDoc). */
function expectedChunkId(slices) {
  const seed = `1|${slices
    .map((s) => `${s.blockId.length}:${s.blockId}:${s.charStart}:${s.charEnd}`)
    .join(',')}`;
  return `c-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16)}`;
}

let blockCounter = 0;
/** Deterministic synthetic block. */
function B(kind, text, extra = {}) {
  blockCounter++;
  return {
    blockId: extra.blockId ?? `b${blockCounter}`,
    kind,
    part: extra.part ?? 'main',
    index: extra.index ?? blockCounter - 1,
    styleFingerprint: 'fp',
    sourceHash: 'sh',
    text,
    spans: [],
  };
}

/** Minimal normalized-document shell around blocks (planner reads blocks). */
function docOf(blocks) {
  return {
    schemaVersion: 1,
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
    chunkPlans: [],
    translations: {},
  };
}

/** §10.4 invariant: every block covered exactly once, ranges in order. */
function assertCoverage(plan, blocks) {
  const rangesByBlock = new Map();
  const flat = [];
  for (const chunk of plan.chunks) {
    for (const slice of chunk.slices) {
      flat.push(slice);
      const ranges = rangesByBlock.get(slice.blockId) ?? [];
      ranges.push([slice.charStart, slice.charEnd]);
      rangesByBlock.set(slice.blockId, ranges);
    }
  }
  assert.equal(rangesByBlock.size, blocks.length, 'every block appears in the plan');
  let lastIndex = -1;
  const indexById = new Map(blocks.map((b, i) => [b.blockId, i]));
  for (const slice of flat) {
    const idx = indexById.get(slice.blockId);
    assert.ok(idx !== undefined, `slice references known block ${slice.blockId}`);
    assert.ok(idx >= lastIndex, 'slices follow document order');
    lastIndex = idx;
  }
  for (const block of blocks) {
    const ranges = rangesByBlock.get(block.blockId);
    assert.ok(ranges, `block ${block.blockId} covered`);
    let pos = 0;
    for (const [start, end] of ranges) {
      assert.equal(start, pos, `block ${block.blockId} ranges are contiguous`);
      pos = end;
    }
    assert.equal(pos, block.text.length, `block ${block.blockId} fully covered`);
  }
}

/**
 * Budget audit: a chunk may exceed maxTokensPerChunk only at documented
 * overflow points — a slice that is an atomic structural unit (any non-prose
 * kind), a slice larger than the whole budget (one giant sentence/piece), or
 * a slice placed whole although the chunk's remaining room was smaller (an
 * unsplittable single sentence). Every overflow point must be justified.
 */
function assertBudgetRespected(plan, blocks, maxTokens) {
  const kindById = new Map(blocks.map((b) => [b.blockId, b.kind]));
  const PROSE = new Set(['paragraph', 'quote']);
  for (const chunk of plan.chunks) {
    let running = 0;
    const violations = [];
    for (const slice of chunk.slices) {
      const room = maxTokens - running;
      if (slice.tokenEstimate > room) violations.push({ slice, room });
      running += slice.tokenEstimate;
    }
    if (running <= maxTokens) continue;
    assert.ok(violations.length > 0, `chunk ${chunk.chunkId} over budget reports its overflow point`);
    for (const v of violations) {
      const kind = kindById.get(v.slice.blockId);
      const justified =
        !PROSE.has(kind) || // atomic structural unit (heading/verse/list/table/row/empty/other)
        v.slice.tokenEstimate > maxTokens || // one sentence larger than the whole budget
        v.slice.tokenEstimate > v.room; // placed whole although the remainder was smaller
      assert.ok(justified, `overflow at ${v.slice.blockId}:${v.slice.charStart} is an atomic unit`);
    }
  }
}

/** No non-final chunk may END with a heading slice (headings bind forward). */
function assertHeadingsBoundForward(plan, blocks) {
  const kindById = new Map(blocks.map((b) => [b.blockId, b.kind]));
  for (let i = 0; i < plan.chunks.length; i++) {
    const last = plan.chunks[i].slices.at(-1);
    const endsWithHeading = last.charStart === 0 && kindById.get(last.blockId) === 'heading';
    if (endsWithHeading) assert.equal(i, plan.chunks.length - 1, 'only the final chunk may end with a heading');
  }
}

function assertBoundedContext(plan, maxChars) {
  plan.chunks.forEach((chunk, i) => {
    assert.ok(chunk.contextBefore.length <= maxChars, `chunk ${i} contextBefore bounded`);
    assert.ok(chunk.contextAfter.length <= maxChars, `chunk ${i} contextAfter bounded`);
  });
  if (plan.chunks.length > 0) {
    assert.equal(plan.chunks[0].contextBefore, '');
    assert.equal(plan.chunks.at(-1).contextAfter, '');
  }
}

// --- Token estimate ------------------------------------------------------------

test('estimateTokens is the documented ceil(chars/4) heuristic', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('a'), 1);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('x'.repeat(800)), 200);
  assert.equal(estimateTokens('𝕏'), 1); // surrogate pair counts its 2 UTF-16 units
  assert.throws(() => estimateTokens(undefined), TypeError);
});

// --- Options ---------------------------------------------------------------------

test('resolveChunkPlannerOptions applies documented defaults and freezes the result', () => {
  assert.deepEqual(resolveChunkPlannerOptions(undefined), DEFAULT_CHUNK_PLANNER_OPTIONS);
  assert.deepEqual(resolveChunkPlannerOptions({}), DEFAULT_CHUNK_PLANNER_OPTIONS);
  const resolved = resolveChunkPlannerOptions({ maxTokensPerChunk: 64, contextChars: 0 });
  assert.deepEqual(resolved, { maxTokensPerChunk: 64, contextChars: 0 });
  assert.ok(Object.isFrozen(resolved));
});

test('resolveChunkPlannerOptions rejects invalid values loudly', () => {
  for (const bad of [0, -5, 1.5, NaN, Infinity, 'x', null]) {
    assert.throws(() => resolveChunkPlannerOptions({ maxTokensPerChunk: bad }), TypeError);
  }
  for (const bad of [-1, 2.5, NaN, Infinity, 'x', null]) {
    assert.throws(() => resolveChunkPlannerOptions({ contextChars: bad }), TypeError);
  }
  assert.throws(() => resolveChunkPlannerOptions(null), TypeError);
  assert.throws(() => resolveChunkPlannerOptions([1]), TypeError);
  assert.throws(() => resolveChunkPlannerOptions(42), TypeError);
});

// --- Golden: headings + sections ---------------------------------------------------

test('golden: heading opens a new chunk and binds to its section content', () => {
  blockCounter = 0;
  const blocks = [
    B('heading', 'Introduction', { blockId: 'b0' }),
    B('paragraph', 'One two three.', { blockId: 'b1' }),
    B('heading', 'Deep Dive', { blockId: 'b2' }),
    B('paragraph', 'Four five.', { blockId: 'b3' }),
  ];
  const plan = createChunkPlan(docOf(blocks), { maxTokensPerChunk: 8, contextChars: 400 });
  const c0 = {
    chunkId: expectedChunkId([
      { blockId: 'b0', charStart: 0, charEnd: 12 },
      { blockId: 'b1', charStart: 0, charEnd: 14 },
    ]),
    slices: [
      { blockId: 'b0', charStart: 0, charEnd: 12, tokenEstimate: 3 },
      { blockId: 'b1', charStart: 0, charEnd: 14, tokenEstimate: 4 },
    ],
    tokenEstimate: 7,
    contextBefore: '',
    contextAfter: 'Deep DiveFour five.',
  };
  const c1 = {
    chunkId: expectedChunkId([
      { blockId: 'b2', charStart: 0, charEnd: 9 },
      { blockId: 'b3', charStart: 0, charEnd: 10 },
    ]),
    slices: [
      { blockId: 'b2', charStart: 0, charEnd: 9, tokenEstimate: 3 },
      { blockId: 'b3', charStart: 0, charEnd: 10, tokenEstimate: 3 },
    ],
    tokenEstimate: 6,
    contextBefore: 'IntroductionOne two three.',
    contextAfter: '',
  };
  assert.deepEqual(plan, {
    schemaVersion: 1,
    options: { maxTokensPerChunk: 8, contextChars: 400 },
    chunks: [c0, c1],
  });
  assert.ok(isChunkPlan(plan));
  assertCoverage(plan, blocks);
  assertHeadingsBoundForward(plan, blocks);
});

// --- Golden: tables -----------------------------------------------------------------

test('golden: a table group is atomic and may exceed the budget as one unit', () => {
  blockCounter = 0;
  const blocks = [
    B('paragraph', 'aaaaaaa.', { blockId: 'b0' }),
    B('table', 'Header', { blockId: 't0' }),
    B('row', 'a | b', { blockId: 'r0' }),
    B('row', 'c | d', { blockId: 'r1' }),
    B('paragraph', 'tail.', { blockId: 'b4' }),
  ];
  const plan = createChunkPlan(docOf(blocks), { maxTokensPerChunk: 6, contextChars: 400 });
  // b0(2) + table group(2+2+2=6) projects to 8 > 6: atomic exception, the
  // whole table stays in one chunk with its lead-in. 'tail.' opens the next.
  assert.equal(plan.chunks.length, 2);
  assert.deepEqual(
    plan.chunks[0].slices.map((s) => s.blockId),
    ['b0', 't0', 'r0', 'r1'],
  );
  assert.equal(plan.chunks[0].tokenEstimate, 8); // documented exception
  assert.deepEqual(
    plan.chunks[1].slices.map((s) => s.blockId),
    ['b4'],
  );
  assert.deepEqual(plan.chunks[0].slices, [
    { blockId: 'b0', charStart: 0, charEnd: 8, tokenEstimate: 2 },
    { blockId: 't0', charStart: 0, charEnd: 6, tokenEstimate: 2 },
    { blockId: 'r0', charStart: 0, charEnd: 5, tokenEstimate: 2 },
    { blockId: 'r1', charStart: 0, charEnd: 5, tokenEstimate: 2 },
  ]);
  assert.equal(plan.chunks[0].contextAfter, 'tail.');
  assert.equal(plan.chunks[1].contextBefore, 'aaaaaaa.Headera | bc | d');
  assert.ok(isChunkPlan(plan));
  assertCoverage(plan, blocks);
  assertBudgetRespected(plan, blocks, 6);
});

// --- Golden: atomic kinds -------------------------------------------------------------

test('golden: verse and list blocks are never split internally', () => {
  blockCounter = 0;
  const blocks = [
    B('verse', 'Roses are red', { blockId: 'v0' }),
    B('list', 'one\ntwo\nthree', { blockId: 'l0' }),
    B('other', 'code();', { blockId: 'o0' }),
  ];
  const plan = createChunkPlan(docOf(blocks), { maxTokensPerChunk: 4, contextChars: 400 });
  assert.equal(plan.chunks.length, 2);
  assert.deepEqual(plan.chunks[0].slices, [
    { blockId: 'v0', charStart: 0, charEnd: 13, tokenEstimate: 4 },
    { blockId: 'l0', charStart: 0, charEnd: 13, tokenEstimate: 4 },
  ]);
  assert.equal(plan.chunks[0].tokenEstimate, 8); // atomic exception
  assert.deepEqual(plan.chunks[1].slices, [
    { blockId: 'o0', charStart: 0, charEnd: 7, tokenEstimate: 2 },
  ]);
  assert.ok(isChunkPlan(plan));
  assertCoverage(plan, blocks);
});

// --- Golden: oversized paragraph --------------------------------------------------------

const LONG_SENTENCES = [
  'First sentence here. ',
  'Second sentence goes. ',
  'Third one right here. ',
  'Fourth sentence now. ',
  'Fifth sentence ends. ',
  'Sixth final stop.',
];
const LONG_TEXT = LONG_SENTENCES.join('');

test('golden: oversized paragraph splits at sentence boundaries with exact ranges', () => {
  blockCounter = 0;
  const blocks = [B('paragraph', LONG_TEXT, { blockId: 'p0' })];
  const plan = createChunkPlan(docOf(blocks), { maxTokensPerChunk: 20, contextChars: 400 });
  assert.equal(plan.chunks.length, 2);
  assert.deepEqual(plan.chunks[0].slices, [
    { blockId: 'p0', charStart: 0, charEnd: 21, tokenEstimate: 6 },
    { blockId: 'p0', charStart: 21, charEnd: 43, tokenEstimate: 6 },
    { blockId: 'p0', charStart: 43, charEnd: 65, tokenEstimate: 6 },
  ]);
  assert.deepEqual(plan.chunks[1].slices, [
    { blockId: 'p0', charStart: 65, charEnd: 86, tokenEstimate: 6 },
    { blockId: 'p0', charStart: 86, charEnd: 107, tokenEstimate: 6 },
    { blockId: 'p0', charStart: 107, charEnd: 124, tokenEstimate: 5 },
  ]);
  assert.equal(plan.chunks[0].tokenEstimate, 18);
  assert.equal(plan.chunks[1].tokenEstimate, 17);
  // Pieces concatenate back to the exact block text.
  assert.equal(
    plan.chunks.map((c) => c.slices.map((s) => LONG_TEXT.slice(s.charStart, s.charEnd)).join('')).join(''),
    LONG_TEXT,
  );
  assert.equal(plan.chunks[0].contextAfter, 'Fourth sentence now. Fifth sentence ends. Sixth final stop.');
  assert.equal(plan.chunks[1].contextBefore, 'First sentence here. Second sentence goes. Third one right here. ');
  assert.ok(isChunkPlan(plan));
  assertCoverage(plan, blocks);
});

test('context truncation cuts the nearest overflowing segment (tail before, head after)', () => {
  blockCounter = 0;
  const blocks = [B('paragraph', LONG_TEXT, { blockId: 'p0' })];
  const plan = createChunkPlan(docOf(blocks), { maxTokensPerChunk: 20, contextChars: 10 });
  assert.equal(plan.chunks[0].contextBefore, '');
  assert.equal(plan.chunks[0].contextAfter, 'Fourth sen'); // head of the next segment
  assert.equal(plan.chunks[1].contextBefore, 'ght here. '); // tail of the previous segment
  assert.equal(plan.chunks[1].contextAfter, '');
  assertBoundedContext(plan, 10);
});

// --- Empty documents ----------------------------------------------------------------------

test('empty document yields zero chunks; only-empty document yields one zero-token chunk', () => {
  const empty = createChunkPlan(docOf([]), { maxTokensPerChunk: 8, contextChars: 5 });
  assert.deepEqual(empty, { schemaVersion: 1, options: { maxTokensPerChunk: 8, contextChars: 5 }, chunks: [] });
  assert.ok(isChunkPlan(empty));

  blockCounter = 0;
  const blocks = [
    B('empty', '', { blockId: 'e0' }),
    B('empty', '', { blockId: 'e1' }),
    B('empty', '', { blockId: 'e2' }),
  ];
  const plan = createChunkPlan(docOf(blocks), { maxTokensPerChunk: 8, contextChars: 5 });
  assert.equal(plan.chunks.length, 1);
  assert.deepEqual(plan.chunks[0].slices, [
    { blockId: 'e0', charStart: 0, charEnd: 0, tokenEstimate: 0 },
    { blockId: 'e1', charStart: 0, charEnd: 0, tokenEstimate: 0 },
    { blockId: 'e2', charStart: 0, charEnd: 0, tokenEstimate: 0 },
  ]);
  assert.equal(plan.chunks[0].tokenEstimate, 0);
  assert.equal(plan.chunks[0].contextBefore, '');
  assert.equal(plan.chunks[0].contextAfter, '');
  assert.ok(isChunkPlan(plan));
  assertCoverage(plan, blocks);
});

// --- Determinism ------------------------------------------------------------------------------

test('planning is deterministic: two runs are deeply equal (synthetic and imported)', async () => {
  blockCounter = 0;
  const blocks = [
    B('heading', 'Title', { blockId: 'h0' }),
    B('paragraph', `${'A '.repeat(60).trim()}.`, { blockId: 'p0' }),
    B('table', 'T', { blockId: 't0' }),
    B('row', 'x | y', { blockId: 'r0' }),
    B('verse', 'verse line', { blockId: 'v0' }),
    B('paragraph', LONG_TEXT, { blockId: 'p1' }),
  ];
  const options = { maxTokensPerChunk: 30, contextChars: 25 };
  const a = createChunkPlan(docOf(blocks), options);
  const b = createChunkPlan(docOf(blocks), options);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.ok(isChunkPlan(a));
  assertCoverage(a, blocks);
  assertBudgetRespected(a, blocks, 30);

  const imported = await importDocument(getFixture('md'));
  assert.deepEqual(createChunkPlan(imported), createChunkPlan(imported));
});

// --- Stability ---------------------------------------------------------------------------------

test('stability: an unrelated wording edit changes no chunkId', () => {
  blockCounter = 0;
  const mk = (t) => B('paragraph', t);
  const before = [
    mk('Paragraph No.0'),
    mk('Paragraph No.1'),
    mk('Paragraph No.2'),
    mk('Paragraph No.3'),
    mk('Paragraph No.4'),
    mk('Paragraph No.5'),
  ];
  const planA = createChunkPlan(docOf(before), { maxTokensPerChunk: 8, contextChars: 400 });
  assert.equal(planA.chunks.length, 3);

  const after = before.map((b) => ({ ...b }));
  // Same length, different wording: structure untouched.
  after[1] = { ...after[1], text: 'Paragraph NO.1' };
  const planB = createChunkPlan(docOf(after), { maxTokensPerChunk: 8, contextChars: 400 });
  assert.deepEqual(
    planB.chunks.map((c) => c.chunkId),
    planA.chunks.map((c) => c.chunkId),
  );
});

test('stability: an unrelated chunk keeps its id and slices across a nearby edit', () => {
  blockCounter = 0;
  const mk = (t) => B('paragraph', t);
  const before = [
    mk('Paragraph No.0'),
    mk('Paragraph No.1'),
    mk('Paragraph No.2'),
    mk('Paragraph No.3'),
    mk('Paragraph No.4'),
    mk('Paragraph No.5'),
    mk('Paragraph No.6'),
    mk('Paragraph No.7'),
  ];
  const options = { maxTokensPerChunk: 12, contextChars: 400 };
  const planA = createChunkPlan(docOf(before), options);
  assert.deepEqual(
    planA.chunks.map((c) => c.slices.map((s) => s.blockId)),
    [
      ['b1', 'b2', 'b3'],
      ['b4', 'b5', 'b6'],
      ['b7', 'b8'],
    ],
  );

  // Grow b5 (inside the middle chunk): the first chunk is untouched, the
  // regrouped region re-derives ids, and the trailing triple regroups.
  const after = before.map((b) => ({ ...b }));
  after[4] = { ...after[4], text: 'Paragraph No.4 grew by several extra words.' };
  const planB = createChunkPlan(docOf(after), options);
  assert.equal(planB.chunks[0].chunkId, planA.chunks[0].chunkId);
  assert.deepEqual(planB.chunks[0].slices, planA.chunks[0].slices);
  assert.deepEqual(
    planB.chunks.map((c) => c.slices.map((s) => s.blockId)),
    [
      ['b1', 'b2', 'b3'],
      ['b4', 'b5'],
      ['b6', 'b7', 'b8'],
    ],
  );
  const idsB = new Set(planB.chunks.map((c) => c.chunkId));
  assert.ok(idsB.has(planA.chunks[0].chunkId));
  assert.ok(!idsB.has(planA.chunks[1].chunkId), 'regrouped chunk re-derives its id');
  assertCoverage(planB, after);
});

// --- Budget, heading binding, parts -------------------------------------------------------------

test('budget holds for every chunk except documented atomic units (varied document)', () => {
  blockCounter = 0;
  const blocks = [
    B('heading', 'Section'),
    B('paragraph', `${'Prose '.repeat(30).trim()}.`),
    B('quote', `${'Quote '.repeat(40).trim()}.`),
    B('table', 'H'),
    B('row', 'a | b | c'),
    B('row', 'd | e | f'),
    B('list', 'x\ny\nz'),
    B('paragraph', LONG_TEXT),
    B('verse', `${'V '.repeat(50).trim()}.`),
  ];
  for (const budget of [800, 50, 7]) {
    const plan = createChunkPlan(docOf(blocks), { maxTokensPerChunk: budget, contextChars: 100 });
    assertBudgetRespected(plan, blocks, budget);
    assertHeadingsBoundForward(plan, blocks);
    assertCoverage(plan, blocks);
    assertBoundedContext(plan, 100);
    assert.ok(isChunkPlan(plan));
  }
});

test('a heading is never orphaned: it stays glued to an oversized atomic section unit', () => {
  blockCounter = 0;
  const blocks = [
    B('heading', 'Head', { blockId: 'h0' }),
    B('table', 'H', { blockId: 't0' }),
    B('row', 'a | b', { blockId: 'r0' }),
    B('row', 'c | d', { blockId: 'r1' }),
  ];
  const plan = createChunkPlan(docOf(blocks), { maxTokensPerChunk: 3, contextChars: 400 });
  assert.equal(plan.chunks.length, 1);
  assert.deepEqual(
    plan.chunks[0].slices.map((s) => s.blockId),
    ['h0', 't0', 'r0', 'r1'],
  );
  assertHeadingsBoundForward(plan, blocks);
});

test('a trailing heading forms the final chunk only', () => {
  blockCounter = 0;
  const blocks = [B('paragraph', 'Body text.', { blockId: 'b0' }), B('heading', 'Dangling', { blockId: 'h0' })];
  const plan = createChunkPlan(docOf(blocks), { maxTokensPerChunk: 8, contextChars: 400 });
  assert.equal(plan.chunks.length, 2);
  assert.deepEqual(
    plan.chunks.map((c) => c.slices.map((s) => s.blockId)),
    [['b0'], ['h0']],
  );
});

test('part changes close chunks: peripheral parts never glue onto main-flow chunks', () => {
  blockCounter = 0;
  const blocks = [
    B('paragraph', 'Main one.', { blockId: 'm0' }),
    B('paragraph', 'Main two.', { blockId: 'm1' }),
    B('other', 'Foot note', { blockId: 'f0', part: 'footer' }),
    B('paragraph', 'Main three.', { blockId: 'm2' }),
  ];
  const plan = createChunkPlan(docOf(blocks), { maxTokensPerChunk: 800, contextChars: 400 });
  assert.deepEqual(
    plan.chunks.map((c) => c.slices.map((s) => s.blockId)),
    [['m0', 'm1'], ['f0'], ['m2']],
  );
  assertCoverage(plan, blocks);

  blockCounter = 0;
  const interleaved = [
    B('heading', 'Sec', { blockId: 'h0' }),
    B('other', 'Running head', { blockId: 'hd0', part: 'header' }),
    B('paragraph', 'After.', { blockId: 'p0' }),
  ];
  const plan2 = createChunkPlan(docOf(interleaved), { maxTokensPerChunk: 800, contextChars: 400 });
  assert.deepEqual(
    plan2.chunks.map((c) => c.slices.map((s) => s.blockId)),
    [['h0'], ['hd0'], ['p0']],
  );
});

test('separators and headings interleave in document order (fold + drain)', () => {
  blockCounter = 0;
  const blocks = [
    B('empty', '', { blockId: 'e0' }),
    B('heading', 'Title', { blockId: 'h0' }),
    B('empty', '', { blockId: 'e1' }),
    B('paragraph', 'Body.', { blockId: 'p0' }),
  ];
  const plan = createChunkPlan(docOf(blocks), { maxTokensPerChunk: 800, contextChars: 400 });
  assert.equal(plan.chunks.length, 1);
  assert.deepEqual(
    plan.chunks[0].slices.map((s) => s.blockId),
    ['e0', 'h0', 'e1', 'p0'],
  );
  assert.equal(plan.chunks[0].tokenEstimate, 4); // 'Title' (2) + 'Body.' (2)
});

// --- Sentence last resort -------------------------------------------------------------------------

test('a single sentence longer than the budget is emitted alone (last resort)', () => {
  blockCounter = 0;
  const monster = `${'w'.repeat(500)}.`;
  const blocks = [B('paragraph', monster, { blockId: 'm0' })];
  const plan = createChunkPlan(docOf(blocks), { maxTokensPerChunk: 10, contextChars: 20 });
  assert.equal(plan.chunks.length, 1);
  assert.deepEqual(plan.chunks[0].slices, [{ blockId: 'm0', charStart: 0, charEnd: 501, tokenEstimate: 126 }]);
  assert.equal(plan.chunks[0].tokenEstimate, 126);
  assertBudgetRespected(plan, blocks, 10);
});

test('sentence scanning handles clustered terminators, initials, and mid-word dots deterministically', () => {
  blockCounter = 0;
  const text = 'Wait... really?! Yes — "ok." e.g. stays whole. Done';
  const blocks = [B('paragraph', text, { blockId: 's0' })];
  const plan = createChunkPlan(docOf(blocks), { maxTokensPerChunk: 1, contextChars: 400 });
  const pieces = plan.chunks.flatMap((c) => c.slices.map((s) => text.slice(s.charStart, s.charEnd)));
  assert.equal(pieces.join(''), text); // lossless partition
  assertCoverage(plan, blocks);
  // 'e.g.' must not split internally, and the initial-dot rule keeps it
  // glued to the following clause: one piece runs from 'e.g.' to 'whole. '.
  const egIndex = pieces.findIndex((p) => p.startsWith('e.g.'));
  assert.ok(egIndex !== -1, `'e.g.' starts a piece: ${JSON.stringify(pieces)}`);
  assert.equal(pieces[egIndex], 'e.g. stays whole. ');
});

// --- Contract validator ------------------------------------------------------------------------------

test('validateChunkPlan accepts planner output and rejects tampered plans', () => {
  blockCounter = 0;
  const blocks = ['0', '1', '2', '3', '4', '5'].map((n) => B('paragraph', `Paragraph No.${n}`));
  const plan = createChunkPlan(docOf(blocks), { maxTokensPerChunk: 8, contextChars: 100 });
  assert.ok(plan.chunks.length >= 2, 'fixture yields a multi-chunk plan');
  assert.equal(validateChunkPlan(plan).ok, true);

  const broken = (mutate) => {
    const copy = JSON.parse(JSON.stringify(plan));
    mutate(copy);
    return validateChunkPlan(copy).ok;
  };
  assert.equal(broken((p) => { p.schemaVersion = 2; }), false);
  assert.equal(broken((p) => { p.options.maxTokensPerChunk = 0; }), false);
  assert.equal(broken((p) => { p.options.contextChars = -1; }), false);
  assert.equal(broken((p) => { p.chunks[0].tokenEstimate += 1; }), false);
  assert.equal(broken((p) => { p.chunks[0].slices[0].charStart = 5; p.chunks[0].slices[0].charEnd = 2; }), false);
  assert.equal(broken((p) => { p.chunks[0].slices[0].tokenEstimate = -1; }), false);
  assert.equal(broken((p) => { p.chunks[0].slices = []; }), false);
  assert.equal(broken((p) => { p.chunks[1].chunkId = p.chunks[0].chunkId; }), false);
  assert.equal(broken((p) => { p.chunks[0].contextAfter = 'x'.repeat(101); }), false);
  assert.equal(broken((p) => { delete p.chunks[0].contextBefore; }), false);
  assert.equal(validateChunkPlan(null).ok, false);
  assert.equal(validateChunkPlan({ schemaVersion: 1 }).ok, false);
});

// --- Integration with real imports ---------------------------------------------------------------------

test('integration: imported MD document plans, validates, covers, and respects defaults', async () => {
  const imported = await importDocument(getFixture('md'));
  const plan = createChunkPlan(imported);
  assert.equal(plan.schemaVersion, 1);
  assert.deepEqual(plan.options, DEFAULT_CHUNK_PLANNER_OPTIONS);
  assert.ok(plan.chunks.length >= 1);
  assert.ok(isChunkPlan(plan));
  assertCoverage(plan, imported.blocks);
  assertBudgetRespected(plan, imported.blocks, DEFAULT_CHUNK_PLANNER_OPTIONS.maxTokensPerChunk);
  assertHeadingsBoundForward(plan, imported.blocks);
  assertBoundedContext(plan, DEFAULT_CHUNK_PLANNER_OPTIONS.contextChars);
  // Token estimates reconcile: chunk sum equals slice sums everywhere.
  for (const chunk of plan.chunks) {
    assert.equal(chunk.tokenEstimate, chunk.slices.reduce((n, s) => n + s.tokenEstimate, 0));
  }
});

test('integration: imported TXT and DOCX documents produce valid stable plans', async () => {
  for (const format of ['txt', 'docx']) {
    const imported = await importDocument(getFixture(format));
    const plan = createChunkPlan(imported, { maxTokensPerChunk: 12, contextChars: 40 });
    assert.ok(isChunkPlan(plan), `${format} plan validates`);
    assertCoverage(plan, imported.blocks);
    assertBudgetRespected(plan, imported.blocks, 12);
    assertBoundedContext(plan, 40);
    assert.deepEqual(createChunkPlan(imported, { maxTokensPerChunk: 12, contextChars: 40 }), plan);
  }
});

test('planner rejects garbage input loudly', () => {
  assert.throws(() => createChunkPlan(null), TypeError);
  assert.throws(() => createChunkPlan({}), TypeError);
  assert.throws(() => createChunkPlan({ blocks: 'nope' }), TypeError);
  assert.throws(() => createChunkPlan({ blocks: [null] }), TypeError);
  assert.throws(() => createChunkPlan({ blocks: [{ blockId: 'b0' }] }), TypeError);
});

// --- Review findings P3A.D3-R1..R9 regressions -------------------------------------

// R1 — heading binding precedence: a pending heading prefix binds to the
// first following prose slice even when the budget is exhausted (documented
// overflow). Heading-only non-final chunks must not exist.

test('a heading at exact budget glues the first prose piece past the budget', () => {
  blockCounter = 0;
  const blocks = [
    B('heading', 'abcd', { blockId: 'h0' }), // 1 token === budget
    B('paragraph', 'aa. bb.', { blockId: 'p0' }), // 'aa. '(1 tok) + 'bb.'(1 tok)
  ];
  const plan = createChunkPlan(docOf(blocks), { maxTokensPerChunk: 1, contextChars: 400 });
  assert.deepEqual(
    plan.chunks.map((c) => c.slices),
    [
      [
        { blockId: 'h0', charStart: 0, charEnd: 4, tokenEstimate: 1 },
        { blockId: 'p0', charStart: 0, charEnd: 4, tokenEstimate: 1 },
      ],
      [{ blockId: 'p0', charStart: 4, charEnd: 7, tokenEstimate: 1 }],
    ],
  );
  assert.equal(plan.chunks[0].tokenEstimate, 2); // documented overflow
  assertHeadingsBoundForward(plan, blocks);
  assertBudgetRespected(plan, blocks, 1);
});

test('reviewer repro: heading plus prose at budget 1 never yields a heading-only chunk', () => {
  blockCounter = 0;
  const blocks = [B('heading', 'abcd', { blockId: 'h0' }), B('paragraph', 'a. b.', { blockId: 'p0' })];
  const plan = createChunkPlan(docOf(blocks), { maxTokensPerChunk: 1, contextChars: 400 });
  assert.equal(plan.chunks.length, 1); // pre-fix: [heading],[a.],[b.]
  assert.equal(plan.chunks[0].slices.length, 2);
  assertHeadingsBoundForward(plan, blocks);
});

test('an over-budget heading glues the first prose piece and flushes the rest', () => {
  blockCounter = 0;
  const blocks = [
    B('heading', 'Heading text', { blockId: 'h0' }), // 3 tokens > budget 2
    B('paragraph', 'AA. BB.', { blockId: 'p0' }),
  ];
  const plan = createChunkPlan(docOf(blocks), { maxTokensPerChunk: 2, contextChars: 400 });
  assert.deepEqual(
    plan.chunks.map((c) => c.slices.map((s) => s.blockId)),
    [['h0', 'p0'], ['p0']],
  );
  assert.equal(plan.chunks[0].tokenEstimate, 4); // documented overflow
  assertHeadingsBoundForward(plan, blocks);
  assertBudgetRespected(plan, blocks, 2);
});

// R2 — chunkId seed injectivity: the length-prefixed canonical encoding makes
// delimiter-carrying blockIds unambiguous.

test('chunkId encoding is injective: reviewer collision pair now derives distinct ids', () => {
  blockCounter = 0;
  // Pre-fix BOTH documents serialized to the seed `1|A:0:1,B:0:4` — one full
  // slice of block "A:0:1,B" vs two slices "A:0:1" + "B:0:4".
  const docA = docOf([B('paragraph', 'wxyz', { blockId: 'A:0:1,B' })]);
  const docB = docOf([B('paragraph', 'a', { blockId: 'A' }), B('paragraph', 'wxyz', { blockId: 'B' })]);
  const options = { maxTokensPerChunk: 800, contextChars: 400 };
  const idsA = createChunkPlan(docA, options).chunks.map((c) => c.chunkId);
  const idsB = createChunkPlan(docB, options).chunks.map((c) => c.chunkId);
  for (const id of idsA) {
    assert.ok(!idsB.includes(id), `chunkId ${id} still collides across the two encodings`);
  }
  assert.deepEqual(createChunkPlan(docA, options).chunks.map((c) => c.chunkId), idsA);
});

// R3 — duplicate blockIds are rejected before planning, fail closed.

test('duplicate blockIds cannot silently produce a plan (typed rejection)', () => {
  blockCounter = 0;
  const dupParas = [
    B('paragraph', 'first text', { blockId: 'dup' }),
    B('paragraph', 'second', { blockId: 'dup' }),
  ];
  assert.throws(
    () => createChunkPlan(docOf(dupParas), { maxTokensPerChunk: 8, contextChars: 10 }),
    /duplicate blockId "dup"/,
  );

  blockCounter = 0;
  const dupRows = [
    B('table', 'H', { blockId: 't0' }),
    B('row', 'a | b', { blockId: 'r0' }),
    B('row', 'c | d', { blockId: 'r0' }), // grouped rows need identity too
  ];
  assert.throws(
    () => createChunkPlan(docOf(dupRows), { maxTokensPerChunk: 8, contextChars: 10 }),
    /duplicate blockId "r0"/,
  );

  blockCounter = 0;
  const dupAcrossKinds = [
    B('table', 'H', { blockId: 't0' }),
    B('row', 'a | b', { blockId: 'r0' }),
    B('paragraph', 'x', { blockId: 't0' }),
  ];
  assert.throws(
    () => createChunkPlan(docOf(dupAcrossKinds), { maxTokensPerChunk: 8, contextChars: 10 }),
    /duplicate blockId "t0"/,
  );
});

// R4 — table grouping folds only same-part immediate rows.

test('table grouping ignores rows from other parts: footer rows form their own chunks', () => {
  blockCounter = 0;
  const blocks = [
    B('table', 'Header', { blockId: 't0' }),
    B('row', 'a | b', { blockId: 'r0' }),
    B('row', 'footer sig', { blockId: 'r1', part: 'footer' }),
    B('row', 'still footer', { blockId: 'r2', part: 'footer' }),
    B('paragraph', 'tail.', { blockId: 'p0' }),
  ];
  const plan = createChunkPlan(docOf(blocks), { maxTokensPerChunk: 800, contextChars: 400 });
  assert.deepEqual(
    plan.chunks.map((c) => c.slices.map((s) => s.blockId)),
    [['t0', 'r0'], ['r1', 'r2'], ['p0']],
  );
  assertCoverage(plan, blocks);
});

// R5 — rule 8 vs rule 7 precedence for all-empty documents spanning parts.

test('all-empty document yields one zero-token chunk per part (rule 7 precedence)', () => {
  blockCounter = 0;
  const blocks = [
    B('empty', '', { blockId: 'e0' }),
    B('empty', '', { blockId: 'e1', part: 'footer' }),
    B('empty', '', { blockId: 'e2', part: 'footer' }),
  ];
  const plan = createChunkPlan(docOf(blocks), { maxTokensPerChunk: 8, contextChars: 5 });
  assert.equal(plan.chunks.length, 2);
  assert.deepEqual(
    plan.chunks.map((c) => c.slices.map((s) => s.blockId)),
    [['e0'], ['e1', 'e2']],
  );
  assertCoverage(plan, blocks);
});

// R6 — partial context cuts never split a surrogate pair.

test('context cuts omit an emoji code point that cannot fit (never a lone surrogate)', () => {
  blockCounter = 0;
  const emoji = '\u{1F600}';
  const head = createChunkPlan(
    docOf([B('paragraph', 'wxyz', { blockId: 'x0' }), B('paragraph', `${emoji}xyz`, { blockId: 'y0' })]),
    { maxTokensPerChunk: 1, contextChars: 1 },
  );
  assert.equal(head.chunks[0].contextAfter, ''); // 😀 does not fit whole -> omitted
  assert.equal(head.chunks[1].contextBefore, 'z');
  const tail = createChunkPlan(
    docOf([B('paragraph', `xy${emoji}`, { blockId: 'x0' }), B('paragraph', 'zw', { blockId: 'y0' })]),
    { maxTokensPerChunk: 1, contextChars: 1 },
  );
  assert.equal(tail.chunks[1].contextBefore, ''); // tail edge inside the pair -> omitted
  assert.equal(tail.chunks[0].contextAfter, 'z');
  for (const plan of [head, tail]) {
    for (const chunk of plan.chunks) {
      for (const context of [chunk.contextBefore, chunk.contextAfter]) {
        assert.ok(!/^[\uDC00-\uDFFF]/.test(context), `unpaired low surrogate: ${JSON.stringify(context)}`);
        assert.ok(!/[\uD800-\uDBFF]$/.test(context), `unpaired high surrogate: ${JSON.stringify(context)}`);
      }
    }
  }
});

// R7 — source-aware plan validation at the DOC-04 boundary.

test('validateChunkPlanAgainstSource accepts planner output for its own document', async () => {
  blockCounter = 0;
  const blocks = ['0', '1', '2', '3'].map((n) => B('paragraph', `Paragraph No.${n}`));
  const document = docOf(blocks);
  const plan = createChunkPlan(document, { maxTokensPerChunk: 8, contextChars: 100 });
  assert.ok(plan.chunks.length >= 2, 'fixture yields a multi-chunk plan');
  assert.equal(validateChunkPlanAgainstSource(plan, document).ok, true);
  assert.equal(isChunkPlanForSource(plan, document), true);

  const imported = await importDocument(getFixture('md'));
  assert.equal(validateChunkPlanAgainstSource(createChunkPlan(imported), imported).ok, true);
});

test('validateChunkPlanAgainstSource rejects fabricated or stale plans with CORRUPT_DATA', async () => {
  blockCounter = 0;
  const blocks = ['0', '1', '2'].map((n) => B('paragraph', `Paragraph No.${n}`));
  const document = docOf(blocks);
  const plan = createChunkPlan(document, { maxTokensPerChunk: 8, contextChars: 100 });
  const corrupt = (mutate, mutateDocument) => {
    const planCopy = JSON.parse(JSON.stringify(plan));
    const docCopy = JSON.parse(JSON.stringify(document));
    mutate?.(planCopy);
    mutateDocument?.(docCopy);
    return validateChunkPlanAgainstSource(planCopy, docCopy);
  };

  // Arbitrary chunkId: shape-valid but wrongly derived.
  let r = corrupt((p) => { p.chunks[0].chunkId = 'c-0000000000000000'; });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'CORRUPT_DATA');
  // Malformed chunkId shape.
  r = corrupt((p) => { p.chunks[0].chunkId = 'nope'; });
  assert.equal(r.ok, false);
  // Slice referencing a block absent from the document (id re-derived so the
  // unknown-block check is what fires).
  r = corrupt(
    (p) => {
      p.chunks.at(-1).slices.push({ blockId: 'ghost', charStart: 0, charEnd: 0, tokenEstimate: 0 });
      p.chunks.at(-1).chunkId = deriveChunkPlanId(p.chunks.at(-1).slices);
    },
  );
  assert.equal(r.ok, false);
  assert.match(r.error.message, /absent from the source document/);
  // Range beyond the owning block's UTF-16 text bounds (id re-derived so the
  // bounds check is what fires).
  r = corrupt((p) => {
    p.chunks.at(-1).slices.at(-1).charEnd += 100;
    p.chunks.at(-1).chunkId = deriveChunkPlanId(p.chunks.at(-1).slices);
  });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /beyond its text length/);
  // Gap inside a split block's coverage (id re-derived so the gap check is
  // what fires).
  r = corrupt((p) => {
    p.chunks[1].slices[0].charStart += 1;
    p.chunks[1].chunkId = deriveChunkPlanId(p.chunks[1].slices);
  });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /gap or overlap/);
  // Missing coverage: dropping a chunk leaves document blocks uncovered.
  r = corrupt((p) => { p.chunks.pop(); });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /does not cover/);
  // Wrong estimate kept structurally consistent (chunk sum adjusted too).
  r = corrupt((p) => {
    p.chunks[0].slices[0].tokenEstimate += 1;
    p.chunks[0].tokenEstimate += 1;
  });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /does not match the recomputed/);
  // Document mutated after planning: two blocks collapse onto one id.
  r = corrupt(undefined, (d) => { d.blocks[1].blockId = d.blocks[0].blockId; });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /duplicate blockId/);
  // Structural failures keep their own code.
  r = corrupt((p) => { p.schemaVersion = 2; });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'VALIDATION_FAILED');
  // Garbage document.
  r = validateChunkPlanAgainstSource(plan, null);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'CORRUPT_DATA');
});

// R8 — runtime-frozen planner defaults.

test('DEFAULT_CHUNK_PLANNER_OPTIONS is frozen: mutation attempts throw or no-op', () => {
  assert.ok(Object.isFrozen(DEFAULT_CHUNK_PLANNER_OPTIONS));
  const attempt = () => {
    'use strict';
    DEFAULT_CHUNK_PLANNER_OPTIONS.maxTokensPerChunk = 1;
  };
  assert.throws(attempt, TypeError);
  DEFAULT_CHUNK_PLANNER_OPTIONS.contextChars = 999999; // sloppy mode: silent no-op
  assert.equal(DEFAULT_CHUNK_PLANNER_OPTIONS.contextChars, 400);
});

// R9 — deterministic abbreviation handling + unicode closers.

test('abbreviation dots never split: Dr. Smith and U.S. Army stay whole', () => {
  blockCounter = 0;
  const drText = 'Dr. Smith arrived. He left.';
  const dr = createChunkPlan(docOf([B('paragraph', drText, { blockId: 'd0' })]), { maxTokensPerChunk: 4, contextChars: 400 });
  assert.deepEqual(
    dr.chunks.flatMap((c) => c.slices.map((s) => drText.slice(s.charStart, s.charEnd))),
    ['Dr. Smith arrived. ', 'He left.'],
  );

  const usText = 'The U.S. Army marched. Done';
  const us = createChunkPlan(docOf([B('paragraph', usText, { blockId: 'u0' })]), { maxTokensPerChunk: 4, contextChars: 400 });
  assert.deepEqual(
    us.chunks.flatMap((c) => c.slices.map((s) => usText.slice(s.charStart, s.charEnd))),
    ['The U.S. Army marched. ', 'Done'],
  );
});

test('unicode closing quotes bind to the terminator before a boundary', () => {
  blockCounter = 0;
  const text = 'Er sagte: «Guten Tag.» Dann ging er.';
  const plan = createChunkPlan(docOf([B('paragraph', text, { blockId: 'g0' })]), { maxTokensPerChunk: 4, contextChars: 400 });
  assert.deepEqual(
    plan.chunks.flatMap((c) => c.slices.map((s) => text.slice(s.charStart, s.charEnd))),
    ['Er sagte: «Guten Tag.» ', 'Dann ging er.'],
  );
});

// --- Review 2 residuals (P3A.D3 delta) ------------------------------------------------

// Review2-R1 — heading + empties + heading stays in the pending prefix: the
// intervening zero-token separator must NOT let the first heading drain into
// a contentless NON-final chunk when the next heading arrives.

test('reviewer 2 repro: heading/empty/heading accumulates in the prefix until section content', () => {
  blockCounter = 0;
  const blocks = [
    B('heading', 'abcd', { blockId: 'h0' }), // 1 token
    B('empty', '', { blockId: 'e0' }), // separator rides along after h0 drains
    B('heading', 'efgh', { blockId: 'h1' }), // 1 token
    B('paragraph', 'ij. kl.', { blockId: 'p0' }), // 'ij. '(1 tok) + 'kl.'(1 tok)
  ];
  const plan = createChunkPlan(docOf(blocks), { maxTokensPerChunk: 2, contextChars: 400 });
  // Pre-fix: h1 flushed [h0, e0] as a contentless non-final chunk ->
  // [['h0','e0'], ['h1','p0'(0,4)], ['p0'(4,7)]]. Post-fix the prefix
  // (h0 + e0 + h1) drains INTACT into its section chunk.
  assert.deepEqual(
    plan.chunks.map((c) => c.slices.map((s) => s.blockId)),
    [['h0', 'e0', 'h1', 'p0'], ['p0']],
  );
  assertCoverage(plan, blocks);
  assertHeadingsBoundForward(plan, blocks);
});

// Review2-R2 — legal blockIds that name Object.prototype properties must not
// collide with inherited keys in the validator's id index (plain Record read
// `__proto__` as an always-present "duplicate").

test('reviewer 2: prototype-property blockIds validate against their source', () => {
  blockCounter = 0;
  const PROTO_IDS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];
  const blocks = PROTO_IDS.map((id, i) => B('paragraph', `text ${i}`, { blockId: id }));
  const document = docOf(blocks);
  const plan = createChunkPlan(document, { maxTokensPerChunk: 800, contextChars: 400 });
  const result = validateChunkPlanAgainstSource(plan, document);
  assert.equal(result.ok, true); // pre-fix: CORRUPT_DATA "duplicate blockId __proto__"
  assert.equal(isChunkPlanForSource(plan, document), true);
  assertCoverage(plan, blocks);

  // True duplicates keep failing closed, prototype ids included.
  blockCounter = 0;
  const dupDoc = docOf([
    B('paragraph', 'one', { blockId: '__proto__' }),
    B('paragraph', 'two', { blockId: '__proto__' }),
  ]);
  const dupSlices = [
    { blockId: '__proto__', charStart: 0, charEnd: 3, tokenEstimate: 1 },
    { blockId: '__proto__', charStart: 0, charEnd: 3, tokenEstimate: 1 },
  ];
  const r = validateChunkPlanAgainstSource(
    {
      schemaVersion: 1,
      options: { maxTokensPerChunk: 800, contextChars: 400 },
      chunks: [
        {
          chunkId: deriveChunkPlanId(dupSlices),
          slices: dupSlices,
          tokenEstimate: 2,
          contextBefore: '',
          contextAfter: '',
        },
      ],
    },
    dupDoc,
  );
  assert.equal(r.ok, false);
  assert.match(r.error.message, /duplicate blockId "__proto__"/);
});

// Review2-R3 — degenerate zero-length slices cannot pass the exactly-once
// coverage check: forbidden outright on nonempty blocks, and an EMPTY block
// may carry only its single legitimate full-range slice.

test('reviewer 2: zero-length slices cannot fake exactly-once coverage', () => {
  blockCounter = 0;
  const document = docOf([B('paragraph', 'abcd', { blockId: 'z0' })]);
  const mkSlice = (blockId, charStart, charEnd) => ({
    blockId,
    charStart,
    charEnd,
    tokenEstimate: charEnd - charStart === 0 ? 0 : Math.ceil((charEnd - charStart) / 4),
  });
  const mkPlan = (blockId, slicePairs) => ({
    schemaVersion: 1,
    options: { maxTokensPerChunk: 800, contextChars: 400 },
    chunks: slicePairs.map((pair) => {
      const slices = pair.map(([start, end]) => mkSlice(blockId, start, end));
      return {
        chunkId: deriveChunkPlanId(slices),
        slices,
        tokenEstimate: slices.reduce((n, s) => n + s.tokenEstimate, 0),
        contextBefore: '',
        contextAfter: '',
      };
    }),
  });

  // Standalone zero-length prefix slice + full coverage (pre-fix: ok).
  let r = validateChunkPlanAgainstSource(mkPlan('z0', [[[0, 0]], [[0, 4]]]), document);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /zero-length \(0, 0\) but the block is not empty/);

  // Full coverage followed by a zero-length suffix duplicate (pre-fix: ok).
  r = validateChunkPlanAgainstSource(mkPlan('z0', [[[0, 4]], [[4, 4]]]), document);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /zero-length \(4, 4\) but the block is not empty/);

  // Legitimate planner output: an EMPTY block covered by its single
  // zero-length full-range slice still passes.
  const emptyDoc = docOf([B('empty', '', { blockId: 'ze' })]);
  r = validateChunkPlanAgainstSource(mkPlan('ze', [[[0, 0]]]), emptyDoc);
  assert.equal(r.ok, true);
  // But TWO zero-length slices on one empty block are duplicate coverage
  // (two whole CHUNKS of [0,0] would already fail structurally as duplicate
  // chunkIds — this form reaches the coverage gate).
  r = validateChunkPlanAgainstSource(mkPlan('ze', [[[0, 0], [0, 0]]]), emptyDoc);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /covered by 2 zero-length slices/);

  // Valid split-block coverage keeps passing end-to-end.
  blockCounter = 0;
  const splitDoc = docOf([
    B('heading', 'abcd', { blockId: 'sh' }),
    B('paragraph', 'aa. bb.', { blockId: 'sp' }),
  ]);
  const splitPlan = createChunkPlan(splitDoc, { maxTokensPerChunk: 1, contextChars: 400 });
  assert.ok(splitPlan.chunks.length >= 2, 'fixture splits sp across chunks');
  r = validateChunkPlanAgainstSource(splitPlan, splitDoc);
  assert.equal(r.ok, true);
});
