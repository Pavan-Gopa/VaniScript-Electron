'use strict';

// Translation coordinator (DOC-04, plan §10.6).
//
// Drives per-chunk translation of a D3 ChunkPlan against a D2
// DocumentProjectStore translation archive, with pause/resume/cancel at
// safe chunk boundaries, local structural validation of every response
// BEFORE commit, at most two repair attempts for repairable (malformed but
// re-askable) responses, revision-guarded commits after each successfully
// processed chunk, and stale-response rejection: an operation captured
// against old source/target revisions can never overwrite newer state.
//
// The provider is a dependency-injected `translate` function (the P2.D9
// router adapter plugs in here in production; tests inject fakes) — this
// module performs NO network I/O. Its request/response contract
// (`TranslateChunkRequest`/`TranslateChunkResponse` in
// shared/contracts/documents.ts):
//
//   request  { runId, chunkId, targetLanguage, contextBefore, contextAfter,
//              segments: [{ blockId, charStart, charEnd, text }],
//              repair?: { attempt, issues } }
//   response { segments: [{ blockId, text, charStart?, charEnd? }] }
//
// `contextBefore`/`contextAfter` are exactly the D3-computed rolling
// contexts (rolling memory, plan §10.6) — passed through untouched.
//
// Run state machine (plan §10.6):
//   idle → preparing → translating → validating → repairing → committing
//     → paused | completed | failed | cancelled
// The validating/repairing/committing middle states are per-chunk phases
// the run-level state mirrors while a chunk is in flight. Pause takes
// effect at chunk boundaries: the in-flight chunk settles through commit
// if it was already valid, then the run parks.
//
// Cancel is AUTHORITATIVE at every in-flight boundary — before each
// provider dispatch, in the provider catch, after the provider await,
// immediately after the 'validating' transition, at commit entry,
// immediately after the 'committing' transition, and FIRST in the commit
// catch (before stale classification): an outstanding cancel discards the
// uncommitted response, writes nothing, and ends the run 'cancelled'.
//
// Per-chunk pipeline:
//   1. TRANSLATE  send non-empty, unprotected slice texts (empty slices
//                 resolve to '' locally — the only valid translation of
//                 empty source; protected slices are NEVER sent).
//   2. VALIDATE   structural check: one response segment per sent segment,
//                 blockId echoed, string texts, no extra (fabricated)
//                 segments; a block appearing more than once must also
//                 echo its exact offsets (its only per-slice identity).
//                 All issues are collected for the repair ask.
//   3. REPAIR     malformed responses are re-asked with corrective context
//                 (the issue list) at most MAX_REPAIR_ATTEMPTS (2) times;
//                 a still-malformed response fails the chunk. A translate
//                 function that THROWS is non-repairable: the chunk fails
//                 immediately.
//   4. MERGE      translated slice pieces join per block in range order;
//                 a block commits when ALL of this run's slices for it are
//                 resolved (split blocks buffer across chunks — the
//                 completing chunk writes the merged entry; earlier chunks
//                 still report 'committed' with their block 'buffered').
//   5. COMMIT     per-chunk atomicity through
//                 DocumentProjectStore.saveTranslations with a CAS on the
//                 captured project revision (advanced by each own commit).
//                 Before the CAS the covered blocks are re-hashed against
//                 a fresh archive read; any drift (or a CAS CONFLICT)
//                 marks the chunk stale, discards the response, and ends
//                 the run — a stale snapshot must never overwrite newer
//                 state (plan §10.6; typed SOURCE_CHANGED / CONFLICT).
//                 ANY OTHER commit/storage failure is TERMINAL for the
//                 whole run (see _abortOnStorageFailure): pending work
//                 stops so a post-lease D2 intent can never be replayed
//                 past this run's captured CAS chain.
//
// Status policy (plan §10.6 "automatic mode auto-approves ONLY locally-
// valid results"): automatic runs write locally-valid, unsuspicious blocks
// as 'approved'; suspicious ones (target identical to non-empty source, or
// blank target for non-empty source — deterministic heuristics) commit as
// 'needs-review' instead. Manual/targeted runs always write 'draft';
// approval belongs to the review lane (D6). A failed targeted translation
// never touches the archive, so the previous valid variant survives.
//
// Manual-chunk policy: `startManualChunk` EXPANDS the requested plan chunk
// to every plan chunk carrying a slice of any block it touches — a
// D3-split long block contributes several partial slices across chunks,
// and running one of them alone could never satisfy the whole-block
// coverage gate (a committed entry replaces a block's WHOLE translation),
// silently landing nothing. The expanded run resolves all sibling slices
// in-run and the last-touching chunk commits the merged draft.
//
// Targeted intent: explicit block fragments (selection snapshot, §10.8).
// Fragments that fully cover a block commit through the normal path;
// partial-block results are validated and REPORTED ('uncommitted') but
// never written — merging a fragment into an existing block translation
// requires the editor's transaction machinery (D5/D7), not guessed text
// splicing. (The processed fragment chunk itself still completes as
// 'committed' — its work was done and reported per block; nothing was
// written.)

const { EventEmitter } = require('node:events');
const { createAppError, isAppError } = require('../../../shared/contracts/errors.ts');
const {
  deriveChunkPlanId,
  validateChunkPlanAgainstSource,
} = require('../../../shared/contracts/documents.ts');
const { blockSourceHash } = require('./documentProjectStore.js');
const { estimateTokens } = require('./chunkPlanner.js');

