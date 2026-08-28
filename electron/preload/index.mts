/**
 * Typed preload bridge (VaniScript Electron Migration Plan §4.3 — FND-02).
 *
 * Exposes a single typed `electronAPI` to the renderer via `contextBridge`,
 * rejecting malformed or locally-invalid payloads before they ever reach
 * `ipcMain`. Every call is wrapped in the shared `RequestEnvelope` and the
 * `ResultEnvelope` returned by the router is unwrapped back into a plain value
 * (or a thrown `IpcBridgeError` on failure).
 *
 * The module is Electron-independent at load time: only the renderer install
 * path (guarded by `process.type === 'renderer'`) dynamically imports
 * `electron`, so the bridge logic can be unit-tested directly in Node.
 */
import {
  createRequest,
  type RequestEnvelope,
  type RequestOptions,
  type ResultEnvelope,
  SETTINGS_GET_COMMAND,
  SETTINGS_UPDATE_COMMAND,
  type SettingsGetResult,
  type SettingsUpdateRequest,
  type SettingsUpdateResult,
  CAPABILITIES_GET_COMMAND,
  type CapabilitiesGetResult,
  USAGE_GET_COMMAND,
  USAGE_RECORD_COMMAND,
  USAGE_RESET_COMMAND,
  USAGE_EXPORT_COMMAND,
  DIAGNOSTICS_GET_COMMAND,
  DIAGNOSTICS_EXPORT_COMMAND,
  DIAGNOSTICS_OPEN_LOGS_COMMAND,
  type UsageGetResult,
  type UsageRecordRequest,
  type UsageRecordResult,
  type UsageResetResult,
  type UsageExportResult,
  type DiagnosticsGetResult,
  type DiagnosticsExportResult,
  type DiagnosticsOpenLogsResult,
} from '../../shared/contracts/ipc.ts';
import {
  DOCUMENT_EXPORT_COMMAND,
  type DocumentExportRequest,
  type DocumentExportResult,
} from '../../shared/contracts/documents.ts';
import {
  createAppError,
  isAppError,
  type AppError,
} from '../../shared/contracts/errors.ts';
import {
  PROVIDER_INVOKE_COMMAND,
  type ProviderInvokeRequest,
  type ProviderInvokeResult,
} from '../../shared/contracts/providers.ts';
import { IPC_DISPATCH_CHANNEL, type Command } from '../main/ipc/index.mts';
import {
  BATCH_COMMANDS,
  type BatchJob,
  type BatchJobsPage,
  type BatchJobsQuery,
  type BatchProfile,
  type BatchProfileInput,
  type BatchJobDetails,
  type BatchQueueSnapshot,
  type BatchIssue,
} from '../../shared/contracts/batch.ts';
import type { IpcRenderer } from 'electron';

/** Opt-in local validation for registered methods. */
interface MethodSpec {
  /** Validate args before dispatch; returning false rejects the call locally. */
  validateArgs?: (args: unknown) => boolean;
}

function hasNonEmptyStringField(value: unknown, key: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const field = record[key];
  return typeof field === 'string' && field.trim().length > 0;
}

/**
 * Local guard rail: known methods get a cheap structural check so a bad call
 * fails immediately in the renderer instead of round-tripping to main.
 */
