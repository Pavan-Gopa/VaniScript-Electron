'use strict';

// Main-process cloud provider router (PRV-01).
//
// Responsibilities:
//   - Map a provider id to its HTTP adapter (table-driven catalog).
//   - Resolve the provider config + API key from settings/vault (never trust the
//     Renderer to supply a key).
//   - Perform the HTTP call and normalize the response into a provider-agnostic
//     result.
//   - Throw structured AppErrors (PERMISSION_DENIED / PROVIDER_ERROR / etc.) so
//     the IPC layer can return a typed envelope to the Renderer.
//
// This file is loaded by the Electron main process (CommonJS). It requires the
// plain-JavaScript shared contract runtimes (`*-runtime.js`: no TypeScript
// syntax, loaded via require(esm)) so it loads under the bundled Node runtime
// without a TypeScript loader — never the `.ts` façades, which are for typed
// Renderer/bundler consumption only.

const path = require('node:path');
const { createAppError, isAppError } = require('../../../shared/contracts/errors-runtime.js');
const { PROVIDER_INVOKE_COMMAND } = require('../../../shared/contracts/providers-runtime.js');
const { readSettings } = require('../storage/settingsStore.js');
const { getSecret } = require('../storage/vault.js');

// Provider catalog: id -> adapter. Kept self-contained so the main process does
// not depend on the renderer-side provider registry.
const PROVIDER_CATALOG = {
  gemini: {
    label: 'Google Gemini',
    requiresKey: true,
    defaultHost: 'https://generativelanguage.googleapis.com',
    auth: (key) => ({ 'x-goog-api-key': key }),
    buildUrl: (model, host) => `${host}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    buildBody: buildGeminiBody,
    normalize: normalizeGemini,
  },
  openai: {
    label: 'OpenAI',
    requiresKey: true,
    defaultHost: 'https://api.openai.com',
    auth: (key) => ({ Authorization: `Bearer ${key}` }),
    buildUrl: (model, host) => `${host}/v1/chat/completions`,
    buildBody: buildOpenAIBody,
    normalize: normalizeOpenAI,
  },
  anthropic: {
    label: 'Anthropic Claude',
    requiresKey: true,
    defaultHost: 'https://api.anthropic.com',
    auth: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    buildUrl: (model, host) => `${host}/v1/messages`,
    buildBody: buildAnthropicBody,
    normalize: normalizeAnthropic,
  },
  qwen: {
    label: 'Alibaba Qwen (DashScope)',
    requiresKey: true,
    defaultHost: 'https://dashscope.aliyuncs.com',
    auth: (key) => ({ Authorization: `Bearer ${key}` }),
    buildUrl: (model, host) => `${host}/compatible-mode/v1/chat/completions`,
    buildBody: buildOpenAIBody,
    normalize: normalizeOpenAI,
  },
  openrouter: {
    label: 'OpenRouter',
    requiresKey: true,
    defaultHost: 'https://openrouter.ai/api/v1',
    auth: (key) => ({
      Authorization: `Bearer ${key}`,
      'HTTP-Referer': 'https://vaniscript.local',
      'X-Title': 'VaniScript',
    }),
    buildUrl: (model, host) => `${host}/chat/completions`,
    buildBody: buildOpenAIBody,
    normalize: normalizeOpenAI,
  },
  custom: {
    label: 'OpenAI-compatible (custom)',
    requiresKey: true,
    // `custom` is an OpenAI-compatible endpoint. Its host is operator-controlled
    // via settings.customBaseUrl (resolved in resolveBaseUrl), so it is NOT in
    // SELF_HOSTABLE — the Renderer may never redirect it via request.baseUrl.
    defaultHost: 'https://api.openai.com',
    auth: (key) => ({ Authorization: `Bearer ${key}` }),
    buildUrl: (model, host) => `${host}/v1/chat/completions`,
    buildBody: buildOpenAIBody,
    normalize: normalizeOpenAI,
  },
  ollama: {
    label: 'Ollama (local)',
    requiresKey: false,
    defaultHost: 'http://localhost:11434',
    // Self-hostable: baseUrl override is honored (see resolveBaseUrl).
    allowBaseUrlOverride: true,
    auth: () => ({}),
    buildUrl: (model, host) => `${host}/api/chat`,
    buildBody: buildOllamaBody,
    normalize: normalizeOllama,
  },
};

const SELF_HOSTABLE = new Set(
  Object.keys(PROVIDER_CATALOG).filter((id) => PROVIDER_CATALOG[id].allowBaseUrlOverride)
);

function toMessages(request) {
  let messages = Array.isArray(request.messages) && request.messages.length > 0
    ? request.messages
    : null;
  if (!messages) {
    const prompt = typeof request.prompt === 'string' ? request.prompt : '';
    if (!prompt) return null;
    messages = [{ role: 'user', content: prompt }];
  }
  const system =
    request.params && typeof request.params.system === 'string' ? request.params.system : null;
  if (system) {
    messages = [{ role: 'system', content: system }, ...messages];
  }
  return messages;
}

function buildOpenAIBody(request, model) {
  const messages = toMessages(request);
  const body = {
    model,
    messages,
    stream: false,
    ...(request.params || {}),
  };
  // Keep server-controlled fields authoritative over caller params.
  body.model = model;
  body.messages = messages;
  if (body.stream === undefined) body.stream = false;
  return body;
}

function buildOllamaBody(request, model) {
  const messages = toMessages(request);
  const body = {
    model,
    messages,
    stream: false,
    ...(request.params || {}),
  };
  body.model = model;
  body.messages = messages;
  if (body.stream === undefined) body.stream = false;
  return body;
}

function buildAnthropicBody(request, model) {
  const raw = toMessages(request);
  let system = null;
  const messages = [];
  for (const m of raw) {
    if (m.role === 'system') {
      system = m.content;
      continue;
    }
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  const maxTokens =
    request.params && Number.isInteger(request.params.max_tokens)
      ? request.params.max_tokens
      : 2048;
  const body = { model, messages, max_tokens: maxTokens, stream: false };
  if (system) body.system = system;
  return body;
}

function buildGeminiBody(request, model) {
  const raw = toMessages(request);
  let systemInstruction = null;
  const contents = [];
  for (const m of raw) {
    if (m.role === 'system') {
      systemInstruction = { parts: [{ text: m.content }] };
      continue;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    contents.push({ role, parts: [{ text: m.content }] });
  }
  const body = { contents };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  const gen = {};
  const params = request.params || {};
  for (const k of ['temperature', 'maxOutputTokens', 'topP', 'topK']) {
    if (params[k] !== undefined) gen[k] = params[k];
  }
  if (Object.keys(gen).length) body.generationConfig = gen;
  return body;
}

function normalizeOpenAI(json) {
  const usage = json && json.usage
    ? {
        promptTokens: num(json.usage.prompt_tokens),
        completionTokens: num(json.usage.completion_tokens),
        totalTokens: num(json.usage.total_tokens),
      }
    : undefined;
  return { data: json, usage };
}

function normalizeAnthropic(json) {
  const usage = json && json.usage
    ? {
        promptTokens: num(json.usage.input_tokens),
        completionTokens: num(json.usage.output_tokens),
        totalTokens:
          num(json.usage.input_tokens) + num(json.usage.output_tokens),
      }
    : undefined;
  return { data: json, usage };
}

function normalizeGemini(json) {
  const um = json && json.usageMetadata;
  const usage = um
    ? {
        promptTokens: num(um.promptTokenCount),
        completionTokens: num(um.candidatesTokenCount),
        totalTokens: num(um.totalTokenCount),
      }
    : undefined;
  return { data: json, usage };
}

function normalizeOllama(json) {
  const usage = json
    ? {
        promptTokens: num(json.prompt_eval_count),
        completionTokens: num(json.eval_count),
        totalTokens: num(json.prompt_eval_count) + num(json.eval_count),
      }
    : undefined;
  return { data: json, usage };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function resolveModel(request, providerConfig, purpose) {
  if (typeof request.modelId === 'string' && request.modelId.length > 0) {
    return request.modelId;
  }
  if (purpose === 'transcription' && providerConfig.transcriptionModel) {
    return providerConfig.transcriptionModel;
  }
  if (purpose === 'translation' && providerConfig.translationModel) {
    return providerConfig.translationModel;
  }
  return providerConfig.model || null;
}

// Validate a base URL: it must be http(s) and must not carry embedded
// credentials (username/password), which would leak a secret via the host.
function validateHost(url, id) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw createAppError('VALIDATION_FAILED', `Invalid baseUrl for provider "${id}"`, {
      providerId: id,
      baseUrl: url,
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createAppError('VALIDATION_FAILED', `baseUrl must use http(s) for provider "${id}"`, {
      providerId: id,
      baseUrl: url,
    });
  }
  if (parsed.username || parsed.password) {
    throw createAppError('VALIDATION_FAILED', `baseUrl must not contain credentials for provider "${id}"`, {
      providerId: id,
    });
  }
  return `${parsed.origin}`;
}

// Resolve the effective host for a provider invocation.
//
// - `custom` (OpenAI-compatible) honors `customBaseUrl` from settings only; the
//   Renderer may never redirect it via request.baseUrl (it is not SELF_HOSTABLE),
//   so the operator — not untrusted UI — controls where the key is sent.
// - Self-hostable providers (e.g. ollama) honor a caller-supplied baseUrl after
//   validation.
// - All other cloud providers ignore any override and use their pinned host.
function resolveBaseUrl(request, providerConfig, catalogEntry) {
  if (
    providerConfig.id === 'custom' &&
    typeof providerConfig.customBaseUrl === 'string' &&
    providerConfig.customBaseUrl.length > 0
  ) {
    return validateHost(providerConfig.customBaseUrl, providerConfig.id);
  }
  const override = typeof request.baseUrl === 'string' ? request.baseUrl : null;
  if (!override) return catalogEntry.defaultHost;
  if (!SELF_HOSTABLE.has(providerConfig.id)) return catalogEntry.defaultHost;
  return validateHost(override, providerConfig.id);
}

function truncate(s, n = 240) {
  if (typeof s !== 'string') return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

// Replace every literal occurrence of `secret` with '***'. No-op when either
// argument is not a usable string (e.g. a null key, or non-string text), so it
// is always safe to call defensively.
function redactSecret(text, secret) {
  if (typeof text !== 'string' || !secret || typeof secret !== 'string') return text;
  return text.split(secret).join('***');
}

// Redact `secret` from every string leaf of an arbitrary JSON-serializable
// `value`, returning a NEW value so callers retain their originals. Used to
// scrub error `details` before they cross the IPC boundary.
function redactInDetails(value, secret) {
  if (!secret || typeof secret !== 'string') return value;
  if (typeof value === 'string') return redactSecret(value, secret);
  if (Array.isArray(value)) return value.map((v) => redactInDetails(v, secret));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = redactInDetails(value[key], secret);
    return out;
  }
  return value;
}

// Build a structured AppError after aggressively redacting `secret` from the
// message AND every string leaf of `details`. This guarantees a secret echoed
// back by a cloud provider (e.g. inside an HTTP error body) can never reach the
// Renderer inside a ResultEnvelope.
function providerError(code, message, details, secret) {
  const safeMessage = redactSecret(message, secret);
  const safeDetails = redactInDetails(details, secret);
  return createAppError(code, safeMessage, safeDetails);
}


/**
 * Resolve a provider route without performing I/O.
 *
 * @returns {{ providerId: string, model: string, url: string, headers: object, body: object, apiKey: string|null }}
 */
async function resolveRouteInternal(request, deps = {}) {
  const readSettings = deps.readSettings || readSettingsImpl;
  const getSecret = deps.getSecret || getSecretImpl;

  validateRequestShape(request);
  const catalogEntry = PROVIDER_CATALOG[request.providerId];
  if (!catalogEntry) {
    throw createAppError('PROVIDER_ERROR', `Unknown or unsupported provider "${request.providerId}"`, {
      providerId: request.providerId,
    });
  }

  const settings = readSettings();
  const providerConfig = settings && settings.api && settings.api.providers
    ? settings.api.providers[request.providerId]
    : undefined;
  if (!providerConfig) {
    throw createAppError('PROVIDER_ERROR', `Provider "${request.providerId}" is not configured`, {
      providerId: request.providerId,
    });
  }
  if (providerConfig.enabled === false) {
    throw createAppError('CAPABILITY_UNAVAILABLE', `Provider "${request.providerId}" is disabled`, {
      providerId: request.providerId,
    });
  }

  const purpose = request.purpose || 'text';
  const model = resolveModel(request, providerConfig, purpose);
  if (!model) {
    throw createAppError(
      'PROVIDER_ERROR',
      `No model resolved for provider "${request.providerId}" (purpose "${purpose}")`,
      { providerId: request.providerId, purpose }
    );
  }

  let apiKey = null;
  if (catalogEntry.requiresKey) {
    const keyRef = providerConfig.keyRef;
    if (keyRef) apiKey = getSecret(keyRef);
    if (!apiKey) {
      throw createAppError('PERMISSION_DENIED', `No API key available for provider "${request.providerId}"`, {
        providerId: request.providerId,
      });
    }
  }

  const host = resolveBaseUrl(request, providerConfig, catalogEntry);
  const url = catalogEntry.buildUrl(model, host);
  const headers = {
    'content-type': 'application/json',
    ...catalogEntry.auth(apiKey || ''),
  };
  const body = catalogEntry.buildBody(request, model);

  return {
    providerId: request.providerId,
    model,
    url,
    headers,
    body,
    apiKey,
  };
}

/**
 * Resolve a provider route without performing I/O. Exposed for tests and for
 * callers that want to inspect the destination before invoking. The API key is
 * intentionally omitted from this public projection (it is only needed inside
 * invokeProvider, which uses resolveRouteInternal).
 *
 * @returns {{ providerId: string, model: string, url: string, headers: object, body: object }}
 */
async function resolveRoute(request, deps = {}) {
  const { apiKey, ...route } = await resolveRouteInternal(request, deps);
  return route;
}

function validateRequestShape(request) {
  if (!request || typeof request !== 'object') {
    throw createAppError('VALIDATION_FAILED', 'provider:invoke requires a request object');
  }
  if (typeof request.providerId !== 'string' || request.providerId.length === 0) {
    throw createAppError('VALIDATION_FAILED', 'provider:invoke requires a non-empty "providerId"');
  }
  const hasMessages = Array.isArray(request.messages) && request.messages.length > 0;
  const hasPrompt = typeof request.prompt === 'string' && request.prompt.length > 0;
  if (!hasMessages && !hasPrompt) {
    throw createAppError('VALIDATION_FAILED', 'provider:invoke requires "prompt" (string) or "messages" (array)');
  }
}

/**
 * Perform a cloud provider invocation on behalf of the Renderer.
 *
 * Main injects the API key from the vault; the returned result contains only the
 * provider payload (no secrets). Throws an AppError on any failure.
 *
 * @param {import('../../../shared/contracts/providers.ts').ProviderInvokeRequest} request
 * @param {{ readSettings?: Function, getSecret?: Function, fetch?: Function }} [deps] test seams
 */
async function invokeProvider(request, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const { apiKey, ...route } = await resolveRouteInternal(request, deps);
  const catalogEntry = PROVIDER_CATALOG[request.providerId];

  let response;
  try {
    if (typeof fetchFn !== 'function') {
      throw providerError(
        'PROVIDER_ERROR',
        'No fetch implementation available in main process',
        undefined,
        apiKey
      );
    }
    response = await fetchFn(route.url, {
      method: 'POST',
      headers: route.headers,
      body: JSON.stringify(route.body),
    });
  } catch (netErr) {
    throw providerError(
      'PROVIDER_ERROR',
      `Network error contacting ${catalogEntry.label}`,
      {
        providerId: request.providerId,
        model: route.model,
        cause: String(netErr && netErr.message ? netErr.message : netErr),
      },
      apiKey
    );
  }

  if (!response.ok) {
    const text = await safeText(response);
    // Aggressively redact the secret key: a provider may echo the key back
    // inside its error body (the snippet), so scrub it before it can reach the
    // Renderer in a ResultEnvelope.
    throw providerError(
      'PROVIDER_ERROR',
      `${catalogEntry.label} responded with ${response.status}`,
      {
        providerId: request.providerId,
        model: route.model,
        status: response.status,
        snippet: truncate(text),
      },
      apiKey
    );
  }

  let json;
  try {
    json = await response.json();
  } catch (parseErr) {
    throw providerError(
      'PROVIDER_ERROR',
      `${catalogEntry.label} returned an unparseable response`,
      {
        providerId: request.providerId,
        model: route.model,
        cause: String(parseErr && parseErr.message ? parseErr.message : parseErr),
      },
      apiKey
    );
  }

  const normalized = catalogEntry.normalize(json);
  return {
    providerId: request.providerId,
    model: route.model,
    purpose: request.purpose || 'text',
    data: normalized.data,
    usage: normalized.usage,
  };
}

// Real implementations, swappable via deps in tests.
function readSettingsImpl() {
  // settingsStore.readSettings returns a wrapper { settings, source, ... };
  // the router only needs the raw settings document (which carries `.api`).
  const loaded = readSettings();
  return loaded && loaded.settings ? loaded.settings : loaded;
}
function getSecretImpl(keyRef) {
  return getSecret(keyRef);
}

module.exports = {
  PROVIDER_CATALOG,
  PROVIDER_INVOKE_COMMAND,
  invokeProvider,
  resolveRoute,
  resolveRouteInternal,
  redactSecret,
  isAppError,
};
