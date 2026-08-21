/**
 * Platform capability contract (VaniScript Electron Migration Plan §5 — CAP-01).
 *
 * A capability is reported as a structured `CapabilityStatus`, never a bare
 * boolean. When a feature is unavailable the status MUST explain *why*
 * (`reasonCode`) and *how to proceed* (`userMessage`, `remediation`) so the UI
 * can surface guidance instead of silently falling back to another backend.
 */

/** Machine-readable reason a capability is available or not. */
export type CapabilityReasonCode =
  | 'OK'
  | 'UNSUPPORTED_OS'
  | 'UNSUPPORTED_ARCH'
  | 'LOOPBACK_UNAVAILABLE'
  | 'MISSING_DEPENDENCY'
  | 'PERMISSION_REQUIRED'
  | 'DISABLED'
  | 'UNKNOWN_CAPABILITY';

/**
 * Structured availability report for a single platform feature. This is the
 * contract the renderer and workflow selectors consume — never a boolean.
 */
export interface CapabilityStatus {
  /** Whether the capability can be used on the current host. */
  readonly available: boolean;
  /** Stable code explaining the availability decision. */
  readonly reasonCode?: CapabilityReasonCode;
  /** Human-readable explanation suitable for a tooltip or disabled control. */
  readonly userMessage?: string;
  /** Actionable guidance shown when the feature is unavailable. */
  readonly remediation?: string;
  /** The concrete backend that serves the capability when available. */
  readonly backend?: string;
}

/** Stable identifiers for every probed platform capability. */
export const CAPABILITY_KEYS = [
  'coreml_asr',
  'coreml_parakeet',
  'mlx_translation',
  'llamacpp_translation',
  'whisper_cpp_asr',
  'system_audio_loopback',
  'metal_compositor',
  'microphone_capture',
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** Full capability report keyed by capability. */
export type CapabilityReport = Readonly<Record<CapabilityKey, CapabilityStatus>>;

/**
 * Resolved host facts the capability matrix is evaluated against. Injecting
 * this (rather than reading `process` directly) keeps the probe fully
 * unit-testable under any OS/arch/loopback combination.
 */
export interface HostEnvironment {
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** `process.arch` (e.g. `arm64`, `x64`). */
  readonly arch: string;
  /** Whether system audio loopback can be captured on this host. */
  readonly audioLoopbackAvailable: boolean;
}

/** Host summary returned alongside the capability report. */
export interface HostSummary {
  readonly platform: string;
  readonly arch: string;
  readonly audioLoopbackAvailable: boolean;
}

/** IPC command that returns the full capability report. */
export const CAPABILITIES_GET_COMMAND = 'capabilities:get' as const;