/** Repair ceiling for repairable (malformed) responses (plan §10.6). */
const MAX_REPAIR_ATTEMPTS = 2;

const RUN_STATES = new Set([
  'idle',
  'preparing',
  'translating',
  'validating',
  'repairing',
  'committing',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);

const CHUNK_STATUSES = new Set([
  'pending',
  'translating',
  'validating',
  'repairing',
  'committing',
  'committed',
  'needs-review',
  'failed',
  'stale',
  'cancelled',
  'skipped',
]);

/** Chunk statuses that count as successfully processed progress. */
const CHUNK_DONE_STATUSES = new Set(['committed', 'needs-review', 'skipped']);

/** Stale codes: responses against obsolete snapshots must never overwrite. */
const STALE_ERROR_CODES = new Set(['CONFLICT', 'SOURCE_CHANGED']);

// --- Response validation -----------------------------------------------------

/**
 * Locally validate a translate response against its request BEFORE any
 * commit (plan §10.6): the response must tile the sent segments exactly —
 * one segment per sent segment, in order, with the `blockId` echoed and a
 * string `text`. A block that appears ONCE is identified by its blockId
 * echo alone; echoed offsets stay optional but are validated when present.
 * A block that appears MORE than once (a D3-split block contributing
 * several slices to the same chunk) has no other per-slice identity: every
 * such segment MUST echo its exact charStart/charEnd, so a provider that
 * reorders or drops the offset echo can never be confused for a valid
 * tiling. Extra or reordered segments are fabricated structure; missing
 * ones are absent targets. All of it is repairable. Returns
 * `{ ok: true }` or `{ ok: false, issues }` listing EVERY issue (richer
 * corrective context for the repair ask).
 */
function validateChunkResponse(request, response) {
  const sent = request.segments;
  const issues = [];
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return { ok: false, issues: ['response must be an object with a segments array.'] };
  }
  if (!Array.isArray(response.segments)) {
    return { ok: false, issues: ['response.segments must be an array.'] };
  }
  if (response.segments.length !== sent.length) {
    issues.push(
      `expected exactly ${sent.length} segment(s), got ${response.segments.length} — do not add, drop, merge, or reorder segments.`,
    );
  }
  const count = Math.min(response.segments.length, sent.length);
  // Per-slice identity for REPEATED blockIds: a block contributing several
  // slices to one chunk cannot be pinned by its blockId echo alone.
  const repeated = new Set();
  {
    const seen = new Map();
    for (const s of sent) seen.set(s.blockId, (seen.get(s.blockId) ?? 0) + 1);
    for (const [blockId, n] of seen) {
      if (n > 1) repeated.add(blockId);
    }
  }
  for (let i = 0; i < count; i++) {
    const expect = sent[i];
    const got = response.segments[i];
    if (!got || typeof got !== 'object' || Array.isArray(got)) {
      issues.push(`segments[${i}] must be an object.`);
      continue;
    }
    if (got.blockId !== expect.blockId) {
      issues.push(
        `segments[${i}].blockId must echo "${expect.blockId}", got ${JSON.stringify(got.blockId ?? null)}.`,
      );
    }
    if (typeof got.text !== 'string') {
      issues.push(`segments[${i}].text must be a string.`);
    }
    if (repeated.has(expect.blockId)) {
      // Repeated-block slice: the offset echo is REQUIRED identity, not a
      // nicety — position alone is ambiguous among same-blockId segments.
      if (got.charStart !== expect.charStart) {
        issues.push(
          `segments[${i}].charStart must echo ${expect.charStart}: block "${expect.blockId}" appears more than once in this chunk, so every segment must identify its slice by its exact offsets.`,
        );
      }
      if (got.charEnd !== expect.charEnd) {
        issues.push(
          `segments[${i}].charEnd must echo ${expect.charEnd}: block "${expect.blockId}" appears more than once in this chunk, so every segment must identify its slice by its exact offsets.`,
        );
      }
    } else {
      if (got.charStart !== undefined && got.charStart !== expect.charStart) {
        issues.push(`segments[${i}].charStart must be ${expect.charStart} when echoed.`);
      }
      if (got.charEnd !== undefined && got.charEnd !== expect.charEnd) {
        issues.push(`segments[${i}].charEnd must be ${expect.charEnd} when echoed.`);
      }
    }
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/**
 * Suspicion heuristics (plan §10.6 "подозрительные результаты"): returns
 * 'identical' when a non-empty source came back unchanged, 'blank' when a
 * non-empty source came back empty/whitespace, else null. Deliberately
 * deterministic and cheap — deeper review belongs to lane D6.
 */
function suspicionOf(sourceText, targetText) {
  if (sourceText.length === 0) return null;
  if (targetText.trim().length === 0) return 'blank';
  if (targetText === sourceText) return 'identical';
  return null;
}

/** Status written for one block commit (see module header, status policy). */
function statusForBlock(intent, suspicious) {
  if (intent === 'automatic') return suspicious ? 'needs-review' : 'approved';
  return 'draft';
}

// --- Input validation --------------------------------------------------------

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw createAppError('VALIDATION_FAILED', `${label} must be a non-empty string.`);
  }
  return value;
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createAppError('VALIDATION_FAILED', `${label} must be an object.`);
  }
  return value;
}

