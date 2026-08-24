/**
 * Runtime implementation of the provider routing contract (providers.ts
 * façade). Plain JavaScript with no TypeScript syntax so the Electron main
 * process can load it directly under the bundled Node runtime without any
 * TypeScript loader. This directory's package.json declares
 * `"type": "module"`, so `.js` here is an ES module; Node >= 20.19 loads it
 * synchronously through `require()` via built-in require(esm).
 */

/** IPC channel used for provider invocations from the Renderer. */
export const PROVIDER_INVOKE_COMMAND = 'provider:invoke';
