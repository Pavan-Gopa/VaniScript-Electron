'use strict';

/**
 * Single Main/renderer-compatible implementation of the media session
 * multi-language contract (P3E.D2).
 *
 * Canonical runtime/session state owns only `activeTranslationLanguage`,
 * `availableTranslationLanguages`, `targetLang`, `config.targetLang`, and
 * `chunks[].translationsByLanguage`. The legacy `selectedTranslationLanguage`
 * field is load-only input and is stripped by normalization.
 *
 * `translationsByLanguage` is the authority. The legacy `translated`,
 * `translatedCues`, and `translatedFormats` chunk fields remain eagerly
 * synchronized projections of the current active variant only; a missing
 * active variant projects blank/undefined and never borrows another language.
 *
 * Display/key/usability policy mirrors the Apple Silicon edition's
 * `TranslationArchive` enum (SessionModels.swift), including its machine
 * failure markers. Everything in this module is pure: inputs are never
 * mutated, outputs are fresh objects.
 */

const FAILURE_MARKERS = Object.freeze([
  'mlx translation failed',
  'mlx returned no usable translation text',
  'translation failed:',
  'generation timed out',
]);

const DISPLAY_BY_PREFIX = Object.freeze([
  ['ru', 'Russian'],
  ['cs', 'Czech'],
  ['cz', 'Czech'],
  ['fr', 'French'],
  ['de', 'German'],
  ['pl', 'Polish'],
  ['en', 'English'],
  ['hi', 'Hindi'],
  ['es', 'Spanish'],
  ['sv', 'Swedish'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
]);

/** Apple-equivalent display name: known prefixes map to English names,
 * anything else is trimmed with only its first character uppercased. */
function displayTranslationLanguage(language) {
  const raw = typeof language === 'string' ? language : '';
  const clean = raw.trim().toLowerCase();
  for (const [prefix, display] of DISPLAY_BY_PREFIX) {
    if (clean.startsWith(prefix)) return display;
  }
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Archive/map key for a language: the lowercased display name. */
function translationLanguageKey(language) {
  return displayTranslationLanguage(language).toLowerCase();
}

/** Empty and `same` are not real translation languages. */
function isRealTranslationLanguage(language) {
  const key = translationLanguageKey(language);
  return key !== '' && key !== 'same';
}

/** Reject unusable machine text (blank or containing a known failure marker). */
function isUsableTranslationText(text) {
  const clean = typeof text === 'string' ? text.trim() : '';
  if (!clean) return false;
  const lower = clean.toLowerCase();
  return !FAILURE_MARKERS.some((marker) => lower.includes(marker));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** Normalize one variant payload to the exact TranslationVariant shape, or
 * null when the language is not real or the text is unusable. */
function toTranslationVariant(input) {
  if (!isPlainObject(input)) return null;
  if (!isRealTranslationLanguage(input.language)) return null;
  if (!isUsableTranslationText(input.text)) return null;
  const variant = {
    language: displayTranslationLanguage(input.language),
    text: input.text,
  };
  if (Array.isArray(input.cues)) variant.cues = input.cues;
  if (isPlainObject(input.formats)) variant.formats = input.formats;
  if (typeof input.provider === 'string' && input.provider) variant.provider = input.provider;
  if (typeof input.updatedAt === 'string' && input.updatedAt) variant.updatedAt = input.updatedAt;
  return variant;
}

/**
 * Re-key a chunk's archive from variant.language (or its raw key) to the
 * canonical language key, keeping every usable variant and dropping
 * unusable/unreal ones. First occurrence wins on key collisions so the
 * operation is deterministic and idempotent.
 */
function normalizeVariantArchive(chunk) {
  const archive = {};
  const source = isPlainObject(chunk) ? chunk.translationsByLanguage : null;
  if (!isPlainObject(source)) return archive;
  for (const [rawKey, value] of Object.entries(source)) {
    if (!isPlainObject(value)) continue;
    const language = isRealTranslationLanguage(value.language) ? value.language : rawKey;
    const variant = toTranslationVariant({ ...value, language });
    if (!variant) continue;
    const key = translationLanguageKey(variant.language);
    if (!hasOwn(archive, key)) archive[key] = variant;
  }
  return archive;
}

/**
 * Exact resolver: an explicitly requested language (or the active one)
 * resolves to exactly that variant or null — never a fallback to another
 * language.
 */
function resolveChunkVariant(chunk, requestedLanguage, activeLanguage) {
  const key = isRealTranslationLanguage(requestedLanguage)
    ? translationLanguageKey(requestedLanguage)
    : isRealTranslationLanguage(activeLanguage)
      ? translationLanguageKey(activeLanguage)
      : '';
  if (!key) return null;
  const archive = normalizeVariantArchive(chunk);
  return hasOwn(archive, key) ? archive[key] : null;
}

/**
 * Legacy eager projection of the active variant: blank/undefined when the
 * variant is missing, never borrowed from another language.
 */
function projectChunkLegacyFields(chunk, activeLanguage) {
  const variant = resolveChunkVariant(chunk, undefined, activeLanguage);
  return {
    translated: variant ? variant.text : '',
    translatedCues: variant?.cues,
    translatedFormats: variant?.formats,
  };
}

/**
 * Upsert a variant into a chunk's archive (canonical key, usable text only).
 * Returns the fresh archive object, or null when the input is unreal or
 * unusable (callers preserve the prior archive in that case).
 */
function upsertTranslationVariant(chunk, input) {
  const variant = toTranslationVariant(input);
  if (!variant) return null;
  const archive = normalizeVariantArchive(chunk);
  archive[translationLanguageKey(variant.language)] = variant;
  return archive;
}

/** Remove one language from a chunk's archive; returns the fresh archive. */
function removeTranslationVariant(chunk, language) {
  const archive = normalizeVariantArchive(chunk);
  const key = translationLanguageKey(language);
  if (hasOwn(archive, key)) delete archive[key];
  return archive;
}

/** First archive language across chunks (insertion order), or ''. Used to
 * derive an active language for archives that lack an explicit selection. */
function firstArchiveLanguageKey(chunks) {
  const list = Array.isArray(chunks) ? chunks : [];
  for (const chunk of list) {
    const archive = normalizeVariantArchive(chunk);
    const keys = Object.keys(archive);
    if (keys.length > 0) return keys[0];
  }
  return '';
}

/**
 * Active-first available-language union: canonical active, then previously
 * declared languages (partial declarations survive even without variants),
 * then every archive-derived language sorted for determinism. Display names.
 */
function collectAvailableTranslationLanguages(chunks, activeLanguage, declaredLanguages) {
  const orderedKeys = [];
  const push = (language) => {
    if (!isRealTranslationLanguage(language)) return false;
    const key = translationLanguageKey(language);
    if (orderedKeys.includes(key)) return false;
    orderedKeys.push(key);
    return true;
  };
  push(activeLanguage);
  const declared = Array.isArray(declaredLanguages) ? declaredLanguages : [];
  for (const language of declared) push(language);
  const archiveKeys = [];
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    for (const key of Object.keys(normalizeVariantArchive(chunk))) {
      if (!orderedKeys.includes(key) && !archiveKeys.includes(key)) archiveKeys.push(key);
    }
  }
  archiveKeys.sort();
  return [...orderedKeys, ...archiveKeys].map((key) => displayTranslationLanguage(key));
}

/**
 * Full session normalization. Idempotent and clone-only (never mutates the
 * input):
 *
 *   - strips the legacy `selectedTranslationLanguage` field;
 *   - resolves the active language: active -> legacy selected -> targetLang
 *     -> config.targetLang -> first archive language;
 *   - re-keys every chunk archive from variant.language/raw key, preserving
 *     every inactive usable variant;
 *   - seeds the usable legacy translated* projection into the resolved
 *     variant slot only when that variant is missing;
 *   - projects the active variant back onto the legacy fields;
 *   - derives the active-first available-language union;
 *   - synchronizes targetLang and config.targetLang to the canonical active
 *     display name (left untouched when no real active exists).
 */
function normalizeMediaSessionTranslations(session) {
  const base = isPlainObject(session) ? session : {};
  const next = { ...base };
  delete next.selectedTranslationLanguage;

  const config = isPlainObject(base.config) ? { ...base.config } : undefined;
  const candidates = [
    base.activeTranslationLanguage,
    base.selectedTranslationLanguage,
    base.targetLang,
    config?.targetLang,
  ];
  let activeKey = '';
  for (const candidate of candidates) {
    if (isRealTranslationLanguage(candidate)) {
      activeKey = translationLanguageKey(candidate);
      break;
    }
  }
  if (!activeKey) activeKey = firstArchiveLanguageKey(base.chunks);

  const inputChunks = Array.isArray(base.chunks) ? base.chunks : [];
  next.chunks = inputChunks.map((chunk) => {
    if (!isPlainObject(chunk)) return chunk;
    const archive = normalizeVariantArchive(chunk);
    if (activeKey && !hasOwn(archive, activeKey)) {
      // Seed the usable legacy projection into the resolved variant slot only
      // when that variant is missing.
      const seeded = toTranslationVariant({
        language: activeKey,
        text: chunk.translated,
        cues: chunk.translatedCues,
        formats: chunk.translatedFormats,
      });
      if (seeded) archive[activeKey] = seeded;
    }
    // With a canonical active language the eager projection mirrors exactly
    // that variant (blank when missing). Without one there is nothing to
    // project onto, so legacy fields stay untouched instead of being wiped.
    const updated = { ...chunk };
    if (activeKey) {
      const projection = projectChunkLegacyFields({ translationsByLanguage: archive }, activeKey);
      updated.translated = projection.translated;
      if (projection.translatedCues !== undefined) updated.translatedCues = projection.translatedCues;
      else delete updated.translatedCues;
      if (projection.translatedFormats !== undefined) updated.translatedFormats = projection.translatedFormats;
      else delete updated.translatedFormats;
    }
    if (Object.keys(archive).length > 0) {
      updated.translationsByLanguage = archive;
    } else {
      delete updated.translationsByLanguage;
    }
    return updated;
  });

  next.availableTranslationLanguages = collectAvailableTranslationLanguages(
    next.chunks,
    activeKey,
    base.availableTranslationLanguages
  );
  if (activeKey) {
    const display = displayTranslationLanguage(activeKey);
    next.activeTranslationLanguage = display;
    next.targetLang = display;
    if (config) {
      config.targetLang = display;
      next.config = config;
    }
  } else {
    delete next.activeTranslationLanguage;
  }

  return next;
}

module.exports = {
  FAILURE_MARKERS,
  collectAvailableTranslationLanguages,
  displayTranslationLanguage,
  firstArchiveLanguageKey,
  isRealTranslationLanguage,
  isUsableTranslationText,
  normalizeMediaSessionTranslations,
  normalizeVariantArchive,
  projectChunkLegacyFields,
  removeTranslationVariant,
  resolveChunkVariant,
  toTranslationVariant,
  translationLanguageKey,
  upsertTranslationVariant,
};
