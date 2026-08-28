'use strict';

/**
 * One final, dependency-free observability sink for Electron Main and its
 * untrusted renderer/worker/MCP boundaries. The module deliberately accepts
 * only structured records and projects every value through an allowlist before
 * it reaches a sink, audit ring, usage ledger, or diagnostics response.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  createDefaultUsageLedger,
  normalizeUsageLedger,
  recordUsage: recordUsageLedger,
  projectUsage,
} = require('../../shared/contracts/settings-runtime.js');

const SCHEMA_VERSION = 1;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_DATA_DEPTH = 5;
const MAX_DATA_KEYS = 48;
const MAX_ARRAY_LENGTH = 32;
const MAX_STRING_LENGTH = 160;
const MAX_RECENT_ERRORS = 100;
const MAX_AUDIT_RECORDS = 1000;
const SAFE_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const SAFE_CATEGORIES = new Set([
  'runtime',
  'renderer',
  'worker',
  'ffmpeg',
  'hyperframes',
  'provider',
  'agent',
  'mcp',
  'storage',
  'usage',
  'diagnostics',
]);
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u;
const SAFE_EVENT_RE = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+){0,4}$/u;
const SAFE_CODE_RE = /^[A-Z][A-Z0-9_:-]{1,95}$/u;
const ABSOLUTE_PATH_RE = /(?:^|[\s"'=\[(])(?:\/(?:Users|private|var|tmp|home|Volumes|System|Applications)\/|[A-Za-z]:[\\/])[^\s"'`\])},;]+/u;
const URL_RE = /^(?:https?|wss?):\/\//iu;
const SECRET_VALUE_RE = /(?:bearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{16,}|gh[pousr]_[A-Za-z0-9_\-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|eyJ[A-Za-z0-9_-]{20,})/u;
const SECRET_KEY_RE = /(?:api[_-]?key|(?:gemini|openai|anthropic)[_-]?key|access[_-]?token|authorization|bearer|password|secret|credential|private[_-]?key|cookie|keyref|token|environment[_-]?(?:api[_-]?key|token|authorization)|header[_-]?(?:api[_-]?key|token|authorization)|(?:^|[_-])key(?:$|[_-]))/iu;
const PATH_KEY_RE = /(?:path|filepath|sourcepath|outputpath|directory|dirname|folder|filename|command|commands|argument|arguments|args|validatedurl|sourceid)$/iu;
const URL_KEY_RE = /(?:url|uri|endpoint|query|fragment|href)$/iu;
const TEXT_KEY_RE = /(?:prompt|message|messages|input|output|response|content|body|snippet|stderr|stdout|text|manuscript|transcript|documenttext|rawtext|selectiontext|details|stack|cause)$/iu;
const SAFE_STRING_KEYS = new Set([
  'provider',
  'providerid',
  'model',
  'modelid',
  'purpose',
  'operation',
  'operationid',
  'phase',
  'state',
  'outcome',
  'reason',
  'reasoncode',
  'code',
  'statuscode',
  'route',
  'tool',
  'method',
  'peer',
  'platform',
  'arch',
  'runtime',
  'backend',
  'name',
  'event',
  'category',
  'timestamp',
  'lastused',
  'startedat',
  'expiresat',
  'stage',
  'type',
  'status',
  'scope',
  'job',
  'jobid',
  'requestid',
  'projectid',
]);
const SAFE_NUMBER_KEYS = new Set([
  'count',
  'counts',
  'requests',
  'errors',
  'inputtokens',
  'outputtokens',
  'tokens',
  'audiominutes',
  'estimatedcost',
  'spend',
  'duration',
  'durationms',
  'bytes',
  'size',
  'sizebytes',
  'width',
  'height',
  'dimensions',
  'progress',
  'attempt',
  'attempts',
  'limit',
  'max',
  'total',
  'completed',
  'current',
  'port',
  'status',
  'statuscode',
  'line',
  'fps',
]);
const SAFE_BOOLEAN_KEYS = new Set([
  'available',
  'supported',
  'enabled',
  'visible',
  'focused',
  'haskey',
  'rawlogsincluded',
  'cancelled',
  'retryable',
  'islocal',
  'success',
]);
const SAFE_ERROR_CODES = new Set([
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'CANCELLED',
  'PERMISSION_DENIED',
  'CAPABILITY_UNAVAILABLE',
  'PROVIDER_ERROR',
  'MODEL_UNAVAILABLE',
  'SOURCE_CHANGED',
  'OUTPUT_COLLISION',
  'UPDATE_BLOCKED',
  'CORRUPT_DATA',
  'TAMPERED',
  'INTERNAL',
  'MCP_BIND_REJECTED',
  'MCP_SERVER_NOT_RUNNING',
  'MCP_SERVER_DRAINING',
  'MCP_UNAUTHORIZED',
  'MCP_TOKEN_EXPIRED',
  'MCP_TOKEN_REVOKED',
  'MCP_TOKEN_UNAVAILABLE',
  'MCP_UNSUPPORTED_VERSION',
  'MCP_INVALID_REQUEST',
  'MCP_REQUEST_TOO_LARGE',
  'MCP_REQUEST_TIMEOUT',
  'MCP_CONCURRENCY_LIMIT',
  'MCP_METHOD_NOT_FOUND',
  'MCP_PERMISSION_DENIED',
  'MCP_CONFIRMATION_REQUIRED',
  'MCP_CONFIRMATION_INVALID',
  'MCP_STALE_REVISION',
  'MCP_NOT_FOUND',
  'MCP_CONFLICT',
  'MCP_CAPABILITY_UNAVAILABLE',
  'MCP_INTERNAL',
]);
const SAFE_MCP_OUTCOMES = new Set(['success', 'denied', 'rejected', 'timeout']);
const SAFE_MCP_REASONS = new Set([
  'required',
  'unknown_or_expired',
  'challenge_mismatch',
  'not_approved',
  'missing_window',
  'parse_failed',
  'renderer_rejected',
  'server_error',
  'unauthorized',
  'timeout',
]);
const SAFE_MCP_CONFIRMATION_TEXTS = new Set([
  'Allow the MCP client to replace the selected transcript chunk text?',
  'Allow the MCP client to replace the selected transcript cue text?',
  'Allow the MCP client to change the selected cue timing?',
  'Allow the MCP client to add this glossary entry?',
  'Allow the MCP client to update this glossary entry?',
  'Allow the MCP client to delete this glossary entry?',
  'Allow the MCP client to approve this transcript chunk?',
  'Allow the MCP client to change approval for this batch of transcript chunks?',
  'Allow the MCP client to retranslate this transcript chunk?',
  'Allow the MCP client to reprocess this transcript chunk?',
  'Allow the MCP client to cancel this processing job?',
]);

const SAFE_MCP_MESSAGES = new Set([
  'NO_ACTIVE_PROJECT: No project is open',
]);

function clone(value) {
  if (value === undefined) return undefined;
  try {
    return structuredClone(value);
  } catch {
    return undefined;
  }
}

function isoNow(clock) {
  try {
    const value = typeof clock === 'function' ? clock() : clock;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  } catch {
    // fall through to the process clock
  }
  return new Date().toISOString();
}

function keyName(key) {
  return String(key || '').replace(/[^a-z0-9]/giu, '').toLowerCase();
}

function boundedString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, MAX_STRING_LENGTH);
}

function safeIdentifier(value, fallback = 'unknown') {
  const text = boundedString(value, '').trim();
  if (!text || !SAFE_ID_RE.test(text) || SECRET_VALUE_RE.test(text) || ABSOLUTE_PATH_RE.test(text)) return fallback;
  return text;
}

function safeRoute(value) {
  const text = boundedString(value, '').trim();
  if (!text || text.length > MAX_STRING_LENGTH || /[\u0000-\u001f\u007f]/u.test(text)) return 'unknown';
  const queryStart = text.search(/[?#]/u);
  const route = queryStart >= 0 ? text.slice(0, queryStart) : text;
  if (URL_RE.test(route) || ABSOLUTE_PATH_RE.test(route)) return '[REDACTED_PATH]';
  return route.replace(/[^A-Za-z0-9._:/=-]/gu, '_');
}

function safeCode(value, fallback = undefined) {
  if (typeof value !== 'string') return fallback;
  const code = value.trim().slice(0, MAX_STRING_LENGTH);
  return SAFE_CODE_RE.test(code) && SAFE_ERROR_CODES.has(code) ? code : fallback;
}

function hash(value, length = 32) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex').slice(0, length);
}

function fullHash(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function marker(kind) {
  if (kind === 'secret') return '[REDACTED_SECRET]';
  if (kind === 'path') return '[REDACTED_PATH]';
  if (kind === 'url') return '[REDACTED_URL]';
  return '[REDACTED_TEXT]';
}

function increment(counts, kind, amount = 1) {
  if (Object.prototype.hasOwnProperty.call(counts, kind)) counts[kind] += amount;
}

function initialCounts() {
  return { secret: 0, path: 0, text: 0, field: 0 };
}

function knownSecretMatch(value, knownSecrets) {
  if (typeof value !== 'string') return false;
  for (const secret of knownSecrets) {
    if (typeof secret === 'string' && secret.length > 0 && value.includes(secret)) return true;
  }
  return SECRET_VALUE_RE.test(value);
}

function classifyString(value, rawKey, counts, knownSecrets) {
  const key = keyName(rawKey);
  if (knownSecretMatch(value, knownSecrets) || SECRET_KEY_RE.test(rawKey)) {
    increment(counts, 'secret');
    return marker('secret');
  }
  if (URL_KEY_RE.test(rawKey)) {
    increment(counts, 'path');
    if (/^file:\/\//iu.test(value) || PATH_KEY_RE.test(rawKey)) return marker('path');
    return marker('url');
  }
  if (URL_RE.test(value) && /[?#]/u.test(value)) {
    increment(counts, 'path');
    return marker('url');
  }
  if (PATH_KEY_RE.test(rawKey) || ABSOLUTE_PATH_RE.test(value)) {
    increment(counts, 'path');
    return marker('path');
  }
  if (TEXT_KEY_RE.test(rawKey)) {
    increment(counts, 'text');
    return marker('text');
  }
  if (SAFE_STRING_KEYS.has(key)) {
    if (key === 'requestid' || key === 'projectid' || key === 'operationid' || key === 'jobid') return hash(value);
    const safe = key === 'route' || key === 'peer' || key === 'method' ? safeRoute(value) : safeIdentifier(value, 'unknown');
    if (safe === 'unknown' && value.trim()) increment(counts, 'field');
    return safe;
  }
  increment(counts, 'text');
  return marker('text');
}

function classifyNumber(value, rawKey, counts) {
  if (!Number.isFinite(value)) {
    increment(counts, 'field');
    return undefined;
  }
  const key = keyName(rawKey);
  if (!SAFE_NUMBER_KEYS.has(key)) {
    increment(counts, 'field');
    return undefined;
  }
  if (key === 'progress') return Math.min(1, Math.max(0, value));
  if (key === 'port') return Math.min(65535, Math.max(0, Math.round(value)));
  return Math.min(1_000_000_000_000, Math.max(0, value));
}

function projectValue(value, rawKey, depth, counts, knownSecrets) {
  if (depth > MAX_DATA_DEPTH) {
    increment(counts, 'field');
    return undefined;
  }
  if (value === null) {
    const key = keyName(rawKey);
    if (SAFE_STRING_KEYS.has(key) || SAFE_BOOLEAN_KEYS.has(key)) return null;
    increment(counts, 'field');
    return undefined;
  }
  if (typeof value === 'string') return classifyString(value, rawKey, counts, knownSecrets);
  if (typeof value === 'number') return classifyNumber(value, rawKey, counts);
  if (typeof value === 'boolean') {
    if (!SAFE_BOOLEAN_KEYS.has(keyName(rawKey))) {
      increment(counts, 'field');
      return undefined;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value.slice(0, MAX_ARRAY_LENGTH)) {
      const projected = projectValue(item, rawKey, depth + 1, counts, knownSecrets);
      if (projected !== undefined) out.push(projected);
    }
    if (value.length > MAX_ARRAY_LENGTH) increment(counts, 'field', value.length - MAX_ARRAY_LENGTH);
    return out;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_DATA_KEYS)) {
      const projected = projectValue(item, key, depth + 1, counts, knownSecrets);
      if (projected !== undefined) out[key] = projected;
    }
    if (Object.keys(value).length > MAX_DATA_KEYS) increment(counts, 'field', Object.keys(value).length - MAX_DATA_KEYS);
    return Object.keys(out).length > 0 ? out : undefined;
  }
  increment(counts, 'field');
  return undefined;
}

function projectData(data, counts, knownSecrets) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    if (data !== undefined) increment(counts, 'field');
    return undefined;
  }
  const projected = projectValue(data, 'data', 0, counts, knownSecrets);
  return projected && typeof projected === 'object' && !Array.isArray(projected) ? projected : undefined;
}

function safeCategory(value) {
  const category = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SAFE_CATEGORIES.has(category) ? category : 'runtime';
}

function safeEvent(value) {
  const event = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SAFE_EVENT_RE.test(event) ? event : 'unknown';
}

function safeCorrelation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const key of ['requestId', 'projectId', 'operationId', 'jobId']) {
    if (typeof value[key] === 'string' && value[key].length > 0) out[key] = hash(value[key]);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function errorClass(error) {
  const name = error && typeof error.name === 'string' ? error.name : error?.constructor?.name;
  if (name === 'AppError' || error?.isAppError === true) return 'AppError';
  if (name === 'McpServerError') return 'McpServerError';
  if (name === 'Error' || error instanceof Error) return 'Error';
  return 'UnknownError';
}

function safeErrorMessage(code) {
  if (code === 'PROVIDER_ERROR') return 'Provider request failed.';
  if (code && code.startsWith('MCP_')) return 'MCP request failed.';
  if (code === 'PERMISSION_DENIED') return 'Permission denied.';
  if (code === 'CAPABILITY_UNAVAILABLE' || code === 'MODEL_UNAVAILABLE') return 'Capability unavailable.';
  if (code === 'CANCELLED') return 'Operation cancelled.';
  if (code === 'VALIDATION_FAILED') return 'Validation failed.';
  if (code === 'NOT_FOUND') return 'Resource not found.';
  return 'Operation failed.';
}

function safeError(error, fallbackCode = 'INTERNAL') {
  const source = error && typeof error === 'object' ? error : {};
  const code = safeCode(source.code, safeCode(fallbackCode, 'INTERNAL')) || 'INTERNAL';
  const status = Number.isFinite(Number(source.status))
    ? Math.min(599, Math.max(100, Math.round(Number(source.status))))
    : undefined;
  return {
    name: errorClass(error),
    ...(code ? { code } : {}),
    message: safeErrorMessage(code),
    ...(status === undefined ? {} : { status }),
  };
}

function safeIpcError(error, fallbackCode = 'INTERNAL') {
  const normalized = safeError(error, fallbackCode);
  const result = {
    __appError: true,
    code: normalized.code || fallbackCode,
    message: normalized.message,
  };
  if (normalized.status !== undefined) result.status = normalized.status;
  const details = error && typeof error === 'object' ? error.details : undefined;
  const counts = initialCounts();
  const projected = projectData(details, counts, []);
  if (projected) result.details = projected;
  return result;
}

function safeMcpError(error, fallbackCode = 'MCP_INTERNAL') {
  const source = error && typeof error === 'object' ? error : {};
  const fallback = source.code || source.mcpCode || fallbackCode;
  const normalized = safeError(error, fallback === 'MCP_INTERNAL' ? 'INTERNAL' : fallback);
  const details = source.details && typeof source.details === 'object' ? source.details : {};
  const safeDetails = {};
  for (const key of ['challengeId', 'expiresAt', 'requiresHumanConfirmation', 'confirmationText', 'reason', 'tool', 'scope', 'currentProjectRevision', 'currentRevision']) {
    if (!(key in details)) continue;
    if (key === 'requiresHumanConfirmation') {
      if (typeof details[key] === 'boolean') safeDetails[key] = details[key];
      continue;
    }
    if (key === 'confirmationText') {
      if (normalized.code === 'MCP_CONFIRMATION_REQUIRED' && SAFE_MCP_CONFIRMATION_TEXTS.has(details[key])) {
        safeDetails[key] = details[key];
      }
      continue;
    }
    if (key === 'currentProjectRevision' || key === 'currentRevision') {
      if (Number.isFinite(Number(details[key]))) safeDetails[key] = Math.max(0, Math.round(Number(details[key])));
      continue;
    }
    if (key === 'expiresAt') {
      if (typeof details[key] === 'string' && /^\d{4}-\d{2}-\d{2}T/iu.test(details[key])) safeDetails[key] = details[key].slice(0, 32);
      continue;
    }
    const safe = safeIdentifier(details[key], '');
    if (safe) safeDetails[key] = SAFE_MCP_REASONS.has(safe) || key !== 'reason' ? safe : 'unknown';
  }
  const message = normalized.code === 'MCP_NOT_FOUND'
    && typeof source.message === 'string'
    && SAFE_MCP_MESSAGES.has(source.message)
    ? source.message
    : normalized.message;
  return {
    code: normalized.code || 'INTERNAL',
    message,
    ...(normalized.status === undefined ? {} : { status: normalized.status }),
    ...(Object.keys(safeDetails).length > 0 ? { details: safeDetails } : {}),
  };
}

function safeHashField(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return /^[0-9a-f]{64}$/u.test(value) ? value : fullHash(value);
}

function safeAuditRecord(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const rawCode = source.mcpCode || source.code || source.error?.mcpCode || source.error?.code;
  const mcpCode = typeof rawCode === 'string' && SAFE_CODE_RE.test(rawCode) && SAFE_ERROR_CODES.has(rawCode)
    ? rawCode
    : null;
  const rawReason = source.reason || source.error?.details?.reason;
  const reason = typeof rawReason === 'string' && SAFE_MCP_REASONS.has(rawReason) ? rawReason : null;
  const outcome = SAFE_MCP_OUTCOMES.has(source.outcome) ? source.outcome : 'rejected';
  const record = {
    timestamp: typeof source.timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T/iu.test(source.timestamp)
      ? source.timestamp.slice(0, 32)
      : new Date().toISOString(),
    peer: safeRoute(source.peer || 'unknown'),
    route: safeRoute(source.route || '/unknown'),
    tool: source.tool == null ? null : safeIdentifier(source.tool, null),
    outcome,
    mcpCode,
    reason,
    tokenIdHash: safeHashField(source.tokenIdHash || source.tokenId),
    requestIdHash: safeHashField(source.requestIdHash || source.requestId),
  };
  if (source.method != null) record.method = safeIdentifier(source.method, null);
  return record;
}

function boundedRecord(record) {
  try {
    if (Buffer.byteLength(JSON.stringify(record), 'utf8') <= MAX_RECORD_BYTES) return record;
  } catch {
    // fall through to a minimal record
  }
  const reduced = {
    schemaVersion: SCHEMA_VERSION,
    timestamp: record.timestamp,
    level: record.level,
    category: record.category,
    event: record.event,
    redactions: { ...record.redactions, field: record.redactions.field + 1 },
  };
  if (record.correlation) reduced.correlation = record.correlation;
  if (record.error) reduced.error = record.error;
  return reduced;
}

function createSafeLogger(sink, options = {}) {
  const target = typeof sink === 'function'
    ? sink
    : sink && typeof sink.info === 'function'
      ? (line, level) => {
        const method = typeof sink[level] === 'function' ? sink[level] : sink.info;
        method.call(sink, line);
      }
      : () => {};
  const knownSecrets = Array.isArray(options.knownSecrets)
    ? options.knownSecrets.filter((value) => typeof value === 'string' && value.length > 0)
    : [];

  let sinkFailures = 0;
  function emit(level, input) {
    const counts = initialCounts();
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    if (source !== input) counts.field += 1;
    const data = projectData(source.data, counts, knownSecrets);
    const correlation = safeCorrelation(source.correlation);
    const record = {
      schemaVersion: SCHEMA_VERSION,
      timestamp: isoNow(options.clock),
      level: SAFE_LEVELS.has(level) ? level : 'info',
      category: safeCategory(source.category),
      event: safeEvent(source.event),
      ...(correlation ? { correlation } : {}),
      ...(data ? { data } : {}),
      ...(source.error !== undefined ? { error: safeError(source.error) } : {}),
      redactions: counts,
    };
    const bounded = boundedRecord(record);
    try {
      target(JSON.stringify(bounded), level);
    } catch {
      sinkFailures += 1;
      try { options.onSinkFailure?.(); } catch { /* telemetry must never affect product operations */ }
    }
    return bounded;
  }

  return {
    debug: (input) => emit('debug', input),
    info: (input) => emit('info', input),
    warn: (input) => emit('warn', input),
    error: (input) => emit('error', input),
    getSinkFailures: () => sinkFailures,
  };
}

