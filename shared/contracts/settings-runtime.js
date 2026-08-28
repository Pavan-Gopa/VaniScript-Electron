/**
 * Runtime implementation of the application settings contract (settings.ts
 * façade): canonical defaults plus normalization and versioned migration used
 * by the Main-process settings disk store
 * (`electron/main/storage/settingsStore.js`).
 *
 * Plain JavaScript with no TypeScript syntax so the Electron main process can
 * load it directly under the bundled Node runtime without any TypeScript
 * loader. This directory's package.json declares `"type": "module"`, so `.js`
 * here is an ES module; Node >= 20.19 loads it synchronously through
 * `require()` via built-in require(esm).
 *
 * Secrets are intentionally absent: provider credentials are stored only as
 * opaque `keyRef` references (resolved by the credential vault, SET-02). The
 * settings store never persists plaintext keys.
 *
 * This module is pure (no Electron / Node built-in side effects).
 */

/** Current persisted settings schema version. Bump when the shape changes. */
export const SETTINGS_SCHEMA_VERSION = 2;

/** Version of the bounded Main-owned usage ledger stored in api.lastUsage. */
export const USAGE_SCHEMA_VERSION = 1;

export const USAGE_PURPOSES = Object.freeze([
  'text',
  'chat',
  'translation',
  'transcription',
  'vision',
  'review',
  'polish',
  'shorts',
]);

/** Provider pricing copied from the existing Settings UI (USD / 1M tokens). */
export const USAGE_PRICING = Object.freeze({
  'gemini-cloud': Object.freeze({
    inputPerMillion: 0.3,
    outputPerMillion: 2.5,
    models: Object.freeze(['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro']),
  }),
  'gpt-cloud': Object.freeze({
    inputPerMillion: 2.5,
    outputPerMillion: 10,
    models: Object.freeze(['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-5']),
  }),
});

const DEFAULT_SETTINGS = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  agents: {
    localMcpEnabled: false,
    mcpPort: null,
    accessTokenRef: null,
    preferredAgent: 'codex',
    embeddedChatEnabled: false,
    permissions: {
      read: true,
      mutate: false,
      processing: true,
      file: false,
      network: false,
      destructive: false,
    },
  },
  api: {
    providers: {},
    favoriteModels: [],
    lastUsage: createDefaultUsageLedger(),
  },
  appearance: {
    theme: 'system',
    fontFamily: 'system-ui',
    baseFontSize: 14,
    scale: 1,
    annotationMode: 'standard',
    density: 'comfortable',
    editorFonts: {
      source: 'system-ui',
      translation: 'system-ui',
      monospace: 'monospace',
    },
    reduceMotion: false,
    highContrast: false,
  },
  chunking: {
    media: {
      targetDurationMinutes: 10,
      sliceMode: 'silence',
      silenceThreshold: 0.03,
      minSilenceDuration: 0.5,
      smartSemantic: true,
    },
    document: {
      targetTokens: 1000,
      strategy: 'semantic',
      overlap: 100,
    },
  },
  glossary: {
    languageScoped: true,
    protectedTermsPolicy: 'replace',
  },
  models: {
    localAsrRoot: null,
    localTranslationRoot: null,
    autoScan: true,
  },
  prompts: {
    builtInVersion: 1,
    userCopyEnabled: true,
  },
  transcription: {
    defaultSourceLanguage: 'auto',
    defaultTranscriptionProvider: '',
    defaultTranslationProvider: '',
    defaultTargetLanguage: 'en',
    languageAutoDetect: true,
    documentApprovalMode: 'manual',
  },
  updates: {
    autoCheck: true,
    channel: 'stable',
  },
};

/** Return a fresh, deep-cloned copy of the canonical defaults. */
export function createDefaultSettings() {
  return structuredClone(DEFAULT_SETTINGS);
}

// --- Decoder helpers -------------------------------------------------------

function asObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? v
    : null;
}

function str(v, d) {
  return typeof v === 'string' ? v : d;
}

function bool(v, d) {
  return typeof v === 'boolean' ? v : d;
}

function num(v, d, min, max) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return d;
  if (min !== undefined && v < min) return min;
  if (max !== undefined && v > max) return max;
  return v;
}

function oneOf(v, allowed, d) {
  return allowed.includes(v) ? v : d;
}

function strArray(v, d) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : d;
}

