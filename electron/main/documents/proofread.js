'use strict';

// D7 proofreading primitives (plan §10.9).
//
// These functions are pure projections. D3 owns source slice/chunk plans and
// D6 owns freshness/status review rows; this module only maps those existing
// values onto source/translation ranges and reports source-refresh effects.
// No review status is rewritten or recomputed through a second persistence path.

const { createHash } = require('node:crypto');

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  return value;
}

function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function sourceBlocks(document) {
  requireRecord(document, 'document');
  if (!Array.isArray(document.blocks)) throw new TypeError('document.blocks must be an array.');
  return document.blocks.map((block, index) => {
    if (!isRecord(block) || typeof block.blockId !== 'string' || typeof block.text !== 'string') {
      throw new TypeError(`document.blocks[${index}] must carry blockId and text.`);
    }
    return block;
  });
}

function translationEntry(translation, blockId) {
  if (!translation) return null;
  const blocks = translation.blocks;
  return blocks && isRecord(blocks) ? blocks[blockId] || null : null;
}

function validateFreshness(freshness) {
  if (freshness === undefined || freshness === null) return null;
  requireRecord(freshness, 'freshness');
  if (!isRecord(freshness.blocks)) throw new TypeError('freshness.blocks must be an object.');
  return freshness;
}

function reviewInfo(freshness, blockId, entry) {
  const info = freshness && freshness.blocks[blockId];
  // D6's report is authoritative when supplied. Without it, expose only the
  // archive status and leave freshness unknown instead of duplicating D6 hash
  // classification here.
  return {
    freshness: info && typeof info.freshness === 'string' ? info.freshness : null,
    status: info && typeof info.status === 'string' ? info.status : entry ? entry.status : 'missing',
  };
}

/** Deterministic sentence ranges used for local block correspondence. */
function sentenceRanges(text) {
  requireString(text, 'text');
  const ranges = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    if ('.!?…'.includes(text[i])) {
      let end = i + 1;
      while (end < text.length && '\'»)]}'.includes(text[end])) end += 1;
      if (end >= text.length || /\s/.test(text[end])) {
        while (end < text.length && /\s/.test(text[end])) end += 1;
        ranges.push({ start, end, text: text.slice(start, end) });
        start = end;
        i = end;
        continue;
      }
      i = end;
      continue;
    }
    i += 1;
  }
  if (start < text.length) ranges.push({ start, end: text.length, text: text.slice(start) });
  return ranges;
}

/**
 * Pure sentence correspondence by stable ordinal. The source and target are
 * independent strings, so unmatched tails are represented as null ranges.
 */
function alignSentences(sourceText, targetText) {
  const source = sentenceRanges(sourceText);
  const target = sentenceRanges(targetText);
  const count = Math.max(source.length, target.length);
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      index: i,
      sourceRange: source[i] ? { start: source[i].start, end: source[i].end } : null,
      sourceText: source[i] ? source[i].text : '',
      targetRange: target[i] ? { start: target[i].start, end: target[i].end } : null,
      targetText: target[i] ? target[i].text : '',
    });
  }
  return rows;
}

function normalizePlan(plan) {
  if (plan === undefined || plan === null) return null;
  if (Array.isArray(plan)) return { chunks: plan };
  requireRecord(plan, 'plan');
  if (!Array.isArray(plan.chunks)) throw new TypeError('plan.chunks must be an array.');
  return plan;
}

function projectionRange(charStart, charEnd, sourceLength, targetLength) {
  if (sourceLength <= 0 || targetLength <= 0) return { start: 0, end: 0 };
  const start = Math.max(0, Math.min(targetLength, Math.floor((charStart / sourceLength) * targetLength)));
  const end = Math.max(start, Math.min(targetLength, Math.ceil((charEnd / sourceLength) * targetLength)));
  return { start, end };
}

/**
 * Project an intersected selection from one row interval into its counterpart
 * interval. Row ranges may describe only a D3 slice, so projecting against
 * the full block would over-highlight every slice touched by a selection.
 */
function counterpartRangeForSelection(row, side, start, end) {
  const selected = side === 'source' ? row.sourceRange : row.targetRange;
  const counterpart = side === 'source' ? row.targetRange : row.sourceRange;
  if (!selected || !counterpart) return null;
  const projected = projectionRange(
    start - selected.start,
    end - selected.start,
    selected.end - selected.start,
    counterpart.end - counterpart.start,
  );
  return {
    start: counterpart.start + projected.start,
    end: counterpart.start + projected.end,
  };
}

