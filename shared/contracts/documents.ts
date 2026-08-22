/**
 * Document domain contract (DOC-01) — normalized import/preflight state.
 *
 * This is the shared Main/Renderer/Worker contract for the document feature
 * lane. DOC-01 owns the import + preflight slice: turning a raw DOCX/PDF/RTF/
 * TXT/MD byte buffer into a normalized `NormalizedDocument` (structural
 * blocks + inline spans + a preflight report). DOC-02 adds the persistence
 * slice: the versioned `DocumentArchive` and per-language `TranslationArchive`
 * schemas plus BCP-47 normalization. Later DOC steps (chunk planning,
 * translation, editorial) extend this shape but never redefine
 * these invariants.
 *
 * Design constraints (migration plan §3, §10.3, §10.4):
 *  - Every persisted format carries a `schemaVersion` and a validator so a
 *    corrupt or future payload can be rejected or migrated (invariant #4).
 *  - The source asset is treated as immutable; only its `hash`, `sizeBytes`
 *    and `fileName` are recorded here (invariant #6).
 *  - No manuscript text or secret leaks into logs: the normalized state is
 *    plain serializable data (invariant #7).
 *  - Format limits mirror the canonical constraints and are surfaced
 *    explicitly rather than silently truncated.
 *
 * The parsing/normalization logic lives in `electron/main/documents/import.js`
 * (CommonJS, Node-only deps) and is validated here at runtime so the Renderer
 * and Main agree on the exact shape.
 */

import { createHash } from 'node:crypto';
import { AppError, createAppError, type ErrorCode } from './errors.ts';

/** Current normalized document schema version. Bump on shape change. */
export const DOCUMENT_SCHEMA_VERSION = 1 as const;
export type DocumentSchemaVersion = typeof DOCUMENT_SCHEMA_VERSION;

/** Supported import formats (plan §10.2). */
export type DocumentFormat = 'docx' | 'pdf' | 'rtf' | 'txt' | 'md';

export const DOCUMENT_FORMATS: readonly DocumentFormat[] = [
  'docx',
  'pdf',
  'rtf',
  'txt',
  'md',
] as const;

/**
 * Document parts (plan §10.4). The OOXML/DOCX import keeps the original
 * package and maps text nodes to a stable part so headers, footers and notes
 * are first-class rather than lost in an HTML conversion.
 */
export type DocumentPart =
  | 'main'
  | 'header'
  | 'footer'
  | 'footnote'
  | 'endnote'
  | 'textbox';

/** Structural block kinds (plan §10.4). */
export type BlockKind =
  | 'paragraph'
  | 'heading'
  | 'quote'
  | 'verse'
  | 'list'
  | 'table'
  | 'row'
  | 'empty'
  | 'other';

export const BLOCK_KINDS: readonly BlockKind[] = [
  'paragraph',
  'heading',
  'quote',
  'verse',
  'list',
  'table',
  'row',
  'empty',
  'other',
] as const;

/** Inline traits carried on a span. */
export interface SpanTrait {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  superScript?: boolean;
  subScript?: boolean;
  smallCaps?: boolean;
  /** Hex color, e.g. `#FF0000`. Absent means inherit. */
  color?: string;
}

/**
 * A contiguous run of text inside a block sharing one trait set.
 *
 * Indexing rule: `start`/`end` are offsets in UTF-16 code units over the
 * owning block's `text` (`start` inclusive, `end` exclusive) — plain
 * JavaScript string indices, so `span.text === block.text.slice(span.start,
 * span.end)` always holds. Offsets MAY fall inside a surrogate pair: content
 * integrity is guaranteed by the slice equality, not by code-point
 * alignment, and validators enforce exactly that equality.
 */
export interface Span {
  spanId: string;
  blockId: string;
  text: string;
  /** Character offset of this span within `block.text` (inclusive). */
  start: number;
  /** Exclusive end offset within `block.text`. */
  end: number;
  traits: SpanTrait;
}

/** A normalized structural block of the document. */
export interface Block {
  blockId: string;
  kind: BlockKind;
  part: DocumentPart;
  /** Heading/list depth. Present for `heading`/`list`. */
  level?: number;
  /** Zero-based position of the block within its part. */
  index: number;
  /** 1-based page for paginated formats (DOCX/PDF). */
  page?: number;
  /** Stable, content-derived fingerprint of the block's kind/level/traits. */
  styleFingerprint: string;
  /** Hash of the source part bytes this block was extracted from. */
  sourceHash: string;
  /** Full concatenated text of the block. */
  text: string;
  spans: Span[];
}

export type WarningSeverity = 'info' | 'warning' | 'error';

/** A non-fatal (or fatal-but-diagnosable) condition discovered during preflight. */
export interface PreflightWarning {
  code: string;
  message: string;
  severity: WarningSeverity;
}

export type ExtractionAccuracy = 'high' | 'partial' | 'low' | 'unknown';

/** Report produced for the Upload → Preflight UX step (plan §10.1). */
export interface PreflightReport {
  format: DocumentFormat;
  sizeBytes: number;
  sourceHash: string;
  /** Page count for paginated formats. */
  pages?: number;
  words: number;
  /** Count of structural sections (headings). */
  sections: number;
  blocks: number;
  /** False when the document must be rejected (e.g. OCR required, over limit). */
  canImport: boolean;
  protectedContent: boolean;
  extractionAccuracy: ExtractionAccuracy;
  warnings: PreflightWarning[];
  limits: { sizeBytesLimit: number; exceeded: boolean };
}

/** Immutable source asset reference (invariant #6). */
export interface SourceAssetRef {
  ref: string;
  hash: string;
  sizeBytes: number;
  fileName: string;
}

/**
 * The normalized document produced by DOC-01 import/preflight. The `chunkPlans`
 * and `translations` slots are reserved (empty) for DOC-03/DOC-04; they are
 * present now so the persisted shape is stable and validates forward.
 */
export interface NormalizedDocument {
  schemaVersion: DocumentSchemaVersion;
  format: DocumentFormat;
  title: string;
  sourceAsset: SourceAssetRef;
  preflight: PreflightReport;
  blocks: Block[];
  chunkPlans: never[];
  translations: Record<string, never>;
}

// --- Format size limits (plan §10.2; bytes) --------------------------------

export const DOCUMENT_SIZE_LIMITS: Readonly<Record<DocumentFormat, number>> = {
  docx: 64 * 1024 * 1024,
  pdf: 100 * 1024 * 1024,
  rtf: 32 * 1024 * 1024,
  txt: 32 * 1024 * 1024,
  md: 32 * 1024 * 1024,
};

/**
 * Maximum page count accepted for paginated imports (plan §10.2). Preflight
 * rejects documents beyond this limit with `PAGE_LIMIT_EXCEEDED`.
 */
export const DOCUMENT_PAGE_LIMIT = 2000 as const;

/** Resolve a format from a file name extension (case-insensitive). */
export function detectFormatFromFileName(fileName: string): DocumentFormat | null {
  const ext = String(fileName).toLowerCase().split('.').pop();
  switch (ext) {
    case 'docx':
      return 'docx';
    case 'pdf':
      return 'pdf';
    case 'rtf':
      return 'rtf';
    case 'txt':
    case 'text':
      return 'txt';
    case 'md':
    case 'markdown':
      return 'md';
    default:
      return null;
  }
}

// --- Validation result types ------------------------------------------------

type ValidationOk<T> = { ok: true; value: T };
type ValidationErr = { ok: false; error: AppError };

/** Result of structurally validating an unknown value as a normalized document. */
export type DocumentValidationResult = ValidationOk<NormalizedDocument> | ValidationErr;

// --- Primitive coercers (mirror shared/contracts/projects.ts) ---------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function fail(code: ErrorCode, message: string, details?: unknown): ValidationErr {
  return { ok: false, error: createAppError(code, message, details) };
}

function coerceTrait(v: unknown): SpanTrait | undefined {
  if (!isPlainObject(v)) return undefined;
  const out: SpanTrait = {};
  // The optional boolean traits, keyed exactly as they appear on SpanTrait.
  const keys = [
    'bold',
    'italic',
    'underline',
    'strike',
    'superScript',
    'subScript',
    'smallCaps',
  ] as const;
  for (const k of keys) {
    const b: boolean | undefined = bool(v[k]);
    if (b !== undefined) out[k] = b;
  }
  const color = str(v.color);
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) out.color = color;
  return out;
}

