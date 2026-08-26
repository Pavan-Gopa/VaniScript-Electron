'use strict';

/**
 * MCP-02 read-only tool catalogue.
 *
 * The catalogue is deliberately independent from the HTTP transport.  Each
 * handler is a pure projection over an injected reader (or one of the small
 * adapters below), and always returns the same metadata envelope.  This keeps
 * the D1 loopback seam useful in headless tests while allowing Main to provide
 * the real project/document stores at runtime.
 */

const fs = require('node:fs');
const path = require('node:path');

// Single shared multi-language implementation (P3E.D2): every read
// normalizes a clone through it so published state is canonical and the
// caller's session object is never touched.
const mediaTranslations = require('../../../../shared/media-translations.js');
// Shared Shorts normalizer/projections/validator keep Main reads byte-for-byte
// aligned with the renderer while the response sanitizers below enforce the
// MCP trust boundary.
const shortsState = require('../../../../shared/shorts-state.js');

const READ_SCOPE = 'read';
const READ_RISK = 'read';
const READ_SCHEMA_VERSION = 1;

const RESULT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
  required: [
    'schemaVersion',
    'tool',
    'scope',
    'risk',
    'projectId',
    'projectRevision',
    'data',
  ],
  properties: {
    schemaVersion: { type: 'integer', const: READ_SCHEMA_VERSION },
    tool: { type: 'string', minLength: 1 },
    scope: { type: 'string', const: READ_SCOPE },
    risk: { type: 'string', const: READ_RISK },
    projectId: { type: ['string', 'null'] },
    projectRevision: { type: ['string', 'number', 'null'] },
    data: {},
  },
});