const METHOD_REGISTRY: Record<string, MethodSpec> = {
  'dialog:openFile': { validateArgs: (a) => a === undefined || a === null },
  'dialog:openDirectory': { validateArgs: (a) => a === undefined || a === null },
  'fs:writeFile': {
    validateArgs: (a) => {
      if (a === null || typeof a !== 'object') return false;
      if (!('filePath' in a) || !('content' in a)) return false;
      return typeof a.filePath === 'string' && typeof a.content === 'string';
    },
  },
  'settings:get': { validateArgs: (a) => a === undefined || a === null },
  'settings:update': {
    validateArgs: (a) => {
      if (a === undefined || a === null) return false;
      if (typeof a !== 'object' || Array.isArray(a)) return false;
      const patch = a as Partial<SettingsUpdateRequest>;
      if (patch.settings !== undefined && typeof patch.settings !== 'object') return false;
      if (patch.usage !== undefined && typeof patch.usage !== 'object') return false;
      return true;
    },
  },
  'capabilities:get': { validateArgs: (a) => a === undefined || a === null },
  [USAGE_GET_COMMAND]: { validateArgs: (a) => a === undefined || a === null || (typeof a === 'object' && !Array.isArray(a)) },
  [USAGE_RECORD_COMMAND]: {
    validateArgs: (a) => {
      if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
      const input = a as Partial<UsageRecordRequest>;
      return typeof input.operationId === 'string'
        && typeof input.providerId === 'string'
        && typeof input.purpose === 'string'
        && (input.outcome === 'success' || input.outcome === 'error');
    },
  },
  [USAGE_RESET_COMMAND]: { validateArgs: (a) => a === undefined || a === null },
  [USAGE_EXPORT_COMMAND]: { validateArgs: (a) => a === undefined || a === null || (typeof a === 'object' && !Array.isArray(a)) },
  [DIAGNOSTICS_GET_COMMAND]: { validateArgs: (a) => a === undefined || a === null },
  [DIAGNOSTICS_EXPORT_COMMAND]: { validateArgs: (a) => a === undefined || a === null },
  [DIAGNOSTICS_OPEN_LOGS_COMMAND]: { validateArgs: (a) => a === undefined || a === null },
  [DOCUMENT_EXPORT_COMMAND]: {
    validateArgs: (a) => {
      if (a === null || typeof a !== 'object' || Array.isArray(a)) return false;
      const request = a as Partial<DocumentExportRequest>;
      if (typeof request.projectId !== 'string' || request.projectId.trim() === '') return false;
      if (!['docx', 'txt', 'md', 'pdf'].includes(request.format as string)) return false;
      if (request.language !== undefined && request.language !== null && typeof request.language !== 'string') return false;
      if (request.outputPath !== undefined && request.outputPath !== null && typeof request.outputPath !== 'string') return false;
      return request.overwrite === undefined || typeof request.overwrite === 'boolean';
    },
  },
  // provider:invoke is a raw ipcMain.handle in main.js (PRV-01), not routed via
  // the typed ipc:dispatch facade; it still gets a local shape guard here.
  [PROVIDER_INVOKE_COMMAND]: {
    validateArgs: (a) =>
      !!a &&
      typeof a === 'object' &&
      !Array.isArray(a) &&
      typeof (a as ProviderInvokeRequest).providerId === 'string',
  },
  [BATCH_COMMANDS.getState]: { validateArgs: (a) => a === undefined || a === null },
  [BATCH_COMMANDS.listProfiles]: {
    validateArgs: (a) => a === undefined || a === null || (typeof a === 'object' && !Array.isArray(a)),
  },
  [BATCH_COMMANDS.createProfile]: {
    validateArgs: (a) => hasNonEmptyStringField(a, 'name') && hasNonEmptyStringField(a, 'sourcePath'),
  },
  [BATCH_COMMANDS.listJobs]: {
    validateArgs: (a) => a === undefined || a === null || (typeof a === 'object' && !Array.isArray(a)),
  },
  [BATCH_COMMANDS.getJobDetails]: {
    validateArgs: (a) => hasNonEmptyStringField(a, 'jobId'),
  },
  [BATCH_COMMANDS.scan]: { validateArgs: (a) => a === undefined || a === null },
  [BATCH_COMMANDS.start]: { validateArgs: (a) => a === undefined || a === null },
  [BATCH_COMMANDS.pauseAfterCurrent]: { validateArgs: (a) => a === undefined || a === null },
  [BATCH_COMMANDS.resume]: { validateArgs: (a) => a === undefined || a === null },
  [BATCH_COMMANDS.drain]: { validateArgs: (a) => a === undefined || a === null },
  [BATCH_COMMANDS.retry]: {
    validateArgs: (a) => hasNonEmptyStringField(a, 'jobId'),
  },
  [BATCH_COMMANDS.cancel]: {
    validateArgs: (a) => hasNonEmptyStringField(a, 'jobId'),
  },
  [BATCH_COMMANDS.listIssues]: { validateArgs: (a) => a === undefined || a === null },
};

/** Error surfaced to renderer code when a call is rejected or fails. */
export class IpcBridgeError extends Error {
  readonly appError: AppError;
  constructor(appError: AppError) {
    super(appError.message);
    this.name = 'IpcBridgeError';
    this.appError = appError;
    Object.setPrototypeOf(this, IpcBridgeError.prototype);
  }
}

