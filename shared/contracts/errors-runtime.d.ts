/**
 * Type declarations for `errors-runtime.js` — the CommonJS runtime behind the
 * `errors.ts` façade. Self-contained by design: the canonical TypeScript
 * types live here next to the runtime implementation, and the façade simply
 * re-exports them so both entrypoints present one identical contract.
 */

/** Canonical error codes shared by every typed IPC response. */
export declare const ERROR_CODES: readonly [
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
  'TAMPERED',
  'INTERNAL',
];

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
export declare class AppError extends Error implements AppErrorShape {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown);

  /** Serializable projection used when crossing the IPC boundary. */
  toJSON(): AppErrorShape;
}

/** Convenience constructor. */
export declare function createAppError(
  code: ErrorCode,
  message: string,
  details?: unknown,
): AppError;

/** Type guard for the known error code strings. */
export declare function isErrorCode(value: unknown): value is ErrorCode;

/**
 * True for a genuine `AppError` instance or any structurally compatible
 * object (valid `code` + string `message`). Structural acceptance lets a
 * deserialized error that lost its prototype still validate.
 */
export declare function isAppError(value: unknown): value is AppError;

export type ValidationResult =
  | { ok: true; value: AppError }
  | { ok: false; error: string };

/**
 * Runtime validation of an unknown value as an `AppError`. Returns a
 * discriminated result and, on success, a normalized `AppError` instance so
 * callers always receive a real `AppError` rather than a bare object.
 */
export declare function validateAppError(value: unknown): ValidationResult;