function configureElectronLog(log, options = {}) {
  if (!log || !log.transports) return null;
  const userDataPath = typeof options.userDataPath === 'string' && options.userDataPath.length > 0
    ? options.userDataPath
    : typeof options.getUserDataPath === 'function'
      ? options.getUserDataPath()
      : null;
  const logPath = path.join(userDataPath || process.cwd(), 'logs', 'main.log');
  try { log.initialize?.(); } catch { /* electron-log may already be initialized */ }
  if (log.transports.file) {
    const file = log.transports.file;
    file.level = 'info';
    file.maxSize = 5 * 1024 * 1024;
    file.writeOptions = { ...(file.writeOptions || {}), flag: 'a', mode: 0o600, encoding: 'utf8' };
    file.resolvePathFn = () => logPath;
    file.archiveLogFn = (fileObject) => {
      const current = typeof fileObject === 'string' ? fileObject : fileObject?.toString?.() || logPath;
      try {
        fs.mkdirSync(path.dirname(current), { recursive: true });
        fs.rmSync(`${current}.3`, { force: true });
        for (let index = 2; index >= 1; index -= 1) {
          if (fs.existsSync(`${current}.${index}`)) fs.renameSync(`${current}.${index}`, `${current}.${index + 1}`);
        }
        if (fs.existsSync(current)) fs.renameSync(current, `${current}.1`);
      } catch {
        try { fileObject?.crop?.(Math.min(file.maxSize / 4, 256 * 1024)); } catch { /* best effort */ }
      }
    };
  }
  if (log.transports.console) log.transports.console.level = 'debug';
  if (log.transports.remote) log.transports.remote.level = false;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (fs.existsSync(logPath)) fs.chmodSync(logPath, 0o600);
  } catch {
    // electron-log remains usable even when the platform denies chmod.
  }
  return logPath;
}

