/**
 * Typed IPC router (VaniScript Electron Migration Plan §4.3 — FND-02).
 *
 * A single dispatch channel carries every `RequestEnvelope`. The router
 * validates the inbound envelope, authenticates the sender frame, routes the
 * command to a registered handler, and wraps the outcome in a `ResultEnvelope`.
 *
 * The module is fully Electron-independent (it only receives the `ipcMain`
 * instance for registration) so the routing logic can be exercised directly
 * in unit tests without spinning up Electron.
 */
import {
  validateRequest,
  createSuccess,
  createFailure,
  type RequestEnvelope,
  type ResultEnvelope,
} from '../../../shared/contracts/ipc.ts';
import {
  AppError,
  createAppError,
  isAppError,
} from '../../../shared/contracts/errors.ts';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  readSettings,
  writeSettings,
} from '../storage/settingsStore.js';
import {
  SETTINGS_GET_COMMAND,
  SETTINGS_UPDATE_COMMAND,
  type SettingsUpdateRequest,
} from '../../../shared/contracts/ipc.ts';
import type { Settings } from '../../../shared/contracts/settings.ts';
import capabilityRegistry from '../platform/capabilityRegistry.js';
import {
  CAPABILITIES_GET_COMMAND,
  type CapabilityReport,
  type HostSummary,
} from '../../../shared/contracts/capabilities.ts';
import type { CapabilitiesGetResult } from '../../../shared/contracts/ipc.ts';
import {
  DOCUMENT_EXPORT_COMMAND,
  type DocumentExportRequest,
  type DocumentExportResult,
} from '../../../shared/contracts/documents.ts';
import { createDocumentExportService } from '../documents/export.js';
import {
  BATCH_COMMANDS,
  BATCH_JOB_STATES,
  type BatchBadgeState,
  type BatchIssue,
  type BatchJob,
  type BatchJobDetails,
  type BatchJobsPage,
  type BatchProfile,
  type BatchProfileInput,
  type BatchQueueSnapshot,
  type BatchSchedulerMode,
} from '../../../shared/contracts/batch.ts';
import { createBatchDomain } from '../batch/batchDomain.js';
import { createBatchScheduler } from '../batch/batchScheduler.js';
import { createBatchWatcher } from '../batch/batchWatcher.js';

/** Wire channel every typed request travels on. */
export const IPC_DISPATCH_CHANNEL = 'ipc:dispatch' as const;

/** A routed command: which handler to run plus its (already typed) args. */
export interface Command<P = unknown> {
  readonly method: string;
  readonly args: P;
}

function isCommandPayload(p: unknown): p is Command {
  return typeof p === 'object' && p !== null && typeof (p as Command).method === 'string';
}

/** A handler resolves args into a value (wrapped as a success result). */
export type IpcHandler<Args = unknown, Result = unknown> = (
  args: Args,
  ctx: DispatchContext,
) => Result | Promise<Result>;

export interface IpcHandlerMap {
  [method: string]: IpcHandler;
}

/** Ambient context handed to every handler. */
export interface DispatchContext {
  /** The originating request id, for tracing. */
  readonly requestId?: string;
  /** The IPC event that triggered the call, when available. */
  readonly event?: IpcMainInvokeEvent;
  /** Optional project scope carried on the envelope. */
  readonly projectId?: string;
  /** Optional optimistic-concurrency revision carried on the envelope. */
  readonly expectedRevision?: string;
}