function validateSpan(v: unknown): ValidationOk<Span> | ValidationErr {
  if (!isPlainObject(v)) return fail('VALIDATION_FAILED', 'Span must be an object.');
  const spanId = str(v.spanId);
  if (!spanId) return fail('VALIDATION_FAILED', 'span.spanId is required.');
  const blockId = str(v.blockId);
  if (!blockId) return fail('VALIDATION_FAILED', 'span.blockId is required.');
  const text = str(v.text);
  if (text === undefined) return fail('VALIDATION_FAILED', 'span.text is required.');
  const start = num(v.start);
  const end = num(v.end);
  if (start === undefined || end === undefined) {
    return fail('VALIDATION_FAILED', 'span.start/end must be numbers.');
  }
  const traits = coerceTrait(v.traits);
  if (!traits) return fail('VALIDATION_FAILED', 'span.traits must be an object.');
  return {
    ok: true,
    value: { spanId, blockId, text, start, end, traits },
  };
}

function validateBlock(v: unknown): ValidationOk<Block> | ValidationErr {
  if (!isPlainObject(v)) return fail('VALIDATION_FAILED', 'Block must be an object.');
  const blockId = str(v.blockId);
  if (!blockId) return fail('VALIDATION_FAILED', 'block.blockId is required.');
  const kind = str(v.kind);
  if (!kind || !BLOCK_KINDS.includes(kind as BlockKind)) {
    return fail('VALIDATION_FAILED', `block.kind is invalid: ${kind}`);
  }
  const part = str(v.part);
  if (!part) return fail('VALIDATION_FAILED', 'block.part is required.');
  const index = num(v.index);
  if (index === undefined) return fail('VALIDATION_FAILED', 'block.index is required.');
  const styleFingerprint = str(v.styleFingerprint);
  if (!styleFingerprint) return fail('VALIDATION_FAILED', 'block.styleFingerprint is required.');
  const sourceHash = str(v.sourceHash);
  if (!sourceHash) return fail('VALIDATION_FAILED', 'block.sourceHash is required.');
  const text = str(v.text);
  if (text === undefined) return fail('VALIDATION_FAILED', 'block.text is required.');
  if (!Array.isArray(v.spans)) return fail('VALIDATION_FAILED', 'block.spans must be an array.');
  const spans: Span[] = [];
  for (const s of v.spans) {
    const r = validateSpan(s);
    if (!r.ok) return r;
    spans.push(r.value);
  }
  // Exact-tiling invariant (plan §10.4): spans tile `text` contiguously,
  // completely, and exactly once — ordered, non-empty, integer-bounded in
  // UTF-16 code units (see Span), text-faithful, owned by this block, and
  // uniquely identified. An empty text is tiled by exactly zero spans.
  let prevEnd = 0;
  const seenSpanIds = new Set<string>();
  for (const span of spans) {
    if (
      !Number.isInteger(span.start) ||
      !Number.isInteger(span.end) ||
      span.start < 0 ||
      span.end <= span.start ||
      span.end > text.length
    ) {
      return fail(
        'VALIDATION_FAILED',
        `span "${span.spanId}" must be integer-bounded within 0..${text.length} and non-empty.`,
      );
    }
    if (span.start !== prevEnd) {
      return fail(
        'VALIDATION_FAILED',
        `spans must tile the block text contiguously: "${span.spanId}" starts at ${span.start}, expected ${prevEnd}.`,
      );
    }
    if (span.text !== text.slice(span.start, span.end)) {
      return fail('VALIDATION_FAILED', `span "${span.spanId}".text does not equal its slice of the block text.`);
    }
    if (span.blockId !== blockId) {
      return fail('VALIDATION_FAILED', `span "${span.spanId}" must belong to block "${blockId}".`);
    }
    if (seenSpanIds.has(span.spanId)) {
      return fail('VALIDATION_FAILED', `duplicate spanId "${span.spanId}" in block "${blockId}".`);
    }
    seenSpanIds.add(span.spanId);
    prevEnd = span.end;
  }
  if (prevEnd !== text.length) {
    return fail(
      'VALIDATION_FAILED',
      `spans must cover the block text exactly (covered 0..${prevEnd} of ${text.length}).`,
    );
  }
  const block: Block = {
    blockId,
    kind: kind as BlockKind,
    part: part as DocumentPart,
    index,
    styleFingerprint,
    sourceHash,
    text,
    spans,
  };
  const level = num(v.level);
  if (level !== undefined) block.level = level;
  const page = num(v.page);
  if (page !== undefined) block.page = page;
  return { ok: true, value: block };
}

function validateWarning(v: unknown): ValidationOk<PreflightWarning> | ValidationErr {
  if (!isPlainObject(v)) return fail('VALIDATION_FAILED', 'Warning must be an object.');
  const code = str(v.code);
  if (!code) return fail('VALIDATION_FAILED', 'warning.code is required.');
  const message = str(v.message);
  if (!message) return fail('VALIDATION_FAILED', 'warning.message is required.');
  const severity = str(v.severity);
  if (severity !== 'info' && severity !== 'warning' && severity !== 'error') {
    return fail('VALIDATION_FAILED', `warning.severity invalid: ${severity}`);
  }
  return { ok: true, value: { code, message, severity: severity as WarningSeverity } };
}

function validatePreflight(v: unknown): ValidationOk<PreflightReport> | ValidationErr {
  if (!isPlainObject(v)) return fail('VALIDATION_FAILED', 'preflight must be an object.');
  const format = str(v.format);
  if (!format || !DOCUMENT_FORMATS.includes(format as DocumentFormat)) {
    return fail('VALIDATION_FAILED', `preflight.format invalid: ${format}`);
  }
  const sizeBytes = num(v.sizeBytes);
  if (sizeBytes === undefined) return fail('VALIDATION_FAILED', 'preflight.sizeBytes required.');
  const sourceHash = str(v.sourceHash);
  if (!sourceHash) return fail('VALIDATION_FAILED', 'preflight.sourceHash required.');
  const words = num(v.words);
  if (words === undefined) return fail('VALIDATION_FAILED', 'preflight.words required.');
  const sections = num(v.sections);
  if (sections === undefined) return fail('VALIDATION_FAILED', 'preflight.sections required.');
  const blocks = num(v.blocks);
  if (blocks === undefined) return fail('VALIDATION_FAILED', 'preflight.blocks required.');
  const canImport = bool(v.canImport);
  if (canImport === undefined) return fail('VALIDATION_FAILED', 'preflight.canImport required.');
  const protectedContent = bool(v.protectedContent);
  if (protectedContent === undefined) {
    return fail('VALIDATION_FAILED', 'preflight.protectedContent required.');
  }
  const accuracy = str(v.extractionAccuracy);
  if (accuracy !== 'high' && accuracy !== 'partial' && accuracy !== 'low' && accuracy !== 'unknown') {
    return fail('VALIDATION_FAILED', `preflight.extractionAccuracy invalid: ${accuracy}`);
  }
  if (!Array.isArray(v.warnings)) return fail('VALIDATION_FAILED', 'preflight.warnings required.');
  const warnings: PreflightWarning[] = [];
  for (const w of v.warnings) {
    const r = validateWarning(w);
    if (!r.ok) return r;
    warnings.push(r.value);
  }
  const limits = isPlainObject(v.limits) ? v.limits : null;
  if (!limits) return fail('VALIDATION_FAILED', 'preflight.limits required.');
  const limitBytes = num(limits.sizeBytesLimit);
  if (limitBytes === undefined) return fail('VALIDATION_FAILED', 'preflight.limits.sizeBytesLimit required.');
  const exceeded = bool(limits.exceeded);
  if (exceeded === undefined) return fail('VALIDATION_FAILED', 'preflight.limits.exceeded required.');
  const report: PreflightReport = {
    format: format as DocumentFormat,
    sizeBytes,
    sourceHash,
    words,
    sections,
    blocks,
    canImport,
    protectedContent,
    extractionAccuracy: accuracy as ExtractionAccuracy,
    warnings,
    limits: { sizeBytesLimit: limitBytes, exceeded },
  };
  const pages = num(v.pages);
  if (pages !== undefined) report.pages = pages;
  return { ok: true, value: report };
}

/**
 * Validate (and structurally normalize) an unknown value as a strict
 * `NormalizedDocument`. Returns a normalized instance on success so callers
 * always hold the canonical shape.
 */
