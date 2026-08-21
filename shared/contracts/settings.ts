/**
 * Application settings contract (shared Main/Renderer source of truth).
 *
 * Defines the canonical settings schema, default values, and the
 * normalization + versioned migration logic used by the Main-process
 * settings disk store (`electron/main/storage/settingsStore.js`).
 *
 * Secrets are intentionally absent: provider credentials are stored only as
 * opaque `keyRef` references (resolved by the credential vault, SET-02). The
 * settings store never persists plaintext keys.
 *
 * This module is pure (no Electron / Node built-in side effects) so it can be
 * imported from CommonJS tests via Node's type stripping (`require`).
 */

/** Current persisted settings schema version. Bump when the shape changes. */
export const SETTINGS_SCHEMA_VERSION = 1 as const;
export type SettingsSchemaVersion = typeof SETTINGS_SCHEMA_VERSION;

export interface AgentPermissions {
  read: boolean;
  mutate: boolean;
  processing: boolean;
  file: boolean;
  network: boolean;
  destructive: boolean;
}

export interface AgentsSettings {
  localMcpEnabled: boolean;
  /** Loopback bind port; `null` lets the runtime auto-select. */
  mcpPort: number | null;
  /** Opaque vault reference for the MCP access token (never plaintext). */
  accessTokenRef: string | null;
  preferredAgent: 'codex' | 'grok' | 'qwen';
  embeddedChatEnabled: boolean;
  permissions: AgentPermissions;
}

export interface ProviderBudget {
  enabled: boolean;
  /** Monthly token/credit limit; `null` = unlimited. */
  monthlyLimit: number | null;
}

export interface CloudProviderSettings {
  id: string;
  enabled: boolean;
  /** Opaque vault reference for the API key (never plaintext). */
  keyRef: string | null;
  model: string | null;
  transcriptionModel: string | null;
  translationModel: string | null;
  budget: ProviderBudget;
}

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  audioMinutes: number;
  requests: number;
  lastModel: string | null;
  lastPurpose: string | null;
  estimatedCost: number;
}

export interface ApiSettings {
  providers: Record<string, CloudProviderSettings>;
  favoriteModels: string[];
  lastUsage: UsageSnapshot;
}

export interface EditorFonts {
  source: string;
  translation: string;
  monospace: string;
}

export interface AppearanceSettings {
  theme: 'light' | 'dark' | 'system';
  fontFamily: string;
  baseFontSize: number;
  scale: number;
  annotationMode: string;
  density: 'comfortable' | 'compact';
  editorFonts: EditorFonts;
  reduceMotion: boolean;
  highContrast: boolean;
}

export interface MediaChunkingSettings {
  /** Target segment duration in minutes (1–60). */
  targetDurationMinutes: number;
  sliceMode: string;
  silenceThreshold: number;
  minSilenceDuration: number;
  smartSemantic: boolean;
}

export interface DocumentChunkingSettings {
  targetTokens: number;
  strategy: string;
  overlap: number;
}

export interface ChunkingSettings {
  media: MediaChunkingSettings;
  /** Kept independent so document config never leaks into media chunking. */
  document: DocumentChunkingSettings;
}

export interface GlossarySettings {
  languageScoped: boolean;
  protectedTermsPolicy: 'replace' | 'preserve';
}

export interface ModelsSettings {
  localAsrRoot: string | null;
  localTranslationRoot: string | null;
  autoScan: boolean;
}

export interface PromptsSettings {
  builtInVersion: number;
  userCopyEnabled: boolean;
}

export interface TranscriptionSettings {
  defaultSourceLanguage: string;
  defaultTranscriptionProvider: string;
  defaultTranslationProvider: string;
  defaultTargetLanguage: string;
  languageAutoDetect: boolean;
  documentApprovalMode: 'manual' | 'auto';
}

export interface UpdatesSettings {
  autoCheck: boolean;
  channel: 'stable' | 'beta';
}

