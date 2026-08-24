/**
 * Runtime implementation of the shared error model (errors.ts façade).
 *
 * Plain JavaScript with no TypeScript syntax so the Electron main process can
 * load it directly under the bundled Node runtime without any TypeScript
 * loader. Note: this directory's package.json declares `"type": "module"`,
 * so `.js` here is an ES module; Node >= 20.19 loads it synchronously through
 * `require()` via built-in require(esm), and the `.ts` façade re-exports every
 * value below. This module is the single runtime source.
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
  'TAMPERED',
  'INTERNAL',
];

/**
 * Carryable application error. Extends the native `Error` so it integrates
 * with normal `try/catch`/stack-trace tooling while carrying a structured
 * `code` that the IPC layer can switch on.
 */
export class AppError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
    // Restore the prototype chain for `instanceof` under ES5/CommonJS transpilation.
    Object.setPrototypeOf(this, AppError.prototype);
  }

  /** Serializable projection used when crossing the IPC boundary. */
  toJSON() {
    const out = { code: this.code, message: this.message };
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

/** Convenience constructor. */
export function createAppError(code, message, details) {
  return new AppError(code, message, details);
}

/** Type guard for the known error code strings. */
export function isErrorCode(value) {
  return (
    typeof value === 'string' &&
    ERROR_CODES.includes(value)
  );
}

/**
 * True for a genuine `AppError` instance or any structurally compatible
 * object (valid `code` + string `message`). Structural acceptance lets a
 * deserialized error that lost its prototype still validate.
 */
export function isAppError(value) {
  if (value instanceof AppError) return true;
  if (typeof value !== 'object' || value === null) return false;
  const v = value;
  return isErrorCode(v['code']) && typeof v['message'] === 'string';
}

/**
 * Runtime validation of an unknown value as an `AppError`. Returns a
 * discriminated result and, on success, a normalized `AppError` instance so
 * callers always receive a real `AppError` rather than a bare object.
 */
export function validateAppError(value) {
  if (value instanceof AppError) return { ok: true, value };
  if (typeof value !== 'object' || value === null) {
    return { ok: false, error: 'AppError must be an object' };
  }
  const v = value;
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
    value: new AppError(v['code'], v['message'], v['details']),
  };
}