function resolveSettings(settingsStore) {
  if (!settingsStore || typeof settingsStore.readSettings !== 'function') return {};
  try {
    const result = settingsStore.readSettings();
    return result && result.settings ? result.settings : result || {};
  } catch {
    return {};
  }
}

function writeSettings(settingsStore, settings) {
  if (!settingsStore || typeof settingsStore.writeSettings !== 'function') throw new Error('settings unavailable');
  return settingsStore.writeSettings(settings);
}

function settingsProjection(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const api = source.api && typeof source.api === 'object' ? source.api : {};
  const providers = api.providers && typeof api.providers === 'object' ? api.providers : {};
  const legacyProviders = Object.keys(providers).length > 0
    ? providers
    : {
      ...(source.geminiKey !== undefined ? { 'gemini-cloud': { enabled: true, model: null, transcriptionModel: null, translationModel: null, keyRef: source.geminiKey } } : {}),
      ...(source.openaiKey !== undefined ? { 'gpt-cloud': { enabled: true, model: null, transcriptionModel: null, translationModel: null, keyRef: source.openaiKey } } : {}),
      ...(source.anthropicKey !== undefined ? { 'claude-cloud': { enabled: true, model: null, transcriptionModel: null, translationModel: null, keyRef: source.anthropicKey } } : {}),
    };
  const providerRows = Object.entries(legacyProviders).slice(0, 128).map(([id, value]) => {
    const provider = value && typeof value === 'object' ? value : {};
    const keyRef = provider.keyRef ?? provider.apiKey ?? provider.key ?? provider.token;
    return {
      id: safeIdentifier(id),
      enabled: provider.enabled !== false,
      model: safeIdentifier(provider.model, null),
      transcriptionModel: safeIdentifier(provider.transcriptionModel, null),
      translationModel: safeIdentifier(provider.translationModel, null),
      hasKey: typeof keyRef === 'string' && keyRef.length > 0,
    };
  });
  const agents = source.agents && typeof source.agents === 'object' ? source.agents : {};
  const permissions = agents.permissions && typeof agents.permissions === 'object' ? agents.permissions : {};
  const appearance = source.appearance && typeof source.appearance === 'object' ? source.appearance : {};
  const transcription = source.transcription && typeof source.transcription === 'object' ? source.transcription : {};
  const chunking = source.chunking && typeof source.chunking === 'object' ? source.chunking : {};
  const media = chunking.media && typeof chunking.media === 'object' ? chunking.media : {};
  const document = chunking.document && typeof chunking.document === 'object' ? chunking.document : {};
  return {
    schemaVersion: Number.isFinite(Number(source.schemaVersion)) ? Math.max(0, Math.round(Number(source.schemaVersion))) : 0,
    providers: providerRows,
    agents: {
      preferredAgent: safeIdentifier(agents.preferredAgent ?? source.preferredAgent, 'codex'),
      embeddedChatEnabled: Boolean(agents.embeddedChatEnabled ?? source.embeddedChatEnabled),
      localMcpEnabled: Boolean(agents.localMcpEnabled ?? source.localMcpEnabled),
      mcpPort: Number.isFinite(Number(agents.mcpPort ?? source.mcpPort)) ? Math.min(65535, Math.max(0, Math.round(Number(agents.mcpPort ?? source.mcpPort)))) : null,
      permissions: Object.fromEntries(Object.entries(permissions).slice(0, 32).map(([key, value]) => [safeIdentifier(key), Boolean(value)])),
    },
    appearance: {
      theme: safeIdentifier(appearance.theme ?? source.theme, 'system'),
      density: safeIdentifier(appearance.density ?? source.density, 'comfortable'),
      baseFontSize: Number.isFinite(Number(appearance.baseFontSize ?? source.baseFontSize)) ? Math.min(72, Math.max(8, Number(appearance.baseFontSize ?? source.baseFontSize))) : 14,
      scale: Number.isFinite(Number(appearance.scale ?? source.fontScale)) ? Math.min(3, Math.max(0.5, Number(appearance.scale ?? source.fontScale))) : 1,
      reduceMotion: Boolean(appearance.reduceMotion),
      highContrast: Boolean(appearance.highContrast),
    },
    transcription: {
      defaultSourceLanguage: safeIdentifier(transcription.defaultSourceLanguage ?? source.defaultSourceLang, 'auto'),
      defaultTranscriptionProvider: safeIdentifier(transcription.defaultTranscriptionProvider ?? source.transcriptionProvider, ''),
      defaultTranslationProvider: safeIdentifier(transcription.defaultTranslationProvider ?? source.translationProvider, ''),
      defaultTargetLanguage: safeIdentifier(transcription.defaultTargetLanguage ?? source.defaultTargetLang, 'en'),
    },
    chunking: {
      mediaTargetDurationMinutes: Number.isFinite(Number(media.targetDurationMinutes ?? source.chunkDurationMin)) ? Math.min(60, Math.max(1, Number(media.targetDurationMinutes ?? source.chunkDurationMin))) : 10,
      documentTargetTokens: Number.isFinite(Number(document.targetTokens)) ? Math.min(100000, Math.max(1, Number(document.targetTokens))) : 1000,
      sliceMode: safeIdentifier(media.sliceMode ?? source.sliceMode, 'silence'),
    },
  };
}

