import { ChunkData, GlossaryEntry, LanguageResult, SessionConfig, TranscriptCue, TranslationVariant } from '../types';
import {
  displayTranslationLanguage,
  isRealTranslationLanguage,
  isUsableTranslationText,
  normalizeMediaSessionTranslations,
  normalizeVariantArchive,
  projectChunkLegacyFields,
  removeTranslationVariant,
  resolveChunkVariant,
  translationLanguageKey,
  upsertTranslationVariant,
} from '../../shared/media-translations.js';
import { replaceSelectedText } from '../lib/text-revision';
import { applyGlossaryToText } from '../lib/glossary';

/**
 * Renderer media-review coordinator (P3E.D2).
 *
 * One owner for every source/translation mutation of a media session:
 * hydration, language selection/registration, direct edits, AI-assisted
 * operations (transcription, retranslation, audio-aware review, literary
 * polish, Add Translation sweeps), contextual selection replacement, variant
 * upsert/removal with eager legacy projection, approval/navigation, and a
 * TRANSIENT generation ledger that invalidates late async completions.
 *
 * Stale contract (all enforced before any commit lands):
 *   - explicit start/open/new session bumps the session generation; an
 *     old-session completion is a no-op;
 *   - exact chunk identity is index + filePath + startSec + endSec, never
 *     array position alone;
 *   - every lane validates its captured content generation AND the exact
 *     captured text (blocks ABA round-trips);
 *   - translation lanes additionally validate the captured previous variant
 *     text and (for active-language operations) that the active language has
 *     not moved away since capture;
 *   - a newer operation on the same scope (chunk, plus language on the
 *     translation lane) invalidates any older one regardless of kind;
 *   - stale/unusable/error outcomes preserve canonical content and archives;
 *   - generations live only in this ledger and are never persisted.
 * Representation honesty: arbitrary text replacement (direct edits,
 *   contextual selection rewrites, undo-style restores) cannot preserve
 *   timing truthfully — such mutations drop the lane's structured cues and
 *   every non-TXT format, keeping the new plain text as the sole canonical
 *   representation. Exempt: deterministic glossary rewrites (term
 *   replacement is structurally reconcilable) and provider commits (they
 *   return their own cues/formats).
 *
 * The class is pure with respect to sessions apart from its private counters:
 * every method either derives and returns a fresh session (or null for
 * stale/no-op) or records bookkeeping. Provider/network/electron effects stay
 * injected in App. Callers must invoke mutating methods OUTSIDE React state
 * updaters (the counters must not be double-invoked) and feed the freshest
 * session snapshot into each call.
 */

/** Text selection handed over from TextPanel async callbacks. */
export interface SelectionPayload {
  selectedText: string;
  contextText: string;
}

export type ReviewSide = 'original' | 'translated';

/** Structural subset of App's Session consumed by the coordinator. */
export interface ReviewSession {
  chunks: ChunkData[];
  currentIndex: number;
  targetLang: string;
  config: SessionConfig;
  activeTranslationLanguage?: string;
  availableTranslationLanguages?: string[];
}

type OperationKind = 'transcription' | 'retranslation' | 'sweep' | 'review' | 'polish';
type OperationLane = 'source' | 'translation';

interface ReviewOpToken {
  id: number;
  kind: OperationKind;
  lane: OperationLane;
  chunkIndex: number;
  filePath: string;
  startSec: number;
  endSec: number;
  sessionGen: number;
  contentGen: number;
  sourceText: string;
  /** Captured translation language key ('' never occurs on translation lanes). */
  languageKey: string;
  /** Exact previously-captured variant text; undefined captures "no variant". */
  variantText?: string;
  /** Drop after the active language moves away from the captured key. */
  requiresActive: boolean;
  selection?: SelectionPayload;
}

/** Opaque handle returned by begin* methods and consumed by commit/fail. */
export type ReviewOperation = Readonly<ReviewOpToken>;

export interface OperationStart<S extends ReviewSession> {
  session: S;
  operation: ReviewOperation;
}

export interface TranscriptionPayload {
  original: string;
  originalFormats?: LanguageResult;
  originalCues?: TranscriptCue[];
  unrecognizedFragments?: string[];
  translatedText?: string;
  translatedCues?: TranscriptCue[];
  translatedFormats?: LanguageResult;
  provider?: string;
  updatedAt?: string;
}