function strOrNull(v) {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const MAX_USAGE_PROVIDERS = 128;
const MAX_USAGE_MODELS = 64;
const MAX_USAGE_PURPOSES = 16;
const MAX_USAGE_DAYS = 366;
const MAX_USAGE_OPERATION_HASHES = 1024;
const MAX_USAGE_ID_LENGTH = 96;
const MAX_USAGE_NUMBER = 1_000_000_000_000;
const SAFE_USAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u;

function safeUsageId(value, fallback = 'unknown') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().slice(0, MAX_USAGE_ID_LENGTH);
  if (!trimmed || !SAFE_USAGE_ID.test(trimmed)) return fallback;
  if (/^(?:sk-|pk-|bearer|eyJ|AIza|ghp_|xox[baprs]-)/i.test(trimmed)) return fallback;
  return trimmed;
}

function usageNumber(value, fallback = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_USAGE_NUMBER, Math.max(0, value));
}

function emptyUsageCounter() {
  return {
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    audioMinutes: 0,
    estimatedCost: 0,
  };
}

function emptyProviderUsage() {
  return {
    ...emptyUsageCounter(),
    lastUsed: null,
    lastInputTokens: 0,
    lastOutputTokens: 0,
    models: {},
    purposes: {},
  };
}

function normalizeUsageCounter(input) {
  const value = asObject(input) ?? {};
  return {
    requests: usageNumber(value.requests),
    errors: usageNumber(value.errors),
    inputTokens: usageNumber(value.inputTokens),
    outputTokens: usageNumber(value.outputTokens),
    audioMinutes: usageNumber(value.audioMinutes),
    estimatedCost: usageNumber(value.estimatedCost),
  };
}

function normalizeUsageMap(input, limit, valueFactory = normalizeUsageCounter) {
  const source = asObject(input) ?? {};
  const out = {};
  for (const [rawId, rawValue] of Object.entries(source).slice(0, limit)) {
    const id = safeUsageId(rawId);
    if (id === 'unknown' && rawId !== 'unknown') continue;
    out[id] = valueFactory(rawValue);
  }
  return out;
}

function normalizeProviderUsage(input) {
  const value = asObject(input) ?? {};
  const out = {
    ...emptyProviderUsage(),
    ...normalizeUsageCounter(value),
    lastUsed: typeof value.lastUsed === 'string' && value.lastUsed.length > 0 ? value.lastUsed : null,
    lastInputTokens: usageNumber(value.lastInputTokens),
    lastOutputTokens: usageNumber(value.lastOutputTokens),
    models: normalizeUsageMap(value.models, MAX_USAGE_MODELS),
    purposes: normalizeUsageMap(value.purposes, MAX_USAGE_PURPOSES),
  };
  return out;
}

function normalizeDailyUsage(input) {
  const source = asObject(input) ?? {};
  const out = {};
  for (const [date, value] of Object.entries(source).slice(-MAX_USAGE_DAYS)) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) continue;
    const row = asObject(value) ?? {};
    out[date] = {
      ...emptyUsageCounter(),
      ...normalizeUsageCounter(row),
      providers: normalizeUsageMap(row.providers, MAX_USAGE_PROVIDERS, normalizeProviderUsage),
    };
  }
  return out;
}

/** Return a fresh empty Main-owned usage ledger. */
export function createDefaultUsageLedger() {
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    inputTokens: 0,
    outputTokens: 0,
    audioMinutes: 0,
    requests: 0,
    errors: 0,
    estimatedCost: 0,
    lastProvider: null,
    lastModel: null,
    lastPurpose: null,
    lastUsed: null,
    lastInputTokens: 0,
    lastOutputTokens: 0,
    providers: {},
    daily: {},
    recentOperationHashes: [],
  };
}

