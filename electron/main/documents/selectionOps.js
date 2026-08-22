'use strict';

// D7 selection operations (plan §10.8).
//
// This module is deliberately an integration layer, not another persistence
// path. It captures immutable source anchors, verifies those anchors against a
// D5-compatible editor binding, and delegates the one accepted mutation to
// binding.applyProgrammaticReplace(). The binding therefore remains the owner
// of ProseMirror identity/formatting, undo grouping, D2 CAS, and durable writes.

const { createHash } = require('node:crypto');
const {
  SELECTION_SNAPSHOT_KIND,
  selectionTextHash,
} = require('./editorCore.js');
const { normalizeBcp47 } = require('../../../shared/contracts/documents.ts');
const { createAppError } = require('../../../shared/contracts/errors.ts');

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireRevision(value, label) {
  return requireString(value, label);
}

function hashText(text) {
  if (typeof text !== 'string') throw new TypeError('hashText expects a string.');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}


function normalizeFragments(document, input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError('selection fragments must be a non-empty array.');
  }
  if (!Array.isArray(document.blocks)) throw new TypeError('document.blocks must be an array.');
  const byId = new Map(document.blocks.map((block, index) => [block.blockId, { block, index }]));
  const seen = new Set();
  const fragments = input.map((raw, index) => {
    requireRecord(raw, `fragments[${index}]`);
    const blockId = requireString(raw.blockId, `fragments[${index}].blockId`);
    const found = byId.get(blockId);
    if (!found) throw new TypeError(`fragments[${index}] references unknown block "${blockId}".`);
    if (seen.has(blockId)) {
      throw new TypeError(`selection may contain only one contiguous fragment per block (duplicate "${blockId}").`);
    }
    seen.add(blockId);
    const charStart = raw.charStart;
    const charEnd = raw.charEnd;
    if (!Number.isInteger(charStart) || !Number.isInteger(charEnd) || charStart < 0 || charEnd < charStart) {
      throw new TypeError(`fragments[${index}] range must satisfy 0 <= charStart <= charEnd.`);
    }
    if (charEnd > found.block.text.length) {
      throw new TypeError(
        `fragments[${index}] range ${charStart}..${charEnd} exceeds block length ${found.block.text.length}.`,
      );
    }
    const text = found.block.text.slice(charStart, charEnd);
    return {
      blockId,
      charStart,
      charEnd,
      text,
      textHash: selectionTextHash(text),
      _documentIndex: found.index,
    };
  });
  fragments.sort((a, b) => a._documentIndex - b._documentIndex || a.charStart - b.charStart);
  for (let i = 1; i < fragments.length; i++) {
    if (fragments[i - 1]._documentIndex > fragments[i]._documentIndex) {
      throw new TypeError('selection fragments must be in document order.');
    }
  }
  return fragments.map(({ _documentIndex, ...fragment }) => fragment);
}

function selectionText(fragments) {
  // Newline is an explicit, deterministic boundary between source blocks. It
  // is not persisted or sent to the editor; only per-block response text is
  // ever allowed to mutate.
  return fragments.map((fragment) => fragment.text).join('\n');
}

/**
 * Capture an immutable selection request. Callers may pass either
 * `fragments: [{ blockId, charStart, charEnd }]` or the legacy single-range
 * `{ blockId, charStart, charEnd }` fields. `createdAt` is required rather
 * than silently generated so repeated captures in a headless test are truly
 * deterministic; UI callers should pass their operation timestamp.
 */