export interface Settings {
  schemaVersion: SettingsSchemaVersion;
  agents: AgentsSettings;
  api: ApiSettings;
  appearance: AppearanceSettings;
  chunking: ChunkingSettings;
  glossary: GlossarySettings;
  models: ModelsSettings;
  prompts: PromptsSettings;
  transcription: TranscriptionSettings;
  updates: UpdatesSettings;
}

const DEFAULT_SETTINGS: Settings = {
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
export function createDefaultSettings(): Settings {
  return structuredClone(DEFAULT_SETTINGS);
}

// --- Decoder helpers -------------------------------------------------------

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown, d: string): string {
  return typeof v === 'string' ? v : d;
}

function bool(v: unknown, d: boolean): boolean {
  return typeof v === 'boolean' ? v : d;
}

function num(v: unknown, d: number, min?: number, max?: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return d;
  if (min !== undefined && v < min) return min;
  if (max !== undefined && v > max) return max;
  return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], d: T): T {
  return (allowed as readonly string[]).includes(v as string) ? (v as T) : d;
}

function strArray(v: unknown, d: string[]): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : d;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function normalizeAgents(input: unknown): AgentsSettings {
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

function normalizeProvider(input: unknown, id: string): CloudProviderSettings {
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

function normalizeApi(input: unknown): ApiSettings {
  const base = createDefaultSettings().api;
  const a = asObject(input);
  if (!a) return base;
  const rawProviders = asObject(a.providers) ?? {};
  const providers: Record<string, CloudProviderSettings> = {};
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

function normalizeAppearance(input: unknown): AppearanceSettings {
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

function normalizeChunking(input: unknown): ChunkingSettings {
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

function normalizeGlossary(input: unknown): GlossarySettings {
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

function normalizeModels(input: unknown): ModelsSettings {
  const base = createDefaultSettings().models;
  const m = asObject(input);
  if (!m) return base;
  return {
    localAsrRoot: strOrNull(m.localAsrRoot),
    localTranslationRoot: strOrNull(m.localTranslationRoot),
    autoScan: bool(m.autoScan, base.autoScan),
  };
}

function normalizePrompts(input: unknown): PromptsSettings {
  const base = createDefaultSettings().prompts;
  const p = asObject(input);
  if (!p) return base;
  return {
    builtInVersion: num(p.builtInVersion, base.builtInVersion, 1),
    userCopyEnabled: bool(p.userCopyEnabled, base.userCopyEnabled),
  };
}

function normalizeTranscription(input: unknown): TranscriptionSettings {
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

function normalizeUpdates(input: unknown): UpdatesSettings {
  const base = createDefaultSettings().updates;
  const u = asObject(input);
  if (!u) return base;
  return {
    autoCheck: bool(u.autoCheck, base.autoCheck),
    channel: oneOf(u.channel, ['stable', 'beta'], base.channel),
  };
}

/**
 * Decode an unknown value into a fully-formed {@link Settings}, filling any
 * missing or invalid field with its default. Never throws.
 */
export function normalizeSettings(input: unknown): Settings {
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
const MIGRATIONS: Record<number, (data: Record<string, unknown>) => Record<string, unknown>> = {
  0: (data) => ({ ...data, schemaVersion: SETTINGS_SCHEMA_VERSION }),
};

/**
 * Apply sequential migrations to an unknown payload, then normalize.
 *
 * @returns the migrated settings, whether a migration ran, and the version
 *          the payload started from.
 */
export function migrateSettings(raw: unknown): {
  settings: Settings;
  migrated: boolean;
  fromVersion: number;
} {
  const obj = asObject(raw);
  const declared =
    obj && typeof obj.schemaVersion === 'number' && Number.isFinite(obj.schemaVersion)
      ? obj.schemaVersion
      : 0;
  const startVersion = declared;

  let data: Record<string, unknown> =
    obj !== null ? { ...obj } : {};
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
