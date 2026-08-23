'use strict';

/**
 * Embedded agent clients (MCP-04).
 *
 * The module owns the provider protocol boundary, but not IPC or UI wiring. A
 * client is deliberately constructed with an injectable fetch implementation
 * so protocol and cancellation behavior can be exercised without real network
 * calls. Provider credentials are resolved from the Main-process vault and are
 * never included in a stream event, status projection, or history record.
 *
 * §13.5 path stripping (visible): start() and the outbound prompt builder
 * replace absolute filesystem paths with `[REDACTED_PATH]` so the agent never
 * receives arbitrary filesystem paths. Exact vault-secret values are
 * substituted after credential resolution. Secret-shaped key/token heuristics
 * are not applied to outbound prompts or inbound tokens. Counts are reported
 * on done/error/status as `redactions: [{ kind: 'path'|'secret', count }]`.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {
  AppError,
  isAppError,
} = require('../../../shared/contracts/errors.ts');
const defaultVault = require('../storage/vault.js');

const AGENT_PROFILES = Object.freeze(['codex', 'grok', 'qwen']);
const DEFAULT_HISTORY_LIMIT = 20;
const HISTORY_VERSION = 1;
const HISTORY_FILENAME = 'agent-history.json';
const DEFAULT_MODELS = Object.freeze({
  codex: 'gpt-5',
  grok: 'grok-4.1',
  qwen: 'qwen-max',
});

const PROFILE_DEFINITIONS = Object.freeze({
  codex: Object.freeze({
    id: 'codex',
    label: 'Codex',
    provider: 'OpenAI Responses',
    endpoint: 'https://api.openai.com/v1/responses',
    defaultModel: DEFAULT_MODELS.codex,
  }),
  grok: Object.freeze({
    id: 'grok',
    label: 'Grok',
    provider: 'xAI Chat Completions',
    endpoint: 'https://api.x.ai/v1/chat/completions',
    defaultModel: DEFAULT_MODELS.grok,
  }),
  qwen: Object.freeze({
    id: 'qwen',
    label: 'Qwen',
    provider: 'Alibaba DashScope Chat Completions',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    defaultModel: DEFAULT_MODELS.qwen,
  }),
});

const SECRET_KEY_PATTERN = /(?:pass(?:word|phrase)?|secret|api[_-]?key|access[_-]?token|authorization|bearer|private[_-]?key|credential)/i;
const PATH_KEY_PATTERN = /(?:^|[_-])(?:path|file|filename|directory|dirname|folder|absolutePath|sourcePath|outputPath)$/i;
const MANUSCRIPT_KEY_PATTERN = /^(?:manuscript|rawText|sourceText|documentText|selectionText)$/i;
const ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'=\[(])(?:\/(?:Users|private|var|tmp|home|Volumes|System|Applications)\/|[A-Za-z]:[\\/])[^\s"'`\])},;]+/g;
const SECRET_SHAPED_PATTERNS = Object.freeze([
  /\b(?:sk|xai|gsk|sk-proj|sess|key|token)[_-][A-Za-z0-9][A-Za-z0-9._~+\-/=]{8,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+\-/=]{12,}\b/gi,
  /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9._~+\-/=]{8,}["']?/gi,
]);

function nowIso() {
  return new Date().toISOString();
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function recordRedaction(report, kind, count) {
  if (!report || !count) return;
  report[kind] = (report[kind] || 0) + count;
}

function redactionReport(counts = {}) {
  return [
    { kind: 'path', count: counts.path || 0 },
    { kind: 'secret', count: counts.secret || 0 },
  ];
}

function substituteExactSecrets(value, secrets = []) {
  if (typeof value !== 'string') return { text: value, count: 0 };
  let output = value;
  let count = 0;
  const usableSecrets = secrets
    .filter((secret) => typeof secret === 'string' && secret.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const secret of usableSecrets) {
    if (!output.includes(secret)) continue;
    const pieces = output.split(secret);
    count += pieces.length - 1;
    output = pieces.join('[REDACTED]');
  }
  return { text: output, count };
}

function stripAbsolutePaths(value) {
  if (typeof value !== 'string') return { text: value, count: 0 };
  let count = 0;
  const text = value.replace(ABSOLUTE_PATH_PATTERN, () => {
    count += 1;
    return '[REDACTED_PATH]';
  });
  return { text, count };
}

function redactString(value, secrets = []) {
  if (typeof value !== 'string') return value;
  let output = substituteExactSecrets(value, secrets).text;
  for (const pattern of SECRET_SHAPED_PATTERNS) output = output.replace(pattern, '[REDACTED]');
  return stripAbsolutePaths(output).text;
}

/**
 * Outbound prompt/context sanitizer (§13.5): exact vault-secret substitution
 * plus visible absolute-path stripping. No key/token heuristic.
 */