function captureSelectionSnapshot(options = {}) {
  requireRecord(options, 'captureSelectionSnapshot options');
  const document = requireRecord(options.document, 'document');
  const operationId = requireString(options.operationId, 'operationId');
  const rawLanguage = requireString(options.language, 'language');
  const language = normalizeBcp47(rawLanguage);
  if (!language) {
    throw createAppError('VALIDATION_FAILED', `Invalid BCP-47 language tag: ${JSON.stringify(rawLanguage)}.`);
  }
  const chunkId = options.chunkId === undefined ? (options.chunk === undefined ? null : options.chunk) : options.chunkId;
  if (chunkId !== null) requireString(chunkId, 'chunkId');
  const sourceRevision = requireRevision(options.sourceRevision, 'sourceRevision');
  const targetRevision = requireRevision(options.targetRevision, 'targetRevision');
  const createdAt = requireString(options.createdAt, 'createdAt');
  if (Number.isNaN(Date.parse(createdAt))) throw new TypeError('createdAt must be an ISO timestamp.');

  let rawFragments = options.fragments ?? options.blockFragments;
  if (rawFragments === undefined && options.selection !== undefined) {
    rawFragments = Array.isArray(options.selection) ? options.selection : [options.selection];
  }
  if (rawFragments === undefined) {
    rawFragments = [{ blockId: options.blockId, charStart: options.charStart, charEnd: options.charEnd }];
  }
  const fragments = normalizeFragments(document, rawFragments);
  const sourceHashes = {};
  for (const fragment of fragments) {
    const block = document.blocks.find((candidate) => candidate.blockId === fragment.blockId);
    sourceHashes[fragment.blockId] = hashText(block.text);
  }
  const text = selectionText(fragments);
  const snapshot = {
    kind: SELECTION_SNAPSHOT_KIND,
    operationId,
    language,
    chunkId,
    blockId: fragments[0].blockId,
    textHash: selectionTextHash(text),
    textLength: text.length,
    blockFragments: fragments,
    sourceHashes,
    sourceRevision,
    targetRevision,
    createdAt,
  };
  if (fragments.length === 1) {
    snapshot.charStart = fragments[0].charStart;
    snapshot.charEnd = fragments[0].charEnd;
  }
  return snapshot;
}

/**
 * Canonical runtime mirror of the shared SelectionSnapshot contract. It
 * validates the complete shape — operationId, language, chunkId, blockId,
 * hashes, lengths, fragments, revisions, timestamp, and paired range anchor.
 * Accepted responses propagate operationId into D5 transaction metadata; a
 * malformed snapshot fails closed before a guard or editor call.
 */

function validateSnapshot(snapshot) {
  if (!isRecord(snapshot) || snapshot.kind !== SELECTION_SNAPSHOT_KIND) return false;
  for (const key of ['operationId', 'language', 'blockId', 'textHash', 'sourceRevision', 'targetRevision', 'createdAt']) {
    if (typeof snapshot[key] !== 'string' || snapshot[key].length === 0) return false;
  }
  if (!SHA256_HEX.test(snapshot.textHash) || !Number.isInteger(snapshot.textLength) || snapshot.textLength < 0) {
    return false;
  }
  if (!Array.isArray(snapshot.blockFragments) || snapshot.blockFragments.length === 0) return false;
  if (!isRecord(snapshot.sourceHashes)) return false;
  if (snapshot.chunkId !== null && (typeof snapshot.chunkId !== 'string' || snapshot.chunkId.length === 0)) return false;
  if (Number.isNaN(Date.parse(snapshot.createdAt))) return false;
  let totalLength = 0;
  const seen = new Set();
  for (const fragment of snapshot.blockFragments) {
    if (!isRecord(fragment) || typeof fragment.blockId !== 'string' || fragment.blockId.length === 0) return false;
    if (seen.has(fragment.blockId)) return false;
    seen.add(fragment.blockId);
    if (!Number.isInteger(fragment.charStart) || !Number.isInteger(fragment.charEnd)) return false;
    if (fragment.charStart < 0 || fragment.charEnd < fragment.charStart) return false;
    if (typeof fragment.text !== 'string' || !SHA256_HEX.test(fragment.textHash)) return false;
    if (fragment.textHash !== selectionTextHash(fragment.text)) return false;
    if (fragment.charEnd - fragment.charStart !== fragment.text.length) return false;
    totalLength += fragment.text.length;
    const sourceHash = snapshot.sourceHashes[fragment.blockId];
    if (typeof sourceHash !== 'string' || !SHA256_HEX.test(sourceHash)) return false;
  }
  if (totalLength + Math.max(0, snapshot.blockFragments.length - 1) !== snapshot.textLength) return false;
  if (snapshot.blockId !== snapshot.blockFragments[0].blockId) return false;
  const hasStart = snapshot.charStart !== undefined;
  const hasEnd = snapshot.charEnd !== undefined;
  if (hasStart !== hasEnd) return false;
  if (hasStart && (snapshot.blockFragments.length !== 1 || snapshot.charStart !== snapshot.blockFragments[0].charStart || snapshot.charEnd !== snapshot.blockFragments[0].charEnd)) {
    return false;
  }
  return true;
}

