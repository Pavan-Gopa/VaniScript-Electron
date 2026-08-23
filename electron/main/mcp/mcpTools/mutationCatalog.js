'use strict';

/**
 * MCP-03 mutation/processing catalogue.
 *
 * This module owns the policy boundary around the real Main-process stores. It
 * deliberately does not accept paths or renderer state. Project edits go
 * through ProjectStore's revision-guarded save, glossary edits use an injected
 * settings/domain writer when supplied, and processing operations are narrow
 * adapters over the existing scheduler/coordinator APIs.
 */

const crypto = require('node:crypto');

const { ProjectStore, defaultProjectStore } = require('../../projects/projectStore.js');

const MUTATION_SCHEMA_VERSION = 1;
const MUTATION_SCOPE = 'mutation';
const PROCESSING_SCOPE = 'processing';
const READ_SCOPE = 'read';
const DEFAULT_CONFIRMATION_TTL_MS = 120_000;
const MAX_TEXT_LENGTH = 100_000;
const MAX_BATCH_SIZE = 100;

const MUTATION_ERROR_CODES = Object.freeze({
  PERMISSION_DENIED: 'MCP_PERMISSION_DENIED',
  CONFIRMATION_REQUIRED: 'MCP_CONFIRMATION_REQUIRED',
  CONFIRMATION_INVALID: 'MCP_CONFIRMATION_INVALID',
  STALE_REVISION: 'MCP_STALE_REVISION',
});