function capabilityProjection(source) {
  const value = typeof source === 'function' ? source() : source;
  const report = value && typeof value.getAll === 'function' ? value.getAll() : value?.capabilities ?? value ?? {};
  const host = value && typeof value.getHost === 'function' ? value.getHost() : value?.host ?? {};
  const entries = {};
  for (const [key, status] of Object.entries(report && typeof report === 'object' ? report : {}).slice(0, 128)) {
    if (!status || typeof status !== 'object') continue;
    entries[safeIdentifier(key)] = {
      available: Boolean(status.available),
      ...(typeof status.reasonCode === 'string' ? { reasonCode: safeIdentifier(status.reasonCode, 'UNKNOWN') } : {}),
      ...(typeof status.backend === 'string' ? { backend: safeIdentifier(status.backend, 'unknown') } : {}),
    };
  }
  return {
    host: {
      platform: safeIdentifier(host.platform, process.platform),
      arch: safeIdentifier(host.arch, process.arch),
      audioLoopbackAvailable: Boolean(host.audioLoopbackAvailable),
    },
    entries,
  };
}

function modelProjection(source) {
  let value = typeof source === 'function' ? source() : source;
  if (value && typeof value.then === 'function') value = {};
  const entries = Array.isArray(value) ? value : Array.isArray(value?.entries) ? value.entries : [];
  const out = [];
  for (const item of entries.slice(0, 100)) {
    if (!item || typeof item !== 'object') continue;
    const modelId = safeIdentifier(item.modelId ?? item.id ?? item.name, 'unknown');
    const runtime = item.runtime == null ? null : safeIdentifier(item.runtime, null);
    const role = item.role == null ? null : safeIdentifier(item.role, null);
    const size = Number(item.sizeBytes ?? item.bytes ?? item.size);
    out.push({
      modelId,
      runtime,
      role,
      supported: Boolean(item.supported),
      ...(Number.isFinite(size) && size >= 0 ? { sizeBytes: Math.min(1_000_000_000_000, Math.round(size)) } : {}),
    });
  }

  return { entries: out, truncated: entries.length > out.length };
}
/**
 * Build the production legacy-MCP audit seam without exposing a second field
 * policy. The transport supplies only request metadata; this helper performs
 * the shared projection before handing the record to the central ring.
 */