function sanitizeOutboundText(value, secrets = [], report = null) {
  if (typeof value !== 'string') return value;
  const secreted = substituteExactSecrets(value, secrets);
  recordRedaction(report, 'secret', secreted.count);
  const pathed = stripAbsolutePaths(secreted.text);
  recordRedaction(report, 'path', pathed.count);
  return pathed.text;
}

/**
 * Inbound token sanitizer: exact vault-secret substitution only.
 */
function sanitizeInboundText(value, secrets = [], report = null) {
  if (typeof value !== 'string') return value;
  const secreted = substituteExactSecrets(value, secrets);
  recordRedaction(report, 'secret', secreted.count);
  return secreted.text;
}

/**
 * Redact a value recursively before it can reach history or an error event.
 * Manuscript/selection fields are represented by a marker in persisted data,
 * while ordinary assistant input/output remains available as bounded history.
 */
function redactValue(value, options = {}, key = '') {
  const secrets = Array.isArray(options.secrets) ? options.secrets : [];
  if (SECRET_KEY_PATTERN.test(key)) return '[REDACTED]';
  if (PATH_KEY_PATTERN.test(key)) return '[REDACTED_PATH]';
  if (MANUSCRIPT_KEY_PATTERN.test(key)) return '[REDACTED_MANUSCRIPT]';
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, options, key));
  if (!isRecord(value)) return value;
  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    output[childKey] = redactValue(childValue, options, childKey);
  }
  return output;
}

function sanitizeForTransport(value, key = '', report = null, secrets = []) {
  if (SECRET_KEY_PATTERN.test(key) || PATH_KEY_PATTERN.test(key)) return undefined;
  if (typeof value === 'string') return sanitizeOutboundText(value, secrets, report);
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeForTransport(item, key, report, secrets))
      .filter((item) => item !== undefined);
  }
  if (!isRecord(value)) return value;
  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const sanitized = sanitizeForTransport(childValue, childKey, report, secrets);
    if (sanitized !== undefined) output[childKey] = sanitized;
  }
  return output;
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function historyKey(profile, projectId) {
  const digest = crypto
    .createHash('sha256')
    .update(`${profile}\u0000${projectId}`)
    .digest('hex');
  return `${profile}:${digest}`;
}

function defaultHistoryPath() {
  try {
    // Lazy import keeps this module usable under plain node tests.
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'agents', HISTORY_FILENAME);
    }
  } catch {
    // Electron is not present in unit tests; use a user-owned non-project path.
  }
  return path.join(os.homedir(), '.vaniscript', 'agents', HISTORY_FILENAME);
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'w', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

class AgentClientError extends AppError {
  constructor(code, message, details) {
    super(code, message, details);
    this.name = 'AgentClientError';
    Object.setPrototypeOf(this, AgentClientError.prototype);
  }
}

function agentError(code, message, details, secrets = []) {
  const safeDetails = redactValue(details, { secrets });
  const safeMessage = redactString(message, secrets);
  return new AgentClientError(code, safeMessage, safeDetails);
}

function isAbortError(error) {
  return Boolean(error) && (
    error.name === 'AbortError' ||
    error.code === 'ABORT_ERR' ||
    /aborted|abort|cancel/i.test(typeof error.message === 'string' ? error.message : '')
  );
}

function normalizeThrown(error, profile, secrets, signal) {
  if (signal?.aborted || isAbortError(error)) {
    return agentError('CANCELLED', `Agent stream for ${profile} was cancelled.`, { profile }, secrets);
  }
  if (error instanceof AgentClientError) {
    return agentError(error.code, error.message, error.details, secrets);
  }
  if (isAppError(error)) {
    return agentError(error.code, error.message, error.details, secrets);
  }
  const message = error && typeof error.message === 'string' ? error.message : String(error);
  return agentError(
    'PROVIDER_ERROR',
    `Agent ${profile} request failed.`,
    { profile, cause: message },
    secrets,
  );
}