const RESULT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
  required: ['schemaVersion', 'tool', 'scope', 'risk', 'projectId', 'projectRevision', 'data', 'confirmationText'],
  properties: {
    schemaVersion: { type: 'integer', const: MUTATION_SCHEMA_VERSION },
    tool: { type: 'string', minLength: 1 },
    scope: { type: 'string', enum: [READ_SCOPE, MUTATION_SCOPE, PROCESSING_SCOPE] },
    risk: { type: 'string', enum: [READ_SCOPE, MUTATION_SCOPE, PROCESSING_SCOPE] },
    projectId: { type: ['string', 'null'] },
    projectRevision: { type: ['string', 'number', 'null'] },
    data: {},
    confirmationText: { type: ['string', 'null'] },
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
const boundedString = (description) => ({
  ...string(description),
  maxLength: MAX_TEXT_LENGTH,
});
const integer = (minimum, maximum, description) => ({
  type: 'integer',
  ...(minimum === undefined ? {} : { minimum }),
  ...(maximum === undefined ? {} : { maximum }),
  ...(description ? { description } : {}),
});
const number = (minimum, maximum, description) => ({
  type: 'number',
  ...(minimum === undefined ? {} : { minimum }),
  ...(maximum === undefined ? {} : { maximum }),
  ...(description ? { description } : {}),
});
const boolean = (description) => ({ type: 'boolean', ...(description ? { description } : {}) });

const COMMON_MUTATION_PROPERTIES = Object.freeze({
  projectId: string('Project identifier; never a filesystem path.'),
  expectedProjectRevision: { type: ['string', 'number'], description: 'Current project revision required for optimistic concurrency.' },
  challengeId: string('Server-issued challenge identifier approved by a human in Main.'),
});


function mutationInput(properties, required = []) {
  return objectSchema({ ...COMMON_MUTATION_PROPERTIES, ...properties }, ['projectId', 'expectedProjectRevision', ...required]);
}

function definition(name, description, scope, inputSchema, confirmationText = null) {
  const isRead = scope === READ_SCOPE;
  const capability = `mcp.${scope}`;
  return Object.freeze({
    name,
    description,
    risk: scope,
    riskLevel: scope,
    scope,
    capabilityRequirements: Object.freeze([capability]),
    requiredCapabilities: Object.freeze([capability]),
    capabilities: Object.freeze([capability]),
    confirmationText: isRead ? null : confirmationText,
    inputSchema,
    resultSchema: RESULT_SCHEMA,
    outputSchema: RESULT_SCHEMA,
    annotations: Object.freeze({
      readOnlyHint: isRead,
      destructiveHint: false,
      idempotentHint: isRead,
      openWorldHint: false,
    }),
  });
}

const MUTATION_TOOL_DEFINITIONS = Object.freeze([
  definition(
    'update_chunk_text',
    'Update original or translated text for one transcript chunk.',
    MUTATION_SCOPE,
    mutationInput({
      chunkId: string('Stable chunk identifier.'),
      chunkIndex: integer(0, undefined, 'Zero-based chunk index.'),
      side: { type: 'string', enum: ['original', 'translated'] },
      text: string('Replacement text.'),
      language: string('Optional translation language.'),
    }, ['side', 'text']),
    'Allow the MCP client to replace the selected transcript chunk text?',
  ),
  definition(
    'update_cue_text',
    'Update one timed original or translated cue.',
    MUTATION_SCOPE,
    mutationInput({
      chunkId: string('Stable chunk identifier.'),
      chunkIndex: integer(0, undefined, 'Zero-based chunk index.'),
      cueId: string('Stable cue identifier.'),
      cueIndex: integer(0, undefined, 'Zero-based cue index.'),
      side: { type: 'string', enum: ['original', 'translated'] },
      text: string('Replacement cue text.'),
      language: string('Optional translation language.'),
    }, ['side', 'text']),
    'Allow the MCP client to replace the selected transcript cue text?',
  ),
  definition(
    'update_cue_timestamps',
    'Update the start and end timestamps for one timed cue.',
    MUTATION_SCOPE,
    mutationInput({
      chunkId: string('Stable chunk identifier.'),
      chunkIndex: integer(0, undefined, 'Zero-based chunk index.'),
      cueId: string('Stable cue identifier.'),
      cueIndex: integer(0, undefined, 'Zero-based cue index.'),
      side: { type: 'string', enum: ['original', 'translated'] },
      startSec: number(0, undefined, 'Cue start in seconds.'),
      endSec: number(0, undefined, 'Cue end in seconds.'),
    }, ['side']),
    'Allow the MCP client to change the selected cue timing?',
  ),
  definition(
    'create_glossary_entry',
    'Create one glossary entry in the project glossary.',
    MUTATION_SCOPE,
    mutationInput({
      id: string('Optional stable entry identifier.'),
      source: boundedString('Source term.'),
      translation: boundedString('Preferred translation.'),
      variants: { type: 'array', maxItems: MAX_BATCH_SIZE, items: boundedString() },
      category: boundedString('Optional category.'),
      translations: { type: 'object', additionalProperties: boundedString() },
      remember: boolean(),
    }, ['source', 'translation']),
    'Allow the MCP client to add this glossary entry?',
  ),
  definition(
    'update_glossary_entry',
    'Update fields of one existing glossary entry.',
    MUTATION_SCOPE,
    mutationInput({
      entryId: string('Stable glossary entry identifier.'),
      source: boundedString('Source term.'),
      translation: boundedString('Preferred translation.'),
      variants: { type: 'array', maxItems: MAX_BATCH_SIZE, items: boundedString() },
      category: boundedString('Optional category.'),
      translations: { type: 'object', additionalProperties: boundedString() },
      remember: boolean(),
    }, ['entryId']),
    'Allow the MCP client to update this glossary entry?',
  ),
  definition(
    'delete_glossary_entry',
    'Delete one glossary entry.',
    MUTATION_SCOPE,
    mutationInput({ entryId: string('Stable glossary entry identifier.') }, ['entryId']),
    'Allow the MCP client to delete this glossary entry?',
  ),
  definition(
    'approve_chunk',
    'Approve one transcript chunk for review/export.',
    MUTATION_SCOPE,
    mutationInput({
      chunkId: string('Stable chunk identifier.'),
      chunkIndex: integer(0, undefined, 'Zero-based chunk index.'),
      approved: boolean('True to approve; false to revoke.'),
    }),
    'Allow the MCP client to approve this transcript chunk?',
  ),
  definition(
    'batch_approve_chunks',
    'Atomically approve or revoke a bounded set of transcript chunks.',
    MUTATION_SCOPE,
    mutationInput({
      chunkIds: { type: 'array', minItems: 1, maxItems: MAX_BATCH_SIZE, items: string() },
      approved: boolean('True to approve; false to revoke.'),
    }, ['chunkIds']),
    'Allow the MCP client to change approval for this batch of transcript chunks?',
  ),
  definition(
    'retranslate_chunk',
    'Start a real translation/retranslation operation for one transcript chunk.',
    PROCESSING_SCOPE,
    mutationInput({
      chunkId: string('Stable chunk identifier.'),
      chunkIndex: integer(0, undefined, 'Zero-based chunk index.'),
      language: string('Optional target language.'),
    }),
    'Allow the MCP client to retranslate this transcript chunk?',
  ),
  definition(
    'reprocess_chunk',
    'Start a real transcription/reprocessing operation for one transcript chunk.',
    PROCESSING_SCOPE,
    mutationInput({
      chunkId: string('Stable chunk identifier.'),
      chunkIndex: integer(0, undefined, 'Zero-based chunk index.'),
    }),
    'Allow the MCP client to reprocess this transcript chunk?',
  ),
  definition(
    'cancel_processing',
    'Cancel one running processing job through the existing scheduler.',
    PROCESSING_SCOPE,
    mutationInput({ jobId: string('Opaque processing job identifier.') }, ['jobId']),
    'Allow the MCP client to cancel this processing job?',
  ),
]);

const PROCESSING_STATUS_DEFINITION = definition(
  'get_processing_status',
  'Read bounded processing status and job state without changing data.',
  READ_SCOPE,
  objectSchema({ projectId: string('Optional project identifier.'), jobId: string('Optional opaque job identifier.') }),
);

const TOOL_DEFINITIONS = Object.freeze([
  ...MUTATION_TOOL_DEFINITIONS,
  PROCESSING_STATUS_DEFINITION,
]);
const TOOL_NAMES = Object.freeze(TOOL_DEFINITIONS.map((tool) => tool.name));
const DEFINITIONS_BY_NAME = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
const MUTATION_TOOL_NAMES = Object.freeze(MUTATION_TOOL_DEFINITIONS.map((tool) => tool.name));
const PROCESSING_TOOL_NAMES = Object.freeze(
  MUTATION_TOOL_DEFINITIONS.filter((tool) => tool.scope === PROCESSING_SCOPE).map((tool) => tool.name),
);
const CATALOG_HTTP_STATUS = Object.freeze({
  MCP_INVALID_REQUEST: 400,
  MCP_METHOD_NOT_FOUND: 404,
  MCP_NOT_FOUND: 404,
  MCP_PERMISSION_DENIED: 403,
  MCP_CONFIRMATION_REQUIRED: 428,
  MCP_CONFIRMATION_INVALID: 428,
  MCP_STALE_REVISION: 409,
  MCP_CONFLICT: 409,
  MCP_CAPABILITY_UNAVAILABLE: 503,
});

class MutationCatalogError extends Error {
  constructor(code, message, details, status) {
    super(message);
    this.name = 'MutationCatalogError';
    this.mcpCode = code;
    this.code = code;
    this.status = status || CATALOG_HTTP_STATUS[code] || 500;
    if (details !== undefined) this.details = details;
    Object.setPrototypeOf(this, MutationCatalogError.prototype);
  }
}

function mutationError(code, message, details, status) {
  return new MutationCatalogError(code, message, details, status);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asObject(value) {
  return isObject(value) ? value : {};
}

function clone(value) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch { /* fall through for plain JSON state */ }
  }
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.keys(value).sort().reduce((out, key) => {
    if (value[key] !== undefined) out[key] = stableValue(value[key]);
    return out;
  }, {});
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw mutationError('MCP_INVALID_REQUEST', `${field} must be a non-empty string.`);
  }
  return value;
}

