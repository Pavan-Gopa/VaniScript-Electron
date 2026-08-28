/**
 * Runtime names for the redacted observability contract. This module is
 * intentionally dependency-free so Main and preload can load the constants
 * without bringing Electron or a logger into the renderer bundle.
 */

export const OBSERVABILITY_SCHEMA_VERSION = 1;
export const USAGE_GET_COMMAND = 'usage:get';
export const USAGE_RECORD_COMMAND = 'usage:record';
export const USAGE_RESET_COMMAND = 'usage:reset';
export const USAGE_EXPORT_COMMAND = 'usage:export';
export const DIAGNOSTICS_GET_COMMAND = 'diagnostics:get';
export const DIAGNOSTICS_EXPORT_COMMAND = 'diagnostics:export';
export const DIAGNOSTICS_OPEN_LOGS_COMMAND = 'diagnostics:openLogs';

export const OBSERVABILITY_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);
export const SAFE_CATEGORIES = Object.freeze([
  'runtime',
  'renderer',
  'worker',
  'ffmpeg',
  'hyperframes',
  'provider',
  'agent',
  'mcp',
  'storage',
  'usage',
  'diagnostics',
]);

export const USAGE_PURPOSES = Object.freeze([
  'text',
  'chat',
  'translation',
  'transcription',
  'vision',
  'review',
  'polish',
  'shorts',
]);