export function validateNormalizedDocument(raw: unknown): DocumentValidationResult {
  if (!isPlainObject(raw)) {
    return fail('VALIDATION_FAILED', 'NormalizedDocument must be an object.');
  }
  const declared = num(raw.schemaVersion);
  if (declared !== DOCUMENT_SCHEMA_VERSION) {
    return fail(
      'VALIDATION_FAILED',
      `Unsupported document schemaVersion: expected ${DOCUMENT_SCHEMA_VERSION}, got ${declared}`,
    );
  }
  const format = str(raw.format);
  if (!format || !DOCUMENT_FORMATS.includes(format as DocumentFormat)) {
    return fail('VALIDATION_FAILED', `document.format invalid: ${format}`);
  }
  const title = str(raw.title);
  if (title === undefined) return fail('VALIDATION_FAILED', 'document.title required.');
  const asset = isPlainObject(raw.sourceAsset) ? raw.sourceAsset : null;
  if (!asset) return fail('VALIDATION_FAILED', 'document.sourceAsset required.');
  const ref = str(asset.ref);
  const hash = str(asset.hash);
  const sizeBytes = num(asset.sizeBytes);
  const fileName = str(asset.fileName);
  if (!ref || !hash || sizeBytes === undefined || !fileName) {
    return fail('VALIDATION_FAILED', 'document.sourceAsset missing required fields.');
  }
  const preflight = validatePreflight(raw.preflight);
  if (!preflight.ok) return preflight;
  if (!Array.isArray(raw.blocks)) return fail('VALIDATION_FAILED', 'document.blocks required.');
  const blocks: Block[] = [];
  for (const b of raw.blocks) {
    const r = validateBlock(b);
    if (!r.ok) return r;
    blocks.push(r.value);
  }
  if (!Array.isArray(raw.chunkPlans)) {
    return fail('VALIDATION_FAILED', 'document.chunkPlans must be an array.');
  }
  if (!isPlainObject(raw.translations)) {
    return fail('VALIDATION_FAILED', 'document.translations must be an object.');
  }
  return {
    ok: true,
    value: {
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      format: format as DocumentFormat,
      title,
      sourceAsset: { ref, hash, sizeBytes, fileName },
      preflight: preflight.value,
      blocks,
      chunkPlans: [],
      translations: {},
    },
  };
}

/** Type guard: true iff `raw` is a structurally valid normalized document. */
export function isNormalizedDocument(raw: unknown): raw is NormalizedDocument {
  return validateNormalizedDocument(raw).ok;
}

// ============================================================================
// DOC-02 — Document project persistence (plan §10.4, §10.5, §10.9, §10.11)
// ============================================================================

/** Current document archive schema version. Bump on shape change. */
export const DOCUMENT_ARCHIVE_SCHEMA_VERSION = 1 as const;
export type DocumentArchiveSchemaVersion = typeof DOCUMENT_ARCHIVE_SCHEMA_VERSION;

/** Current per-language translation archive schema version. */
export const TRANSLATION_ARCHIVE_SCHEMA_VERSION = 1 as const;
export type TranslationArchiveSchemaVersion = typeof TRANSLATION_ARCHIVE_SCHEMA_VERSION;

/**
 * Translation/protection policy for a block or span (plan §10.4). Absent
 * policy means `translate`; `protect` marks content that must never be sent
 * to a provider.
 */
export interface TranslationPolicy {
  action: 'translate' | 'protect';
  /** Optional human-readable reason (editor tooltip). */
  note?: string;
}

/** Review/approval state of one block translation (plan §10.4). */
export type TranslationStatus = 'draft' | 'needs-review' | 'approved';

/**
 * Provenance recorded once per language variant (plan §10.5): every variant
 * knows exactly how it was produced so retranslation and audit decisions are
 * reproducible. The record is ALWAYS complete: validators normalize absent
 * `model`/`profile`/`promptVersion`/`glossaryRevision` values to the
 * explicit `'unknown'` sentinel (see `UNKNOWN_PROVENANCE`) rather than
 * leaving holes in the audit trail.
 */
export interface LanguageVariantMeta {
  provider: string;
  /** Model id used; `'unknown'` when not recorded. */
  model: string;
  /** Provider profile used; `'unknown'` when not recorded. */
  profile: string;
  /** Prompt version used; `'unknown'` when not recorded. */
  promptVersion: string;
  /** Glossary revision used; `'unknown'` when not recorded. */
  glossaryRevision: string;
  /**
   * Canonical SHA-256 hex (lowercase, 64 chars) of the document source state
   * the variant was created against.
   */
  sourceHash: string;
}

/** One block's translation inside a language variant. */
export interface BlockTranslation {
  blockId: string;
  /** Current translated text of the block. */
  text: string;
  /**
   * Canonical SHA-256 hex (lowercase, 64 chars) of the source block text at
   * translation time. Freshness is computed by comparing this against the
   * hash of the current block text (§10.9): a source edit flips only the
   * affected blocks stale and never deletes the translation (editor
   * invariant #4).
   */
  sourceHash: string;
  status: TranslationStatus;
  updatedAt: string;
}

/**
 * Persisted document project state — one `document.json` inside the project
 * directory, written under the project v3 store's atomic/revision discipline.
 * Captures the normalized import plus everything the editorial lane mutates:
 * working-copy blocks, per-block edit baselines, protection policies and the
 * undo recovery boundary. Language variants live in sibling per-BCP-47 files.
 */
