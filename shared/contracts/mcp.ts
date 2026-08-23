/**
 * Shared contracts for the Main-process loopback MCP service (MCP-01).
 *
 * The transport is intentionally dependency-free. These shapes are the stable
 * boundary for the future read/mutation tool catalog; the server itself may
 * remain CommonJS while Renderer/Main consumers import these types directly.
 */

import { AppError, createAppError } from './errors.ts';

/** Version of the MCP transport/domain shapes, not the MCP protocol itself. */
export const MCP_SCHEMA_VERSION = 1 as const;
export type McpSchemaVersion = typeof MCP_SCHEMA_VERSION;

/** Protocol versions understood by this release, oldest first for negotiation. */
export const MCP_PROTOCOL_VERSIONS = [
  '2024-11-05',
  '2025-03-26',
] as const;
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];
export const MCP_DEFAULT_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[MCP_PROTOCOL_VERSIONS.length - 1];
/** Compatibility alias used by protocol clients that call this a single version. */
export const MCP_PROTOCOL_VERSION = MCP_DEFAULT_PROTOCOL_VERSION;

export const MCP_SERVER_STATES = [
  'stopped',
  'starting',
  'running',
  'draining',
  'error',
] as const;
export type McpServerState = (typeof MCP_SERVER_STATES)[number];

/** Transport-level errors are distinct from JSON-RPC's numeric error codes. */
export const MCP_ERROR_CODES = [
  'MCP_BIND_REJECTED',
  'MCP_SERVER_NOT_RUNNING',
  'MCP_SERVER_DRAINING',
  'MCP_UNAUTHORIZED',
  'MCP_TOKEN_EXPIRED',
  'MCP_TOKEN_REVOKED',
  'MCP_TOKEN_UNAVAILABLE',
  'MCP_UNSUPPORTED_VERSION',
  'MCP_INVALID_REQUEST',
  'MCP_REQUEST_TOO_LARGE',
  'MCP_REQUEST_TIMEOUT',
  'MCP_CONCURRENCY_LIMIT',
  'MCP_METHOD_NOT_FOUND',
  'MCP_INTERNAL',
] as const;
export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

export const MCP_AUDIT_OUTCOMES = [
  'success',
  'denied',
  'rejected',
  'error',
  'timeout',
] as const;
export type McpAuditOutcome = (typeof MCP_AUDIT_OUTCOMES)[number];

export interface McpErrorShape {
  readonly code: McpErrorCode;
  readonly message: string;
  readonly status: number;
  readonly appCode?: string;
  readonly details?: unknown;
}

export interface McpServerStatus {
  readonly schemaVersion: McpSchemaVersion;
  readonly state: McpServerState;
  readonly host: '127.0.0.1' | '::1';
  readonly port: number | null;
  readonly uptimeMs: number;
  readonly activeConnections: number;
  readonly activeRequests: number;
  readonly startedAt: string | null;
  readonly supportedProtocolVersions: readonly McpProtocolVersion[];
  readonly tokenRef: string | null;
  readonly tokenId: string | null;
  readonly tokenExpiresAt: string | null;
}

/** Opaque token metadata; the token value is deliberately absent. */
export interface McpTokenRecord {
  readonly tokenId: string;
  readonly tokenRef: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

export interface McpIssuedToken extends McpTokenRecord {
  /** Returned only by an explicit issue/rotation call, never by status/audit. */
  readonly token: string;
}

export interface McpHandshakeParams {
  readonly protocolVersion?: string;
  readonly clientInfo?: Record<string, unknown>;
  readonly capabilities?: Record<string, unknown>;
  readonly projectId?: string | null;
  readonly projectRevision?: number | string | null;
}

export interface McpHandshakeResult {
  readonly protocolVersion: McpProtocolVersion;
  readonly capabilities: Record<string, unknown>;
  readonly serverInfo: {
    readonly name: string;
    readonly version: string;
  };
}

export interface McpAuditRecord {
  readonly timestamp: string;
  readonly peer: string;
  readonly route: string;
  readonly tool: string | null;
  readonly outcome: McpAuditOutcome;
  readonly tokenIdHash: string | null;
  readonly requestIdHash: string | null;
}

export interface McpResponseEnvelope<T = unknown> {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly requestId: string;
  readonly projectId: string | null;
  readonly projectRevision: number | string | null;
  readonly result?: T;
  readonly error?: McpErrorShape;
}

export type McpValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AppError };

export function isMcpProtocolVersion(value: unknown): value is McpProtocolVersion {
  return (
    typeof value === 'string' &&
    (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(value)
  );
}

export function isMcpErrorCode(value: unknown): value is McpErrorCode {
  return (
    typeof value === 'string' &&
    (MCP_ERROR_CODES as readonly string[]).includes(value)
  );
}

export function createMcpResponseEnvelope<T>(
  id: string | number | null,
  requestId: string,
  result: T,
  projectId: string | null = null,
  projectRevision: number | string | null = null,
): McpResponseEnvelope<T> {
  return {
    jsonrpc: '2.0',
    id,
    requestId,
    projectId,
    projectRevision,
    result,
  };
}

export function createMcpErrorEnvelope(
  id: string | number | null,
  requestId: string,
  error: McpErrorShape,
  projectId: string | null = null,
  projectRevision: number | string | null = null,
): McpResponseEnvelope<never> {
  return {
    jsonrpc: '2.0',
    id,
    requestId,
    projectId,
    projectRevision,
    error,
  };
}

export function validateMcpAuditRecord(value: unknown): McpValidationResult<McpAuditRecord> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: createAppError('VALIDATION_FAILED', 'MCP audit record must be an object.') };
  }
  const record = value as Record<string, unknown>;
  const requiredStrings = ['timestamp', 'peer', 'route'];
  if (requiredStrings.some((field) => typeof record[field] !== 'string' || record[field] === '')) {
    return {
      ok: false,
      error: createAppError('VALIDATION_FAILED', 'MCP audit record contains an invalid required field.'),
    };
  }
  if (record.tool !== null && typeof record.tool !== 'string') {
    return { ok: false, error: createAppError('VALIDATION_FAILED', 'MCP audit record.tool must be a string or null.') };
  }
  if (!MCP_AUDIT_OUTCOMES.includes(record.outcome as McpAuditOutcome)) {
    return { ok: false, error: createAppError('VALIDATION_FAILED', 'MCP audit record.outcome is invalid.') };
  }
  if (record.tokenIdHash !== null && typeof record.tokenIdHash !== 'string') {
    return { ok: false, error: createAppError('VALIDATION_FAILED', 'MCP audit record.tokenIdHash must be a string or null.') };
  }
  if (record.requestIdHash !== null && typeof record.requestIdHash !== 'string') {
    return { ok: false, error: createAppError('VALIDATION_FAILED', 'MCP audit record.requestIdHash must be a string or null.') };
  }
  return {
    ok: true,
    value: {
      timestamp: record.timestamp as string,
      peer: record.peer as string,
      route: record.route as string,
      tool: record.tool as string | null,
      outcome: record.outcome as McpAuditOutcome,
      tokenIdHash: record.tokenIdHash as string | null,
      requestIdHash: record.requestIdHash as string | null,
    },
  };
}
