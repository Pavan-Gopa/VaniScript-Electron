'use strict';

// Editorial editor core — ProseMirror projection schema (DOC-05, plan §10.7).
//
// Maps the closed D1-D4 block/span domain onto a ProseMirror schema and back:
//
//   Block (NormalizedDocument)  →  PM block node
//   ---------------------------     -----------------------------------------
//   kind: paragraph|heading|quote|verse|list|table|row|empty|other
//                                  one node type per kind, SAME name
//   blockId/part/index/page/level  node attrs (stable identity in attrs)
//   Span (exact tiling)            text nodes; traits as inline marks plus a
//                                  `span` mark carrying { spanId, policy, note }
//
// The `span` mark is the span-identity anchor: every text node in the source
// projection carries exactly one, so unchanged span IDs survive edits by
// construction — typed text inherits the marks at its position and therefore
// joins the span it was typed into (editor invariant #2). Policy metadata
// rides on the same mark so the projection can guard protected content
// without a second source of truth (the store's spanPolicies/blockPolicies
// stay canonical; the mark carries the RESOLVED effective policy).
//
// Everything in this module is pure and DOM-free: the schema works headlessly
// under node:test (no prosemirror-view, no jsdom). The DocumentState
// (DocumentArchive) remains the source of truth; a PM doc built here is only
// ever a projection of it (editor invariant #1).

const { createHash } = require('node:crypto');
const { Schema } = require('prosemirror-model');
const { validateDocumentArchive } = require('../../../shared/contracts/documents.ts');
const { createAppError } = require('../../../shared/contracts/errors.ts');

/** Inline trait marks, keyed exactly as the SpanTrait boolean fields. */
const TRAIT_MARKS = ['bold', 'italic', 'underline', 'strike', 'superScript', 'subScript', 'smallCaps'];

/** Mark carrying span identity + resolved translation policy. */
const SPAN_MARK = 'span';

/** Transaction meta key: origin of every dispatched transaction (plan §10.7). */
const EDITOR_ORIGIN_META = 'vaniscript/editorOrigin';

/** Reserved transaction origins. `user` is the default for plain dispatches. */
const EDITOR_ORIGINS = ['user', 'ai-replace', 'retranslate', 'policy', 'internal'];

const EDITOR_SCHEMA = new Schema({
  nodes: {
    doc: { content: 'block+' },
    // One node type per BlockKind, named identically, so node.type.name is
    // the domain kind. All carry the stable identity attrs; only the
    // structural kinds use `level`.
    paragraph: blockNode(),
    heading: blockNode(),
    quote: blockNode(),
    verse: blockNode(),
    list: blockNode(),
    table: blockNode(),
    row: blockNode(),
    empty: blockNode(),
    other: blockNode(),
    // Translation-side projection block: one per source block, carrying the
    // persisted BlockTranslation metadata as attrs so a translation-side undo
    // can restore text, freshness hash and review status faithfully.
    tblock: {
      group: 'block',
      content: 'inline*',
      attrs: {
        blockId: { default: '' },
        sourceHash: { default: null },
        status: { default: null },
        updatedAt: { default: null },
      },
    },
    text: { group: 'inline' },
  },
  marks: {
    bold: {},
    italic: {},
    underline: {},
    strike: {},
    superScript: {},
    subScript: {},
    smallCaps: {},
    color: { attrs: { color: {} } },
    span: {
      attrs: {
        spanId: {},
        /** Resolved effective policy: 'translate' | 'protect'. */
        policy: { default: 'translate' },
        note: { default: null },
      },
    },
  },
});

function blockNode() {
  return {
    group: 'block',
    content: 'inline*',
    attrs: {
      blockId: { default: '' },
      part: { default: 'main' },
      index: { default: 0 },
      page: { default: null },
      level: { default: null },
      styleFingerprint: { default: '' },
    },
  };
}

// --- Marks ↔ traits ----------------------------------------------------------

/** Sort a mark array into schema order (prosemirror-model requires it). */
function sortMarks(marks) {
  const order = new Map(Object.keys(EDITOR_SCHEMA.marks).map((name, i) => [name, i]));
  return marks.slice().sort((a, b) => order.get(a.type.name) - order.get(b.type.name));
}