function requireBinding(binding) {
  requireRecord(binding, 'binding');
  for (const method of ['selectionGuard', 'applyProgrammaticReplace']) {
    if (typeof binding[method] !== 'function') {
      throw new TypeError(`binding.${method}() is required.`);
    }
  }
  if (!binding.archive || !Array.isArray(binding.archive.blocks)) {
    throw new TypeError('binding.archive.blocks is required.');
  }
}

function currentSelection(binding, snapshot) {
  const byId = new Map(binding.archive.blocks.map((block) => [block.blockId, block]));
  const fragments = [];
  for (const expected of snapshot.blockFragments) {
    const block = byId.get(expected.blockId);
    if (!block || typeof block.text !== 'string') return null;
    if (expected.charEnd > block.text.length) return null;
    const text = block.text.slice(expected.charStart, expected.charEnd);
    fragments.push({ ...expected, currentText: text, currentHash: selectionTextHash(text), sourceHash: hashText(block.text) });
  }
  return { fragments, text: fragments.map((fragment) => fragment.currentText).join('\n') };
}

function protectedRange(archive, blockId, start, end) {
  const block = archive.blocks.find((candidate) => candidate.blockId === blockId);
  if (!block) return false;
  const blockPolicy = archive.blockPolicies && archive.blockPolicies[blockId];
  for (const span of block.spans || []) {
    const spanPolicy = archive.spanPolicies && archive.spanPolicies[span.spanId];
    const policy = spanPolicy || blockPolicy;
    if (policy && policy.action === 'protect' && start < span.end && end > span.start) return true;
  }
  return blockPolicy && blockPolicy.action === 'protect';
}

function denied(reason) {
  return { applied: false, changed: false, reason, changedRanges: [], changedRange: null };
}

function normalizeResponse(snapshot, response) {
  requireRecord(response, 'provider response');
  let replacements = response.replacements || response.fragments;
  if (replacements === undefined && typeof response.text === 'string') {
    if (snapshot.blockFragments.length !== 1) {
      throw new TypeError('provider response.text is only valid for a single-block selection.');
    }
    replacements = [{ ...snapshot.blockFragments[0], text: response.text }];
  }
  if (!Array.isArray(replacements) || replacements.length !== snapshot.blockFragments.length) {
    throw new TypeError('provider response must contain exactly one replacement per selected block fragment.');
  }
  const expected = new Map(snapshot.blockFragments.map((fragment) => [fragment.blockId, fragment]));
  const seen = new Set();
  return replacements.map((raw, index) => {
    requireRecord(raw, `provider response replacements[${index}]`);
    const blockId = requireString(raw.blockId, `provider response replacements[${index}].blockId`);
    const fragment = expected.get(blockId);
    if (!fragment || seen.has(blockId) || raw.charStart !== fragment.charStart || raw.charEnd !== fragment.charEnd) {
      throw new TypeError(`provider response replacement[${index}] is outside the captured selection.`);
    }
    seen.add(blockId);
    if (typeof raw.text !== 'string') throw new TypeError(`provider response replacement[${index}].text must be a string.`);
    return { blockId, charStart: fragment.charStart, charEnd: fragment.charEnd, text: raw.text };
  });
}

