'use strict';

// Semantic chunk planner (DOC-03).
//
// Derives a versioned, STABLE, DETERMINISTIC `ChunkPlan` (plan §10.4) from a
// normalized `NormalizedDocument` (DOC-01): ordered chunks of block slices
// with per-slice/chunk token estimates and bounded rolling context before/
// after. The DOC-04 translation coordinator is the downstream consumer: it
// translates per chunk, reports progress over chunks/blocks/tokens, keeps
// rolling context/memory, and commits after each successfully processed
// chunk (plan §10.6) — this plan is its input contract.
//
// Determinism contract (plan §20 "stable block chunk plans", "deterministic
// fixtures"): the plan is a pure function of `document.blocks` + options.
// No timestamps, no randomness, no iteration-order dependence, no ML calls.
// The same document version plus the same options always yields a
// byte-identical plan.
//
// Grouping rules (single greedy pass over planning units, in block order):
//
//   1. Units. Each block is one planning unit, except a `table` block plus
//      its immediately following `row` blocks IN THE SAME PART, which form
//      ONE atomic unit — tables are never split mid-structure.
//   2. Headings bind forward. A `heading` unit never ends a non-final chunk:
//      it opens a pending prefix that is glued to the following section
//      content. Consecutive headings (and any empty separators between them)
//      accumulate in the prefix.
//   3. Budget. Units accumulate into the open chunk while the projected
//      token sum fits `options.maxTokensPerChunk`. A `heading` always closes
//      the open chunk first (rule 2), so sections break before their heading.
//   4. Oversized splittable blocks. Only `paragraph` and `quote` blocks are
//      splittable (prose). When one does not fit, it is split at sentence
//      boundaries — the first piece fills the open chunk's remaining budget,
//      later pieces pack full-budget chunks, and the last piece stays open so
//      following blocks can ride with it. When the open chunk holds ONLY a
//      freshly drained heading prefix (no positive-token content yet), rule 2
//      takes precedence over the flush: the first piece glues onto the
//      heading even past the budget — the second documented overflow case
//      (a heading is never left alone in a non-final chunk). Sentence
//      boundaries are a fixed scan: `. ! ? …` (plus trailing closing
//      quotes/brackets) at end of text or before whitespace; inter-sentence
//      whitespace stays attached to the preceding sentence, so a block's
//      pieces concatenate back to its exact text. A `.` completing a
//      single-letter initial or a common title (Mr/Mrs/Ms/Dr/Prof/Sr/Jr/St,
//      case-insensitive — fixed list, no ML) never terminates; a single
//      sentence longer than the budget is emitted alone (last resort).
//   5. Atomic units. `heading`, `verse`, `list`, `table`+`row` groups,
//      `empty`, and `other` blocks are never split internally. An atomic
//      unit that does not fit is appended anyway and the chunk is closed —
//      the documented budget exception. Its bound leading heading(s) go with
//      it (a heading is never orphaned from its section content).
//   6. Empty blocks. Zero-token separator blocks ride with whichever chunk
//      is open when they arrive — after a pending heading prefix has drained
//      into it, so a separator lands between its heading and the section
//      content it belongs to. They never trigger a flush.
//   7. Parts. A part change (main → header/footer/footnote/endnote/textbox)
//      closes the open chunk and any pending prefix: peripheral parts are
//      never glued onto main-flow chunks.
//   8. Coverage. Every block appears in exactly one chunk, in document
//      order; a split block's slices partition `[0, block.text.length)`.
//      A document with zero blocks yields zero chunks; a document whose
//      blocks are all empty yields exactly one (zero-token) chunk PER PART
//      (rule 7 takes precedence when empties span several parts).
//
// Token estimate (documented approximation, no ML): for text `t`,
// `estimateTokens(t) = t.length === 0 ? 0 : Math.ceil(t.length / 4)` over
// UTF-16 code units — the classic ~4 chars/token BPE heuristic for
// English-ish prose. Chunk estimates are exactly the sum of their slice
// estimates so token progress (§10.6) reconciles at every level.
//
// Rolling context: `contextBefore`/`contextAfter` walk the flat slice
// sequence outward from the chunk (crossing chunk borders — rolling memory
// for §10.6) and concatenate neighboring slice texts nearest-first; the
// segment that overflows the `options.contextChars` budget is partially cut
// (tail for before, head for after) on a CODE-POINT boundary: a cut landing
// inside a surrogate pair omits that code point entirely, so a context never
// ends in an unpaired surrogate. Result is always `<= contextChars`
// characters and `''` at the document edges.
//
// chunkId derivation and evolution: slices serialize through the contract's
// INJECTIVE `canonicalChunkSeed` — length-prefixed blockIds
// (`"len:blockId:start:end"`, comma-joined, schema-version-prefixed) — and
// hash with SHA-256, first 16 lowercase hex digits, `c-` prefix (derivation
// lives in `deriveChunkPlanId` in shared/contracts/documents.ts so planner
// and validators cannot drift). Ids depend only on membership + ranges —
// never on array position, wording, or document length — so re-deriving a
// plan for the same document version reproduces ids exactly, and chunks
// whose membership+ranges survive a nearby edit keep their id even when
// their ordinal shifts. Stability is RANGE-based, not content-based: an edit
// changing a block's TEXT LENGTH moves slice boundaries and re-derives the
// affected ids, while a same-length wording edit keeps every id (content
// staleness is DOC-02 freshness territory, tracked per block via source
// hashes). Plans are derived state, never persisted truth: recompute.
//
// Options: `resolveChunkPlannerOptions` applies `DEFAULT_CHUNK_PLANNER_OPTIONS`
// (`maxTokensPerChunk: 800`, `contextChars: 400`) and rejects non-integer or
// out-of-range values with `TypeError` — planner options are programmer
// input from trusted main-process code, not runtime data, so they fail loud
// and early rather than through the typed IPC error channel.
//
// Input precondition: `document.blocks` is the block array of a validated
// normalized document (DOC-01). The planner re-checks the few fields it
// reads (`blockId`, `kind`, `text`, `part`) and throws `TypeError` on
// garbage; full structural validation remains the contract's job.

