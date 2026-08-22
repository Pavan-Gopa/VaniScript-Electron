'use strict';

// Document review/multi-language service (DOC-06, plan sections 10.5/10.9).
//
// The D2 DocumentProjectStore owns archive identity, atomic writes, language
// isolation, freshness calculation, and the project revision CAS. This module
// deliberately stays thin over those primitives: review writes update only
// the selected language archive through saveTranslations, while all review
// queries are pure projections of a D2 FreshnessReport. No language archive is
// copied into another language and the active language is only a view helper.

const path = require('node:path');
const { createAppError } = require('../../../shared/contracts/errors.ts');
const { normalizeBcp47 } = require('../../../shared/contracts/documents.ts');

const REVIEW_FILTERS = Object.freeze(['all', 'needs-review', 'stale', 'approved']);
const TRANSLATION_STATUSES = Object.freeze(['draft', 'needs-review', 'approved']);
const FRESHNESS_VALUES = Object.freeze(['missing', 'stale', 'fresh']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw createAppError('VALIDATION_FAILED', `${label} must be a non-empty string.`);
  }
  return value;
}

function requireExpectedRevision(expectedRevision, projectId) {
  if (expectedRevision == null) {
    throw createAppError(
      'VALIDATION_FAILED',
      `expectedRevision is required to mutate document project "${projectId}".`,
    );
  }
}

function normalizeLanguage(language) {
  const normalized = normalizeBcp47(language);
  if (!normalized) {
    throw createAppError(
      'VALIDATION_FAILED',
      `Invalid BCP-47 language tag: ${JSON.stringify(language)}.`,
    );
  }
  return normalized;
}

function normalizeFilter(filter) {
  if (filter === undefined || filter === null) return 'all';
  if (typeof filter !== 'string') {
    throw new TypeError('review filter must be a string.');
  }
  const compact = filter.trim().toLowerCase().replace(/[ _]+/g, '-');
  if (compact === 'needsreview') return 'needs-review';
  if (REVIEW_FILTERS.includes(compact)) return compact;
  throw new TypeError(
    `Unknown review filter "${filter}"; expected one of ${REVIEW_FILTERS.join(', ')}.`,
  );
}

function validateFreshnessReport(report) {
  if (!isRecord(report) || !isRecord(report.blocks)) {
    throw new TypeError('freshness report must contain a blocks record.');
  }
  for (const [blockId, info] of Object.entries(report.blocks)) {
    if (!isRecord(info)) {
      throw new TypeError(`freshness report block "${blockId}" must be an object.`);
    }
    if (!FRESHNESS_VALUES.includes(info.freshness)) {
      throw new TypeError(`freshness report block "${blockId}" has invalid freshness.`);
    }
    if (![...TRANSLATION_STATUSES, 'missing'].includes(info.status)) {
      throw new TypeError(`freshness report block "${blockId}" has invalid status.`);
    }
  }
  return report;
}

function matchesFilter(info, filter) {
  if (filter === 'all') return true;
  if (filter === 'needs-review') return info.status === 'needs-review';
  if (filter === 'stale') return info.freshness === 'stale';
  return info.status === 'approved';
}

/**
 * Pure review query over a D2 FreshnessReport.
 *
 * The returned rows retain the report's block insertion order (which is the
 * normalized source order) and contain no archive references. `missing` rows
 * are included by `all`, but are not silently treated as needs-review or
 * stale: those are independent filters with explicit status/freshness rules.
 */
function filterReviewBlocks(report, filter = 'all') {
  validateFreshnessReport(report);
  const normalizedFilter = normalizeFilter(filter);
  return Object.entries(report.blocks)
    .filter(([, info]) => matchesFilter(info, normalizedFilter))
    .map(([blockId, info]) => ({
      blockId,
      freshness: info.freshness,
      status: info.status,
    }));
}

/** Alias with query-oriented naming for callers building a review navigator. */
function queryReviewBlocks(report, filter = 'all') {
  return filterReviewBlocks(report, filter);
}

/** Pure ID-only form for consumers that only need a block selection. */
function filterReviewBlockIds(report, filter = 'all') {
  return filterReviewBlocks(report, filter).map((row) => row.blockId);
}

