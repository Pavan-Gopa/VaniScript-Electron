/**
 * Type declarations for `providers-runtime.js` — the CommonJS runtime behind
 * the `providers.ts` façade. Request/result shapes remain declared in the
 * façade; only runtime values live here.
 */

/** IPC channel used for provider invocations from the Renderer. */
export declare const PROVIDER_INVOKE_COMMAND: 'provider:invoke';