function textValue(value, field) {
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) {
    throw mutationError('MCP_INVALID_REQUEST', `${field} must be a string of at most ${MAX_TEXT_LENGTH} characters.`);
  }
  return value;
}

function finiteNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw mutationError('MCP_INVALID_REQUEST', `${field} must be a finite number.`);
  }
  return value;
}

function projectIdFor(args, context, options, project) {
  const candidate = args.projectId ?? context.projectId ?? options.projectId ?? project?.projectId ?? project?.id;
  return nonEmptyString(candidate, 'projectId');
}

function projectRevisionFor(args, context) {
  const candidate = args.expectedProjectRevision ?? args.expectedRevision ?? args.projectRevision ?? context.projectRevision;
  if (candidate === undefined || candidate === null || candidate === '') {
    throw mutationError(
      MUTATION_ERROR_CODES.STALE_REVISION,
      'A current expectedProjectRevision is required for every mutation.',
      { expectedProjectRevision: candidate ?? null, currentProjectRevision: null },
      409,
    );
  }
  if ((typeof candidate !== 'string' && typeof candidate !== 'number') || (typeof candidate === 'number' && !Number.isFinite(candidate))) {
    throw mutationError('MCP_INVALID_REQUEST', 'expectedProjectRevision must be a string or finite number.');
  }
  return String(candidate);
}

function readSettings(options) {
  if (options.settings && isObject(options.settings)) return options.settings;
  const store = options.settingsStore;
  if (store && typeof store.readSettings === 'function') {
    try {
      const result = store.readSettings(options.settingsOptions);
      return isObject(result?.settings) ? result.settings : isObject(result) ? result : {};
    } catch {
      return {};
    }
  }
  return isObject(options) ? options : {};
}

function scopeValue(value, scope) {
  if (value instanceof Set) return value.has(scope);
  if (Array.isArray(value)) return value.includes(scope);
  if (isObject(value)) {
    if (value.allowedScopes !== undefined) return scopeValue(value.allowedScopes, scope);
    if (value.scopes !== undefined) return scopeValue(value.scopes, scope);
    if (value[scope] !== undefined) return value[scope] === true;
    const aliases = scope === MUTATION_SCOPE ? ['edit', 'mutation', 'mutating', 'mcpAllowMutatingTools'] : ['processing', 'mcpAllowProcessingTools'];
    return aliases.some((key) => value[key] === true);
  }
  return null;
}

function createScopePolicy(options = {}) {
  const explicit = options.permissionPolicy ?? options.scopePolicy ?? options.policy ?? options.allowedScopes ?? options.permissions;
  if (typeof explicit === 'function') {
    return (scope, meta) => explicit.length <= 1 ? Boolean(explicit(scope)) : Boolean(explicit(scope, meta));
  }
  return (scope) => {
    if (scope === READ_SCOPE) return true;
    const direct = scopeValue(explicit, scope);
    if (direct !== null) return direct;
    const settings = readSettings(options);
    const settingsScopes = settings.mcpAllowedScopes ?? settings.mcpPermissions ?? settings.permissions ?? settings.allowedScopes;
    const configured = scopeValue(settingsScopes, scope);
    if (configured !== null) return configured;
    if (scope === MUTATION_SCOPE) {
      return settings.mcpAllowMutatingTools === true || settings.mcpAllowEditTools === true;
    }
    if (scope === PROCESSING_SCOPE) return settings.mcpAllowProcessingTools === true;
    return false;
  };
}

class ConfirmationStore {
  constructor(options = {}) {
    this.ttlMs = Number.isInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_CONFIRMATION_TTL_MS;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : (size) => crypto.randomBytes(size);
    this.entries = new Map();
  }

  issue({ tokenId, tool, projectId, expectedProjectRevision, argsHash, confirmationText }) {
    this.prune();
    const secret = this.randomBytes(32).toString('base64url');
    const challengeId = sha256(`${secret}:challenge`).slice(0, 32);
    const issuedAtMs = this.now();
    const expiresAtMs = issuedAtMs + this.ttlMs;
    const expiresAt = new Date(expiresAtMs).toISOString();
    this.entries.set(challengeId, {
      challengeId,
      secret,
      tokenId,
      tool,
      projectId,
      expectedProjectRevision,
      argsHash,
      confirmationText,
      expiresAt,
      expiresAtMs,
      approved: false,
    });
    return {
      challengeId,
      confirmationText,
      requiresHumanConfirmation: true,
      expiresAt,
    };
  }

  approve(challengeId) {
    this.prune();
    if (typeof challengeId !== 'string' || challengeId.length === 0) return false;
    const entry = this.entries.get(challengeId);
    if (!entry) return false;
    entry.approved = true;
    entry.approvedAt = new Date(this.now()).toISOString();
    return true;
  }

  consume(challengeId, expected) {
    this.prune();
    const entry = this.entries.get(challengeId);
    if (!entry) return { ok: false, reason: 'unknown_or_expired' };
    if (
      entry.tokenId !== expected.tokenId
      || entry.tool !== expected.tool
      || entry.projectId !== expected.projectId
      || entry.expectedProjectRevision !== expected.expectedProjectRevision
      || entry.argsHash !== expected.argsHash
    ) return { ok: false, reason: 'challenge_mismatch' };
    if (!entry.approved) return { ok: false, reason: 'not_approved' };
    this.entries.delete(challengeId);
    return { ok: true, entry };
  }

  prune() {
    const now = this.now();
    for (const [challengeId, entry] of this.entries) {
      if (entry.expiresAtMs <= now) this.entries.delete(challengeId);
    }
  }

  size() {
    this.prune();
    return this.entries.size;
  }
}

function currentProjectStore(options) {
  if (options.projectStore && typeof options.projectStore === 'object') return options.projectStore;
  if (typeof options.baseDir === 'string' && options.baseDir.length > 0) return new ProjectStore({ baseDir: options.baseDir });
  return defaultProjectStore;
}

