/**
 * Project v3 domain model + versioned migrator (shared Main/Renderer contract).
 *
 * This is the single strict schema that unites media and document projects in
 * the Electron edition (Migration Plan P2 — state/data/platform foundation).
 *
 * Lineage: the shape follows the canonical `ProjectState` from the
 * VaniScript → Electron Migration Plan (§6.3 persistent project store, §9.1
 * canonical project schema), which used a `sourceKind` discriminator. The
 * PROJ-01 assignment names the v3 discriminator `type` (`'media' | 'document'`);
 * we use that name here and keep the rest of the plan's field set
 * (`projectId`, `revision`, `metadata`, `createdAt`/`updatedAt`, asset
 * manifest, domain `mediaState`/`documentState`).
 *
 * `MediaProjectState` is aliased to the existing `SessionState` (the real
 * media session the legacy Electron app persisted) so migration preserves the
 * proven media domain 1:1. The dependency is `import type` only — this module
 * is pure (no Electron / Node built-in side effects) and can be required
 * directly from CommonJS tests via Node's type stripping, exactly like
 * `shared/contracts/settings.ts`.
 */

import type {
  AudioMetadata,
  ChunkData,
  OutputFormat,
  SessionState,
  TranslationProvider,
} from '../../src/types.ts';
import { AppError, createAppError, type ErrorCode } from './errors.ts';

/** Current persisted project schema version. Bump when the shape changes. */
export const PROJECT_SCHEMA_VERSION = 3 as const;
export type ProjectSchemaVersion = typeof PROJECT_SCHEMA_VERSION;

/** Discriminator values for the unified project schema. */
export type ProjectType = 'media' | 'document';

/** Known, persistable output subtitle formats. */
export const KNOWN_OUTPUT_FORMATS: readonly OutputFormat[] = [
  'TXT',
  'SRT',
  'VTT',
  'Markdown',
];

/** Asset manifest entry (plan §6.3). */
export interface ProjectAsset {
  role: string;
  relativePath: string;
  sizeBytes: number;
  checksum: string;
}

/** Project-level metadata carried on every project. */
export interface ProjectMetadata {
  name: string;
  sourceFileName: string;
  sourcePath?: string;
  note?: string;
}

/**
 * Media domain state. Aliased (not re-declared) to the real `SessionState` the
 * legacy app persisted, so a migrated media project is byte-faithful to the
 * session the user was working in.
 */
export type MediaProjectState = SessionState;

/**
 * Document domain state. The full document feature lane (DOC-*) extends this
 * later; for the v3 foundation it captures the strict identity needed to make a
 * document project a first-class member of the union.
 */
export interface DocumentProjectState {
  sourceFileName: string;
  sourcePath?: string;
  title: string;
  sourceLang: string;
  targetLang: string;
  translationProvider: TranslationProvider;
}

interface ProjectV3Base {
  schemaVersion: ProjectSchemaVersion;
  projectId: string;
  /** Monotonically increasing revision (atomic store increments this). */
  revision: string;
  metadata: ProjectMetadata;
  route?: string;
  activeTranslationLanguage?: string;
  createdAt: string;
  updatedAt: string;
  assets: ProjectAsset[];
}

/**
 * The unified v3 project. A discriminated union on `type` so the media and
 * document branches are mutually exclusive and strict.
 */
export type ProjectV3 =
  | (ProjectV3Base & { type: 'media'; mediaState: MediaProjectState })
  | (ProjectV3Base & { type: 'document'; documentState: DocumentProjectState });

// --- Validation result types ------------------------------------------------

type ValidationOk<T> = { ok: true; value: T };
type ValidationErr = { ok: false; error: AppError };

/** Result of structurally validating an unknown value as a v3 project. */
export type ProjectValidationResult = ValidationOk<ProjectV3> | ValidationErr;

// --- Primitive coercers (mirror shared/contracts/settings.ts) ---------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function int(v: unknown): number {
  const n = num(v);
  return n === undefined ? 0 : Math.trunc(n);
}

/** Read the declared `schemaVersion`, treating absent/non-numeric as legacy (0). */
function declaredSchemaVersion(obj: Record<string, unknown>): number {
  const sv = obj.schemaVersion;
  return typeof sv === 'number' && Number.isFinite(sv) ? sv : 0;
}

function nowIso(): string {
  return new Date().toISOString();
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  );
}

function generateProjectId(name: string): string {
  return `proj-${slug(name)}`;
}

function fail(code: ErrorCode, message: string, details?: unknown): ValidationErr {
  return { ok: false, error: createAppError(code, message, details) };
}

// --- Field normalizers ------------------------------------------------------

