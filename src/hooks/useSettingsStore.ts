/**
 * `useSettingsStore` — React adapter over the typed IPC settings bridge.
 *
 * SET-04 establishes Settings UI parity by reading/writing the main-process
 * settings store via `window.electronAPI.getSettings()` / `updateSettings(...)`
 * instead of touching `localStorage` directly. This hook fetches the store
 * once, caches it in React state, and exposes a typed `updateSettings` that
 * deep-merges a partial patch back to Main.
 *
 * The global `electronAPI` type (declared in `src/types.ts`) is not augmented
 * here; we cast to a local `SettingsBridge` so the hook stays self-contained
 * and never weakens the shared contract.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Settings, UsageSnapshot } from '../../shared/contracts/settings';
import type {
  SettingsGetResult,
  SettingsUpdateRequest,
  SettingsUpdateResult,
} from '../../shared/contracts/ipc';

/** The SET-04 settings surface layered onto the global `electronAPI`. */
export interface SettingsBridge {
  getSettings(): Promise<SettingsGetResult>;
  updateSettings(args: SettingsUpdateRequest): Promise<SettingsUpdateResult>;
}

function resolveBridge(): SettingsBridge | undefined {
  const api = (window as { electronAPI?: unknown }).electronAPI;
  if (!api || typeof (api as { getSettings?: unknown }).getSettings !== 'function') {
    return undefined;
  }
  return api as unknown as SettingsBridge;
}

export interface UseSettingsStore {
  settings: Settings | null;
  loading: boolean;
  error: Error | null;
  /** Fetch the latest settings from Main; returns them or null on failure. */
  fetchSettings: () => Promise<Settings | null>;
  /** Deep-merge a partial patch (and optional usage) into the Main store. */
  updateSettings: (
    patch: Partial<Settings>,
    usage?: UsageSnapshot,
  ) => Promise<Settings | null>;
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(typeof err === 'string' ? err : 'Unknown settings store error');
}

/**
 * Adapter hook for the main-process settings store.
 *
 * @param initial Optional seed used before the first IPC read resolves.
 */
export function useSettingsStore(initial: Settings | null = null): UseSettingsStore {
  const [settings, setSettings] = useState<Settings | null>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fetchSettings = useCallback(async (): Promise<Settings | null> => {
    const bridge = resolveBridge();
    if (!bridge) return settings;
    setLoading(true);
    try {
      const result = await bridge.getSettings();
      if (mounted.current) setSettings(result.settings);
      return result.settings;
    } catch (err) {
      if (mounted.current) setError(toError(err));
      return null;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [settings]);

  const updateSettings = useCallback(
    async (patch: Partial<Settings>, usage?: UsageSnapshot): Promise<Settings | null> => {
      const bridge = resolveBridge();
      if (!bridge) {
        // No IPC bridge (e.g. browser preview): keep a local best-effort copy.
        const next = { ...(settings ?? ({} as Settings)), ...patch } as Settings;
        if (mounted.current) setSettings(next);
        return next;
      }
      try {
        const result = await bridge.updateSettings({ settings: patch, usage });
        if (mounted.current) setSettings(result.settings);
        return result.settings;
      } catch (err) {
        if (mounted.current) setError(toError(err));
        return null;
      }
    },
    [settings],
  );

  return { settings, loading, error, fetchSettings, updateSettings };
}
