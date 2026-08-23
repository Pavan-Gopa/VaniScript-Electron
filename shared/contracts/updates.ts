/**
 * Shared Update domain contract (UPD-01).
 *
 * Canonical descriptor, state-machine, readiness-blocker, quit-prep, and
 * receipt shapes for the Main-process update service.  Validators are
 * dependency-free apart from the shared error taxonomy so a malformed feed
 * payload or persisted receipt is rejected before it reaches the store.
 *
 * Platform adapters (UPD-02) and Settings/UI (UPD-03) consume these types;
 * this module does not talk to the network or electron-updater.
 */

import { AppError, createAppError, type ErrorCode } from './errors.ts';

/** Version of the serialized Update domain shapes. */
export const UPDATE_SCHEMA_VERSION = 1 as const;
export type UpdateSchemaVersion = typeof UPDATE_SCHEMA_VERSION;

/** Renderer-facing IPC methods reserved for the Updates Settings surface. */
export const UPDATE_COMMANDS = Object.freeze({
  getState: 'updates:state',
  checkNow: 'updates:check',
  downloadNow: 'updates:download',
  installNow: 'updates:install',
  skipVersion: 'updates:skip',
  remindLater: 'updates:remind',
  cancelDownload: 'updates:cancel-download',
  retry: 'updates:retry',
  collectBlockers: 'updates:blockers',
  prepareForTermination: 'updates:prepare-termination',
} as const);

export type UpdateCommand = (typeof UPDATE_COMMANDS)[keyof typeof UPDATE_COMMANDS];

/**
 * Canonical lifecycle from migration plan §12.1.
 * `verifying` is the post-download integrity/check state (assignment "download-check").
 * `readyToInstall` is the explicit-action gate before install ("ready").
 */
export const UPDATE_STATES = [
  'idle',
  'checking',
  'upToDate',
  'available',
  'downloading',
  'verifying',
  'readyToInstall',
  'installing',
  'failed',
] as const;
export type UpdateStateName = (typeof UPDATE_STATES)[number];

export const UPDATE_USER_ACTIONS = [
  'checkNow',
  'downloadNow',
  'installNow',
  'skipVersion',
  'remindLater',
  'cancelDownload',
  'retry',
] as const;
export type UpdateUserAction = (typeof UPDATE_USER_ACTIONS)[number];

export const UPDATE_CHANNELS = ['stable', 'beta'] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export const UPDATE_RECEIPT_OUTCOMES = ['success', 'failed'] as const;
export type UpdateReceiptOutcome = (typeof UPDATE_RECEIPT_OUTCOMES)[number];

export const UPDATE_QUIT_SUBSYSTEMS = ['settings', 'projects', 'sqlite', 'recovery'] as const;
export type UpdateQuitSubsystem = (typeof UPDATE_QUIT_SUBSYSTEMS)[number];

export const UPDATE_QUIT_OUTCOMES = ['ok', 'failed', 'timeout', 'skipped'] as const;
export type UpdateQuitOutcome = (typeof UPDATE_QUIT_OUTCOMES)[number];

/**
 * §12.3 readiness categories.  Each maps to one injected domain probe.
 * Finer-grained aliases (preview vs save, transcript vs document translation)
 * collapse onto these plan bullets at the service boundary.
 */
export const UPDATE_BLOCKER_CATEGORIES = [
  'recording',
  'recordingPreviewSave',
  'mediaProcessing',
  'translation',
  'shortsRenderPlanning',
  'batchCurrentJob',
  'documentRecovery',
  'projectSaveFailure',
  'modelMutation',
] as const;
export type UpdateBlockerCategory = (typeof UPDATE_BLOCKER_CATEGORIES)[number];

export const UPDATE_BLOCKER_MESSAGES: Record<UpdateBlockerCategory, string> = {
  recording: 'Microphone or system recording is in progress.',
  recordingPreviewSave: 'Recording preview or save is in progress.',
  mediaProcessing: 'Media segment processing is in progress.',
  translation: 'Transcript, document, or shorts translation is running.',
  shortsRenderPlanning: 'Shorts render or planning is in progress.',
  batchCurrentJob: 'A batch job is currently running.',
  documentRecovery: 'Document autosave or recovery journal is pending.',
  projectSaveFailure: 'Project save failed and must be resolved before updating.',
  modelMutation: 'Model download or relocation is unsafe to interrupt.',
};

