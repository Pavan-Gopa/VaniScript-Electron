import type { ShortsRenderProject } from '../render-engine/types';
// @ts-ignore Shared CommonJS module is consumed by both Vite and Electron Main.
import * as shortsExportContractShared from '../../shared/shorts-export-contract.js';

/** Versioned wire contract shared by the renderer and Main export coordinator. */
export const SHORTS_EXPORT_CONTRACT: 'vaniscript-shorts-render-v1' = shortsExportContractShared.SHORTS_EXPORT_CONTRACT;

export type ShortsExportContract = typeof SHORTS_EXPORT_CONTRACT;
export type ShortsExportLanguage = 'source' | 'target';
export type ShortsExportFormat = 'mp4' | 'mov';
export type ShortsExportResolutionPreset = 'source' | '1080p' | '2k' | '4k';
export type ShortsExportFrameRatePreset = 'source' | '24' | '25' | '30' | '50' | '60';
export type ShortsExportQualityPreset = 'high' | 'balanced' | 'compact';

/** JSON values are the only values allowed to cross the export boundary. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

/** Recursive readonly view used for the canonical, frozen snapshot. */
export type DeepReadonly<T> =
  T extends (...args: never[]) => unknown ? T
    : T extends readonly (infer U)[] ? readonly DeepReadonly<U>[]
      : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T;

export type ShortsExportSourceInfo = Readonly<{
  width: number;
  height: number;
  durationSec: number;
  fps: number | null;
}>;

export type ShortsExportSource = Readonly<{
  inputVideoPath: string;
  inputVideoSrc: string;
  sourceFileName: string;
  info: ShortsExportSourceInfo;
}>;

export type ShortsExportOptions = Readonly<{
  format: ShortsExportFormat;
  resolutionPreset: ShortsExportResolutionPreset;
  frameRatePreset: ShortsExportFrameRatePreset;
  qualityPreset: ShortsExportQualityPreset;
  subtitleBottomMargin: number;
  subtitleUseCharsPerLine: boolean;
  subtitleUseLinesPerCue: boolean;
  subtitleMaxCharsPerLine: number;
  subtitleMaxLines: number;
}>;

export type ShortsExportSelectedUnit = Readonly<{
  stableID: string;
  language: ShortsExportLanguage;
}>;

/**
 * A renderer-owned value captured synchronously at export entry.
 *
 * `project` is already fully materialized by the existing pure render builder.
 * The optional `renderSeed`, transcript, and selection fields are intentionally
 * input-only metadata: materialization copies the render project into the wire
 * snapshot and never retains a live Session/React reference.
 */
export type ShortsExportClipSeed = Readonly<{
  stableID: string;
  language: ShortsExportLanguage;
  title?: string;
  project: ShortsRenderProject;
  renderSeed?: JsonObject;
  selectedUnit?: ShortsExportSelectedUnit;
}>;

export type ShortsExportSnapshotSeed = Readonly<{
  jobId: string;
  source: Readonly<{
    inputVideoPath: string;
    inputVideoSrc: string;
    sourceFileName: string;
    info?: Partial<ShortsExportSourceInfo>;
  }>;
  options: ShortsExportOptions;
  clips: readonly ShortsExportClipSeed[];
  selectedUnits?: readonly ShortsExportSelectedUnit[];
  transcriptCueInputs?: JsonValue;
  activeTranslationLanguage?: string | null;
}>;

export type ShortsExportClip = Readonly<{
  ordinal: number;
  stableID: string;
  language: ShortsExportLanguage;
  fileName: string;
  outputPath: string;
  project: DeepReadonly<ShortsRenderProject>;
}>;

/**
 * The only payload sent to Main. It deliberately contains no functions,
 * Promises, DOM values, Sets, class instances, or media bytes.
 */
export type ShortsExportSnapshot = Readonly<{
  contract: ShortsExportContract;
  jobId: string;
  source: ShortsExportSource;
  options: ShortsExportOptions;
  clips: readonly DeepReadonly<ShortsExportClip>[];
}>;

export type ShortsExportProbeResult = Readonly<{
  width: number;
  height: number;
  durationSec: number;
  fps?: number | null;
}>;

export type ShortsExportClipInput = Readonly<{
  ordinal?: number;
  stableID: string;
  language: ShortsExportLanguage;
  fileName?: string;
  outputPath?: string;
  project: ShortsRenderProject;
}>;

export type ShortsExportSnapshotInput = Readonly<{
  contract?: ShortsExportContract;
  jobId: string;
  source: ShortsExportSource;
  options: ShortsExportOptions;
  clips: readonly ShortsExportClipInput[];
}>;

export type ShortsExportProgressStage = string;

export type ShortsExportProgressEvent = Readonly<{
  jobId: string;
  sequence: number;
  kind: 'starting' | 'progress';
  clipIndex: number;
  completed: number;
  current: number;
  total: number;
  progress: number;
  stage: ShortsExportProgressStage;
  message: string;
}>;