function normalizeDomainError(error, projectId) {
  if (error?.code === 'NOT_FOUND' || error?.mcpCode === 'MCP_NOT_FOUND') {
    return mutationError('MCP_NOT_FOUND', error.message || `Project "${projectId}" was not found.`, error.details, 404);
  }
  if (
    error?.code === 'CONFLICT'
    || error?.code === 'MCP_CONFLICT'
    || error?.mcpCode === 'CONFLICT'
    || error?.mcpCode === 'MCP_CONFLICT'
  ) {
    return mutationError(MUTATION_ERROR_CODES.STALE_REVISION, error.message || `Project "${projectId}" revision is stale.`, error.details, 409);
  }
  if (error && typeof error.mcpCode === 'string') return error;
  return error;
}

async function loadProject(options, projectId) {
  try {
    const explicitStore = options.projectStore;
    if (explicitStore && typeof explicitStore.loadProject === 'function') return await explicitStore.loadProject(projectId);
    if (typeof options.baseDir === 'string' && options.baseDir.length > 0) {
      const store = currentProjectStore(options);
      if (store && typeof store.loadProject === 'function') return await store.loadProject(projectId);
    }
    if (typeof options.loadProject === 'function') return await options.loadProject(projectId);
    if (isObject(options.project)) return options.project;
    const store = currentProjectStore(options);
    if (store && typeof store.loadProject === 'function') return await store.loadProject(projectId);
    throw mutationError('MCP_CAPABILITY_UNAVAILABLE', 'Project mutation storage is unavailable.');
  } catch (error) {
    throw normalizeDomainError(error, projectId);
  }
}


function projectState(project) {
  if (isObject(project?.mediaState)) return project.mediaState;
  if (isObject(project?.session)) return project.session;
  if (isObject(project?.state) && Array.isArray(project.state.chunks)) return project.state;
  if (Array.isArray(project?.chunks)) return project;
  throw mutationError('MCP_CAPABILITY_UNAVAILABLE', 'The selected project has no mutable transcript state.');
}

function projectChunks(project) {
  const state = projectState(project);
  if (!Array.isArray(state.chunks)) throw mutationError('MCP_CAPABILITY_UNAVAILABLE', 'The selected project has no transcript chunks.');
  return { state, chunks: state.chunks };
}

function stableChunkId(chunk, index) {
  if (typeof chunk?.chunkId === 'string' && chunk.chunkId.length > 0) return chunk.chunkId;
  if (Number.isInteger(chunk?.index)) return `chunk-${chunk.index}`;
  return `chunk-${index}`;
}

function resolveChunk(project, args) {
  const { chunks } = projectChunks(project);
  if (typeof args.chunkId === 'string' && args.chunkId.length > 0) {
    const index = chunks.findIndex((chunk, position) => stableChunkId(chunk, position) === args.chunkId);
    if (index >= 0) return { chunks, chunk: chunks[index], index, chunkId: stableChunkId(chunks[index], index) };
  }
  if (Number.isInteger(args.chunkIndex) && args.chunkIndex >= 0 && args.chunkIndex < chunks.length) {
    return { chunks, chunk: chunks[args.chunkIndex], index: args.chunkIndex, chunkId: stableChunkId(chunks[args.chunkIndex], args.chunkIndex) };
  }
  throw mutationError('MCP_NOT_FOUND', 'Transcript chunk was not found.', { chunkId: args.chunkId ?? null, chunkIndex: args.chunkIndex ?? null });
}

function cueArray(chunk, side) {
  if (side !== 'original' && side !== 'translated') throw mutationError('MCP_INVALID_REQUEST', 'side must be "original" or "translated".');
  const key = side === 'original' ? 'originalCues' : 'translatedCues';
  if (!Array.isArray(chunk[key])) throw mutationError('MCP_NOT_FOUND', `Chunk has no ${side} cues.`);
  return { key, cues: chunk[key] };
}

function cueId(chunkId, side, index) {
  return `${chunkId}-${side}-cue-${index}`;
}

function resolveCue(project, args) {
  const resolved = resolveChunk(project, args);
  const { cues, key } = cueArray(resolved.chunk, args.side);
  let index = -1;
  if (typeof args.cueId === 'string' && args.cueId.length > 0) {
    index = cues.findIndex((cue, position) => (
      cueId(resolved.chunkId, args.side, position) === args.cueId || cue?.cueId === args.cueId || cue?.id === args.cueId
    ));
  }
  if (index < 0 && Number.isInteger(args.cueIndex)) index = args.cueIndex;
  if (index < 0 || index >= cues.length) throw mutationError('MCP_NOT_FOUND', 'Transcript cue was not found.', { cueId: args.cueId ?? null, cueIndex: args.cueIndex ?? null });
  return { ...resolved, cues, key, cue: cues[index], cueIndex: index, cueId: cueId(resolved.chunkId, args.side, index) };
}

function markEdited(chunk) {
  if (chunk && typeof chunk === 'object') {
    chunk.approved = false;
    if (chunk.status === 'processing') chunk.status = 'pending';
    else if (typeof chunk.status !== 'string') chunk.status = 'done';
  }
}

function aggregateCueText(chunk, side, cues) {
  const text = cues.map((cue) => typeof cue?.text === 'string' ? cue.text : '').join(' ').trim();
  if (side === 'original') chunk.original = text;
  else chunk.translated = text;
}

function glossarySource(project, options) {
  if (Array.isArray(project?.glossary)) return { owner: 'project', entries: project.glossary };
  if (Array.isArray(options.glossary)) return { owner: 'options', entries: options.glossary };
  if (Array.isArray(options.settings?.glossary)) return { owner: 'settings', entries: options.settings.glossary };
  const settings = readSettings(options);
  if (Array.isArray(settings.glossary)) return { owner: 'settingsStore', entries: settings.glossary, settings };
  return { owner: 'project', entries: [] };
}

