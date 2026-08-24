/**
 * Standard application error model shared across the Electron Main and
 * Renderer processes (VaniScript Electron Migration Plan §4.3 — Typed IPC).
 *
 * These error codes and the `AppError` shape are the canonical failure
 * vocabulary carried inside `ResultEnvelope` across the process boundary.
 * Runtime validators (`isAppError`, `validateAppError`) let both sides
 * enforce the same contract without a third-party schema dependency.
 *
 * Typed façade: the public TypeScript types and every runtime value are
 * declared once in `errors-runtime.js` / `errors-runtime.d.ts`
 * (plain CommonJS, loadable by the Electron main process without TypeScript
 * support) and re-exported here unchanged. No runtime logic lives in this file.
 */

export {
  ERROR_CODES,
  AppError,
  createAppError,
  isErrorCode,
  isAppError,
  validateAppError,
} from './errors-runtime.js';

export type {
  ErrorCode,
  AppErrorShape,
  ValidationResult,
} from './errors-runtime.js';