function objectSchema(properties = {}, required = []) {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

const string = (description) => ({ type: 'string', ...(description ? { description } : {}) });
const integer = (minimum, maximum, description) => ({
  type: 'integer',
  ...(minimum === undefined ? {} : { minimum }),
  ...(maximum === undefined ? {} : { maximum }),
  ...(description ? { description } : {}),
});
const boolean = (description) => ({ type: 'boolean', ...(description ? { description } : {}) });

const emptySchema = objectSchema();
const projectIdSchema = string('Optional project identifier.');
const cursorSchema = integer(0, undefined, 'Zero-based result offset.');
const limitSchema = integer(1, 100, 'Maximum number of results.');

function definition(name, description, inputSchema = emptySchema) {
  return Object.freeze({
    name,
    description,
    risk: READ_RISK,
    riskLevel: READ_RISK,
    scope: READ_SCOPE,
    capabilityRequirements: Object.freeze(['mcp.read']),
    requiredCapabilities: Object.freeze(['mcp.read']),
    capabilities: Object.freeze(['mcp.read']),
    confirmationText: null,
    inputSchema,
    // Both names are retained because MCP clients use resultSchema while a
    // few SDKs call the same field outputSchema.
    resultSchema: RESULT_SCHEMA,
    outputSchema: RESULT_SCHEMA,
    annotations: Object.freeze({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
  });
}

/**
 * Read-only scope from the canonical Swift catalogue, plus the document
 * selection projections needed by the Electron migration lane.  Mutation,
 * processing, file, network, and destructive names intentionally do not occur.
 */
const READ_TOOL_DEFINITIONS = Object.freeze([
  definition('list_projects', 'List saved projects with bounded pagination and progress summaries.', objectSchema({
    cursor: cursorSchema,
    limit: limitSchema,
  })),
  definition('get_project_summary', 'Get a safe summary for one saved project.', objectSchema({
    projectId: string('Saved project identifier.'),
  }, ['projectId'])),
  definition('get_project_state', 'Get active project state without API keys, access tokens, or provider secrets.', objectSchema({
    projectId: projectIdSchema,
  })),
  definition('get_source_media_info', 'Get safe technical information about a project source media asset.', objectSchema({
    projectId: projectIdSchema,
  })),
  definition('get_workflow_config', 'Get source/target language, providers, formats, and chunking configuration without secrets.', objectSchema({
    projectId: projectIdSchema,
  })),
  definition('get_ui_state', 'Get the current workspace screen and safe review state.', objectSchema({
    projectId: projectIdSchema,
  })),
  definition('get_processing_status', 'Get the current processing stage and bounded progress counters.', objectSchema({
    projectId: projectIdSchema,
  })),
  definition('get_capabilities', 'List the read capabilities and available read tool groups.', emptySchema),
  definition('validate_active_project', 'Validate project integrity, transcript timing, and translation references without changing data.', objectSchema({
    projectId: projectIdSchema,
  })),
  definition('list_chunks', 'List project transcript chunks with stable identifiers, timing, status, and previews.', objectSchema({
    cursor: cursorSchema,
    limit: limitSchema,
    status: { type: 'string', enum: ['pending', 'processing', 'done', 'error'] },
    approved: boolean('Optional approval filter.'),
    projectId: projectIdSchema,
  })),
  definition('get_chunk', 'Get one transcript chunk by stable chunkId or zero-based chunkIndex.', objectSchema({
    chunkId: string('Stable chunk identifier returned by list_chunks.'),
    chunkIndex: integer(0, undefined, 'Zero-based chunk index.'),
    language: string('Optional translation language.'),
    projectId: projectIdSchema,
  })),
  definition('get_chunk_cues', 'Get timed source or translated cues for one transcript chunk.', objectSchema({
    chunkId: string('Stable chunk identifier.'),
    chunkIndex: integer(0, undefined, 'Zero-based chunk index.'),
    side: { type: 'string', enum: ['original', 'translated'] },
    language: string('Optional translation language.'),
    projectId: projectIdSchema,
  })),
  definition('search_transcript', 'Search source and/or translated transcript text without modifying it.', objectSchema({
    query: string('Search text.'),
    side: { type: 'string', enum: ['all', 'original', 'translated'] },
    caseSensitive: boolean(),
    language: string('Optional translation language.'),
    limit: limitSchema,
    projectId: projectIdSchema,
  }, ['query'])),
  definition('get_unrecognized_fragments', 'List unrecognized transcript fragments grouped by stable chunk identifier.', objectSchema({
    chunkId: string('Optional stable chunk identifier.'),
    projectId: projectIdSchema,
  })),
  definition('list_translation_languages', 'List available and active translation languages for a project.', objectSchema({
    projectId: projectIdSchema,
  })),
  definition('list_glossary_entries', 'List glossary entries with stable identifiers and bounded pagination.', objectSchema({
    cursor: cursorSchema,
    limit: integer(1, 200, 'Maximum glossary entries.'),
    category: string('Optional exact category.'),
    projectId: projectIdSchema,
  })),
  definition('search_glossary', 'Search glossary sources, translations, variants, and categories.', objectSchema({
    query: string('Search text.'),
    limit: limitSchema,
    projectId: projectIdSchema,
  }, ['query'])),
  definition('export_glossary', 'Return a portable, secret-free JSON glossary projection.', objectSchema({
    projectId: projectIdSchema,
  })),
  definition('get_document_state', 'Read the validated document project archive and safe project metadata.', objectSchema({
    projectId: projectIdSchema,
  })),
  definition('get_document_selection', 'Read the current document selection snapshot without changing the document.', objectSchema({
    projectId: projectIdSchema,
    blockId: string('Optional document block identifier.'),
    start: integer(0),
    end: integer(0),
  })),
  definition('get_document_selection_context', 'Read the bounded context around a document selection.', objectSchema({
    projectId: projectIdSchema,
    blockId: string('Optional document block identifier.'),
    start: integer(0),
    end: integer(0),
  })),
  definition('list_help_topics', 'List built-in help topics for feature discovery.', objectSchema({
    category: string('Optional exact help category.'),
    language: string('Optional BCP-47 language tag.'),
  })),
  definition('get_help_topic', 'Read one built-in help topic and its bounded instructions.', objectSchema({
    topicId: string('Help topic identifier.'),
    language: string('Optional BCP-47 language tag.'),
  }, ['topicId'])),
  definition('search_help', 'Search built-in help topics by question or feature name.', objectSchema({
    query: string('Search question or feature name.'),
    language: string('Optional BCP-47 language tag.'),
    limit: integer(1, 10),
  }, ['query'])),
  definition('get_contextual_help', 'Read exact next actions for the current screen and project state.', objectSchema({
    language: string('Optional BCP-47 language tag.'),
  })),
  definition('get_onboarding_checklist', 'Read the complete first-use workflow checklist.', objectSchema({
    language: string('Optional BCP-47 language tag.'),
  })),
  // Shorts reads are resolved by the Main-side disk catalogue below. They
  // intentionally share the public read definitions with renderer callers.
  definition('get_subtitle_style', 'Get active subtitle style settings.', emptySchema),
  definition('get_shorts_plans', 'List vertical shorts plans in the active project.', objectSchema({ projectId: projectIdSchema })),
  definition('get_shorts_plan', 'Get one shorts plan by stable plan identifier.', objectSchema({ planId: string(), projectId: projectIdSchema }, ['planId'])),
  definition('list_rejected_shorts_plans', 'List rejected shorts plans without modifying them.', objectSchema({ projectId: projectIdSchema })),
  definition('validate_shorts_plan', 'Validate one shorts plan without changing it.', objectSchema({ planId: string(), projectId: projectIdSchema }, ['planId'])),
  definition('get_playback_state', 'Get bounded review playback state.', emptySchema),
  definition('list_export_options', 'List available transcript and shorts export options.', emptySchema),
  definition('validate_export', 'Run export preflight without creating files.', objectSchema({
    kind: { type: 'string', enum: ['transcript', 'shortsIdeas', 'shortsVideos'] },
    projectId: projectIdSchema,
  }, ['kind'])),
  definition('get_visual_editor_state', 'Get path-safe state for one shorts visual editor plan.', objectSchema({ planId: string(), projectId: projectIdSchema }, ['planId'])),
  definition('get_safe_settings', 'Get safe user preferences without secrets or MCP credentials.', emptySchema),
  definition('list_providers', 'List configured provider identifiers without exposing keys.', emptySchema),
  definition('list_prompt_presets', 'List prompt preset identifiers without exposing secret configuration.', emptySchema),
  definition('get_model_status', 'Get local model availability without filesystem paths.', emptySchema),
]);

const READ_TOOL_NAMES = Object.freeze(READ_TOOL_DEFINITIONS.map((tool) => tool.name));

const DEFAULT_HELP_TOPICS = Object.freeze([
  Object.freeze({
    topicId: 'getting-started',
    category: 'Getting Started',
    screen: 'workspace',
    title: 'Getting started',
    summary: 'Import a source, review the transcript, and export the finished result.',
    requirements: [],
    steps: ['Import an audio, video, or document source.', 'Review and correct the transcript.', 'Export the approved result.'],
    troubleshooting: [],
    relatedTopicIds: ['review-transcript', 'export-results'],
  }),
  Object.freeze({
    topicId: 'review-transcript',
    category: 'Transcript Review',
    screen: 'review',
    title: 'Review a transcript',
    summary: 'Use the chunk list and timed cues to inspect source and translated text.',
    requirements: ['An imported project'],
    steps: ['Select a chunk.', 'Compare source and translation.', 'Correct text before approval.'],
    troubleshooting: [],
    relatedTopicIds: ['getting-started'],
  }),
  Object.freeze({
    topicId: 'export-results',
    category: 'Export',
    screen: 'export',
    title: 'Export results',
    summary: 'Choose an output format after the transcript has been reviewed.',
    requirements: ['A project with reviewed chunks'],
    steps: ['Open Export.', 'Choose a format.', 'Run the export preflight and save the result.'],
    troubleshooting: [],
    relatedTopicIds: ['getting-started'],
  }),
]);

class ReadCatalogError extends Error {
  constructor(message, code = 'MCP_INVALID_REQUEST') {
    super(message);
    this.name = 'ReadCatalogError';
    this.mcpCode = code;
    this.status = 400;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asObject(value) {
  return isObject(value) ? value : {};
}

function clampInteger(value, fallback, minimum, maximum) {
  const candidate = Number.isInteger(value) ? value : fallback;
  return Math.min(maximum, Math.max(minimum, candidate));
}

function compactPreview(value, max = 180) {
  const compact = String(value ?? '').split(/\s+/u).filter(Boolean).join(' ');
  return compact.length <= max ? compact : `${compact.slice(0, max)}...`;
}

function stableClone(value) {
  if (Array.isArray(value)) return value.map(stableClone);
  if (!isObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) out[key] = stableClone(value[key]);
  }
  return out;
}

function safeClone(value, key = '') {
  if (/(?:pass(word)?|secret|token|api.?key|(?:openai|gemini|anthropic|xai|qwen).*key|credential)/i.test(key)) return undefined;
  if (Array.isArray(value)) return value.map((item) => safeClone(item, key));
  if (!isObject(value)) return value;
  const out = {};
  for (const [field, child] of Object.entries(value)) {
    if (/^(?:sourceFile|sourcePath|filePath|wavPath|originalVideoPath|assetPath|absolutePath|path)$/i.test(field)) continue;
    const cleaned = safeClone(child, field);
    if (cleaned !== undefined) out[field] = cleaned;
  }
  return out;
}

function camelCase(name) {
  return name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function readerCandidates(readers, name) {
  const camel = camelCase(name);
  const aliases = {
    list_projects: ['listProjects', 'projects'],
    get_project_summary: ['getProjectSummary', 'projectSummary'],
    get_project_state: ['getProjectState', 'projectState'],
    get_source_media_info: ['getSourceMediaInfo', 'sourceMediaInfo'],
    get_workflow_config: ['getWorkflowConfig', 'workflowConfig'],
    get_ui_state: ['getUiState', 'uiState'],
    get_processing_status: ['getProcessingStatus', 'processingStatus'],
    get_capabilities: ['getCapabilities', 'capabilities'],
    validate_active_project: ['validateActiveProject', 'validateProject'],
    list_chunks: ['listChunks', 'chunks'],
    get_chunk: ['getChunk', 'chunk'],
    get_chunk_cues: ['getChunkCues', 'chunkCues'],
    search_transcript: ['searchTranscript', 'transcriptSearch'],
    get_unrecognized_fragments: ['getUnrecognizedFragments', 'unrecognizedFragments'],
    list_translation_languages: ['listTranslationLanguages', 'translationLanguages'],
    list_glossary_entries: ['listGlossaryEntries', 'glossary'],
    search_glossary: ['searchGlossary'],
    export_glossary: ['exportGlossary'],
    get_document_state: ['getDocumentState', 'documentState'],
    get_document_selection: ['getDocumentSelection', 'documentSelection'],
    get_document_selection_context: ['getDocumentSelectionContext', 'documentSelectionContext'],
    list_help_topics: ['listHelpTopics', 'helpTopics'],
    get_help_topic: ['getHelpTopic', 'helpTopic'],
    search_help: ['searchHelp'],
    get_contextual_help: ['getContextualHelp', 'contextualHelp'],
    get_onboarding_checklist: ['getOnboardingChecklist', 'onboardingChecklist'],
  };
  return [name, camel, ...(aliases[name] || [])];
}

function findReader(options, name) {
  const readers = asObject(options.readers);
  const nested = [
    readers,
    asObject(readers.project),
    asObject(readers.transcript),
    asObject(readers.glossary),
    asObject(readers.document),
    asObject(readers.help),
    asObject(options),
  ];
  for (const container of nested) {
    for (const candidate of readerCandidates(readers, name)) {
      if (typeof container[candidate] === 'function') return container[candidate];
    }
  }
  return null;
}

function contextFor(options, args, handlerContext) {
  const params = asObject(args);
  const ctx = asObject(handlerContext);
  const project = asObject(options.project || options.activeProject);
  return {
    projectId: typeof params.projectId === 'string' ? params.projectId
      : typeof ctx.projectId === 'string' ? ctx.projectId
        : typeof options.projectId === 'string' ? options.projectId
          : typeof project.projectId === 'string' ? project.projectId
            : typeof project.id === 'string' ? project.id : null,
    projectRevision: params.projectRevision ?? ctx.projectRevision ?? options.projectRevision ?? options.revision ?? project.revision ?? null,
  };
}

function projectSummary(project, fallbackId = null) {
  const raw = asObject(project);
  const session = asObject(raw.session || raw.mediaState || raw.state);
  const chunks = Array.isArray(session.chunks) ? session.chunks : [];
  const id = raw.projectId || raw.id || fallbackId || null;
  return {
    id,
    name: raw.name || raw.metadata?.name || session.sourceFileName || 'Untitled Project',
    sourceFileName: raw.sourceFileName || raw.metadata?.sourceFileName || session.sourceFileName || '',
    updatedAt: raw.updatedAt || raw.metadata?.updatedAt || raw.createdAt || '',
    createdAt: raw.createdAt || raw.metadata?.createdAt || raw.updatedAt || '',
    currentIndex: Number.isInteger(raw.currentIndex) ? raw.currentIndex : Number.isInteger(session.currentChunkIndex) ? session.currentChunkIndex : 0,
    totalChunks: chunks.length,
    approvedChunks: chunks.filter((chunk) => Boolean(chunk && chunk.approved)).length,
    targetLang: raw.targetLang || raw.metadata?.targetLang || session.targetLang || '',
    type: raw.type || (raw.documentState ? 'document' : 'media'),
  };
}

function sourceSession(options, project) {
  const raw = asObject(project || options.project || options.activeProject);
  const session = asObject(options.session || raw.session || raw.mediaState || raw.state);
  return normalizeSessionView(session);
}

/**
 * Canonical read view of one media session: a deep clone normalized through
 * the shared module (strips the legacy selected field, resolves the active
 * language, projects the eager fields). The input object is never mutated,
 * so repeated reads are deep-equal to the stored source.
 */
function normalizeSessionView(session) {
  const clone = JSON.parse(JSON.stringify(session));
  return mediaTranslations.normalizeMediaSessionTranslations(clone);
}

/** Canonical read view of a whole project record (its session normalized). */
function projectView(project) {
  if (!isObject(project)) return project;
  const clone = JSON.parse(JSON.stringify(project));
  if (isObject(clone.session)) clone.session = normalizeSessionView(clone.session);
  return clone;
}
function projectRecordID(project, fallbackId = null) {
  const raw = asObject(project);
  return typeof raw.id === 'string' && raw.id.length > 0
    ? raw.id
    : typeof raw.projectId === 'string' && raw.projectId.length > 0
      ? raw.projectId
      : fallbackId;
}

function projectRecordMatches(project, projectId) {
  return Boolean(project && projectId && projectRecordID(project) === projectId);
}

function shortsPathField(key) {
  return /^(?:src|previewSrc|sourceFile|sourcePath|filePath|wavPath|originalVideoPath|assetPath|absolutePath|path)$/i.test(key);
}

function shortsSafeClone(value, key = '') {
  if (/(?:pass(word)?|secret|token|api.?key|credential)/i.test(key) || shortsPathField(key)) return undefined;
  if (typeof value === 'string') {
    return path.isAbsolute(value) || path.win32.isAbsolute(value) || /^file:\/\//iu.test(value) ? undefined : value;
  }
  if (Array.isArray(value)) return value.map((item) => shortsSafeClone(item, key));
  if (!isObject(value)) return value;
  const out = {};
  for (const [field, child] of Object.entries(value)) {
    const cleaned = shortsSafeClone(child, field);
    if (cleaned !== undefined) out[field] = cleaned;
  }
  return out;
}
function shortsProjectSession(project) {
  const raw = asObject(project);
  const stored = asObject(raw.session || raw.mediaState || raw.state);
  const session = { ...stored };
  if (!Object.prototype.hasOwnProperty.call(session, 'sourceMediaInfo') && isObject(raw.sourceMediaInfo)) {
    session.sourceMediaInfo = raw.sourceMediaInfo;
  }
  if (!Object.prototype.hasOwnProperty.call(session, 'durationSec') && Number.isFinite(raw.durationSec)) {
    session.durationSec = raw.durationSec;
  }
  return shortsState.normalizeShortsSessionState(session);
}

async function resolveShortsProject(options, args, handlerContext) {
  const params = asObject(args);
  const context = asObject(handlerContext);
  const explicitId = typeof params.projectId === 'string' && params.projectId.trim().length > 0
    ? params.projectId.trim()
    : null;
  const contextId = !explicitId && typeof context.projectId === 'string' && context.projectId.trim().length > 0
    ? context.projectId.trim()
    : null;
  const requestedId = explicitId || contextId;
  let project = null;

  if (typeof options.resolveShortsProject === 'function') {
    try {
      project = await options.resolveShortsProject(requestedId || undefined);
    } catch {
      project = null;
    }
  } else if (requestedId) {
    if (projectRecordMatches(options.project, requestedId)) project = options.project;
    else if (projectRecordMatches(options.activeProject, requestedId)) project = options.activeProject;
    else if (Array.isArray(options.projects)) project = options.projects.find((candidate) => projectRecordMatches(candidate, requestedId)) || null;
    else {
      project = loadProject({ ...options, project: null, activeProject: null }, requestedId);
    }
  } else if (isObject(options.project)) {
    project = options.project;
  } else if (isObject(options.activeProject)) {
    project = options.activeProject;
  }
  if (project && requestedId && projectRecordID(project) !== requestedId) {
    project = null;
  }
  const projectId = projectRecordID(project, requestedId);
  if (!project || !projectId) {
    throw new ReadCatalogError(
      requestedId ? `ENTITY_NOT_FOUND: Unknown projectId ${requestedId}` : 'NO_ACTIVE_PROJECT: No project is open',
      'MCP_NOT_FOUND',
    );
  }
  return { project, projectId, session: shortsProjectSession(project) };
}

function shortsPlanProjectionForSession(plan, session) {
  return plan?.languageMode === 'target' || plan?.languageMode === 'bilingual'
    ? shortsState.activeShortsPlanProjection(plan, session.activeTranslationLanguage)
    : shortsState.sourceShortsPlanProjection(plan);
}

function shortsPlanRange(plan) {
  const start = shortsState.parseShortsTimestamp(plan?.start);
  const end = shortsState.parseShortsTimestamp(plan?.end);
  return {
    startSec: start.ok ? start.seconds : null,
    endSec: end.ok ? end.seconds : null,
  };
}

function shortsVisualSummary(plan) {
  return {
    cutCount: Array.isArray(plan?.timelineCuts) ? plan.timelineCuts.length : 0,
    sourceSubtitleCount: Array.isArray(plan?.sourceAlignment) ? plan.sourceAlignment.length : 0,
    targetSubtitleCount: Array.isArray(plan?.targetAlignment) ? plan.targetAlignment.length : 0,
    sourceTextTrackCount: Array.isArray(plan?.sourceTextTracks) ? plan.sourceTextTracks.length : 0,
    targetTextTrackCount: Array.isArray(plan?.targetTextTracks) ? plan.targetTextTracks.length : 0,
    sourceAudioTrackCount: Array.isArray(plan?.sourceAudioTracks) ? plan.sourceAudioTracks.length : 0,
    targetAudioTrackCount: Array.isArray(plan?.targetAudioTracks) ? plan.targetAudioTracks.length : 0,
    syncEnabled: plan?.syncEnabled !== false,
  };
}

function shortsPlanSummary(plan, index, session, rejected = false) {
  const projection = shortsPlanProjectionForSession(plan, session);
  const range = shortsPlanRange(plan);
  const archive = isObject(plan?.translationsByLanguage) ? plan.translationsByLanguage : {};
  const translationLanguages = Object.values(archive)
    .map((variant) => variant?.language)
    .filter((language) => typeof language === 'string' && language.trim().length > 0)
    .sort();
  return shortsSafeClone({
    id: plan?.stableID || null,
    displayNumber: index + 1,
    arrayIndex: index,
    rejected,
    start: plan?.start || '',
    end: plan?.end || '',
    startSec: range.startSec,
    endSec: range.endSec,
    title: projection.available ? projection.title : '',
    summary: projection.available ? projection.summary : '',
    hook: projection.available ? projection.hook : '',
    category: projection.available ? projection.category : '',
    captionText: projection.available ? projection.captionText : '',
    languageMode: plan?.languageMode || '',
    translationLanguages,
    visualEditor: shortsVisualSummary(plan),
  });
}

function shortsSubtitleSegments(segments) {
  return (Array.isArray(segments) ? segments : []).map((segment, index) => ({
    segmentId: segment?.id || segment?.stableID || `segment-${index}`,
    startSec: Number.isFinite(segment?.startSec) ? segment.startSec : Number.isFinite(segment?.start) ? segment.start : 0,
    endSec: Number.isFinite(segment?.endSec) ? segment.endSec : Number.isFinite(segment?.end) ? segment.end : 0,
    text: typeof segment?.text === 'string' ? segment.text : '',
  }));
}

function shortsFrameKeyframes(keyframes) {
  return (Array.isArray(keyframes) ? keyframes : []).map((frame, index) => ({
    keyframeId: frame?.id || frame?.stableID || `frame-${index}`,
    timeSec: Number.isFinite(frame?.timeSec) ? frame.timeSec : Number.isFinite(frame?.time) ? frame.time : 0,
    x: Number.isFinite(frame?.x) ? frame.x : 0,
    y: Number.isFinite(frame?.y) ? frame.y : 0,
    zoom: Number.isFinite(frame?.zoom) ? frame.zoom : 1,
    backgroundColor: typeof frame?.backgroundColor === 'string' ? frame.backgroundColor : '',
  }));
}

function shortsLogoState(logo) {
  if (!isObject(logo)) return { present: false };
  return {
    present: true,
    logoId: logo.id || logo.stableID || '',
    name: logo.name || '',
    size: logo.size ?? 0,
    opacity: logo.opacity ?? 0,
    position: logo.position || '',
    hidden: logo.hidden === true,
  };
}

function shortsTextTracks(tracks) {
  return (Array.isArray(tracks) ? tracks : []).map((track, index) => ({
    trackId: track?.id || track?.stableID || `track-${index}`,
    name: track?.name || '',
    hidden: track?.hidden === true,
    muted: track?.muted === true,
    blocks: (Array.isArray(track?.blocks) ? track.blocks : []).map((block, blockIndex) => ({
      blockId: block?.id || block?.stableID || `block-${blockIndex}`,
      startSec: Number.isFinite(block?.startSec) ? block.startSec : 0,
      endSec: Number.isFinite(block?.endSec) ? block.endSec : 0,
      text: typeof block?.text === 'string' ? block.text : '',
      hidden: block?.hidden === true,
    })),
  }));
}

function shortsAudioTracks(tracks) {
  return (Array.isArray(tracks) ? tracks : []).map((track, index) => ({
    audioTrackId: track?.id || track?.stableID || `audio-${index}`,
    name: track?.name || '',
    startSec: Number.isFinite(track?.startSec) ? track.startSec : 0,
    trimStartSec: Number.isFinite(track?.trimStartSec) ? track.trimStartSec : 0,
    trimEndSec: Number.isFinite(track?.trimEndSec) ? track.trimEndSec : 0,
    volume: Number.isFinite(track?.volume) ? track.volume : 1,
    fadeInSec: Number.isFinite(track?.fadeInSec) ? track.fadeInSec : 0,
    fadeOutSec: Number.isFinite(track?.fadeOutSec) ? track.fadeOutSec : 0,
    muted: track?.muted === true,
    assetDurationSec: Number.isFinite(track?.assetDurationSec) ? track.assetDurationSec : 0,
  }));
}

function shortsOverlayState(overlay) {
  if (!isObject(overlay)) return { present: false };
  return {
    present: true,
    overlayId: overlay.id || overlay.stableID || '',
    name: overlay.name || '',
    duration: overlay.duration ?? 0,
    x: overlay.x ?? 0,
    y: overlay.y ?? 0,
    scale: overlay.scale ?? 1,
    animation: overlay.animation || 'none',
    hidden: overlay.hidden === true,
    speed: overlay.speed ?? 1,
    transitionSec: overlay.transitionSec ?? 0,
  };
}

function shortsVisualLanguageState(plan, language) {
  const source = language === 'source';
  return {
    subtitleSegments: shortsSubtitleSegments(source ? plan?.sourceAlignment : plan?.targetAlignment),
    frameKeyframes: shortsFrameKeyframes(source ? plan?.sourceFrameKeyframes : plan?.targetFrameKeyframes),
    logo: shortsLogoState(source ? plan?.sourceLogo || plan?.logo : plan?.targetLogo || plan?.logo),
    textTracks: shortsTextTracks(source ? plan?.sourceTextTracks || plan?.textTracks : plan?.targetTextTracks || plan?.textTracks),
    audioTracks: shortsAudioTracks(source ? plan?.sourceAudioTracks || plan?.audioTracks : plan?.targetAudioTracks || plan?.audioTracks),
    intro: shortsOverlayState(source ? plan?.sourceIntro || plan?.intro : plan?.targetIntro || plan?.intro),
    outro: shortsOverlayState(source ? plan?.sourceOutro || plan?.outro : plan?.targetOutro || plan?.outro),
  };
}

function shortsVisualEditorState(plan, index, session) {
  const range = shortsPlanRange(plan);
  const duration = range.startSec !== null && range.endSec !== null ? Math.max(0, range.endSec - range.startSec) : 0;
  return shortsSafeClone({
    plan: shortsPlanSummary(plan, index, session, false),
    clipDurationSec: duration,
    timeline: {
      cuts: (Array.isArray(plan?.timelineCuts) ? plan.timelineCuts : []).map((cut, cutIndex) => ({
        cutId: cut?.stableID || `cut-${cutIndex}`,
        startSec: cut?.startSec ?? 0,
        endSec: cut?.endSec ?? 0,
      })),
      trim: {
        trimStartSec: plan?.timelineTrim?.trimStartSec ?? 0,
        trimEndSec: plan?.timelineTrim?.trimEndSec ?? 0,
      },
    },
    source: shortsVisualLanguageState(plan, 'source'),
    target: shortsVisualLanguageState(plan, 'target'),
    background: shortsSafeClone(plan?.backgroundSettings || {}),
    subtitleStyle: shortsSafeClone(plan?.subtitleStyle || {}),
    syncEnabled: plan?.syncEnabled ?? (plan?.languageMode === 'bilingual'),
    assetPolicy: 'MCP never accepts source paths. Add image, video, or audio assets through the Visual Editor file picker, then address the returned existing asset ID here.',
  });
}

/**
 * Exact translation lookup for publication: an explicitly requested language
 * resolves to exactly that variant text or empty; without one the canonical
 * active variant is used. Never a fallback to another language.
 */
function translationFor(chunk, session, language) {
  if (!isObject(chunk)) return '';
  const variant = mediaTranslations.resolveChunkVariant(
    chunk,
    typeof language === 'string' ? language : undefined,
    typeof session.activeTranslationLanguage === 'string' ? session.activeTranslationLanguage : ''
  );
  return variant ? variant.text : '';
}

/** Cue count from the exact requested (or canonical active) variant. */
function translationCueCount(chunk, session, language) {
  if (!isObject(chunk)) return 0;
  const variant = mediaTranslations.resolveChunkVariant(
    chunk,
    typeof language === 'string' ? language : undefined,
    typeof session.activeTranslationLanguage === 'string' ? session.activeTranslationLanguage : ''
  );
  return Array.isArray(variant?.cues) ? variant.cues.length : 0;
}

function chunkId(chunk, arrayIndex) {
  if (typeof chunk?.chunkId === 'string' && chunk.chunkId.length > 0) return chunk.chunkId;
  if (Number.isInteger(chunk?.index)) return `chunk-${chunk.index}`;
  return `chunk-${arrayIndex}`;
}

function chunkSummary(chunk, arrayIndex, session) {
  const original = typeof chunk?.original === 'string' ? chunk.original : '';
  const translated = translationFor(chunk, session);
  return {
    chunkId: chunkId(chunk, arrayIndex),
    chunkIndex: arrayIndex,
    displayNumber: Number.isInteger(chunk?.index) ? chunk.index + 1 : arrayIndex + 1,
    startSec: Number.isFinite(chunk?.startSec) ? chunk.startSec : 0,
    endSec: Number.isFinite(chunk?.endSec) ? chunk.endSec : 0,
    durationSec: Number.isFinite(chunk?.durationSec) ? chunk.durationSec : Math.max(0, (chunk?.endSec || 0) - (chunk?.startSec || 0)),
    status: typeof chunk?.status === 'string' ? chunk.status : 'pending',
    approved: Boolean(chunk?.approved),
    originalPreview: compactPreview(original),
    translatedPreview: compactPreview(translated),
  };
}

function resolveChunk(chunks, args) {
  const params = asObject(args);
  if (typeof params.chunkId === 'string' && params.chunkId.length > 0) {
    const index = chunks.findIndex((candidate, position) => chunkId(candidate, position) === params.chunkId);
    if (index >= 0) return { index, chunk: chunks[index] };
  }
  if (Number.isInteger(params.chunkIndex) && chunks[params.chunkIndex]) {
    return { index: params.chunkIndex, chunk: chunks[params.chunkIndex] };
  }
  return null;
}

function cueItems(chunk, side, language, arrayIndex, resolvedCues) {
  const cues = side === 'translated'
    ? (Array.isArray(resolvedCues) ? resolvedCues : [])
    : (Array.isArray(chunk?.originalCues) ? chunk.originalCues : []);
  return cues.map((cue, index) => ({
    cueId: `${chunkId(chunk, arrayIndex)}-${side}-cue-${index}`,
    cueIndex: index,
    startSec: Number.isFinite(cue?.startSec) ? cue.startSec : 0,
    endSec: Number.isFinite(cue?.endSec) ? cue.endSec : 0,
    text: typeof cue?.text === 'string' ? cue.text : '',
    wordCount: Array.isArray(cue?.words) ? cue.words.length : 0,
    ...(language ? { language } : {}),
  }));
}

function searchRanges(text, query, caseSensitive, wholeWord) {
  if (!query) return [];
  const source = caseSensitive ? text : text.toLocaleLowerCase();
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const ranges = [];
  let offset = 0;
  while (offset <= source.length - needle.length) {
    const index = source.indexOf(needle, offset);
    if (index < 0) break;
    const before = index === 0 ? '' : text[index - 1];
    const after = text[index + needle.length] || '';
    const boundary = !wholeWord || (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after));
    if (boundary) ranges.push({ start: index, length: needle.length });
    offset = index + Math.max(1, needle.length);
  }
  return ranges;
}

function snippet(text, start, length, padding = 70) {
  const from = Math.max(0, start - padding);
  const to = Math.min(text.length, start + length + padding);
  return `${from > 0 ? '...' : ''}${compactPreview(text.slice(from, to), padding * 2)}${to < text.length ? '...' : ''}`;
}

function defaultProjectStore(options) {
  if (options.projectStore) return options.projectStore;
  // eslint-disable-next-line global-require
  const stores = require('../../projects/projectStore.js');
  if (typeof options.baseDir === 'string' && options.baseDir.length > 0) {
    return new stores.ProjectStore({ baseDir: options.baseDir });
  }
  return stores.defaultProjectStore;
}

function loadProject(options, projectId) {
  if (isObject(options.project)) return options.project;
  if (isObject(options.activeProject) && (!projectId || options.activeProject.id === projectId || options.activeProject.projectId === projectId)) {
    return options.activeProject;
  }
  const store = defaultProjectStore(options);
  if (store && typeof store.loadProject === 'function' && typeof projectId === 'string' && projectId.length > 0) {
    try { return store.loadProject(projectId); } catch { return null; }
  }
  return null;
}

function listStoredProjects(options) {
  if (Array.isArray(options.projects)) return options.projects;
  const store = defaultProjectStore(options);
  if (!store || typeof store.baseDirPath !== 'function') return [];
  let root;
  try { root = store.baseDirPath(); } catch { return []; }
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try { return store.loadProject(entry.name); } catch { return null; }
    })
    .filter(Boolean);
}

function glossaryEntries(options, project) {
  const rawProject = asObject(project || options.project || options.activeProject);
  const settings = asObject(options.settings);
  if (Array.isArray(options.glossary)) return options.glossary;
  if (Array.isArray(rawProject.glossary)) return rawProject.glossary;
  if (Array.isArray(settings.glossary)) return settings.glossary;
  return [];
}

function helpTopics(options) {
  return Array.isArray(options.helpTopics) ? options.helpTopics : Array.from(DEFAULT_HELP_TOPICS);
}

function safeSettings(options) {
  return safeClone(options.settings || {}) || {};
}

// Native parity for list_export_options / validate_export lives in
// WorkflowStore.mcpExportOptions / mcpValidateExport.  Session truth arrives
// as an injected async readiness snapshot so both tools stay pure projections
// over the same envelope as every other read handler.
const EXPORT_VIDEO_EXTENSIONS = Object.freeze(['.mp4', '.mov', '.webm', '.mkv', '.m4v']);
const EXPORT_DESTINATION_POLICY = 'Files are written only to VaniScript/MCP Exports and returned by exportId.';

function snapshotCount(value) {
  return Number.isFinite(value) ? value : 0;
}

function exportSourceVideoPath(readiness) {
  return typeof readiness.sourceVideoPath === 'string' && readiness.sourceVideoPath.length > 0 ? readiness.sourceVideoPath : null;
}

async function exportReadiness(options) {
  if (typeof options.exportReadiness !== 'function') {
    throw new ReadCatalogError('Export readiness is unavailable; inject an options.exportReadiness reader.', 'MCP_CAPABILITY_UNAVAILABLE');
  }
  return options.exportReadiness();
}

/** Nested native option shape; a missing/null snapshot publishes only unavailable groups. */
function exportOptionsData(snapshot) {
  const readiness = asObject(snapshot);
  const hasPlans = snapshotCount(readiness.shortsPlanCount) > 0;
  const sourceVideoPath = exportSourceVideoPath(readiness);
  return {
    transcript: {
      available: readiness.sessionAvailable === true,
      sides: ['original', 'translated'],
      formats: ['txt', 'markdown', 'srt', 'vtt'],
    },
    shortsIdeas: { available: hasPlans, languages: ['source', 'target'] },
    shortsVideos: {
      available: hasPlans && sourceVideoPath !== null,
      formats: ['mp4', 'mov'],
      resolutions: ['source', '1080p', '720p'],
      frameRates: ['source', '30', '25', '24'],
    },
    destinationPolicy: EXPORT_DESTINATION_POLICY,
  };
}

/**
 * Export preflight mirroring mcpValidateExport: unknown kinds fail typed
 * INVALID_REQUEST (native -2), a closed session fails typed NOT_FOUND with
 * the native -1 message, and SOURCE_MEDIA_MISSING short-circuits the video
 * checks exactly like the native early return.
 */
function validateExportData(kind, snapshot) {
  const readiness = asObject(snapshot);
  if (readiness.sessionAvailable !== true) {
    throw new ReadCatalogError('NO_ACTIVE_PROJECT: No project is open', 'MCP_NOT_FOUND');
  }
  const issues = [];
  if (kind === 'transcript') {
    if (snapshotCount(readiness.chunkCount) === 0) issues.push({ severity: 'error', code: 'NO_CHUNKS', message: 'The project has no segments.' });
    if (snapshotCount(readiness.originalNonEmptyCount) === 0) issues.push({ severity: 'error', code: 'EMPTY_TRANSCRIPT', message: 'The project has no transcript text.' });
  } else if (kind === 'shortsIdeas' || kind === 'shortsVideos') {
    if (snapshotCount(readiness.shortsPlanCount) === 0) issues.push({ severity: 'error', code: 'NO_SHORTS_PLANS', message: 'Create Shorts plans first.' });
    if (kind === 'shortsVideos') {
      const sourceVideoPath = exportSourceVideoPath(readiness);
      // Main computes sourceVideoExists via fs.existsSync after the renderer
      // publishes the path string; absent or false both fail closed.
      if (sourceVideoPath === null || readiness.sourceVideoExists !== true) {
        issues.push({ severity: 'error', code: 'SOURCE_MEDIA_MISSING', message: 'Original source video is unavailable.' });
        return { valid: false, kind, issues };
      }
      if (!EXPORT_VIDEO_EXTENSIONS.includes(path.extname(sourceVideoPath).toLowerCase())) {
        issues.push({ severity: 'error', code: 'VIDEO_REQUIRED', message: 'Shorts video export requires video source media.' });
      }
    }
  } else {
    throw new ReadCatalogError('kind must be transcript, shortsIdeas, or shortsVideos');
  }
  return { valid: !issues.some((issue) => issue.severity === 'error'), kind, issues };
}

function callReader(options, toolName, args, context, fallback) {
  const reader = findReader(options, toolName);
  if (!reader) return Promise.resolve(fallback());
  return Promise.resolve(reader(args, context)).then((value) => value === undefined ? fallback() : value);
}

function makeEnvelope(toolName, data, context) {
  const projectId = context.projectId ?? (isObject(data) && typeof data.projectId === 'string' ? data.projectId : null);
  const projectRevision = context.projectRevision ?? (isObject(data) ? data.projectRevision ?? null : null);
  return stableClone({
    schemaVersion: READ_SCHEMA_VERSION,
    tool: toolName,
    scope: READ_SCOPE,
    risk: READ_RISK,
    projectId: projectId == null ? null : projectId,
    projectRevision: projectRevision == null ? null : projectRevision,
    data,
  });
}

function createReadCatalog(options = {}) {
  const settings = asObject(options);
  const handlers = {};
  const handlerFor = (toolName, fallback) => async (args = {}, handlerContext = {}) => {
    const params = asObject(args);
    const context = contextFor(settings, params, handlerContext);
    const data = await callReader(settings, toolName, params, context, () => fallback(params, context));
    return makeEnvelope(toolName, data, context);
  };

  // Shorts reads are a single Main-side path. Renderer reader injections and
  // options.session are deliberately bypassed so project isolation cannot be
  // overridden by global or stale state.
  const shortsHandlerFor = (toolName, fallback) => async (args = {}, handlerContext = {}) => {
    const params = asObject(args);
    const suppliedContext = asObject(handlerContext);
    const context = {
      projectId: typeof params.projectId === 'string' && params.projectId.trim().length > 0
        ? params.projectId.trim()
        : typeof suppliedContext.projectId === 'string' && suppliedContext.projectId.trim().length > 0
          ? suppliedContext.projectId.trim()
          : null,
      projectRevision: suppliedContext.projectRevision ?? settings.projectRevision ?? settings.revision ?? null,
    };
    const data = await fallback(params, context);
    return makeEnvelope(toolName, data, context);
  };
  handlers.list_projects = handlerFor('list_projects', (args) => {
    const all = listStoredProjects(settings)
      .map((project) => projectSummary(project))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(a.id).localeCompare(String(b.id)));
    const cursor = clampInteger(args.cursor, 0, 0, all.length);
    const limit = clampInteger(args.limit, 30, 1, 100);
    const page = all.slice(cursor, cursor + limit);
    return {
      projects: page,
      cursor,
      nextCursor: cursor + page.length < all.length ? cursor + page.length : null,
      hasMore: cursor + page.length < all.length,
      total: all.length,
      activeProjectId: settings.projectId || settings.activeProject?.id || settings.activeProject?.projectId || null,
    };
  });

  handlers.get_project_summary = handlerFor('get_project_summary', (args, context) => {
    const project = loadProject(settings, args.projectId || context.projectId);
    const summary = project ? projectSummary(project, args.projectId || context.projectId) : null;
    return {
      project: summary,
      isActive: Boolean(summary && (summary.id === (settings.projectId || context.projectId))),
    };
  });

  handlers.get_project_state = handlerFor('get_project_state', (args, context) => {
    const project = loadProject(settings, args.projectId || context.projectId);
    return {
      projectId: context.projectId,
      projectRevision: context.projectRevision,
      active: Boolean(project),
      project: project ? safeClone(projectView(project)) : null,
    };
  });

  handlers.get_source_media_info = handlerFor('get_source_media_info', (args, context) => {
    const project = loadProject(settings, args.projectId || context.projectId);
    const raw = asObject(project);
    const session = sourceSession(settings, project);
    return safeClone(settings.sourceMediaInfo || raw.sourceMediaInfo || session.sourceMediaInfo || {
      sourceFileName: session.sourceFileName || raw.sourceFileName || '',
      durationSec: Number.isFinite(session.durationSec) ? session.durationSec : 0,
      kind: session.sourceMediaKind || raw.sourceMediaKind || null,
    });
  });

  handlers.get_workflow_config = handlerFor('get_workflow_config', (args, context) => {
    const project = loadProject(settings, args.projectId || context.projectId);
    const session = sourceSession(settings, project);
    return {
      sourceLanguage: session.sourceLang || settings.defaultSourceLang || '',
      targetLanguage: session.targetLang || settings.defaultTargetLang || '',
      transcriptionProvider: session.transcriptionProvider || settings.transcriptionProvider || '',
      translationProvider: session.translationProvider || settings.translationProvider || '',
      outputFormats: Array.isArray(session.outputFormats) ? session.outputFormats : [],
      chunkDurationMin: settings.chunkDurationMin ?? null,
      sliceMode: settings.sliceMode || null,
    };
  });

  handlers.get_ui_state = handlerFor('get_ui_state', (args, context) => {
    const project = loadProject(settings, args.projectId || context.projectId);
    const session = sourceSession(settings, project);
    const chunks = Array.isArray(session.chunks) ? session.chunks : [];
    return {
      screen: settings.screen || project?.screen || 'workspace',
      hasSource: Boolean(session.sourceFileName || session.sourceFile),
      sourceFileName: session.sourceFileName || '',
      durationSec: Number.isFinite(session.durationSec) ? session.durationSec : 0,
      hasActiveSession: Boolean(project || settings.session),
      selectedTranslationLanguage: typeof session.activeTranslationLanguage === 'string' ? session.activeTranslationLanguage : '',
      availableTranslationLanguages: Array.isArray(session.availableTranslationLanguages) ? session.availableTranslationLanguages : [],
      chunkCount: chunks.length,
      approvedChunkCount: chunks.filter((chunk) => Boolean(chunk?.approved)).length,
      currentChunkIndex: Number.isInteger(session.currentChunkIndex) ? session.currentChunkIndex : 0,
    };
  });

  handlers.get_processing_status = handlerFor('get_processing_status', (args, context) => {
    const project = loadProject(settings, args.projectId || context.projectId);
    const session = sourceSession(settings, project);
    const chunks = Array.isArray(session.chunks) ? session.chunks : [];
    const currentIndex = Number.isInteger(session.currentChunkIndex) ? session.currentChunkIndex : 0;
    const current = chunks[currentIndex];
    const failedChunks = chunks.filter((chunk) => chunk?.status === 'error').length;
    const completedChunks = chunks.filter((chunk) => chunk?.status === 'done').length;
    return {
      state: current?.status === 'processing' ? 'running' : current?.status === 'error' ? 'error' : completedChunks === chunks.length && chunks.length > 0 ? 'completed' : 'idle',
      progress: chunks.length > 0 ? completedChunks / chunks.length : 0,
      totalChunks: chunks.length,
      completedChunks,
      failedChunks,
      currentChunkId: current ? chunkId(current, currentIndex) : null,
      currentChunkStatus: current?.status || null,
    };
  });

  handlers.get_capabilities = handlerFor('get_capabilities', () => ({
    scope: READ_SCOPE,
    availableToolCount: READ_TOOL_DEFINITIONS.length,
    tools: READ_TOOL_NAMES,
    requiredCapabilities: ['mcp.read'],
    groups: ['project', 'transcript', 'glossary', 'document', 'help'],
  }));

  handlers.validate_active_project = handlerFor('validate_active_project', (args, context) => {
    const project = loadProject(settings, args.projectId || context.projectId);
    const session = sourceSession(settings, project);
    const chunks = Array.isArray(session.chunks) ? session.chunks : [];
    const issues = [];
    chunks.forEach((chunk, index) => {
      if (!Number.isFinite(chunk?.startSec) || !Number.isFinite(chunk?.endSec) || chunk.endSec <= chunk.startSec) {
        issues.push({ severity: 'error', code: 'INVALID_CHUNK_RANGE', chunkId: chunkId(chunk, index) });
      }
      if (chunk?.status === 'done' && !String(chunk.original || '').trim()) {
        issues.push({ severity: 'warning', code: 'EMPTY_TRANSCRIPT', chunkId: chunkId(chunk, index) });
      }
    });
    return { valid: !issues.some((issue) => issue.severity === 'error'), issueCount: issues.length, issues, chunkCount: chunks.length };
  });

  function chunksFor(args, context) {
    const project = loadProject(settings, args.projectId || context.projectId);
    const session = sourceSession(settings, project);
    return { project, session, chunks: Array.isArray(session.chunks) ? session.chunks : [] };
  }

  handlers.list_chunks = handlerFor('list_chunks', (args, context) => {
    const { session, chunks } = chunksFor(args, context);
    const filtered = chunks.map((chunk, index) => ({ chunk, index })).filter(({ chunk }) => (
      (typeof args.status !== 'string' || chunk?.status === args.status) &&
      (typeof args.approved !== 'boolean' || Boolean(chunk?.approved) === args.approved)
    ));
    const cursor = clampInteger(args.cursor, 0, 0, filtered.length);
    const limit = clampInteger(args.limit, 20, 1, 100);
    const page = filtered.slice(cursor, cursor + limit);
    return {
      chunks: page.map(({ chunk, index }) => chunkSummary(chunk, index, session)),
      cursor,
      nextCursor: cursor + page.length < filtered.length ? cursor + page.length : null,
      hasMore: cursor + page.length < filtered.length,
      totalMatching: filtered.length,
      totalChunks: chunks.length,
    };
  });

  handlers.get_chunk = handlerFor('get_chunk', (args, context) => {
    const { session, chunks } = chunksFor(args, context);
    const resolved = resolveChunk(chunks, args);
    if (!resolved) return { chunk: null, chunkIndex: null };
    const chunk = resolved.chunk;
    return {
      ...chunkSummary(chunk, resolved.index, session),
      original: typeof chunk.original === 'string' ? chunk.original : '',
      translated: translationFor(chunk, session, args.language),
      selectedTranslationLanguage: typeof session.activeTranslationLanguage === 'string' ? session.activeTranslationLanguage : '',
      availableTranslationLanguages: Array.isArray(session.availableTranslationLanguages) ? session.availableTranslationLanguages : [],
      unrecognizedFragments: Array.isArray(chunk.unrecognizedFragments) ? chunk.unrecognizedFragments : [],
      originalCueCount: Array.isArray(chunk.originalCues) ? chunk.originalCues.length : 0,
      translationCueCount: translationCueCount(chunk, session, args.language),
    };
  });

  handlers.get_chunk_cues = handlerFor('get_chunk_cues', (args, context) => {
    const { session, chunks } = chunksFor(args, context);
    const resolved = resolveChunk(chunks, args);
    const requestedLanguage = typeof args.language === 'string' && args.language.length > 0 ? args.language : '';
    const activeLanguage = typeof session.activeTranslationLanguage === 'string' ? session.activeTranslationLanguage : '';
    const side = args.side === 'translated' ? 'translated' : 'original';
    const variant = side === 'translated'
      ? mediaTranslations.resolveChunkVariant(resolved?.chunk, requestedLanguage || undefined, activeLanguage || undefined)
      : null;
    const cues = resolved
      ? cueItems(resolved.chunk, side, side === 'translated' ? (requestedLanguage || activeLanguage) : session.sourceLang || '', resolved.index, variant?.cues)
      : [];
    return {
      chunkId: resolved ? chunkId(resolved.chunk, resolved.index) : null,
      displayNumber: resolved ? (Number.isInteger(resolved.chunk.index) ? resolved.chunk.index + 1 : resolved.index + 1) : null,
      side,
      language: side === 'translated' ? requestedLanguage || activeLanguage : session.sourceLang || '',
      cues,
      count: cues.length,
    };
  });

  handlers.search_transcript = handlerFor('search_transcript', (args, context) => {
    const { session, chunks } = chunksFor(args, context);
    const query = typeof args.query === 'string' ? args.query.slice(0, 500) : '';
    const side = ['all', 'original', 'translated'].includes(args.side) ? args.side : 'all';
    const caseSensitive = args.caseSensitive === true;
    const wholeWord = args.wholeWord === true;
    const limit = clampInteger(args.limit, 50, 1, 100);
    const matches = [];
    let truncated = false;
    outer: for (const [index, chunk] of chunks.entries()) {
      const candidates = [
        ['original', typeof chunk?.original === 'string' ? chunk.original : ''],
        ['translated', translationFor(chunk, session, args.language)],
      ];
      for (const [candidateSide, text] of candidates) {
        if (side !== 'all' && side !== candidateSide) continue;
        for (const range of searchRanges(text, query, caseSensitive, wholeWord)) {
          if (matches.length >= limit) {
            truncated = true;
            break outer;
          }
          matches.push({
            chunkId: chunkId(chunk, index),
            chunkIndex: index,
            displayNumber: Number.isInteger(chunk?.index) ? chunk.index + 1 : index + 1,
            side: candidateSide,
            startSec: Number.isFinite(chunk?.startSec) ? chunk.startSec : 0,
            endSec: Number.isFinite(chunk?.endSec) ? chunk.endSec : 0,
            matchStart: range.start,
            matchLength: range.length,
            snippet: snippet(text, range.start, range.length),
          });
        }
      }
    }
    return { query, side, matches, matchCount: matches.length, truncated, limit };
  });

  handlers.get_unrecognized_fragments = handlerFor('get_unrecognized_fragments', (args, context) => {
    const { session, chunks } = chunksFor(args, context);
    const selected = typeof args.chunkId === 'string'
      ? chunks.map((chunk, index) => ({ chunk, index })).filter(({ chunk, index }) => chunkId(chunk, index) === args.chunkId)
      : chunks.map((chunk, index) => ({ chunk, index }));
    const items = selected.map(({ chunk, index }) => ({
      chunkId: chunkId(chunk, index),
      chunkIndex: index,
      displayNumber: Number.isInteger(chunk?.index) ? chunk.index + 1 : index + 1,
      fragments: Array.isArray(chunk?.unrecognizedFragments) ? chunk.unrecognizedFragments : [],
    })).filter((item) => item.fragments.length > 0).map((item) => ({ ...item, count: item.fragments.length }));
    return { chunks: items, affectedChunkCount: items.length, fragmentCount: items.reduce((sum, item) => sum + item.count, 0), sourceLanguage: session.sourceLang || '' };
  });

  handlers.list_translation_languages = handlerFor('list_translation_languages', (args, context) => {
    const project = loadProject(settings, args.projectId || context.projectId);
    const session = sourceSession(settings, project);
    const availableLanguages = Array.isArray(session.availableTranslationLanguages) ? session.availableTranslationLanguages : [];
    return {
      activeLanguage: typeof session.activeTranslationLanguage === 'string' ? session.activeTranslationLanguage : '',
      availableLanguages,
      supportedLanguages: Array.isArray(settings.supportedLanguages) ? settings.supportedLanguages : [],
      targetLanguage: session.targetLang || '',
      translationProvider: session.translationProvider || '',
    };
  });

  handlers.list_glossary_entries = handlerFor('list_glossary_entries', (args, context) => {
    const project = loadProject(settings, args.projectId || context.projectId);
    let entries = glossaryEntries(settings, project).map((entry) => safeClone(entry)).filter(Boolean);
    if (typeof args.category === 'string' && args.category.length > 0) entries = entries.filter((entry) => entry.category === args.category);
    const cursor = clampInteger(args.cursor, 0, 0, entries.length);
    const limit = clampInteger(args.limit, 50, 1, 200);
    const page = entries.slice(cursor, cursor + limit);
    return { entries: page, cursor, nextCursor: cursor + page.length < entries.length ? cursor + page.length : null, hasMore: cursor + page.length < entries.length, total: entries.length };
  });

  handlers.search_glossary = handlerFor('search_glossary', (args, context) => {
    const project = loadProject(settings, args.projectId || context.projectId);
    const query = typeof args.query === 'string' ? args.query.trim().toLocaleLowerCase() : '';
    const limit = clampInteger(args.limit, 50, 1, 100);
    const entries = glossaryEntries(settings, project).map((entry) => safeClone(entry)).filter(Boolean).filter((entry) => {
      if (!query) return true;
      return JSON.stringify(entry).toLocaleLowerCase().includes(query);
    }).slice(0, limit);
    return { query: args.query || '', entries, matches: entries, matchCount: entries.length, limit };
  });

  handlers.export_glossary = handlerFor('export_glossary', (args, context) => {
    const project = loadProject(settings, args.projectId || context.projectId);
    return { schema: 'vaniscript-glossary-v1', entries: glossaryEntries(settings, project).map((entry) => safeClone(entry)).filter(Boolean) };
  });

  function documentFor(args, context) {
    const projectId = args.projectId || context.projectId;
    if (settings.documentProject && typeof settings.documentProject.loadDocumentProject === 'function') {
      try { return settings.documentProject.loadDocumentProject(projectId); } catch { return null; }
    }
    if (settings.documentStore && typeof settings.documentStore.loadDocumentProject === 'function') {
      try { return settings.documentStore.loadDocumentProject(projectId); } catch { return null; }
    }
    const project = loadProject(settings, projectId);
    const raw = asObject(project);
    return raw.documentState || raw.document || null;
  }

  handlers.get_document_state = handlerFor('get_document_state', (args, context) => {
    const document = documentFor(args, context);
    return { projectId: context.projectId, projectRevision: context.projectRevision, document: safeClone(document) };
  });

  const selectionFallback = (args, context) => {
    const source = settings.selection || settings.documentSelection || null;
    return {
      projectId: context.projectId,
      blockId: args.blockId || source?.blockId || null,
      start: Number.isInteger(args.start) ? args.start : source?.start ?? null,
      end: Number.isInteger(args.end) ? args.end : source?.end ?? null,
      text: typeof source?.text === 'string' ? source.text : '',
      snapshot: safeClone(source),
    };
  };
  handlers.get_document_selection = handlerFor('get_document_selection', selectionFallback);
  handlers.get_document_selection_context = handlerFor('get_document_selection_context', selectionFallback);

  handlers.list_help_topics = handlerFor('list_help_topics', (args) => {
    const language = typeof args.language === 'string' && args.language.length > 0 ? args.language : 'en';
    const topics = helpTopics(settings).filter((topic) => !args.category || topic.category === args.category).map((topic) => ({
      topicId: topic.topicId || topic.id,
      category: topic.category || '',
      screen: topic.screen || '',
      title: topic.title || '',
      summary: topic.summary || '',
    }));
    return { language, categories: Array.from(new Set(topics.map((topic) => topic.category))).sort(), topics, count: topics.length };
  });

  handlers.get_help_topic = handlerFor('get_help_topic', (args) => {
    const topic = helpTopics(settings).find((candidate) => (candidate.topicId || candidate.id) === args.topicId) || null;
    return { topic: topic ? safeClone({ ...topic, topicId: topic.topicId || topic.id }) : null, topicId: args.topicId || null };
  });

  handlers.search_help = handlerFor('search_help', (args) => {
    const query = typeof args.query === 'string' ? args.query.trim().toLocaleLowerCase() : '';
    const limit = clampInteger(args.limit, 5, 1, 10);
    const matches = helpTopics(settings).filter((topic) => !query || JSON.stringify(topic).toLocaleLowerCase().includes(query)).slice(0, limit).map((topic) => safeClone({ ...topic, topicId: topic.topicId || topic.id }));
    return { query: args.query || '', language: args.language || 'en', matches, matchCount: matches.length, limit };
  });

  handlers.get_contextual_help = handlerFor('get_contextual_help', (args, context) => {
    const screen = settings.screen || settings.activeProject?.screen || 'workspace';
    const topic = helpTopics(settings).find((candidate) => candidate.screen === screen) || helpTopics(settings)[0];
    return {
      language: args.language || 'en',
      screen,
      title: topic?.title || '',
      summary: topic?.summary || '',
      nextActions: Array.isArray(topic?.steps) ? topic.steps.slice(0, 3) : [],
      recommendedTopicIds: topic ? [topic.topicId || topic.id] : [],
      projectId: context.projectId,
    };
  });

  handlers.get_onboarding_checklist = handlerFor('get_onboarding_checklist', (args) => ({
    language: args.language || 'en',
    title: 'Getting started with VaniScript',
    summary: 'Import, review, and export a project.',
    steps: [
      { number: 1, instruction: 'Import a source.' },
      { number: 2, instruction: 'Review transcript chunks.' },
      { number: 3, instruction: 'Export the approved result.' },
    ],
    topicIds: helpTopics(settings).map((topic) => topic.topicId || topic.id),
  }));

  handlers.get_subtitle_style = handlerFor('get_subtitle_style', () => safeClone(settings.subtitleStyle || settings.style || {}));
  handlers.get_shorts_plans = shortsHandlerFor('get_shorts_plans', async (args, context) => {
    const resolved = await resolveShortsProject(settings, args, context);
    context.projectId = resolved.projectId;
    const plans = resolved.session.shortsPlans;
    return {
      plans: plans.map((plan, index) => shortsPlanSummary(plan, index, resolved.session, false)),
      count: plans.length,
    };
  });
  handlers.get_shorts_plan = shortsHandlerFor('get_shorts_plan', async (args, context) => {
    const resolved = await resolveShortsProject(settings, args, context);
    context.projectId = resolved.projectId;
    const index = resolved.session.shortsPlans.findIndex((plan) => plan.stableID === args.planId);
    if (index < 0) throw new ReadCatalogError(`ENTITY_NOT_FOUND: Unknown planId ${args.planId || ''}`, 'MCP_NOT_FOUND');
    return { plan: shortsPlanSummary(resolved.session.shortsPlans[index], index, resolved.session, false) };
  });
  handlers.list_rejected_shorts_plans = shortsHandlerFor('list_rejected_shorts_plans', async (args, context) => {
    const resolved = await resolveShortsProject(settings, args, context);
    context.projectId = resolved.projectId;
    const plans = resolved.session.shortsRejectedPlans;
    return {
      plans: plans.map((plan, index) => shortsPlanSummary(plan, index, resolved.session, true)),
      count: plans.length,
    };
  });
  handlers.validate_shorts_plan = shortsHandlerFor('validate_shorts_plan', async (args, context) => {
    const resolved = await resolveShortsProject(settings, args, context);
    context.projectId = resolved.projectId;
    const plan = resolved.session.shortsPlans.find((candidate) => candidate.stableID === args.planId);
    if (!plan) throw new ReadCatalogError(`ENTITY_NOT_FOUND: Unknown planId ${args.planId || ''}`, 'MCP_NOT_FOUND');
    return shortsState.validateShortsPlan(plan, {
      session: resolved.session,
      activePlans: resolved.session.shortsPlans,
      rejectedPlans: resolved.session.shortsRejectedPlans,
      excludePlanId: plan.stableID,
    });
  });
  handlers.get_playback_state = handlerFor('get_playback_state', () => safeClone(settings.playbackState || { playing: false, positionSec: 0, durationSec: 0, selectedChunkId: null }));
  handlers.list_export_options = handlerFor('list_export_options', async () => exportOptionsData(await exportReadiness(settings)));
  handlers.validate_export = handlerFor('validate_export', async (args) => validateExportData(args.kind, await exportReadiness(settings)));
  handlers.get_visual_editor_state = shortsHandlerFor('get_visual_editor_state', async (args, context) => {
    const resolved = await resolveShortsProject(settings, args, context);
    context.projectId = resolved.projectId;
    const index = resolved.session.shortsPlans.findIndex((plan) => plan.stableID === args.planId);
    if (index < 0) throw new ReadCatalogError(`ENTITY_NOT_FOUND: Unknown planId ${args.planId || ''}`, 'MCP_NOT_FOUND');
    return shortsVisualEditorState(resolved.session.shortsPlans[index], index, resolved.session);
  });
  handlers.get_safe_settings = handlerFor('get_safe_settings', () => safeSettings(settings));
  handlers.list_providers = handlerFor('list_providers', () => ({ providers: Array.isArray(settings.providers) ? settings.providers.map((provider) => safeClone(provider)).filter(Boolean) : [] }));
  handlers.list_prompt_presets = handlerFor('list_prompt_presets', () => ({ presets: Array.isArray(settings.promptPresets) ? settings.promptPresets.map((preset) => safeClone(preset)).filter(Boolean) : [] }));
  handlers.get_model_status = handlerFor('get_model_status', () => safeClone(settings.modelStatus || {}));

  // Only definitions in the read catalogue are registered.  A caller may
  // supply additional handlers to the transport, but they do not become read
  // tools (and therefore cannot accidentally inherit read risk metadata).
  const catalog = {
    tools: READ_TOOL_DEFINITIONS,
    definitions: READ_TOOL_DEFINITIONS,
    handlers,
    names: READ_TOOL_NAMES,
    execute: async (name, args, context = {}) => {
      const handler = handlers[name];
      if (typeof handler !== 'function') throw new ReadCatalogError(`Unknown read tool: ${name}`, 'MCP_METHOD_NOT_FOUND');
      return handler(args, context);
    },
    get: (name) => handlers[name] || null,
  };
  return catalog;
}

function registerReadTools(server, options = {}) {
  if (!server || typeof server.registerToolCatalog !== 'function') {
    throw new TypeError('registerReadTools requires an MCP server with registerToolCatalog().');
  }
  const catalog = options && options.handlers && options.tools ? options : createReadCatalog(options);
  server.registerToolCatalog(catalog);
  return catalog;
}

module.exports = {
  READ_SCOPE,
  READ_RISK,
  READ_SCHEMA_VERSION,
  READ_TOOL_DEFINITIONS,
  READ_TOOL_NAMES,
  RESULT_SCHEMA,
  ReadCatalogError,
  createReadCatalog,
  createReadToolCatalog: createReadCatalog,
  registerReadTools,
};