function normalizeEntry(input, existing = null) {
  const source = textValue(input.source === undefined ? existing?.source : input.source, 'glossary source');
  const translation = textValue(
    input.translation === undefined ? existing?.translation : input.translation,
    'glossary translation',
  );
  if (source.trim().length === 0) throw mutationError('MCP_INVALID_REQUEST', 'glossary source must be a non-empty string.');
  let category;
  if (input.category !== undefined) {
    category = textValue(input.category, 'glossary category');
  } else if (existing?.category !== undefined) {
    category = textValue(existing.category, 'glossary category');
  }
  if (input.remember !== undefined && typeof input.remember !== 'boolean') throw mutationError('MCP_INVALID_REQUEST', 'glossary remember must be a boolean.');
  const variants = input.variants === undefined ? (existing?.variants || []) : input.variants;
  if (
    !Array.isArray(variants)
    || variants.length > MAX_BATCH_SIZE
    || variants.some((value) => typeof value !== 'string')
  ) throw mutationError('MCP_INVALID_REQUEST', `glossary variants must be an array of at most ${MAX_BATCH_SIZE} strings.`);
  const boundedVariants = variants.map((value) => textValue(value, 'glossary variant'));
  const translations = input.translations === undefined ? existing?.translations : input.translations;
  if (translations !== undefined && !isObject(translations)) {
    throw mutationError('MCP_INVALID_REQUEST', 'glossary translations must map language names to strings.');
  }
  const boundedTranslations = translations === undefined
    ? undefined
    : Object.fromEntries(Object.entries(translations).map(([language, value]) => [
      language,
      textValue(value, `glossary translation for ${language}`),
    ]));
  const now = new Date().toISOString();
  return {
    id: typeof existing?.id === 'string' && existing.id.length > 0
      ? existing.id
      : typeof input.id === 'string' && input.id.length > 0 ? input.id : crypto.randomUUID(),
    source,
    translation,
    variants: boundedVariants,
    ...(category !== undefined ? { category } : {}),
    ...(boundedTranslations !== undefined ? { translations: boundedTranslations } : {}),
    remember: input.remember === undefined ? existing?.remember !== false : input.remember,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}
async function persistGlossary(options, projectId, original, draft, source, expectedRevision) {
  let settingsToWrite = null;
  if (source.owner === 'project') {
    draft.glossary = source.entries;
  } else if (source.owner === 'settingsStore') {
    settingsToWrite = clone(source.settings || readSettings(options)) || {};
    settingsToWrite.glossary = source.entries;
  }
  const saved = source.owner === 'project'
    ? await persistProject(options, projectId, original, draft, expectedRevision)
    : { revision: await touchProjectRevision(options, projectId, expectedRevision) };
  if (source.owner === 'options') options.glossary = source.entries;
  else if (source.owner === 'settings') options.settings.glossary = source.entries;
  else if (
    settingsToWrite
    && options.settingsStore
    && typeof options.settingsStore.writeSettings === 'function'
  ) {
    await options.settingsStore.writeSettings(settingsToWrite, options.settingsOptions);
  }
  return saved;
}

function replaceObject(target, next) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
}

function nextRevision() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
}

function revisionOf(project) {
  return project && (project.revision ?? project.projectRevision) != null
    ? String(project.revision ?? project.projectRevision)
    : null;
}

async function readCurrentRevision(options, projectId, context = {}) {
  if (typeof options.getProjectRevision === 'function') {
    const result = await options.getProjectRevision(projectId, context);
    return result == null ? null : String(result);
  }
  // A live project/store is authoritative. Static revision options are kept
  // for adapters that deliberately expose no project object (e.g. a job-only
  // status bridge), but must not mask a revision written by a mutation.
  if (options.project || options.loadProject || options.projectStore || options.baseDir) {
    const project = await loadProject(options, projectId);
    return revisionOf(project);
  }
  if (options.projectRevision !== undefined && options.projectRevision !== null) return String(options.projectRevision);
  if (options.revision !== undefined && options.revision !== null) return String(options.revision);
  const project = await loadProject(options, projectId);
  return revisionOf(project);
}

function ensureCurrentRevision(expected, current, projectId) {
  if (current === null || String(current) !== String(expected)) {
    throw mutationError(
      MUTATION_ERROR_CODES.STALE_REVISION,
      `Project "${projectId}" is stale; expected revision "${expected}" but found "${current ?? 'none'}".`,
      { projectId, expectedProjectRevision: expected, currentProjectRevision: current },
      409,
    );
  }
}

async function persistProject(options, projectId, original, draft, expectedRevision) {
  const current = revisionOf(original);
  ensureCurrentRevision(expectedRevision, current, projectId);
  let saved;
  try {
    const store = currentProjectStore(options);
    const hasProjectStore = store
      && typeof store.saveProject === 'function'
      && (options.projectStore || options.baseDir);
    if (hasProjectStore) {
      saved = await store.saveProject(draft, expectedRevision);
    } else if (typeof options.saveProject === 'function') {
      saved = await options.saveProject(draft, expectedRevision, projectId);
    } else {
      draft.revision = nextRevision();
      saved = draft;
    }
  } catch (error) {
    throw normalizeDomainError(error, projectId);
  }
  const next = isObject(saved) ? saved : draft;
  if (revisionOf(next) === null || revisionOf(next) === String(expectedRevision)) next.revision = nextRevision();
  if (original && original !== next && isObject(original)) replaceObject(original, next);
  return next;
}

async function touchProjectRevision(options, projectId, expectedRevision) {
  const original = await loadProject(options, projectId);
  ensureCurrentRevision(expectedRevision, revisionOf(original), projectId);
  const draft = clone(original);
  const saved = await persistProject(options, projectId, original, draft, expectedRevision);
  return revisionOf(saved);
}

async function mutateProject(options, args, context, operation) {
  const projectId = projectIdFor(args, context, options);
  const expected = projectRevisionFor(args, context);
  const original = await loadProject(options, projectId);
  ensureCurrentRevision(expected, revisionOf(original), projectId);
  const draft = clone(original);
  const data = await operation(draft, args, projectId);
  const saved = await persistProject(options, projectId, original, draft, expected);
  return { projectId, projectRevision: revisionOf(saved), data };
}

