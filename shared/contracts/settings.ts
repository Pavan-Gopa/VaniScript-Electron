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
 * Typed façade: the public TypeScript interfaces are declared here; every
 * runtime value (`SETTINGS_SCHEMA_VERSION`, defaults, normalization,
 * migration) lives once in `settings-runtime.js` / `settings-runtime.d.ts`
 * (plain CommonJS, loadable by the Electron main process without TypeScript
 * support) and is re-exported below.
 */
import type { SETTINGS_SCHEMA_VERSION } from './settings-runtime.js';

export {
  SETTINGS_SCHEMA_VERSION,
  createDefaultSettings,
  normalizeSettings,
  migrateSettings,
} from './settings-runtime.js';

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
