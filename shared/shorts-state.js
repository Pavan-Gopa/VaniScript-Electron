'use strict';

const {
  displayTranslationLanguage,
  isRealTranslationLanguage,
  translationLanguageKey,
} = require('./media-translations');

const PLAN_LANGUAGE_MODES = new Set(['source', 'target', 'bilingual']);

/** @typedef {import('../src/lib/shorts-reels').NormalizedShortsClipPlan} NormalizedShortsClipPlan */
/**
 * @typedef {Object} NormalizedShortsSessionState
 * @property {NormalizedShortsClipPlan[]} shortsPlans
 * @property {NormalizedShortsClipPlan[]} shortsRejectedPlans
 */
const SOURCE_EVIDENCE_FIELDS = Object.freeze([
  'sourceTitle',
  'sourceSummary',
  'sourceHook',
  'sourceCategory',
  'sourceCaptionText',
]);
const TARGET_EVIDENCE_FIELDS = Object.freeze([
  'targetTitle',
  'targetSummary',
  'targetHook',
  'targetCategory',
  'targetCaptionText',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isPlainObject(value)) return value;
  const copy = {};
  for (const [key, nested] of Object.entries(value)) copy[key] = cloneValue(nested);
  return copy;
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Parse one Shorts timestamp without a sentinel fallback. Ingress accepts
 * numeric one-, two-, or three-component values, optionally wrapped in one
 * pair of square brackets. The returned seconds are already floored to the
 * canonical integer-second range used by Shorts validation.
 *
 * @param {unknown} value
 * @returns {{ok: boolean, seconds: number|null, canonical: string|null, message?: string}}
 */
function parseShortsTimestamp(value) {
  const invalid = (message) => ({ ok: false, seconds: null, canonical: null, message });
  if (typeof value !== 'string' && typeof value !== 'number') {
    return invalid('Timestamp must be a string or finite number.');
  }

  let clean = String(value).trim();
  const startsBracketed = clean.startsWith('[');
  const endsBracketed = clean.endsWith(']');
  if (startsBracketed || endsBracketed) {
    if (!startsBracketed || !endsBracketed) return invalid('Timestamp brackets must wrap the complete value.');
    clean = clean.slice(1, -1).trim();
  }
  if (!clean || clean.includes('[') || clean.includes(']')) {
    return invalid('Timestamp is empty or malformed.');
  }

  const parts = clean.split(':');
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => part.trim() === '')) {
    return invalid('Timestamp must contain one to three numeric components.');
  }
  const components = parts.map((part) => Number(part.trim()));
  if (components.some((component) => !Number.isFinite(component))) {
    return invalid('Timestamp components must be finite numbers.');
  }
  if (components.some((component) => component < 0)) {
    return invalid('Timestamp components must be non-negative.');
  }
  const secondsComponent = components[components.length - 1];
  if (parts.length > 1 && secondsComponent >= 60) {
    return invalid('Timestamp seconds must be less than 60.');
  }
  if (parts.length === 3 && components[1] >= 60) {
    return invalid('Timestamp minutes must be less than 60.');
  }

  const rawSeconds = parts.length === 3
    ? (components[0] * 3600) + (components[1] * 60) + components[2]
    : parts.length === 2
      ? (components[0] * 60) + components[1]
      : components[0];
  if (!Number.isFinite(rawSeconds)) return invalid('Timestamp value must be finite.');
  const seconds = Math.floor(rawSeconds);
  return {
    ok: true,
    seconds,
    canonical: seconds >= 0 ? secondsToShortsTimestamp(seconds) : null,
  };
}

/**
 * Format finite seconds using the canonical Shorts timestamp shape.
 *
 * @param {number} totalSeconds
 * @returns {string}
 */