/**
 * Project D3 block slices and D6 freshness rows onto translation text. A
 * translation archive stores one whole-block target string; split slices get a
 * monotonic proportional target range, while their source range remains exact.
 */
function projectProofreadAlignment(input = {}) {
  requireRecord(input, 'alignment options');
  const document = input.document;
  const translation = input.translation ?? input.translationArchive;
  const plan = input.plan;
  const freshness = input.freshness ?? input.review;
  const blocks = sourceBlocks(document);
  const normalizedPlan = normalizePlan(plan);
  const review = validateFreshness(freshness);
  const slicesByBlock = new Map();
  const chunkBySlice = new Map();
  if (normalizedPlan) {
    for (const chunk of normalizedPlan.chunks) {
      if (!isRecord(chunk) || typeof chunk.chunkId !== 'string' || !Array.isArray(chunk.slices)) {
        throw new TypeError('plan chunks require chunkId and slices.');
      }
      for (const slice of chunk.slices) {
        if (!isRecord(slice) || typeof slice.blockId !== 'string' || !Number.isInteger(slice.charStart) || !Number.isInteger(slice.charEnd)) {
          throw new TypeError('plan slices require blockId and integer ranges.');
        }
        if (slice.charStart < 0 || slice.charEnd < slice.charStart) throw new TypeError('plan slice range is invalid.');
        if (!slicesByBlock.has(slice.blockId)) slicesByBlock.set(slice.blockId, []);
        const projected = { blockId: slice.blockId, charStart: slice.charStart, charEnd: slice.charEnd, chunkId: chunk.chunkId };
        slicesByBlock.get(slice.blockId).push(projected);
        chunkBySlice.set(`${slice.blockId}:${slice.charStart}:${slice.charEnd}`, chunk.chunkId);
      }
    }
  }

  const rows = [];
  for (const block of blocks) {
    const entry = translationEntry(translation, block.blockId);
    const targetText = entry && typeof entry.text === 'string' ? entry.text : '';
    const info = reviewInfo(review, block.blockId, entry);
    const slices = slicesByBlock.get(block.blockId) || [{ blockId: block.blockId, charStart: 0, charEnd: block.text.length, chunkId: null }];
    for (const slice of slices) {
      if (slice.charEnd > block.text.length) throw new TypeError(`plan slice exceeds block "${block.blockId}" text.`);
      const sourceText = block.text.slice(slice.charStart, slice.charEnd);
      const targetRange = projectionRange(slice.charStart, slice.charEnd, block.text.length, targetText.length);
      rows.push({
        blockId: block.blockId,
        chunkId: slice.chunkId,
        sourceRange: { start: slice.charStart, end: slice.charEnd },
        sourceText,
        targetRange,
        targetText: targetText.slice(targetRange.start, targetRange.end),
        fullTargetText: targetText,
        sourceHash: hashText(block.text),
        targetSourceHash: entry ? entry.sourceHash : null,
        freshness: info.freshness,
        status: info.status,
        sentences: alignSentences(sourceText, targetText.slice(targetRange.start, targetRange.end)),
      });
    }
  }
  return rows;
}

/** Alias emphasizing the D3 slice projection contract. */
const alignSourceTranslation = projectProofreadAlignment;
const projectAlignment = projectProofreadAlignment;

/**
 * Pure navigation highlights. The selected range is intersected with exact
 * source/target row ranges; counterpart ranges are returned for synchronized
 * source/translation navigation.
 */