/** Normalize an unknown usage document into the bounded ledger shape. */
export function normalizeUsageLedger(input) {
  const raw = asObject(input) ?? {};
  const ledger = createDefaultUsageLedger();
  ledger.inputTokens = usageNumber(raw.inputTokens);
  ledger.outputTokens = usageNumber(raw.outputTokens);
  ledger.audioMinutes = usageNumber(raw.audioMinutes);
  ledger.requests = usageNumber(raw.requests ?? raw.sessions);
  ledger.errors = usageNumber(raw.errors);
  ledger.estimatedCost = usageNumber(raw.estimatedCost);
  ledger.lastProvider = raw.lastProvider == null ? null : safeUsageId(raw.lastProvider, null);
  ledger.lastModel = raw.lastModel == null ? null : safeUsageId(raw.lastModel, null);
  ledger.lastPurpose = USAGE_PURPOSES.includes(raw.lastPurpose) ? raw.lastPurpose : null;
  ledger.lastUsed = typeof raw.lastUsed === 'string' && raw.lastUsed.length > 0 ? raw.lastUsed : null;
  ledger.lastInputTokens = usageNumber(raw.lastInputTokens);
  ledger.lastOutputTokens = usageNumber(raw.lastOutputTokens);
  ledger.providers = normalizeUsageMap(raw.providers, MAX_USAGE_PROVIDERS, normalizeProviderUsage);
  ledger.daily = normalizeDailyUsage(raw.daily);
  ledger.recentOperationHashes = Array.isArray(raw.recentOperationHashes)
    ? raw.recentOperationHashes
      .filter((value) => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value))
      .slice(-MAX_USAGE_OPERATION_HASHES)
    : [];
  return ledger;
}

function usageModelHasPricing(_providerId, modelId, pricing) {
  if (!pricing) return false;
  if (!modelId) return true;
  if (!Array.isArray(pricing.models)) return false;
  return pricing.models.includes(modelId);
}

function usageCost(providerId, modelId, inputTokens, outputTokens) {
  const pricing = USAGE_PRICING[providerId];
  if (!usageModelHasPricing(providerId, modelId, pricing)) return 0;
  return ((inputTokens * pricing.inputPerMillion) + (outputTokens * pricing.outputPerMillion)) / 1_000_000;
}

