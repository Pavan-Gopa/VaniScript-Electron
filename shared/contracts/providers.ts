// Main-process provider routing contract (PRV-01).
//
// This module is the single source of truth for:
//   1. The IPC command string the Renderer uses to reach the Main-process
//      provider router (`provider:invoke`).
//   2. The request/result shapes exchanged across the bridge.
//
// Main performs the actual HTTP calls and injects API keys from the vault, so
// the Renderer never sees a secret. Errors cross the bridge as a structured
// AppError-shaped envelope (see `shared/contracts/errors.ts`).

/** IPC channel used for provider invocations from the Renderer. */
export const PROVIDER_INVOKE_COMMAND = 'provider:invoke';

/** Capability a provider invocation is meant to satisfy. */
export type ProviderPurpose =
  | 'text'
  | 'chat'
  | 'translation'
  | 'transcription'
  | 'vision';

/** A single chat-style message. */
export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Request the Renderer sends to the Main-process provider router.
 *
 * The Renderer MUST NOT include any API key here — Main resolves the key from
 * the credential vault using the provider's `keyRef` setting.
 */
export interface ProviderInvokeRequest {
  /** Catalog id, e.g. `gemini`, `openai`, `anthropic`, `qwen`, `openrouter`, `ollama`. */
  providerId: string;
  /** What the call is for; selects the model when `modelId` is omitted. */
  purpose?: ProviderPurpose;
  /** Explicit model override; otherwise resolved from provider settings by purpose. */
  modelId?: string;
  /** Plain prompt; convenience for a single user turn. */
  prompt?: string;
  /** Full chat transcript; preferred over `prompt` when present. */
  messages?: ProviderMessage[];
  /** Provider-agnostic extras (temperature, max_tokens, system, etc.). */
  params?: Record<string, unknown>;
  /**
   * Optional base URL override. Only honored for self-hostable providers
   * (e.g. `ollama`); ignored for cloud providers to prevent key exfiltration
   * via host substitution.
   */
  baseUrl?: string;
}

/** Normalized token usage, provider-agnostic. */
export interface ProviderUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** What Main returns to the Renderer after proxying the provider response. */
export interface ProviderInvokeResult {
  providerId: string;
  /** The model that actually served the request. */
  model: string;
  purpose?: ProviderPurpose;
  /** The provider's raw payload (no secrets). */
  data: unknown;
  usage?: ProviderUsage;
}
