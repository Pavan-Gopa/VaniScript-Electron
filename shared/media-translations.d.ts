import type {
  ChunkData,
  LanguageResult,
  SessionState,
  TranscriptCue,
  TranslationVariant,
} from '../src/types';

/**
 * Strict declarations for shared/media-translations.js — the single
 * Main/renderer-compatible multi-language implementation. Types are imported
 * from src/types.ts so both sides share one canonical model.
 */

/** Apple-equivalent display name: known prefixes map to English names,
 * anything else is trimmed with only its first character uppercased. */
export function displayTranslationLanguage(language: string): string;

/** Archive/map key for a language: the lowercased display name. */
export function translationLanguageKey(language: string): string;

/** Empty and `same` are not real translation languages. */
export function isRealTranslationLanguage(language: unknown): language is string;

/** Reject unusable machine text (blank or containing a known failure marker). */
export function isUsableTranslationText(text: string): boolean;

/** Machine failure markers rejected by isUsableTranslationText. */
export const FAILURE_MARKERS: readonly string[];

/** Normalize one variant payload to the exact TranslationVariant shape, or
 * null when the language is not real or the text is unusable. */
export function toTranslationVariant(input: Partial<TranslationVariant> | null | undefined): TranslationVariant | null;

/** Re-key a chunk's archive to canonical language keys, keeping every usable
 * variant and dropping unusable/unreal ones. Deterministic and idempotent. */
export function normalizeVariantArchive(chunk: Pick<ChunkData, 'translationsByLanguage'> | null | undefined): Record<string, TranslationVariant>;

/**
 * Exact resolver: an explicitly requested language resolves to exactly that
 * variant or null; without one the active language is used. Never a fallback
 * to another language.
 */
export function resolveChunkVariant(
  chunk: Pick<ChunkData, 'translationsByLanguage'> | null | undefined,
  requestedLanguage: string | undefined,
  activeLanguage: string | undefined
): TranslationVariant | null;

/** Legacy eager projection of the active variant: blank/undefined when the
 * variant is missing, never borrowed from another language. */
export function projectChunkLegacyFields(
  chunk: Pick<ChunkData, 'translationsByLanguage'> | null | undefined,
  activeLanguage: string | undefined
): Pick<ChunkData, 'translated' | 'translatedCues' | 'translatedFormats'>;

/** Upsert a variant into a chunk's archive (canonical key, usable text only).
 * Returns the fresh archive, or null for unreal/unusable input. */
export function upsertTranslationVariant(
  chunk: Pick<ChunkData, 'translationsByLanguage'> | null | undefined,
  input: Partial<TranslationVariant>
): Record<string, TranslationVariant> | null;

/** Remove one language from a chunk's archive; returns the fresh archive. */
export function removeTranslationVariant(
  chunk: Pick<ChunkData, 'translationsByLanguage'> | null | undefined,
  language: string
): Record<string, TranslationVariant>;

/** First archive language across chunks (insertion order), or ''. */
export function firstArchiveLanguageKey(chunks: ChunkData[] | null | undefined): string;

/** Active-first available-language union as canonical display names. */
export function collectAvailableTranslationLanguages(
  chunks: ChunkData[] | null | undefined,
  activeLanguage: string | undefined,
  declaredLanguages: string[] | null | undefined
): string[];

/** Structural subset consumed by normalizeMediaSessionTranslations; any
 * persisted media session satisfies it. */
export interface NormalizableMediaSession extends Pick<SessionState, 'chunks' | 'targetLang' | 'activeTranslationLanguage' | 'availableTranslationLanguages'> {
  config?: { targetLang?: string } | null;
  /** Load-only legacy input; always absent after normalization. */
  selectedTranslationLanguage?: string;
}

/**
 * Full session normalization (see the JS module header): strips the legacy
 * selected field, resolves the canonical active language with Apple
 * precedence, re-keys archives preserving inactive usable variants, seeds
 * usable legacy projections only into a missing resolved variant, projects
 * the active variant onto the legacy fields, derives the active-first
 * available-language union, and synchronizes target/config targets.
 * Idempotent and clone-only.
 */
export function normalizeMediaSessionTranslations<S extends object>(session: S): S;

export type { ChunkData, LanguageResult, SessionState, TranscriptCue, TranslationVariant };