function operationHash(operationId) {
  // Keep this module dependency-free and deterministic. The digest is not a
  // security boundary; it only prevents duplicate completion notifications.
  let hash = 2166136261;
  for (const char of String(operationId)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const first = (hash >>> 0).toString(16).padStart(8, '0');
  return `${first}${first}${first}${first}${first}${first}${first}${first}`.slice(0, 64);
}

/** Record one terminal logical operation without mutating the input ledger. */
export function recordUsage(ledgerInput, input, now = new Date()) {
  const ledger = normalizeUsageLedger(ledgerInput);
  const request = asObject(input) ?? {};
  const operationId = typeof request.operationId === 'string' ? request.operationId : '';
  const opHash = operationHash(operationId || `${request.providerId}:${request.purpose}:${now.toISOString()}`);
  if (ledger.recentOperationHashes.includes(opHash)) return ledger;
  ledger.recentOperationHashes.push(opHash);
  if (ledger.recentOperationHashes.length > MAX_USAGE_OPERATION_HASHES) {
    ledger.recentOperationHashes.splice(0, ledger.recentOperationHashes.length - MAX_USAGE_OPERATION_HASHES);
  }

  const providerId = safeUsageId(request.providerId);
  const modelId = request.modelId == null ? null : safeUsageId(request.modelId, null);
  const purpose = USAGE_PURPOSES.includes(request.purpose) ? request.purpose : 'text';
  const outcome = request.outcome === 'success' ? 'success' : 'error';
  const inputTokens = outcome === 'success' ? usageNumber(request.inputTokens) : 0;
  const outputTokens = outcome === 'success' ? usageNumber(request.outputTokens) : 0;
  const audioMinutes = outcome === 'success' ? usageNumber(request.audioMinutes) : 0;
  const estimatedCost = outcome === 'success' ? usageCost(providerId, modelId, inputTokens, outputTokens) : 0;
  const timestamp = now instanceof Date && Number.isFinite(now.getTime()) ? now.toISOString() : new Date().toISOString();
  const day = timestamp.slice(0, 10);

  const provider = ledger.providers[providerId] ?? emptyProviderUsage();
  const model = provider.models[modelId || 'unknown'] ?? emptyUsageCounter();
  const purposeCounter = provider.purposes[purpose] ?? emptyUsageCounter();
  const daily = ledger.daily[day] ?? { ...emptyUsageCounter(), providers: {} };
  const dailyProvider = daily.providers[providerId] ?? emptyProviderUsage();
  const dailyModel = dailyProvider.models[modelId || 'unknown'] ?? emptyUsageCounter();
  const dailyPurpose = dailyProvider.purposes[purpose] ?? emptyUsageCounter();

  const apply = (counter) => {
    if (outcome === 'success') counter.requests += 1;
    else counter.errors += 1;
    counter.inputTokens += inputTokens;
    counter.outputTokens += outputTokens;
    counter.audioMinutes += audioMinutes;
    counter.estimatedCost += estimatedCost;
  };
  apply(ledger);
  apply(provider);
  apply(model);
  apply(purposeCounter);
  apply(daily);
  apply(dailyProvider);
  apply(dailyModel);
  apply(dailyPurpose);

  if (outcome === 'success') {
    provider.lastUsed = timestamp;
    provider.lastInputTokens = inputTokens;
    provider.lastOutputTokens = outputTokens;
    ledger.lastProvider = providerId;
    ledger.lastModel = modelId;
    ledger.lastPurpose = purpose;
    ledger.lastUsed = timestamp;
    ledger.lastInputTokens = inputTokens;
    ledger.lastOutputTokens = outputTokens;
    dailyProvider.lastUsed = timestamp;
    dailyProvider.lastInputTokens = inputTokens;
    dailyProvider.lastOutputTokens = outputTokens;
  }
  provider.models[modelId || 'unknown'] = model;
  provider.purposes[purpose] = purposeCounter;
  dailyProvider.models[modelId || 'unknown'] = dailyModel;
  dailyProvider.purposes[purpose] = dailyPurpose;
  daily.providers[providerId] = dailyProvider;
  ledger.providers[providerId] = provider;
  ledger.daily[day] = daily;
  const days = Object.keys(ledger.daily).sort();
  if (days.length > MAX_USAGE_DAYS) {
    for (const stale of days.slice(0, days.length - MAX_USAGE_DAYS)) delete ledger.daily[stale];
  }
  return ledger;
}

function inDateRange(date, range) {
  if (!range || typeof range !== 'object') return true;
  if (typeof range.from === 'string' && date < range.from.slice(0, 10)) return false;
  if (typeof range.to === 'string' && date > range.to.slice(0, 10)) return false;
  return true;
}

function mergeUsageProjection(target, source) {
  for (const key of ['requests', 'errors', 'inputTokens', 'outputTokens', 'audioMinutes', 'estimatedCost']) {
    target[key] += usageNumber(source?.[key]);
  }
}

/** Build a text-free usage projection; operation hashes are never returned. */
export function projectUsage(ledgerInput, range) {
  const ledger = normalizeUsageLedger(ledgerInput);
  const hasRange = Boolean(range && (range.from || range.to));
  const out = {
    schemaVersion: USAGE_SCHEMA_VERSION,
    inputTokens: 0,
    outputTokens: 0,
    audioMinutes: 0,
    requests: 0,
    errors: 0,
    estimatedCost: 0,
    lastProvider: null,
    lastModel: null,
    lastPurpose: null,
    lastUsed: null,
    lastInputTokens: 0,
    lastOutputTokens: 0,
    providers: {},
    daily: {},
  };
  const rows = Object.entries(ledger.daily).filter(([date]) => !hasRange || inDateRange(date, range));
  const providerMerge = (providerId, source) => {
    const destination = out.providers[providerId] ?? emptyProviderUsage();
    mergeUsageProjection(destination, source);
    if (source?.lastUsed && (!destination.lastUsed || source.lastUsed > destination.lastUsed)) {
      destination.lastUsed = source.lastUsed;
      destination.lastInputTokens = source.lastInputTokens;
      destination.lastOutputTokens = source.lastOutputTokens;
    }
    for (const [modelId, model] of Object.entries(source?.models ?? {})) {
      const modelDestination = destination.models[modelId] ?? emptyUsageCounter();
      mergeUsageProjection(modelDestination, model);
      destination.models[modelId] = modelDestination;
    }
    for (const [purpose, purposeCounter] of Object.entries(source?.purposes ?? {})) {
      const purposeDestination = destination.purposes[purpose] ?? emptyUsageCounter();
      mergeUsageProjection(purposeDestination, purposeCounter);
      destination.purposes[purpose] = purposeDestination;
    }
    out.providers[providerId] = destination;
  };
  if (!hasRange) {
    mergeUsageProjection(out, ledger);
    out.lastProvider = ledger.lastProvider;
    out.lastModel = ledger.lastModel;
    out.lastPurpose = ledger.lastPurpose;
    out.lastUsed = ledger.lastUsed;
    out.lastInputTokens = ledger.lastInputTokens;
    out.lastOutputTokens = ledger.lastOutputTokens;
    for (const [providerId, provider] of Object.entries(ledger.providers)) {
      providerMerge(providerId, provider);
    }
    for (const [date, row] of rows) out.daily[date] = structuredClone(row);
  } else {
    for (const [date, row] of rows) {
      out.daily[date] = structuredClone(row);
      mergeUsageProjection(out, row);
      for (const [providerId, provider] of Object.entries(row.providers ?? {})) {
        providerMerge(providerId, provider);
      }
    }
  }
  return out;
}

/** Convert a legacy vs_usage_v1 provider map into the new ledger. */
export function migrateLegacyUsage(input) {
  const raw = asObject(input) ?? {};
  const ledger = createDefaultUsageLedger();
  if (Object.keys(raw).some((key) => ['sessions', 'requests', 'inputTokens', 'outputTokens', 'audioMinutes'].includes(key))) {
    const provider = emptyProviderUsage();
    provider.requests = usageNumber(raw.requests ?? raw.sessions);
    provider.errors = usageNumber(raw.errors);
    provider.inputTokens = usageNumber(raw.inputTokens);
    provider.outputTokens = usageNumber(raw.outputTokens);
    provider.audioMinutes = usageNumber(raw.audioMinutes);
    provider.estimatedCost = usageNumber(raw.estimatedCost);
    provider.lastUsed = typeof raw.lastUsed === 'string' && raw.lastUsed ? raw.lastUsed : null;
    provider.lastInputTokens = usageNumber(raw.lastInputTokens);
    provider.lastOutputTokens = usageNumber(raw.lastOutputTokens);
    ledger.providers.legacy = provider;
    mergeUsageProjection(ledger, provider);
    ledger.lastProvider = 'legacy';
    ledger.lastUsed = provider.lastUsed;
    ledger.lastInputTokens = provider.lastInputTokens;
    ledger.lastOutputTokens = provider.lastOutputTokens;
    return normalizeUsageLedger(ledger);
  }
  for (const [rawProvider, rawValue] of Object.entries(raw).slice(0, MAX_USAGE_PROVIDERS)) {
    if (!asObject(rawValue)) continue;
    const providerId = safeUsageId(rawProvider);
    if (providerId === 'unknown' && rawProvider !== 'unknown') continue;
    const value = rawValue;
    const provider = emptyProviderUsage();
    provider.requests = usageNumber(value.requests ?? value.sessions);
    provider.errors = usageNumber(value.errors);
    provider.inputTokens = usageNumber(value.inputTokens);
    provider.outputTokens = usageNumber(value.outputTokens);
    provider.audioMinutes = usageNumber(value.audioMinutes);
    provider.estimatedCost = usageNumber(value.estimatedCost);
    provider.lastUsed = typeof value.lastUsed === 'string' && value.lastUsed ? value.lastUsed : null;
    provider.lastInputTokens = usageNumber(value.lastInputTokens);
    provider.lastOutputTokens = usageNumber(value.lastOutputTokens);
    ledger.providers[providerId] = provider;
    mergeUsageProjection(ledger, provider);
    if (provider.lastUsed && (!ledger.lastUsed || provider.lastUsed > ledger.lastUsed)) {
      ledger.lastUsed = provider.lastUsed;
      ledger.lastProvider = providerId;
      ledger.lastInputTokens = provider.lastInputTokens;
      ledger.lastOutputTokens = provider.lastOutputTokens;
    }
  }
  return normalizeUsageLedger(ledger);
}

function normalizeAgents(input) {
  const base = createDefaultSettings().agents;
  const a = asObject(input);
  if (!a) return base;
  const p = asObject(a.permissions) ?? {};
  return {
    localMcpEnabled: bool(a.localMcpEnabled, base.localMcpEnabled),
    mcpPort: numOrNull(a.mcpPort),
    accessTokenRef: strOrNull(a.accessTokenRef),
    preferredAgent: oneOf(a.preferredAgent, ['codex', 'grok', 'qwen'], base.preferredAgent),
    embeddedChatEnabled: bool(a.embeddedChatEnabled, base.embeddedChatEnabled),
    permissions: {
      read: bool(p.read, base.permissions.read),
      mutate: bool(p.mutate, base.permissions.mutate),
      processing: bool(p.processing, base.permissions.processing),
      file: bool(p.file, base.permissions.file),
      network: bool(p.network, base.permissions.network),
      destructive: bool(p.destructive, base.permissions.destructive),
    },
  };
}

function normalizeProvider(input, id) {
  const base = createDefaultSettings().api.providers;
  const existing = base[id];
  const p = asObject(input);
  if (!p) {
    return existing ?? {
      id,
      enabled: false,
      keyRef: null,
      model: null,
      transcriptionModel: null,
      translationModel: null,
      budget: { enabled: false, monthlyLimit: null },
    };
  }
  const b = asObject(p.budget) ?? {};
  return {
    id: str(p.id, id),
    enabled: bool(p.enabled, false),
    keyRef: strOrNull(p.keyRef),
    model: strOrNull(p.model),
    transcriptionModel: strOrNull(p.transcriptionModel),
    translationModel: strOrNull(p.translationModel),
    budget: {
      enabled: bool(b.enabled, false),
      monthlyLimit: numOrNull(b.monthlyLimit),
    },
  };
}

function normalizeApi(input) {
  const base = createDefaultSettings().api;
  const a = asObject(input);
  if (!a) return base;
  const rawProviders = asObject(a.providers) ?? {};
  const providers = {};
  for (const [id, value] of Object.entries(rawProviders).slice(0, MAX_USAGE_PROVIDERS)) {
    const normalizedId = safeUsageId(id);
    if (normalizedId === 'unknown' && id !== 'unknown') continue;
    providers[normalizedId] = normalizeProvider(value, normalizedId);
  }
  const rawUsage = asObject(a.lastUsage) ?? {};
  const looksLikeLedger = Object.prototype.hasOwnProperty.call(rawUsage, 'providers')
    || Object.prototype.hasOwnProperty.call(rawUsage, 'daily')
    || Object.prototype.hasOwnProperty.call(rawUsage, 'schemaVersion');
  return {
    providers,
    favoriteModels: strArray(a.favoriteModels, base.favoriteModels).slice(0, 256),
    lastUsage: looksLikeLedger ? normalizeUsageLedger(rawUsage) : migrateLegacyUsage(rawUsage),
  };
}

function normalizeAppearance(input) {
  const base = createDefaultSettings().appearance;
  const a = asObject(input);
  if (!a) return base;
  const e = asObject(a.editorFonts) ?? {};
  return {
    theme: oneOf(a.theme, ['light', 'dark', 'system'], base.theme),
    fontFamily: str(a.fontFamily, base.fontFamily),
    baseFontSize: num(a.baseFontSize, base.baseFontSize, 8, 72),
    scale: num(a.scale, base.scale, 0.5, 3),
    annotationMode: str(a.annotationMode, base.annotationMode),
    density: oneOf(a.density, ['comfortable', 'compact'], base.density),
    editorFonts: {
      source: str(e.source, base.editorFonts.source),
      translation: str(e.translation, base.editorFonts.translation),
      monospace: str(e.monospace, base.editorFonts.monospace),
    },
    reduceMotion: bool(a.reduceMotion, base.reduceMotion),
    highContrast: bool(a.highContrast, base.highContrast),
  };
}

function normalizeChunking(input) {
  const base = createDefaultSettings().chunking;
  const c = asObject(input);
  if (!c) return base;
  const m = asObject(c.media) ?? {};
  const d = asObject(c.document) ?? {};
  return {
    media: {
      targetDurationMinutes: num(m.targetDurationMinutes, base.media.targetDurationMinutes, 1, 60),
      sliceMode: str(m.sliceMode, base.media.sliceMode),
      silenceThreshold: num(m.silenceThreshold, base.media.silenceThreshold, 0, 1),
      minSilenceDuration: num(m.minSilenceDuration, base.media.minSilenceDuration, 0, 30),
      smartSemantic: bool(m.smartSemantic, base.media.smartSemantic),
    },
    document: {
      targetTokens: num(d.targetTokens, base.document.targetTokens, 1),
      strategy: str(d.strategy, base.document.strategy),
      overlap: num(d.overlap, base.document.overlap, 0),
    },
  };
}

function normalizeGlossary(input) {
  const base = createDefaultSettings().glossary;
  const g = asObject(input);
  if (!g) return base;
  return {
    languageScoped: bool(g.languageScoped, base.languageScoped),
    protectedTermsPolicy: oneOf(
      g.protectedTermsPolicy,
      ['replace', 'preserve'],
      base.protectedTermsPolicy,
    ),
  };
}

function normalizeModels(input) {
  const base = createDefaultSettings().models;
  const m = asObject(input);
  if (!m) return base;
  return {
    localAsrRoot: strOrNull(m.localAsrRoot),
    localTranslationRoot: strOrNull(m.localTranslationRoot),
    autoScan: bool(m.autoScan, base.autoScan),
  };
}

function normalizePrompts(input) {
  const base = createDefaultSettings().prompts;
  const p = asObject(input);
  if (!p) return base;
  return {
    builtInVersion: num(p.builtInVersion, base.builtInVersion, 1),
    userCopyEnabled: bool(p.userCopyEnabled, base.userCopyEnabled),
  };
}

function normalizeTranscription(input) {
  const base = createDefaultSettings().transcription;
  const t = asObject(input);
  if (!t) return base;
  return {
    defaultSourceLanguage: str(t.defaultSourceLanguage, base.defaultSourceLanguage),
    defaultTranscriptionProvider: str(t.defaultTranscriptionProvider, base.defaultTranscriptionProvider),
    defaultTranslationProvider: str(t.defaultTranslationProvider, base.defaultTranslationProvider),
    defaultTargetLanguage: str(t.defaultTargetLanguage, base.defaultTargetLanguage),
    languageAutoDetect: bool(t.languageAutoDetect, base.languageAutoDetect),
    documentApprovalMode: oneOf(t.documentApprovalMode, ['manual', 'auto'], base.documentApprovalMode),
  };
}

function normalizeUpdates(input) {
  const base = createDefaultSettings().updates;
  const u = asObject(input);
  if (!u) return base;
  return {
    autoCheck: bool(u.autoCheck, base.autoCheck),
    channel: oneOf(u.channel, ['stable', 'beta'], base.channel),
  };
}

/**
 * Decode an unknown value into a fully-formed settings object, filling any
 * missing or invalid field with its default. Never throws.
 */
export function normalizeSettings(input) {
  const raw = asObject(input);
  if (!raw) return createDefaultSettings();
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    agents: normalizeAgents(raw.agents),
    api: normalizeApi(raw.api),
    appearance: normalizeAppearance(raw.appearance),
    chunking: normalizeChunking(raw.chunking),
    glossary: normalizeGlossary(raw.glossary),
    models: normalizeModels(raw.models),
    prompts: normalizePrompts(raw.prompts),
    transcription: normalizeTranscription(raw.transcription),
    updates: normalizeUpdates(raw.updates),
  };
}

