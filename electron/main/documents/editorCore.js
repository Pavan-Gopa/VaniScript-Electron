'use strict';

// Editorial editor core — DocumentState↔ProseMirror binding (DOC-05, plan §10.7).
//
// This module owns the runtime half of the editor invariant set (plan §10.7):
//
//   1. DocumentState (DocumentArchive) is the source of truth; the PM doc is
//      only ever a projection of it. Every accepted transaction is committed
//      back into the store BEFORE the binding's projection state advances,
//      so a failed commit never desynchronizes the two.
//   2. Unchanged span IDs survive edits (schema-level guarantee; this module
//      mints trusted IDs ONLY for genuinely new content).
//   3. AI/paste content arrives as text, never identity: trusted block/span
//      IDs are minted here, and identity arriving through ANY path — a raw
//      user transaction included — is trusted only when the canonical
//      archive already carries it. Everything else is stripped and reminted.
//   5. A programmatic replace/retranslate is ONE atomic undo step (see
//      "Undo grouping convention" below).
//   6. Clipboard operations cross the MANDATORY sanitize/remint boundary:
//      EditorBinding.applyPaste serializes every paste — payload or raw
//      foreign fragment — through editorClipboard.js, so no private ID can
//      enter the document and no private ID can leave through a copy.
//   7. A selection-AI response applies only when the selection hash, its
//      structural anchor, AND the observed revisions still match
//      (`selectionGuard`, plan §10.8).
//   8. LOG SAFETY: this module contains no console/log calls at all, and its
//      error messages quote identifiers and lengths — never document text —
//      so no code path can serialize manuscript content into a log.
//
// Undo grouping convention (prosemirror-history, per its documented API):
// one programmatic operation builds ALL of its replacements into ONE
// Transaction stamped with `addToHistory: true` (force-recorded) and closed
// with the library's own `closeHistory(tr)` helper (which stamps the
// private key the history plugin actually reads — a plain
// `setMeta('closeHistory', …)` is inert). The public `closeHistory` meta is
// stamped alongside as a transferable marker so the canonical-rewrite path
// can re-close the committed event without touching private keys. The
// close flushes any pending adjacent-typing group, so the operation can
// never glue onto a preceding partial typing group and always starts a
// fresh undo event; `undo()` therefore reverts a whole programmatic
// operation in a single call. Undo/redo-generated transactions carry the
// reserved `internal` origin.
//
// Commit conventions:
//   - EVERY accepted transaction persists as ONE validated candidate archive
//     through ONE `saveDocumentArchive` call — the store's atomic CAS/WAL
//     mutation. Derived content, span-policy deltas, and fingerprint
//     maintenance are folded into the candidate BEFORE it is persisted, so
//     there is no multi-write cascade that could die halfway and strand
//     disk, binding, and projection in divergent states (§10.8
//     all-or-nothing). The projection advance itself is preflighted before
//     the store call and only assigned after the store returns.
//   - A transaction built against any editor state other than the CURRENT
//     binding state is rejected typed (CONFLICT) before any store
//     interaction — a retained transaction can never persist a stale or
//     reverted document.
//   - Identity-only mutations (span retiles the minting pass authorized,
//     structural-attr drift) are detected BEFORE the content-equality
//     no-op branch: authorized retiles persist a matching candidate,
//     unauthorized ones (foreign/moved span ids, hand-mutated structural
//     attrs) are rejected typed.
//   - Every commit chains the revision returned by the store; a CAS
//     CONFLICT propagates verbatim and leaves the binding untouched (the
//     caller reloads and rebuilds).

const { EditorState, TextSelection } = require('prosemirror-state');
const { createHash } = require('node:crypto');
const { Mapping } = require('prosemirror-transform');
const { Fragment, Slice } = require('prosemirror-model');
const { history, undo, closeHistory } = require('prosemirror-history');
const {
  EDITOR_SCHEMA,
  EDITOR_ORIGIN_META,
  SPAN_MARK,
  TRAIT_MARKS,
  buildSourceDoc,
  deriveBlockFromNode,
  effectivePolicy,
  nextArchiveFromDoc,
  sortMarks,
  spanMarkOf,
  traitsOfMarks,
} = require('./editorSchema.js');
const { clipboardPayload, fragmentFromPayload } = require('./editorClipboard.js');
const { BLOCK_KINDS } = require('../../../shared/contracts/documents.ts');
const { createAppError } = require('../../../shared/contracts/errors.ts');

/** Shape discriminator of the §10.8 selection snapshot contract. */
const SELECTION_SNAPSHOT_KIND = 'vaniscript/selection-snapshot@1';

/** Origins allowed for programmatic replacements (invariant #5/#3). */
const PROGRAMMATIC_ORIGINS = ['ai-replace', 'retranslate'];

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Public meta marker mirroring the library's close-history stamp (see header). */
const CLOSE_HISTORY_META = 'closeHistory';

// --- Input preconditions (planner conventions: programmer input fails loud) --

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

/**
 * Minimal structural precheck of a document archive — the few fields the
 * editor reads. Full structural validation remains the contract validator's
 * job (mirrors the chunk planner's split of duties).
 */