/** Extract the SpanTrait shape of a text node's marks. */
function traitsOfMarks(marks) {
  const traits = {};
  for (const mark of marks) {
    if (TRAIT_MARKS.includes(mark.type.name)) traits[mark.type.name] = true;
    else if (mark.type.name === 'color') traits.color = mark.attrs.color;
  }
  return traits;
}

/** The `span` mark of a text node, if any (hygiene guarantees one). */
function spanMarkOf(marks) {
  return marks.find((m) => m.type.name === SPAN_MARK) || null;
}

/** Order-insensitive SpanTrait equality. */
function traitsEqual(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if ((a || {})[k] !== (b || {})[k]) return false;
  }
  return true;
}

function marksForSpan(schema, span) {
  const marks = [];
  for (const k of TRAIT_MARKS) if (span.traits[k]) marks.push(schema.marks[k].create());
  if (span.traits.color) marks.push(schema.marks.color.create({ color: span.traits.color }));
  return marks;
}

// --- Policy resolution -------------------------------------------------------

/**
 * Resolved effective policy of a span: the span override wins, then the
 * block policy, else translate. Mirrors the store's documented inheritance.
 */
function effectivePolicy(archive, spanId, blockId) {
  const spanPolicy = archive.spanPolicies[spanId];
  if (spanPolicy) return spanPolicy;
  const blockPolicy = archive.blockPolicies[blockId];
  if (blockPolicy) return blockPolicy;
  return { action: 'translate' };
}

// --- DocumentState → PM doc (projection build) -------------------------------

/**
 * Project a DocumentArchive into a PM source doc. Stable blockIds/spanIds are
 * preserved verbatim in node attrs / span marks (invariant #2 at load time).
 */
function buildSourceDoc(archive) {
  const schema = EDITOR_SCHEMA;
  const blocks = archive.blocks.map((block) => {
    const attrs = {
      blockId: block.blockId,
      part: block.part,
      index: block.index,
      page: block.page ?? null,
      level: block.level ?? null,
      styleFingerprint: block.styleFingerprint,
    };
    const content = block.spans.map((span) => {
      const policy = effectivePolicy(archive, span.spanId, block.blockId);
      const marks = sortMarks([
        ...marksForSpan(schema, span),
        schema.marks[SPAN_MARK].create({
          spanId: span.spanId,
          policy: policy.action,
          note: policy.note ?? null,
        }),
      ]);
      return schema.text(span.text, marks);
    });
    return schema.nodes[block.kind].create(attrs, content.length ? content : null);
  });
  if (blocks.length === 0) {
    throw createAppError('VALIDATION_FAILED', 'Editor requires a document with at least one block.');
  }
  return schema.node('doc', null, blocks);
}

// --- PM doc → span tiling (commit-side derivation) ---------------------------

/**
 * Derive a block's text + exact span tiling from a PM block node by walking
 * its inline content. Consecutive text nodes with equal spanId AND traits are
 * one span (the same run-merging rule the importer applies). `spanId` is
 * null only for text the span-hygiene pass has not stamped yet (transient
 * inside a transaction); commit paths require it to be resolved.
 */
function deriveBlockFromNode(blockNode) {
  const runs = [];
  blockNode.forEach((child) => {
    if (!child.isText) return;
    const spanMark = spanMarkOf(child.marks);
    const spanId = spanMark ? spanMark.attrs.spanId : null;
    const policy = spanMark ? spanMark.attrs.policy : null;
    const note = spanMark ? spanMark.attrs.note : null;
    const traits = traitsOfMarks(child.marks);
    const last = runs[runs.length - 1];
    if (last && last.spanId === spanId && last.policy === policy && traitsEqual(last.traits, traits)) {
      last.text += child.text;
    } else {
      runs.push({ spanId, policy, note, traits, text: child.text });
    }
  });
  const spans = [];
  let offset = 0;
  for (const run of runs) {
    spans.push({
      spanId: run.spanId,
      blockId: blockNode.attrs.blockId,
      text: run.text,
      start: offset,
      end: offset + run.text.length,
      traits: { ...run.traits },
      policy: run.policy,
      note: run.note,
    });
    offset = offset + run.text.length;
  }
  return { text: runs.map((r) => r.text).join(''), spans };
}