function createLegacyAuditRecorder(audit, clock) {
  return (input) => {
    if (!audit || typeof audit.record !== 'function') return null;
    const record = safeAuditRecord({ ...input, timestamp: isoNow(clock) });
    try { return audit.record(record); } catch { return null; }
  };
}

function createObservability(options = {}) {
  const settingsStore = options.settingsStore || null;
  const recentErrors = [];
  const audits = [];
  let telemetryFailures = 0;
  const baseLogger = createSafeLogger(options.sink, {
    clock: options.clock,
    knownSecrets: options.knownSecrets,
    onSinkFailure: () => { telemetryFailures += 1; },
  });

  function readUsage() {
    const settings = resolveSettings(settingsStore);
    return normalizeUsageLedger(settings.api?.lastUsage);
  }

  function persistUsage(next) {
    const settings = resolveSettings(settingsStore);
    const merged = {
      ...settings,
      api: {
        ...(settings.api && typeof settings.api === 'object' ? settings.api : {}),
        lastUsage: next,
      },
    };
    writeSettings(settingsStore, merged);
  }

  const usage = {
    get(range) {
      try { return projectUsage(readUsage(), range); } catch { return projectUsage(createDefaultUsageLedger(), range); }
    },
    project(range) {
      return this.get(range);
    },
    record(input) {
      const current = readUsage();
      let next;
      try {
        next = recordUsageLedger(current, input, new Date(isoNow(options.clock)));
      } catch (error) {
        try { baseLogger.warn({ category: 'usage', event: 'usage.record-failed', error }); } catch { /* best effort */ }
        return projectUsage(current);
      }
      try {
        persistUsage(next);
      } catch (error) {
        try { baseLogger.warn({ category: 'usage', event: 'usage.persistence-failed', error }); } catch { /* best effort */ }
      }
      return projectUsage(next);
    },
    reset() {
      const next = createDefaultUsageLedger();
      try { persistUsage(next); } catch (error) {
        try { baseLogger.warn({ category: 'usage', event: 'usage.reset-failed', error }); } catch { /* best effort */ }
      }
      return projectUsage(next);
    },
    export(range) {
      return clone(projectUsage(readUsage(), range));
    },
  };

  const audit = {
    record(input) {
      const record = safeAuditRecord(input);
      audits.push(record);
      if (audits.length > MAX_AUDIT_RECORDS) audits.splice(0, audits.length - MAX_AUDIT_RECORDS);
      try {
        baseLogger.info({ category: 'mcp', event: 'mcp.audit', data: record });
      } catch { /* audit must never alter the MCP result */ }
      return clone(record);
    },
    list(query = {}) {
      let rows = audits;
      if (query && typeof query.outcome === 'string') rows = rows.filter((row) => row.outcome === query.outcome);
      if (query && typeof query.since === 'string') {
        const since = Date.parse(query.since);
        if (Number.isFinite(since)) rows = rows.filter((row) => Date.parse(row.timestamp) >= since);
      }
      const limit = Number.isInteger(query?.limit) && query.limit > 0 ? query.limit : rows.length;
      return rows.slice(Math.max(0, rows.length - limit)).map(clone);
    },
    clear() { audits.length = 0; },
  };

  function recordError(error, context = {}) {
    const safe = safeError(error);
    const record = baseLogger.error({
      category: context.category || 'runtime',
      event: context.event || 'error',
      correlation: context.correlation,
      error,
    });
    const recent = {
      timestamp: record.timestamp,
      category: record.category,
      event: record.event,
      ...(record.correlation ? { correlation: record.correlation } : {}),
      error: safe,
      redactions: record.redactions,
    };
    recentErrors.push(recent);
    if (recentErrors.length > MAX_RECENT_ERRORS) recentErrors.splice(0, recentErrors.length - MAX_RECENT_ERRORS);
    return clone(recent);
  }

  function safeDiagnostics() {
    const partialFailures = [];
    let settings = {};
    let capabilities = { host: { platform: process.platform, arch: process.arch, audioLoopbackAvailable: false }, entries: {} };
    let models = { entries: [], truncated: false };
    let errors = [];
    try {
      if (!settingsStore || typeof settingsStore.readSettings !== 'function') throw new Error('settings unavailable');
      const settingsResult = settingsStore.readSettings();
      settings = settingsProjection(settingsResult?.settings ?? settingsResult);
    } catch {
      partialFailures.push({ component: 'settings', code: 'UNAVAILABLE' });
    }
    try { capabilities = capabilityProjection(options.capabilities); } catch { partialFailures.push({ component: 'capabilities', code: 'UNAVAILABLE' }); }
    try { models = modelProjection(options.models); } catch { partialFailures.push({ component: 'models', code: 'UNAVAILABLE' }); }
    try { errors = recentErrors.map(clone).filter(Boolean); } catch { partialFailures.push({ component: 'errors', code: 'UNAVAILABLE' }); }
    let logsAvailable = false;
    try {
      logsAvailable = typeof options.logsAvailable === 'function' ? Boolean(options.logsAvailable()) : Boolean(options.logsAvailable);
    } catch {
      partialFailures.push({ component: 'diagnostics', code: 'LOGS_UNAVAILABLE' });
    }
    const appInfo = (() => {
      try { return typeof options.appInfo === 'function' ? options.appInfo() : options.appInfo || {}; } catch { partialFailures.push({ component: 'diagnostics', code: 'APP_INFO_UNAVAILABLE' }); return {}; }
    })();
    try {
      return {
        schemaVersion: 1,
        generatedAt: isoNow(options.clock),
        app: {
          appVersion: safeIdentifier(appInfo.appVersion, 'unknown'),
          electronVersion: safeIdentifier(appInfo.electronVersion || process.versions.electron, 'unknown'),
          platform: safeIdentifier(appInfo.platform || process.platform, process.platform),
          arch: safeIdentifier(appInfo.arch || process.arch, process.arch),
        },
        capabilities,
        logsAvailable,
        models,
        settings,
        recentErrors: errors,
        partialFailures,
        rawLogsIncluded: false,
      };
    } catch {
      return {
        schemaVersion: 1,
        generatedAt: isoNow(options.clock),
        capabilities,
        partialFailures: [...partialFailures, { component: 'diagnostics', code: 'ASSEMBLY_FAILED' }],
        rawLogsIncluded: false,
      };
    }
  }

  const diagnostics = { snapshot: safeDiagnostics };

  return {
    logger: baseLogger,
    recordError,
    safeError,
    safeIpcError,
    safeMcpError,
    audit,
    usage,
    diagnostics,
    getTelemetryFailures: () => telemetryFailures + baseLogger.getSinkFailures(),
  };
}

module.exports = {
  SCHEMA_VERSION,
  MAX_RECORD_BYTES,
  MAX_RECENT_ERRORS,
  MAX_AUDIT_RECORDS,
  configureElectronLog,
  createSafeLogger,
  createObservability,
  createLegacyAuditRecorder,
  safeError,
  safeIpcError,
  safeMcpError,
  safeAuditRecord,
  safeCorrelation,
  hash,
};