function processingOptions(options) {
  return options.processing && isObject(options.processing) ? options.processing : {};
}

function processingFunction(options, name) {
  const processing = processingOptions(options);
  const candidates = {
    retranslate_chunk: [
      [options.retranslateChunk, options, 'args'],
      [options.retryChunkTranslation, options, 'args'],
      [processing.retranslateChunk, processing, 'args'],
      [processing.retryChunkTranslation, processing, 'args'],
      [processing.retryChunk, processing, 'args'],
    ],
    reprocess_chunk: [
      [options.reprocessChunk, options, 'args'],
      [options.reprocess, options, 'args'],
      [processing.reprocessChunk, processing, 'args'],
      [processing.reprocess, processing, 'args'],
      [processing.processChunk, processing, 'args'],
    ],
    cancel_processing: [
      [options.cancelProcessing, options, 'args'],
      [processing.cancelProcessing, processing, 'args'],
      [options.scheduler?.cancel, options.scheduler, 'jobId'],
      [options.batchScheduler?.cancel, options.batchScheduler, 'jobId'],
      [options.batchDomain?.cancelJob, options.batchDomain, 'jobId'],
    ],
  }[name] || [];
  const selected = candidates.find(([candidate]) => typeof candidate === 'function');
  if (!selected) return null;
  const [candidate, owner, mode] = selected;
  if (mode === 'jobId') {
    if (candidate.length !== 1) return null;
    return (args) => candidate.call(owner, args.jobId);
  }
  if (candidate.length === 0) return null;
  return candidate.length === 1
    ? (args) => candidate.call(owner, args)
    : (args, context) => candidate.call(owner, args, context);
}

const STATUS_SECRET_KEY = /(?:pass(word)?|secret|token|api.?key|credential)/i;
const STATUS_PATH_KEY = /^(?:sourceFile|sourcePath|filePath|outputPath|wavPath|originalVideoPath|assetPath|absolutePath|path)$/i;

function safeStatusClone(value, key = '') {
  if (STATUS_SECRET_KEY.test(key) || STATUS_PATH_KEY.test(key)) return undefined;
  if (Array.isArray(value)) return value.map((item) => safeStatusClone(item, key)).filter((item) => item !== undefined);
  if (!isObject(value)) return value;
  const out = {};
  for (const [field, child] of Object.entries(value)) {
    const cleaned = safeStatusClone(child, field);
    if (cleaned !== undefined) out[field] = cleaned;
  }
  return out;
}


function safeJob(job) {
  if (!isObject(job)) return job ?? null;
  const allowed = ['jobId', 'profileId', 'state', 'phase', 'attempt', 'maxAttempts', 'progress', 'lastError', 'createdAt', 'updatedAt', 'startedAt', 'completedAt'];
  return allowed.reduce((out, key) => {
    if (job[key] !== undefined) out[key] = job[key];
    return out;
  }, {});
}

async function processingStatus(options, args, context) {
  const processing = processingOptions(options);
  const adapter = options.getProcessingStatus || processing.getStatus || processing.status || options.processingStatus;
  if (typeof adapter === 'function') return safeStatusClone(await adapter(args, context));
  if (isObject(adapter)) return safeStatusClone(adapter);
  const jobId = typeof args.jobId === 'string' ? args.jobId : null;
  const domain = options.batchDomain || processing.domain;
  if (domain) {
    if (jobId && typeof domain.getJob === 'function') return safeStatusClone({ job: safeJob(await domain.getJob(jobId)) });
    if (typeof domain.listJobs === 'function') return safeStatusClone({ jobs: (await domain.listJobs({ limit: 100 })).map(safeJob) });
  }
  const scheduler = options.batchScheduler || processing.scheduler;
  if (scheduler && typeof scheduler.status === 'function') return safeStatusClone(await scheduler.status());
  return { jobs: [], active: false };
}

function omitConfirmation(args) {
  const copy = { ...asObject(args) };
  delete copy.challengeId;
  return copy;
}


function argsHash(args) {
  return sha256(stableJson(omitConfirmation(args)));
}

function normalizeAdapterResult(result) {
  if (isObject(result) && result.schemaVersion !== undefined && result.data !== undefined) {
    return { projectRevision: result.projectRevision ?? null, data: result.data };
  }
  if (isObject(result) && result.projectRevision !== undefined && result.data !== undefined) {
    return { projectRevision: result.projectRevision, data: result.data };
  }
  return { projectRevision: null, data: result };
}

