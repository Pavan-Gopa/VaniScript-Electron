import {
  OBSERVABILITY_SCHEMA_VERSION,
  OBSERVABILITY_LEVELS,
  SAFE_CATEGORIES,
  USAGE_GET_COMMAND,
  USAGE_RECORD_COMMAND,
  USAGE_RESET_COMMAND,
  USAGE_EXPORT_COMMAND,
  DIAGNOSTICS_GET_COMMAND,
  DIAGNOSTICS_EXPORT_COMMAND,
  DIAGNOSTICS_OPEN_LOGS_COMMAND,
  USAGE_PURPOSES,
} from './observability-runtime.js';
import type { Settings, UsageLedger, UsageCounter } from './settings.ts';

export {
  OBSERVABILITY_SCHEMA_VERSION,
  OBSERVABILITY_LEVELS,
  SAFE_CATEGORIES,
  USAGE_GET_COMMAND,
  USAGE_RECORD_COMMAND,
  USAGE_RESET_COMMAND,
  USAGE_EXPORT_COMMAND,
  DIAGNOSTICS_GET_COMMAND,
  DIAGNOSTICS_EXPORT_COMMAND,
  DIAGNOSTICS_OPEN_LOGS_COMMAND,
  USAGE_PURPOSES,
} from './observability-runtime.js';

export type ObservabilityLevel = 'debug' | 'info' | 'warn' | 'error';
export type SafeCategory =
  | 'runtime'
  | 'renderer'
  | 'worker'
  | 'ffmpeg'
  | 'hyperframes'
  | 'provider'
  | 'agent'
  | 'mcp'
  | 'storage'
  | 'usage'
  | 'diagnostics'
  | (string & {});

export interface Correlation {
  requestId?: string;
  projectId?: string;
  operationId?: string;
  jobId?: string;
}

export interface SafeRedactionCounts {
  secret: number;
  path: number;
  text: number;
  field: number;
}

export interface SafeError {
  name: 'Error' | 'AppError' | 'McpServerError' | 'UnknownError';
  code?: string;
  message: string;
  status?: number;
}

export interface SafeLogInput {
  category: string;
  event: string;
  data?: Record<string, unknown>;
  correlation?: Correlation;
  error?: unknown;
}

export interface SafeLogRecord {
  schemaVersion: 1;
  timestamp: string;
  level: ObservabilityLevel;
  category: SafeCategory;
  event: string;
  correlation?: Correlation;
  data?: Record<string, unknown>;
  error?: SafeError;
  redactions: SafeRedactionCounts;
}

export interface UsageRecordInput {
  operationId: string;
  providerId: string;
  modelId?: string;
  purpose: (typeof USAGE_PURPOSES)[number];
  outcome: 'success' | 'error';
  inputTokens?: number;
  outputTokens?: number;
  audioMinutes?: number;
  errorCode?: string;
}

export type UsageProjection = Omit<UsageLedger, 'recentOperationHashes'>;

export interface UsageRange {
  from?: string;
  to?: string;
}

export interface AuditRecord {
  timestamp: string;
  peer: string;
  route: string;
  tool: string | null;
  method?: string | null;
  outcome: 'success' | 'denied' | 'rejected' | 'timeout';
  mcpCode: string | null;
  reason: string | null;
  tokenIdHash: string | null;
  requestIdHash: string | null;
}

export interface SafeErrorRecord {
  timestamp: string;
  category: SafeCategory;
  event: string;
  correlation?: Correlation;
  error: SafeError;
  redactions: SafeRedactionCounts;
}

export interface DiagnosticsCapabilityEntry {
  available: boolean;
  reasonCode?: string;
  backend?: string;
}

export interface DiagnosticsSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  app: {
    appVersion: string;
    electronVersion: string;
    platform: string;
    arch: string;
  };
  capabilities: {
    host: { platform: string; arch: string; audioLoopbackAvailable: boolean };
    entries: Record<string, DiagnosticsCapabilityEntry>;
  };
  models: {
    entries: Array<{
      modelId: string;
      runtime: string | null;
      role: string | null;
      supported: boolean;
      sizeBytes?: number;
    }>;
    truncated: boolean;
  };
  settings: {
    schemaVersion: number;
    providers: Array<{
      id: string;
      enabled: boolean;
      model: string | null;
      transcriptionModel: string | null;
      translationModel: string | null;
      hasKey: boolean;
    }>;
    agents: {
      preferredAgent: string;
      embeddedChatEnabled: boolean;
      localMcpEnabled: boolean;
      mcpPort: number | null;
      permissions: Record<string, boolean>;
    };
    appearance: {
      theme: string;
      density: string;
      baseFontSize: number;
      scale: number;
      reduceMotion: boolean;
      highContrast: boolean;
    };
    transcription: {
      defaultSourceLanguage: string;
      defaultTranscriptionProvider: string;
      defaultTranslationProvider: string;
      defaultTargetLanguage: string;
    };
    chunking: {
      mediaTargetDurationMinutes: number;
      documentTargetTokens: number;
      sliceMode: string;
    };
  };
  recentErrors: SafeErrorRecord[];
  partialFailures: Array<{
    component: 'settings' | 'capabilities' | 'models' | 'errors' | 'diagnostics';
    code: string;
  }>;
  logsAvailable: boolean;
  rawLogsIncluded: false;
}

export interface DiagnosticsGetResult {
  ok: true;
  snapshot: DiagnosticsSnapshot;
}

export interface DiagnosticsExportResult {
  ok: boolean;
  cancelled?: boolean;
  error?: SafeError;
}

export interface DiagnosticsOpenLogsResult {
  ok: boolean;
  error?: SafeError;
}

export interface UsageGetResult {
  ok: true;
  usage: UsageProjection;
}

export interface UsageRecordResult {
  ok: true;
  usage: UsageProjection;
}

export interface UsageResetResult {
  ok: true;
  usage: UsageProjection;
}

export interface UsageExportResult {
  ok: boolean;
  cancelled?: boolean;
  error?: SafeError;
}

export type { Settings, UsageLedger, UsageCounter };