function numeric(value) {
  return Number.isFinite(Number(value)) ? Number(value) : undefined;
}

function normalizeUsage(value) {
  if (!isRecord(value)) return undefined;
  const promptTokens = numeric(value.prompt_tokens ?? value.input_tokens ?? value.promptTokens);
  const completionTokens = numeric(value.completion_tokens ?? value.output_tokens ?? value.completionTokens);
  const totalTokens = numeric(value.total_tokens ?? value.totalTokens);
  const output = {};
  if (promptTokens !== undefined) output.promptTokens = promptTokens;
  if (completionTokens !== undefined) output.completionTokens = completionTokens;
  if (totalTokens !== undefined) output.totalTokens = totalTokens;
  return Object.keys(output).length > 0 ? output : undefined;
}

function streamError(profile, reason, details) {
  return agentError('PROVIDER_ERROR', `Malformed ${profile} streaming response.`, {
    profile,
    reason,
    ...(details || {}),
  });
}

function parseJsonPayload(raw, profile) {
  if (raw === '[DONE]') return { done: true };
  try {
    const payload = JSON.parse(raw);
    if (!isRecord(payload)) throw new Error('payload is not an object');
    return payload;
  } catch {
    throw streamError(profile, 'invalid_json');
  }
}

function isCodexVisibleTextDelta(type) {
  return type === 'response.output_text.delta'
    || type === 'response.text.delta'
    || type === 'output_text.delta'
    || type === 'text.delta';
}

function parseCodexEvent(raw, eventName) {
  const payload = parseJsonPayload(raw, 'codex');
  if (payload.done) return payload;
  if (payload.error) {
    throw agentError('PROVIDER_ERROR', 'Codex returned a streaming error.', { profile: 'codex' });
  }
  const type = String(payload.type || eventName || '');
  if (isCodexVisibleTextDelta(type) && typeof payload.delta === 'string') {
    return { token: payload.delta };
  }
  if (type === 'response.completed' || type === 'response.done' || /\.completed$/.test(type)) {
    return { done: true, usage: normalizeUsage(payload.response?.usage || payload.usage) };
  }
  if (
    type === 'response.failed'
    || type === 'response.error'
    || type === 'error'
    || type === 'response.incomplete'
  ) {
    throw agentError('PROVIDER_ERROR', 'Codex returned a streaming error.', {
      profile: 'codex',
      reason: type === 'response.incomplete' ? 'incomplete' : undefined,
    });
  }
  if (Array.isArray(payload.choices)) return parseChatEvent(payload, 'codex');
  return null;
}

function parseChatEvent(payload, profile) {
  if (payload.done) return payload;
  if (payload.error) {
    throw agentError('PROVIDER_ERROR', `${profile} returned a streaming error.`, { profile });
  }
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  if (choices.length > 0) {
    const first = choices[0] || {};
    const delta = first.delta;
    if (typeof delta === 'string') return { token: delta };
    if (isRecord(delta) && typeof delta.content === 'string' && delta.content.length > 0) {
      return { token: delta.content };
    }
    if (first.finish_reason) return { done: true, usage: normalizeUsage(payload.usage) };
    return null;
  }
  if (payload.type && /(?:completed|done)$/.test(String(payload.type))) {
    return { done: true, usage: normalizeUsage(payload.usage) };
  }
  if (payload.usage) return { done: true, usage: normalizeUsage(payload.usage) };
  if (payload.object || payload.id || payload.created) return null;
  throw streamError(profile, 'unknown_event');
}

function parseProviderEvent(profile, raw, eventName) {
  if (profile === 'codex') return parseCodexEvent(raw, eventName);
  return parseChatEvent(parseJsonPayload(raw, profile), profile);
}

class StreamParser {
  constructor(profile, onEvent) {
    this.profile = profile;
    this.onEvent = onEvent;
    this.mode = 'unknown';
    this.buffer = '';
    this.eventName = '';
    this.eventData = [];
    this.done = false;
  }