function defaultMutationAdapter(name, options) {
  if (name === 'update_chunk_text') {
    return (args, context) => mutateProject(options, args, context, (draft) => {
      const resolved = resolveChunk(draft, args);
      const side = args.side;
      if (side !== 'original' && side !== 'translated') throw mutationError('MCP_INVALID_REQUEST', 'side must be "original" or "translated".');
      const text = textValue(args.text, 'text');
      resolved.chunk[side] = text;
      if (side === 'original') resolved.chunk.originalCues = undefined;
      else if (args.language === undefined) resolved.chunk.translatedCues = undefined;
      markEdited(resolved.chunk);
      return { chunkId: resolved.chunkId, chunkIndex: resolved.index, side, text };
    });
  }
  if (name === 'update_cue_text') {
    return (args, context) => mutateProject(options, args, context, (draft) => {
      const resolved = resolveCue(draft, args);
      const text = textValue(args.text, 'text');
      resolved.cue.text = text;
      if (Object.prototype.hasOwnProperty.call(resolved.cue, 'words')) resolved.cue.words = [];
      aggregateCueText(resolved.chunk, args.side, resolved.cues);
      markEdited(resolved.chunk);
      return { chunkId: resolved.chunkId, chunkIndex: resolved.index, cueId: resolved.cueId, cueIndex: resolved.cueIndex, side: args.side, text };
    });
  }
  if (name === 'update_cue_timestamps') {
    return (args, context) => mutateProject(options, args, context, (draft) => {
      if (args.startSec === undefined && args.endSec === undefined) {
        throw mutationError('MCP_INVALID_REQUEST', 'At least one of startSec or endSec is required.');
      }
      const resolved = resolveCue(draft, args);
      const startSec = args.startSec === undefined ? finiteNumber(resolved.cue.startSec, 'startSec') : finiteNumber(args.startSec, 'startSec');
      const endSec = args.endSec === undefined ? finiteNumber(resolved.cue.endSec, 'endSec') : finiteNumber(args.endSec, 'endSec');
      if (startSec < 0 || endSec <= startSec) throw mutationError('MCP_INVALID_REQUEST', 'Cue timing must satisfy 0 <= startSec < endSec.');
      resolved.cue.startSec = startSec;
      resolved.cue.endSec = endSec;
      markEdited(resolved.chunk);
      return { chunkId: resolved.chunkId, chunkIndex: resolved.index, cueId: resolved.cueId, cueIndex: resolved.cueIndex, side: args.side, startSec, endSec };
    });
  }
  if (name === 'approve_chunk') {
    return (args, context) => mutateProject(options, args, context, (draft) => {
      const resolved = resolveChunk(draft, args);
      if (args.approved !== undefined && typeof args.approved !== 'boolean') {
        throw mutationError('MCP_INVALID_REQUEST', 'approved must be a boolean.');
      }
      const approved = args.approved === undefined ? true : args.approved;
      resolved.chunk.approved = approved;
      return { chunkId: resolved.chunkId, chunkIndex: resolved.index, approved };
    });
  }
  if (name === 'batch_approve_chunks') {
    return (args, context) => mutateProject(options, args, context, (draft) => {
      if (!Array.isArray(args.chunkIds) || args.chunkIds.length < 1 || args.chunkIds.length > MAX_BATCH_SIZE) {
        throw mutationError('MCP_INVALID_REQUEST', `chunkIds must contain between 1 and ${MAX_BATCH_SIZE} items.`);
      }
      if (new Set(args.chunkIds).size !== args.chunkIds.length || args.chunkIds.some((id) => typeof id !== 'string' || id.length === 0)) {
        throw mutationError('MCP_INVALID_REQUEST', 'chunkIds must contain unique non-empty strings.');
      }
      if (args.approved !== undefined && typeof args.approved !== 'boolean') {
        throw mutationError('MCP_INVALID_REQUEST', 'approved must be a boolean.');
      }
      const approved = args.approved === undefined ? true : args.approved;
      const changes = args.chunkIds.map((chunkId) => {
        const resolved = resolveChunk(draft, { chunkId });
        resolved.chunk.approved = approved;
        return { chunkId: resolved.chunkId, chunkIndex: resolved.index, approved };
      });
      return { changes, approved };
    });
  }
  if (name === 'create_glossary_entry' || name === 'update_glossary_entry' || name === 'delete_glossary_entry') {
    return async (args, context) => {
      const projectId = projectIdFor(args, context, options);
      const expected = projectRevisionFor(args, context);
      const original = await loadProject(options, projectId);
      ensureCurrentRevision(expected, revisionOf(original), projectId);
      const draft = clone(original);
      const source = glossarySource(draft, options);
      if (source.owner !== 'project') source.entries = source.entries.map((entry) => clone(entry));
      if (name === 'create_glossary_entry') {
        const entry = normalizeEntry(args);
        if (source.entries.some((candidate) => candidate?.id === entry.id)) throw mutationError('MCP_CONFLICT', `Glossary entry "${entry.id}" already exists.`);
        source.entries.push(entry);
        const saved = await persistGlossary(options, projectId, original, draft, source, expected);
        return { projectId, projectRevision: revisionOf(saved), data: { entry } };
      }
      const entryId = nonEmptyString(args.entryId, 'entryId');
      const index = source.entries.findIndex((entry) => entry?.id === entryId);
      if (index < 0) throw mutationError('MCP_NOT_FOUND', `Glossary entry "${entryId}" was not found.`, { entryId });
      if (name === 'delete_glossary_entry') {
        const [entry] = source.entries.splice(index, 1);
        const saved = await persistGlossary(options, projectId, original, draft, source, expected);
        return { projectId, projectRevision: revisionOf(saved), data: { entry } };
      }
      const entry = normalizeEntry(args, source.entries[index]);
      source.entries[index] = entry;
      const saved = await persistGlossary(options, projectId, original, draft, source, expected);
      return { projectId, projectRevision: revisionOf(saved), data: { entry } };
    };
  }
  if (name === 'retranslate_chunk' || name === 'reprocess_chunk' || name === 'cancel_processing') {
    return async (args, context) => {
      const adapter = processingFunction(options, name);
      if (!adapter) throw mutationError('MCP_CAPABILITY_UNAVAILABLE', `${name} is unavailable in the Electron processing coordinator.`);
      const projectId = projectIdFor(args, context, options);
      const expected = projectRevisionFor(args, context);
      const current = await readCurrentRevision(options, projectId, context);
      ensureCurrentRevision(expected, current, projectId);
      if (name !== 'cancel_processing') {
        const project = await loadProject(options, projectId);
        resolveChunk(project, args);
      }
      const result = await adapter(args, { ...context, projectId, projectRevision: expected });
      const projectRevision = await touchProjectRevision(options, projectId, expected);
      return { projectId, projectRevision, data: result ?? { accepted: true } };
    };
  }
  return null;
}

