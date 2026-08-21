/**
 * Typed IPC envelopes shared across the Electron Main and Renderer processes
 * (VaniScript Electron Migration Plan §4.3 — Typed IPC).
 *
 * Every request and response crossing the process boundary is wrapped in a
 * versioned envelope. `RequestEnvelope` carries the request; `ResultEnvelope`
 * is a discriminated success/failure union whose failure branch embeds an
 * `AppError`. Runtime validators let both sides reject malformed frames
 * before they reach business logic.
 */
import {
  ERROR_CODES,
  isAppError,
  type AppError,
} from './errors.ts';
import { type Settings, type UsageSnapshot } from './settings.ts';
import {
  CAPABILITIES_GET_COMMAND,
  type CapabilityReport,
  type HostSummary,
} from './capabilities.ts';

/** Current envelope wire format version. Bump on breaking changes. */
export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** Outbound request frame. */
export interface RequestEnvelope<T> {
  readonly protocolVersion: ProtocolVersion;
  readonly requestId: string;
  readonly projectId?: string;
  readonly expectedRevision?: string;
  readonly payload: T;
}

/** Inbound response frame: success carries `value`, failure carries `error`. */
export type ResultEnvelope<T> =
  | { readonly ok: true; readonly requestId: string; readonly value: T; readonly revision?: string }
  | { readonly ok: false; readonly requestId: string; readonly error: AppError };

function nextRequestId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export interface RequestOptions {
  requestId?: string;
  projectId?: string;
  expectedRevision?: string;
}

/** Build a request envelope, assigning a UUID `requestId` when omitted. */
export function createRequest<T>(
  payload: T,
  options: RequestOptions = {},
): RequestEnvelope<T> {
  const envelope: any = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: options.requestId ?? nextRequestId(),
    payload,
  };
  if (options.projectId !== undefined) envelope.projectId = options.projectId;
  if (options.expectedRevision !== undefined) {
    envelope.expectedRevision = options.expectedRevision;
  }
  return envelope as RequestEnvelope<T>;
}

/** Build a success result, attaching `revision` only when provided. */
export function createSuccess<T>(
  requestId: string,
  value: T,
  revision?: string,
): ResultEnvelope<T> {
  return revision !== undefined
    ? { ok: true, requestId, value, revision }
    : { ok: true, requestId, value };
}

/** Build a failure result embedding an `AppError`. */
export function createFailure<T = never>(
  requestId: string,
  error: AppError,
): ResultEnvelope<T> {
  return { ok: false, requestId, error };
}

export function isSuccess<T>(
  result: ResultEnvelope<T>,
): result is { ok: true; requestId: string; value: T; revision?: string } {
  return result.ok === true;
}

export function isFailure<T>(
  result: ResultEnvelope<T>,
): result is { ok: false; requestId: string; error: AppError } {
  return result.ok === false;
}

/** Structural runtime check for an inbound request frame. */
export function isRequestEnvelope(value: unknown): value is RequestEnvelope<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v['protocolVersion'] === PROTOCOL_VERSION &&
    typeof v['requestId'] === 'string' &&
    'payload' in v
  );
}

/** Structural runtime check for an inbound response frame. */
export function isResultEnvelope(value: unknown): value is ResultEnvelope<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['requestId'] !== 'string') return false;
  if (v['ok'] === true) return 'value' in v;
  if (v['ok'] === false) return isAppError(v['error']);
  return false;
}

export type RequestValidation =
  | { ok: true; value: RequestEnvelope<unknown> }
  | { ok: false; error: string };

/**
 * Validate an unknown value as a `RequestEnvelope`. An optional
 * `validatePayload` hook enforces payload-specific shape (e.g. a command
 * schema) so callers get one validated frame or a precise failure reason.
 */
export function validateRequest(
  value: unknown,
  validatePayload?: (payload: unknown) => boolean,
): RequestValidation {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, error: 'RequestEnvelope must be an object' };
  }
  const v = value as Record<string, unknown>;
  if (v['protocolVersion'] !== PROTOCOL_VERSION) {
    return {
      ok: false,
      error: `protocolVersion must be ${PROTOCOL_VERSION}`,
    };
  }
  if (typeof v['requestId'] !== 'string' || v['requestId'].length === 0) {
    return { ok: false, error: 'requestId must be a non-empty string' };
  }
  if (!('payload' in v)) {
    return { ok: false, error: 'payload is required' };
  }
  if (validatePayload && !validatePayload(v['payload'])) {
    return { ok: false, error: 'payload failed custom validation' };
  }
  return { ok: true, value: value as RequestEnvelope<unknown> };
}

// Re-export the error contract so a single import satisfies most call sites.
export { ERROR_CODES };
export type { AppError };

// ─── Legacy settings migration handshake ───────────────────────────────────
// One-shot handshake used by SET-03: the Renderer reads legacy keys from
// `localStorage` (`vs_settings_v1`, `vs_usage_v1`), ships the raw payload to
// Main, which commits it to the disk settings store + credential vault and
// returns an ack. The Renderer clears `localStorage` only after a successful
// ack — a failed migration leaves the legacy data intact for a safe retry on
// the next launch.

export const MIGRATION_LEGACY_COMMAND = 'settings:migrateLegacy' as const;

export interface MigrateLegacyRequest {
  /** Raw legacy settings payload (already parsed from `vs_settings_v1`). */
  settings?: unknown;
  /** Raw legacy usage payload (already parsed from `vs_usage_v1`). */
  usage?: unknown;
  /** Optional client version string for telemetry. */
  clientVersion?: string;
}

export interface MigrateLegacySummary {
  settingsPath: string;
  vaultPath: string;
  migratedKeys: string[];
  /** sha256 of the committed settings JSON, for verification. */
  checksum: string;
}

export interface MigrateLegacyResult {
  ok: boolean;
  summary?: MigrateLegacySummary;
  error?: string;
  errorCode?: string;
}

// ─── App settings read/update (SET-04) ────────────────────────────────────
// Renderer reads the main-process settings store (instead of `localStorage`)
// and writes changes back through these commands. Usage statistics are folded
// into `Settings.api.lastUsage` — there is no separate main-process usage
// store, so `settings:update` accepts an optional `usage` patch.

export const SETTINGS_GET_COMMAND = 'settings:get' as const;
export const SETTINGS_UPDATE_COMMAND = 'settings:update' as const;

export interface SettingsGetResult {
  settings: Settings;
  revision?: string;
}

export interface SettingsUpdateRequest {
  /** Partial settings patch, deep-merged over the current store. */
  settings?: Partial<Settings>;
  /** Optional usage snapshot folded into `settings.api.lastUsage`. */
  usage?: UsageSnapshot;
}


export interface SettingsUpdateResult {
  settings: Settings;
  revision?: string;
}
// ─── Platform capability registry (CAP-01) ──────────────────────────────────
// Returns a structured capability report (never a bare boolean) plus a host
// summary, so the renderer can disable controls with explicit reasons instead
// of silently picking a different backend. See `electron/main/platform/
// capabilityRegistry.js` for the probe implementation.

export interface CapabilitiesGetResult {
  /** Every probed capability, keyed by `CapabilityKey`. */
  capabilities: CapabilityReport;
  /** The host facts the report was evaluated against. */
  host: HostSummary;
}

// Re-export the capability command + supporting types so most call sites can
// import everything from a single `ipc.ts` module.
export { CAPABILITIES_GET_COMMAND };
export type { CapabilityReport, HostSummary };