function normalizeAudioMetadata(v: unknown): AudioMetadata {
  if (!isPlainObject(v)) return {};
  const m = v as Record<string, unknown>;
  const out: AudioMetadata = {};
  if (typeof m.date === 'string') out.date = m.date;
  if (typeof m.location === 'string') out.location = m.location;
  if (typeof m.lecturer === 'string') out.lecturer = m.lecturer;
  if (typeof m.participants === 'string') out.participants = m.participants;
  return out;
}

function normalizeOutputFormats(v: unknown): OutputFormat[] {
  if (Array.isArray(v)) {
    return v.filter(
      (x): x is OutputFormat =>
        typeof x === 'string' &&
        (KNOWN_OUTPUT_FORMATS as readonly string[]).includes(x),
    );
  }
  if (typeof v === 'string') {
    return v
      .split(/[,\s]+/)
      .filter(Boolean)
      .filter((x): x is OutputFormat =>
        (KNOWN_OUTPUT_FORMATS as readonly string[]).includes(x),
      );
  }
  return [];
}

/**
 * Preserve existing chunk objects verbatim. Deep chunk repair (missing
 * `index`/`status`, cue drift, etc.) is owned by the FND-03 chunk-split lane;
 * here we only drop non-object entries so the array stays well-typed.
 */
function normalizeChunks(v: unknown): ChunkData[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isPlainObject) as ChunkData[];
}

function normalizeAssets(v: unknown): ProjectAsset[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isPlainObject).map((a) => {
    const x = a as Record<string, unknown>;
    return {
      role: str(x.role) ?? 'asset',
      relativePath: str(x.relativePath) ?? str(x.path) ?? '',
      sizeBytes: num(x.sizeBytes) ?? 0,
      checksum: str(x.checksum) ?? '',
    };
  });
}

// --- Structural validation (v3) ---------------------------------------------

function validateMediaState(
  v: unknown,
): ValidationOk<MediaProjectState> | ValidationErr {
  if (!isPlainObject(v)) {
    return fail('VALIDATION_FAILED', 'Project type "media" requires a "mediaState" object.');
  }
  const s = v as Record<string, unknown>;
  const sourceFile: string | null =
    s.sourceFile === null
      ? null
      : typeof s.sourceFile === 'string'
        ? s.sourceFile
        : null;
  const sourceFileName = str(s.sourceFileName);
  if (!sourceFileName) {
    return fail('VALIDATION_FAILED', 'mediaState.sourceFileName is required.');
  }
  const durationSec = num(s.durationSec);
  if (durationSec === undefined) {
    return fail('VALIDATION_FAILED', 'mediaState.durationSec must be a number.');
  }
  const sourceLang = str(s.sourceLang);
  if (!sourceLang) return fail('VALIDATION_FAILED', 'mediaState.sourceLang is required.');
  const targetLang = str(s.targetLang);
  if (!targetLang) return fail('VALIDATION_FAILED', 'mediaState.targetLang is required.');
  const transcriptionProvider = str(s.transcriptionProvider);
  if (transcriptionProvider === undefined) {
    return fail('VALIDATION_FAILED', 'mediaState.transcriptionProvider is required.');
  }
  const translationProvider = str(s.translationProvider);
  if (translationProvider === undefined) {
    return fail('VALIDATION_FAILED', 'mediaState.translationProvider is required.');
  }
  const outputFormats = Array.isArray(s.outputFormats)
    ? (s.outputFormats.filter(
        (x): x is OutputFormat =>
          typeof x === 'string' &&
          (KNOWN_OUTPUT_FORMATS as readonly string[]).includes(x),
      ) as OutputFormat[])
    : null;
  if (outputFormats === null) {
    return fail('VALIDATION_FAILED', 'mediaState.outputFormats must be an array of strings.');
  }
  const chunks = Array.isArray(s.chunks)
    ? (s.chunks.filter(isPlainObject) as ChunkData[])
    : null;
  if (chunks === null) {
    return fail('VALIDATION_FAILED', 'mediaState.chunks must be an array.');
  }
  return {
    ok: true,
    value: {
      sourceFile,
      sourceFileName,
      durationSec,
      metadata: normalizeAudioMetadata(s.metadata),
      sourceLang,
      targetLang,
      transcriptionProvider,
      translationProvider,
      outputFormats,
      chunks,
      currentChunkIndex: int(s.currentChunkIndex),
    },
  };
}

