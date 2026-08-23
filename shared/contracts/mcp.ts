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

/** Transport-level and policy errors are distinct from JSON-RPC numeric codes. */
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
  'MCP_PERMISSION_DENIED',
  'MCP_CONFIRMATION_REQUIRED',
  'MCP_CONFIRMATION_INVALID',
  'MCP_STALE_REVISION',
  'MCP_NOT_FOUND',
  'MCP_CONFLICT',
  'MCP_CAPABILITY_UNAVAILABLE',
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

export const MCP_CONFIRMATION_REASONS = [
  'required',
  'unknown_or_expired',
  'challenge_mismatch',
  'not_approved',
] as const;
export type McpConfirmationReason = (typeof MCP_CONFIRMATION_REASONS)[number];

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
  readonly mcpCode: McpErrorCode | null;
  readonly reason: McpConfirmationReason | null;
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

/** Risk scopes exposed by MCP tools (D2 read plus D3 mutation/processing). */
export const MCP_TOOL_RISK_LEVELS = [
  'read',
  'mutation',
  'processing',
  'files',
  'network',
  'destructive',
] as const;
export type McpToolRiskLevel = (typeof MCP_TOOL_RISK_LEVELS)[number];
export const MCP_READ_TOOL_SCOPE = 'read' as const;
export type McpReadToolScope = typeof MCP_READ_TOOL_SCOPE;
export type McpMutationToolScope = 'mutation' | 'processing';
export type McpScopePermissionMatrix = Partial<Record<McpToolRiskLevel, boolean>>;

/** One-time challenge metadata returned only when a human must confirm a mutation. */
export interface McpConfirmationChallenge {
  readonly challengeId: string;
  readonly confirmationText: string;
  readonly requiresHumanConfirmation: true;
  readonly expiresAt: string;
}
/** Dependency-free JSON Schema projection carried in tools/list. */
export interface McpJsonSchema {
  readonly type?: string | readonly string[];
  readonly title?: string;
  readonly description?: string;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, McpJsonSchema>>;
  readonly additionalProperties?: boolean | McpJsonSchema;
  readonly items?: McpJsonSchema;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly [key: string]: unknown;
}

/** Stable metadata and schemas for one MCP tool. */
export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: McpJsonSchema;
  readonly resultSchema: McpJsonSchema;
  readonly outputSchema?: McpJsonSchema;
  readonly risk: McpToolRiskLevel;
  readonly riskLevel?: McpToolRiskLevel;
  readonly scope: McpToolRiskLevel;
  readonly capabilityRequirements: readonly string[];
  readonly requiredCapabilities?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly confirmationText?: string | null;
  readonly annotations?: Readonly<Record<string, unknown>>;
}
/**
 * Deterministic payload returned by a read handler. The transport envelope
 * repeats projectId/projectRevision for correlation; keeping them here makes a
 * tool result self-describing when it is forwarded or cached independently.
 */
export interface McpReadResultEnvelope<T = unknown> {
  readonly schemaVersion: McpSchemaVersion;
  readonly tool: string;
  readonly scope: typeof MCP_READ_TOOL_SCOPE;
  readonly risk: typeof MCP_READ_TOOL_SCOPE;
  readonly projectId: string | null;
  readonly projectRevision: number | string | null;
  readonly data: T;
}

/** Deterministic payload returned by a mutation/processing handler. */
export interface McpMutationResultEnvelope<T = unknown> {
  readonly schemaVersion: McpSchemaVersion;
  readonly tool: string;
  readonly scope: McpMutationToolScope;
  readonly risk: McpMutationToolScope;
  readonly projectId: string | null;
  readonly projectRevision: number | string | null;
  readonly data: T;
  readonly confirmationText: string;
}

export type McpToolResultEnvelope<T = unknown> =
  | McpReadResultEnvelope<T>
  | McpMutationResultEnvelope<T>;

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
  if (
    record.mcpCode !== undefined
    && record.mcpCode !== null
    && !MCP_ERROR_CODES.includes(record.mcpCode as McpErrorCode)
  ) {
    return { ok: false, error: createAppError('VALIDATION_FAILED', 'MCP audit record.mcpCode is invalid.') };
  }
  if (
    record.reason !== undefined
    && record.reason !== null
    && !MCP_CONFIRMATION_REASONS.includes(record.reason as McpConfirmationReason)
  ) {
    return { ok: false, error: createAppError('VALIDATION_FAILED', 'MCP audit record.reason is invalid.') };
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
      mcpCode: (record.mcpCode ?? null) as McpErrorCode | null,
      reason: (record.reason ?? null) as McpConfirmationReason | null,
      tokenIdHash: record.tokenIdHash as string | null,
      requestIdHash: record.requestIdHash as string | null,
    },
  };
}