function requireDocument(document) {
  requireObject(document, 'loadDocumentIntoEditor expects a normalized document archive');
  if (!Array.isArray(document.blocks)) {
    throw new TypeError('document archive must carry a blocks array.');
  }
  if (typeof document.projectId !== 'string' || document.projectId.length === 0) {
    throw new TypeError('document archive must carry a projectId.');
  }
}

// --- Load: DocumentState → PM doc --------------------------------------------

/**
 * Project a normalized DocumentArchive into a ProseMirror source doc.
 * Stable blockIds/spanIds are preserved verbatim in node attrs / span marks
 * (editor invariant #2 at load time). Block kinds are gated to the shared
 * BLOCK_KINDS domain — the schema also carries projection-only node types
 * (e.g. `tblock`) that are NOT loadable source kinds. Throws `TypeError` on
 * garbage input and the schema module's typed errors for archives the
 * projection cannot represent (e.g. zero blocks).
 */
function loadDocumentIntoEditor(document) {
  requireDocument(document);
  for (let i = 0; i < document.blocks.length; i++) {
    const block = document.blocks[i];
    if (block === null || typeof block !== 'object') {
      throw new TypeError(`document.blocks[${i}] must be an object.`);
    }
    requireNonEmptyString(block.blockId, `document.blocks[${i}].blockId`);
    if (typeof block.kind !== 'string' || !BLOCK_KINDS.includes(block.kind)) {
      throw new TypeError(`document.blocks[${i}].kind "${block.kind}" is not a source block kind.`);
    }
    if (!Array.isArray(block.spans)) {
      throw new TypeError(`document.blocks[${i}].spans must be an array.`);
    }
  }
  return buildSourceDoc(document);
}

// --- Trusted ID minting (invariants #2/#3/#6) --------------------------------

/**
 * Smallest free block id (`b<n>` — the importer's scheme), skipping ids
 * already in use so minted identity can never collide with persisted or
 * previously minted identity.
 */
function nextFreeId(used) {
  let n = 0;
  while (used.has(`b${n}`)) n += 1;
  return `b${n}`;
}