function createMutationCatalog(options = {}) {
  const settings = asObject(options);
  const policy = createScopePolicy(settings);
  const confirmations = options.confirmationStore instanceof ConfirmationStore
    ? options.confirmationStore
    : new ConfirmationStore(options.confirmation || {});
  const adapters = asObject(options.adapters || options.mutators || options.mutationHandlers || options.handlers);
  const locks = new Map();

  async function withProjectLock(projectId, operation) {
    const previous = locks.get(projectId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    locks.set(projectId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(projectId) === current) locks.delete(projectId);
    }
  }
  function contextFor(args, handlerContext) {
    const params = asObject(args);
    const ctx = asObject(handlerContext);
    return {
      ...ctx,
      projectId: params.projectId ?? ctx.projectId ?? options.projectId ?? null,
      projectRevision: params.expectedProjectRevision
        ?? params.expectedRevision
        ?? params.projectRevision
        ?? ctx.projectRevision
        ?? ctx.expectedProjectRevision
        ?? null,
      tokenId: ctx.tokenId ?? ctx.clientTokenId ?? 'anonymous',
    };
  }

  function issueChallenge(definitionForTool, args, context, projectId, expectedRevision) {
    const challenge = confirmations.issue({
      tokenId: context.tokenId,
      tool: definitionForTool.name,
      projectId,
      expectedProjectRevision: expectedRevision,
      argsHash: argsHash(args),
      confirmationText: definitionForTool.confirmationText,
    });
    throw mutationError(
      MUTATION_ERROR_CODES.CONFIRMATION_REQUIRED,
      'Human confirmation is required before this MCP mutation can execute.',
      challenge,
      428,
    );
  }

  async function execute(name, args = {}, handlerContext = {}) {
    const definitionForTool = DEFINITIONS_BY_NAME.get(name);
    if (!definitionForTool) throw mutationError('MCP_METHOD_NOT_FOUND', `Unknown mutation tool: ${name}`, undefined, 404);
    const params = asObject(args);
    const context = contextFor(params, handlerContext);
    if (!policy(definitionForTool.scope, { tool: name, args: params, context, definition: definitionForTool })) {
      throw mutationError(
        MUTATION_ERROR_CODES.PERMISSION_DENIED,
        `Permission scope "${definitionForTool.scope}" is disabled for MCP tool "${name}".`,
        { tool: name, requiredScope: definitionForTool.scope, scope: definitionForTool.scope },
        403,
      );
    }

    if (definitionForTool.scope === READ_SCOPE) {
      const data = await processingStatus(options, params, context);
      return {
        schemaVersion: MUTATION_SCHEMA_VERSION,
        tool: name,
        scope: READ_SCOPE,
        risk: READ_SCOPE,
        projectId: context.projectId ?? null,
        projectRevision: context.projectRevision ?? null,
        data: clone(data),
        confirmationText: null,
      };
    }

    const projectId = projectIdFor(params, context, options);
    const expectedRevision = projectRevisionFor(params, context);
    const currentRevision = await readCurrentRevision(options, projectId, context);
    ensureCurrentRevision(expectedRevision, currentRevision, projectId);

    const requiresConfirmation = definitionForTool.scope === MUTATION_SCOPE || definitionForTool.scope === PROCESSING_SCOPE;
    if (requiresConfirmation) {
      const challengeId = params.challengeId;
      if (typeof challengeId !== 'string' || challengeId.length === 0) {
        issueChallenge(definitionForTool, params, context, projectId, expectedRevision);
      }
      const consumed = confirmations.consume(challengeId, {
        tokenId: context.tokenId,
        tool: name,
        projectId,
        expectedProjectRevision: expectedRevision,
        argsHash: argsHash(params),
      });
      if (!consumed.ok) {
        throw mutationError(
          MUTATION_ERROR_CODES.CONFIRMATION_INVALID,
          'The confirmation challenge is missing, expired, not human-approved, already used, or does not match this tool, client, arguments, and revision.',
          { tool: name, reason: consumed.reason, requiresHumanConfirmation: true },
          428,
        );
      }
    }

    return withProjectLock(projectId, async () => {
      const latest = await readCurrentRevision(options, projectId, context);
      ensureCurrentRevision(expectedRevision, latest, projectId);
      const customAdapter = adapters[name];
      const adapter = typeof customAdapter === 'function' ? customAdapter : defaultMutationAdapter(name, options);
      if (typeof adapter !== 'function') throw mutationError('MCP_CAPABILITY_UNAVAILABLE', `No adapter is available for MCP tool "${name}".`);
      const raw = await adapter(params, { ...context, projectId, projectRevision: expectedRevision });
      const normalized = normalizeAdapterResult(raw);
      const nextRevisionValue = normalized.projectRevision ?? (await readCurrentRevision(options, projectId, context));
      return {
        schemaVersion: MUTATION_SCHEMA_VERSION,
        tool: name,
        scope: definitionForTool.scope,
        risk: definitionForTool.scope,
        projectId,
        projectRevision: nextRevisionValue,
        data: clone(normalized.data),
        confirmationText: definitionForTool.confirmationText,
      };
    });
  }

  const handlers = {};
  for (const name of TOOL_NAMES) handlers[name] = (args, context) => execute(name, args, context);

  return {
    tools: TOOL_DEFINITIONS,
    definitions: TOOL_DEFINITIONS,
    handlers,
    names: TOOL_NAMES,
    execute,
    get: (name) => handlers[name] || null,
    policy,
    confirmations,
    approveChallenge: (challengeId) => confirmations.approve(challengeId),
    getPendingChallengeCount: () => confirmations.size(),
  };
}

function registerMutationTools(server, options = {}) {
  if (!server || typeof server.registerToolCatalog !== 'function') throw new TypeError('registerMutationTools requires an MCP server with registerToolCatalog().');
  const catalog = options && options.handlers && options.tools ? options : createMutationCatalog(options);
  server.registerToolCatalog(catalog);
  return catalog;
}

module.exports = {
  MUTATION_SCHEMA_VERSION,
  MUTATION_SCOPE,
  PROCESSING_SCOPE,
  READ_SCOPE,
  MUTATION_ERROR_CODES,
  RESULT_SCHEMA,
  MUTATION_TOOL_DEFINITIONS,
  MUTATION_TOOL_NAMES,
  PROCESSING_TOOL_NAMES,
  PROCESSING_STATUS_DEFINITION,
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  MutationCatalogError,
  ConfirmationStore,
  createScopePolicy,
  createMutationCatalog,
  createMutationToolCatalog: createMutationCatalog,
  registerMutationTools,
};