function validateDocumentState(
  v: unknown,
): ValidationOk<DocumentProjectState> | ValidationErr {
  if (!isPlainObject(v)) {
    return fail('VALIDATION_FAILED', 'Project type "document" requires a "documentState" object.');
  }
  const s = v as Record<string, unknown>;
  const sourceFileName = str(s.sourceFileName);
  if (!sourceFileName) {
    return fail('VALIDATION_FAILED', 'documentState.sourceFileName is required.');
  }
  const title = str(s.title);
  if (!title) return fail('VALIDATION_FAILED', 'documentState.title is required.');
  const sourceLang = str(s.sourceLang);
  if (!sourceLang) return fail('VALIDATION_FAILED', 'documentState.sourceLang is required.');
  const targetLang = str(s.targetLang);
  if (!targetLang) return fail('VALIDATION_FAILED', 'documentState.targetLang is required.');
  const translationProvider = str(s.translationProvider);
  if (translationProvider === undefined) {
    return fail('VALIDATION_FAILED', 'documentState.translationProvider is required.');
  }
  return {
    ok: true,
    value: {
      sourceFileName,
      sourcePath: str(s.sourcePath) ?? undefined,
      title,
      sourceLang,
      targetLang,
      translationProvider,
    },
  };
}

/**
 * Validate (and normalize) an unknown value as a strict v3 project.
 * `assets` is filled with `[]` when absent so round-tripped files validate.
 */
export function validateProjectV3(raw: unknown): ProjectValidationResult {
  if (!isPlainObject(raw)) {
    return fail('VALIDATION_FAILED', 'Project must be a non-null object.');
  }
  const obj = raw as Record<string, unknown>;
  const sv = declaredSchemaVersion(obj);
  if (sv !== PROJECT_SCHEMA_VERSION) {
    return fail(
      'VALIDATION_FAILED',
      `Unsupported project schemaVersion: ${String(sv)} (expected ${PROJECT_SCHEMA_VERSION}).`,
    );
  }

  const projectId = str(obj.projectId);
  if (!projectId) {
    return fail('VALIDATION_FAILED', 'Project is missing a non-empty "projectId".');
  }
  const revision = str(obj.revision);
  if (!revision) {
    return fail('VALIDATION_FAILED', 'Project is missing a non-empty "revision".');
  }

  const rawType = obj.type;
  const type: ProjectType | null =
    rawType === 'media' ? 'media' : rawType === 'document' ? 'document' : null;
  if (!type) {
    return fail('VALIDATION_FAILED', 'Project "type" must be "media" or "document".');
  }

  const meta = obj.metadata;
  if (!isPlainObject(meta)) {
    return fail('VALIDATION_FAILED', 'Project "metadata" must be an object.');
  }
  const metaObj = meta as Record<string, unknown>;
  const metaName = str(metaObj.name);
  const metaSource = str(metaObj.sourceFileName);
  if (!metaName) return fail('VALIDATION_FAILED', 'Project metadata.name is required.');
  if (!metaSource) {
    return fail('VALIDATION_FAILED', 'Project metadata.sourceFileName is required.');
  }

  const createdAt = str(obj.createdAt);
  if (!createdAt) return fail('VALIDATION_FAILED', 'Project "createdAt" is required.');
  const updatedAt = str(obj.updatedAt);
  if (!updatedAt) return fail('VALIDATION_FAILED', 'Project "updatedAt" is required.');

  const metadata: ProjectMetadata = {
    name: metaName,
    sourceFileName: metaSource,
    sourcePath: str(metaObj.sourcePath) ?? undefined,
    note: str(metaObj.note) ?? undefined,
  };
  const route = str(obj.route) ?? undefined;
  const activeTranslationLanguage = str(obj.activeTranslationLanguage) ?? undefined;
  const assets = normalizeAssets(obj.assets);

  if (type === 'media') {
    const ms = validateMediaState(obj.mediaState);
    if (!ms.ok) return ms;
    return {
      ok: true,
      value: {
        schemaVersion: PROJECT_SCHEMA_VERSION,
        projectId,
        revision,
        type: 'media',
        mediaState: ms.value,
        metadata,
        route,
        activeTranslationLanguage,
        createdAt,
        updatedAt,
        assets,
      },
    };
  }

  const ds = validateDocumentState(obj.documentState);
  if (!ds.ok) return ds;
  return {
    ok: true,
    value: {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      projectId,
      revision,
      type: 'document',
      documentState: ds.value,
      metadata,
      route,
      activeTranslationLanguage,
      createdAt,
      updatedAt,
      assets,
    },
  };
}

/** Type guard: true iff `raw` is a structurally valid v3 project. */
export function isProjectV3(raw: unknown): raw is ProjectV3 {
  return validateProjectV3(raw).ok;
}

// --- Legacy (v1/v2) migration ----------------------------------------------

/** Unwrap a possibly-wrapped legacy session to its inner media object. */
function unwrapSession(obj: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['mediaState', 'media', 'session', 'project']) {
    const v = obj[key];
    if (isPlainObject(v)) {
      if (key === 'project' && isPlainObject((v as Record<string, unknown>).mediaState)) {
        return (v as Record<string, unknown>).mediaState as Record<string, unknown>;
      }
      return v as Record<string, unknown>;
    }
  }
  return obj;
}

