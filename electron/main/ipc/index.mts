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
