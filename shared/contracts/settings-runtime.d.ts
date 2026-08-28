/**
 * Type declarations for `settings-runtime.js` — the CommonJS runtime behind
 * the `settings.ts` façade. The canonical settings interfaces remain declared
 * in the façade; only runtime values live here.
 */

import type {
  Settings,
  UsageLedger,
} from './settings.ts';

/** Current persisted settings schema version. Bump when the shape changes. */
export declare const SETTINGS_SCHEMA_VERSION: 2;
export declare const USAGE_SCHEMA_VERSION: 1;
export declare const USAGE_PURPOSES: readonly [
  'text',
  'chat',
  'translation',
  'transcription',
  'vision',
  'review',
  'polish',
  'shorts',
];
export declare const USAGE_PRICING: Readonly<Record<string, unknown>>;

/** Return a fresh, deep-cloned copy of the canonical defaults. */
export declare function createDefaultSettings(): Settings;
export declare function createDefaultUsageLedger(): UsageLedger;
export declare function normalizeUsageLedger(input: unknown): UsageLedger;
export declare function migrateLegacyUsage(input: unknown): UsageLedger;
export declare function recordUsage(
  ledger: unknown,
  input: unknown,
  now?: Date,
): UsageLedger;
export declare function projectUsage(
  ledger: unknown,
  range?: { from?: string; to?: string },
): Omit<UsageLedger, 'recentOperationHashes'>;

/**
 * Decode an unknown value into a fully-formed {@link Settings}, filling any
 * missing or invalid field with its default. Never throws.
 */
export declare function normalizeSettings(input: unknown): Settings;

/**
 * Apply sequential migrations to an unknown payload, then normalize.
 *
 * @returns the migrated settings, whether a migration ran, and the version
 *          the payload started from.
 */
export declare function migrateSettings(raw: unknown): {
  settings: Settings;
  migrated: boolean;
  fromVersion: number;
};