function extractMediaState(session: Record<string, unknown>): MediaProjectState {
  const s = isPlainObject(session) ? session : {};
  const sourceFile: string | null =
    s.sourceFile === null
      ? null
      : typeof s.sourceFile === 'string'
        ? s.sourceFile
        : typeof s.sourcePath === 'string'
          ? s.sourcePath
          : null;
  const sourceFileName =
    str(s.sourceFileName) ??
    str(s.fileName) ??
    str(s.name) ??
    (typeof sourceFile === 'string' ? basename(sourceFile) : '') ??
    '';
  return {
    sourceFile,
    sourceFileName,
    durationSec: num(s.durationSec) ?? num(s.duration) ?? 0,
    metadata: normalizeAudioMetadata(s.metadata),
    sourceLang: str(s.sourceLang) ?? 'en',
    targetLang: str(s.targetLang) ?? 'en',
    transcriptionProvider: str(s.transcriptionProvider) ?? '',
    translationProvider: str(s.translationProvider) ?? '',
    outputFormats: normalizeOutputFormats(s.outputFormats),
    chunks: normalizeChunks(s.chunks),
    currentChunkIndex: int(s.currentChunkIndex),
  };
}

function extractDocumentState(obj: Record<string, unknown>): DocumentProjectState {
  return {
    sourceFileName: str(obj.sourceFileName) ?? '',
    sourcePath: str(obj.sourcePath) ?? str(obj.sourceFile) ?? undefined,
    title: str(obj.title) ?? str(obj.name) ?? 'Untitled Document',
    sourceLang: str(obj.sourceLang) ?? 'en',
    targetLang: str(obj.targetLang) ?? 'en',
    translationProvider: str(obj.translationProvider) ?? '',
  };
}

/**
 * Upgrade a recognized legacy (v0/v1/v2) payload to v3, or return `null` when
 * `raw` is not a legacy project (e.g. it is already/nearly v3, or garbage).
 * Never downgrades a newer schema — callers reject those explicitly.
 */
function migrateLegacy(raw: unknown): ProjectV3 | null {
  if (!isPlainObject(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const sv = declaredSchemaVersion(obj);
  if (sv >= PROJECT_SCHEMA_VERSION) return null;

  const isDocument = obj.type === 'document' || obj.sourceKind === 'document';
  const session = unwrapSession(obj);

  const sourceFileName =
    str(obj.sourceFileName) ??
    str(session.sourceFileName) ??
    str(obj.fileName) ??
    '';
  const name = str(obj.name) ?? sourceFileName ?? 'Untitled Project';
  const sourcePath =
    str(obj.sourcePath) ?? str(session.sourcePath) ?? str(obj.sourceFile) ?? undefined;

  const base = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId: str(obj.projectId) ?? str(obj.id) ?? str(session.id) ?? generateProjectId(name),
    revision: '1',
    metadata: {
      name,
      sourceFileName,
      sourcePath: sourcePath ?? undefined,
      note: str(obj.note) ?? undefined,
    } satisfies ProjectMetadata,
    route: str(obj.route) ?? undefined,
    activeTranslationLanguage: str(obj.activeTranslationLanguage) ?? undefined,
    createdAt: str(obj.createdAt) ?? nowIso(),
    updatedAt: str(obj.updatedAt) ?? nowIso(),
    assets: normalizeAssets(obj.assets),
  };

  return isDocument
    ? { ...base, type: 'document', documentState: extractDocumentState(obj) }
    : { ...base, type: 'media', mediaState: extractMediaState(session) };
}

/**
 * Safely upgrade an unknown payload to a strict v3 project.
 *
 * - Already-valid v3 → returned as-is (normalized).
 * - Recognized legacy (v0/v1/v2) → migrated to v3.
 * - Anything else (garbage, malformed v3, or a newer schema) → throws an
 *   `AppError` with `code: 'VALIDATION_FAILED'`, so callers can back the bad
 *   file up to a `Corrupt/` dir rather than silently coercing.
 */
export function migrateProject(raw: unknown): ProjectV3 {
  const v3 = validateProjectV3(raw);
  if (v3.ok) return v3.value;

  const declared = isPlainObject(raw) ? declaredSchemaVersion(raw as Record<string, unknown>) : 0;
  if (declared > PROJECT_SCHEMA_VERSION) {
    throw createAppError(
      'VALIDATION_FAILED',
      `Cannot migrate project with newer schemaVersion ${String(declared)} down to v${PROJECT_SCHEMA_VERSION}.`,
      { declared },
    );
  }

  const migrated = migrateLegacy(raw);
  if (migrated) {
    const checked = validateProjectV3(migrated);
    if (checked.ok) return checked.value;
    // Defensive: migrateLegacy is contractually supposed to emit valid v3.
    throw checked.error;
  }

  throw v3.error;
}