/** Best-effort read of an untrusted frame's requestId, for tracing rejected envelopes. */
function readRequestId(raw: unknown): string | undefined {
  // Boundary read of an untrusted frame: we only need a possible requestId
  // for tracing, so accept any object and read it untyped via a named cast.
  if (typeof raw !== 'object' || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  const id = rec.requestId;
  return typeof id === 'string' ? id : undefined;
}


export type SenderValidator = (event: IpcMainInvokeEvent | undefined) => boolean;

export interface DispatchOptions {
  /** IPC event, supplied by the Electron wiring. */
  event?: IpcMainInvokeEvent;
  /**
   * Authorize the sender before routing. Receives the event. Return false to
   * reject with `PERMISSION_DENIED`. When omitted the sender is trusted —
   * production wiring MUST supply a validator.
   */
  validateSender?: SenderValidator;
}

/** Map a thrown error to a failure envelope using the shared error codes. */
function toFailure(requestId: string, error: unknown): ResultEnvelope<never> {
  if (isAppError(error)) {
    return createFailure(requestId, error as AppError);
  }
  const message =
    error instanceof Error ? error.message : String(error ?? 'unknown error');
  return createFailure(requestId, createAppError('INTERNAL', message));
}

/**
 * Validate, authorize, route, and wrap a single inbound request. Pure and
 * Electron-independent so it can be exercised directly in tests.
 */
export async function dispatch(
  raw: unknown,
  handlers: IpcHandlerMap,
  options: DispatchOptions = {},
): Promise<ResultEnvelope<unknown>> {
  const validated = validateRequest(raw);
  if (!validated.ok) {
    const rejectedId = readRequestId(raw) ?? `rejected_${Date.now().toString(36)}`;
    return createFailure(rejectedId, createAppError('VALIDATION_FAILED', validated.error));
  }

  const envelope = validated.value;
  const requestId = envelope.requestId;
  const payload = envelope.payload;
  if (!isCommandPayload(payload)) {
    return createFailure(
      requestId,
      createAppError('VALIDATION_FAILED', 'Invalid command payload'),
    );
  }
  const { method, args } = payload;

  // Authenticate the sender before any handler runs.
  if (options.validateSender && !options.validateSender(options.event)) {
    return createFailure(
      requestId,
      createAppError('PERMISSION_DENIED', 'Sender frame is not authorized to invoke IPC.'),
    );
  }

  const handler = handlers[method];
  if (!handler) {
    return createFailure(
      requestId,
      createAppError('CAPABILITY_UNAVAILABLE', `No handler registered for method "${method}"`),
    );
  }

  const ctx: DispatchContext = {
    requestId,
    event: options.event,
    projectId: envelope.projectId,
    expectedRevision: envelope.expectedRevision,
  };

  try {
    const value = await handler(args, ctx);
    return createSuccess(requestId, value);
  } catch (err) {
    return toFailure(requestId, err);
  }
}

/**
 * Build a sender validator that accepts only the supplied frame origins.
 * Used by the production wiring to reject any request not originating from
 * the trusted renderer (e.g. `app://`, or the dev-server origin in dev).
 */
export function createSenderValidator(
  allowedOrigins: ReadonlyArray<string>,
): SenderValidator {
  return (event) => {
    if (!event) return false;
    const url = event.senderFrame?.url;
    if (!url) return false;
    try {
      return allowedOrigins.includes(new URL(url).origin);
    } catch {
      return false;
    }
  };
}

/**
 * Register the dispatch handler on the real `ipcMain`. Every invoke on
 * `IPC_DISPATCH_CHANNEL` is routed through `dispatch`, preserving the
 * envelope contract and sender authentication.
 */
export function registerIpcRouter(
  ipcMain: IpcMain,
  handlers: IpcHandlerMap,
  baseOptions: Omit<DispatchOptions, 'event'> = {},
): void {
  ipcMain.handle(IPC_DISPATCH_CHANNEL, (event, raw) =>
    dispatch(raw, handlers, { ...baseOptions, event }),
  );
}

/** Main-only channel used by a trusted renderer confirmation affordance. */
export const MCP_CONFIRM_CHALLENGE_CHANNEL = 'mcp:confirmChallenge' as const;

export interface McpChallengeConfirmer {
  confirmChallenge: (challengeId: string) => boolean | Promise<boolean>;
}

export type McpChallengeConfirmationTarget =
  | McpChallengeConfirmer
  | ((challengeId: string) => boolean | Promise<boolean>);

/**
 * Register the human confirmation seam separately from the bearer-authenticated
 * MCP transport. The payload contains only the opaque challenge id; callers
 * must supply the renderer sender validator used by the app's IPC wiring.
 */
export function registerMcpConfirmationChannel(
  ipcMain: IpcMain,
  target: McpChallengeConfirmationTarget,
  options: Pick<DispatchOptions, 'validateSender'> = {},
): void {
  ipcMain.handle(MCP_CONFIRM_CHALLENGE_CHANNEL, async (event, raw) => {
    if (options.validateSender && !options.validateSender(event)) {
      throw createAppError('PERMISSION_DENIED', 'Sender frame is not authorized to confirm MCP challenges.');
    }
    const challengeId = typeof raw === 'string'
      ? raw
      : isPlainObject(raw) && typeof raw.challengeId === 'string'
        ? raw.challengeId
        : '';
    if (challengeId.length === 0) {
      throw createAppError('VALIDATION_FAILED', 'challengeId must be a non-empty string.');
    }
    const approve = typeof target === 'function'
      ? target
      : target && typeof target.confirmChallenge === 'function'
        ? (id: string) => target.confirmChallenge(id)
        : null;
    if (typeof approve !== 'function') {
      throw createAppError('CAPABILITY_UNAVAILABLE', 'MCP mutation confirmation is unavailable.');
    }
    return {
      challengeId,
      approved: Boolean(await approve(challengeId)),
    };
  });
}

// ─── App settings read/update handlers (SET-04) ────────────────────────────
// Renderer-facing handlers backed by the main-process settings store. A
// factory accepts an injected store so tests can use an in-memory adapter
// instead of the on-disk `settingsStore`.

/** Minimal store contract the handlers depend on. */
export interface SettingsStoreAdapter {
  readSettings: (opts?: unknown) => { settings: Settings };
  writeSettings: (settings: Settings, opts?: unknown) => { settings: Settings };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge a partial patch over a base, preserving unspecified fields. */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(patch)) {
    const next = patch[key];
    out[key] = isPlainObject(next) && isPlainObject(out[key])
      ? deepMerge(out[key], next)
      : next;
  }
  return out;
}