/** Legal destination states from each source state (internal + user-driven). */
export const ALLOWED_UPDATE_TRANSITIONS: Record<UpdateStateName, readonly UpdateStateName[]> = {
  idle: ['checking'],
  checking: ['upToDate', 'available', 'failed', 'idle'],
  upToDate: ['checking'],
  available: ['checking', 'downloading', 'idle'],
  downloading: ['verifying', 'available', 'failed'],
  verifying: ['readyToInstall', 'failed'],
  readyToInstall: ['installing', 'idle', 'checking'],
  installing: ['idle', 'failed'],
  failed: ['checking', 'available', 'readyToInstall', 'idle'],
};

/** States from which each explicit user action may be invoked. */
export const UPDATE_ACTIONS_ALLOWED_FROM: Record<UpdateUserAction, readonly UpdateStateName[]> = {
  checkNow: ['idle', 'upToDate', 'available', 'readyToInstall', 'failed'],
  downloadNow: ['available'],
  installNow: ['readyToInstall'],
  skipVersion: ['available', 'readyToInstall'],
  remindLater: ['available', 'readyToInstall'],
  cancelDownload: ['downloading'],
  retry: ['failed'],
};

export interface UpdateDescriptor {
  schemaVersion: UpdateSchemaVersion;
  version: string;
  build: string;
  title: string;
  notes: string;
  critical: boolean;
  informational: boolean;
  publishDate: string | null;
  sizeBytes: number;
  infoUrl: string | null;
  platform: string;
  arch: string;
  channel: UpdateChannel;
  /** Optional artifact digest reserved for UPD-02 signature/hash verification. */
  artifactHash: string | null;
  /** Optional feed signature reserved for UPD-02 tamper rejection. */
  feedSignature: string | null;
}

export interface UpdateFeedDocument {
  schemaVersion: UpdateSchemaVersion;
  channel: UpdateChannel | null;
  updates: UpdateDescriptor[];
  /** Opaque signature over the feed document; verified by UPD-02. */
  signature: string | null;
}

export interface UpdateFeedQuery {
  currentVersion: string;
  currentBuild: string;
  channel: UpdateChannel;
  platform: string;
  arch: string;
}

export interface UpdateDownloadProgress {
  receivedBytes: number;
  totalBytes: number;
  fraction: number;
}

export interface UpdatePresentation {
  /** Critical updates change emphasis only; they never bypass readiness. */
  emphasis: 'standard' | 'informational' | 'critical';
  critical: boolean;
  informational: boolean;
  /** Hard policy: automatic download/install is forbidden by default. */
  autoDownload: false;
  autoInstall: false;
  showSkip: boolean;
  showRemind: boolean;
}

export interface UpdateErrorShape {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export interface UpdateStateSnapshot {
  schemaVersion: UpdateSchemaVersion;
  state: UpdateStateName;
  currentVersion: string;
  currentBuild: string;
  channel: UpdateChannel;
  platform: string;
  arch: string;
  descriptor: UpdateDescriptor | null;
  lastCheckedAt: string | null;
  download: UpdateDownloadProgress | null;
  error: UpdateErrorShape | null;
  skippedVersion: string | null;
  remindLaterUntil: string | null;
  lastAction: UpdateUserAction | null;
  presentation: UpdatePresentation;
}

export interface UpdateBlocker {
  category: UpdateBlockerCategory;
  message: string;
  details?: unknown;
}

export interface UpdateReceipt {
  schemaVersion: UpdateSchemaVersion;
  fromVersion: string;
  toVersion: string;
  fromBuild: string;
  toBuild: string;
  timestamp: string;
  channel: UpdateChannel;
  outcome: UpdateReceiptOutcome;
  artifactHash: string | null;
}

export interface UpdateQuitPreparationResult {
  schemaVersion: UpdateSchemaVersion;
  ready: boolean;
  timedOut: boolean;
  timeoutMs: number;
  outcomes: Record<UpdateQuitSubsystem, UpdateQuitOutcome>;
  errors: Partial<Record<UpdateQuitSubsystem, string>>;
}

type ValidationOk<T> = { ok: true; value: T };
type ValidationErr = { ok: false; error: AppError };
export type UpdateValidationResult<T> = ValidationOk<T> | ValidationErr;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? value : undefined;
}