export type ShortsExportTerminalState = 'succeeded' | 'failed' | 'cancelled';

export type ShortsExportTerminalEvent = Readonly<{
  jobId: string;
  sequence: number;
  kind: 'terminal';
  state: ShortsExportTerminalState;
  progress: number;
  total: number;
  completed: number;
  failedClipIndex?: number;
  failedStableID?: string;
  outputs: readonly string[];
  errorCode?: string;
  message: string;
  cleanupComplete: boolean;
}>;

export type ShortsExportEvent = ShortsExportProgressEvent | ShortsExportTerminalEvent;

export type ShortsExportEventGateState = Readonly<{
  jobId: string;
  sequence: number;
  terminal: boolean;
  percent: number;
  lastTerminal: ShortsExportTerminalEvent | null;
}>;

export type ShortsExportEventGateResult = Readonly<{
  event: ShortsExportEvent;
  percent: number;
}>;

export type ShortsExportEventGate = Readonly<{
  readonly state: ShortsExportEventGateState;
  accept(payload: unknown): ShortsExportEventGateResult | null;
  reset(options: Readonly<{ jobId: string }>): void;
}>;

export type ShortsExportSnapshotIssue = Readonly<{
  path: string;
  code: string;
  message: string;
}>;

export type ShortsExportSnapshotValidation =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; issues: readonly ShortsExportSnapshotIssue[] }>;



/** Runtime guard for the JSON subset used by the wire contract. */
export function isJsonCompatibleValue(value: unknown, ancestors = new WeakSet<object>()): value is JsonValue {
  return shortsExportContractShared.isJsonCompatibleValue(value, ancestors) as boolean;
}

/** Deep-freeze a JSON-compatible value in place. */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  return shortsExportContractShared.deepFreeze(value) as DeepReadonly<T>;
}

/** Clone into plain JSON values, then recursively freeze the clone. */
export function deepCloneDeepFreeze<T>(value: T): DeepReadonly<T> {
  return shortsExportContractShared.deepCloneDeepFreeze(value) as DeepReadonly<T>;
}

/**
 * Derive the deterministic one-based output name used by every export slice.
 * Ordering is supplied by the caller; materialization supplies stable order.
 */
export function shortsExportFileName(
  ordinal: number,
  language: ShortsExportLanguage,
  title: string,
  extension: ShortsExportFormat | `.${ShortsExportFormat}`,
): string {
  return shortsExportContractShared.shortsExportFileName(ordinal, language, title, extension) as string;
}

/**
 * Materialize exactly once from the synchronous seed, probe result, and chosen
 * output directory. Callers must not rebuild this object after awaiting probe
 * or directory selection; the returned value is an immutable export boundary.
 */
export function materializeShortsExportSnapshot(
  seed: ShortsExportSnapshotSeed,
  probeResult: ShortsExportProbeResult,
  chosenDirectory: string,
): ShortsExportSnapshot {
  return shortsExportContractShared.materializeShortsExportSnapshot(seed, probeResult, chosenDirectory) as ShortsExportSnapshot;
}

/** Build/freeze a complete snapshot when paths and source info are already known. */
export function buildShortsExportSnapshot(input: ShortsExportSnapshotInput): ShortsExportSnapshot {
  return shortsExportContractShared.buildShortsExportSnapshot(input) as ShortsExportSnapshot;
}

/** Return output paths occurring more than once, in deterministic order. */
export function findDuplicateOutputPaths(
  value: ShortsExportSnapshot | ReadonlyArray<Pick<ShortsExportClip, 'outputPath'>>,
): string[] {
  return shortsExportContractShared.findDuplicateOutputPaths(value) as string[];
}

/** Validate the complete wire value before Main accepts or re-freezes it. */
export function validateShortsExportSnapshot(value: unknown): ShortsExportSnapshotValidation {
  return shortsExportContractShared.validateShortsExportSnapshot(value) as ShortsExportSnapshotValidation;
}

export function isShortsExportSnapshot(value: unknown): value is ShortsExportSnapshot {
  return shortsExportContractShared.isShortsExportSnapshot(value) as boolean;
}

export function isShortsExportProgressEvent(value: unknown): value is ShortsExportProgressEvent {
  return shortsExportContractShared.isShortsExportProgressEvent(value) as boolean;
}

export function isShortsExportTerminalEvent(value: unknown): value is ShortsExportTerminalEvent {
  return shortsExportContractShared.isShortsExportTerminalEvent(value) as boolean;
}

export function createShortsExportEventGate(options: Readonly<{ jobId: string }>): ShortsExportEventGate {
  return shortsExportContractShared.createShortsExportEventGate(options) as ShortsExportEventGate;
}