// --- Versioned migrations --------------------------------------------------

/**
 * Each entry upgrades a settings object FROM the keyed version TO the next.
 * v0 represents an unversioned/legacy file (no `schemaVersion`).
 */
const MIGRATIONS = {
  0: (data) => ({ ...data, schemaVersion: 1 }),
  1: (data) => {
    const api = asObject(data.api) ?? {};
    const rawUsage = asObject(api.lastUsage) ?? {};
    const looksLikeLedger = (
      Object.prototype.hasOwnProperty.call(rawUsage, 'providers')
      || Object.prototype.hasOwnProperty.call(rawUsage, 'daily')
      || Object.prototype.hasOwnProperty.call(rawUsage, 'schemaVersion')
    );
    return {
      ...data,
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      api: {
        ...api,
        lastUsage: looksLikeLedger ? normalizeUsageLedger(rawUsage) : migrateLegacyUsage(rawUsage),
      },
    };
  },
};

/**
 * Apply sequential migrations to an unknown payload, then normalize.
 *
 * @returns {{ settings: object, migrated: boolean, fromVersion: number }}
 */
export function migrateSettings(raw) {
  const obj = asObject(raw);
  const declared =
    obj && typeof obj.schemaVersion === 'number' && Number.isFinite(obj.schemaVersion)
      ? obj.schemaVersion
      : 0;
  const startVersion = declared;

  let data = obj !== null ? { ...obj } : {};
  let migrated = false;
  let v = startVersion;
  while (v < SETTINGS_SCHEMA_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) break;
    data = step(data);
    v += 1;
    migrated = true;
  }

  return {
    settings: normalizeSettings(data),
    migrated,
    fromVersion: startVersion,
  };
}