export interface TranslationCommitPayload {
  text: string;
  cues?: TranscriptCue[];
  formats?: LanguageResult;
  provider?: string;
  updatedAt?: string;
}

interface ContentCapture {
  filePath: string;
  startSec: number;
  endSec: number;
  contentGen: number;
  sourceText: string;
}

function chunkAt(session: ReviewSession, index: number): ChunkData | null {
  return session.chunks[index] ?? null;
}

function hasUsableSource(chunk: ChunkData | null): chunk is ChunkData {
  return Boolean(chunk && typeof chunk.original === 'string' && chunk.original.trim());
}

/** TXT-only format object for an arbitrarily replaced lane: SRT/VTT and
 * every other derived format are semantically false once plain text was
 * rewritten wholesale, so exactly {TXT} survives — stale timed keys are
 * dropped outright, never left undefined-valued where a consumer could
 * read them as present. */
function untimedFormats(text: string, formatsTxt?: string): LanguageResult {
  return { TXT: formatsTxt ?? text };
}

/** Honest representation after ANY arbitrary source-lane replacement
 * (manual edit, AI selection rewrite, undo-style restore): cue timing
 * cannot survive an unstructured rewrite without stored cue history, so
 * `originalCues` is dropped and only `original` plus its TXT rendering
 * remain canonical. Deterministic glossary rewrites do not go through
 * here — term replacement stays structurally reconcilable. */
function sourceReplacedWithText(chunk: ChunkData, text: string, formatsTxt?: string): ChunkData {
  const next: ChunkData = { ...chunk, original: text, originalFormats: untimedFormats(text, formatsTxt) };
  delete next.originalCues;
  return next;
}

export class MediaReviewCoordinator {
  private sessionGeneration = 0;
  private nextOperationId = 1;
  private contentGenerations = new Map<number, number>();
  private latestByScope = new Map<string, ReviewOpToken>();

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Hydrate a session for review: canonical normalization through the shared
   * module (strips the legacy selected field, resolves the active language,
   * re-keys archives, projects variants) plus a fresh generation epoch.
   */
  adopt<S extends ReviewSession>(session: S): S {
    this.beginEpoch();
    return normalizeMediaSessionTranslations(session);
  }

  /** Explicit start/new-session reset when there is no session to hydrate. */
  reset(): void {
    this.beginEpoch();
  }

