/**
 * Shared Batch domain contract (BAT-01).
 *
 * The Main process persists these shapes in SQLite and exposes the same
 * serializable vocabulary to future IPC/scheduler layers.  The validators are
 * deliberately dependency-free apart from the shared error taxonomy so a
 * malformed archive or IPC payload is rejected before it reaches the store.
 */

import { AppError, createAppError, type ErrorCode } from './errors.ts';

/** Version of the serialized Batch domain shapes (not the SQLite schema). */
export const BATCH_SCHEMA_VERSION = 1 as const;
export type BatchSchemaVersion = typeof BATCH_SCHEMA_VERSION;

/** Current SQLite migration version owned by the Batch domain. */
export const BATCH_DB_SCHEMA_VERSION = 3 as const;
export type BatchDbSchemaVersion = typeof BATCH_DB_SCHEMA_VERSION;

// blockedOutputCollision is terminal until the user removes/renames the
// conflicting companion. A retry may move it back to pending.
export const BATCH_JOB_STATES = [
  'pending',
  'running',
  'done',
  'failed',
  'cancelled',
  'blockedOutputCollision',
] as const;
export type BatchJobState = (typeof BATCH_JOB_STATES)[number];

export const BATCH_JOB_PHASES = [
  'planning',
  'loadingModel',
  'convertingAudio',
  'transcribing',
  'finalizing',
] as const;
export type BatchJobPhase = (typeof BATCH_JOB_PHASES)[number];

export interface BatchSourceFingerprint {
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
}