/** String check that, unlike requireNonEmptyString, allows ''. */
function requireString(value, label) {
  if (typeof value !== 'string') {
    throw createAppError('VALIDATION_FAILED', `${label} must be a string.`);
  }
  return value;
}

/**
 * Normalize ANY thrown/rejected value into an AppError without ever
 * dereferencing it: real AppErrors (including duck-typed ones that crossed
 * a boundary) keep their code and message; Error-shaped values become
 * typed INTERNAL carrying their message; anything else — null, undefined,
 * numbers, cyclic objects — is described safely. A raw `null` rejection
 * must surface as a terminal typed error, never crash the driver with a
 * `err.message` dereference and leave the run promise unresolved.
 */
function normalizeThrown(err) {
  if (isAppError(err)) return err;
  if (err instanceof Error) {
    return createAppError('INTERNAL', err.message || err.name || 'Unknown internal error.');
  }
  return createAppError(
    'INTERNAL',
    `Non-error value thrown where an AppError was expected: ${describeThrownValue(err)}.`,
  );
}

/** Crash-proof one-line description of an arbitrary thrown value. */
function describeThrownValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value);
  try {
    const json = JSON.stringify(value);
    if (typeof json === 'string') return json;
  } catch {
    /* cyclic or otherwise unserializable — fall through to the type name */
  }
  return `a ${t} value`;
}

// --- Run ---------------------------------------------------------------------

let runCounter = 0;

/**
 * One translation run: the mutable state machine plus its EventEmitter
 * surface — 'update' after every state change (with the progress
 * snapshot), 'end' once with the final snapshot. Internal: callers receive
 * live handles from `createTranslationCoordinator().start*`; the handle is
 * removed from the coordinator registry when the run ends.
 */
class TranslationRun extends EventEmitter {
  // @param chunks work items: { chunkId, contextBefore, contextAfter,
  //   tokenEstimate, segments: [{ blockId, charStart, charEnd, text,
  //   protected }] } — pre-built by the intent preparator.
  // @param revision captured project revision — the CAS anchor for the
  //   first commit, advanced by each own commit thereafter.
  // @param sourceHashes Map blockId -> SHA-256 of the block text at capture.
  constructor({ coordinator, projectId, language, intent, chunks, revision, sourceHashes, lengths }) {
    super();
    this._coordinator = coordinator;
    runCounter += 1;
    this.runId = `tr-${runCounter.toString(36)}-${Date.now().toString(36)}`;
    this.projectId = projectId;
    this.language = language; // canonical tag (from the stored archive)
    this.intent = intent;
    this.state = 'idle';
    this.error = null;
    this._blocksDone = 0;

    this.chunks = chunks.map((chunk) => ({
      ...chunk,
      status: 'pending',
      repairAttempts: 0,
      blocks: [],
    }));
    this._revision = revision;
    this._sourceHashes = sourceHashes;

    // Merge bookkeeping: per block, the ordered resolved pieces from this
    // run's chunks plus the index of the LAST chunk touching it (the only
    // chunk that may commit the merged entry), and protection flags.
    this._pieces = new Map(); // blockId -> [{ charStart, text, suspicious }]
    this._lastTouch = new Map(); // blockId -> chunk index
    this._blockProtected = new Set();
    this._lengths = lengths; // blockId -> captured block text length
    for (let i = 0; i < this.chunks.length; i++) {
      for (const segment of this.chunks[i].segments) {
        this._lastTouch.set(segment.blockId, i);
        if (segment.protected) this._blockProtected.add(segment.blockId);
      }
    }
    // Blocks this run can EVER write: never touched by protection and fully
    // tiled by this run's slices over the captured text ([0, length)) — the
    // same predicate the committer enforces, evaluated up front so progress
    // reconciles (a completed run ends blocksDone === blocksTotal).
    this._writableBlocks = new Set();
    for (const chunk of this.chunks) {
      for (const segment of chunk.segments) {
        if (
          !segment.protected &&
          !this._blockProtected.has(segment.blockId) &&
          this._coversWholeBlock(segment.blockId)
        ) {
          this._writableBlocks.add(segment.blockId);
        }
      }
    }

    this._wantPause = false;
    this._cancelRequested = false;
    this._ended = false;
    this._driveSeq = 0;
    this.promise = new Promise((resolve) => {
      this._resolve = resolve;
    });
  }

  // -- observability ----------------------------------------------------------