function numericToken(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Reconcile token progress to a D3 plan when one is available. D3 chunk
 * estimates are authoritative for the total; slice estimates identify which
 * portions are complete once the corresponding whole-block translation exists.
 */
function planTokenProgress(report, plan) {
  if (plan === undefined || plan === null) return null;
  if (!isRecord(plan) || !Array.isArray(plan.chunks)) {
    throw new TypeError('chunk plan must contain a chunks array.');
  }

  let total = 0;
  let done = 0;
  for (const chunk of plan.chunks) {
    if (!isRecord(chunk)) throw new TypeError('chunk plan entries must be objects.');
    const slices = Array.isArray(chunk.slices) ? chunk.slices : [];
    const sliceTotal = slices.reduce((sum, slice) => {
      if (!isRecord(slice)) throw new TypeError('chunk plan slices must be objects.');
      const estimate = numericToken(slice.tokenEstimate);
      if (estimate === null) throw new TypeError('chunk plan slices require tokenEstimate numbers.');
      return sum + estimate;
    }, 0);
    const chunkTotal = numericToken(chunk.tokenEstimate);
    // A validated D3 plan always has both values and they are equal. Falling
    // back to slices keeps this helper useful for a minimal headless fixture
    // without inventing a token estimate.
    total += chunkTotal === null ? sliceTotal : chunkTotal;
    for (const slice of slices) {
      const info = report.blocks[slice.blockId];
      if (info && info.status !== 'missing') done += slice.tokenEstimate;
    }
  }
  return { done, total };
}

/**
 * Pure per-language sidebar/review progress. Status and stale counts are
 * derived from block rows rather than trusting duplicated report totals.
 * When a D3 plan is supplied, tokensDone/tokensTotal exactly reconcile to its
 * estimates; without a plan token progress is explicitly unavailable.
 */
function getReviewProgress(report, plan) {
  validateFreshnessReport(report);
  const rows = filterReviewBlocks(report, 'all');
  const statusCounts = {
    draft: 0,
    needsReview: 0,
    approved: 0,
    missing: 0,
  };
  let fresh = 0;
  let stale = 0;
  for (const row of rows) {
    if (row.status === 'needs-review') statusCounts.needsReview += 1;
    else if (row.status === 'approved') statusCounts.approved += 1;
    else if (row.status === 'draft') statusCounts.draft += 1;
    else statusCounts.missing += 1;
    if (row.freshness === 'fresh') fresh += 1;
    if (row.freshness === 'stale') stale += 1;
  }
  const translated = rows.length - statusCounts.missing;
  const tokenProgress = planTokenProgress(report, plan);
  return {
    language: typeof report.language === 'string' ? report.language : null,
    totalBlocks: rows.length,
    translated,
    fresh,
    stale,
    missing: statusCounts.missing,
    statusCounts,
    blocksDone: translated,
    blocksTotal: rows.length,
    tokensDone: tokenProgress ? tokenProgress.done : null,
    tokensTotal: tokenProgress ? tokenProgress.total : null,
    tokenProgress,
  };
}

function createActiveLanguageViewState(activeLanguage, languages) {
  // Support both createActiveLanguageViewState(active, languages) and the
  // object form used by IPC/view-model callers.
  let active = activeLanguage;
  let available = languages;
  if (isRecord(activeLanguage) && languages === undefined) {
    active = activeLanguage.activeLanguage;
    available = activeLanguage.languages;
  }
  if (!Array.isArray(available)) {
    throw new TypeError('languages must be an array.');
  }
  const canonicalLanguages = [];
  for (const value of available) {
    const raw = typeof value === 'string' ? value : value && value.language;
    const canonical = normalizeBcp47(raw);
    if (canonical && !canonicalLanguages.includes(canonical)) canonicalLanguages.push(canonical);
  }
  const canonicalActive = normalizeBcp47(active);
  const selected = canonicalActive && canonicalLanguages.includes(canonicalActive)
    ? canonicalActive
    : null;
  return {
    activeLanguage: selected,
    languages: canonicalLanguages,
    hasActiveLanguage: selected !== null,
  };
}

function requireStore(store) {
  if (!store || typeof store !== 'object') {
    throw new TypeError('createDocumentReviewService requires a store.');
  }
  const required = [
    'loadDocumentProject',
    'getTranslationArchive',
    'saveTranslations',
    'addLanguage',
    'removeLanguage',
    'listLanguages',
    'setActiveLanguage',
    'freshness',
  ];
  for (const method of required) {
    if (typeof store[method] !== 'function') {
      throw new TypeError(`createDocumentReviewService requires store.${method}().`);
    }
  }
  return store;
}

function resolvePlan(plans, language) {
  if (plans === undefined || plans === null) return undefined;
  if (isRecord(plans) && Array.isArray(plans.chunks)) return plans;
  if (isRecord(plans)) return plans[language];
  throw new TypeError('plans must be a chunk plan or a language-keyed record.');
}

function transitionResult({ store, projectId, language, blockId, expectedRevision, nextStatus, allowedStatuses, operation }) {
  requireNonEmptyString(projectId, 'projectId');
  requireNonEmptyString(blockId, 'blockId');
  requireExpectedRevision(expectedRevision, projectId);
  const loaded = store.loadDocumentProject(projectId);
  const currentRevision = String(loaded.project.revision);
  // Check the CAS anchor before checking the transition. A stale UI command
  // must report CONFLICT even if another writer has already changed the row's
  // status, rather than leaking a misleading transition error.
  if (currentRevision !== String(expectedRevision)) {
    throw createAppError(
      'CONFLICT',
      `Revision conflict for project "${projectId}": expected "${expectedRevision}" but found "${currentRevision}".`,
      { expectedRevision, currentRevision },
    );
  }
  const archive = store.getTranslationArchive(projectId, language);
  const existing = archive.blocks[blockId];
  if (!existing) {
    throw createAppError(
      'NOT_FOUND',
      `No translation for block "${blockId}" in language "${archive.language}".`,
    );
  }
  if (!allowedStatuses.includes(existing.status)) {
    throw createAppError(
      'VALIDATION_FAILED',
      `${operation} requires status ${allowedStatuses.join(' or ')}; block "${blockId}" is "${existing.status}".`,
    );
  }
  const result = store.saveTranslations(
    projectId,
    archive.language,
    [{ blockId, status: nextStatus }],
    expectedRevision,
  );
  return {
    ...result,
    language: archive.language,
    blockId,
    previousStatus: existing.status,
    status: nextStatus,
    changed: true,
  };
}

/**
 * Build a review service bound to one D2 DocumentProjectStore. The optional
 * `plans` value is a chunk plan or language-keyed plan map used only for
 * progress reconciliation; plans are never persisted or mutated here.
 */
function createDocumentReviewService({ store, plans } = {}) {
  const documentStore = requireStore(store);

  function getState(projectId, language, options = {}) {
    requireNonEmptyString(projectId, 'projectId');
    const loaded = documentStore.loadDocumentProject(projectId);
    const archive = documentStore.getTranslationArchive(projectId, language);
    const report = documentStore.freshness(projectId, archive.language);
    const plan = options.plan ?? options.chunkPlan ?? resolvePlan(plans, archive.language);
    const languages = documentStore.listLanguages(projectId);
    const active = createActiveLanguageViewState(
      loaded.project.activeTranslationLanguage,
      languages,
    );
    const variant = {
      language: archive.language,
      meta: archive.meta,
      createdAt: archive.createdAt,
      updatedAt: archive.updatedAt,
      blockCount: Object.keys(archive.blocks).length,
    };
    return {
      projectId,
      projectRevision: String(loaded.project.revision),
      language: archive.language,
      activeLanguage: active.activeLanguage,
      isActive: active.activeLanguage === archive.language,
      languages: active.languages,
      meta: archive.meta,
      provenance: archive.meta,
      variant,
      archive,
      freshness: report,
      blocks: filterReviewBlocks(report, 'all'),
      progress: getReviewProgress(report, plan),
    };
  }

  function getActiveState(projectId) {
    requireNonEmptyString(projectId, 'projectId');
    const loaded = documentStore.loadDocumentProject(projectId);
    return createActiveLanguageViewState(
      loaded.project.activeTranslationLanguage,
      documentStore.listLanguages(projectId),
    );
  }

  function requestLanguageRemoval(projectId, language, options = {}) {
    requireNonEmptyString(projectId, 'projectId');
    const archive = documentStore.getTranslationArchive(projectId, language);
    const loaded = documentStore.loadDocumentProject(projectId);
    const backupDir = options && typeof options === 'object' ? options.backupDir : undefined;
    if (backupDir !== undefined && backupDir !== null && typeof backupDir !== 'string') {
      throw createAppError('VALIDATION_FAILED', 'backupDir must be a path string when supplied.');
    }
    const expectedRevision = options && typeof options === 'object' && options.expectedRevision != null
      ? options.expectedRevision
      : String(loaded.project.revision);
    return {
      kind: 'language-removal-confirmation',
      action: 'remove-language',
      requiresConfirmation: true,
      projectId,
      language: archive.language,
      expectedRevision,
      backupDir: backupDir ?? null,
      meta: archive.meta,
      blockCount: Object.keys(archive.blocks).length,
    };
  }

  function removeLanguage(projectId, language, expectedRevision, options = {}) {
    const confirmed = options === true || (options && (options.confirmed === true || options.confirm === true));
    if (!confirmed) {
      throw createAppError(
        'VALIDATION_FAILED',
        'Removing a language requires explicit confirmation (options.confirmed=true).',
      );
    }
    const backupDir = options && typeof options === 'object' ? options.backupDir : undefined;
    const normalized = normalizeLanguage(language);
    const result = documentStore.removeLanguage(
      projectId,
      normalized,
      expectedRevision,
      backupDir === undefined ? {} : { backupDir },
    );
    return {
      ...result,
      language: normalized,
      backupFile: backupDir == null ? null : path.join(backupDir, `${normalized}.json`),
    };
  }

  function addLanguage(projectId, language, meta, expectedRevision) {
    return documentStore.addLanguage(projectId, language, meta, expectedRevision);
  }

  function setActiveLanguage(projectId, language, expectedRevision) {
    return documentStore.setActiveLanguage(projectId, language, expectedRevision);
  }

  function getLanguageProgress(projectId, language, plan) {
    const state = getState(projectId, language, { plan });
    return state.progress;
  }
  function listLanguageReviewStates(projectId, languagePlans = plans) {
    requireNonEmptyString(projectId, 'projectId');
    const languages = documentStore.listLanguages(projectId);
    return languages.map(({ language }) =>
      getState(projectId, language, { plan: resolvePlan(languagePlans, language) }),
    );
  }

  function listReviewStates(projectId, languagePlans = plans) {
    return listLanguageReviewStates(projectId, languagePlans);
  }

  const api = {
    addLanguage,
    removeLanguage,
    requestLanguageRemoval,
    prepareRemoveLanguage: requestLanguageRemoval,
    approveBlock(projectId, language, blockId, expectedRevision) {
      return transitionResult({
        store: documentStore,
        projectId,
        language,
        blockId,
        expectedRevision,
        nextStatus: 'approved',
        allowedStatuses: ['draft', 'needs-review'],
        operation: 'approveBlock',
      });
    },
    revokeBlock(projectId, language, blockId, expectedRevision) {
      return transitionResult({
        store: documentStore,
        projectId,
        language,
        blockId,
        expectedRevision,
        nextStatus: 'needs-review',
        allowedStatuses: ['approved'],
        operation: 'revokeBlock',
      });
    },
    setBlockNeedsReview(projectId, language, blockId, expectedRevision) {
      requireNonEmptyString(projectId, 'projectId');
      requireNonEmptyString(blockId, 'blockId');
      requireExpectedRevision(expectedRevision, projectId);
      const loaded = documentStore.loadDocumentProject(projectId);
      const currentRevision = String(loaded.project.revision);
      if (currentRevision !== String(expectedRevision)) {
        throw createAppError(
          'CONFLICT',
          `Revision conflict for project "${projectId}": expected "${expectedRevision}" but found "${currentRevision}".`,
          { expectedRevision, currentRevision },
        );
      }
      const archive = documentStore.getTranslationArchive(projectId, language);
      const existing = archive.blocks[blockId];
      if (!existing) {
        throw createAppError(
          'NOT_FOUND',
          `No translation for block "${blockId}" in language "${archive.language}".`,
        );
      }
      if (existing.status === 'needs-review') {
        // Idempotent UI action: the CAS anchor was still checked above, but a
        // no-op must not burn a project revision or rewrite archive bytes.
        return {
          project: loaded.project,
          archive,
          revision: currentRevision,
          language: archive.language,
          blockId,
          previousStatus: existing.status,
          status: existing.status,
          changed: false,
        };
      }
      if (existing.status !== 'draft' && existing.status !== 'approved') {
        throw createAppError(
          'VALIDATION_FAILED',
          `setBlockNeedsReview cannot update status "${existing.status}" for block "${blockId}".`,
        );
      }
      const result = documentStore.saveTranslations(
        projectId,
        archive.language,
        [{ blockId, status: 'needs-review' }],
        expectedRevision,
      );
      return {
        ...result,
        language: archive.language,
        blockId,
        previousStatus: existing.status,
        status: 'needs-review',
        changed: true,
      };
    },
    getLanguageReviewState: getState,
    getReviewState: getState,
    getLanguageState: getState,
    listLanguageReviewStates,
    listReviewStates,
    getLanguageProgress,
    getActiveLanguageViewState: getActiveState,
    activeLanguageViewState: getActiveState,
    setActiveLanguage,
    switchActiveLanguage: setActiveLanguage,
    queryReviewBlocks,
    filterReviewBlocks,
    filterReviewBlockIds,
    _store: documentStore,
  };
  return api;
}

module.exports = {
  REVIEW_FILTERS,
  TRANSLATION_STATUSES,
  filterReviewBlocks,
  queryReviewBlocks,
  filterReviewBlockIds,
  getReviewProgress,
  createActiveLanguageViewState,
  createDocumentReviewService,
};