function fail(code: ErrorCode, message: string, details?: unknown): ValidationErr {
  return { ok: false, error: createAppError(code, message, details) };
}

export function isUpdateState(value: unknown): value is UpdateStateName {
  return typeof value === 'string' && (UPDATE_STATES as readonly string[]).includes(value);
}

export function isUpdateUserAction(value: unknown): value is UpdateUserAction {
  return typeof value === 'string' && (UPDATE_USER_ACTIONS as readonly string[]).includes(value);
}

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return typeof value === 'string' && (UPDATE_CHANNELS as readonly string[]).includes(value);
}

export function isUpdateBlockerCategory(value: unknown): value is UpdateBlockerCategory {
  return typeof value === 'string' && (UPDATE_BLOCKER_CATEGORIES as readonly string[]).includes(value);
}

export function isLegalUpdateTransition(from: unknown, to: unknown): boolean {
  if (!isUpdateState(from) || !isUpdateState(to)) return false;
  return ALLOWED_UPDATE_TRANSITIONS[from].includes(to);
}

export function isLegalUpdateAction(state: unknown, action: unknown): boolean {
  if (!isUpdateState(state) || !isUpdateUserAction(action)) return false;
  return UPDATE_ACTIONS_ALLOWED_FROM[action].includes(state);
}

export function createUpdatePresentation(
  descriptor: UpdateDescriptor | null,
): UpdatePresentation {
  const critical = Boolean(descriptor && descriptor.critical);
  const informational = Boolean(descriptor && descriptor.informational && !critical);
  return {
    emphasis: critical ? 'critical' : informational ? 'informational' : 'standard',
    critical,
    informational,
    autoDownload: false,
    autoInstall: false,
    showSkip: true,
    showRemind: true,
  };
}

export function createUpdateDescriptor(
  input: Partial<UpdateDescriptor> & Pick<UpdateDescriptor, 'version'>,
): UpdateDescriptor {
  const channel = isUpdateChannel(input.channel) ? input.channel : 'stable';
  return {
    schemaVersion: UPDATE_SCHEMA_VERSION,
    version: input.version,
    build: typeof input.build === 'string' && input.build.length > 0 ? input.build : input.version,
    title: typeof input.title === 'string' ? input.title : '',
    notes: typeof input.notes === 'string' ? input.notes : '',
    critical: Boolean(input.critical),
    informational: Boolean(input.informational),
    publishDate: typeof input.publishDate === 'string' ? input.publishDate : null,
    sizeBytes: typeof input.sizeBytes === 'number' && Number.isFinite(input.sizeBytes) ? input.sizeBytes : 0,
    infoUrl: typeof input.infoUrl === 'string' && input.infoUrl.length > 0 ? input.infoUrl : null,
    platform: typeof input.platform === 'string' && input.platform.length > 0 ? input.platform : 'darwin',
    arch: typeof input.arch === 'string' && input.arch.length > 0 ? input.arch : 'arm64',
    channel,
    artifactHash: typeof input.artifactHash === 'string' && input.artifactHash.length > 0
      ? input.artifactHash
      : null,
    feedSignature: typeof input.feedSignature === 'string' && input.feedSignature.length > 0
      ? input.feedSignature
      : null,
  };
}