/** The typed surface exposed to the renderer as `window.electronAPI`. */
export interface ElectronApi {
  invoke<R = unknown>(method: string, args?: unknown, options?: RequestOptions): Promise<R>;
  send(method: string, args?: unknown, options?: RequestOptions): void;
  getVersion(): Promise<string>;
  openFileDialog(): Promise<{ canceled: boolean; filePaths: string[] } | null>;
  writeFile(args: { filePath: string; content: string }): Promise<{ ok: boolean }>;
  listProjects(): Promise<unknown[]>;
  getSettings(): Promise<SettingsGetResult>;
  getCapabilities(): Promise<CapabilitiesGetResult>;
  updateSettings(args: SettingsUpdateRequest): Promise<SettingsUpdateResult>;
  exportDocument(args: DocumentExportRequest): Promise<DocumentExportResult>;
  invokeProvider(args: ProviderInvokeRequest): Promise<ProviderInvokeResult>;
  getUsage(range?: { from?: string; to?: string }): Promise<UsageGetResult>;
  recordUsage(args: UsageRecordRequest): Promise<UsageRecordResult>;
  resetUsage(): Promise<UsageResetResult>;
  exportUsage(range?: { from?: string; to?: string }): Promise<UsageExportResult>;
  getDiagnostics(): Promise<DiagnosticsGetResult>;
  exportDiagnostics(): Promise<DiagnosticsExportResult>;
  openDiagnosticsLogs(): Promise<DiagnosticsOpenLogsResult>;
  getBatchState(): Promise<BatchQueueSnapshot>;
  listBatchProfiles(args?: { limit?: number; offset?: number; enabled?: boolean }): Promise<{ profiles: BatchProfile[] }>;
  createBatchProfile(args: BatchProfileInput): Promise<{ profile: BatchProfile }>;
  listBatchJobs(args?: BatchJobsQuery): Promise<BatchJobsPage>;
  getBatchJobDetails(args: { jobId: string }): Promise<BatchJobDetails>;
  scanBatch(): Promise<unknown>;
  startBatch(): Promise<BatchQueueSnapshot>;
  pauseBatchAfterCurrent(): Promise<BatchQueueSnapshot>;
  resumeBatch(): Promise<BatchQueueSnapshot>;
  drainBatch(): Promise<{ state: BatchQueueSnapshot; result: unknown }>;
  retryBatchJob(args: { jobId: string }): Promise<unknown>;
  cancelBatchJob(args: { jobId: string }): Promise<unknown>;
  listBatchIssues(): Promise<{ issues: BatchIssue[] }>;
}

function buildCommand(method: string, args: unknown): Command {
  return { method, args };
}

function validateLocalArgs(method: string, args: unknown): void {
  const spec = METHOD_REGISTRY[method];
  if (spec?.validateArgs && !spec.validateArgs(args)) {
    throw new IpcBridgeError(
      createAppError('VALIDATION_FAILED', `Invalid args for IPC method "${method}"`),
    );
  }
}

/** Unwrap a `ResultEnvelope` to its value, or throw `IpcBridgeError`. */
function unwrapResult<R>(response: unknown): R {
  if (response === null || typeof response !== 'object' || !('ok' in response)) {
    throw new IpcBridgeError(
      createAppError('CORRUPT_DATA', 'Empty or malformed IPC response'),
    );
  }
  const envelope = response as ResultEnvelope<R>;
  if (envelope.ok) return envelope.value;
  const error = envelope.error;
  if (isAppError(error)) throw new IpcBridgeError(error);
  throw new IpcBridgeError(
    createAppError('INTERNAL', 'IPC response carried an unknown error'),
  );
}

/**
 * Narrow an IPC response to the AppError envelope that main.js returns when a
 * raw handler (e.g. `provider:invoke`) rejects. Used instead of an inline cast
 * so `code`/`message`/`details` are typed after narrowing.
 */
function isAppErrorEnvelope(v: unknown): v is {
  __appError: true;
  code: string;
  message: string;
  details?: unknown;
} {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    r.__appError === true &&
    typeof r.code === 'string' &&
    typeof r.message === 'string'
  );
}

/**
 * Build the typed bridge around any object exposing `invoke`/`send`
 * (the real `ipcRenderer`, or a mock in tests).
 */