const {
  CHUNK_PLAN_SCHEMA_VERSION,
  DEFAULT_CHUNK_PLANNER_OPTIONS,
  deriveChunkPlanId,
} = require('../../../shared/contracts/documents.ts');

// --- Token estimate ----------------------------------------------------------

/**
 * Deterministic token estimate for a block of text: `ceil(chars / 4)` over
 * UTF-16 code units, `0` for empty text. See the module header for why.
 */
function estimateTokens(text) {
  if (typeof text !== 'string') {
    throw new TypeError('estimateTokens expects a string.');
  }
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

// --- Options -----------------------------------------------------------------

/**
 * Apply defaults and validate planner options. Returns a frozen
 * `ResolvedChunkPlannerOptions`. Throws `TypeError` on invalid input:
 * `maxTokensPerChunk` must be an integer >= 1, `contextChars` an integer
 * >= 0. Unknown keys are ignored (forward-compatible options bags).
 */
function resolveChunkPlannerOptions(options) {
  if (options === undefined) options = {};
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('chunk planner options must be an object.');
  }
  const maxTokensPerChunk =
    options.maxTokensPerChunk === undefined
      ? DEFAULT_CHUNK_PLANNER_OPTIONS.maxTokensPerChunk
      : options.maxTokensPerChunk;
  if (!Number.isInteger(maxTokensPerChunk) || maxTokensPerChunk < 1) {
    throw new TypeError('options.maxTokensPerChunk must be an integer >= 1.');
  }
  const contextChars =
    options.contextChars === undefined
      ? DEFAULT_CHUNK_PLANNER_OPTIONS.contextChars
      : options.contextChars;
  if (!Number.isInteger(contextChars) || contextChars < 0) {
    throw new TypeError('options.contextChars must be an integer >= 0.');
  }
  return Object.freeze({ maxTokensPerChunk, contextChars });
}