  push(text) {
    if (this.done) return;
    this.buffer += text;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.processLine(line);
      if (this.done) break;
    }
  }

  finish() {
    if (this.done) return;
    if (this.buffer.length > 0) {
      const line = this.buffer.replace(/\r$/, '');
      this.buffer = '';
      this.processLine(line);
    }
    if (this.mode === 'sse' && this.eventData.length > 0 && !this.done) this.dispatchSse();
  }

  processLine(line) {
    if (this.done) return;
    const trimmed = line.trim();
    if (this.mode === 'unknown') {
      if (!trimmed) return;
      this.mode = trimmed.startsWith('data:') || trimmed.startsWith('event:') || trimmed.startsWith(':')
        ? 'sse'
        : 'jsonl';
    }
    if (this.mode === 'jsonl') {
      if (!trimmed) return;
      this.dispatchRaw(trimmed, '');
      return;
    }
    if (line === '') {
      this.dispatchSse();
      return;
    }
    if (line.startsWith(':')) return;
    if (line.startsWith('event:')) {
      this.eventName = line.slice(6).trim();
      return;
    }
    if (line.startsWith('data:')) {
      this.eventData.push(line.slice(5).replace(/^ /, ''));
      return;
    }
    if (line.startsWith('id:') || line.startsWith('retry:')) return;
    throw streamError(this.profile, 'invalid_sse_line');
  }

  dispatchSse() {
    const raw = this.eventData.join('\n').trim();
    const eventName = this.eventName;
    this.eventData = [];
    this.eventName = '';
    if (raw) this.dispatchRaw(raw, eventName);
  }

  dispatchRaw(raw, eventName) {
    const result = this.onEvent(raw, eventName);
    if (result && result.done) this.done = true;
  }
}

async function cancelBody(body) {
  if (!body) return;
  try {
    if (typeof body.cancel === 'function') await body.cancel();
  } catch {
    // Abort is already authoritative; a stream that rejects cancel is closed by
    // the AbortController in the normal fetch implementation.
  }
}

async function consumeResponseBody(response, profile, signal, onEvent, setReader) {
  if (!response || !response.body) {
    throw streamError(profile, 'missing_body');
  }
  const parser = new StreamParser(profile, onEvent);
  const decoder = new TextDecoder();
  const body = response.body;
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    setReader(reader);
    try {
      while (!signal.aborted) {
        const next = await reader.read();
        if (next.done) break;
        if (next.value !== undefined) {
          const chunk = typeof next.value === 'string'
            ? next.value
            : decoder.decode(next.value, { stream: true });
          parser.push(chunk);
          if (parser.done) break;
        }
      }
      if (!signal.aborted && !parser.done) parser.push(decoder.decode());
      if (!signal.aborted && !parser.done) parser.finish();
    } finally {
      if (parser.done || signal.aborted) await cancelBody(body);
      try { reader.releaseLock(); } catch { /* best effort */ }
      setReader(null);
    }
  } else if (typeof body[Symbol.asyncIterator] === 'function') {
    try {
      for await (const next of body) {
        if (signal.aborted) break;
        const chunk = typeof next === 'string' ? next : decoder.decode(next, { stream: true });
        parser.push(chunk);
        if (parser.done) break;
      }
      if (!signal.aborted && !parser.done) parser.push(decoder.decode());
      if (!signal.aborted && !parser.done) parser.finish();
    } finally {
      if (parser.done || signal.aborted && typeof body.return === 'function') {
        try { await body.return?.(); } catch { /* best effort */ }
      }
    }
  } else if (typeof response.text === 'function') {
    const text = await response.text();
    if (signal.aborted) return;
    parser.push(text);
    if (!parser.done) parser.finish();
  } else {
    throw streamError(profile, 'unsupported_body');
  }
  if (signal.aborted) throw new Error('aborted');
  if (!parser.done) throw streamError(profile, 'incomplete_stream');
}


function extractContextMessages(context, secrets, report) {
  if (!isRecord(context) || !Array.isArray(context.messages)) return [];
  return context.messages
    .filter((message) => isRecord(message) && typeof message.content === 'string')
    .map((message) => ({
      role: message.role === 'assistant' || message.role === 'system' ? message.role : 'user',
      content: sanitizeOutboundText(message.content, secrets, report),
    }));
}