export function validateUpdateDescriptor(value: unknown): UpdateValidationResult<UpdateDescriptor> {
  if (!isPlainObject(value)) return fail('VALIDATION_FAILED', 'Update descriptor must be an object.');
  const schemaVersion = value.schemaVersion === undefined ? UPDATE_SCHEMA_VERSION : value.schemaVersion;
  if (schemaVersion !== UPDATE_SCHEMA_VERSION) {
    return fail('VALIDATION_FAILED', `descriptor.schemaVersion must be ${UPDATE_SCHEMA_VERSION}.`);
  }
  const version = stringValue(value.version);
  if (!version) return fail('VALIDATION_FAILED', 'descriptor.version is required.');
  const build = stringValue(value.build) || version;
  if (!isUpdateChannel(value.channel) && value.channel !== undefined) {
    return fail('VALIDATION_FAILED', 'descriptor.channel must be "stable" or "beta".');
  }
  const channel = isUpdateChannel(value.channel) ? value.channel : 'stable';
  const sizeBytes = value.sizeBytes === undefined ? 0 : finiteNumber(value.sizeBytes);
  if (sizeBytes === undefined || sizeBytes < 0) {
    return fail('VALIDATION_FAILED', 'descriptor.sizeBytes must be a non-negative number.');
  }
  if (value.critical !== undefined && typeof value.critical !== 'boolean') {
    return fail('VALIDATION_FAILED', 'descriptor.critical must be boolean.');
  }
  if (value.informational !== undefined && typeof value.informational !== 'boolean') {
    return fail('VALIDATION_FAILED', 'descriptor.informational must be boolean.');
  }
  const publishDate = value.publishDate === null || value.publishDate === undefined
    ? null
    : isoTimestamp(value.publishDate);
  if (value.publishDate !== null && value.publishDate !== undefined && !publishDate) {
    return fail('VALIDATION_FAILED', 'descriptor.publishDate must be an ISO timestamp or null.');
  }
  const infoUrl = value.infoUrl === null || value.infoUrl === undefined
    ? null
    : stringValue(value.infoUrl);
  if (value.infoUrl !== null && value.infoUrl !== undefined && !infoUrl) {
    return fail('VALIDATION_FAILED', 'descriptor.infoUrl must be a non-empty string or null.');
  }
  const platform = stringValue(value.platform) || 'darwin';
  const arch = stringValue(value.arch) || 'arm64';
  const artifactHash = value.artifactHash === null || value.artifactHash === undefined
    ? null
    : stringValue(value.artifactHash);
  if (value.artifactHash !== null && value.artifactHash !== undefined && !artifactHash) {
    return fail('VALIDATION_FAILED', 'descriptor.artifactHash must be a non-empty string or null.');
  }
  const feedSignature = value.feedSignature === null || value.feedSignature === undefined
    ? null
    : stringValue(value.feedSignature);
  if (value.feedSignature !== null && value.feedSignature !== undefined && !feedSignature) {
    return fail('VALIDATION_FAILED', 'descriptor.feedSignature must be a non-empty string or null.');
  }
  return {
    ok: true,
    value: {
      schemaVersion: UPDATE_SCHEMA_VERSION,
      version,
      build,
      title: typeof value.title === 'string' ? value.title : '',
      notes: typeof value.notes === 'string' ? value.notes : '',
      critical: Boolean(value.critical),
      informational: Boolean(value.informational),
      publishDate: publishDate ?? null,
      sizeBytes,
      infoUrl: infoUrl ?? null,
      platform,
      arch,
      channel,
      artifactHash: artifactHash ?? null,
      feedSignature: feedSignature ?? null,
    },
  };
}

export function isUpdateDescriptor(value: unknown): value is UpdateDescriptor {
  return validateUpdateDescriptor(value).ok;
}