// --- Sentence splitting ------------------------------------------------------

// Closing quotes/brackets that may trail a terminator and still belong to
// the sentence ("…last words." / "(like this.)").
const SENTENCE_CLOSERS = '\'"»)]}';

// A `.` completing one of these forms never terminates a sentence — fixed,
// documented list, no ML: single-letter initials ("J.", "U.S.") plus common
// titles. Accepted trade-off: a TRUE sentence ending in such a form (e.g.
// "...the U.S.") merges into the next sentence instead of mis-splitting
// "Dr. Smith".
const ABBREVIATION_TITLES = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st']);

/** True when the dot at `dotIndex` completes a single-letter initial or a listed title. */
function isAbbreviationDot(text, dotIndex) {
  let s = dotIndex;
  while (s > 0 && /[A-Za-z]/.test(text[s - 1])) s--;
  const token = text.slice(s, dotIndex);
  return token.length === 1 || ABBREVIATION_TITLES.has(token.toLowerCase());
}

/**
 * Split `text` into sentence ranges `[start, end)` (UTF-16 offsets). A
 * sentence ends at `.`, `!`, `?` or `…`, optionally followed by closing
 * quotes/brackets, at end of text or immediately before whitespace; the
 * trailing whitespace stays attached to the preceding sentence, so the
 * ranges always concatenate back to the exact input text. A terminator not
 * followed by a boundary ("3.5") does not split, and a `.` completing a
 * single-letter initial or a listed title (`ABBREVIATION_TITLES`) never
 * splits ("Dr. Smith", "U.S. Army"). Fully deterministic: fixed scans plus
 * a fixed list, no ML.
 */
function sentenceRanges(text) {
  const ranges = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
      let j = i + 1;
      // A `.` completing an initial/title never terminates — keep scanning.
      if (ch === '.' && isAbbreviationDot(text, i)) {
        i++;
        continue;
      }
      while (j < text.length && SENTENCE_CLOSERS.includes(text[j])) j++;
      if (j >= text.length || /\s/.test(text[j])) {
        let k = j;
        while (k < text.length && /\s/.test(text[k])) k++;
        ranges.push({ start, end: k });
        start = k;
        i = k;
        continue;
      }
      i = j;
      continue;
    }
    i++;
  }
  if (start < text.length) ranges.push({ start, end: text.length });
  return ranges;
}

/**
 * Greedily pack sentence `ranges` into groups of consecutive sentences whose
 * token sums fit the per-group caps (`caps[0]` for the first emitted group —
 * typically the open chunk's remaining budget — `caps[1]` for all later
 * groups). A sentence that alone exceeds its group's cap is emitted alone;
 * that group may exceed the cap (documented last resort). Returns at least
 * one group for non-empty input.
 */
function packSentenceGroups(ranges, text, firstCap, cap) {
  const groups = [];
  let current = [];
  let currentTokens = 0;
  let capIdx = 0;
  for (const range of ranges) {
    const tokens = estimateTokens(text.slice(range.start, range.end));
    if (current.length > 0 && currentTokens + tokens > (capIdx === 0 ? firstCap : cap)) {
      groups.push(current);
      current = [];
      currentTokens = 0;
      capIdx = 1;
    }
    current.push(range);
    currentTokens += tokens;
  }
  groups.push(current);
  return groups;
}

// --- Planning units ----------------------------------------------------------

/**
 * Fold blocks into planning units (module header rule 1): every block stands
 * alone except a `table` + immediately following same-part `row` blocks,
 * which merge into one atomic unit. Rejects duplicate blockIds up front
 * (fail closed — a duplicated id would silently resolve text via
 * last-write-wins downstream) and validates every grouped row's identity
 * fields too. Unit shape: `{ blocks, part, tokens, role, atomic }` where
 * `role` is `'heading'` (binds forward) or `'content'`, and `atomic`
 * forbids internal splitting.
 */
