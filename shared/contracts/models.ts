/**
 * MOD-01 — Local model manager IPC contracts.
 *
 * Typed request/response shapes for the Main-process model manager that the
 * Renderer invokes through `window.electronAPI.manageModels(action, payload)`.
 * A single IPC channel carries a discriminated `action` so scanning, verifying,
 * and relocating all route through one secured Main-only handler. The Renderer
 * never touches model bytes, paths outside the allowed root, or secret material.
 */

import type { AppErrorShape } from './errors';

/** Model runtimes the manager can discover and relocate. */
export type ModelRuntime = 'mlx' | 'gguf' | 'ggml' | 'whisperkit';

/** A discoverable model artifact returned by a scan. */
export interface ModelArtifact {
  /** Display name (file name or directory name). */
  name: string;
  /** Detected runtime / format family. */
  runtime: ModelRuntime;
  /** Absolute path to the artifact on disk. */
  path: string;
  /** True when the artifact is a directory (e.g. WhisperKit bundle, MLX dir). */
  isDirectory: boolean;
  /** Lower-cased file extension including the dot, or '' for directories. */
  extension: string;
  /** Size in bytes for file artifacts; undefined for directories. */
  sizeBytes?: number;
}

export type ModelAction = 'scan' | 'verify' | 'relocate';

export interface ScanModelsRequest {
  action: 'scan';
  /** Explicit directories to scan. When omitted the resolved models root is scanned. */
  directories?: string[];
  /** Restrict detection to these runtimes. */
  runtimes?: ModelRuntime[];
  /** Include per-artifact byte sizes (slightly slower). Default true. */
  includeSizes?: boolean;
}

export interface VerifyModelRequest {
  action: 'verify';
  /** Absolute path to the model file to verify. */
  filePath: string;
  /** Expected hex checksum. When supplied a mismatch raises CORRUPT_DATA. */
  expectedChecksum?: string;
  /** Hash algorithm (default 'sha256'). */
  algorithm?: string;
  /** Optional root the path must stay within (blocks traversal). */
  allowedRoot?: string;
}

export interface RelocateModelRequest {
  action: 'relocate';
  /** Absolute source path (must exist, must stay within allowedRoot). */
  sourcePath: string;
  /** Absolute destination path (must stay within allowedRoot, must not already exist). */
  destinationPath: string;
  /** Expected source checksum; mismatch raises CORRUPT_DATA before any move. */
  expectedChecksum?: string;
  /** Hash algorithm (default 'sha256'). */
  algorithm?: string;
  /** Root both paths must resolve within. Defaults to the resolved models root. */
  allowedRoot?: string;
}

export type ModelManageRequest = ScanModelsRequest | VerifyModelRequest | RelocateModelRequest;

export interface ScanModelsResult {
  action: 'scan';
  models: ModelArtifact[];
}

export interface VerifyModelResult {
  action: 'verify';
  filePath: string;
  algorithm: string;
  checksum: string;
  sizeBytes: number;
  /** True when expectedChecksum was supplied and matched. */
  match: boolean;
}

export interface RelocateModelResult {
  action: 'relocate';
  sourcePath: string;
  destinationPath: string;
  checksum: string;
  sizeBytes: number;
}

export type ModelManageResult = ScanModelsResult | VerifyModelResult | RelocateModelResult;

/** IPC channel the manager is exposed on (canonical; mirrored in modelManager.js). */
export const MODELS_MANAGE_CHANNEL = 'models:manage';

/** Per-action command identifiers (documentation / future dedicated channels). */
export const MODELS_SCAN_COMMAND = 'models:scan';
export const MODELS_VERIFY_COMMAND = 'models:verify';
export const MODELS_RELOCATE_COMMAND = 'models:relocate';

/** Success / failure envelope returned across IPC (AppError marker preserved). */
export type ModelManageResponse =
  | { ok: true; result: ModelManageResult }
  | { ok: false; error: AppErrorShape };
