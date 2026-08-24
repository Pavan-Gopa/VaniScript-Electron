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
export const SETTINGS_SCHEMA_VERSION = 1;

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
    lastUsage: {
      inputTokens: 0,
      outputTokens: 0,
      audioMinutes: 0,
      requests: 0,
      lastModel: null,
      lastPurpose: null,
      estimatedCost: 0,
    },
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
  for (const [id, value] of Object.entries(rawProviders)) {
    providers[id] = normalizeProvider(value, id);
  }
  const u = asObject(a.lastUsage) ?? {};
  return {
    providers,
    favoriteModels: strArray(a.favoriteModels, base.favoriteModels),
    lastUsage: {
      inputTokens: num(u.inputTokens, 0, 0),
      outputTokens: num(u.outputTokens, 0, 0),
      audioMinutes: num(u.audioMinutes, 0, 0),
      requests: num(u.requests, 0, 0),
      lastModel: strOrNull(u.lastModel),
      lastPurpose: strOrNull(u.lastPurpose),
      estimatedCost: num(u.estimatedCost, 0, 0),
    },
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
  0: (data) => ({ ...data, schemaVersion: SETTINGS_SCHEMA_VERSION }),
};

/**
 * Apply sequential migrations to an unknown payload, then normalize.
 *
 * @returns the migrated settings, whether a migration ran, and the version
 *          the payload started from.
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