function buildUnits(blocks) {
  const units = [];
  const firstSeenAt = new Map(); // blockId -> index of first occurrence
  /** Validates the fields the planner reads; returns the normalized part. */
  const checkedPart = (block, i) => {
    if (block === null || typeof block !== 'object') {
      throw new TypeError(`document.blocks[${i}] must be an object.`);
    }
    if (typeof block.blockId !== 'string' || block.blockId === '') {
      throw new TypeError(`document.blocks[${i}].blockId must be a non-empty string.`);
    }
    if (typeof block.kind !== 'string') {
      throw new TypeError(`document.blocks[${i}].kind must be a string.`);
    }
    if (typeof block.text !== 'string') {
      throw new TypeError(`document.blocks[${i}].text must be a string.`);
    }
    return typeof block.part === 'string' ? block.part : 'main';
  };
  /** Fail-closed duplicate-id rejection across ALL blocks (rows included). */
  const claim = (block, i) => {
    const prior = firstSeenAt.get(block.blockId);
    if (prior !== undefined) {
      throw new TypeError(
        `duplicate blockId "${block.blockId}": document.blocks[${i}] repeats document.blocks[${prior}].`,
      );
    }
    firstSeenAt.set(block.blockId, i);
  };
  for (let i = 0; i < blocks.length; ) {
    const block = blocks[i];
    const part = checkedPart(block, i);
    claim(block, i);
    if (block.kind === 'table') {
      const group = [block];
      let j = i + 1;
      while (
        j < blocks.length &&
        blocks[j] !== null &&
        typeof blocks[j] === 'object' &&
        blocks[j].kind === 'row' &&
        (typeof blocks[j].part === 'string' ? blocks[j].part : 'main') === part
      ) {
        checkedPart(blocks[j], j); // grouped rows need identity fields too
        claim(blocks[j], j);
        group.push(blocks[j]);
        j++;
      }
      units.push({
        blocks: group,
        part,
        tokens: group.reduce((sum, b) => sum + estimateTokens(b.text), 0),
        role: 'content',
        atomic: true,
      });
      i = j;
      continue;
    }
    units.push({
      blocks: [block],
      part,
      tokens: estimateTokens(block.text),
      role: block.kind === 'heading' ? 'heading' : 'content',
      atomic: block.kind !== 'paragraph' && block.kind !== 'quote',
    });
    i++;
  }
  return units;
}

// --- Slices ------------------------------------------------------------------

/** Full-range slice for one block (the block is not split). */
function fullSlice(block) {
  return {
    blockId: block.blockId,
    charStart: 0,
    charEnd: block.text.length,
    tokenEstimate: estimateTokens(block.text),
  };
}

/** Slice for one sentence range of a split block. */
function rangeSlice(block, range) {
  return {
    blockId: block.blockId,
    charStart: range.start,
    charEnd: range.end,
    tokenEstimate: estimateTokens(block.text.slice(range.start, range.end)),
  };
}

function slicesTokens(slices) {
  return slices.reduce((sum, s) => sum + s.tokenEstimate, 0);
}

// --- Context -----------------------------------------------------------------

/**
 * Partial context cuts never split a surrogate pair: when the budget edge
 * lands inside one, the WHOLE code point is omitted (the result may be one
 * code unit shorter than the budget).
 */
function cutHead(text, room) {
  let end = room;
  const cu = text.charCodeAt(end - 1);
  if (cu >= 0xd800 && cu <= 0xdbff && end < text.length) {
    const next = text.charCodeAt(end);
    if (next >= 0xdc00 && next <= 0xdfff) end -= 1;
  }
  return text.slice(0, end);
}

function cutTail(text, room) {
  const start = text.length - room;
  const cu = text.charCodeAt(start);
  if (cu >= 0xdc00 && cu <= 0xdfff && start > 0) {
    const prev = text.charCodeAt(start - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) return text.slice(start + 1);
  }
  return text.slice(start);
}