export function createTypedIpcBridge(
  ipc: Pick<IpcRenderer, 'invoke' | 'send'>,
): ElectronApi {
  async function invoke<R = unknown>(
    method: string,
    args?: unknown,
    options?: RequestOptions,
  ): Promise<R> {
    validateLocalArgs(method, args);
    const envelope = createRequest<Command>(buildCommand(method, args), options);
    const response = await ipc.invoke(IPC_DISPATCH_CHANNEL, envelope);
    return unwrapResult<R>(response);
  }

  function send(method: string, args?: unknown, options?: RequestOptions): void {
    validateLocalArgs(method, args);
    const envelope = createRequest<Command>(buildCommand(method, args), options);
    ipc.send(IPC_DISPATCH_CHANNEL, envelope);
  }
  function invokeRaw<R = unknown>(method: string, args?: unknown): Promise<R> {
    validateLocalArgs(method, args);
    return ipc.invoke(method, args).then((response) => {
      if (isAppErrorEnvelope(response)) {
        throw new IpcBridgeError(
          createAppError(response.code, response.message, response.details),
        );
      }
      return response as R;
    });
  }

  return {
    invoke,
    send,
    getVersion: () => invoke<string>('app:getVersion'),
    openFileDialog: () =>
      invoke<{ canceled: boolean; filePaths: string[] } | null>('dialog:openFile'),
    writeFile: (args: { filePath: string; content: string }) =>
      invoke<{ ok: boolean }>('fs:writeFile', args),
    listProjects: () => invoke<unknown[]>('project:list'),
    getSettings: () => invoke<SettingsGetResult>(SETTINGS_GET_COMMAND),
    getCapabilities: () => invoke<CapabilitiesGetResult>(CAPABILITIES_GET_COMMAND),
    updateSettings: (args: SettingsUpdateRequest) =>
      invoke<SettingsUpdateResult>(SETTINGS_UPDATE_COMMAND, args),
    exportDocument: (args: DocumentExportRequest) =>
      invoke<DocumentExportResult>(DOCUMENT_EXPORT_COMMAND, args),
    invokeProvider: (args: ProviderInvokeRequest) => {
      // Routed directly to the raw `provider:invoke` channel in main.js (PRV-01),
      // not through the typed ipc:dispatch facade. Main proxies the cloud call
      // and never returns the secret; errors arrive as an __appError envelope.
      validateLocalArgs(PROVIDER_INVOKE_COMMAND, args);
      return ipc.invoke(PROVIDER_INVOKE_COMMAND, args).then((response) => {
        if (isAppErrorEnvelope(response)) {
          throw new IpcBridgeError(
            createAppError(response.code, response.message, response.details),
          );
        }
        return response as ProviderInvokeResult;
      });
    },
    getUsage: (range) => invokeRaw<UsageGetResult>(USAGE_GET_COMMAND, range),
    recordUsage: (args) => invokeRaw<UsageRecordResult>(USAGE_RECORD_COMMAND, args),
    resetUsage: () => invokeRaw<UsageResetResult>(USAGE_RESET_COMMAND),
    exportUsage: (range) => invokeRaw<UsageExportResult>(USAGE_EXPORT_COMMAND, range),
    getDiagnostics: () => invokeRaw<DiagnosticsGetResult>(DIAGNOSTICS_GET_COMMAND),
    exportDiagnostics: () => invokeRaw<DiagnosticsExportResult>(DIAGNOSTICS_EXPORT_COMMAND),
    openDiagnosticsLogs: () => invokeRaw<DiagnosticsOpenLogsResult>(DIAGNOSTICS_OPEN_LOGS_COMMAND),
    getBatchState: () => invoke<BatchQueueSnapshot>(BATCH_COMMANDS.getState),
    listBatchProfiles: (args) =>
      invoke<{ profiles: BatchProfile[] }>(BATCH_COMMANDS.listProfiles, args),
    createBatchProfile: (args) =>
      invoke<{ profile: BatchProfile }>(BATCH_COMMANDS.createProfile, args),
    listBatchJobs: (args) =>
      invoke<BatchJobsPage>(
        BATCH_COMMANDS.listJobs,
        args,
      ),
    getBatchJobDetails: (args) =>
      invoke<BatchJobDetails>(BATCH_COMMANDS.getJobDetails, args),
    scanBatch: () => invoke<unknown>(BATCH_COMMANDS.scan),
    startBatch: () => invoke<BatchQueueSnapshot>(BATCH_COMMANDS.start),
    pauseBatchAfterCurrent: () => invoke<BatchQueueSnapshot>(BATCH_COMMANDS.pauseAfterCurrent),
    resumeBatch: () => invoke<BatchQueueSnapshot>(BATCH_COMMANDS.resume),
    drainBatch: () => invoke<{ state: BatchQueueSnapshot; result: unknown }>(BATCH_COMMANDS.drain),
    retryBatchJob: (args) => invoke<unknown>(BATCH_COMMANDS.retry, args),
    cancelBatchJob: (args) => invoke<unknown>(BATCH_COMMANDS.cancel, args),
    listBatchIssues: () => invoke<{ issues: BatchIssue[] }>(BATCH_COMMANDS.listIssues),
  };
}

/** Install the bridge into the renderer world; no-op outside Electron. */
function installRendererBridge(): void {
  if (typeof process === 'undefined' || process.type !== 'renderer') return;
  import('electron')
    .then((electron) => {
      const { contextBridge, ipcRenderer } = electron as typeof import('electron');
      contextBridge.exposeInMainWorld('electronAPI', createTypedIpcBridge(ipcRenderer));
    })
    .catch((err) => {
      console.error('[preload] failed to install electronAPI', err);
    });
}

installRendererBridge();