export function validateUpdateFeed(value: unknown): UpdateValidationResult<UpdateFeedDocument> {
  if (!isPlainObject(value)) return fail('CORRUPT_DATA', 'Update feed must be an object.');
  const schemaVersion = value.schemaVersion === undefined ? UPDATE_SCHEMA_VERSION : value.schemaVersion;
  if (schemaVersion !== UPDATE_SCHEMA_VERSION) {
    return fail('CORRUPT_DATA', `feed.schemaVersion must be ${UPDATE_SCHEMA_VERSION}.`);
  }
  if (value.channel !== null && value.channel !== undefined && !isUpdateChannel(value.channel)) {
    return fail('CORRUPT_DATA', 'feed.channel must be "stable", "beta", or null.');
  }
  if (!Array.isArray(value.updates)) {
    return fail('CORRUPT_DATA', 'feed.updates must be an array.');
  }
  const updates: UpdateDescriptor[] = [];
  for (let index = 0; index < value.updates.length; index += 1) {
    const result = validateUpdateDescriptor(value.updates[index]);
    if (!result.ok) {
      return fail('CORRUPT_DATA', `feed.updates[${index}] is invalid.`, { cause: result.error.message });
    }
    updates.push(result.value);
  }
  const signature = value.signature === null || value.signature === undefined
    ? null
    : stringValue(value.signature);
  if (value.signature !== null && value.signature !== undefined && !signature) {
    return fail('CORRUPT_DATA', 'feed.signature must be a non-empty string or null.');
  }
  return {
    ok: true,
    value: {
      schemaVersion: UPDATE_SCHEMA_VERSION,
      channel: isUpdateChannel(value.channel) ? value.channel : null,
      updates,
      signature: signature ?? null,
    },
  };
}

export function validateUpdateBlocker(value: unknown): UpdateValidationResult<UpdateBlocker> {
  if (!isPlainObject(value)) return fail('VALIDATION_FAILED', 'Update blocker must be an object.');
  if (!isUpdateBlockerCategory(value.category)) {
    return fail('VALIDATION_FAILED', 'blocker.category is not a known readiness category.');
  }
  const message = stringValue(value.message) || UPDATE_BLOCKER_MESSAGES[value.category];
  const blocker: UpdateBlocker = { category: value.category, message };
  if (value.details !== undefined) blocker.details = value.details;
  return { ok: true, value: blocker };
}

export function validateUpdateReceipt(value: unknown): UpdateValidationResult<UpdateReceipt> {
  if (!isPlainObject(value)) return fail('VALIDATION_FAILED', 'Update receipt must be an object.');
  if (value.schemaVersion !== UPDATE_SCHEMA_VERSION) {
    return fail('VALIDATION_FAILED', `receipt.schemaVersion must be ${UPDATE_SCHEMA_VERSION}.`);
  }
  const fromVersion = stringValue(value.fromVersion);
  const toVersion = stringValue(value.toVersion);
  const fromBuild = stringValue(value.fromBuild);
  const toBuild = stringValue(value.toBuild);
  const timestamp = isoTimestamp(value.timestamp);
  if (!fromVersion) return fail('VALIDATION_FAILED', 'receipt.fromVersion is required.');
  if (!toVersion) return fail('VALIDATION_FAILED', 'receipt.toVersion is required.');
  if (!fromBuild) return fail('VALIDATION_FAILED', 'receipt.fromBuild is required.');
  if (!toBuild) return fail('VALIDATION_FAILED', 'receipt.toBuild is required.');
  if (!timestamp) return fail('VALIDATION_FAILED', 'receipt.timestamp must be an ISO timestamp.');
  if (!isUpdateChannel(value.channel)) {
    return fail('VALIDATION_FAILED', 'receipt.channel must be "stable" or "beta".');
  }
  if (value.outcome !== 'success' && value.outcome !== 'failed') {
    return fail('VALIDATION_FAILED', 'receipt.outcome must be "success" or "failed".');
  }
  const artifactHash = value.artifactHash === null || value.artifactHash === undefined
    ? null
    : stringValue(value.artifactHash);
  if (value.artifactHash !== null && value.artifactHash !== undefined && !artifactHash) {
    return fail('VALIDATION_FAILED', 'receipt.artifactHash must be a non-empty string or null.');
  }
  return {
    ok: true,
    value: {
      schemaVersion: UPDATE_SCHEMA_VERSION,
      fromVersion,
      toVersion,
      fromBuild,
      toBuild,
      timestamp,
      channel: value.channel,
      outcome: value.outcome,
      artifactHash: artifactHash ?? null,
    },
  };
}

export function isUpdateReceipt(value: unknown): value is UpdateReceipt {
  return validateUpdateReceipt(value).ok;
}