/**
 * Rolling context for the chunk at flat position `from` in `segments`
 * (`{ text, chunk }` entries in document order): walk outward nearest-first
 * (`step` -1 for before, +1 for after) concatenating whole segment texts
 * until `budget` characters would be exceeded, then partially cut that
 * segment (head for after, tail for before — code-point-safe, see above)
 * and stop. Bounded by construction.
 */
function rollingContext(segments, from, step, budget) {
  if (budget === 0) return '';
  const forward = step > 0;
  let out = '';
  for (let s = from; s >= 0 && s < segments.length && out.length < budget; s += step) {
    const text = segments[s].text;
    if (text.length === 0) continue;
    const room = budget - out.length;
    if (text.length <= room) out = forward ? out + text : text + out;
    else out = forward ? out + cutHead(text, room) : cutTail(text, room) + out;
  }
  return out;
}

// --- Planner -----------------------------------------------------------------

/**
 * Derive the semantic chunk plan for a normalized document. Pure and
 * deterministic: same `document.blocks` + same options ⇒ identical plan.
 * See the module header for the grouping rules, token formula, context
 * window, and chunkId derivation.
 *
 * @param {{ blocks: Array }} document normalized document (DOC-01).
 * @param {{ maxTokensPerChunk?: number, contextChars?: number }} [options]
 * @returns {{ schemaVersion: number, options: ResolvedChunkPlannerOptions,
 *             chunks: Array }} versioned `ChunkPlan`.
 */