export interface DocumentArchive {
  schemaVersion: DocumentArchiveSchemaVersion;
  projectId: string;
  format: DocumentFormat;
  title: string;
  /** Immutable original asset reference (plan §10.4, invariant #6). */
  sourceAsset: SourceAssetRef;
  /** Preflight metadata/warnings captured at import time (plan §10.4). */
  preflight: PreflightReport;
  /** Working-copy blocks: stable blockIds preserved, user edits applied. */
  blocks: Block[];
  /**
   * Imported baseline kept for every user-modified block, keyed by blockId.
   * First edit wins: the baseline is the block exactly as imported, so later
   * merges/reports can diff against the true original.
   */
  editBaselines: Record<string, Block>;
  /** Per-block policy overrides; absent means `translate`. */
  blockPolicies: Record<string, TranslationPolicy>;
  /** Per-span policy overrides; absent means inherit the block policy. */
  spanPolicies: Record<string, TranslationPolicy>;
  /**
   * Monotonic counter bumped by every persisted source edit. Reopen restores
   * this value; undo history before it is the recovery boundary (§10.11) —
   * the editor starts a fresh undo stack anchored here.
   */
  editEpoch: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Per-language translation archive (`translations/<language>.json`), keyed by
 * the normalized BCP-47 tag, which is also the file stem. Adding a language
 * creates a NEW archive and never mutates existing ones (plan §10.5).
 */
export interface TranslationArchive {
  schemaVersion: TranslationArchiveSchemaVersion;
  projectId: string;
  /** Canonical (normalized) BCP-47 tag; also the archive file stem. */
  language: string;
  meta: LanguageVariantMeta;
  /** Block translations keyed by blockId (`entry.blockId === key`). */
  blocks: Record<string, BlockTranslation>;
  createdAt: string;
  updatedAt: string;
}

export type BlockFreshness = 'missing' | 'stale' | 'fresh';

/** Per-block review filter entry (plan §10.9: All / Needs Review / Stale / Approved). */
export interface BlockFreshnessInfo {
  freshness: BlockFreshness;
  status: TranslationStatus | 'missing';
}

/** Computed freshness/approval summary for one language variant (§10.9). */
export interface FreshnessReport {
  language: string;
  totalBlocks: number;
  translated: number;
  fresh: number;
  stale: number;
  missing: number;
  approved: number;
  needsReview: number;
  /** Detail per blockId for review filters and navigation highlights. */
  blocks: Record<string, BlockFreshnessInfo>;
}

/** Sentinel persisted when a provenance field was not recorded. */
export const UNKNOWN_PROVENANCE = 'unknown' as const;

const CANONICAL_SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** True iff `value` is a canonical lowercase 64-char hex SHA-256 digest. */
export function isCanonicalSha256(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_SHA256_PATTERN.test(value);
}

/** Result of structurally validating an unknown value as a document archive. */
export type DocumentArchiveValidationResult = ValidationOk<DocumentArchive> | ValidationErr;

/** Result of structurally validating an unknown value as a translation archive. */
export type TranslationValidationResult = ValidationOk<TranslationArchive> | ValidationErr;

/**
 * Structural tag pattern. One deliberate extension over the plain regular
 * grammar: the private-use singleton `x` is accepted as the FIRST subtag so
 * whole-tag private-use forms (`x-private`) normalize like any other tag.
 * Underscores are never accepted — callers must convert `_`-separated aliases
 * to `-` before calling; `normalizeBcp47('en_US')` returns `null`.
 */
const BCP47_TAG_PATTERN = /^(?:[A-Za-z]{2,8}|[Xx])(?:-[A-Za-z0-9]{1,8})*$/;

/**
 * Normalize a BCP-47 language tag to canonical case, context-aware per
 * RFC 5646 §2.1: primary language lowercase; script subtags Titlecase;
 * alpha-2 region subtags uppercase; everything after an extension singleton
 * (`u`, `t`, ...) or the private-use singleton `x` lowercase — extension
 * keys AND their subtags carry no uppercase (so `en-U-CA-Gregory` and
 * `en-u-ca-gregory` both normalize to `en-u-ca-gregory`); variants and
 * numeric regions normalize to their inherent case.
 *
 * Grandfathered tags are not special-cased: irregular `i-*` forms fail the
 * structural pattern and return `null`; legacy tags that happen to match the
 * regular grammar (`sgn-BE-FR`, `art-lojban`, ...) pass through the normal
 * rules stably. Callers should canonicalize truly legacy tags upstream (e.g.
 * `Intl.getCanonicalLocales`).
 *
 * Returns `null` for structurally invalid tags. The normalized tag is the
 * translation archive key and file stem, so it is restricted to characters
 * that are safe in a file name.
 */
export function normalizeBcp47(tag: string): string | null {
  if (typeof tag !== 'string' || !BCP47_TAG_PATTERN.test(tag)) return null;
  const out: string[] = [];
  const subtags = tag.split('-');
  // Parsing context: 'lang' until an extension/private-use singleton flips
  // the remainder of the tag into case-insensitive territory.
  let context = 'lang';
  for (let i = 0; i < subtags.length; i++) {
    const s = subtags[i];
    if (i === 0) {
      // Primary language subtag — or a whole-tag private-use marker, which
      // puts the remainder into case-insensitive territory.
      out.push(s.toLowerCase());
      if (s.toLowerCase() === 'x') context = 'privateuse';
      continue;
    }
    if (s.length === 1) {
      // Singleton subtag: extension key or private-use marker.
      out.push(s.toLowerCase());
      context = s.toLowerCase() === 'x' ? 'privateuse' : 'extension';
      continue;
    }
    if (context !== 'lang') {
      // Extension keys/subtags and private-use subtags are lowercase.
      out.push(s.toLowerCase());
      continue;
    }
    if (s.length === 4 && /^[A-Za-z]{4}$/.test(s)) {
      // Script subtag: Titlecase.
      out.push(s[0].toUpperCase() + s.slice(1).toLowerCase());
    } else if (s.length === 2 && /^[A-Za-z]{2}$/.test(s)) {
      // Alpha-2 region subtag: uppercase.
      out.push(s.toUpperCase());
    } else {
      // Variants (5-8 alphanumerics or 4 starting with a digit) and numeric
      // regions have no upper case — normalized lowercase.
      out.push(s.toLowerCase());
    }
  }
  return out.join('-');
}

function validatePolicy(v: unknown): ValidationOk<TranslationPolicy> | ValidationErr {
  if (!isPlainObject(v)) return fail('VALIDATION_FAILED', 'Policy must be an object.');
  const action = str(v.action);
  if (action !== 'translate' && action !== 'protect') {
    return fail('VALIDATION_FAILED', `policy.action invalid: ${action}`);
  }
  const policy: TranslationPolicy = { action };
  const note = str(v.note);
  if (note !== undefined) policy.note = note;
  return { ok: true, value: policy };
}

function validatePolicyRecord(
  v: unknown,
  label: string,
): ValidationOk<Record<string, TranslationPolicy>> | ValidationErr {
  if (!isPlainObject(v)) return fail('VALIDATION_FAILED', `${label} must be an object.`);
  const out: Record<string, TranslationPolicy> = {};
  for (const [key, value] of Object.entries(v)) {
    if (!key) return fail('VALIDATION_FAILED', `${label} has an empty key.`);
    const r = validatePolicy(value);
    if (!r.ok) return fail('VALIDATION_FAILED', `${label}[${key}]: ${r.error.message}`);
    out[key] = r.value;
  }
  return { ok: true, value: out };
}

function validateBlockRecord(
  v: unknown,
  label: string,
): ValidationOk<Record<string, Block>> | ValidationErr {
  if (!isPlainObject(v)) return fail('VALIDATION_FAILED', `${label} must be an object.`);
  const out: Record<string, Block> = {};
  for (const [key, value] of Object.entries(v)) {
    if (!key) return fail('VALIDATION_FAILED', `${label} has an empty key.`);
    const r = validateBlock(value);
    if (!r.ok) return fail('VALIDATION_FAILED', `${label}[${key}]: ${r.error.message}`);
    out[key] = r.value;
  }
  return { ok: true, value: out };
}

function validateSourceAsset(v: unknown): ValidationOk<SourceAssetRef> | ValidationErr {
  if (!isPlainObject(v)) return fail('VALIDATION_FAILED', 'sourceAsset must be an object.');
  const ref = str(v.ref);
  const hash = str(v.hash);
  const sizeBytes = num(v.sizeBytes);
  const fileName = str(v.fileName);
  if (!ref || !hash || sizeBytes === undefined || !fileName) {
    return fail('VALIDATION_FAILED', 'sourceAsset missing required fields.');
  }
  return { ok: true, value: { ref, hash, sizeBytes, fileName } };
}

/**
 * Validate (and structurally normalize) an unknown value as a strict
 * `DocumentArchive`. Block IDs must be unique; timestamps and IDs non-empty.
 */
export function validateDocumentArchive(raw: unknown): DocumentArchiveValidationResult {
  if (!isPlainObject(raw)) {
    return fail('VALIDATION_FAILED', 'DocumentArchive must be an object.');
  }
  const declared = num(raw.schemaVersion);
  if (declared !== DOCUMENT_ARCHIVE_SCHEMA_VERSION) {
    return fail(
      'VALIDATION_FAILED',
      `Unsupported document archive schemaVersion: expected ${DOCUMENT_ARCHIVE_SCHEMA_VERSION}, got ${declared}`,
    );
  }
  const projectId = str(raw.projectId);
  if (!projectId) return fail('VALIDATION_FAILED', 'archive.projectId is required.');
  const format = str(raw.format);
  if (!format || !DOCUMENT_FORMATS.includes(format as DocumentFormat)) {
    return fail('VALIDATION_FAILED', `archive.format invalid: ${format}`);
  }
  const title = str(raw.title);
  if (!title) return fail('VALIDATION_FAILED', 'archive.title is required.');
  const sourceAsset = validateSourceAsset(raw.sourceAsset);
  if (!sourceAsset.ok) return sourceAsset;
  const preflight = validatePreflight(raw.preflight);
  if (!preflight.ok) return preflight;
  if (!Array.isArray(raw.blocks)) return fail('VALIDATION_FAILED', 'archive.blocks must be an array.');
  const blocks: Block[] = [];
  const seen = new Set<string>();
  for (const b of raw.blocks) {
    const r = validateBlock(b);
    if (!r.ok) return r;
    if (seen.has(r.value.blockId)) {
      return fail('VALIDATION_FAILED', `archive.blocks contains duplicate blockId "${r.value.blockId}".`);
    }
    seen.add(r.value.blockId);
    blocks.push(r.value);
  }
  const editBaselines = validateBlockRecord(raw.editBaselines, 'archive.editBaselines');
  if (!editBaselines.ok) return editBaselines;
  const blockPolicies = validatePolicyRecord(raw.blockPolicies, 'archive.blockPolicies');
  if (!blockPolicies.ok) return blockPolicies;
  const spanPolicies = validatePolicyRecord(raw.spanPolicies, 'archive.spanPolicies');
  if (!spanPolicies.ok) return spanPolicies;
  const editEpoch = num(raw.editEpoch);
  if (editEpoch === undefined || !Number.isInteger(editEpoch) || editEpoch < 0) {
    return fail('VALIDATION_FAILED', 'archive.editEpoch must be a non-negative integer.');
  }
  const createdAt = str(raw.createdAt);
  if (!createdAt) return fail('VALIDATION_FAILED', 'archive.createdAt is required.');
  const updatedAt = str(raw.updatedAt);
  if (!updatedAt) return fail('VALIDATION_FAILED', 'archive.updatedAt is required.');
  return {
    ok: true,
    value: {
      schemaVersion: DOCUMENT_ARCHIVE_SCHEMA_VERSION,
      projectId,
      format: format as DocumentFormat,
      title,
      sourceAsset: sourceAsset.value,
      preflight: preflight.value,
      blocks,
      editBaselines: editBaselines.value,
      blockPolicies: blockPolicies.value,
      spanPolicies: spanPolicies.value,
      editEpoch,
      createdAt,
      updatedAt,
    },
  };
}

/** Type guard: true iff `raw` is a structurally valid document archive. */
export function isDocumentArchive(raw: unknown): raw is DocumentArchive {
  return validateDocumentArchive(raw).ok;
}

function validateLanguageVariantMeta(
  v: unknown,
): ValidationOk<LanguageVariantMeta> | ValidationErr {
  if (!isPlainObject(v)) return fail('VALIDATION_FAILED', 'meta must be an object.');
  const provider = str(v.provider);
  if (!provider) return fail('VALIDATION_FAILED', 'meta.provider is required.');
  const sourceHash = str(v.sourceHash);
  if (!sourceHash) return fail('VALIDATION_FAILED', 'meta.sourceHash is required.');
  if (!isCanonicalSha256(sourceHash)) {
    return fail(
      'VALIDATION_FAILED',
      'meta.sourceHash must be a canonical SHA-256 digest (lowercase 64-char hex).',
    );
  }
  // Provenance completeness (plan §10.5): unrecorded fields persist as the
  // explicit 'unknown' sentinel instead of leaving the audit trail holey.
  const meta: LanguageVariantMeta = { provider, sourceHash } as LanguageVariantMeta;
  for (const key of ['model', 'profile', 'promptVersion', 'glossaryRevision'] as const) {
    const value = v[key];
    if (value === undefined || value === null) {
      meta[key] = UNKNOWN_PROVENANCE;
      continue;
    }
    const s = str(value);
    if (!s) {
      return fail('VALIDATION_FAILED', `meta.${key} must be a non-empty string when recorded.`);
    }
    meta[key] = s;
  }
  return { ok: true, value: meta };
}

function validateBlockTranslation(
  v: unknown,
  key: string,
): ValidationOk<BlockTranslation> | ValidationErr {
  if (!isPlainObject(v)) return fail('VALIDATION_FAILED', 'Block translation must be an object.');
  const blockId = str(v.blockId);
  if (!blockId) return fail('VALIDATION_FAILED', 'translation.blockId is required.');
  if (blockId !== key) {
    return fail('VALIDATION_FAILED', `translation key "${key}" does not match blockId "${blockId}".`);
  }
  const text = str(v.text);
  if (text === undefined) return fail('VALIDATION_FAILED', 'translation.text is required.');
  const sourceHash = str(v.sourceHash);
  if (!sourceHash) return fail('VALIDATION_FAILED', 'translation.sourceHash is required.');
  if (!isCanonicalSha256(sourceHash)) {
    return fail(
      'VALIDATION_FAILED',
      'translation.sourceHash must be a canonical SHA-256 digest (lowercase 64-char hex).',
    );
  }
  const status = str(v.status);
  if (status !== 'draft' && status !== 'needs-review' && status !== 'approved') {
    return fail('VALIDATION_FAILED', `translation.status invalid: ${status}`);
  }
  const updatedAt = str(v.updatedAt);
  if (!updatedAt) return fail('VALIDATION_FAILED', 'translation.updatedAt is required.');
  return {
    ok: true,
    value: { blockId, text, sourceHash, status: status as TranslationStatus, updatedAt },
  };
}

/**
 * Validate (and structurally normalize) an unknown value as a strict
 * `TranslationArchive`. The language tag must already be in normalized
 * (canonical) form — producers run `normalizeBcp47` first.
 */
export function validateTranslationArchive(raw: unknown): TranslationValidationResult {
  if (!isPlainObject(raw)) {
    return fail('VALIDATION_FAILED', 'TranslationArchive must be an object.');
  }
  const declared = num(raw.schemaVersion);
  if (declared !== TRANSLATION_ARCHIVE_SCHEMA_VERSION) {
    return fail(
      'VALIDATION_FAILED',
      `Unsupported translation archive schemaVersion: expected ${TRANSLATION_ARCHIVE_SCHEMA_VERSION}, got ${declared}`,
    );
  }
  const projectId = str(raw.projectId);
  if (!projectId) return fail('VALIDATION_FAILED', 'translation archive.projectId is required.');
  const language = str(raw.language);
  if (!language) return fail('VALIDATION_FAILED', 'translation archive.language is required.');
  if (normalizeBcp47(language) !== language) {
    return fail(
      'VALIDATION_FAILED',
      `translation archive.language must be a normalized BCP-47 tag, got "${language}".`,
    );
  }
  const meta = validateLanguageVariantMeta(raw.meta);
  if (!meta.ok) return meta;
  if (!isPlainObject(raw.blocks)) {
    return fail('VALIDATION_FAILED', 'translation archive.blocks must be an object.');
  }
  const blocks: Record<string, BlockTranslation> = {};
  for (const [key, value] of Object.entries(raw.blocks)) {
    const r = validateBlockTranslation(value, key);
    if (!r.ok) return r;
    blocks[key] = r.value;
  }
  const createdAt = str(raw.createdAt);
  if (!createdAt) return fail('VALIDATION_FAILED', 'translation archive.createdAt is required.');
  const updatedAt = str(raw.updatedAt);
  if (!updatedAt) return fail('VALIDATION_FAILED', 'translation archive.updatedAt is required.');
  return {
    ok: true,
    value: {
      schemaVersion: TRANSLATION_ARCHIVE_SCHEMA_VERSION,
      projectId,
      language,
      meta: meta.value,
      blocks,
      createdAt,
      updatedAt,
    },
  };
}

/** Type guard: true iff `raw` is a structurally valid translation archive. */
export function isTranslationArchive(raw: unknown): raw is TranslationArchive {
  return validateTranslationArchive(raw).ok;
}

// ============================================================================
// DOC-03 — Semantic chunk planning (plan §10.4, §10.6, §20)
// ============================================================================

/** Current chunk-plan schema version. Bump on shape change. */
export const CHUNK_PLAN_SCHEMA_VERSION = 1 as const;
export type ChunkPlanSchemaVersion = typeof CHUNK_PLAN_SCHEMA_VERSION;

/**
 * Planner options (plan §10.4). Both fields are optional; omitted fields
 * take `DEFAULT_CHUNK_PLANNER_OPTIONS`. Options are deterministic inputs:
 * the same document plus the same options MUST always produce the identical
 * chunk plan (§20 acceptance: stable plans, deterministic fixtures).
 */
export interface ChunkPlannerOptions {
  /**
   * Target maximum tokens per chunk. A chunk MAY exceed this only in the
   * documented overflow cases: it contains an unsplittable atomic unit (a
   * table group, a verse/list/code block, or one sentence longer than the
   * budget) — possibly together with its bound leading heading(s) — or the
   * chunk opens with a bound heading that has exhausted the budget, so the
   * section's FIRST prose piece glues onto it anyway (a heading is never
   * left alone in a non-final chunk).
   */
  maxTokensPerChunk?: number;
  /** Maximum characters of rolling context captured before/after a chunk. */
  contextChars?: number;
}

/** Planner options after defaults have been applied and validated. */
export interface ResolvedChunkPlannerOptions {
  maxTokensPerChunk: number;
  contextChars: number;
}

/**
 * Documented planner defaults. `maxTokensPerChunk: 800` targets typical
 * translation-provider request budgets (~4 chars/token heuristic below);
 * `contextChars: 400` bounds the rolling context window to roughly one
 * paragraph on each side. Frozen at runtime so a stray write cannot corrupt
 * shared defaults — strict-mode callers (ES modules, `'use strict'`) throw
 * `TypeError` on assignment instead of silently mutating every future plan.
 */
export const DEFAULT_CHUNK_PLANNER_OPTIONS: Readonly<ResolvedChunkPlannerOptions> = Object.freeze({
  maxTokensPerChunk: 800,
  contextChars: 400,
});

/**
 * One ordered reference into a block (plan §10.4 "block slices"). Slices are
 * references into the normalized document, never text copies: consumers read
 * text via `block.text.slice(charStart, charEnd)` over UTF-16 code units.
 * A block that was split across chunks contributes several slices whose
 * ranges partition `[0, block.text.length)` in order.
 */
export interface BlockSlice {
  blockId: string;
  /** Inclusive start offset within the owning block's text. */
  charStart: number;
  /** Exclusive end offset within the owning block's text. */
  charEnd: number;
  /**
   * Deterministic token estimate for this slice's text:
   * `text.length === 0 ? 0 : Math.ceil(text.length / 4)`.
   */
  tokenEstimate: number;
}

/**
 * Canonical, injective serialization of a chunk's member slices for chunkId
 * derivation (DOC-03). Each slice encodes as
 * `${blockId.length}:${blockId}:${charStart}:${charEnd}` and the slices join
 * with `,`, prefixed by the schema version. Length-prefixing `blockId` makes
 * the encoding unambiguous for ANY legal blockId: `,` and `:` inside an id
 * cannot alias one slice onto two (the earlier naive `id:start:end` join was
 * not injective — `"A:0:1,B:0:4"` parsed as either one slice of block
 * `"A:0:1,B"` or two slices of `"A"`/`"B"`).
 */
export function canonicalChunkSeed(
  slices: ReadonlyArray<Pick<BlockSlice, 'blockId' | 'charStart' | 'charEnd'>>,
): string {
  return `${CHUNK_PLAN_SCHEMA_VERSION}|${slices
    .map((s) => `${s.blockId.length}:${s.blockId}:${s.charStart}:${s.charEnd}`)
    .join(',')}`;
}

/**
 * Derive a `PlanChunk.chunkId` from its slices: `"c-"` + the first 16
 * lowercase hex digits of SHA-256 over `canonicalChunkSeed(slices)`. Single
 * source of truth for the derivation — the planner (DOC-03) and
 * `validateChunkPlanAgainstSource` both call this. Node-crypto based;
 * main/worker-side only (renderer consumers use the types, not this).
 */
export function deriveChunkPlanId(
  slices: ReadonlyArray<Pick<BlockSlice, 'blockId' | 'charStart' | 'charEnd'>>,
): string {
  return `c-${createHash('sha256').update(canonicalChunkSeed(slices)).digest('hex').slice(0, 16)}`;
}

/**
 * One translatable unit (plan §10.4 "semantic chunk plans with context
 * before/after, token estimate and block slices"; consumed by the DOC-04
 * translation coordinator, which commits per chunk and reports progress
 * over chunks/blocks/tokens, plan §10.6).
 */
export interface PlanChunk {
  /**
   * Stable, content-derived id: `"c-"` + the first 16 lowercase hex digits
   * of SHA-256 over `canonicalChunkSeed(slices)` — the injective
   * length-prefixed encoding
   * `"${CHUNK_PLAN_SCHEMA_VERSION}|${slices.map((s) =>
   * `${s.blockId.length}:${s.blockId}:${s.charStart}:${s.charEnd}`).join(',')}"`.
   *
   * The id depends ONLY on member slice ids/ranges — never on array
   * position, document length, wording, or timestamps. Re-deriving a plan
   * for the same document version therefore reproduces ids byte-identically,
   * and chunks whose membership+ranges survive a nearby edit keep their id
   * even when their ordinal shifts. Stability is RANGE-based, not
   * content-based: an edit that changes a block's text LENGTH shifts some
   * slice's charStart/charEnd (and every later offset in that block) and
   * therefore re-derives the affected ids, while a same-length wording edit
   * inside an unchanged range keeps every id. Content staleness itself is
   * tracked per block via source hashes (DOC-02 freshness), not via chunk
   * ids. Plans are derived state, never persisted truth.
   */
  chunkId: string;
  /** Ordered block slices covering this chunk's source text. */
  slices: BlockSlice[];
  /** Exactly the sum of the member slices' `tokenEstimate`s. */
  tokenEstimate: number;
  /**
   * Rolling context from neighboring blocks before this chunk ('' at the
   * document start), at most `options.contextChars` characters, taken from
   * the nearest preceding slices (whole segments first, then a partial cut).
   */
  contextBefore: string;
  /** Rolling context after this chunk ('' at the document end). */
  contextAfter: string;
}

/**
 * A semantic chunk plan for one normalized document (DOC-03 output, plan
 * §10.4). Plans are pure derived state: recomputable at any time from the
 * normalized blocks plus options, so they are never persisted inside the
 * document archive (`NormalizedDocument.chunkPlans` stays reserved).
 */
export interface ChunkPlan {
  schemaVersion: ChunkPlanSchemaVersion;
  /** Resolved options this plan was produced with (echoed for consumers). */
  options: ResolvedChunkPlannerOptions;
  chunks: PlanChunk[];
}

export type ChunkPlanValidationResult = ValidationOk<ChunkPlan> | ValidationErr;

function validateBlockSlice(v: unknown): ValidationOk<BlockSlice> | ValidationErr {
  if (!isPlainObject(v)) return fail('VALIDATION_FAILED', 'BlockSlice must be an object.');
  const blockId = str(v.blockId);
  if (!blockId) return fail('VALIDATION_FAILED', 'slice.blockId is required.');
  const charStart = num(v.charStart);
  const charEnd = num(v.charEnd);
  if (
    charStart === undefined ||
    charEnd === undefined ||
    !Number.isInteger(charStart) ||
    !Number.isInteger(charEnd)
  ) {
    return fail('VALIDATION_FAILED', 'slice.charStart/charEnd must be integers.');
  }
  if (charStart < 0 || charEnd < charStart) {
    return fail('VALIDATION_FAILED', 'slice range must satisfy 0 <= charStart <= charEnd.');
  }
  const tokenEstimate = num(v.tokenEstimate);
  if (tokenEstimate === undefined || !Number.isInteger(tokenEstimate) || tokenEstimate < 0) {
    return fail('VALIDATION_FAILED', 'slice.tokenEstimate must be a non-negative integer.');
  }
  return { ok: true, value: { blockId, charStart, charEnd, tokenEstimate } };
}

function validateResolvedPlannerOptions(v: unknown): ValidationOk<ResolvedChunkPlannerOptions> | ValidationErr {
  if (!isPlainObject(v)) return fail('VALIDATION_FAILED', 'chunk plan.options must be an object.');
  const maxTokensPerChunk = num(v.maxTokensPerChunk);
  if (maxTokensPerChunk === undefined || !Number.isInteger(maxTokensPerChunk) || maxTokensPerChunk < 1) {
    return fail('VALIDATION_FAILED', 'options.maxTokensPerChunk must be an integer >= 1.');
  }
  const contextChars = num(v.contextChars);
  if (contextChars === undefined || !Number.isInteger(contextChars) || contextChars < 0) {
    return fail('VALIDATION_FAILED', 'options.contextChars must be an integer >= 0.');
  }
  return { ok: true, value: { maxTokensPerChunk, contextChars } };
}

/**
 * Validate (and structurally normalize) an unknown value as a strict
 * `ChunkPlan`: unique chunkIds, per-chunk token sums reconciled with their
 * slices, and contexts bounded by the echoed `options.contextChars`.
 *
 * STRUCTURAL ONLY: this proves the plan is internally well-formed. It does
 * NOT tie the slices to any source document — an arbitrary or wrongly
 * derived chunkId, or a slice pointing at a block that does not exist,
 * passes here. At the DOC-04 boundary, pair it with
 * `validateChunkPlanAgainstSource(plan, document)`, which proves the plan
 * was actually derived from its normalized source.
 */
export function validateChunkPlan(raw: unknown): ChunkPlanValidationResult {
  if (!isPlainObject(raw)) {
    return fail('VALIDATION_FAILED', 'ChunkPlan must be an object.');
  }
  const declared = num(raw.schemaVersion);
  if (declared !== CHUNK_PLAN_SCHEMA_VERSION) {
    return fail(
      'VALIDATION_FAILED',
      `chunk plan.schemaVersion ${declared} !== ${CHUNK_PLAN_SCHEMA_VERSION}.`,
    );
  }
  const options = validateResolvedPlannerOptions(raw.options);
  if (!options.ok) return options;
  if (!Array.isArray(raw.chunks)) return fail('VALIDATION_FAILED', 'chunk plan.chunks must be an array.');
  const seenIds = new Set<string>();
  const chunks: PlanChunk[] = [];
  for (const c of raw.chunks) {
    if (!isPlainObject(c)) return fail('VALIDATION_FAILED', 'PlanChunk must be an object.');
    const chunkId = str(c.chunkId);
    if (!chunkId) return fail('VALIDATION_FAILED', 'chunk.chunkId is required.');
    if (seenIds.has(chunkId)) {
      return fail('VALIDATION_FAILED', `duplicate chunkId "${chunkId}".`);
    }
    seenIds.add(chunkId);
    if (!Array.isArray(c.slices)) return fail('VALIDATION_FAILED', 'chunk.slices must be an array.');
    if (c.slices.length === 0) return fail('VALIDATION_FAILED', 'chunk.slices must not be empty.');
    const slices: BlockSlice[] = [];
    let tokenSum = 0;
    for (const s of c.slices) {
      const r = validateBlockSlice(s);
      if (!r.ok) return r;
      tokenSum += r.value.tokenEstimate;
      slices.push(r.value);
    }
    const tokenEstimate = num(c.tokenEstimate);
    if (tokenEstimate === undefined || !Number.isInteger(tokenEstimate) || tokenEstimate < 0) {
      return fail('VALIDATION_FAILED', 'chunk.tokenEstimate must be a non-negative integer.');
    }
    if (tokenEstimate !== tokenSum) {
      return fail('VALIDATION_FAILED', `chunk "${chunkId}".tokenEstimate does not equal its slice sum.`);
    }
    const contextBefore = str(c.contextBefore);
    const contextAfter = str(c.contextAfter);
    if (contextBefore === undefined || contextAfter === undefined) {
      return fail('VALIDATION_FAILED', 'chunk.contextBefore/contextAfter must be strings.');
    }
    if (contextBefore.length > options.value.contextChars || contextAfter.length > options.value.contextChars) {
      return fail('VALIDATION_FAILED', `chunk "${chunkId}" context exceeds options.contextChars.`);
    }
    chunks.push({ chunkId, slices, tokenEstimate, contextBefore, contextAfter });
  }
  return { ok: true, value: { schemaVersion: CHUNK_PLAN_SCHEMA_VERSION, options: options.value, chunks } };
}

/** Type guard: true iff `raw` is a structurally valid chunk plan. */
export function isChunkPlan(raw: unknown): raw is ChunkPlan {
  return validateChunkPlan(raw).ok;
}

/**
 * Source-aware chunk-plan validation (DOC-03 → DOC-04 boundary). Proves a
 * plan is not merely well-formed (that is `validateChunkPlan`) but actually
 * DERIVED FROM `document`:
 *
 *  - every chunkId matches `/^c-[0-9a-f]{16}$/` AND re-derives from its own
 *    slices via `deriveChunkPlanId` (SHA-256 over the canonical seed),
 *  - every slice references a block that exists in `document.blocks` and
 *    stays inside that block's UTF-16 text bounds,
 *  - slices cover every document block exactly once, in document order,
 *    each block's ranges forming a gapless, non-overlapping partition of
 *    `[0, block.text.length)` — a zero-length slice is legal ONLY as the
 *    sole slice of an empty source block,
 *  - every slice token estimate matches the documented `ceil(chars / 4)`
 *    recomputation over the actual covered text (chunk sums are already
 *    reconciled by `validateChunkPlan`).
 *
 * Structural failures surface the underlying `validateChunkPlan` error
 * (VALIDATION_FAILED). Any mismatch against the source document — unknown
 * block, out-of-bounds range, gap/overlap, missing coverage, stale
 * estimate, wrong id derivation — surfaces CORRUPT_DATA: the plan is stale
 * or fabricated relative to its input. Both parameters are `unknown` so
 * Main-process callers can validate untrusted payloads directly.
 */
export function validateChunkPlanAgainstSource(
  rawPlan: unknown,
  rawDocument: unknown,
): ChunkPlanValidationResult {
  const structural = validateChunkPlan(rawPlan);
  if (!structural.ok) return structural;

  if (!isPlainObject(rawDocument) || !Array.isArray(rawDocument.blocks)) {
    return fail('CORRUPT_DATA', 'source document must be an object with a blocks array.');
  }
  const blocks: Array<{ blockId: string; text: string }> = [];
  // Prototype-safe id index: a plain Record would collide legal blockIds
  // like "__proto__", "constructor", or "toString" with inherited
  // properties — reading them yields inherited values (false duplicates)
  // and writing "__proto__" never creates an own key.
  const indexById = new Map<string, number>();
  for (let i = 0; i < rawDocument.blocks.length; i++) {
    const b = rawDocument.blocks[i];
    if (!isPlainObject(b)) {
      return fail('CORRUPT_DATA', `source document.blocks[${i}] must be an object.`);
    }
    const blockId = str(b.blockId);
    if (!blockId) {
      return fail('CORRUPT_DATA', `source document.blocks[${i}].blockId must be a non-empty string.`);
    }
    if (indexById.get(blockId) !== undefined) {
      return fail('CORRUPT_DATA', `source document has duplicate blockId "${blockId}".`);
    }
    const text = str(b.text);
    if (text === undefined) {
      return fail('CORRUPT_DATA', `source document.blocks[${i}].text must be a string.`);
    }
    indexById.set(blockId, i);
    blocks.push({ blockId, text });
  }

  // chunkId shape + derivation, checked per chunk before coverage.
  for (const chunk of structural.value.chunks) {
    if (!/^c-[0-9a-f]{16}$/.test(chunk.chunkId)) {
      return fail('CORRUPT_DATA', `chunk id "${chunk.chunkId}" is not a "c-<16 lowercase hex>" id.`);
    }
    if (deriveChunkPlanId(chunk.slices) !== chunk.chunkId) {
      return fail('CORRUPT_DATA', `chunk id "${chunk.chunkId}" does not re-derive from its slices.`);
    }
  }

  // Ordered, gapless, full coverage of the document's blocks.
  const flat = structural.value.chunks.flatMap((c) => c.slices);
  let ptr = 0; // next document block the plan must cover
  let covering = -1; // index of the block currently being covered
  let expectedStart = 0;
  let zeroLengthSlices = 0; // zero-length slices seen on the covered block
  for (const slice of flat) {
    const idx = indexById.get(slice.blockId);
    if (idx === undefined) {
      return fail('CORRUPT_DATA', `slice references block "${slice.blockId}" absent from the source document.`);
    }
    if (idx !== covering) {
      if (covering >= 0 && expectedStart !== blocks[covering].text.length) {
        return fail(
          'CORRUPT_DATA',
          `block "${blocks[covering].blockId}" is not fully covered by the plan.`,
        );
      }
      if (idx !== ptr) {
        return fail(
          'CORRUPT_DATA',
          `plan covers blocks out of document order (expected block index ${ptr}, got ${idx}).`,
        );
      }
      covering = idx;
      ptr = idx + 1;
      expectedStart = 0;
      zeroLengthSlices = 0;
    }
    if (slice.charEnd > blocks[idx].text.length) {
      return fail(
        'CORRUPT_DATA',
        `slice on block "${slice.blockId}" ends at ${slice.charEnd}, beyond its text length ${blocks[idx].text.length}.`,
      );
    }
    if (slice.charStart !== expectedStart) {
      return fail(
        'CORRUPT_DATA',
        `slice on block "${slice.blockId}" starts at ${slice.charStart}, expected ${expectedStart} (gap or overlap).`,
      );
    }
    // Exactly-once partition: a zero-length slice is legitimate ONLY as the
    // single full-range slice of an EMPTY block — anywhere else it claims
    // characters some other slice also covers.
    if (slice.charStart === slice.charEnd) {
      if (blocks[idx].text.length > 0) {
        return fail(
          'CORRUPT_DATA',
          `slice on block "${slice.blockId}" is zero-length (${slice.charStart}, ${slice.charEnd}) but the block is not empty.`,
        );
      }
      zeroLengthSlices += 1;
      if (zeroLengthSlices > 1) {
        return fail(
          'CORRUPT_DATA',
          `empty block "${slice.blockId}" is covered by ${zeroLengthSlices} zero-length slices.`,
        );
      }
    }
    expectedStart = slice.charEnd;
    // Recompute the slice's token estimate with the documented formula the
    // contract specifies on `BlockSlice.tokenEstimate` (`ceil(chars / 4)`).
    const covered = blocks[idx].text.slice(slice.charStart, slice.charEnd);
    const actual = covered.length === 0 ? 0 : Math.ceil(covered.length / 4);
    if (actual !== slice.tokenEstimate) {
      return fail(
        'CORRUPT_DATA',
        `slice tokenEstimate ${slice.tokenEstimate} on block "${slice.blockId}" does not match the recomputed ${actual}.`,
      );
    }
  }
  if (covering >= 0 && expectedStart !== blocks[covering].text.length) {
    return fail('CORRUPT_DATA', `block "${blocks[covering].blockId}" is not fully covered by the plan.`);
  }
  if (ptr !== blocks.length) {
    return fail('CORRUPT_DATA', `plan does not cover ${blocks.length - ptr} document block(s) starting at index ${ptr}.`);
  }
  return structural;
}

/** Type guard: true iff `raw` is a structurally valid plan FOR `document`. */
export function isChunkPlanForSource(rawPlan: unknown, rawDocument: unknown): boolean {
  return validateChunkPlanAgainstSource(rawPlan, rawDocument).ok;
}

// ============================================================================
// DOC-04 — Translation coordination (plan §10.6)
// ============================================================================
//
// Types for the translation coordinator's observable surface. These describe
// wire-shaped data only (progress snapshots, translate requests/responses);
// the state machine itself lives in electron/main/documents/
// translationCoordinator.js and is dependency-injected with a translate
// function, so no runtime behavior ships in this section.

/** Run-level state machine states (plan §10.6), in canonical order. */
export type TranslationRunState =
  | 'idle'
  | 'preparing'
  | 'translating'
  | 'validating'
  | 'repairing'
  | 'committing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** The three §10.6 intents. */
export type TranslationIntentKind = 'automatic' | 'manual-chunk' | 'targeted';

/**
 * Per-chunk processing status. `needs-review` means committed WITH flagged
 * (suspicious) blocks; `stale` means the response was discarded because the
 * captured source/target revisions no longer match; `skipped` means nothing
 * was sendable (fully protected chunk) and nothing was written.
 */
export type TranslationChunkStatus =
  | 'pending'
  | 'translating'
  | 'validating'
  | 'repairing'
  | 'committing'
  | 'committed'
  | 'needs-review'
  | 'failed'
  | 'stale'
  | 'cancelled'
  | 'skipped';

/**
 * Per-block outcome inside one processed chunk — exactly the values the
 * coordinator emits (guarded against drift by
 * test/translationCoordinator.test.js). Committed blocks carry the §10.6
 * status-policy verdict: `approved` for clean automatic results,
 * `needs-review` when suspicious pieces were flagged, `draft` for
 * manual/targeted runs. `buffered` marks slices awaiting sibling chunks;
 * `uncommitted` marks resolved-but-not-written blocks (targeted fragments,
 * discarded/cancelled/stale responses); `protected` blocks were never
 * sent; `failed` marks the blocks of a failed chunk.
 */
export type TranslationBlockStatus =
  | 'approved'
  | 'buffered'
  | 'draft'
  | 'failed'
  | 'needs-review'
  | 'protected'
  | 'uncommitted';

/** One block outcome row inside a chunk progress entry. */
export interface TranslationBlockProgress {
  blockId: string;
  status: TranslationBlockStatus;
}

/** One chunk's row in a progress snapshot. */
export interface TranslationChunkProgress {
  chunkId: string;
  status: TranslationChunkStatus;
  tokenEstimate: number;
  /** Repair attempts used (0 = first response was valid). */
  repairAttempts: number;
  /** Outcome per block this chunk contributed slices to. */
  blocks: TranslationBlockProgress[];
}

/**
 * Observable progress snapshot for a translation run (plan §10.6 "progress
 * по chunks/blocks/tokens"). Plain JSON — safe to ship over the typed IPC
 * bridge. Token totals reconcile against the ChunkPlan estimates over the
 * WHOLE run, whatever its outcome: `tokensTotal` is the full plan/run
 * estimate — the sum over EVERY chunk of the run (pending, in-flight,
 * failed, and cancelled chunks included) — while `tokensDone` accumulates
 * a chunk's `tokenEstimate` only when it finishes successfully
 * (`committed`, `needs-review`, or `skipped`). Partial and failed runs
 * therefore always show `tokensDone < tokensTotal`. Block totals count only
 * the blocks the run can ever write (unprotected and fully tiled by its
 * slices), so a completed run ends with `blocksDone === blocksTotal`.
 */
export interface TranslationProgressSnapshot {
  runId: string;
  projectId: string;
  /** Canonical (normalized) BCP-47 tag of the target language archive. */
  language: string;
  intent: TranslationIntentKind;
  state: TranslationRunState;
  chunks: TranslationChunkProgress[];
  chunksDone: number;
  chunksTotal: number;
  blocksDone: number;
  blocksTotal: number;
  tokensDone: number;
  tokensTotal: number;
  /** First fatal error ({code, message}); null unless the run failed. */
  error: { code: ErrorCode; message: string } | null;
}

/**
 * One source segment handed to the translate function: a slice reference
 * plus its text read from the run's captured document snapshot. Only
 * non-empty, unprotected segments are sent.
 */
export interface TranslateSegment {
  blockId: string;
  charStart: number;
  charEnd: number;
  text: string;
}

/** Request contract for the injected translate function (one chunk). */
export interface TranslateChunkRequest {
  runId: string;
  chunkId: string;
  /** Canonical BCP-47 tag of the target language. */
  targetLanguage: string;
  /** Rolling context from the D3 plan (§10.4/§10.6); '' at document edges. */
  contextBefore: string;
  contextAfter: string;
  segments: TranslateSegment[];
  /**
   * Present only on a bounded repair retry (attempt 1..MAX_REPAIR_ATTEMPTS)
   * with the structural issues of the rejected response.
   */
  repair?: { attempt: number; issues: string[] };
}

/**
 * One translated segment. The `blockId` echo is ALWAYS required; the
 * offset echoes are optional ONLY for a block that appears once in the
 * chunk (validated when present). A block appearing MORE than once has no
 * other per-slice identity, so every one of its segments MUST echo its
 * exact `charStart`/`charEnd` — omitting or mismatching them there is a
 * structural validation failure (repairable), never an accepted tiling.
 */
export interface TranslatedSegment {
  blockId: string;
  charStart?: number;
  charEnd?: number;
  text: string;
}

/** Response contract for the injected translate function (one chunk). */
export interface TranslateChunkResponse {
  segments: TranslatedSegment[];
}

// ============================================================================
// DOC-05 — Editorial editor core (plan §10.7, §10.8)
// ============================================================================
//
// Types for the ProseMirror binding's observable surface (electron/main/
// documents/editorCore.js). The runtime origin constant and the guard logic
// live in the core module; this section is wire-shaped vocabulary only.

/**
 * Origin of an editor transaction (the `vaniscript/editorOrigin` meta key).
 * Absent meta means `user`: every PROGRAMMATIC transaction must carry one of
 * the reserved origins so persistence/audit can tell human edits from
 * machine-applied ones (editor invariant #5).
 */
export type EditorOrigin = 'user' | 'ai-replace' | 'retranslate' | 'policy' | 'internal';

/**
 * Immutable capture of a selection at operation-request time (plan §10.8).
 * An AI response may only be applied when BOTH the selection text hash AND
 * the observed source/target revisions still match (editor invariant #7).
 */
export interface SelectionSnapshot {
  /** Shape discriminator, bumped on incompatible change. */
  kind: 'vaniscript/selection-snapshot@1';
  operationId: string;
  language: string;
  chunkId: string | null;
  blockId: string;
  /** Canonical SHA-256 hex of the captured selection text. */
  textHash: string;
  /** Captured selection length in UTF-16 code units. */
  textLength: number;
  /**
   * UTF-16 offsets of the captured range inside `block.text`, when the
   * capture carried range context. Optional, but strictly paired: when one
   * is present both are, and `charEnd - charStart === textLength`.
   */
  charStart?: number;
  /** Exclusive end offset of the captured range (paired with `charStart`). */
  charEnd?: number;
  sourceRevision: string;
  /** Project revision observed on the translation side at capture time. */
  targetRevision: string;
  createdAt: string;
}

/** Typed denial reasons of the selection guard, in check precedence order. */
export type SelectionGuardDenyReason =
  | 'invalid-snapshot'
  | 'selection-changed'
  | 'source-revision-moved'
  | 'target-revision-moved';

/** Discriminated allow/deny result of the selection guard (§10.8). */
export type SelectionGuardResult =
  | { ok: true }
  | { ok: false; reason: SelectionGuardDenyReason };