/**
 * Guard-only form for callers that need to validate a response before
 * presenting it. It performs no editor or store mutation.
 */
function guardSelection(options = {}) {
  requireRecord(options, 'guardSelection options');
  requireBinding(options.binding);
  const snapshot = options.snapshot;
  if (!validateSnapshot(snapshot)) return { ok: false, reason: 'invalid-snapshot' };
  const expectedTargetRevision = requireRevision(options.expectedTargetRevision, 'expectedTargetRevision');
  const live = currentSelection(options.binding, snapshot);
  if (!live || selectionTextHash(live.text) !== snapshot.textHash) return { ok: false, reason: 'selection-changed' };
  // A touched block's full source-hash mismatch is deliberately classified
  // as `selection-changed`: this guard cannot prove that an unrelated edit
  // represents a project-revision move. The binding's observed revision check
  // below remains the authoritative `source-revision-moved` classification.
  for (const fragment of live.fragments) {
    if (fragment.currentHash !== fragment.textHash) return { ok: false, reason: 'selection-changed' };
    if (snapshot.sourceHashes[fragment.blockId] !== fragment.sourceHash) return { ok: false, reason: 'selection-changed' };
  }
  const first = snapshot.blockFragments[0];
  const expectedAnchor = options.expectedAnchor || {
    blockId: first.blockId,
    chunkId: snapshot.chunkId,
    ...(snapshot.blockFragments.length === 1 ? { charStart: first.charStart, charEnd: first.charEnd } : {}),
  };
  const guard = options.binding.selectionGuard(snapshot, snapshot.textHash, expectedTargetRevision, expectedAnchor);
  return guard && guard.ok === true ? { ok: true } : { ok: false, reason: guard && guard.reason ? guard.reason : 'selection-changed' };
}

/**
 * Verify a provider response and apply only captured ranges. A stale response
 * returns a typed denial before any D5/D2 call; accepted ranges are committed
 * in one D5 programmatic operation and therefore one undo action.
 */
function applySelectionResponse(options = {}) {
  const guard = guardSelection(options);
  if (!guard.ok) return denied(guard.reason);
  const snapshot = options.snapshot;

  const replacements = normalizeResponse(snapshot, options.response);
  for (const replacement of replacements) {
    if (protectedRange(options.binding.archive, replacement.blockId, replacement.charStart, replacement.charEnd)) {
      return denied('protected-range');
    }
  }
  const textByBlock = {};
  for (const replacement of replacements) textByBlock[replacement.blockId] = replacement.text;
  const commit = options.binding.applyProgrammaticReplace(
    replacements.map(({ blockId, charStart, charEnd }) => ({ blockId, charStart, charEnd })),
    textByBlock,
    { origin: options.origin || 'retranslate', operationId: snapshot.operationId },
  );
  const rangeDetails = replacements.map((replacement) => ({
    blockId: replacement.blockId,
    charStart: replacement.charStart,
    charEnd: replacement.charStart + replacement.text.length,
    originalCharStart: replacement.charStart,
    originalCharEnd: replacement.charEnd,
    oldLength: replacement.charEnd - replacement.charStart,
    newLength: replacement.text.length,
  }));
  const changedRanges = rangeDetails.map(({ blockId, charStart, charEnd }) => ({ blockId, charStart, charEnd }));
  return {
    ...commit,
    applied: true,
    changedRanges,
    changedRange: changedRanges.length === 1 ? changedRanges[0] : null,
    rangeDetails,
    operationId: snapshot.operationId,
  };
}

const createSelectionSnapshot = captureSelectionSnapshot;
const guardAndApplySelection = applySelectionResponse;
const applySelectionTranslation = applySelectionResponse;

module.exports = {
  hashText,
  captureSelectionSnapshot,
  createSelectionSnapshot,
  validateSnapshot,
  validateSelectionSnapshot: validateSnapshot,
  applySelectionResponse,
  guardAndApplySelection,
  applySelectionTranslation,
};