function historyMessages(history, secrets, report) {
  const messages = [];
  for (const item of Array.isArray(history) ? history : []) {
    if (typeof item.input === 'string') {
      messages.push({ role: 'user', content: sanitizeOutboundText(item.input, secrets, report) });
    }
    if (typeof item.output === 'string' && item.output.length > 0) {
      messages.push({ role: 'assistant', content: sanitizeOutboundText(item.output, secrets, report) });
    }
  }
  return messages;
}

function buildMessages(input, context, history, secrets = [], report = null) {
  const safeContext = sanitizeForTransport(context, '', report, secrets);
  const messages = [
    ...historyMessages(history, secrets, report),
    ...extractContextMessages(safeContext, secrets, report),
  ];
  if (typeof safeContext?.system === 'string' && safeContext.system.length > 0) {
    messages.unshift({ role: 'system', content: safeContext.system });
  }
  messages.push({ role: 'user', content: sanitizeOutboundText(input, secrets, report) });
  return messages;
}


function addReasoning(body, profile, reasoning) {
  if (reasoning === undefined || reasoning === null || reasoning === '') return;
  if (profile === 'codex') {
    body.reasoning = isRecord(reasoning) ? clone(reasoning) : { effort: reasoning };
  } else if (profile === 'grok') {
    body.reasoning_effort = reasoning;
  } else {
    if (typeof reasoning === 'boolean') {
      body.enable_thinking = reasoning;
    } else if (isRecord(reasoning)) {
      body.enable_thinking = reasoning.enabled !== false;
      if (reasoning.budget !== undefined) body.thinking_budget = reasoning.budget;
    } else {
      body.enable_thinking = reasoning !== 'none' && reasoning !== 'off';
    }
  }
}

function buildRequestBody(profile, model, reasoning, input, context, history, secrets = [], report = null) {
  const messages = buildMessages(input, context, history, secrets, report);
  const body = { model, stream: true };
  if (profile === 'codex') {
    body.input = messages;
  } else {
    body.messages = messages;
  }
  addReasoning(body, profile, reasoning);
  return body;
}


function authHeaders(profile, secret) {
  if (profile === 'codex' || profile === 'grok' || profile === 'qwen') {
    return { authorization: `Bearer ${secret}` };
  }
  return {};
}
function validateEndpoint(endpoint, profile, definition, allowedHosts, allowAnyHost) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw agentError('VALIDATION_FAILED', `Invalid endpoint configured for ${profile}.`, { profile });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw agentError('VALIDATION_FAILED', `Endpoint for ${profile} must use http(s).`, { profile });
  }
  if (parsed.username || parsed.password) {
    throw agentError('VALIDATION_FAILED', `Endpoint for ${profile} must not contain credentials.`, { profile });
  }
  if (endpoint === definition.endpoint) return endpoint;
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === 'localhost';
  if (!allowAnyHost && !loopback && !allowedHosts.has(parsed.host)) {
    throw agentError('PERMISSION_DENIED', `Endpoint for ${profile} is outside the configured network allowlist.`, {
      profile,
      host: parsed.host,
    });
  }
  return endpoint;
}

class AgentHistoryStore {
  constructor(options = {}) {
    this.filePath = options.historyPath || defaultHistoryPath();
    this.limit = Number.isInteger(options.historyLimit) && options.historyLimit > 0
      ? options.historyLimit
      : DEFAULT_HISTORY_LIMIT;
    this.fs = options.fs || fs;
  }

  _empty() {
    return { version: HISTORY_VERSION, entries: {} };
  }

  _read() {
    let parsed;
    try {
      parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return this._empty();
    }
    if (!isRecord(parsed) || parsed.version !== HISTORY_VERSION || !isRecord(parsed.entries)) {
      return this._empty();
    }
    const entries = {};
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (Array.isArray(value)) entries[key] = value.slice(-this.limit);
    }
    return { version: HISTORY_VERSION, entries };
  }

  _write(doc) {
    const content = JSON.stringify(doc, null, 2);
    atomicWrite(this.filePath, content);
  }

  get(profile, projectId) {
    const key = historyKey(profile, projectId);
    const doc = this._read();
    return redactValue(clone(Array.isArray(doc.entries[key]) ? doc.entries[key] : []));
  }

  append(profile, projectId, record, secrets = []) {
    const key = historyKey(profile, projectId);
    const doc = this._read();
    const safe = redactValue(record, { secrets });
    const rows = Array.isArray(doc.entries[key]) ? doc.entries[key] : [];
    rows.push(safe);
    doc.entries[key] = rows.slice(-this.limit);
    // A write also scrubs secret-shaped values that may have been present in an
    // older file before the current request supplied the real key.
    const sanitizedDoc = redactValue(doc, { secrets });
    this._write(sanitizedDoc);
  }

  clear(profile, projectId) {
    const key = historyKey(profile, projectId);
    const doc = this._read();
    delete doc.entries[key];
    this._write(doc);
  }
}