function nextFreeSpanId(blockId, used) {
  let n = 0;
  const prefix = `${blockId}-s`;
  while (used.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

function spanMarkFor(schema, spanId, policy = 'translate', note = null) {
  return schema.marks[SPAN_MARK].create({ spanId, policy, note });
}

/** Every span id the canonical archive vouches for. */
function archiveSpanIds(archive) {
  const ids = new Set();
  for (const block of archive.blocks) {
    for (const span of block.spans) ids.add(span.spanId);
  }
  return ids;
}

/**
 * Stamp trusted identity onto projection content. An id survives ONLY when
 * the caller's trust set vouches for it (canonical archive ids for commit
 * paths; nothing at all for paste preparation):
 *
 *   - a block node with an EMPTY blockId, a DUPLICATE of an id already seen
 *     in this doc (tr.split copies attrs), or a FOREIGN id outside the
 *     trust set gets a freshly minted one;
 *   - text whose span id is trusted and not yet consumed passes through
 *     untouched (and separates minted runs on either side of it);
 *   - text whose span id is a duplicate of a trusted span is reminted with
 *     the source mark's resolved policy — trusted, because the mark came
 *     from this archive's own projection (protection survives splits and
 *     copies);
 *   - unstamped or foreign-stamped text is reminted with the DESTINATION
 *     policy for its block (`trust.policyFor`) — never with a policy the
 *     incoming content carried.
 *
 * Minted ids continue the importer's sequential schemes and skip every id
 * in the trust/reserve sets or present anywhere in the transaction result.
 *
 * @param trust {{
 *   blocks?: Iterable<string>, spans?: Iterable<string>,
 *   reserveBlocks?: Iterable<string>, reserveSpans?: Iterable<string>,
 *   policyFor?: (blockId: string) => { action: string, note: string|null },
 * }} omitted ⇒ nothing is trusted (paste preparation).
 * @returns {{ doc, minted: boolean, mintedBlockIds: Set, mintedSpanIds: Set }}
 */
function mintProjectionIds(doc, trust = {}) {
  const passBlocks = new Set(trust.blocks ?? []);
  const passSpans = new Set(trust.spans ?? []);
  const usedBlockIds = new Set([...passBlocks, ...(trust.reserveBlocks ?? [])]);
  const usedSpanIds = new Set([...passSpans, ...(trust.reserveSpans ?? [])]);
  const policyFor = trust.policyFor ?? (() => ({ action: 'translate', note: null }));
  doc.forEach((node) => {
    if (node.attrs.blockId) usedBlockIds.add(node.attrs.blockId);
  });
  doc.forEach((block) => {
    block.forEach((child) => {
      const mark = spanMarkOf(child.marks);
      if (mark) usedSpanIds.add(mark.attrs.spanId);
    });
  });
  const seenBlockIds = new Set();
  const seenSpanIds = new Set();
  const mintedBlockIds = new Set();
  const mintedSpanIds = new Set();
  let changed = false;
  const blocks = [];
  doc.forEach((block) => {
    let blockId = block.attrs.blockId;
    let blockChanged = false;
    if (!blockId || seenBlockIds.has(blockId) || !passBlocks.has(blockId)) {
      blockId = nextFreeId(usedBlockIds);
      usedBlockIds.add(blockId);
      mintedBlockIds.add(blockId);
      changed = true;
      blockChanged = true;
    }
    seenBlockIds.add(blockId);
    const inline = [];
    let pending = null; // { text, traits, marks, policy }
    const flush = () => {
      if (!pending) return;
      const spanId = nextFreeSpanId(blockId, usedSpanIds);
      usedSpanIds.add(spanId);
      mintedSpanIds.add(spanId);
      inline.push(
        EDITOR_SCHEMA.text(
          pending.text,
          sortMarks([...pending.marks, spanMarkFor(EDITOR_SCHEMA, spanId, pending.policy.action, pending.policy.note)]),
        ),
      );
      pending = null;
      changed = true;
      blockChanged = true;
    };
    block.forEach((child) => {
      if (!child.isText) {
        flush();
        inline.push(child);
        return;
      }
      const mark = spanMarkOf(child.marks);
      if (mark && passSpans.has(mark.attrs.spanId)) {
        if (!seenSpanIds.has(mark.attrs.spanId)) {
          // First occurrence of a trusted span: passes through untouched.
          flush();
          seenSpanIds.add(mark.attrs.spanId);
          inline.push(child);
          return;
        }
        // Duplicate of a trusted span (split/copy copied the mark): remint,
        // preserving the mark's trusted resolved policy/note.
        const policy = { action: mark.attrs.policy ?? 'translate', note: mark.attrs.note ?? null };
        const traits = traitsOfMarks(child.marks);
        if (
          pending &&
          (!traitsEqualForMint(pending.traits, traits) ||
            pending.policy.action !== policy.action ||
            pending.policy.note !== policy.note)
        ) {
          flush();
        }
        if (pending) pending.text += child.text;
        else pending = { text: child.text, traits, marks: traitMarksOnly(child.marks), policy };
        return;
      }
      // Unstamped or foreign-stamped text joins the minting merge under the
      // destination's resolved policy — external policy is never trusted.
      const policy = policyFor(blockId);
      const traits = traitsOfMarks(child.marks);
      if (
        pending &&
        (!traitsEqualForMint(pending.traits, traits) ||
          pending.policy.action !== policy.action ||
          pending.policy.note !== policy.note)
      ) {
        flush();
      }
      if (pending) pending.text += child.text;
      else pending = { text: child.text, traits, marks: traitMarksOnly(child.marks), policy };
    });
    flush();
    blocks.push(
      blockChanged ? block.type.create({ ...block.attrs, blockId }, Fragment.fromArray(inline)) : block,
    );
  });
  if (!changed) return { doc, minted: false, mintedBlockIds, mintedSpanIds };
  return { doc: EDITOR_SCHEMA.node('doc', null, Fragment.fromArray(blocks)), minted: true, mintedBlockIds, mintedSpanIds };
}

/** Trait-mark subset of a mark array (drops any existing span mark). */
function traitMarksOnly(marks) {
  return marks.filter((m) => TRAIT_MARKS.includes(m.type.name) || m.type.name === 'color');
}

function traitsEqualForMint(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * Locate the absolute ProseMirror positions of a UTF-16 character range
 * inside a block, plus the marks at the range start — the span identity and
 * formatting a programmatic replacement inherits (editor invariant #3).
 * The schema's inline content is text-only, so in-block PM offsets map 1:1
 * onto UTF-16 offsets. An empty block yields its single insert position
 * with no marks. Throws `TypeError` for a range beyond the block's text.
 */
function locateCharRange(doc, blockId, charStart, charEnd) {
  let contentStart = 1; // first block's inline content begins at position 1
  for (let i = 0; i < doc.childCount; i++) {
    const block = doc.child(i);
    const contentSize = block.content.size;
    if (block.attrs.blockId === blockId) {
      if (charStart > contentSize || charEnd > contentSize) {
        throw new TypeError(
          `programmatic replace range ${charStart}..${charEnd} exceeds block "${blockId}" length ${contentSize}.`,
        );
      }
      const from = contentStart + charStart;
      const $from = doc.resolve(from);
      return { from, to: contentStart + charEnd, marks: $from.marks() };
    }
    contentStart += block.nodeSize;
  }
  throw new TypeError(`programmatic replace target block "${blockId}" is not in the projection.`);
}

// --- Selection hashing (§10.8 primitive) --------------------------------------

/**
 * Canonical SHA-256 hex of a selection text — the same algorithm the store
 * applies to block text (`blockSourceHash`), applied to the captured
 * selection string so snapshot hashes and live hashes compare equal.
 */
function selectionTextHash(text) {
  if (typeof text !== 'string') throw new TypeError('selectionTextHash expects a string.');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// --- Selection guard (§10.8, editor invariant #7) -----------------------------

/**
 * Structural check of a `SelectionSnapshot` (shared/contracts/documents.ts).
 * A malformed snapshot is RUNTIME data, so it denies typed ('invalid-snapshot')
 * instead of throwing — only the caller-side expectation arguments are
 * programmer input and fail loud with TypeError.
 */
function isValidSelectionSnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  if (snapshot.kind !== SELECTION_SNAPSHOT_KIND) return false;
  for (const key of ['operationId', 'language', 'blockId', 'textHash', 'sourceRevision', 'targetRevision', 'createdAt']) {
    const value = snapshot[key];
    if (typeof value !== 'string' || value.length === 0) return false;
  }
  if (!SHA256_HEX.test(snapshot.textHash)) return false;
  if (!Number.isInteger(snapshot.textLength) || snapshot.textLength < 0) return false;
  // Optional range anchor: strictly paired, integer-bounded, and exactly as
  // long as the captured selection text.
  const hasStart = snapshot.charStart !== undefined;
  const hasEnd = snapshot.charEnd !== undefined;
  if (hasStart !== hasEnd) return false;
  if (hasStart) {
    if (!Number.isInteger(snapshot.charStart) || !Number.isInteger(snapshot.charEnd)) return false;
    if (snapshot.charStart < 0 || snapshot.charEnd < snapshot.charStart) return false;
    if (snapshot.charEnd - snapshot.charStart !== snapshot.textLength) return false;
  }
  const { chunkId } = snapshot;
  if (chunkId !== null && (typeof chunkId !== 'string' || chunkId.length === 0)) return false;
  return !Number.isNaN(Date.parse(snapshot.createdAt));
}

// --- Paste boundary (invariants #3/#6) -----------------------------------------

/**
 * The MANDATORY sanitize step of the paste boundary: whatever comes in — a
 * `clipboardPayload` from the copy path, or any foreign ProseMirror value
 * (Slice/Fragment/Node, bare text nodes included) — is serialized down to
 * public text + traits and rebuilt WITHOUT any identity. There is no
 * stamped fast path: a fully stamped foreign fragment takes the same round
 * trip, so nothing id-bearing can ride along. Trusted destination identity
 * is minted afterwards (commit time for `applyPaste`,
 * `preparePasteFragment` for standalone preparation).
 */
function sanitizedPasteFragment(content) {
  if (content && typeof content === 'object' && Array.isArray(content.segments)) {
    return fragmentFromPayload(content); // id-free by construction
  }
  return fragmentFromPayload(clipboardPayload(content));
}

/** Insertable slice shape for a sanitized paste fragment. */
function sliceForPaste(fragment) {
  if (fragment.childCount === 1 && fragment.child(0).content.size > 0) {
    // Inline-shaped paste: splice the paragraph's content at the selection.
    return new Slice(fragment, 1, 1);
  }
  return new Slice(fragment, 0, 0);
}

/**
 * Mint trusted identity for an id-free clipboard fragment (editor
 * invariant #3). ALWAYS sanitizes first — even a fully stamped foreign
 * fragment is stripped and reminted; nothing passes through. When the
 * caller knows the destination, `options.reserveBlockIds`/
 * `reserveSpanIds` keep minted ids clear of it.
 */
function preparePasteFragment(fragment, options = {}) {
  if (!(fragment instanceof Fragment)) {
    throw new TypeError('preparePasteFragment expects a ProseMirror Fragment.');
  }
  const clean = sanitizedPasteFragment(fragment);
  const { doc } = mintProjectionIds(EDITOR_SCHEMA.node('doc', null, clean), {
    reserveBlocks: options.reserveBlockIds ?? [],
    reserveSpans: options.reserveSpanIds ?? [],
  });
  const blocks = [];
  doc.forEach((node) => blocks.push(node));
  return Fragment.fromArray(blocks);
}

// --- The binding --------------------------------------------------------------

const EDITOR_BINDING_STORE_METHODS = ['saveDocumentArchive'];

/**
 * Runtime binding between one DocumentArchive (canonical) and its
 * ProseMirror projection. See the module header for the commit and undo
 * conventions. `options.revision` is the source project revision observed
 * when the archive was loaded; commits CAS against it and advance it from
 * each store result. Until a revision is known, committing throws CONFLICT.
 */
class EditorBinding {
  constructor(document, store, revision) {
    requireDocument(document);
    requireObject(store, 'createEditorBinding expects a store object');
    for (const method of EDITOR_BINDING_STORE_METHODS) {
      if (typeof store[method] !== 'function') {
        throw new TypeError(`store.${method} must be a function.`);
      }
    }
    if (revision !== undefined && revision !== null && typeof revision !== 'string') {
      throw new TypeError('options.revision must be a string when provided.');
    }
    this._document = document;
    this._store = store;
    this._projectId = document.projectId;
    this._archive = document;
    this._revision = revision ?? null;
    this._state = EditorState.create({
      doc: buildSourceDoc(document),
      plugins: [history()],
    });
  }

  /** Current PM projection doc (post-commit truth of the binding). */
  get doc() {
    return this._state.doc;
  }

  /** Current editor state; build transactions from THIS state. */
  get state() {
    return this._state;
  }

  /** Canonical archive the projection currently reflects. */
  get archive() {
    return this._archive;
  }

  /** Known source project revision, or null until the caller provides one. */
  get revision() {
    return this._revision;
  }

  /**
   * Commit a user-authored transaction. The caller builds it against the
   * binding's state (or a view sharing that doc); the binding never mutates
   * it. Plain dispatches carry no origin meta, which the schema contract
   * defines as the `user` origin. A transaction built against any other
   * state is rejected typed before any store interaction. Store-first
   * discipline with a preflighted advance: the canonical commit happens
   * BEFORE the projection advances, so a thrown conflict leaves both sides
   * untouched and the caller re-syncs from a fresh load.
   *
   * @returns {{ changed: boolean, archive: object, revision: string|null }}
   */
  applyUserTransaction(tr) {
    return this._commitProjection(tr);
  }

  /**
   * Apply a programmatic text replacement (AI replace / retranslate response)
   * as ONE atomic operation: every target is replaced inside a single
   * transaction (invariant #5), stamped with the reserved origin and the
   * history-grouping metas documented in the module header, then committed
   * through the shared pipeline like any other accepted edit.
   *
   * Replacement text inherits the marks — including span identity — at the
   * START of the replaced range (editor invariant #3: the caller supplies
   * text only, never identity/styles; §10.8 "preserve surrounding
   * formatting"). An EMPTY replacement text deletes the range (an empty
   * text node cannot exist in ProseMirror). Spans fully covered by the
   * range are absorbed; their possible policy overrides simply become
   * unreferenced entries.
   *
   * Targets are applied bottom-up (descending document order) so positions
   * located on the pre-operation doc stay valid across replacements.
   *
   * @param blockTargets Array of `{ blockId, charStart?, charEnd? }`; an
   *   omitted range replaces the whole block, `charStart === charEnd`
   *   inserts at that offset.
   * @param textByBlock Map blockId → replacement text (UTF-16, like PM);
   *   the empty string deletes.
   * @param meta `{ origin: 'ai-replace' | 'retranslate', ... }`.
   * @returns {{ changed: boolean, archive: object, revision: string|null }}
   */
  applyProgrammaticReplace(blockTargets, textByBlock, meta) {
    if (!Array.isArray(blockTargets) || blockTargets.length === 0) {
      throw new TypeError('applyProgrammaticReplace expects a non-empty blockTargets array.');
    }
    requireObject(textByBlock, 'textByBlock');
    requireObject(meta, 'meta');
    if (!PROGRAMMATIC_ORIGINS.includes(meta.origin)) {
      throw new TypeError(
        `meta.origin must be one of: ${PROGRAMMATIC_ORIGINS.map((o) => `"${o}"`).join(', ')}.`,
      );
    }
    const knownBlocks = new Set(this._archive.blocks.map((b) => b.blockId));
    const parsed = blockTargets.map((target, i) => {
      if (target === null || typeof target !== 'object') {
        throw new TypeError(`blockTargets[${i}] must be an object.`);
      }
      requireNonEmptyString(target.blockId, `blockTargets[${i}].blockId`);
      if (!knownBlocks.has(target.blockId)) {
        throw new TypeError(`blockTargets[${i}] references unknown blockId "${target.blockId}".`);
      }
      const text = textByBlock[target.blockId];
      if (typeof text !== 'string') {
        throw new TypeError(`textByBlock["${target.blockId}"] must carry a string replacement.`);
      }
      const charStart = target.charStart === undefined ? 0 : target.charStart;
      if (!Number.isInteger(charStart) || charStart < 0) {
        throw new TypeError(`blockTargets[${i}].charStart must be a non-negative integer.`);
      }
      const charEnd =
        target.charEnd === undefined
          ? this._archive.blocks.find((b) => b.blockId === target.blockId).text.length
          : target.charEnd;
      if (!Number.isInteger(charEnd) || charEnd < charStart) {
        throw new TypeError(`blockTargets[${i}].charEnd must be an integer >= charStart.`);
      }
      return { blockId: target.blockId, charStart, charEnd, text };
    });
    for (const key of Object.keys(textByBlock)) {
      if (!parsed.some((p) => p.blockId === key)) {
        throw new TypeError(`textByBlock key "${key}" has no matching blockTarget.`);
      }
    }
    const doc = this._state.doc;
    const located = parsed.map((p) => ({ ...p, ...locateCharRange(doc, p.blockId, p.charStart, p.charEnd) }));
    located.sort((a, b) => b.from - a.from || b.to - a.to);
    const tr = this._state.tr;
    for (const loc of located) {
      if (loc.text === '') {
        // Empty replacement = deletion: an empty text node cannot exist.
        if (loc.to > loc.from) tr.delete(loc.from, loc.to);
        continue;
      }
      tr.replaceWith(loc.from, loc.to, loc.marks.length ? EDITOR_SCHEMA.text(loc.text, loc.marks) : EDITOR_SCHEMA.text(loc.text));
    }
    tr.setMeta(EDITOR_ORIGIN_META, meta.origin);
    tr.setMeta('addToHistory', true);
    // The library helper stamps the private key the plugin reads; the
    // public marker lets canonical rewrites transfer the intent.
    closeHistory(tr);
    tr.setMeta(CLOSE_HISTORY_META, true);
    return this._commitProjection(tr);
  }

  /**
   * Paste boundary (editor invariant #6): EVERYTHING enters the document
   * through the clipboard sanitizer. A `clipboardPayload` from the copy
   * path, or any foreign ProseMirror content (Slice/Fragment/Node, bare
   * text nodes included), is serialized down to public text + traits and
   * rebuilt without identity; the shared commit pipeline then mints
   * destination-trusted ids with full destination context (existing-block
   * policies included). There is no stamped fast path — a fully stamped
   * foreign fragment is stripped and reminted like anything else.
   *
   * @param at Optional absolute PM position naming the drop point; the
   *   default is the state's current selection.
   * @returns {{ changed: boolean, archive: object, revision: string|null }}
   */
  applyPaste(content, at) {
    const fragment = sanitizedPasteFragment(content);
    const tr = this._state.tr;
    if (at !== undefined) {
      // Headless callers name the drop point explicitly; the default is the
      // state's current selection (a live view shares it).
      if (!Number.isInteger(at) || at < 0 || at > tr.doc.content.size) {
        throw new TypeError('applyPaste position "at" must be within the document.');
      }
      const $at = tr.doc.resolve(at);
      tr.setSelection(
        $at.parent.inlineContent
          ? TextSelection.create(tr.doc, at)
          : TextSelection.near($at), // block boundaries resolve nearby
      );
    }
    tr.replaceSelection(sliceForPaste(fragment));
    return this._commitProjection(tr);
  }

  /**
   * Undo the most recent history event (whole programmatic operations undo
   * as one step — see the module header). The undone transaction carries
   * the `internal` origin (machine-derived, not typed by a human) and is
   * committed like any accepted edit; when there is nothing to undo nothing
   * is committed and the binding is untouched.
   */
  undo() {
    let undone = null;
    const ok = undo(this._state, (tr) => {
      undone = tr;
    });
    if (!ok || !undone) {
      return { changed: false, archive: this._archive, revision: this._revision };
    }
    undone.setMeta(EDITOR_ORIGIN_META, 'internal');
    return this._commitProjection(undone);
  }

  /**
   * §10.8 primitive (editor invariant #7): decide whether a captured
   * selection snapshot may still have its AI response applied. Deny
   * precedence follows the contract's SelectionGuardDenyReason order:
   *   - 'invalid-snapshot'     — the snapshot itself is malformed;
   *   - 'selection-changed'    — its text hash differs from the CURRENT
   *                              hash of the selected text (`expectedSourceHash`,
   *                              computed with `selectionTextHash`), OR its
   *                              structural anchor (blockId / chunkId /
   *                              captured range) no longer matches the
   *                              caller's live `expectedAnchor` — identical
   *                              text elsewhere or a moved range denies;
   *   - 'source-revision-moved'— the document project revision moved since
   *                              capture (binding-tracked; fail-closed when
   *                              the binding has no observed revision);
   *   - 'target-revision-moved'— the translation-side revision (`snapshot.targetRevision`)
   *                              no longer matches the caller's current
   *                              `expectedTargetRevision`.
   *
   * @param expectedAnchor Optional `{ blockId?, chunkId?, charStart?, charEnd? }`
   *   — the caller's live observation of where the selection sits. Every
   *   supplied field must match the snapshot; a range expectation against a
   *   snapshot captured WITHOUT range context denies (fail-closed).
   * @returns {{ ok: true } | { ok: false, reason: string }}
   */
  selectionGuard(selection, expectedSourceHash, expectedTargetRevision, expectedAnchor) {
    if (typeof expectedSourceHash !== 'string') {
      throw new TypeError('expectedSourceHash must be a string.');
    }
    if (typeof expectedTargetRevision !== 'string') {
      throw new TypeError('expectedTargetRevision must be a string.');
    }
    let anchor = null;
    if (expectedAnchor !== undefined && expectedAnchor !== null) {
      requireObject(expectedAnchor, 'expectedAnchor');
      anchor = {};
      if (expectedAnchor.blockId !== undefined) {
        requireNonEmptyString(expectedAnchor.blockId, 'expectedAnchor.blockId');
        anchor.blockId = expectedAnchor.blockId;
      }
      if (expectedAnchor.chunkId !== undefined) {
        const { chunkId } = expectedAnchor;
        if (chunkId !== null && (typeof chunkId !== 'string' || chunkId.length === 0)) {
          throw new TypeError('expectedAnchor.chunkId must be a string or null.');
        }
        anchor.chunkId = chunkId;
      }
      for (const key of ['charStart', 'charEnd']) {
        if (expectedAnchor[key] !== undefined) {
          if (!Number.isInteger(expectedAnchor[key]) || expectedAnchor[key] < 0) {
            throw new TypeError(`expectedAnchor.${key} must be a non-negative integer.`);
          }
          anchor[key] = expectedAnchor[key];
        }
      }
    }
    if (!isValidSelectionSnapshot(selection)) return { ok: false, reason: 'invalid-snapshot' };
    if (selection.textHash !== expectedSourceHash) return { ok: false, reason: 'selection-changed' };
    if (anchor) {
      if (anchor.blockId !== undefined && selection.blockId !== anchor.blockId) {
        return { ok: false, reason: 'selection-changed' };
      }
      if (anchor.chunkId !== undefined && (selection.chunkId ?? null) !== anchor.chunkId) {
        return { ok: false, reason: 'selection-changed' };
      }
      if (anchor.charStart !== undefined) {
        if (
          selection.charStart === undefined ||
          selection.charStart !== anchor.charStart ||
          selection.charEnd !== anchor.charEnd
        ) {
          return { ok: false, reason: 'selection-changed' };
        }
      }
    }
    if (this._revision === null || selection.sourceRevision !== this._revision) {
      return { ok: false, reason: 'source-revision-moved' };
    }
    if (selection.targetRevision !== expectedTargetRevision) {
      return { ok: false, reason: 'target-revision-moved' };
    }
    return { ok: true };
  }

  // --- shared commit pipeline ---

  /**
   * Reject stale transactions → stamp identity → derive candidate → detect
   * identity drift → fold ONE validated candidate → preflight → commit →
   * advance. Origin metas are stamped by the callers that own their
   * transactions; a plain user dispatch carries none (the schema contract's
   * default).
   */
  _commitProjection(inputTr) {
    if (inputTr === null || typeof inputTr !== 'object' || inputTr.doc === undefined) {
      throw new TypeError('editor transaction commit expects a ProseMirror transaction with a resulting doc.');
    }
    if (inputTr.doc.type.schema !== EDITOR_SCHEMA) {
      throw new TypeError('transaction doc was not built with the editor schema.');
    }
    if (!inputTr.before || typeof inputTr.before.eq !== 'function') {
      throw new TypeError('editor transaction commit expects a ProseMirror Transaction.');
    }
    // Stale-transaction rejection (§10.8 all-or-nothing): a transaction
    // retained across other commits would otherwise persist a stale or
    // reverted document. Rejected BEFORE any store interaction — zero writes.
    if (!inputTr.before.eq(this._state.doc)) {
      throw createAppError(
        'CONFLICT',
        'transaction was built against a stale editor state; rebuild it from binding.state.',
      );
    }
    let tr = inputTr;
    const trust = {
      blocks: new Set(this._archive.blocks.map((b) => b.blockId)),
      spans: archiveSpanIds(this._archive),
      policyFor: (blockId) => {
        const resolved = effectivePolicy(this._archive, null, blockId);
        return { action: resolved.action, note: resolved.note ?? null };
      },
    };
    const { doc: resolvedDoc, mintedBlockIds, mintedSpanIds } = mintProjectionIds(tr.doc, trust);
    let candidate = nextArchiveFromDoc(this._archive, resolvedDoc);
    const policyDeltas = this._policyDeltas(resolvedDoc);
    if (!candidate.changed && policyDeltas.length === 0) {
      // Content-equal: still no license to advance blindly. Identity-only
      // drift (span retiles, structural attrs) is detected here — before
      // the no-op branch — so the projection can never diverge from disk.
      const drift = this._identityDrift(resolvedDoc, mintedBlockIds, mintedSpanIds);
      if (drift === null) {
        // Preflighted advance: a throwing apply leaves the binding untouched.
        this._state = this._state.apply(tr);
        return { changed: false, archive: this._archive, revision: this._revision };
      }
      if (drift.unauthorized) {
        throw createAppError('VALIDATION_FAILED', drift.message);
      }
      // Authorized identity retile: persist a candidate that matches the
      // projection exactly (content equality alone would skip the write).
      candidate = nextArchiveFromDoc(this._archive, resolvedDoc, { assumeChanged: true });
    }
    // ONE validated candidate carrying content, fingerprints, and policy
    // deltas — persisted through ONE atomic CAS/WAL mutation.
    const payload = this._foldedCandidate(candidate.archive, policyDeltas);
    const canonical = buildSourceDoc(payload);
    if (!canonical.eq(tr.doc)) {
      // The raw transaction doc diverges from what will be persisted
      // (minted identity, structural rebuild, fingerprint moves): make THE
      // CANONICAL ARCHIVE itself the committed transaction so projection,
      // store, and undo event describe the same content. (A follow-up
      // addToHistory:false sync step would only add position maps to the
      // prior event, swamping its inversion — the next undo would silently
      // no-op.)
      tr = this._recommitWithResolved(canonical, tr);
    }
    // Preflight the projection advance BEFORE the store call: a transaction
    // that cannot apply throws here and nothing is written at all.
    const nextState = this._state.apply(tr);
    const result = this._store.saveDocumentArchive(
      this._projectId,
      payload,
      requireRevisionForCommit(this._revision),
    );
    this._archive = result.archive;
    this._revision = result.revision;
    this._state = nextState;
    return { changed: true, archive: this._archive, revision: this._revision };
  }

  /** The single candidate archive: span-policy deltas folded in. (Fingerprints were maintained during derivation.) */
  _foldedCandidate(candidate, policyDeltas) {
    if (policyDeltas.length === 0) return candidate;
    const spanPolicies = { ...candidate.spanPolicies };
    for (const delta of policyDeltas) spanPolicies[delta.spanId] = delta.policy;
    return { ...candidate, spanPolicies };
  }
  /**
   * Identity drift of a content-equal transaction result vs the canonical
   * archive. Returns `null` when identical, `{ unauthorized: false }` when
   * the drift is exactly a minting-shaped span retile (persist a matching
   * candidate), or `{ unauthorized: true, message }` for foreign or moved
   * span identity and hand-mutated structural attrs (reject typed).
   */
  _identityDrift(resolvedDoc, mintedBlockIds, mintedSpanIds) {
    const archive = this._archive;
    if (resolvedDoc.childCount !== archive.blocks.length) {
      return { unauthorized: true, message: 'block count changed without a content change.' };
    }
    const homeOf = new Map(); // spanId → canonical home blockId
    for (const block of archive.blocks) {
      for (const span of block.spans) homeOf.set(span.spanId, block.blockId);
    }
    const docBlocks = [];
    resolvedDoc.forEach((node) => docBlocks.push(node));
    let drifted = false;
    for (let i = 0; i < docBlocks.length; i++) {
      const node = docBlocks[i];
      const arch = archive.blocks[i];
      const blockId = node.attrs.blockId;
      if (blockId !== arch.blockId) {
        return { unauthorized: true, message: `block order changed without a content change ("${blockId}" vs "${arch.blockId}").` };
      }
      if (!mintedBlockIds.has(blockId)) {
        if ((node.attrs.part || 'main') !== arch.part) {
          return { unauthorized: true, message: `structural attr "part" mutated on block "${blockId}".` };
        }
        if ((node.attrs.page ?? null) !== (arch.page ?? null)) {
          return { unauthorized: true, message: `structural attr "page" mutated on block "${blockId}".` };
        }
        if (node.attrs.styleFingerprint !== arch.styleFingerprint) {
          return { unauthorized: true, message: `structural attr "styleFingerprint" mutated on block "${blockId}".` };
        }
      }
      const docSeq = deriveBlockFromNode(node).spans.map((s) => s.spanId);
      const archSeq = arch.spans.map((s) => s.spanId);
      const seqEqual =
        docSeq.length === archSeq.length && docSeq.every((id, j) => id === archSeq[j]);
      if (seqEqual) continue;
      drifted = true;
      for (const id of docSeq) {
        if (mintedSpanIds.has(id)) continue;
        if (homeOf.get(id) !== blockId) {
          return {
            unauthorized: true,
            message: `span "${id}" does not belong to block "${blockId}" in the canonical archive; foreign or moved identity.`,
          };
        }
      }
    }
    // A trusted id may never surface outside its canonical home block.
    const docHomes = new Map(); // spanId → Set of doc blocks containing it
    for (const node of docBlocks) {
      for (const span of deriveBlockFromNode(node).spans) {
        if (mintedSpanIds.has(span.spanId)) continue;
        if (!docHomes.has(span.spanId)) docHomes.set(span.spanId, new Set());
        docHomes.get(span.spanId).add(node.attrs.blockId);
      }
    }
    for (const [spanId, homes] of docHomes) {
      const home = homeOf.get(spanId);
      if (home === undefined || homes.size > 1 || !homes.has(home)) {
        return { unauthorized: true, message: `span "${spanId}" moved outside its canonical block.` };
      }
    }
    return drifted ? { unauthorized: false } : null;
  }

  /**
   * Build the committed form of a transaction whose raw doc diverges from
   * what was persisted (minted identity, or a structural rebuild): one
   * whole-document ReplaceStep carrying the faithful content. The rewritten
   * transaction keeps the original's selection and its history-relevant
   * metas (origin, addToHistory, closeHistory — the close re-stamped with
   * the library helper) so undo grouping and atomic-step semantics are
   * unchanged; plugin-internal metas (e.g. history's own) are deliberately
   * not copied.
   */
  _recommitWithResolved(resolved, tr) {
    const committed = this._state.tr;
    committed.replace(0, committed.doc.content.size, new Slice(resolved.content, 0, 0));
    // Selection positions are identical across the two docs (minting only
    // rewrites identity attrs), but Selection carries its source doc by
    // reference — re-resolve it onto the committed transaction's doc.
    const selection = tr.selection;
    committed.setSelection(
      selection.$from.doc === committed.doc
        ? selection
        : selection.map(committed.doc, new Mapping()),
    );
    for (const key of [EDITOR_ORIGIN_META, 'addToHistory', CLOSE_HISTORY_META]) {
      const value = tr.getMeta(key);
      if (value !== undefined) committed.setMeta(key, value);
    }
    if (tr.getMeta(CLOSE_HISTORY_META)) closeHistory(committed);
    return committed;
  }

  /**
   * Span policy changes visible in the projection's span marks. Compared
   * against the RESOLVED effective policy (override → block → translate),
   * so a mark matching what the store already resolves produces no write.
   * Minted spans are stamped with their destination resolution at mint
   * time, so they only produce deltas when they deliberately preserve a
   * trusted policy across a split/copy (invariant: protection survives).
   */
  _policyDeltas(doc) {
    const deltas = [];
    doc.forEach((block) => {
      block.forEach((child) => {
        if (!child.isText) return;
        const mark = spanMarkOf(child.marks);
        if (!mark) return; // commit-time hygiene rejects these later anyway
        const current = effectivePolicy(this._archive, mark.attrs.spanId, block.attrs.blockId);
        const note = mark.attrs.note ?? null;
        if (mark.attrs.policy !== current.action || note !== (current.note ?? null)) {
          deltas.push({ spanId: mark.attrs.spanId, policy: { action: mark.attrs.policy, ...(note === null ? {} : { note }) } });
        }
      });
    });
    return deltas;
  }
}

/** A commit without a known revision would fail the store CAS confusingly. */
function requireRevisionForCommit(revision) {
  if (revision === null || revision === undefined) {
    throw createAppError(
      'CONFLICT',
      'Editor binding has no observed project revision; reload the document before committing.',
    );
  }
  return revision;
}

function createEditorBinding(options) {
  requireObject(options, 'createEditorBinding expects an options object');
  return new EditorBinding(options.document, options.store, options.revision);
}

module.exports = {
  SELECTION_SNAPSHOT_KIND,
  PROGRAMMATIC_ORIGINS,
  loadDocumentIntoEditor,
  createEditorBinding,
  selectionTextHash,
  preparePasteFragment,
};