export interface BatchProfile {
  schemaVersion: BatchSchemaVersion;
  profileId: string;
  name: string;
  sourcePath: string;
  accessRef: string | null;
  enabled: boolean;
  recursive: boolean;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BatchProfileInput {
  profileId?: string;
  name: string;
  sourcePath: string;
  accessRef?: string | null;
  enabled?: boolean;
  recursive?: boolean;
  config?: Record<string, unknown>;
}

export type BatchProfilePatch = Partial<Omit<BatchProfileInput, 'profileId'>>;

export interface BatchJob {
  schemaVersion: BatchSchemaVersion;
  jobId: string;
  profileId: string;
  sourcePath: string;
  outputPath: string | null;
  state: BatchJobState;
  phase: BatchJobPhase;
  attempt: number;
  maxAttempts: number;
  progress: number;
  configSnapshot: Record<string, unknown>;
  sourceFingerprint: BatchSourceFingerprint | null;
  outputFingerprint: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface BatchJobInput {
  jobId?: string;
  profileId: string;
  sourcePath: string;
  outputPath?: string | null;
  maxAttempts?: number;
  configSnapshot?: Record<string, unknown>;
  sourceFingerprint?: BatchSourceFingerprint | null;
}

export interface BatchCheckpoint {
  schemaVersion: BatchSchemaVersion;
  jobId: string;
  checkpointKey: string;
  token: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BatchCheckpointInput {
  checkpointKey: string;
  token: string;
  metadata?: Record<string, unknown>;
}

export interface BatchEvent {
  schemaVersion: BatchSchemaVersion;
  eventId: number;
  jobId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface BatchEventInput {
  eventType: string;
  payload?: Record<string, unknown>;
}

type ValidationOk<T> = { ok: true; value: T };
type ValidationErr = { ok: false; error: AppError };

export type BatchValidationResult<T> = ValidationOk<T> | ValidationErr;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return Number.isInteger(value) ? (value as number) : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? value : undefined;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  // JSON is the persisted/IPC representation.  Clone so callers cannot mutate
  // the validated value after it has crossed a store boundary.
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function fail(code: ErrorCode, message: string, details?: unknown): ValidationErr {
  return { ok: false, error: createAppError(code, message, details) };
}

function validateRecord(
  value: unknown,
  field: string,
): BatchValidationResult<Record<string, unknown>> {
  if (!isPlainObject(value)) return fail('VALIDATION_FAILED', `${field} must be an object.`);
  try {
    return { ok: true, value: cloneRecord(value) };
  } catch (error) {
    return fail('VALIDATION_FAILED', `${field} must contain JSON-serializable values.`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function validateFingerprint(
  value: unknown,
  field: string,
): BatchValidationResult<BatchSourceFingerprint | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (!isPlainObject(value)) return fail('VALIDATION_FAILED', `${field} must be an object or null.`);
  const sizeBytes = finiteNumber(value.sizeBytes);
  const mtimeMs = finiteNumber(value.mtimeMs);
  const sha256 = stringValue(value.sha256);
  if (sizeBytes === undefined || sizeBytes < 0) {
    return fail('VALIDATION_FAILED', `${field}.sizeBytes must be a non-negative number.`);
  }
  if (mtimeMs === undefined || mtimeMs < 0) {
    return fail('VALIDATION_FAILED', `${field}.mtimeMs must be a non-negative number.`);
  }
  if (!sha256 || !/^[0-9a-fA-F]{64}$/.test(sha256)) {
    return fail('VALIDATION_FAILED', `${field}.sha256 must be a SHA-256 hex string.`);
  }
  return { ok: true, value: { sizeBytes, mtimeMs, sha256: sha256.toLowerCase() } };
}

function validateSchemaVersion(value: unknown, field: string): ValidationErr | null {
  return value === BATCH_SCHEMA_VERSION
    ? null
    : fail('VALIDATION_FAILED', `${field} must be ${BATCH_SCHEMA_VERSION}.`);
}

export function validateBatchProfile(value: unknown): BatchValidationResult<BatchProfile> {
  if (!isPlainObject(value)) return fail('VALIDATION_FAILED', 'Batch profile must be an object.');
  const versionError = validateSchemaVersion(value.schemaVersion, 'profile.schemaVersion');
  if (versionError) return versionError;
  const profileId = stringValue(value.profileId);
  const name = stringValue(value.name);
  const sourcePath = stringValue(value.sourcePath);
  const accessRefValue = value.accessRef === null || value.accessRef === undefined
    ? null
    : stringValue(value.accessRef);
  const accessRef: string | null = accessRefValue;
  const enabled = value.enabled;
  const recursive = value.recursive;
  const createdAt = isoTimestamp(value.createdAt);
  const updatedAt = isoTimestamp(value.updatedAt);
  if (!profileId) return fail('VALIDATION_FAILED', 'profile.profileId is required.');
  if (!name) return fail('VALIDATION_FAILED', 'profile.name is required.');
  if (!sourcePath) return fail('VALIDATION_FAILED', 'profile.sourcePath is required.');
  if (value.accessRef !== null && value.accessRef !== undefined && !accessRefValue) {
    return fail('VALIDATION_FAILED', 'profile.accessRef must be a non-empty string or null.');
  }
  if (typeof enabled !== 'boolean') return fail('VALIDATION_FAILED', 'profile.enabled must be boolean.');
  if (typeof recursive !== 'boolean') return fail('VALIDATION_FAILED', 'profile.recursive must be boolean.');
  if (!createdAt || !updatedAt) return fail('VALIDATION_FAILED', 'profile timestamps must be ISO strings.');
  const config = validateRecord(value.config, 'profile.config');
  if (!config.ok) return { ok: false, error: (config as ValidationErr).error };
  return {
    ok: true,
    value: {
      schemaVersion: BATCH_SCHEMA_VERSION,
      profileId,
      name,
      sourcePath,
      accessRef,
      enabled,
      recursive,
      config: config.value,
      createdAt,
      updatedAt,
    },
  };
}

export function isBatchProfile(value: unknown): value is BatchProfile {
  return validateBatchProfile(value).ok;
}

export function validateBatchProfileInput(value: unknown): BatchValidationResult<BatchProfileInput> {
  if (!isPlainObject(value)) return fail('VALIDATION_FAILED', 'Batch profile input must be an object.');
  const name = stringValue(value.name);
  const sourcePath = stringValue(value.sourcePath);
  const profileId = value.profileId === undefined ? undefined : stringValue(value.profileId);
  const accessRef: string | null | undefined = value.accessRef === null
    ? null
    : value.accessRef === undefined
      ? undefined
      : stringValue(value.accessRef);
  const enabled = value.enabled === undefined ? true : value.enabled;
  const recursive = value.recursive === undefined ? true : value.recursive;
  if (!name) return fail('VALIDATION_FAILED', 'profile.name is required.');
  if (!sourcePath) return fail('VALIDATION_FAILED', 'profile.sourcePath is required.');
  if (value.profileId !== undefined && !profileId) {
    return fail('VALIDATION_FAILED', 'profile.profileId must be a non-empty string.');
  }
  if (value.accessRef !== undefined && value.accessRef !== null && !accessRef) {
    return fail('VALIDATION_FAILED', 'profile.accessRef must be a non-empty string or null.');
  }
  if (typeof enabled !== 'boolean') return fail('VALIDATION_FAILED', 'profile.enabled must be boolean.');
  if (typeof recursive !== 'boolean') return fail('VALIDATION_FAILED', 'profile.recursive must be boolean.');
  const config = value.config === undefined ? { ok: true as const, value: {} } : validateRecord(value.config, 'profile.config');
  if (!config.ok) return { ok: false, error: (config as ValidationErr).error };
  return {
    ok: true,
    value: {
      ...(profileId ? { profileId } : {}),
      name,
      sourcePath,
      accessRef: accessRef === undefined ? undefined : accessRef as string | null,
      enabled,
      recursive,
      config: config.value,
    },
  };
}

export function validateBatchJob(value: unknown): BatchValidationResult<BatchJob> {
  if (!isPlainObject(value)) return fail('VALIDATION_FAILED', 'Batch job must be an object.');
  const versionError = validateSchemaVersion(value.schemaVersion, 'job.schemaVersion');
  if (versionError) return versionError;
  const jobId = stringValue(value.jobId);
  const profileId = stringValue(value.profileId);
  const sourcePath = stringValue(value.sourcePath);
  const outputPathValue = value.outputPath === null || value.outputPath === undefined
    ? null
    : stringValue(value.outputPath);
  const outputPath: string | null = outputPathValue;
  const state = value.state;
  const phase = value.phase;
  const attempt = integerValue(value.attempt);
  const maxAttempts = integerValue(value.maxAttempts);
  const progress = finiteNumber(value.progress);
  const lastErrorValue = value.lastError === null || value.lastError === undefined
    ? null
    : stringValue(value.lastError);
  const lastError: string | null = lastErrorValue;
  const createdAt = isoTimestamp(value.createdAt);
  const updatedAt = isoTimestamp(value.updatedAt);
  const startedAtValue = value.startedAt === null || value.startedAt === undefined
    ? null
    : isoTimestamp(value.startedAt);
  const startedAt: string | null = startedAtValue;
  const completedAtValue = value.completedAt === null || value.completedAt === undefined
    ? null
    : isoTimestamp(value.completedAt);
  const completedAt: string | null = completedAtValue;
  if (!jobId) return fail('VALIDATION_FAILED', 'job.jobId is required.');
  if (!profileId) return fail('VALIDATION_FAILED', 'job.profileId is required.');
  if (!sourcePath) return fail('VALIDATION_FAILED', 'job.sourcePath is required.');
  if (value.outputPath !== null && value.outputPath !== undefined && !outputPathValue) {
    return fail('VALIDATION_FAILED', 'job.outputPath must be a non-empty string or null.');
  }
  if (!(BATCH_JOB_STATES as readonly unknown[]).includes(state)) {
    return fail('VALIDATION_FAILED', 'job.state is not a supported batch state.');
  }
  if (!(BATCH_JOB_PHASES as readonly unknown[]).includes(phase)) {
    return fail('VALIDATION_FAILED', 'job.phase is not a supported batch phase.');
  }
  if (attempt === undefined || attempt < 0) return fail('VALIDATION_FAILED', 'job.attempt must be a non-negative integer.');
  if (maxAttempts === undefined || maxAttempts < 1) return fail('VALIDATION_FAILED', 'job.maxAttempts must be a positive integer.');
  if (progress === undefined || progress < 0 || progress > 1) return fail('VALIDATION_FAILED', 'job.progress must be between 0 and 1.');
  if (value.lastError !== null && value.lastError !== undefined && !lastErrorValue) {
    return fail('VALIDATION_FAILED', 'job.lastError must be a non-empty string or null.');
  }
  if (!createdAt || !updatedAt) return fail('VALIDATION_FAILED', 'job timestamps must be ISO strings.');
  if (value.startedAt !== null && value.startedAt !== undefined && !startedAtValue) {
    return fail('VALIDATION_FAILED', 'job.startedAt must be an ISO string or null.');
  }
  if (value.completedAt !== null && value.completedAt !== undefined && !completedAtValue) {
    return fail('VALIDATION_FAILED', 'job.completedAt must be an ISO string or null.');
  }
  const configSnapshot = validateRecord(value.configSnapshot, 'job.configSnapshot');
  if (!configSnapshot.ok) return { ok: false, error: (configSnapshot as ValidationErr).error };
  const sourceFingerprint = validateFingerprint(value.sourceFingerprint, 'job.sourceFingerprint');
  if (!sourceFingerprint.ok) return { ok: false, error: (sourceFingerprint as ValidationErr).error };
  const outputFingerprintValue = value.outputFingerprint === null || value.outputFingerprint === undefined
    ? null
    : stringValue(value.outputFingerprint);
  const outputFingerprint: string | null = outputFingerprintValue;
  if (value.outputFingerprint !== null && value.outputFingerprint !== undefined && !outputFingerprintValue) {
    return fail('VALIDATION_FAILED', 'job.outputFingerprint must be a non-empty string or null.');
  }
  return {
    ok: true,
    value: {
      schemaVersion: BATCH_SCHEMA_VERSION,
      jobId,
      profileId,
      sourcePath,
      outputPath,
      state: state as BatchJobState,
      phase: phase as BatchJobPhase,
      attempt,
      maxAttempts,
      progress,
      configSnapshot: configSnapshot.value,
      sourceFingerprint: sourceFingerprint.value,
      outputFingerprint,
      lastError,
      createdAt,
      updatedAt,
      startedAt,
      completedAt,
    },
  };
}

export function isBatchJob(value: unknown): value is BatchJob {
  return validateBatchJob(value).ok;
}

export function validateBatchJobInput(value: unknown): BatchValidationResult<BatchJobInput> {
  if (!isPlainObject(value)) return fail('VALIDATION_FAILED', 'Batch job input must be an object.');
  const jobId = value.jobId === undefined ? undefined : stringValue(value.jobId);
  const profileId = stringValue(value.profileId);
  const sourcePath = stringValue(value.sourcePath);
  const outputPath = value.outputPath === null || value.outputPath === undefined
    ? value.outputPath
    : stringValue(value.outputPath);
  const maxAttempts = value.maxAttempts === undefined ? 3 : integerValue(value.maxAttempts);
  if (value.jobId !== undefined && !jobId) return fail('VALIDATION_FAILED', 'job.jobId must be a non-empty string.');
  if (!profileId) return fail('VALIDATION_FAILED', 'job.profileId is required.');
  if (!sourcePath) return fail('VALIDATION_FAILED', 'job.sourcePath is required.');
  if (value.outputPath !== undefined && value.outputPath !== null && !outputPath) {
    return fail('VALIDATION_FAILED', 'job.outputPath must be a non-empty string or null.');
  }
  if (maxAttempts === undefined || maxAttempts < 1) return fail('VALIDATION_FAILED', 'job.maxAttempts must be a positive integer.');
  const configSnapshot = value.configSnapshot === undefined
    ? { ok: true as const, value: {} }
    : validateRecord(value.configSnapshot, 'job.configSnapshot');
  if (!configSnapshot.ok) return { ok: false, error: (configSnapshot as ValidationErr).error };
  const sourceFingerprint = validateFingerprint(value.sourceFingerprint, 'job.sourceFingerprint');
  if (!sourceFingerprint.ok) return { ok: false, error: (sourceFingerprint as ValidationErr).error };
  return {
    ok: true,
    value: {
      ...(jobId ? { jobId } : {}),
      profileId,
      sourcePath,
      outputPath: outputPath === undefined ? undefined : outputPath as string | null,
      maxAttempts,
      configSnapshot: configSnapshot.value,
      sourceFingerprint: sourceFingerprint.value,
    },
  };
}

export function validateBatchCheckpoint(value: unknown): BatchValidationResult<BatchCheckpoint> {
  if (!isPlainObject(value)) return fail('VALIDATION_FAILED', 'Batch checkpoint must be an object.');
  const versionError = validateSchemaVersion(value.schemaVersion, 'checkpoint.schemaVersion');
  if (versionError) return versionError;
  const jobId = stringValue(value.jobId);
  const checkpointKey = stringValue(value.checkpointKey);
  const token = stringValue(value.token);
  const createdAt = isoTimestamp(value.createdAt);
  const updatedAt = isoTimestamp(value.updatedAt);
  if (!jobId) return fail('VALIDATION_FAILED', 'checkpoint.jobId is required.');
  if (!checkpointKey) return fail('VALIDATION_FAILED', 'checkpoint.checkpointKey is required.');
  if (!token) return fail('VALIDATION_FAILED', 'checkpoint.token is required.');
  if (!createdAt || !updatedAt) return fail('VALIDATION_FAILED', 'checkpoint timestamps must be ISO strings.');
  const metadata = validateRecord(value.metadata, 'checkpoint.metadata');
  if (!metadata.ok) return { ok: false, error: (metadata as ValidationErr).error };
  return {
    ok: true,
    value: {
      schemaVersion: BATCH_SCHEMA_VERSION,
      jobId,
      checkpointKey,
      token,
      metadata: metadata.value,
      createdAt,
      updatedAt,
    },
  };
}

export function isBatchCheckpoint(value: unknown): value is BatchCheckpoint {
  return validateBatchCheckpoint(value).ok;
}

export function validateBatchCheckpointInput(value: unknown): BatchValidationResult<BatchCheckpointInput> {
  if (!isPlainObject(value)) return fail('VALIDATION_FAILED', 'Batch checkpoint input must be an object.');
  const checkpointKey = stringValue(value.checkpointKey);
  const token = stringValue(value.token);
  if (!checkpointKey) return fail('VALIDATION_FAILED', 'checkpoint.checkpointKey is required.');
  if (!token) return fail('VALIDATION_FAILED', 'checkpoint.token is required.');
  const metadata = value.metadata === undefined ? { ok: true as const, value: {} } : validateRecord(value.metadata, 'checkpoint.metadata');
  if (!metadata.ok) return { ok: false, error: (metadata as ValidationErr).error };
  return { ok: true, value: { checkpointKey, token, metadata: metadata.value } };
}
export function validateBatchEventInput(value: unknown): BatchValidationResult<BatchEventInput> {
  if (!isPlainObject(value)) return fail('VALIDATION_FAILED', 'Batch event input must be an object.');
  const eventType = stringValue(value.eventType);
  if (!eventType) return fail('VALIDATION_FAILED', 'event.eventType is required.');
  const payload = value.payload === undefined ? { ok: true as const, value: {} } : validateRecord(value.payload, 'event.payload');
  if (!payload.ok) return { ok: false, error: (payload as ValidationErr).error };
  return { ok: true, value: { eventType, payload: payload.value } };
}


export function validateBatchEvent(value: unknown): BatchValidationResult<BatchEvent> {
  if (!isPlainObject(value)) return fail('VALIDATION_FAILED', 'Batch event must be an object.');
  const versionError = validateSchemaVersion(value.schemaVersion, 'event.schemaVersion');
  if (versionError) return versionError;
  const eventId = integerValue(value.eventId);
  const jobId = stringValue(value.jobId);
  const eventType = stringValue(value.eventType);
  const createdAt = isoTimestamp(value.createdAt);
  if (eventId === undefined || eventId < 1) return fail('VALIDATION_FAILED', 'event.eventId must be a positive integer.');
  if (!jobId) return fail('VALIDATION_FAILED', 'event.jobId is required.');
  if (!eventType) return fail('VALIDATION_FAILED', 'event.eventType is required.');
  if (!createdAt) return fail('VALIDATION_FAILED', 'event.createdAt must be an ISO string.');
  const payload = validateRecord(value.payload, 'event.payload');
  if (!payload.ok) return { ok: false, error: (payload as ValidationErr).error };
  return {
    ok: true,
    value: { schemaVersion: BATCH_SCHEMA_VERSION, eventId, jobId, eventType, payload: payload.value, createdAt },
  };
}

export function isBatchEvent(value: unknown): value is BatchEvent {
  return validateBatchEvent(value).ok;
}