  private beginEpoch(): void {
    this.sessionGeneration += 1;
    this.contentGenerations.clear();
    this.latestByScope.clear();
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  /** Canonical active language display name, or '' when untranslated. */
  activeLanguage(session: ReviewSession): string {
    return isRealTranslationLanguage(session.activeTranslationLanguage)
      ? displayTranslationLanguage(session.activeTranslationLanguage)
      : '';
  }

  /** Canonical available languages (display names). */
  availableLanguages(session: ReviewSession): string[] {
    return Array.isArray(session.availableTranslationLanguages)
      ? session.availableTranslationLanguages.filter(isRealTranslationLanguage).map((l) =>
          displayTranslationLanguage(l)
        )
      : [];
  }

  private activeKeyOf(session: ReviewSession): string {
    return isRealTranslationLanguage(session.activeTranslationLanguage)
      ? translationLanguageKey(session.activeTranslationLanguage)
      : '';
  }

  // ── Transcription (initial, auto-next, retry) ────────────────────────────

  /**
   * Begin one chunk transcription. Initial/auto-next flips the chunk to
   * 'processing'; a retry additionally resets approval and status exactly as
   * the historical flow did (`approved: false, status: 'pending'`).
   */
  beginTranscription<S extends ReviewSession>(
    session: S,
    index: number,
    cfg: SessionConfig,
    options: { retry: boolean }
  ): OperationStart<S> | null {
    const chunk = chunkAt(session, index);
    if (!chunk) return null;
    const operation: ReviewOpToken = {
      id: this.nextOperationId++,
      kind: 'transcription',
      lane: 'source',
      chunkIndex: index,
      ...this.captureContent(session, index),
      sessionGen: this.sessionGeneration,
      languageKey: isRealTranslationLanguage(cfg.targetLang)
        ? translationLanguageKey(cfg.targetLang)
        : '',
      requiresActive: false,
    };
    this.latestByScope.set(this.scopeOf(operation), operation);
    const nextChunk: ChunkData = options.retry
      ? { ...chunk, approved: false, status: 'pending' }
      : { ...chunk, status: 'processing' };
    return { session: this.withChunk(session, index, nextChunk), operation };
  }

  /**
   * Commit a finished transcription. Freshness first: an old-session,
   * identity-changed, or content-drifted completion is a deep no-op. On
   * success the captured target language receives the variant (unusable
   * translations preserve prior archives untouched), inactive variants are
   * preserved, the captured active variant is refreshed, and approval /
   * current index / active selection made after the start are never restored.
   */
  commitTranscription<S extends ReviewSession>(
    session: S,
    operation: ReviewOperation,
    payload: TranscriptionPayload
  ): S | null {
    if (!this.isFresh(session, operation)) return null;
    const chunk = chunkAt(session, operation.chunkIndex)!;
    let nextChunk: ChunkData = {
      ...chunk,
      original: payload.original,
      originalFormats: payload.originalFormats,
      originalCues: payload.originalCues,
      unrecognizedFragments: payload.unrecognizedFragments ?? [],
      status: 'done',
    };
    if (
      operation.languageKey &&
      payload.translatedText !== undefined &&
      isUsableTranslationText(payload.translatedText)
    ) {
      const archive = upsertTranslationVariant(nextChunk, {
        language: operation.languageKey,
        text: payload.translatedText,
        cues: payload.translatedCues,
        formats: payload.translatedFormats,
        provider: payload.provider,
        updatedAt: payload.updatedAt,
      });
      if (archive) nextChunk.translationsByLanguage = archive;
    }
    nextChunk = this.projectChunk(nextChunk, this.activeKeyOf(session));
    this.bumpContent(operation.chunkIndex);
    return this.withChunk(session, operation.chunkIndex, nextChunk);
  }

  /**
   * Commit a failed transcription. Parity with the historical error path: the
   * chunk surfaces the typed error message as its source text and goes to
   * 'error'. The typed message wholesale-replaces the source lane, so prior
   * cue timing collapses to the shared TXT-only representation exactly like
   * any other arbitrary replacement — stale cues must never mask the failure.
   * Stale failures are no-ops.
   */
  failTranscription<S extends ReviewSession>(
    session: S,
    operation: ReviewOperation,
    message: string
  ): S | null {
    if (!this.isFresh(session, operation)) return null;
    const chunk = chunkAt(session, operation.chunkIndex)!;
    const errorText = `Error: ${message}`;
    this.bumpContent(operation.chunkIndex);
    return this.withChunk(session, operation.chunkIndex, {
      ...sourceReplacedWithText(chunk, errorText),
      status: 'error',
    });
  }

  // ── Retry translation (active language) ──────────────────────────────────

  /**
   * Begin a retry translation for the currently displayed (active) language.
   * The operation captures the exact source text, the captured variant text,
   * and the active language; any later switch/edit/session change drops it.
   */
  beginTranslationRetry<S extends ReviewSession>(
    session: S,
    index: number
  ): OperationStart<S> | null {
    const chunk = chunkAt(session, index);
    const activeKey = this.activeKeyOf(session);
    if (!chunk || !activeKey) return null;
    const operation: ReviewOpToken = {
      id: this.nextOperationId++,
      kind: 'retranslation',
      lane: 'translation',
      chunkIndex: index,
      ...this.captureContent(session, index),
      sessionGen: this.sessionGeneration,
      languageKey: activeKey,
      variantText: this.variantTextOf(chunk, activeKey),
      requiresActive: true,
    };
    this.latestByScope.set(this.scopeOf(operation), operation);
    return { session: this.withChunk(session, index, { ...chunk, status: 'processing' }), operation };
  }

  /**
   * Commit a finished retry translation. Writes ONLY the captured active
   * language key; unusable results preserve canonical content and archives
   * and land like a failure (status follows source presence).
   */
  commitTranslationResult<S extends ReviewSession>(
    session: S,
    operation: ReviewOperation,
    payload: TranslationCommitPayload
  ): S | null {
    if (!this.isFresh(session, operation)) return null;
    const chunk = chunkAt(session, operation.chunkIndex)!;
    if (!isUsableTranslationText(payload.text)) {
      return this.withChunk(session, operation.chunkIndex, {
        ...chunk,
        status: hasUsableSource(chunk) ? 'done' : 'error',
      });
    }
    const archive = upsertTranslationVariant(chunk, {
      language: operation.languageKey,
      text: payload.text,
      cues: payload.cues,
      formats: payload.formats,
      provider: payload.provider,
      updatedAt: payload.updatedAt,
    });
    let nextChunk: ChunkData = { ...chunk, status: 'done' };
    if (archive) nextChunk.translationsByLanguage = archive;
    nextChunk = this.projectChunk(nextChunk, this.activeKeyOf(session));
    this.bumpContent(operation.chunkIndex);
    return this.withChunk(session, operation.chunkIndex, nextChunk);
  }

  /** Fail a retry translation; status follows the historical parity rule. */
  failTranslationRetry<S extends ReviewSession>(
    session: S,
    operation: ReviewOperation
  ): S | null {
    if (!this.isFresh(session, operation)) return null;
    const chunk = chunkAt(session, operation.chunkIndex)!;
    return this.withChunk(session, operation.chunkIndex, {
      ...chunk,
      status: hasUsableSource(chunk) ? 'done' : 'error',
    });
  }

  // ── Add Translation sweep (captured language, archive-only safe) ─────────

  /**
   * Begin one progressive Add Translation step for a specific language.
   * Unlike the active retry, this operation does not require the captured
   * language to remain selected and never touches chunk status: a late
   * completion archives only its captured language while the projection stays
   * on whatever the user currently views.
   */
  beginLanguageSweepStep<S extends ReviewSession>(
    session: S,
    index: number,
    language: string
  ): ReviewOperation | null {
    const chunk = chunkAt(session, index);
    const languageKey = isRealTranslationLanguage(language)
      ? translationLanguageKey(language)
      : '';
    if (!chunk || !hasUsableSource(chunk) || !languageKey) return null;
    const operation: ReviewOpToken = {
      id: this.nextOperationId++,
      kind: 'sweep',
      lane: 'translation',
      chunkIndex: index,
      ...this.captureContent(session, index),
      sessionGen: this.sessionGeneration,
      languageKey,
      variantText: this.variantTextOf(chunk, languageKey),
      requiresActive: false,
    };
    this.latestByScope.set(this.scopeOf(operation), operation);
    return operation;
  }

  /**
   * Commit one Add Translation step. Archives only the captured language;
   * projection remains on the current active variant. Stale steps (source
   * edited, chunk replaced, newer same-scope work, old session) are skipped.
   */
  commitLanguageSweepStep<S extends ReviewSession>(
    session: S,
    operation: ReviewOperation,
    payload: TranslationCommitPayload
  ): S | null {
    if (!this.isFresh(session, operation)) return null;
    const chunk = chunkAt(session, operation.chunkIndex)!;
    if (!isUsableTranslationText(payload.text)) return null;
    const archive = upsertTranslationVariant(chunk, {
      language: operation.languageKey,
      text: payload.text,
      cues: payload.cues,
      formats: payload.formats,
      provider: payload.provider,
      updatedAt: payload.updatedAt,
    });
    if (!archive) return null;
    const nextChunk = this.projectChunk(
      { ...chunk, translationsByLanguage: archive },
      this.activeKeyOf(session)
    );
    this.bumpContent(operation.chunkIndex);
    return this.withChunk(session, operation.chunkIndex, nextChunk);
  }

  // ── Contextual selection operations (audio review, polish) ───────────────

  /**
   * Begin an audio-aware review or literary polish over one pane selection.
   * The baseline (exact lane text plus selection/context strings) is captured
   * here; the commit applies only against the same baseline with an
   * unambiguous still-current occurrence.
   */
  beginSelectionOperation<S extends ReviewSession>(
    session: S,
    index: number,
    side: ReviewSide,
    selection: SelectionPayload,
    kind: Extract<OperationKind, 'review' | 'polish'> = 'review'
  ): ReviewOperation | null {
    const chunk = chunkAt(session, index);
    const activeKey = this.activeKeyOf(session);
    if (!chunk) return null;
    if (side === 'translated' && !activeKey) return null;
    const lane: OperationLane = side === 'original' ? 'source' : 'translation';
    const operation: ReviewOpToken = {
      id: this.nextOperationId++,
      kind,
      lane,
      chunkIndex: index,
      ...this.captureContent(session, index),
      sessionGen: this.sessionGeneration,
      languageKey: lane === 'translation' ? activeKey : '',
      variantText: lane === 'translation' ? this.variantTextOf(chunk, activeKey) : undefined,
      requiresActive: lane === 'translation',
      selection: { ...selection },
    };
    this.latestByScope.set(this.scopeOf(operation), operation);
    return operation;
  }

  /**
   * Commit a selection replacement. Requires the same baseline (the lane text
   * is unchanged since capture) and an unambiguous still-current occurrence
   * of the selection; otherwise a no-op. Either lane's replacement is an
   * arbitrary rewrite, so the touched representation collapses to plain
   * text: source drops originalCues and non-TXT formats; translation
   * replacements drop that variant's cues and timed formats while inactive
   * variants stay byte-identical.
   */
  commitSelectionReplacement<S extends ReviewSession>(
    session: S,
    operation: ReviewOperation,
    replacementText: string,
    updatedAt?: string
  ): S | null {
    if (!operation.selection || !this.isFresh(session, operation)) return null;
    const chunk = chunkAt(session, operation.chunkIndex)!;
    const current =
      operation.lane === 'source'
        ? chunk.original ?? ''
        : this.variantTextOf(chunk, operation.languageKey) ?? '';
    // Unambiguous still-current occurrence: a repeated selection is only
    // replaceable when a unique context line scopes it; otherwise no-op.
    const trimmedSelection = operation.selection.selectedText.trim();
    if (!trimmedSelection) return null;
    const occurrences = countOccurrences(current, trimmedSelection);
    if (occurrences > 1) {
      const context = operation.selection.contextText.trim();
      if (!context || countOccurrences(current, context) !== 1) return null;
    }

    const result = replaceSelectedText(current, {
      selectedText: operation.selection.selectedText,
      replacementText,
      contextText: operation.selection.contextText,
    });
    if (!result.changed || result.text === current) return null;

    if (operation.lane === 'source') {
      this.bumpContent(operation.chunkIndex);
      return this.withChunk(
        session,
        operation.chunkIndex,
        this.settleProcessing(sourceReplacedWithText(chunk, result.text))
      );
    }

    const archive = this.replaceVariantWithPlainText(
      chunk,
      operation.languageKey,
      result.text,
      undefined,
      updatedAt
    );
    if (!archive) return null;
    const nextChunk = this.projectChunk(
      { ...chunk, translationsByLanguage: archive },
      this.activeKeyOf(session)
    );
    this.bumpContent(operation.chunkIndex);
    return this.withChunk(session, operation.chunkIndex, this.settleProcessing(nextChunk));
  }

  // ── Direct edits ─────────────────────────────────────────────────────────

  /**
   * Direct synchronous source edit (manual editing, MCP text mutation,
   * undo-style restores). An arbitrary replacement: originalCues and every
   * non-TXT format are invalidated; the new plain text stays the canonical
   * source and TXT representation.
   */
  editSource<S extends ReviewSession>(
    session: S,
    index: number,
    text: string,
    formatsTxt?: string
  ): S {
    const chunk = chunkAt(session, index);
    if (!chunk) return session;
    this.bumpContent(index);
    return this.withChunk(
      session,
      index,
      this.settleProcessing(sourceReplacedWithText(chunk, text, formatsTxt))
    );
  }

  /**
   * Direct synchronous translation edit on the active language. An explicit
   * empty edit removes the active variant; anything else upserts it as an
   * arbitrary rewrite — that variant's cues and timed formats are dropped,
   * still-true metadata (provider/updatedAt) survives — and refreshes the
   * eager projection.
   */
  editTranslation<S extends ReviewSession>(
    session: S,
    index: number,
    text: string,
    formatsTxt?: string,
    updatedAt?: string
  ): S {
    const chunk = chunkAt(session, index);
    const activeKey = this.activeKeyOf(session);
    if (!chunk || !activeKey) return session;
    let archive: Record<string, TranslationVariant>;
    if (text.trim() === '') {
      archive = removeTranslationVariant(chunk, activeKey);
    } else {
      const upserted = this.replaceVariantWithPlainText(chunk, activeKey, text, formatsTxt, updatedAt);
      if (!upserted) return session;
      archive = upserted;
    }
    const nextChunk = this.projectChunk(
      { ...chunk, translationsByLanguage: archive },
      activeKey
    );
    if (Object.keys(archive).length === 0) delete nextChunk.translationsByLanguage;
    this.bumpContent(index);
    return this.withChunk(session, index, this.settleProcessing(nextChunk));
  }

  /**
   * Route a bulk content rewrite (glossary application) through the
   * coordinator: swaps the provided chunk objects in, bumps the affected
   * content generations so concurrent operations drop, and refreshes every
   * eager projection against the current active variant.
   */
  commitContentRewrite<S extends ReviewSession>(
    session: S,
    nextChunks: ChunkData[],
    touchedIndexes: number[]
  ): S {
    const activeKey = this.activeKeyOf(session);
    const chunks = session.chunks.map((chunk, index) => {
      const replacement = nextChunks[index];
      if (!replacement || replacement === chunk) return chunk;
      return this.settleProcessing(this.projectChunk(replacement, activeKey));
    });
    for (const index of touchedIndexes) this.bumpContent(index);
    return { ...session, chunks };
  }

  /**
   * Language-aware bulk glossary rewrite. The caller supplies only the touched
   * chunk indexes; this owns canonical mutation semantics: source lanes take
   * the generic source replacement, while every translation variant first
   * looks up a case-insensitive language-specific replacement in
   * `entry.translations`. The active variant alone may fall back to the
   * generic `entry.translation`; an inactive variant without its own mapping
   * stays byte-identical. Projections refresh and touched generations bump
   * exactly once, as for every other coordinated rewrite.
   */
  applyGlossaryEntry<S extends ReviewSession>(
    session: S,
    touchedIndexes: number[],
    entry: GlossaryEntry
  ): S {
    const touched = new Set(touchedIndexes);
    const activeKey = this.activeKeyOf(session);
    const nextChunks = session.chunks.map((chunk, index) =>
      touched.has(index) ? this.rewriteChunkWithGlossary(chunk, entry, activeKey) : chunk
    );
    return this.commitContentRewrite(session, nextChunks, touchedIndexes);
  }

  private rewriteChunkWithGlossary(chunk: ChunkData, entry: GlossaryEntry, activeKey: string): ChunkData {
    const archive = normalizeVariantArchive(chunk);
    const nextArchive: Record<string, TranslationVariant> = {};
    for (const [languageKey, variant] of Object.entries(archive)) {
      const scoped = scopedTranslationEntry(entry, languageKey, activeKey);
      if (!scoped) {
        nextArchive[languageKey] = variant;
        continue;
      }
      const cues = Array.isArray(variant.cues)
        ? variant.cues.map((cue) => ({ ...cue, text: applyGlossaryToText(cue.text, [scoped], 'translation').text }))
        : variant.cues;
      nextArchive[languageKey] = {
        ...variant,
        text: applyGlossaryToText(variant.text, [scoped], 'translation').text,
        ...(cues ? { cues } : {}),
        formats: mapStringFormats(variant.formats, scoped, 'translation'),
      };
    }
    // The source cue track follows the same source replacement as the chunk
    // body; every other cue field (timing/words) passes through untouched.
    const originalCues = Array.isArray(chunk.originalCues)
      ? chunk.originalCues.map((cue) => ({ ...cue, text: applyGlossaryToText(cue.text, [entry], 'source').text }))
      : chunk.originalCues;
    return this.projectChunk(
      {
        ...chunk,
        original: applyGlossaryToText(chunk.original ?? '', [entry], 'source').text,
        ...(originalCues ? { originalCues } : {}),
        originalFormats: mapStringFormats(chunk.originalFormats, entry, 'source'),
        translationsByLanguage: nextArchive,
      },
      activeKey
    );
  }

  // ── Approval & navigation ────────────────────────────────────────────────

  /** Approval stays chunk-global and never touches archives. */
  setApproval<S extends ReviewSession>(session: S, index: number, approved: boolean): S {
    const chunk = chunkAt(session, index);
    if (!chunk || chunk.approved === approved) return session;
    return this.withChunk(session, index, { ...chunk, approved });
  }

  /** Navigation only moves the cursor; archives and selections are untouched. */
  setCurrentIndex<S extends ReviewSession>(session: S, index: number): S {
    const clamped = Math.max(0, Math.min(index, session.chunks.length - 1));
    if (clamped === session.currentIndex) return session;
    return { ...session, currentIndex: clamped };
  }

  // ── Language controls ────────────────────────────────────────────────────

  /**
   * Switch the active translation language synchronously. Requires a real
   * registered language; synchronizes target/config targets and reprojects
   * every chunk so the legacy fields immediately mirror the new variant.
   */
  selectLanguage<S extends ReviewSession>(session: S, language: string): S | null {
    const display = displayTranslationLanguage(language);
    if (!isRealTranslationLanguage(display)) return null;
    if (!this.availableLanguages(session).includes(display)) return null;
    return this.withActiveLanguage(session, translationLanguageKey(display));
  }

  /**
   * Register a new target language and select it immediately (Add
   * Translation). Registration happens even though no variant exists yet so
   * declared-but-partial languages survive normalization.
   */
  addLanguage<S extends ReviewSession>(session: S, language: string): S | null {
    const display = displayTranslationLanguage(language);
    if (!isRealTranslationLanguage(display)) return null;
    const available = this.availableLanguages(session);
    const nextAvailable = available.includes(display)
      ? available
      : [...available, display];
    return this.withActiveLanguage({ ...session, availableTranslationLanguages: nextAvailable }, translationLanguageKey(display));
  }

  private withActiveLanguage<S extends ReviewSession>(session: S, key: string): S {
    const display = displayTranslationLanguage(key);
    const chunks = session.chunks.map((chunk) => this.projectChunk(chunk, key));
    return {
      ...session,
      chunks,
      activeTranslationLanguage: display,
      targetLang: display,
      config: { ...session.config, targetLang: display },
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private captureContent(session: ReviewSession, index: number): ContentCapture {
    const chunk = chunkAt(session, index)!;
    return {
      filePath: chunk.filePath,
      startSec: chunk.startSec,
      endSec: chunk.endSec,
      contentGen: this.contentGenerations.get(index) ?? 0,
      sourceText: chunk.original ?? '',
    };
  }

  private chunkMatchesIdentity(chunk: ChunkData | null | undefined, operation: ReviewOpToken): boolean {
    return Boolean(
      chunk &&
      chunk.filePath === operation.filePath &&
      chunk.startSec === operation.startSec &&
      chunk.endSec === operation.endSec
    );
  }

  private scopeOf(operation: ReviewOpToken): string {
    return operation.lane === 'translation'
      ? `t:${operation.chunkIndex}|${operation.languageKey}`
      : `s:${operation.chunkIndex}`;
  }

  private variantTextOf(chunk: ChunkData, languageKey: string): string | undefined {
    if (!languageKey) return undefined;
    const archive = normalizeVariantArchive(chunk);
    return Object.prototype.hasOwnProperty.call(archive, languageKey)
      ? archive[languageKey].text
      : undefined;
  }

  /**
   * Upsert an arbitrarily replaced translation text (manual edit, AI
   * selection rewrite, undo-style restore) for the captured language: that
   * variant's cues and timed formats are dropped — timing cannot survive an
   * unstructured rewrite — while still-true metadata (provider/updatedAt)
   * is preserved. Inactive variants pass through untouched.
   */
  private replaceVariantWithPlainText(
    chunk: ChunkData,
    languageKey: string,
    text: string,
    formatsTxt?: string,
    updatedAt?: string
  ): Record<string, TranslationVariant> | null {
    const existing = resolveChunkVariant(chunk, languageKey, languageKey);
    return upsertTranslationVariant(chunk, {
      language: languageKey,
      text,
      formats: untimedFormats(text, formatsTxt),
      provider: existing?.provider,
      updatedAt: updatedAt ?? existing?.updatedAt,
    });
  }

  private isFresh(session: ReviewSession, operation: ReviewOpToken): boolean {
    if (operation.sessionGen !== this.sessionGeneration) return false;
    const chunk = chunkAt(session, operation.chunkIndex);
    if (!this.chunkMatchesIdentity(chunk, operation)) return false;
    if ((this.contentGenerations.get(operation.chunkIndex) ?? 0) !== operation.contentGen) {
      return false;
    }
    if ((chunk!.original ?? '') !== operation.sourceText) return false;
    if (this.latestByScope.get(this.scopeOf(operation))?.id !== operation.id) return false;
    if (operation.lane === 'translation') {
      if (
        operation.requiresActive &&
        this.activeKeyOf(session) !== operation.languageKey
      ) {
        return false;
      }
      if ((this.variantTextOf(chunk!, operation.languageKey) ?? undefined) !== operation.variantText) {
        return false;
      }
    }
    return true;
  }

  private bumpContent(index: number): void {
    this.contentGenerations.set(index, (this.contentGenerations.get(index) ?? 0) + 1);
  }

  /**
   * Stable post-invalidation status for synchronous content mutations. A
   * mutation that drops an in-flight operation (its generation bump makes the
   * late commit a no-op) must never leave the chunk stuck at 'processing':
   * existing chunk content alone picks the normal stable state ('done' with a
   * usable source, otherwise 'error'). Approval, archives, and the cursor are
   * untouched.
   */
  private settleProcessing(chunk: ChunkData): ChunkData {
    if (chunk.status !== 'processing') return chunk;
    return { ...chunk, status: hasUsableSource(chunk) ? 'done' : 'error' };
  }

  /** Eagerly project the active variant onto the legacy chunk fields; a
   * missing variant projects blank/undefined and never borrows. */
  private projectChunk(chunk: ChunkData, activeKey: string): ChunkData {
    const projection = projectChunkLegacyFields(chunk, activeKey);
    const next: ChunkData = { ...chunk, translated: projection.translated };
    if (projection.translatedCues === undefined) delete next.translatedCues;
    else next.translatedCues = projection.translatedCues;
    if (projection.translatedFormats === undefined) delete next.translatedFormats;
    else next.translatedFormats = projection.translatedFormats;
    if (
      !next.translationsByLanguage ||
      Object.keys(next.translationsByLanguage).length === 0

    ) {
      delete next.translationsByLanguage;
    }
    return next;
  }

  private withChunk<S extends ReviewSession>(session: S, index: number, chunk: ChunkData): S {
    const chunks = session.chunks.slice();
    chunks[index] = chunk;
    return { ...session, chunks };
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  for (;;) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

/** Rewrite every string format value through one glossary entry; non-string
 * values pass through untouched. */
function mapStringFormats(
  formats: LanguageResult | undefined,
  entry: GlossaryEntry,
  target: 'source' | 'translation'
): LanguageResult | undefined {
  if (!formats) return formats;
  return Object.fromEntries(
    Object.entries(formats).map(([format, value]) => [
      format,
      typeof value === 'string' ? applyGlossaryToText(value, [entry], target).text : value,
    ])
  ) as LanguageResult;
}

/** Case-insensitive language-specific replacement declared for a canonical
 * language key, or undefined when the entry declares none (or an empty one). */
function languageGlossaryReplacement(entry: GlossaryEntry, languageKey: string): string | undefined {
  if (!languageKey) return undefined;
  for (const [declaredLanguage, replacement] of Object.entries(entry.translations ?? {})) {
    if (
      typeof replacement === 'string' &&
      replacement.trim() &&
      translationLanguageKey(declaredLanguage) === languageKey
    ) {
      return replacement;
    }
  }
  return undefined;
}

/** The entry scoped to one archive language: a declared replacement always
 * wins; without one, only the active language may use the generic
 * `entry.translation`. null leaves the variant byte-identical. */
function scopedTranslationEntry(
  entry: GlossaryEntry,
  languageKey: string,
  activeKey: string
): GlossaryEntry | null {
  const replacement = languageGlossaryReplacement(entry, languageKey);
  if (replacement !== undefined) return { ...entry, translation: replacement };
  return languageKey === activeKey ? entry : null;
}