function computeHighlightRanges(alignment, { blockId, charStart, charEnd, side = 'source' } = {}) {
  if (!Array.isArray(alignment)) throw new TypeError('alignment must be an array.');
  if (typeof blockId !== 'string' || !Number.isInteger(charStart) || !Number.isInteger(charEnd) || charStart < 0 || charEnd < charStart) {
    throw new TypeError('highlight selection requires blockId and a valid range.');
  }
  if (side !== 'source' && side !== 'target') throw new TypeError('highlight side must be source or target.');
  const ranges = [];
  for (const row of alignment) {
    if (!row || row.blockId !== blockId) continue;
    const selected = side === 'source' ? row.sourceRange : row.targetRange;
    const counterpart = side === 'source' ? row.targetRange : row.sourceRange;
    // A missing translation can have an empty target interval (or a null
    // counterpart in caller-supplied alignment). Keep its source row visible,
    // but target-side navigation safely yields no range.
    if (!selected || !counterpart) continue;
    const start = Math.max(charStart, selected.start);
    const end = Math.min(charEnd, selected.end);
    if (start >= end) continue;
    ranges.push({
      blockId: row.blockId,
      chunkId: row.chunkId,
      side,
      range: { start, end },
      counterpartRange: counterpartRangeForSelection(row, side, start, end),
      status: row.status,
      freshness: row.freshness,
    });
  }
  return ranges;
}

const highlightRanges = computeHighlightRanges;
const getHighlightRanges = computeHighlightRanges;

function unchangedRanges(oldText, newText) {
  let prefix = 0;
  while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldText.length - prefix &&
    suffix < newText.length - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) suffix += 1;
  const ranges = [];
  if (prefix > 0) ranges.push({ oldStart: 0, oldEnd: prefix, newStart: 0, newEnd: prefix });
  if (suffix > 0) {
    ranges.push({
      oldStart: oldText.length - suffix,
      oldEnd: oldText.length,
      newStart: newText.length - suffix,
      newEnd: newText.length,
    });
  }
  return ranges;
}

function archivesInput(options) {
  const value = options.translations ?? options.translationArchives ?? options.translation;
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}
function sourceRefreshMergeReport(input = {}, newSourceArg, translationArg, blockIdArg) {
  let blockId;
  let oldSource;
  let newSource;
  let translations;
  let translation;
  let translationArchives;
  if (typeof input === 'string' && typeof newSourceArg === 'string') {
    // Positional convenience: (oldSource, newSource, translations, blockId).
    oldSource = input;
    newSource = newSourceArg;
    translations = translationArg;
    blockId = blockIdArg;
  } else {
    ({ blockId, oldSource, newSource, translations, translation, translationArchives } = input);
  }
  if (typeof blockId !== 'string' || blockId.length === 0) throw new TypeError('blockId must be a non-empty string.');
  const oldText = typeof oldSource === 'string' ? oldSource : oldSource && oldSource.text;
  const newText = typeof newSource === 'string' ? newSource : newSource && newSource.text;
  if (typeof oldText !== 'string' || typeof newText !== 'string') throw new TypeError('oldSource/newSource must be strings or blocks.');
  const oldHash = hashText(oldText);
  const newHash = hashText(newText);
  const changed = oldHash !== newHash;
  const reports = archivesInput({ translations, translation, translationArchives }).map((archive) => {
    requireRecord(archive, 'translation archive');
    const entry = translationEntry(archive, blockId);
    const before = !entry ? 'missing' : entry.sourceHash === oldHash ? 'fresh' : 'stale';
    const after = !entry ? 'missing' : entry.sourceHash === newHash ? 'fresh' : 'stale';
    return {
      language: typeof archive.language === 'string' ? archive.language : null,
      blockId,
      status: entry ? entry.status : 'missing',
      sourceHash: entry ? entry.sourceHash : null,
      before,
      after,
      becameStale: before === 'fresh' && after === 'stale',
      realigned: after === 'fresh' && (before !== 'fresh' || changed),
    };
  });
  return {
    blockId,
    oldHash,
    newHash,
    changed,
    translations: reports,
    staleLanguages: reports.filter((row) => row.becameStale).map((row) => row.language),
    realignedLanguages: reports.filter((row) => row.realigned).map((row) => row.language),
    unchangedRanges: unchangedRanges(oldText, newText),
  };
}

const buildSourceRefreshMergeReport = sourceRefreshMergeReport;
const refreshMergeReport = sourceRefreshMergeReport;
const computeSourceRefreshMergeReport = sourceRefreshMergeReport;
const computeHighlights = computeHighlightRanges;

module.exports = {
  sentenceRanges,
  alignSentences,
  projectProofreadAlignment,
  alignSourceTranslation,
  projectAlignment,
  computeHighlightRanges,
  computeHighlights,
  highlightRanges,
  getHighlightRanges,
  sourceRefreshMergeReport,
  buildSourceRefreshMergeReport,
  computeSourceRefreshMergeReport,
  refreshMergeReport,
};