function createChunkPlan(document, options) {
  const opts = resolveChunkPlannerOptions(options);
  const blocks = document === null || typeof document !== 'object' ? undefined : document.blocks;
  if (!Array.isArray(blocks)) {
    throw new TypeError('createChunkPlan expects a normalized document with a blocks array.');
  }
  const budget = opts.maxTokensPerChunk;

  // Grouping pass — produces chunks as slice arrays (ids/contexts added below).
  const chunkSlices = [];
  let cur = null; // open chunk: { part, slices, tokens, contentTokens }
  let prefix = []; // pending heading/separator units bound forward (invariant: prefix non-empty ⇒ cur null)

  const flushCur = () => {
    if (cur !== null && cur.slices.length > 0) chunkSlices.push(cur.slices);
    cur = null;
  };
  const flushPrefix = () => {
    if (prefix.length > 0) {
      chunkSlices.push(prefix.flatMap((entry) => entry.slices));
      prefix = [];
    }
  };
  const openCur = (part) => {
    cur = { part, slices: [], tokens: 0, contentTokens: 0 };
    return cur;
  };

  for (const unit of buildUnits(blocks)) {
    // Rule 7: part change closes open grouping state.
    if (cur !== null && cur.part !== unit.part) flushCur();
    if (prefix.length > 0 && prefix[0].part !== unit.part) flushPrefix();

    if (unit.role === 'heading') {
      // Rule 2: a heading closes the open chunk only when the chunk holds
      // REAL content (`contentTokens > 0`). A chunk holding just a drained
      // heading prefix plus zero-token separators folds BACK into the
      // pending prefix instead — consecutive headings and any empty
      // separators between them stay pending there until section content,
      // a part boundary, or the final flush releases them. (Invariant:
      // prefix non-empty implies cur null, so a fold never interleaves
      // with a pending prefix.)
      if (cur !== null) {
        if (cur.contentTokens > 0) flushCur();
        else {
          prefix = [{ slices: cur.slices, part: cur.part }];
          cur = null;
        }
      }
      prefix.push({ slices: unit.blocks.map(fullSlice), part: unit.part });
      continue;
    }

    // Content unit: drain the pending prefix into the (possibly new) open
    // chunk first — prefix units precede this unit in document order.
    const drained = prefix.splice(0, prefix.length);
    if (cur === null) openCur(unit.part);
    // Prefix tokens deliberately skip contentTokens: a chunk holding only a
    // drained heading prefix still owes its first prose piece (rule 2).
    for (const pending of drained) {
      cur.slices.push(...pending.slices);
      cur.tokens += slicesTokens(pending.slices);
    }

    // Rule 6: zero-token separators ride along, never trigger a flush.
    if (unit.tokens === 0) {
      for (const block of unit.blocks) cur.slices.push(fullSlice(block));
      continue;
    }

    if (cur.tokens + unit.tokens <= budget) {
      for (const block of unit.blocks) cur.slices.push(fullSlice(block));
      cur.tokens += unit.tokens;
      cur.contentTokens += unit.tokens;
      continue;
    }

    if (unit.atomic) {
      // Rule 5: budget exception — append whole, close. Bound leading
      // headings (already drained into cur) stay with their section unit.
      for (const block of unit.blocks) cur.slices.push(fullSlice(block));
      cur.tokens += unit.tokens;
      cur.contentTokens += unit.tokens;
      flushCur();
      continue;
    }

    // Rule 4: split the prose block at sentence boundaries. If the open
    // chunk is already exactly full, close it first — UNLESS it holds only
    // the freshly drained heading prefix (contentTokens === 0): rule 2
    // binding precedence then beats the flush, and the first group glues
    // onto the heading even past the budget (documented overflow — a
    // heading is never left alone in a non-final chunk).
    const block = unit.blocks[0];
    if (budget - cur.tokens <= 0 && cur.contentTokens > 0) flushCur();
    if (cur === null) openCur(unit.part);
    const groups = packSentenceGroups(sentenceRanges(block.text), block.text, budget - cur.tokens, budget);
    // Order matters: the first group continues the open chunk, the chunk is
    // then flushed BEFORE any middle group is emitted, and only the last
    // group reopens as the current chunk — so chunks always appear in
    // document order regardless of group count.
    const firstSlices = groups[0].map((range) => rangeSlice(block, range));
    cur.slices.push(...firstSlices);
    cur.tokens += slicesTokens(firstSlices);
    cur.contentTokens += slicesTokens(firstSlices);
    if (groups.length > 1) {
      flushCur();
      for (let g = 1; g < groups.length - 1; g++) {
        chunkSlices.push(groups[g].map((range) => rangeSlice(block, range)));
      }
      openCur(unit.part);
      const lastSlices = groups[groups.length - 1].map((range) => rangeSlice(block, range));
      cur.slices.push(...lastSlices);
      cur.tokens += slicesTokens(lastSlices);
      cur.contentTokens += slicesTokens(lastSlices);
    }
  }
  flushCur();
  flushPrefix();

  // Flat segment list (document order) for rolling context: each slice of
  // each chunk in order, with its resolved text.
  const blockById = new Map(blocks.map((b) => [b.blockId, b]));
  const segments = [];
  const chunks = chunkSlices.map((slices, chunkIndex) => {
    const firstSeg = segments.length;
    for (const slice of slices) {
      const block = blockById.get(slice.blockId);
      if (block === undefined) {
        throw new TypeError(`chunk slice references unknown blockId "${slice.blockId}".`);
      }
      segments.push({ text: block.text.slice(slice.charStart, slice.charEnd), chunk: chunkIndex });
    }
    return { slices, firstSeg, lastSeg: segments.length - 1 };
  });

  // Finish: ids + bounded rolling context per chunk.
  return {
    schemaVersion: CHUNK_PLAN_SCHEMA_VERSION,
    options: { maxTokensPerChunk: opts.maxTokensPerChunk, contextChars: opts.contextChars },
    chunks: chunks.map(({ slices, firstSeg, lastSeg }, chunkIndex) => ({
      chunkId: deriveChunkPlanId(slices),
      slices,
      tokenEstimate: slicesTokens(slices),
      contextBefore: rollingContext(segments, firstSeg - 1, -1, opts.contextChars),
      contextAfter: rollingContext(segments, lastSeg + 1, 1, opts.contextChars),
    })),
  };
}

module.exports = {
  estimateTokens,
  resolveChunkPlannerOptions,
  createChunkPlan,
};
