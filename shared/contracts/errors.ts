/**
 * Standard application error model shared across the Electron Main and
 * Renderer processes (VaniScript Electron Migration Plan §4.3 — Typed IPC).
 *
 * These error codes and the `AppError` shape are the canonical failure
 * vocabulary carried inside `ResultEnvelope` across the process boundary.
 * Runtime validators (`isAppError`, `validateAppError`) let both sides
 * enforce the same contract without a third-party schema dependency.
 */

/** Canonical error codes shared by every typed IPC response. */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'CANCELLED',
  'PERMISSION_DENIED',
  'CAPABILITY_UNAVAILABLE',
  'PROVIDER_ERROR',
  'MODEL_UNAVAILABLE',
  'SOURCE_CHANGED',
  'OUTPUT_COLLISION',
  'UPDATE_BLOCKED',
  'CORRUPT_DATA',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Plain, serializable shape of an application error. */
export interface AppErrorShape {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

/**
 * Carryable application error. Extends the native `Error` so it integrates
 * with normal `try/catch`/stack-trace tooling while carrying a structured
 * `code` that the IPC layer can switch on.
 */
export class AppError extends Error implements AppErrorShape {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
    // Restore the prototype chain for `instanceof` under ES5/CommonJS transpilation.
    Object.setPrototypeOf(this, AppError.prototype);
  }

  /** Serializable projection used when crossing the IPC boundary. */
  toJSON(): AppErrorShape {
    const out: any = { code: this.code, message: this.message };
    if (this.details !== undefined) out.details = this.details;
    return out as AppErrorShape;
  }
}

/** Convenience constructor. */
export function createAppError(
  code: ErrorCode,
  message: string,
  details?: unknown,
): AppError {
  return new AppError(code, message, details);
}

/** Type guard for the known error code strings. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return (
    typeof value === 'string' &&
    (ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * True for a genuine `AppError` instance or any structurally compatible
 * object (valid `code` + string `message`). Structural acceptance lets a
 * deserialized error that lost its prototype still validate.
 */
export function isAppError(value: unknown): value is AppError {
  if (value instanceof AppError) return true;
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return isErrorCode(v['code']) && typeof v['message'] === 'string';
}

export type ValidationResult =
  | { ok: true; value: AppError }
  | { ok: false; error: string };

/**
 * Runtime validation of an unknown value as an `AppError`. Returns a
 * discriminated result and, on success, a normalized `AppError` instance so
 * callers always receive a real `AppError` rather than a bare object.
 */
export function validateAppError(value: unknown): ValidationResult {
  if (value instanceof AppError) return { ok: true, value };
  if (typeof value !== 'object' || value === null) {
    return { ok: false, error: 'AppError must be an object' };
  }
  const v = value as Record<string, unknown>;
  if (!isErrorCode(v['code'])) {
    return {
      ok: false,
      error: `AppError.code must be one of the known error codes, received: ${String(v['code'])}`,
    };
  }
  if (typeof v['message'] !== 'string') {
    return { ok: false, error: 'AppError.message must be a string' };
  }
  return {
    ok: true,
    value: new AppError(v['code'] as ErrorCode, v['message'], v['details']),
  };
}
