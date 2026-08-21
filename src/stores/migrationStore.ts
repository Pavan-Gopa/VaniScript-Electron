import { useEffect, useRef, useState } from 'react';

// Minimal slice of the legacy `window.electronAPI` bridge this migration needs.
interface ElectronAPI {
  migrateLegacySettings?: (
    payload: { settings?: unknown; usage?: unknown },
  ) => Promise<{ ok: boolean; errorCode?: string; error?: string }>;
}

type WindowWithElectron = Window & { electronAPI?: ElectronAPI };

// Legacy `localStorage` keys written by the Apple-Silicon era app
// (see migration plan §7.2). These are the ONLY keys this migration touches.
export const LEGACY_SETTINGS_KEY = 'vs_settings_v1';
export const LEGACY_USAGE_KEY = 'vs_usage_v1';

export type MigrationStatus =
  | 'idle'
  | 'skipped'
  | 'migrating'
  | 'migrated'
  | 'failed';

export interface MigrationOutcome {
  status: MigrationStatus;
  detail?: string;
}

/**
 * Injected dependencies for the migration orchestration. Keeping the logic pure
 * (and the DOM/IPC behind these seams) lets the renderer-side behaviour —
 * especially "clear `localStorage` on success, keep it on failure" — be unit
 * tested without a browser or React.
 */
export interface MigrationDeps {
  /** Whether any legacy key is still present. */
  hasLegacy: () => boolean;
  /** Read + parse the legacy payload (may throw on corrupt localStorage). */
  readLegacy: () => { settings?: unknown; usage?: unknown };
  /** Ship the payload to Main and resolve with the ack. */
  send: (
    payload: { settings?: unknown; usage?: unknown },
  ) => Promise<{ ok: boolean; errorCode?: string; error?: string }>;
  /** Clear the legacy keys after a successful ack. */
  clearLegacy: () => void;
  /** Optional status observer. */
  onStatus?: (status: MigrationStatus, detail?: string) => void;
}

/**
 * One-shot legacy-settings migration orchestration.
 *
 * Safety contract: `localStorage` is cleared ONLY after `send` resolves with
 * `ok: true`. On any failure (send rejects, returns `ok: false`, or legacy data
 * is unreadable) the legacy keys are left intact so the migration can be
 * retried on the next launch.
 */
export async function runLegacySettingsMigration(
  deps: MigrationDeps,
): Promise<MigrationOutcome> {
  const { hasLegacy, readLegacy, send, clearLegacy, onStatus } = deps;

  if (!hasLegacy()) {
    onStatus?.('skipped');
    return { status: 'skipped' };
  }

  onStatus?.('migrating');

  let payload: { settings?: unknown; usage?: unknown };
  try {
    payload = readLegacy();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    onStatus?.('failed', detail);
    return { status: 'failed', detail };
  }

  const result = await send(payload);
  if (result.ok) {
    clearLegacy();
    onStatus?.('migrated');
    return { status: 'migrated' };
  }

  // Failure: keep localStorage for a safe retry next launch. Do NOT clear.
  onStatus?.('failed', result.error || result.errorCode);
  return { status: 'failed', detail: result.error || result.errorCode };
}

/**
 * React hook that runs the one-shot migration once on mount, wiring the
 * orchestration to the legacy `window.electronAPI` bridge and `localStorage`.
 *
 * The migration only runs when `window.electronAPI.migrateLegacySettings` exists
 * (i.e. the Main handler is registered); otherwise it is a no-op so the app
 * still boots on a platform without the new IPC wired yet.
 */
export function useLegacySettingsMigration(options?: { enabled?: boolean }): {
  status: MigrationStatus;
  detail?: string;
} {
  const [status, setStatus] = useState<MigrationStatus>('idle');
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const ranRef = useRef(false);

  useEffect(() => {
    if (options?.enabled === false) return;
    if (ranRef.current) return;
    ranRef.current = true;

    const api = typeof window !== 'undefined' ? (window as WindowWithElectron).electronAPI : undefined;
    if (!api || typeof api.migrateLegacySettings !== 'function') return;

    const migrateFn = api.migrateLegacySettings;
    const deps: MigrationDeps = {
      hasLegacy: () => {
        try {
          const ls = window.localStorage;
          return ls.getItem(LEGACY_SETTINGS_KEY) !== null || ls.getItem(LEGACY_USAGE_KEY) !== null;
        } catch {
          return false;
        }
      },
      readLegacy: () => {
        const ls = window.localStorage;
        const parse = (key: string): unknown => {
          const raw = ls.getItem(key);
          if (raw == null) return undefined;
          try {
            return JSON.parse(raw);
          } catch {
            return raw;
          }
        };
        return { settings: parse(LEGACY_SETTINGS_KEY), usage: parse(LEGACY_USAGE_KEY) };
      },
      send: async (payload) => {
        try {
          const res = await migrateFn(payload);
          if (res && typeof res.ok === 'boolean') return res;
          return { ok: false, errorCode: 'INTERNAL', error: 'malformed migration response' };
        } catch (err) {
          return {
            ok: false,
            errorCode: 'INTERNAL',
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
      clearLegacy: () => {
        try {
          window.localStorage.removeItem(LEGACY_SETTINGS_KEY);
          window.localStorage.removeItem(LEGACY_USAGE_KEY);
        } catch {
          /* best-effort */
        }
      },
      onStatus: (s, d) => {
        setStatus(s);
        setDetail(d);
      },
    };

    void runLegacySettingsMigration(deps);
  }, [options?.enabled]);

  return { status, detail };
}