/**
 * Validate spans as an exact tiling of `text` — the same contract the D2
 * store enforces on updateBlockText, applied by the editor BEFORE anything is
 * applied or written (malformed programmatic input is rejected before it can
 * touch the document). Throws a typed AppError; returns normalized copies.
 */
function validateSpanTiling(blockId, text, spans) {
  if (!Array.isArray(spans)) {
    throw createAppError('VALIDATION_FAILED', 'spans must be an array.');
  }
  const out = [];
  let prevEnd = 0;
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      throw createAppError('VALIDATION_FAILED', `spans[${i}] must be an object.`);
    }
    if (typeof s.spanId !== 'string' || s.spanId.length === 0) {
      throw createAppError('VALIDATION_FAILED', `spans[${i}].spanId is required.`);
    }
    if (s.blockId !== blockId) {
      throw createAppError('VALIDATION_FAILED', `spans[${i}].blockId must be "${blockId}".`);
    }
    if (!Number.isInteger(s.start) || !Number.isInteger(s.end)) {
      throw createAppError('VALIDATION_FAILED', `spans[${i}].start/end must be integers.`);
    }
    if (s.start !== prevEnd) {
      throw createAppError(
        'VALIDATION_FAILED',
        `spans[${i}] must start at offset ${prevEnd}, got ${s.start}.`,
      );
    }
    if (s.end <= s.start) {
      throw createAppError('VALIDATION_FAILED', `spans[${i}] must not be empty.`);
    }
    if (s.end > text.length) {
      throw createAppError('VALIDATION_FAILED', `spans[${i}].end exceeds text length.`);
    }
    if (typeof s.text !== 'string' || s.text !== text.slice(s.start, s.end)) {
      throw createAppError(
        'VALIDATION_FAILED',
        `spans[${i}].text must equal text.slice(${s.start}, ${s.end}).`,
      );
    }
    if (!s.traits || typeof s.traits !== 'object' || Array.isArray(s.traits)) {
      throw createAppError('VALIDATION_FAILED', `spans[${i}].traits must be an object.`);
    }
    out.push({
      spanId: s.spanId,
      blockId,
      text: s.text,
      start: s.start,
      end: s.end,
      traits: { ...s.traits },
    });
    prevEnd = s.end;
  }
  if (prevEnd !== text.length) {
    throw createAppError(
      'VALIDATION_FAILED',
      `spans must tile the full text (covered 0..${prevEnd} of ${text.length}).`,
    );
  }
  return out;
}

// --- Fingerprint maintenance (editorial-layer duty per DOC-02) ----------------

const FINGERPRINT_TRAIT_KEYS = [...TRAIT_MARKS, 'color'];

/**
 * Same algorithm as the importer's styleFingerprint: a stable content-derived
 * fingerprint of the block's kind/level/span traits. Recomputed by the editor
 * only when a block's structure or traits change; unchanged blocks keep the
 * imported fingerprint byte-for-byte.
 */
function styleFingerprintFor(kind, level, spans) {
  let s = `${kind}|${level === undefined || level === null ? '' : level}`;
  for (const sp of spans) {
    for (const k of FINGERPRINT_TRAIT_KEYS) if (sp.traits[k]) s += `|${k}`;
  }
  return createHash('sha1').update(s).digest('hex').slice(0, 12);
}


/** True when two derived tilings carry the same trait shape (per position). */
function spansShapeEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!traitsEqual(a[i].traits, b[i].traits)) return false;
  }
  return true;
}

/** Content equality of a persisted block vs a derived one (ids ignored). */
function blockContentEqual(prev, kind, level, text, spans) {
  return (
    prev.kind === kind &&
    (prev.level ?? null) === (level ?? null) &&
    prev.text === text &&
    spansShapeEqual(prev.spans, spans)
  );
}