class AgentStream {
  constructor(owner, profile, request) {
    this.owner = owner;
    this.profile = profile;
    this.id = crypto.randomUUID();
    this.controller = new AbortController();
    this.reader = null;
    this.cancelRequested = false;
    this.state = 'starting';
    this.tokens = 0;
    this.output = '';
    this.usage = undefined;
    this.secret = null;
    this.redactions = { path: 0, secret: 0 };
    this.listeners = { token: new Set(), done: new Set(), error: new Set() };
    this.settledValue = null;
    this.resolveSettled = null;
    this.settled = new Promise((resolve) => { this.resolveSettled = resolve; });
    this.request = this._normalizeRequest(request);
    queueMicrotask(() => { void this._run(); });
  }

  _normalizeRequest(request) {
    const context = isRecord(request.context)
      ? sanitizeForTransport(request.context, '', this.redactions)
      : {};
    const projectId = typeof request.projectId === 'string' && request.projectId.length > 0
      ? request.projectId
      : (typeof context.projectId === 'string' && context.projectId.length > 0 ? context.projectId : 'default');
    return {
      input: sanitizeOutboundText(request.input, [], this.redactions),
      model: request.model,
      reasoning: request.reasoning,
      context,
      projectId,
    };
  }


  onToken(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.token.add(listener);
    return () => this.listeners.token.delete(listener);
  }

  onDone(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.done.add(listener);
    return () => this.listeners.done.delete(listener);
  }

  onError(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.error.add(listener);
    return () => this.listeners.error.delete(listener);
  }

  cancel() {
    if (this.cancelRequested) return this.settled;
    this.cancelRequested = true;
    this.controller.abort();
    const reader = this.reader;
    if (reader && typeof reader.cancel === 'function') {
      Promise.resolve(reader.cancel()).catch(() => {});
    }
    return this.settled;
  }

  _emit(kind, value) {
    for (const listener of this.listeners[kind]) {
      try { listener(value); } catch { /* listener errors do not orphan a stream */ }
    }
  }

  _emitToken(token) {
    if (this.cancelRequested || this.state === 'error' || this.state === 'cancelled') return;
    if (typeof token !== 'string' || token.length === 0) return;
    const safeToken = sanitizeInboundText(token, this.secret ? [this.secret] : [], this.redactions);
    if (safeToken.length === 0) return;
    this.tokens += 1;
    this.output += safeToken;
    this._emit('token', safeToken);
  }


  _settle(value) {
    if (this.settledValue !== null) return;
    this.settledValue = value;
    this.resolveSettled(value);
  }

  _finishDone() {
    if (this.state === 'done' || this.state === 'error' || this.state === 'cancelled') return;
    this.state = 'done';
    let historyPersisted = true;
    try {
      this.owner.history.append(
        this.profile,
        this.request.projectId,
        {
          at: nowIso(),
          model: this.request.model,
          input: this.request.input,
          output: this.output,
          context: this.request.context,
        },
        this.secret ? [this.secret] : [],
      );
    } catch {
      historyPersisted = false;
    }
    const payload = {
      state: 'done',
      id: this.id,
      profile: this.profile,
      model: this.request.model,
      tokens: this.tokens,
      usage: this.usage,
      historyPersisted,
      redactions: redactionReport(this.redactions),
    };
    this._emit('done', payload);
    this._settle({ state: 'done', ...payload });
  }

  _finishError(error) {
    if (this.state === 'done' || this.state === 'error' || this.state === 'cancelled') return;
    const typed = normalizeThrown(error, this.profile, this.secret ? [this.secret] : [], this.controller.signal);
    this.state = typed.code === 'CANCELLED' ? 'cancelled' : 'error';
    const report = redactionReport(this.redactions);
    if (isRecord(typed.details)) typed.details.redactions = report;
    else typed.details = { redactions: report };
    this._emit('error', typed);
    this._settle({ state: this.state, error: typed, redactions: report, historyPersisted: false });
  }

