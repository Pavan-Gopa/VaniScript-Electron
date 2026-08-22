'use strict';

// D7 find/replace (plan §10.8).
//
// `scanMatches` and `previewReplaceAll` are pure: they never touch a binding or
// store. `replaceAll` builds one ProseMirror transaction and hands it to the
// D5 binding, so the D5 canonical archive candidate and D2 CAS are the only
// mutation path. A storage or validation error therefore leaves every match
// uncommitted rather than producing a partially replaced document.

const { closeHistory } = require('prosemirror-history');
const { EDITOR_SCHEMA, EDITOR_ORIGIN_META } = require('./editorSchema.js');
const { createAppError } = require('../../../shared/contracts/errors.ts');

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}


function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isWordCharacter(value) {
  return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
}

function effectivePolicy(archive, block, spanId) {
  const spanPolicy = archive.spanPolicies && archive.spanPolicies[spanId];
  if (spanPolicy) return spanPolicy;
  const blockPolicy = archive.blockPolicies && archive.blockPolicies[block.blockId];
  return blockPolicy || { action: 'translate' };
}

function protectedIntervals(archive, block) {
  const intervals = [];
  for (const span of block.spans || []) {
    const policy = effectivePolicy(archive, block, span.spanId);
    if (policy.action === 'protect') intervals.push({ start: span.start, end: span.end });
  }
  if (archive.blockPolicies && archive.blockPolicies[block.blockId]?.action === 'protect') {
    intervals.push({ start: 0, end: block.text.length });
  }
  return intervals;
}

function overlapsProtected(intervals, start, end) {
  return intervals.some((interval) => start < interval.end && end > interval.start);
}

function makeMatcher(query, options) {
  const useRegex = options.regex === true || query instanceof RegExp;
  if (query instanceof RegExp) {
    const flags = query.flags.includes('g') ? query.flags : `${query.flags}g`;
    return { regex: new RegExp(query.source, flags), regexMode: true };
  }
  if (typeof query !== 'string' || query.length === 0) throw new TypeError('query must be a non-empty string.');
  if (useRegex) {
    const flags = typeof options.flags === 'string' ? options.flags : '';
    const normalizedFlags = flags.includes('g') ? flags : `${flags}g`;
    return { regex: new RegExp(query, normalizedFlags), regexMode: true };
  }
  const flags = options.caseSensitive === false ? 'giu' : 'gu';
  return { regex: new RegExp(escapeRegExp(query), flags), regexMode: false };
}

function findMatchesInText(text, matcher, options, intervals) {
  const matches = [];
  matcher.regex.lastIndex = 0;
  for (const match of text.matchAll(matcher.regex)) {
    const matched = match[0];
    const start = match.index;
    const end = start + matched.length;
    // Zero-width patterns cannot produce a mutation range. They are exposed as
    // preview matches only when explicitly requested, but replaceAll skips them.
    if (end === start && options.includeEmpty !== true) continue;
    if (options.wholeWord === true && (isWordCharacter(text[start - 1]) || isWordCharacter(text[end]))) continue;
    if (overlapsProtected(intervals, start, end)) continue;
    matches.push({ start, end, text: matched, groups: match.slice(1) });
  }
  return matches;
}

function resolveBlocks(input) {
  if (Array.isArray(input)) return { blocks: input, archive: { blocks: input, spanPolicies: {}, blockPolicies: {} } };
  requireRecord(input, 'archive');
  if (!Array.isArray(input.blocks)) throw new TypeError('archive.blocks must be an array.');
  return { blocks: input.blocks, archive: input };
}

/**
 * Pure deterministic match scan. Every returned range is UTF-16 based and
 * belongs to one source block. Protected spans are never returned.
 */
function scanMatches(input, query, options = {}) {
  const { blocks, archive } = resolveBlocks(input);
  requireRecord(options, 'options');
  const matcher = makeMatcher(query, options);
  const output = [];
  blocks.forEach((block, blockIndex) => {
    if (!isRecord(block) || typeof block.blockId !== 'string' || typeof block.text !== 'string') {
      throw new TypeError(`blocks[${blockIndex}] must contain blockId and text.`);
    }
    const intervals = protectedIntervals(archive, block);
    for (const match of findMatchesInText(block.text, matcher, options, intervals)) {
      output.push({
        matchIndex: output.length,
        blockId: block.blockId,
        charStart: match.start,
        charEnd: match.end,
        text: match.text,
        groups: match.groups,
      });
    }
  });
  return output;
}

function replacementFor(match, replacement, regexMode) {
  if (typeof replacement !== 'string') throw new TypeError('replacement must be a string.');
  if (!regexMode) return replacement;
  return replacement
    .replace(/\$&/g, match.text)
    .replace(/\$(\d+)/g, (_, n) => match.groups[Number(n) - 1] ?? '');
}