/**
 * Build the next DocumentArchive candidate from a post-transaction PM doc:
 * re-derives every block's text/spans, re-indexes per part, preserves
 * sourceHash/page, maintains styleFingerprints (recomputed ONLY for
 * trait/structure changes), records first-edit-wins baselines, and bumps
 * `editEpoch` (the persisted undo-recovery boundary). The candidate is fully
 * validated with the D1/D2 contract validator before it is returned, so a
 * caller can persist or reject it without ever holding an invalid state.
 */
function nextArchiveFromDoc(archive, doc, options = {}) {
  // `assumeChanged` forces the validated candidate through the persist path
  // even when content equality says nothing changed: identity-only retiles
  // (span-id drift that minting authorized) must land on disk or the
  // projection would diverge from the canonical archive.
  const assumeChanged = options.assumeChanged === true;
  const prevById = new Map(archive.blocks.map((b) => [b.blockId, b]));
  const baselines = { ...archive.editBaselines };
  const blocks = [];
  const perPartCount = new Map();
  let changed = doc.childCount !== archive.blocks.length;

  const nextOrder = [];
  doc.forEach((node) => {
    const blockId = node.attrs.blockId;
    if (!blockId) {
      throw createAppError('INTERNAL', 'Block node without blockId reached the commit builder.');
    }
    nextOrder.push(blockId);
    const kind = node.type.name;
    const level = node.attrs.level ?? undefined;
    const { text, spans } = deriveBlockFromNode(node);
    for (const span of spans) {
      if (!span.spanId) {
        throw createAppError('INTERNAL', `Block "${blockId}" has unstamped span text at commit time.`);
      }
    }
    const prev = prevById.get(blockId);
    const part = node.attrs.part || 'main';
    const index = perPartCount.get(part) ?? 0;
    perPartCount.set(part, index + 1);

    const domain = {
      blockId,
      kind,
      part,
      index,
      styleFingerprint: fingerprintFor(prev, kind, level, spans),
      sourceHash: prev ? prev.sourceHash : archive.sourceAsset.hash,
      text,
      spans,
    };
    if (level !== undefined) domain.level = level;
    if (node.attrs.page != null) domain.page = node.attrs.page;

    if (prev) {
      const contentChanged = !blockContentEqual(prev, kind, level, text, spans);
      if (contentChanged) {
        changed = true;
        // First edit wins: baseline is the block exactly as previously
        // persisted (as imported, or as of its first committed edit).
        if (baselines[blockId] === undefined) baselines[blockId] = structuredClone(prev);
      }
    } else {
      changed = true;
    }
    blocks.push(domain);
  });
  // A pure reorder (same blocks, same content, different sequence) must
  // commit too: content equality alone cannot see it, and skipping would
  // leave the store permanently out of sync with the projection.
  if (
    !changed &&
    nextOrder.join('\u0000') !== archive.blocks.map((b) => b.blockId).join('\u0000')
  ) {
    changed = true;
  }
  if (!changed && !assumeChanged) {
    return { archive, changed };
  }
  const candidate = validateDocumentArchive({
    ...archive,
    blocks,
    editBaselines: baselines,
    editEpoch: archive.editEpoch + 1,
  });
  if (!candidate.ok) throw candidate.error;
  return { archive: candidate.value, changed };
}

/** Keep the persisted fingerprint when the trait shape is unchanged. */
function fingerprintFor(prev, kind, level, spans) {
  const fresh = styleFingerprintFor(kind, level, spans);
  if (prev && styleFingerprintFor(prev.kind, prev.level ?? null, prev.spans) === fresh) {
    return prev.styleFingerprint;
  }
  return fresh;
}

module.exports = {
  EDITOR_SCHEMA,
  EDITOR_ORIGIN_META,
  EDITOR_ORIGINS,
  SPAN_MARK,
  TRAIT_MARKS,
  buildSourceDoc,
  deriveBlockFromNode,
  validateSpanTiling,
  traitsEqual,
  spansShapeEqual,
  effectivePolicy,
  nextArchiveFromDoc,
  styleFingerprintFor,
  sortMarks,
  marksForSpan,
  spanMarkOf,
  traitsOfMarks,
};