export function createSettingsHandlers(
  store: SettingsStoreAdapter = { readSettings, writeSettings },
): IpcHandlerMap {
  return {
    [SETTINGS_GET_COMMAND]: () => {
      const { settings } = store.readSettings();
      return { settings };
    },
    [SETTINGS_UPDATE_COMMAND]: (args: SettingsUpdateRequest) => {
      const current = store.readSettings().settings;
      const merged = args.settings
        ? (deepMerge(current, args.settings) as Settings)
        : current;
      const written =
        args.usage !== undefined
          ? { ...merged, api: { ...merged.api, lastUsage: args.usage } }
          : merged;
      return { settings: store.writeSettings(written).settings };
    },
  };
}

export const settingsHandlers = createSettingsHandlers();

// ─── Platform capability registry (CAP-01) ────────────────────────────────
// Probes host OS features and returns a structured CapabilityReport (never a
// bare boolean). The handler is built from the registry so the renderer can
// disable controls with explicit reasons instead of silently choosing a
// different backend.

export function createCapabilityHandlers(
  env?: import('../../../shared/contracts/capabilities.ts').HostEnvironment,

): IpcHandlerMap {
  const handlers = capabilityRegistry.createCapabilityHandlers(env);
  return handlers as IpcHandlerMap;
}

export const capabilityHandlers = createCapabilityHandlers();
// ─── Derived document export (DOC-08) ──────────────────────────────────────

/** Narrow service seam used by the typed handler and its headless tests. */
export interface DocumentExportServiceAdapter {
  exportDocument(
    request: DocumentExportRequest,
  ): DocumentExportResult | Promise<DocumentExportResult>;
}

/**
 * Build the document export handler from a service (or an injected
 * DocumentProjectStore). The default service reads the Main-process project
 * store and never accepts raw source bytes from Renderer.
 */
export function createDocumentExportHandlers(

  serviceOrStore: DocumentExportServiceAdapter | { loadDocumentProject: Function } = createDocumentExportService(),
): IpcHandlerMap {
  const service =
    serviceOrStore && typeof serviceOrStore.exportDocument === 'function'
      ? serviceOrStore as DocumentExportServiceAdapter
      : createDocumentExportService({ store: serviceOrStore });
  return {
    [DOCUMENT_EXPORT_COMMAND]: (args) => {
      const { projectId, format, language, outputPath, overwrite } =
        (args ?? {}) as DocumentExportRequest;
      return service.exportDocument({ projectId, format, language, outputPath, overwrite });
    },
  };
}

export const documentExportHandlers = createDocumentExportHandlers();
// ─── Batch workspace handlers (BAT-06) ─────────────────────────────────────
// The factory is intentionally dependency-injected: D6 owns the renderer
// contract and orchestration seam, while D1-D5 remain the only source of
// persistence, scanning, and scheduler behavior. Production wiring can supply
// the process-owned instances; tests use small fakes without opening SQLite.

export interface BatchDomainAdapter {
  listProfiles(options?: Record<string, unknown>): BatchProfile[];
  createProfile(input: BatchProfileInput): BatchProfile;
  listJobs(options?: BatchJobsQuery): BatchJob[];
  countJobs?(options?: BatchJobsQuery): number;
  getJob(jobId: string): BatchJob;
  listCheckpoints(jobId: string): unknown[];
  listEvents(jobId: string, options?: Record<string, unknown>): unknown[];
  transitionJob?(jobId: string, state: string, details?: Record<string, unknown>): BatchJob;
  cancelJob?(jobId: string): BatchJob;
}