  async _run() {
    let response;
    try {
      if (this.cancelRequested) throw new Error('aborted');
      const profileConfig = this.owner.resolveProfileConfig(this.profile);
      this.request.model = this.request.model || profileConfig.model || PROFILE_DEFINITIONS[this.profile].defaultModel;
      this.secret = await this.owner.resolveSecret(this.profile, profileConfig);
      if (this.cancelRequested) throw new Error('aborted');
      const history = this.owner.history.get(this.profile, this.request.projectId);
      const body = buildRequestBody(
        this.profile,
        this.request.model,
        this.request.reasoning,
        this.request.input,
        this.request.context,
        history,
        this.secret ? [this.secret] : [],
        this.redactions,
      );

      const endpoint = this.owner.resolveEndpoint(
        this.profile,
        profileConfig.endpoint || PROFILE_DEFINITIONS[this.profile].endpoint,
      );
      const fetchFn = this.owner.fetch;
      if (typeof fetchFn !== 'function') {
        throw agentError('PROVIDER_ERROR', 'No injectable fetch implementation is available.', { profile: this.profile });
      }
      this.state = 'connecting';
      response = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json',
          ...authHeaders(this.profile, this.secret),
        },
        body: JSON.stringify(body),
        signal: this.controller.signal,
      });
      if (this.controller.signal.aborted) throw new Error('aborted');
      if (!response || response.ok === false) {
        let snippet = '';
        try { snippet = typeof response?.text === 'function' ? await response.text() : ''; } catch { /* no body */ }
        throw agentError(
          'PROVIDER_ERROR',
          `${PROFILE_DEFINITIONS[this.profile].label} request failed.`,
          { profile: this.profile, status: response?.status, snippet },
          this.secret ? [this.secret] : [],
        );
      }
      this.state = 'streaming';
      await consumeResponseBody(
        response,
        this.profile,
        this.controller.signal,
        (raw, eventName) => {
          const parsed = parseProviderEvent(this.profile, raw, eventName);
          if (!parsed) return parsed;
          if (parsed.usage) this.usage = parsed.usage;
          if (parsed.token) this._emitToken(parsed.token);
          return parsed;
        },
        (reader) => { this.reader = reader; },
      );
      if (this.controller.signal.aborted || this.cancelRequested) throw new Error('aborted');
      this._finishDone();
    } catch (error) {
      if (response?.body && (this.cancelRequested || this.controller.signal.aborted)) await cancelBody(response.body);
      this._finishError(error);
    } finally {
      this.owner.active.delete(this.id);
    }
  }
}

class AgentClients {
  constructor(options = {}) {
    this.fetch = options.fetch || options.transport?.fetch || globalThis.fetch;
    this.vault = options.vault || defaultVault;
    this.getSecret = options.getSecret || (async (keyRef) => {
      if (!this.vault || typeof this.vault.getSecret !== 'function') return null;
      return this.vault.getSecret(keyRef);
    });
    this.keyRefs = isRecord(options.keyRefs) ? { ...options.keyRefs } : {};
    this.profileConfigs = isRecord(options.profileConfigs)
      ? { ...options.profileConfigs }
      : isRecord(options.profiles) && !Array.isArray(options.profiles)
        ? { ...options.profiles }
        : {};
    this.history = options.historyStore || new AgentHistoryStore(options);
    this.active = new Map();
    this.allowedHosts = new Set(
      Array.isArray(options.allowedHosts)
        ? options.allowedHosts.filter((host) => typeof host === 'string' && host.length > 0)
        : [],
    );
    this.allowAnyHost = options.allowAnyHost === true;
  }

  listProfiles() {
    return AGENT_PROFILES.map((id) => {
      const definition = PROFILE_DEFINITIONS[id];
      const config = this.resolveProfileConfig(id);
      return {
        id,
        label: definition.label,
        provider: definition.provider,
        defaultModel: config.model || definition.defaultModel,
        requiresKey: true,
      };
    });
  }

