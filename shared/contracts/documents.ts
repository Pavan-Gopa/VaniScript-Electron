/**
 * Document domain contract (DOC-01) — normalized import/preflight state.
 *
 * This is the shared Main/Renderer/Worker contract for the document feature
 * lane. DOC-01 owns the import + preflight slice: turning a raw DOCX/PDF/RTF/
 * TXT/MD byte buffer into a normalized `NormalizedDocument` (structural
 * blocks + inline spans + a preflight report). Later DOC steps (persistence,
 * chunk planning, translation, editorial) extend this shape but never redefine
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

/** A contiguous run of text inside a block sharing one trait set. */
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
  const keys: (keyof SpanTrait)[] = [
    'bold',
    'italic',
    'underline',
    'strike',
    'superScript',
    'subScript',
    'smallCaps',
  ];
  for (const k of keys) {
    const b = bool(v[k]);
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