  /**
   * Plain-JSON progress snapshot (see TranslationProgressSnapshot).
   * blocksTotal counts only blocks this run can ever write (unprotected and
   * fully tiled by this run's slices), so a completed run always reconciles
   * to blocksDone === blocksTotal.
   */
  snapshot() {
    let tokensDone = 0;
    let chunksDone = 0;
    for (const chunk of this.chunks) {
      if (CHUNK_DONE_STATUSES.has(chunk.status)) {
        chunksDone += 1;
        tokensDone += chunk.tokenEstimate;
      }
    }
    return {
      runId: this.runId,
      projectId: this.projectId,
      language: this.language,
      intent: this.intent,
      state: this.state,
      chunks: this.chunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        status: chunk.status,
        tokenEstimate: chunk.tokenEstimate,
        repairAttempts: chunk.repairAttempts,
        blocks: chunk.blocks.map((b) => ({ ...b })),
      })),
      chunksDone,
      chunksTotal: this.chunks.length,
      blocksDone: this._blocksDone,
      blocksTotal: this._writableBlocks.size,
      tokensDone,
      tokensTotal: this.chunks.reduce((sum, c) => sum + c.tokenEstimate, 0),
      error: this.error,
    };
  }

  _setState(state) {
    if (this.state === state) return; // no duplicate event for a no-op phase
    this.state = state;
    this._emitUpdate();
  }

  _emitUpdate() {
    if (!this._ended) this.emit('update', this.snapshot());
  }

  // -- control ----------------------------------------------------------------

  /** Request a pause at the next safe boundary (a chunk edge). */
  pause() {
    if (this._ended || this._cancelRequested) return;
    this._wantPause = true;
    // An in-flight chunk settles first (through commit if valid); the
    // driver observes the flag at the loop top. From idle/preparing the
    // driver pauses before the first dispatch.
  }

  /** Resume a paused run at the first unprocessed chunk. */
  resume() {
    if (this._ended || !this._wantPause || this._cancelRequested) return;
    this._wantPause = false;
    if (this.state !== 'paused') return;
    this._drive(); // bumps _driveSeq: any superseded loop exits at its next check
  }

  /**
   * Cancel the run: the in-flight response (if any) is discarded without
   * commit, pending chunks are marked cancelled, committed chunks stay
   * durable. Terminal.
   */
  cancel() {
    if (this._ended || this._cancelRequested) return;
    this._cancelRequested = true;
    this._wantPause = false;
    if (
      this.state === 'paused' ||
      this.state === 'idle' ||
      this.state === 'preparing'
    ) {
      this._sweepPending('cancelled');
      this._finish('cancelled');
    }
    // Otherwise the driver observes the flag after the current await.
  }

  /**
   * THE authoritative in-flight cancellation check (plan §10.6): called at
   * EVERY phase boundary — before each provider dispatch, in the provider
   * catch, after the provider await, immediately after the 'validating'
   * transition, at commit entry, immediately after the 'committing'
   * transition, and FIRST in the commit catch (before stale
   * classification) — so a cancel raised synchronously from any progress
   * update wins over ANY concurrent outcome: the in-flight chunk is marked
   * cancelled with uncommitted blocks, pending work is swept, and the run
   * finishes 'cancelled'. Returns true when it settled the run.
   */
  _settleCancelledInFlight(chunk) {
    if (!this._cancelRequested || this._ended) return false;
    chunk.status = 'cancelled';
    chunk.blocks = this._uncommittedRows(chunk);
    this._sweepPending('cancelled');
    this._finish('cancelled');
    return true;
  }

  _sweepPending(status) {
    for (const chunk of this.chunks) {
      if (chunk.status === 'pending') {
        chunk.status = status;
        chunk.blocks = this._uniqueBlockIds(chunk).map((blockId) => ({
          blockId,
          status: 'uncommitted',
        }));
      }
    }
  }

  _finish(state) {
    if (this._ended) return;
    this._ended = true;
    // Contract (TranslationProgressSnapshot.error): "null unless the run
    // failed". A cancelled run is not a failed run — an earlier chunk
    // failure that never became terminal must not leak onto the
    // authoritative cancelled snapshot.
    if (state === 'cancelled') this.error = null;
    this.state = state;
    this._coordinator._forget(this);
    const snap = this.snapshot();
    this.emit('end', snap);
    this._resolve(snap);
  }

  // -- driver -----------------------------------------------------------------

  /** Start (or restart after resume) the sequential chunk driver. */
  _drive() {
    if (this._ended || this._cancelRequested) return;
    const seq = ++this._driveSeq;
    this._setState('translating');
    void this._loop(seq);
  }
  async _loop(seq) {
    for (;;) {
      if (seq !== this._driveSeq) return; // superseded (resume double-drive guard)
      if (this._cancelRequested) {
        this._sweepPending('cancelled');
        this._finish('cancelled');
        return;
      }
      if (this._wantPause) {
        this._setState('paused');
        return;
      }
      const next = this.chunks.find((c) => c.status === 'pending');
      if (!next) {
        const anyBad = this.chunks.some((c) => c.status === 'failed' || c.status === 'stale');
        this._finish(anyBad ? 'failed' : 'completed');
        return;
      }
      await this._processChunk(next);
    }
  }

  _uncommittedRows(chunk) {
    return this._uniqueBlockIds(chunk).map((blockId) => ({ blockId, status: 'uncommitted' }));
  }

  _uniqueBlockIds(chunk) {
    return [...new Set(chunk.segments.map((s) => s.blockId))];
  }

  /** How many slices of `blockId` this run's chunks carry. */
  _expectedSliceCount(blockId) {
    return this.chunks.reduce(
      (n, c) => n + c.segments.filter((s) => s.blockId === blockId).length,
      0,
    );
  }

  /**
   * Translate → validate → (bounded repair) → merge → commit one chunk.
   * Cancellation is AUTHORITATIVE at every boundary: it is re-checked
   * before every provider dispatch, in the provider catch, after the
   * provider await, right after the 'validating' transition, and at both
   * commit boundaries (entry and after the 'committing' transition — see
   * _commitPhase), so a cancel racing ANY outcome — even a valid response
   * or a stale verdict — settles the run cancelled with nothing written.
   * Stale detection (source drift or CAS conflict) marks the chunk stale,
   * sweeps remaining chunks, and fails the run — the captured snapshot is
   * obsolete and must never overwrite newer state.
   */
  async _processChunk(chunk) {
    const sendable = chunk.segments.filter((s) => !s.protected && s.text.length > 0);

    if (sendable.length === 0) {
      // Nothing to send: empty slices resolve to '' locally (the only
      // valid target for empty source), protected slices stay untouched.
      for (const s of chunk.segments) {
        if (!s.protected) this._recordPiece(s, '');
      }
      await this._commitPhase(chunk);
      return;
    }

    chunk.status = 'translating';
    this._setState('translating'); // run-level mirror of the in-flight phase
    const request = {
      runId: this.runId,
      chunkId: chunk.chunkId,
      targetLanguage: this.language,
      contextBefore: chunk.contextBefore,
      contextAfter: chunk.contextAfter,
      segments: sendable.map((s) => ({
        blockId: s.blockId,
        charStart: s.charStart,
        charEnd: s.charEnd,
        text: s.text,
      })),
    };

    let repair;
    let response;
    for (let attempt = 0; ; attempt++) {
      // Cancellation wins BEFORE any dispatch: a cancel that landed
      // between iterations (e.g. synchronously from an 'update' listener
      // while the run mirrored 'repairing') must not fire another call.
      if (this._settleCancelledInFlight(chunk)) return;
      let call;
      try {
        call = await this._coordinator._translate(repair ? { ...request, repair } : request);
      } catch (err) {
        // Cancel beats failure here too: a rejection after cancel() ends
        // the run cancelled, never a failed chunk carrying a provider
        // error. Otherwise a thrown provider error is non-repairable and
        // fails the chunk immediately — repair is for malformed
        // RESPONSES, not throws.
        if (this._settleCancelledInFlight(chunk)) return;
        this._failChunk(chunk, err);
        return;
      }
      // The response settled but a cancel raced it: discard uncommitted.
      if (this._settleCancelledInFlight(chunk)) return;
      chunk.status = 'validating';
      this._setState('validating');
      // Cancellation precedence: a sync progress listener cancelling from
      // THIS update must win before the response can be accepted.
      if (this._settleCancelledInFlight(chunk)) return;
      const verdict = validateChunkResponse(request, call);
      if (verdict.ok) {
        response = call;
        break;
      }
      if (attempt >= MAX_REPAIR_ATTEMPTS) {
        this._failChunk(
          chunk,
          createAppError(
            'PROVIDER_ERROR',
            `Chunk "${chunk.chunkId}": response still invalid after ${MAX_REPAIR_ATTEMPTS} repair attempt(s): ${verdict.issues.join(' ')}`,
            { chunkId: chunk.chunkId, issues: verdict.issues },
          ),
        );
        return;
      }
      chunk.repairAttempts = attempt + 1;
      chunk.status = 'repairing';
      this._setState('repairing');
      repair = { attempt: attempt + 1, issues: verdict.issues };
    }

    // Merge validated pieces into the per-block buffers (positional — the
    // validator proved the 1:1 tiling), then commit what completes.
    const byPosition = new Map(sendable.map((s, i) => [i, s]));
    response.segments.forEach((translated, i) => {
      this._recordPiece(byPosition.get(i), translated.text);
    });
    for (const s of chunk.segments) {
      if (!s.protected && s.text.length === 0) this._recordPiece(s, '');
    }
    await this._commitPhase(chunk);
  }

  _recordPiece(segment, translatedText) {
    let pieces = this._pieces.get(segment.blockId);
    if (!pieces) {
      pieces = [];
      this._pieces.set(segment.blockId, pieces);
    }
    pieces.push({
      charStart: segment.charStart,
      text: translatedText,
      suspicious: suspicionOf(segment.text, translatedText) !== null,
    });
  }

  /**
   * True when this run's resolved slices for `blockId` tile its WHOLE
   * current text `[0, length)` contiguously — the precondition for writing
   * a block translation entry, because an entry REPLACES the block's whole
   * translation: a partial fragment must never be spliced in here
   * (targeted selections report 'uncommitted' instead).
   */
  _coversWholeBlock(blockId) {
    let covered = 0;
    const ranges = [];
    for (const chunk of this.chunks) {
      for (const segment of chunk.segments) {
        if (segment.blockId !== blockId || segment.protected) continue;
        ranges.push([segment.charStart, segment.charEnd]);
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    for (const [start, end] of ranges) {
      if (start !== covered) return false;
      covered = end;
    }
    // The captured hash pins the text length at capture time; the fresh
    // re-hash in _commitChunk proves it unchanged before any write.
    return ranges.length > 0 && covered === this._lengths.get(blockId);
  }

  /**
   * COMMIT phase: write every block this chunk COMPLETES (all of this
   * run's slices for it resolved, none protected). Chunks whose blocks
   * still have unresolved pieces elsewhere commit nothing — no store
   * write, no revision burn; the completing chunk writes the merge.
   *
   * Failure policy: a stale verdict (SOURCE_CHANGED drift / CAS CONFLICT)
   * ends the run as before. Any OTHER commit/storage failure is TERMINAL
   * for the run (_abortOnStorageFailure) — never an ordinary per-chunk
   * failure that lets later chunks dispatch.
   *
   * Cancellation policy: an outstanding cancel settles at entry AND after
   * the 'committing' update, and is checked BEFORE stale classification in
   * the catch — no write ever lands past an authoritative cancel.
   */
  async _commitPhase(chunk) {
    // ONE precedence at the commit boundary: settle at entry (a cancel
    // raised during validating/merging lands here) AND again right after
    // the 'committing' transition — a sync listener cancelling from that
    // very update must never let the write land.
    if (this._settleCancelledInFlight(chunk)) return;
    chunk.status = 'committing';
    this._setState('committing');
    if (this._settleCancelledInFlight(chunk)) return;
    try {
      await this._commitChunk(chunk);
    } catch (err) {
      // An authoritative cancel beats stale classification: cancel+stale
      // ends authoritatively cancelled with the obsolete response
      // discarded — never failed wearing the stale error.
      if (this._settleCancelledInFlight(chunk)) return;
      if (isAppError(err) && STALE_ERROR_CODES.has(err.code)) {
        chunk.status = 'stale';
        chunk.blocks = this._uncommittedRows(chunk);
        this._sweepPending('stale');
        if (!this.error) this.error = { code: err.code, message: err.message };
        this._finish('failed');
        return;
      }
      this._abortOnStorageFailure(chunk, err);
      return;
    }
  }

  /**
   * Terminal commit/storage failure (deliberate policy — see the module
   * header, step 5 COMMIT): a D2 mutation that throws after taking its
   * lease leaves a write-ahead intent whose recovery — triggered by the
   * NEXT reader or writer — replays the content and advances the durable
   * revision PAST this run's captured CAS chain. Continuing to dispatch
   * would therefore turn one failed chunk into a stale cascade with the
   * failed chunk's work landing durably anyway. Instead: stop all pending
   * work, sweep it 'failed', surface the typed error, and end the run.
   * Recovery of the intent belongs to the next project load (D2 exactly-
   * once replay), not to this run.
   */
  _abortOnStorageFailure(chunk, err) {
    const normalized = normalizeThrown(err);
    chunk.status = 'failed';
    chunk.blocks = this._uniqueBlockIds(chunk).map((blockId) => ({ blockId, status: 'failed' }));
    if (!this.error) this.error = { code: normalized.code, message: normalized.message };
    this._sweepPending('failed');
    this._finish('failed');
  }

  async _commitChunk(chunk) {
    const index = this.chunks.indexOf(chunk);
    const completing = [];
    for (const [blockId, lastTouch] of this._lastTouch) {
      if (lastTouch !== index || this._blockProtected.has(blockId)) continue;
      const pieces = this._pieces.get(blockId);
      if (pieces && pieces.length === this._expectedSliceCount(blockId) && this._coversWholeBlock(blockId)) {
        completing.push(blockId);
      }
    }

    const written = [];
    if (completing.length > 0) {
      // Freshness integration (plan §10.9): re-hash the CURRENT source text
      // and require equality with the captured hash — a source edit since
      // dispatch makes this response stale (SOURCE_CHANGED), never a write.
      const freshArchive = this._coordinator._store.loadDocumentArchive(this.projectId);
      const freshById = new Map(freshArchive.blocks.map((b) => [b.blockId, b]));
      for (const blockId of completing) {
        const freshBlock = freshById.get(blockId);
        if (!freshBlock || blockSourceHash(freshBlock) !== this._sourceHashes.get(blockId)) {
          throw createAppError(
            'SOURCE_CHANGED',
            `Block "${blockId}" changed since chunk "${chunk.chunkId}" was dispatched; discarding stale translation.`,
            { chunkId: chunk.chunkId, blockId },
          );
        }
      }
      const entries = completing.map((blockId) => {
        const pieces = this._pieces
          .get(blockId)
          .slice()
          .sort((a, b) => a.charStart - b.charStart);
        const text = pieces.map((p) => p.text).join('');
        const status = statusForBlock(this.intent, pieces.some((p) => p.suspicious));
        return { blockId, text, sourceHash: this._sourceHashes.get(blockId), status };
      });
      // CAS commit: expectedRevision anchors this write to the run's chain
      // (advanced by each own commit); any interleaved external mutation
      // makes the store reject with CONFLICT — the response is discarded.
      const result = this._coordinator._store.saveTranslations(
        this.projectId,
        this.language,
        entries,
        this._revision,
      );
      this._revision = result.revision;
      this._blocksDone += entries.length;
      for (const entry of entries) written.push(entry);
    }

    // Report per-block outcomes for every block this chunk touches.
    const writtenById = new Map(written.map((w) => [w.blockId, w.status]));
    chunk.blocks = this._uniqueBlockIds(chunk).map((blockId) => {
      if (writtenById.has(blockId)) {
        return { blockId, status: writtenById.get(blockId) };
      }
      if (this._blockProtected.has(blockId)) {
        return { blockId, status: 'protected' };
      }
      const pieces = this._pieces.get(blockId);
      // More of this block's slices resolve in later chunks of this run —
      // buffered; fully resolved but not whole-block coverage (targeted
      // partial fragment) — permanently uncommitted by this run.
      const buffered = pieces && pieces.length < this._expectedSliceCount(blockId);
      return { blockId, status: buffered ? 'buffered' : 'uncommitted' };
    });

    const flagged = [...writtenById.values()].some((status) => status === 'needs-review');
    chunk.status =
      written.length === 0 && !this._hadSendableWork(chunk)
        ? 'skipped'
        : flagged
          ? 'needs-review'
          : 'committed';
    this._emitUpdate();
  }

  /** True when the chunk actually sent anything to the translator. */
  _hadSendableWork(chunk) {
    return chunk.segments.some((s) => !s.protected && s.text.length > 0);
  }

  /**
   * Non-repairable chunk failure (translator throw or exhausted repairs).
   * The thrown value is normalized FIRST — a null/undefined rejection must
   * surface as a typed INTERNAL error, never crash on `err.message`.
   */
  _failChunk(chunk, err) {
    const normalized = normalizeThrown(err);
    chunk.status = 'failed';
    chunk.blocks = this._uniqueBlockIds(chunk).map((blockId) => ({ blockId, status: 'failed' }));
    if (!this.error) {
      this.error = { code: normalized.code, message: normalized.message };
    }
    this._emitUpdate();
    // The captured snapshot stays valid for the remaining chunks — keep
    // going; the run ends 'failed' once they settle.
  }
}

// --- Coordinator -------------------------------------------------------------

/**
 * Create a translation coordinator bound to a DocumentProjectStore and a
 * pluggable translate function. No network I/O happens here — `translate`
 * is the seam (production: the P2.D9 provider router adapter; tests: fakes).
 *
 * @param {object} deps
 * @param {import('./documentProjectStore.js').DocumentProjectStore} deps.store
 * @param {(request: import('../../../shared/contracts/documents.ts').TranslateChunkRequest) =>
 *   Promise<import('../../../shared/contracts/documents.ts').TranslateChunkResponse>} deps.translate
 */
function createTranslationCoordinator({ store, translate }) {
  if (!store || typeof store.saveTranslations !== 'function') {
    throw new TypeError('createTranslationCoordinator requires a DocumentProjectStore as "store".');
  }
  if (typeof translate !== 'function') {
    throw new TypeError('createTranslationCoordinator requires a "translate" function.');
  }
  const runs = new Map();

  /**
   * Shared preparation: load the project + archive (capturing the revision
   * CAS anchor and per-block source hashes), require the language archive
   * to exist (adding a language is an explicit confirmed act owned by the
   * store/UI, plan §10.5 — never a side effect here), validate the plan
   * against the loaded source, and build per-chunk work items with
   * protection flags applied.
   */
  function prepare({ projectId, language, intent, plan, chunkId, fragments, contextBefore = '', contextAfter = '' }) {
    requireNonEmptyString(projectId, 'projectId');
    requireString(contextBefore, 'contextBefore');
    requireString(contextAfter, 'contextAfter');
    const loaded = store.loadDocumentProject(projectId); // NOT_FOUND / VALIDATION_FAILED
    const revision = String(loaded.project.revision);
    const blocks = loaded.archive.blocks;
    const blockById = new Map(blocks.map((b) => [b.blockId, b]));

    const translation = store.getTranslationArchive(projectId, language); // NOT_FOUND when absent
    const canonical = translation.language;

    // Protection flags (plan §10.4): a `protect` block policy wins;
    // otherwise any overlapping `protect` span policy marks the slice.
    const blockPolicies = loaded.archive.blockPolicies || {};
    const spanPolicies = loaded.archive.spanPolicies || {};
    const isProtected = (block, charStart, charEnd) => {
      if (blockPolicies[block.blockId]?.action === 'protect') return true;
      for (const span of block.spans) {
        if (spanPolicies[span.spanId]?.action !== 'protect') continue;
        if (span.start < charEnd && charStart < span.end) return true;
      }
      return false;
    };

    const sourceHashes = new Map();
    const hashOf = (blockId) => {
      if (!sourceHashes.has(blockId)) {
        sourceHashes.set(blockId, blockSourceHash(blockById.get(blockId)));
      }
      return sourceHashes.get(blockId);
    };

    let chunks;
    if (intent === 'targeted') {
      if (!Array.isArray(fragments) || fragments.length === 0) {
        throw createAppError('VALIDATION_FAILED', 'fragments must be a non-empty array.');
      }
      const slices = fragments.map((raw, i) => {
        const fragment = requirePlainObject(raw, `fragments[${i}]`);
        requireNonEmptyString(fragment.blockId, `fragments[${i}].blockId`);
        const block = blockById.get(fragment.blockId);
        if (!block) {
          throw createAppError(
            'NOT_FOUND',
            `fragments[${i}] references unknown blockId "${fragment.blockId}".`,
          );
        }
        const charStart = fragment.charStart === undefined ? 0 : fragment.charStart;
        const charEnd = fragment.charEnd === undefined ? block.text.length : fragment.charEnd;
        if (
          !Number.isInteger(charStart) ||
          !Number.isInteger(charEnd) ||
          charStart < 0 ||
          charEnd <= charStart ||
          charEnd > block.text.length
        ) {
          throw createAppError(
            'VALIDATION_FAILED',
            `fragments[${i}] range (${charStart}, ${charEnd}) is not a non-empty in-bounds range of block "${fragment.blockId}" (text length ${block.text.length}).`,
          );
        }
        return {
          blockId: fragment.blockId,
          charStart,
          charEnd,
          tokenEstimate: estimateTokens(block.text.slice(charStart, charEnd)),
        };
      });
      chunks = [
        {
          chunkId: deriveChunkPlanId(slices),
          contextBefore,
          contextAfter,
          tokenEstimate: slices.reduce((sum, s) => sum + s.tokenEstimate, 0),
          segments: slices.map((slice) => {
            const block = blockById.get(slice.blockId);
            return {
              blockId: slice.blockId,
              charStart: slice.charStart,
              charEnd: slice.charEnd,
              text: block.text.slice(slice.charStart, slice.charEnd),
              protected: isProtected(block, slice.charStart, slice.charEnd),
            };
          }),
        },
      ];
    } else {
      // automatic | manual-chunk: the plan must be genuinely derived from
      // the loaded source (DOC-03 → DOC-04 boundary check).
      const verdict = validateChunkPlanAgainstSource(plan, { blocks });
      if (!verdict.ok) throw verdict.error;
      // MANUAL-CHUNK EXPANSION POLICY (see module header): the requested
      // chunk grows to every plan chunk carrying a slice of any block it
      // touches, in plan order. A D3-split block has slices in several
      // chunks; running the requested one alone can never tile the whole
      // block, so the manual ask would be reported 'committed' while the
      // block stayed uncommitted and the archive unchanged. Expansion keeps
      // the run self-contained: every sibling slice resolves in-run and the
      // last-touching chunk commits the merged draft.
      const all = verdict.value.chunks;
      let selected;
      if (intent === 'manual-chunk') {
        const requested = all.find((c) => c.chunkId === chunkId);
        if (!requested) {
          throw createAppError('NOT_FOUND', `Chunk "${chunkId}" is not part of the plan.`);
        }
        const touched = new Set(requested.slices.map((s) => s.blockId));
        selected = all.filter((c) => c.slices.some((s) => touched.has(s.blockId)));
      } else {
        selected = all;
      }
      chunks = selected.map((chunk) => ({
        chunkId: chunk.chunkId,
        contextBefore: chunk.contextBefore,
        contextAfter: chunk.contextAfter,
        tokenEstimate: chunk.tokenEstimate,
        segments: chunk.slices.map((slice) => {
          const block = blockById.get(slice.blockId);
          return {
            blockId: slice.blockId,
            charStart: slice.charStart,
            charEnd: slice.charEnd,
            text: block.text.slice(slice.charStart, slice.charEnd),
            protected: isProtected(block, slice.charStart, slice.charEnd),
          };
        }),
      }));
    }

    // Hash every block the run touches (targeted fragments included).
    for (const chunk of chunks) {
      for (const segment of chunk.segments) hashOf(segment.blockId);
    }

    // Capture per-block text lengths alongside the hashes — the whole-block
    // coverage gate needs the captured length (the fresh re-hash proves the
    // text unchanged before any write).
    const lengths = new Map();
    for (const blockId of sourceHashes.keys()) {
      lengths.set(blockId, blockById.get(blockId).text.length);
    }

    const run = new TranslationRun({
      coordinator: api,
      projectId,
      language: canonical,
      intent,
      chunks,
      revision,
      sourceHashes,
      lengths,
    });
    runs.set(run.runId, run);
    return run;
  }

  /** Start an automatic batch over the whole plan (plan §10.6 intent 1). */
  function startAutomatic(options) {
    const opts = requirePlainObject(options, 'options');
    const run = prepare({ ...opts, intent: 'automatic' });
    run._setState('preparing');
    queueMicrotask(() => run._drive()); // listeners attached now see every transition
    return run;
  }

  /**
   * Translate one plan chunk by id (plan §10.6 intent 2). The run EXPANDS
   * to every plan chunk carrying a slice of any block the requested chunk
   * touches (manual-chunk expansion policy — module header): a D3-split
   * block only commits when ALL its slices resolve, so a bare single-chunk
   * run would report success while landing nothing. Progress and token
   * totals therefore cover the expanded chunk set; the resulting merged
   * entries are 'draft' (approval belongs to the review lane, D6).
   */
  function startManualChunk(options) {
    const opts = requirePlainObject(options, 'options');
    requireNonEmptyString(opts.chunkId, 'options.chunkId');
    const run = prepare({ ...opts, intent: 'manual-chunk' });
    run._setState('preparing');
    queueMicrotask(() => run._drive());
    return run;
  }
  /**
   * Translate explicit block fragments — targeted current/selection intent
   * (plan §10.6 intent 3). Full-block fragments commit through the archive
   * path; partial blocks are validated and reported but never written (see
   * module header).
   */
  function startTargeted(options) {
    const opts = requirePlainObject(options, 'options');
    const run = prepare({ ...opts, intent: 'targeted' });
    run._setState('preparing');
    queueMicrotask(() => run._drive());
    return run;
  }

  /** Look up a live run handle by id (null when unknown/ended). */
  function getRun(runId) {
    return runs.get(runId) ?? null;
  }

  const api = {
    startAutomatic,
    startManualChunk,
    startTargeted,
    getRun,
    _store: store,
    _translate: translate,
    _forget(run) {
      runs.delete(run.runId);
    },
  };
  return api;
}

module.exports = {
  createTranslationCoordinator,
  MAX_REPAIR_ATTEMPTS,
  validateChunkResponse,
  suspicionOf,
  statusForBlock,
  RUN_STATES,
  CHUNK_STATUSES,
  CHUNK_DONE_STATUSES,
};