  resolveProfileConfig(profile) {
    const definition = PROFILE_DEFINITIONS[profile];
    const configured = isRecord(this.profileConfigs[profile]) ? this.profileConfigs[profile] : {};
    return {
      ...configured,
      endpoint: configured.endpoint || definition.endpoint,
      model: configured.model || definition.defaultModel,
      keyRef: configured.keyRef ?? this.keyRefs[profile] ?? `${profile}-api-key`,
    };
  }
  resolveEndpoint(profile, endpoint) {
    return validateEndpoint(
      endpoint,
      profile,
      PROFILE_DEFINITIONS[profile],
      this.allowedHosts,
      this.allowAnyHost,
    );
  }

  async resolveSecret(profile, config) {
    const keyRef = config.keyRef;
    if (typeof keyRef !== 'string' || keyRef.length === 0) {
      throw agentError('PERMISSION_DENIED', `No credential reference configured for ${profile}.`, { profile });
    }
    let secret;
    try {
      secret = await this.getSecret(keyRef);
    } catch (error) {
      throw agentError('PERMISSION_DENIED', `Unable to resolve the ${profile} credential.`, { profile });
    }
    if (typeof secret !== 'string' || secret.length === 0) {
      throw agentError('PERMISSION_DENIED', `No credential available for ${profile}.`, { profile });
    }
    return secret;
  }

  /**
   * Start a streaming completion.
   *
   * §13.5: absolute filesystem paths in `input` and context strings are
   * replaced with `[REDACTED_PATH]` before the request is stored or sent so
   * the agent never receives arbitrary filesystem paths. After the vault
   * secret is resolved, exact secret values are substituted. Secret-shaped
   * key/token heuristics are not applied to outbound prompts or inbound
   * tokens. Path/secret counts appear on done, error, and status payloads as
   * `redactions`.
   */
  start(profile, request = {}) {
    if (!AGENT_PROFILES.includes(profile)) {
      throw agentError('VALIDATION_FAILED', `Unknown agent profile "${String(profile)}".`, { profile });
    }
    if (!isRecord(request) || typeof request.input !== 'string' || request.input.length === 0) {
      throw agentError('VALIDATION_FAILED', 'Agent start requires a non-empty input string.', { profile });
    }
    if (request.model !== undefined && (typeof request.model !== 'string' || request.model.length === 0)) {
      throw agentError('VALIDATION_FAILED', 'Agent model must be a non-empty string when supplied.', { profile });
    }
    const projectId = isRecord(request.context)
      && typeof request.context.projectId === 'string'
      && request.context.projectId.length > 0
      ? request.context.projectId
      : 'default';
    const stream = new AgentStream(this, profile, {
      input: request.input,
      model: request.model,
      reasoning: request.reasoning,
      context: isRecord(request.context) ? request.context : {},
      projectId,
    });
    this.active.set(stream.id, stream);
    return stream;
  }


  getHistory(profile, projectId = 'default') {
    if (!AGENT_PROFILES.includes(profile)) {
      throw agentError('VALIDATION_FAILED', `Unknown agent profile "${String(profile)}".`, { profile });
    }
    return this.history.get(profile, typeof projectId === 'string' && projectId.length > 0 ? projectId : 'default');
  }

  clearHistory(profile, projectId = 'default') {
    if (!AGENT_PROFILES.includes(profile)) {
      throw agentError('VALIDATION_FAILED', `Unknown agent profile "${String(profile)}".`, { profile });
    }
    return this.history.clear(profile, typeof projectId === 'string' && projectId.length > 0 ? projectId : 'default');
  }

  status() {
    return {
      active: [...this.active.values()].map((stream) => ({
        id: stream.id,
        profile: stream.profile,
        model: stream.request.model || null,
        state: stream.state,
        tokens: stream.tokens,
        redactions: redactionReport(stream.redactions),
      })),

      profiles: this.listProfiles(),
    };
  }

  getStatus() {
    return this.status();
  }
}

function createAgentClients(options) {
  return new AgentClients(options);
}

module.exports = {
  AGENT_PROFILES,
  PROFILE_DEFINITIONS,
  DEFAULT_HISTORY_LIMIT,
  HISTORY_FILENAME,
  AgentClientError,
  AgentHistoryStore,
  AgentClients,
  createAgentClients,
  redactString,
  redactValue,
  sanitizeForTransport,
  parseProviderEvent,
};