/** Pure preview: count and replacement ranges without mutating a binding. */
function previewReplaceAll(input = {}, queryArg, replacementArg, optionsArg = {}) {
  let archive;
  let query;
  let replacement;
  let options;
  if (queryArg !== undefined) {
    archive = input;
    query = queryArg;
    replacement = replacementArg;
    options = optionsArg;
  } else {
    ({ archive, query, replacement, options = {} } = input);
  }
  requireRecord(options, 'options');
  const matches = scanMatches(archive, query, options);
  const matcher = makeMatcher(query, options);
  const replacements = matches
    .filter((match) => match.charEnd > match.charStart)
    .map((match) => ({
      ...match,
      replacement: replacementFor(match, replacement, matcher.regexMode),
    }));
  return {
    count: replacements.length,
    matches: replacements,
    skippedEmpty: matches.length - replacements.length,
    query,
    replacement,
  };
}

function requireBinding(binding) {
  requireRecord(binding, 'binding');
  if (typeof binding.applyUserTransaction !== 'function') {
    throw new TypeError('binding.applyUserTransaction() is required.');
  }
  if (!binding.state || !binding.state.doc) throw new TypeError('binding.state.doc is required.');
  if (!binding.archive || !Array.isArray(binding.archive.blocks)) throw new TypeError('binding.archive.blocks is required.');
}

function blockPositions(doc) {
  const positions = new Map();
  let contentStart = 1;
  for (let index = 0; index < doc.childCount; index++) {
    const block = doc.child(index);
    positions.set(block.attrs.blockId, { from: contentStart, node: block, index });
    contentStart += block.nodeSize;
  }
  return positions;
}

function replacementTransaction(binding, matches) {
  const tr = binding.state.tr;
  const positions = blockPositions(tr.doc);
  const ordered = matches
    .slice()
    .sort((a, b) => {
      const pa = positions.get(a.blockId);
      const pb = positions.get(b.blockId);
      return (pb ? pb.from : 0) - (pa ? pa.from : 0) || b.charStart - a.charStart;
    });
  for (const match of ordered) {
    const position = positions.get(match.blockId);
    if (!position) throw createAppError('CONFLICT', `Replace target block "${match.blockId}" is no longer in the editor.`);
    const from = position.from + match.charStart;
    const to = position.from + match.charEnd;
    const $from = tr.doc.resolve(from);
    if (match.replacement.length === 0) {
      tr.delete(from, to);
    } else {
      const marks = $from.marks();
      tr.replaceWith(
        from,
        to,
        marks.length ? EDITOR_SCHEMA.text(match.replacement, marks) : EDITOR_SCHEMA.text(match.replacement),
      );
    }
  }
  tr.setMeta(EDITOR_ORIGIN_META, 'ai-replace');
  tr.setMeta('addToHistory', true);
  closeHistory(tr);
  tr.setMeta('closeHistory', true);
  return tr;
}

/**
 * Transactional replace-all. The scan is repeated against the binding's
 * current archive so a stale preview cannot silently target moved text. One PM
 * transaction carries all matches and one D5 call carries the single D2 CAS.
 */
function replaceAll({ binding, query, replacement, options = {}, expectedRevision } = {}) {
  requireBinding(binding);
  if (expectedRevision !== undefined && String(binding.revision) !== String(expectedRevision)) {
    throw createAppError(
      'CONFLICT',
      `Replace preview revision "${expectedRevision}" does not match binding revision "${binding.revision}".`,
      { expectedRevision, currentRevision: binding.revision },
    );
  }
  const preview = previewReplaceAll({ archive: binding.archive, query, replacement, options });
  if (preview.count === 0) {
    return { changed: false, applied: true, count: 0, matches: [], changedRanges: [], preview };
  }
  const tr = replacementTransaction(binding, preview.matches);
  const commit = binding.applyUserTransaction(tr);
  const rangeDetails = preview.matches.map((match) => ({
    blockId: match.blockId,
    charStart: match.charStart,
    charEnd: match.charStart + match.replacement.length,
    originalCharStart: match.charStart,
    originalCharEnd: match.charEnd,
  }));
  const changedRanges = rangeDetails.map(({ blockId, charStart, charEnd }) => ({ blockId, charStart, charEnd }));
  return { ...commit, applied: true, count: preview.count, matches: preview.matches, changedRanges, rangeDetails, preview };
}

const previewReplace = previewReplaceAll;
const replaceEverywhere = replaceAll;
const replaceAllMatches = replaceAll;

module.exports = {
  scanMatches,
  findMatches: scanMatches,
  scanFindMatches: scanMatches,
  previewReplaceAll,
  previewReplace,
  replaceAll,
  replaceEverywhere,
  replaceAllMatches,
  protectedIntervals,
};