export interface BatchSchedulerAdapter {
  readonly mode?: BatchSchedulerMode | string;
  readonly activeJob?: BatchJob | null;
  start(options?: Record<string, unknown>): Promise<unknown> | unknown;
  pauseAfterCurrent(): Promise<unknown> | unknown;
  resume(): Promise<unknown> | unknown;
  drain(): Promise<unknown> | unknown;
  cancel?(jobId: string): Promise<unknown> | unknown;
}

export interface BatchWatcherAdapter {
  start?(): Promise<unknown> | unknown;
  reconcileProfile?(profileId: string, options?: Record<string, unknown>): Promise<unknown> | unknown;
  readonly activeProfiles?: BatchProfile[];
}

export interface BatchHandlerOptions {
  domain?: BatchDomainAdapter;
  scheduler?: BatchSchedulerAdapter;
  watcher?: BatchWatcherAdapter;
  dbPath?: string;
  runJob?: (job: BatchJob, context: unknown) => Promise<unknown> | unknown;
  scan?: (args: Record<string, unknown>) => Promise<unknown> | unknown;
  retryJob?: (jobId: string) => Promise<unknown> | unknown;
  getIssues?: () => BatchIssue[] | Promise<BatchIssue[]>;
}

function batchRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw createAppError('VALIDATION_FAILED', `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function batchJobId(value: unknown): string {
  const args = batchRecord(value, 'Batch job command');
  const jobId = args.jobId;
  if (typeof jobId !== 'string' || jobId.trim().length === 0) {
    throw createAppError('VALIDATION_FAILED', 'jobId must be a non-empty string.');
  }
  return jobId;
}

function batchLimit(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10000) {
    throw createAppError('VALIDATION_FAILED', 'limit must be an integer between 1 and 10000.');
  }
  return value;
}

function batchOffset(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw createAppError('VALIDATION_FAILED', 'offset must be a non-negative integer.');
  }
  return value;
}

const BATCH_PAGE_MAX_BYTES = 1024 * 1024;

function batchPageByteLength(page: BatchJobsPage): number {
  return new TextEncoder().encode(JSON.stringify(page)).byteLength;
}

function schedulerMode(scheduler: BatchSchedulerAdapter): BatchSchedulerMode {
  const mode = scheduler.mode;
  if (mode === 'running' || mode === 'paused' || mode === 'pause-after-current') return mode;
  return 'stopped';
}

function batchStateForMode(mode: BatchSchedulerMode): BatchBadgeState {
  if (mode === 'running') return 'running';
  if (mode === 'paused' || mode === 'pause-after-current') return 'paused';
  return 'idle';
}

export function createBatchHandlers(options: BatchHandlerOptions = {}): IpcHandlerMap {
  const issueBuffer: BatchIssue[] = [];
  const domain: BatchDomainAdapter = options.domain
    ?? createBatchDomain({ dbPath: options.dbPath }) as unknown as BatchDomainAdapter;
  const scheduler: BatchSchedulerAdapter = options.scheduler
    ?? createBatchScheduler({
      domain,
      runJob: options.runJob ?? (async () => {
        throw createAppError(
          'CAPABILITY_UNAVAILABLE',
          'Batch transcription runner is not wired; inject a runner before starting the queue.',
        );
      }),
      onIssue: (issue: unknown) => {
        if (issue && typeof issue === 'object') issueBuffer.push(issue as BatchIssue);
      },
    }) as unknown as BatchSchedulerAdapter;
  const watcher: BatchWatcherAdapter | undefined = options.watcher
    ?? (createBatchWatcher({
      domain,
      onIssue: (issue: unknown) => {
        if (issue && typeof issue === 'object') issueBuffer.push(issue as BatchIssue);
      },
    }) as unknown as BatchWatcherAdapter);

  const readIssues = async (): Promise<BatchIssue[]> => {
    const issues = options.getIssues ? await options.getIssues() : issueBuffer;
    return Array.isArray(issues) ? issues.slice(-100) : [];
  };

  const readState = async (): Promise<BatchQueueSnapshot> => {
    const mode = schedulerMode(scheduler);
    const activeJobId = scheduler.activeJob?.jobId ?? null;
    return {
      mode,
      activeJobId,
      badge: batchStateForMode(mode),
      updatedAt: new Date().toISOString(),
    };
  };

  return {
    [BATCH_COMMANDS.getState]: async () => readState(),
    [BATCH_COMMANDS.listProfiles]: (args) => {
      const input = batchRecord(args, 'Batch profile query');
      return {
        profiles: domain.listProfiles({
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          limit: batchLimit(input.limit, 1000),
          offset: batchOffset(input.offset),
        }),
      };
    },
    [BATCH_COMMANDS.createProfile]: (args) => ({
      profile: domain.createProfile(batchRecord(args, 'Batch profile input') as unknown as BatchProfileInput),
    }),
    [BATCH_COMMANDS.listJobs]: (args) => {
      const input = batchRecord(args, 'Batch job query');
      const limit = batchLimit(input.limit, 10000);
      const offset = batchOffset(input.offset);
      if (input.profileId !== undefined && typeof input.profileId !== 'string') {
        throw createAppError('VALIDATION_FAILED', 'profileId must be a string.');
      }
      if (input.state !== undefined && !BATCH_JOB_STATES.includes(input.state as BatchJob['state'])) {
        throw createAppError('VALIDATION_FAILED', 'state filter is not supported.');
      }
      if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 256)) {
        throw createAppError('VALIDATION_FAILED', 'query must be a string of at most 256 characters.');
      }
      const query = typeof input.query === 'string' ? input.query.trim() : undefined;
      const criteria: BatchJobsQuery = {
        limit,
        offset,
        ...(input.profileId === undefined ? {} : { profileId: input.profileId as string }),
        ...(input.state === undefined ? {} : { state: input.state as BatchJob['state'] }),
        ...(query ? { query } : {}),
      };
      const loaded = domain.listJobs(criteria);
      const total = typeof domain.countJobs === 'function'
        ? domain.countJobs(criteria)
        : offset + loaded.length + (loaded.length === limit ? 1 : 0);
      let jobs = loaded.slice(0, limit);
      const buildPage = (items: BatchJob[]): BatchJobsPage => {
        const hasMore = offset + items.length < total;
        return {
          jobs: items,
          limit,
          offset,
          total,
          hasMore,
          nextOffset: hasMore ? offset + items.length : null,
        };
      };
      while (jobs.length > 0 && batchPageByteLength(buildPage(jobs)) > BATCH_PAGE_MAX_BYTES) jobs = jobs.slice(0, -1);
      if (loaded.length > 0 && jobs.length === 0) {
        throw createAppError('PAYLOAD_TOO_LARGE', 'Batch page exceeds the 1 MiB payload limit.');
      }
      return buildPage(jobs);
    },
    [BATCH_COMMANDS.getJobDetails]: (args) => {
      const jobId = batchJobId(args);
      const job = domain.getJob(jobId);
      const checkpoints = domain.listCheckpoints(jobId) as BatchJobDetails['checkpoints'];
      const events = domain.listEvents(jobId, { limit: 1000 }) as BatchJobDetails['events'];
      return { job, checkpoints, events } satisfies BatchJobDetails;
    },
    [BATCH_COMMANDS.scan]: async (args) => {
      const input = batchRecord(args, 'Batch scan command');
      if (options.scan) return options.scan(input);
      if (watcher?.start) return watcher.start();
      if (watcher?.reconcileProfile && Array.isArray(watcher.activeProfiles)) {
        const results = await Promise.all(
          watcher.activeProfiles.map((profile) => watcher.reconcileProfile!(profile.profileId, { reason: 'manual' })),
        );
        return { results };
      }
      throw createAppError('CAPABILITY_UNAVAILABLE', 'Batch watcher scan is unavailable.');
    },
    [BATCH_COMMANDS.start]: async () => {
      await scheduler.start({ recover: true });
      return readState();
    },
    [BATCH_COMMANDS.pauseAfterCurrent]: async () => {
      await scheduler.pauseAfterCurrent();
      return readState();
    },
    [BATCH_COMMANDS.resume]: async () => {
      await scheduler.resume();
      return readState();
    },
    [BATCH_COMMANDS.drain]: async () => {
      const result = await scheduler.drain();
      return { state: await readState(), result };
    },
    [BATCH_COMMANDS.retry]: async (args) => {
      const jobId = batchJobId(args);
      if (options.retryJob) return options.retryJob(jobId);
      const job = domain.getJob(jobId);
      if (job.state === 'blockedOutputCollision' && domain.transitionJob) {
        return domain.transitionJob(jobId, 'pending');
      }
      throw createAppError(
        'CAPABILITY_UNAVAILABLE',
        'Batch retry requires the scheduler/domain retry API for this job state.',
      );
    },
    [BATCH_COMMANDS.cancel]: async (args) => {
      const jobId = batchJobId(args);
      if (scheduler.cancel) return scheduler.cancel(jobId);
      if (domain.cancelJob) return domain.cancelJob(jobId);
      throw createAppError('CAPABILITY_UNAVAILABLE', 'Batch cancellation is unavailable.');
    },
    [BATCH_COMMANDS.listIssues]: async () => ({ issues: await readIssues() }),
  };
}