function secondsToShortsTimestamp(totalSeconds) {
  if (!Number.isFinite(totalSeconds)) throw new TypeError('Shorts timestamp seconds must be finite.');
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function canonicalizePlanRange(plan) {
  const start = parseShortsTimestamp(plan.start);
  const end = parseShortsTimestamp(plan.end);
  if (!start.ok || !end.ok || start.seconds === null || end.seconds === null) return;
  if (start.seconds < 0 || end.seconds <= start.seconds) return;
  plan.start = start.canonical;
  plan.end = end.canonical;
}

function identityKey(value) {
  return String(value).toLowerCase();
}

function validIdentity(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function defaultIDFactory() {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function') return randomUUID.call(globalThis.crypto).toLowerCase();
  const random = Math.random().toString(16).slice(2).padEnd(32, '0');
  return `${random.slice(0, 8)}-${random.slice(8, 12)}-4${random.slice(13, 16)}-8${random.slice(17, 20)}-${random.slice(20, 32)}`.toLowerCase();
}

function mintIdentity(idFactory, used) {
  const supplied = typeof idFactory === 'function' ? idFactory() : undefined;
  const candidate = validIdentity(supplied) ? String(supplied).toLowerCase() : '';
  if (candidate && !used.has(identityKey(candidate))) return candidate;

  let fallback = defaultIDFactory();
  while (used.has(identityKey(fallback))) fallback = defaultIDFactory();
  return fallback;
}

function chooseIdentity(plan, used, idFactory) {
  const candidates = [plan.stableID, plan.id];
  for (const candidate of candidates) {
    if (!validIdentity(candidate)) continue;
    const canonical = String(candidate);
    const key = identityKey(canonical);
    if (!used.has(key)) {
      used.add(key);
      return canonical;
    }
  }

  const minted = mintIdentity(idFactory, used);
  used.add(identityKey(minted));
  return minted;
}

function defineArchiveEntry(archive, key, value) {
  Object.defineProperty(archive, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function normalizeTranslations(plan) {
  const archive = {};
  const source = isPlainObject(plan.translationsByLanguage) ? plan.translationsByLanguage : null;
  if (!source) return archive;

  for (const [rawKey, rawValue] of Object.entries(source)) {
    if (!isPlainObject(rawValue)) continue;
    const languageInput = isRealTranslationLanguage(rawValue.language)
      ? rawValue.language
      : rawKey;
    if (!isRealTranslationLanguage(languageInput)) continue;

    const language = displayTranslationLanguage(languageInput);
    const key = translationLanguageKey(language);
    if (!key || hasOwn(archive, key)) continue;

    defineArchiveEntry(archive, key, {
      ...cloneValue(rawValue),
      language,
    });
  }
  return archive;
}

function activeLanguageKey(session) {
  const candidates = [
    session?.activeTranslationLanguage,
    session?.targetLang,
    session?.config?.targetLang,
  ];
  for (const candidate of candidates) {
    if (isRealTranslationLanguage(candidate)) return translationLanguageKey(candidate);
  }
  return '';
}

function shortsPlanArchive(plan) {
  const value = plan && typeof plan === 'object' && !Array.isArray(plan)
    ? plan.translationsByLanguage
    : null;
  return isPlainObject(value) ? value : {};
}

function shortsActiveLanguageKey(activeLanguage) {
  if (activeLanguage && typeof activeLanguage === 'object' && !Array.isArray(activeLanguage)) {
    activeLanguage = activeLanguage.activeTranslationLanguage;
  }
  return isRealTranslationLanguage(activeLanguage)
    ? translationLanguageKey(activeLanguage)
    : '';
}

function shortsTranslationForLanguage(plan, activeLanguage) {
  const key = shortsActiveLanguageKey(activeLanguage);
  const archive = shortsPlanArchive(plan);
  const variant = key && isPlainObject(archive[key]) ? archive[key] : null;
  return variant ? { key, variant } : null;
}

function sourceShortsPlanProjection(plan) {
  const value = isPlainObject(plan) ? plan : {};
  return {
    available: true,
    title: hasText(value.sourceTitle) ? value.sourceTitle : (hasText(value.title) ? value.title : ''),
    summary: hasText(value.sourceSummary) ? value.sourceSummary : (hasText(value.summary) ? value.summary : ''),
    hook: hasText(value.sourceHook) ? value.sourceHook : (hasText(value.hook) ? value.hook : ''),
    category: hasText(value.sourceCategory) ? value.sourceCategory : (hasText(value.category) ? value.category : ''),
    captionText: hasText(value.sourceCaptionText)
      ? value.sourceCaptionText
      : (hasText(value.captionText) ? value.captionText : ''),
  };
}

function activeShortsPlanProjection(plan, activeLanguage) {
  const resolved = shortsTranslationForLanguage(plan, activeLanguage);
  if (!resolved) {
    return {
      available: false,
      languageKey: shortsActiveLanguageKey(activeLanguage),
      title: '',
      summary: '',
      hook: '',
      category: '',
      captionText: '',
      variant: null,
    };
  }
  const { key, variant } = resolved;
  return {
    available: true,
    languageKey: key,
    title: hasText(variant.title) ? variant.title : '',
    summary: hasText(variant.summary) ? variant.summary : '',
    hook: hasText(variant.hook) ? variant.hook : '',
    category: hasText(variant.category) ? variant.category : '',
    captionText: hasText(variant.captionText) ? variant.captionText : '',
    variant,
  };
}

function shortsPlanProjection(plan, projection, activeLanguage) {
  return projection === 'target'
    ? activeShortsPlanProjection(plan, activeLanguage)
    : sourceShortsPlanProjection(plan);
}

function shortsPlanID(plan) {
  const value = isPlainObject(plan) ? plan.stableID : undefined;
  if (typeof value === 'string' && value.trim()) return value;
  const legacy = isPlainObject(plan) ? plan.id : undefined;
  return typeof legacy === 'string' && legacy.trim() ? legacy : '';
}

function parseShortsPlanRange(plan) {
  const value = isPlainObject(plan) ? plan : {};
  const start = parseShortsTimestamp(value.start);
  const end = parseShortsTimestamp(value.end);
  if (!start.ok || !end.ok || start.seconds === null || end.seconds === null) return null;
  return { startSec: start.seconds, endSec: end.seconds };
}

function finitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function resolveShortsSourceDuration(session) {
  if (!isPlainObject(session)) return null;
  const sourceMediaInfo = isPlainObject(session.sourceMediaInfo) ? session.sourceMediaInfo : null;
  const persisted = finitePositive(sourceMediaInfo?.durationSec) ?? finitePositive(session.durationSec);
  if (persisted !== null) return persisted;

  const chunks = Array.isArray(session.chunks) ? session.chunks : [];
  let maxEndSec = 0;
  for (const chunk of chunks) {
    if (!isPlainObject(chunk)) continue;
    if (typeof chunk.endSec !== 'number' || !Number.isFinite(chunk.endSec)) continue;
    maxEndSec = Math.max(maxEndSec, chunk.endSec);
  }
  return maxEndSec > 0 ? maxEndSec : null;
}

function validationActiveLanguageKey(options) {
  const session = isPlainObject(options?.session) ? options.session : null;
  const config = isPlainObject(session?.config) ? session.config : null;
  for (const candidate of [
    options?.activeLanguage,
    session?.activeTranslationLanguage,
    session?.targetLang,
    config?.targetLang,
  ]) {
    if (isRealTranslationLanguage(candidate)) return translationLanguageKey(candidate);
  }
  return '';
}

function validationIssue(issues, severity, code, message, entityId) {
  issues.push(entityId ? { severity, code, message, entityId } : { severity, code, message });
}

function shortsExclusionWindow(range) {
  return { startSec: Math.max(0, range.startSec - 15), endSec: range.endSec + 15 };
}

function shortsOverlapSeconds(a, b) {
  return Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));
}

function inferShortsProjection(plan) {
  return plan?.languageMode === 'target' || plan?.languageMode === 'bilingual' ? 'target' : 'source';
}

/**
 * Canonical Shorts validation shared by renderer and Main. The options object
 * intentionally mirrors the typed renderer API but remains dependency-free so
 * disk-backed MCP reads can use the exact same range, cut, source-bound,
 * projection, and padded-overlap semantics.
 */
function validateShortsPlan(plan, options = {}) {
  const value = isPlainObject(plan) ? plan : {};
  const issues = [];
  const planId = shortsPlanID(value);
  const parsedStart = parseShortsTimestamp(value.start);
  const parsedEnd = parseShortsTimestamp(value.end);
  const startSec = parsedStart.ok ? parsedStart.seconds : null;
  const endSec = parsedEnd.ok ? parsedEnd.seconds : null;
  const durationSec = startSec !== null && endSec !== null ? endSec - startSec : null;

  if (!parsedStart.ok || !parsedEnd.ok || startSec === null || endSec === null || startSec < 0 || endSec <= startSec) {
    validationIssue(issues, 'error', 'INVALID_RANGE', 'Shorts plan start/end must be finite, non-negative, and end after start.', planId);
  }

  const minDurationSec = options.minDurationSec ?? 10;
  const maxDurationSec = options.maxDurationSec ?? 300;
  if (
    durationSec !== null
    && (!Number.isFinite(minDurationSec) || !Number.isFinite(maxDurationSec)
      || durationSec < minDurationSec || durationSec > maxDurationSec)
  ) {
    validationIssue(issues, 'error', 'INVALID_DURATION', `Shorts plan duration must be between ${minDurationSec} and ${maxDurationSec} seconds.`, planId);
  }

  const sourceDurationSec = finitePositive(options.sourceDurationSec) ?? resolveShortsSourceDuration(options.session);
  if (sourceDurationSec !== null && endSec !== null && endSec > sourceDurationSec) {
    validationIssue(issues, 'error', 'OUTSIDE_SOURCE', 'Shorts plan ends after the source media.', planId);
  }

  const projection = options.projection === 'target' || options.projection === 'source'
    ? options.projection
    : inferShortsProjection(value);
  const selected = shortsPlanProjection(value, projection, validationActiveLanguageKey(options));
  if (projection === 'target' && !selected.available) {
    validationIssue(issues, 'error', 'MISSING_TARGET_VARIANT', 'The exact active target-language Shorts variant is unavailable.', planId);
  } else {
    if (!hasText(selected.title)) {
      validationIssue(issues, 'error', 'EMPTY_TITLE', `${projection === 'target' ? 'Target' : 'Source'} Shorts title is empty.`, planId);
    }
    if (!hasText(selected.captionText)) {
      validationIssue(issues, 'warning', 'EMPTY_CAPTIONS', `${projection === 'target' ? 'Target' : 'Source'} caption text is empty.`, planId);
    }
  }

  const cuts = value.timelineCuts;
  if (cuts !== undefined && !Array.isArray(cuts)) {
    validationIssue(issues, 'error', 'INVALID_CUT', 'Timeline cuts must be an array.', planId);
  } else if (Array.isArray(cuts)) {
    cuts.forEach((rawCut, index) => {
      const cut = isPlainObject(rawCut) ? rawCut : null;
      const cutID = cut && typeof cut.stableID === 'string' && cut.stableID.trim()
        ? cut.stableID
        : `cut-${index}`;
      const cutStart = cut?.startSec;
      const cutEnd = cut?.endSec;
      if (
        typeof cutStart !== 'number' || !Number.isFinite(cutStart)
        || typeof cutEnd !== 'number' || !Number.isFinite(cutEnd)
        || cutStart < 0 || cutEnd <= cutStart
        || (durationSec !== null && cutEnd > durationSec)
      ) {
        validationIssue(issues, 'error', 'INVALID_CUT', 'Timeline cut is outside the clip duration.', cutID);
      }
    });
  }

  const candidateRange = startSec !== null && endSec !== null && startSec >= 0 && endSec > startSec
    ? { startSec, endSec }
    : null;
  if (candidateRange) {
    const threshold = typeof options.overlapThresholdSec === 'number'
      && Number.isFinite(options.overlapThresholdSec)
      && options.overlapThresholdSec >= 0
      ? options.overlapThresholdSec
      : 1;
    const excludedPlanID = options.excludePlanId ? String(options.excludePlanId).toLowerCase() : '';
    const checkPlans = (plans, code) => {
      for (const other of Array.isArray(plans) ? plans : []) {
        const otherID = shortsPlanID(other);
        if (excludedPlanID && otherID.toLowerCase() === excludedPlanID) continue;
        const otherRange = parseShortsPlanRange(other);
        if (!otherRange || otherRange.startSec < 0 || otherRange.endSec <= otherRange.startSec) continue;
        if (shortsOverlapSeconds(candidateRange, shortsExclusionWindow(otherRange)) > threshold) {
          validationIssue(issues, 'error', code, `Shorts plan overlaps an excluded ${code === 'OVERLAP_ACTIVE' ? 'active' : 'rejected'} range by more than ${threshold} second.`, otherID || undefined);
        }
      }
    };
    checkPlans(options.activePlans, 'OVERLAP_ACTIVE');
    checkPlans(options.rejectedPlans, 'OVERLAP_REJECTED');
  }

  return {
    valid: !issues.some((issue) => issue.severity === 'error'),
    planId,
    startSec,
    endSec,
    durationSec,
    issues,
  };
}

function validateShortsPlanRestore(plan, options = {}) {
  return validateShortsPlan(plan, {
    ...options,
    projection: inferShortsProjection(plan),
    excludePlanId: shortsPlanID(plan),
  });
}

function collectShortsTranslationLanguages(
  plans,
  rejectedPlans,
  activeLanguage,
  declaredLanguages
) {
  const keys = [];
  const push = (language) => {
    if (!isRealTranslationLanguage(language)) return;
    const key = translationLanguageKey(language);
    if (!keys.includes(key)) keys.push(key);
  };
  push(activeLanguage);
  for (const language of Array.isArray(declaredLanguages) ? declaredLanguages : []) push(language);

  const archiveKeys = [];
  for (const plan of [
    ...(Array.isArray(plans) ? plans : []),
    ...(Array.isArray(rejectedPlans) ? rejectedPlans : []),
  ]) {
    for (const rawKey of Object.keys(shortsPlanArchive(plan))) {
      const key = translationLanguageKey(rawKey);
      if (isRealTranslationLanguage(key) && !keys.includes(key) && !archiveKeys.includes(key)) archiveKeys.push(key);
    }
  }
  archiveKeys.sort();
  return [...keys, ...archiveKeys].map((key) => displayTranslationLanguage(key));
}

function upsertShortsPlanTranslation(plan, activeLanguage, input) {
  const source = isPlainObject(plan) ? plan : {};
  const key = shortsActiveLanguageKey(activeLanguage);
  if (!key || !isPlainObject(input)) return cloneValue(source);
  const archive = shortsPlanArchive(source);
  const existing = isPlainObject(archive[key]) ? archive[key] : {};
  const translation = {
    ...cloneValue(existing),
    ...cloneValue(input),
    language: displayTranslationLanguage(activeLanguage),
  };
  const nextArchive = { ...archive, [key]: translation };
  return {
    ...cloneValue(source),
    translationsByLanguage: nextArchive,
  };
}

function attachShortsPlanActiveTranslation(plan, activeLanguage) {
  const source = isPlainObject(plan) ? plan : {};
  if (
    source.languageMode !== 'target'
    && source.languageMode !== 'bilingual'
  ) return cloneValue(source);
  const targetFields = {
    title: hasText(source.targetTitle) ? source.targetTitle : source.title,
    summary: hasText(source.targetSummary) ? source.targetSummary : source.summary,
    hook: hasText(source.targetHook) ? source.targetHook : source.hook,
  };
  if (hasText(source.targetCategory) || hasText(source.category)) targetFields.category = hasText(source.targetCategory) ? source.targetCategory : source.category;
  if (hasText(source.targetCaptionText) || hasText(source.captionText)) targetFields.captionText = hasText(source.targetCaptionText) ? source.targetCaptionText : source.captionText;
  return upsertShortsPlanTranslation(source, activeLanguage, targetFields);
}

function hasEvidence(plan, fields) {
  return fields.some((field) => hasText(plan[field]));
}

function inferLanguageMode(plan, archive, activeKey) {
  const sourceEvidence = hasEvidence(plan, SOURCE_EVIDENCE_FIELDS);
  const targetEvidence = hasEvidence(plan, TARGET_EVIDENCE_FIELDS)
    || Boolean(activeKey && hasOwn(archive, activeKey));
  if (sourceEvidence && targetEvidence) return 'bilingual';
  if (targetEvidence && activeKey) return 'target';
  return 'source';
}

function fieldValue(plan, field, fallbackField) {
  if (hasText(plan[field])) return plan[field];
  return fallbackField && hasText(plan[fallbackField]) ? plan[fallbackField] : '';
}

function copyTranslationFields(plan, fields) {
  const translation = {
    language: fields.language,
    title: fieldValue(plan, fields.title, fields.fallbackTitle),
    summary: fieldValue(plan, fields.summary, fields.fallbackSummary),
    hook: fieldValue(plan, fields.hook, fields.fallbackHook),
  };
  const category = fieldValue(plan, fields.category, fields.fallbackCategory);
  const captionText = fieldValue(plan, fields.captionText, fields.fallbackCaptionText);
  if (hasText(category)) translation.category = category;
  if (hasText(captionText)) translation.captionText = captionText;
  return translation;
}

function seedActiveTranslation(plan, archive, activeKey, languageMode) {
  if (!activeKey || Object.keys(archive).length > 0) return;

  const targetEvidence = hasEvidence(plan, TARGET_EVIDENCE_FIELDS);
  const fields = targetEvidence
    ? {
        language: displayTranslationLanguage(activeKey),
        title: 'targetTitle',
        summary: 'targetSummary',
        hook: 'targetHook',
        category: 'targetCategory',
        captionText: 'targetCaptionText',
        fallbackTitle: 'title',
        fallbackSummary: 'summary',
        fallbackHook: 'hook',
        fallbackCategory: 'category',
        fallbackCaptionText: 'captionText',
      }
    : languageMode === 'target' || languageMode === 'bilingual'
      ? {
          language: displayTranslationLanguage(activeKey),
          title: 'title',
          summary: 'summary',
          hook: 'hook',
          category: 'category',
          captionText: 'captionText',
        }
      : null;
  if (!fields) return;

  defineArchiveEntry(archive, activeKey, copyTranslationFields(plan, fields));
}

function normalizePlan(rawPlan, session, usedPlanIDs, idFactory) {
  if (!isPlainObject(rawPlan)) return null;
  const plan = cloneValue(rawPlan);
  plan.stableID = chooseIdentity(plan, usedPlanIDs, idFactory);
  delete plan.id;

  const archive = normalizeTranslations(plan);
  const activeKey = activeLanguageKey(session);
  const languageMode = PLAN_LANGUAGE_MODES.has(plan.languageMode)
    ? plan.languageMode
    : inferLanguageMode(plan, archive, activeKey);
  plan.languageMode = languageMode;
  seedActiveTranslation(plan, archive, activeKey, languageMode);
  if (Object.keys(archive).length > 0) plan.translationsByLanguage = archive;
  else delete plan.translationsByLanguage;

  canonicalizePlanRange(plan);
  normalizeCuts(plan, idFactory);
  return plan;
}

function normalizeCuts(plan, idFactory) {
  if (!Array.isArray(plan.timelineCuts)) return;
  const used = new Set();
  plan.timelineCuts = plan.timelineCuts
    .filter(isPlainObject)
    .map((rawCut) => {
      const cut = cloneValue(rawCut);
      delete cut.id;
      const candidate = validIdentity(cut.stableID) ? String(cut.stableID) : '';
      const key = identityKey(candidate);
      const stableID = candidate && !used.has(key) ? candidate : mintIdentity(idFactory, used);
      used.add(identityKey(stableID));
      cut.stableID = stableID;
      return cut;
    });
}

/**
 * Clone and canonicalize the durable Shorts state shared by Main and the
 * renderer. The optional idFactory exists for deterministic migration tests;
 * production calls use lowercase crypto UUIDs.
 *
 * @param {unknown} session
 * @param {() => string} [idFactory]
 * @returns {NormalizedShortsSessionState}
 */
function normalizeShortsSessionState(session, idFactory = defaultIDFactory) {
  const base = isPlainObject(session) ? session : {};
  const next = cloneValue(base);
  delete next.selectedShortsPlanIndexes;

  const usedPlanIDs = new Set();
  const normalizePlans = (plans) => (Array.isArray(plans) ? plans : [])
    .map((plan) => normalizePlan(plan, base, usedPlanIDs, idFactory))
    .filter(Boolean);
 
  next.shortsPlans = normalizePlans(base.shortsPlans);
  next.shortsRejectedPlans = normalizePlans(base.shortsRejectedPlans);
  next.availableTranslationLanguages = collectShortsTranslationLanguages(
    next.shortsPlans,
    next.shortsRejectedPlans,
    activeLanguageKey(base),
    base.availableTranslationLanguages,
  );

  return next;
}

if (typeof module !== 'undefined') {
  module.exports = {
    normalizeShortsSessionState,
    parseShortsTimestamp,
    secondsToShortsTimestamp,
    parseShortsPlanRange,
    resolveShortsSourceDuration,
    validateShortsPlan,
    validateShortsPlanRestore,
    sourceShortsPlanProjection,
    activeShortsPlanProjection,
    shortsPlanProjection,
    shortsTranslationForLanguage,
    collectShortsTranslationLanguages,
    upsertShortsPlanTranslation,
    attachShortsPlanActiveTranslation,
  };
}
