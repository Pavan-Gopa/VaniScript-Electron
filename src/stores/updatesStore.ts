import { isErrorCode } from '../../shared/contracts/errors.ts';
import { useSyncExternalStore } from 'react';
import {
  UPDATE_ACTIONS_ALLOWED_FROM,
  UPDATE_BLOCKER_CATEGORIES,
  UPDATE_BLOCKER_MESSAGES,
  UPDATE_COMMANDS,
  UPDATE_STATES,
  UPDATE_USER_ACTIONS,
  type UpdateBlockerCategory,
  type UpdateDownloadProgress,
  type UpdatePresentation,
  type UpdateStateName,
  type UpdateUserAction,
} from '../../shared/contracts/updates.ts';

/** Honest renderer state when Main has not exposed the D1 seam yet. */
export const UPDATE_BRIDGE_DEFERRED =
  'Update bridge is not exposed; update actions are deferred until Main exposes the D1 service seam.';

export const UPDATE_BLOCKER_LABELS: Record<UpdateBlockerCategory, string> = {
  recording: 'Recording',
  recordingPreviewSave: 'Recording preview or save',
  mediaProcessing: 'Media processing',
  translation: 'Translation',
  shortsRenderPlanning: 'Shorts render or planning',
  batchCurrentJob: 'Batch job',
  documentRecovery: 'Document autosave or recovery',
  projectSaveFailure: 'Project save failure',
  modelMutation: 'Model download or relocation',
};

export interface UpdateDescriptorSummary {
  schemaVersion: number;
  version: string;
  build: string;
  title: string;
  notes: string;
  critical: boolean;
  informational: boolean;
  publishDate: string | null;
  sizeBytes: number;
  infoUrl: string | null;
  platform: string;
  arch: string;
  channel: 'stable' | 'beta';
  artifactType: string | null;
}

export interface UpdateCapabilitiesSummary {
  available: boolean;
  platform: string | null;
  arch: string | null;
  backend: string | null;
  installAvailable: boolean | null;
  installPolicy: string | null;
  userMessage: string | null;
  artifactType: string | null;
  acceptedArtifactTypes: readonly string[];
}

export interface UpdateErrorView {
  code: string;
  message: string;
  details?: unknown;
}

export interface UpdateBlockerView {
  category: string;
  label: string;
  message: string;
  details?: unknown;
}

/** Receipt fields needed by Settings; artifact hashes stay in Main. */
export interface UpdateReceiptSummary {
  schemaVersion: number;
  fromVersion: string;
  toVersion: string;
  fromBuild: string;
  toBuild: string;
  timestamp: string;
  channel: 'stable' | 'beta';
  outcome: 'success' | 'failed';
}

export interface UpdateBridge {
  getState?: () => unknown | Promise<unknown>;
  getReceipt?: () => unknown | Promise<unknown>;
  collectBlockers?: () => unknown | Promise<unknown>;
  getCapabilities?: (artifactType?: string | null) => unknown | Promise<unknown>;
  checkNow?: () => unknown | Promise<unknown>;
  downloadNow?: () => unknown | Promise<unknown>;
  installNow?: () => unknown | Promise<unknown>;
  skipVersion?: () => unknown | Promise<unknown>;
  remindLater?: () => unknown | Promise<unknown>;
  cancelDownload?: () => unknown | Promise<unknown>;
  retry?: () => unknown | Promise<unknown>;
}

export interface UpdatesStoreSnapshot {
  state: UpdateStateName;
  currentVersion: string;
  currentBuild: string;
  channel: 'stable' | 'beta';
  platform: string;
  arch: string;
  descriptor: UpdateDescriptorSummary | null;
  lastCheckedAt: string | null;
  download: UpdateDownloadProgress | null;
  skippedVersion: string | null;
  remindLaterUntil: string | null;
  lastAction: UpdateUserAction | null;
  presentation: UpdatePresentation;
  blockers: readonly UpdateBlockerView[];
  receipt: UpdateReceiptSummary | null;
  capabilities: UpdateCapabilitiesSummary | null;
  error: UpdateErrorView | null;
  busyAction: UpdateUserAction | null;
  loading: boolean;
  bridgeStatus: 'ready' | 'deferred';
  bridgeMessage: string | null;
  actions: Readonly<Record<UpdateUserAction, boolean>>;
}

export interface UpdatesStore {
  getState(): UpdatesStoreSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  refreshBlockers(): Promise<void>;
  checkNow(): Promise<void>;
  downloadNow(): Promise<void>;
  installNow(): Promise<void>;
  skipVersion(): Promise<void>;
  remindLater(): Promise<void>;
  cancelDownload(): Promise<void>;
  retry(): Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
function publicInfoUrl(value: unknown): string | null {
  const candidate = nullableString(value);
  if (!candidate) return null;
  try {
    const protocol = new URL(candidate).protocol;
    return protocol === 'http:' || protocol === 'https:' ? candidate : null;
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function isState(value: unknown): value is UpdateStateName {
  return typeof value === 'string' && (UPDATE_STATES as readonly string[]).includes(value);
}

function isAction(value: unknown): value is UpdateUserAction {
  return typeof value === 'string' && (UPDATE_USER_ACTIONS as readonly string[]).includes(value);
}

function isCategory(value: unknown): value is UpdateBlockerCategory {
  return typeof value === 'string'
    && (UPDATE_BLOCKER_CATEGORIES as readonly string[]).includes(value);
}

function safeDetails(value: unknown, depth = 0, key = ''): unknown {
  if (depth > 3) return '[details omitted]';
  if (key && /secret|token|password|credential|private|signature|artifacthash|authorization|^feed$|^raw$|^payload$|^artifact$|^bytes$/i.test(key)) {
    return '[redacted]';
  }
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((entry) => safeDetails(entry, depth + 1));
  }
  const record = asRecord(value);
  if (!record) return String(value);
  return Object.fromEntries(
    Object.entries(record)
      .slice(0, 24)
      .map(([entryKey, entryValue]) => [entryKey, safeDetails(entryValue, depth + 1, entryKey)]),
  );
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const record = asRecord(error);
  if (typeof record?.message === 'string' && record.message.length > 0) return record.message;
  return String(error);
}

function errorView(error: unknown): UpdateErrorView {
  const outer = asRecord(error);
  const nested = asRecord(outer?.error);
  const record = nested || outer;
  const code = isErrorCode(record?.code) ? record.code : 'INTERNAL';
  const message = typeof record?.message === 'string' && record.message.length > 0
    ? record.message
    : errorText(error);
  const details = record?.details === undefined ? undefined : safeDetails(record.details);
  return details === undefined ? { code, message } : { code, message, details };
}

function descriptorSummary(value: unknown): UpdateDescriptorSummary | null {
  const record = asRecord(value);
  if (!record || typeof record.version !== 'string' || record.version.length === 0) return null;
  return {
    schemaVersion: finiteNumber(record.schemaVersion, 1),
    version: record.version,
    build: stringValue(record.build, '—'),
    title: stringValue(record.title, `Update ${record.version}`),
    notes: stringValue(record.notes),
    critical: record.critical === true,
    informational: record.informational === true,
    publishDate: nullableString(record.publishDate),
    sizeBytes: Math.max(0, finiteNumber(record.sizeBytes)),
    infoUrl: publicInfoUrl(record.infoUrl),
    platform: stringValue(record.platform, '—'),
    arch: stringValue(record.arch, '—'),
    channel: record.channel === 'beta' ? 'beta' : 'stable',
    // Feed signatures and artifact hashes are intentionally not copied here.
    artifactType: nullableString(record.artifactType),
  };
}

function presentationFor(descriptor: UpdateDescriptorSummary | null): UpdatePresentation {
  const critical = descriptor?.critical === true;
  const informational = !critical && descriptor?.informational === true;
  return {
    emphasis: critical ? 'critical' : informational ? 'informational' : 'standard',
    critical,
    informational,
    autoDownload: false,
    autoInstall: false,
    showSkip: Boolean(descriptor),
    showRemind: Boolean(descriptor),
  };
}

function downloadProgress(value: unknown): UpdateDownloadProgress | null {
  const record = asRecord(value);
  if (!record) return null;
  const totalBytes = Math.max(0, finiteNumber(record.totalBytes));
  const receivedBytes = Math.max(0, finiteNumber(record.receivedBytes));
  const fraction = Math.max(0, Math.min(1, finiteNumber(record.fraction, totalBytes > 0 ? receivedBytes / totalBytes : 0)));
  return { receivedBytes, totalBytes, fraction };
}

function receiptSummary(value: unknown): UpdateReceiptSummary | null {
  const record = asRecord(unwrapBridgeResult(value));
  if (!record || typeof record.fromVersion !== 'string' || typeof record.toVersion !== 'string') return null;
  if (record.outcome !== 'success' && record.outcome !== 'failed') return null;
  return {
    schemaVersion: finiteNumber(record.schemaVersion, 1),
    fromVersion: record.fromVersion,
    toVersion: record.toVersion,
    fromBuild: stringValue(record.fromBuild, '—'),
    toBuild: stringValue(record.toBuild, '—'),
    timestamp: stringValue(record.timestamp, '—'),
    channel: record.channel === 'beta' ? 'beta' : 'stable',
    outcome: record.outcome,
  };
}

function blockerEntries(value: unknown): unknown[] {
  const unwrapped = unwrapBridgeResult(value);
  if (Array.isArray(unwrapped)) return unwrapped;
  const record = asRecord(unwrapped);
  if (!record) return [];
  if (Array.isArray(record.blockers)) return record.blockers;
  if (Array.isArray(record.reasons)) return record.reasons;
  return [];
}

export function blockerLabel(category: string): string {
  if (isCategory(category)) return UPDATE_BLOCKER_LABELS[category];
  if (category === 'settings' || category === 'projects' || category === 'sqlite' || category === 'recovery') {
    return `${category[0].toUpperCase()}${category.slice(1)} save preparation`;
  }
  return category ? category : 'Update readiness';
}

function blockerSummary(value: unknown): UpdateBlockerView | null {
  const record = asRecord(value);
  if (!record) return null;
  const category = typeof record.category === 'string'
    ? record.category
    : typeof record.subsystem === 'string' ? record.subsystem : 'readiness';
  const message = typeof record.message === 'string' && record.message.length > 0
    ? record.message
    : isCategory(category) ? UPDATE_BLOCKER_MESSAGES[category] : 'Update readiness is not complete.';
  const details = record.details === undefined
    ? (record.outcome === undefined ? undefined : safeDetails({ outcome: record.outcome }))
    : safeDetails(record.details);
  return {
    category,
    label: blockerLabel(category),
    message,
    ...(details === undefined ? {} : { details }),
  };
}

function blockersFrom(value: unknown): UpdateBlockerView[] {
  const seen = new Set<string>();
  const result: UpdateBlockerView[] = [];
  for (const entry of blockerEntries(value)) {
    const blocker = blockerSummary(entry);
    if (!blocker) continue;
    const key = `${blocker.category}:${blocker.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(blocker);
  }
  return result;
}

function capabilitiesSummary(value: unknown): UpdateCapabilitiesSummary | null {
  const record = asRecord(unwrapBridgeResult(value));
  if (!record) return null;
  const accepted = Array.isArray(record.acceptedArtifactTypes)
    ? record.acceptedArtifactTypes.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return {
    available: record.available !== false,
    platform: nullableString(record.platform),
    arch: nullableString(record.arch),
    backend: nullableString(record.backend),
    installAvailable: boolOrNull(record.installAvailable),
    installPolicy: nullableString(record.installPolicy),
    userMessage: nullableString(record.userMessage),
    artifactType: nullableString(record.artifactType),
    acceptedArtifactTypes: accepted,
  };
}

function unwrapBridgeResult(value: unknown): unknown {
  const record = asRecord(value);
  if (!record || typeof record.ok !== 'boolean') return value;
  if (record.ok === false && 'error' in record) throw record.error;
  return record.ok === true && 'value' in record ? record.value : value;
}
function stateRecord(value: unknown): Record<string, unknown> | null {
  const record = asRecord(unwrapBridgeResult(value));
  if (!record) return null;
  const nested = asRecord(record.state);
  return nested && isState(nested.state) ? nested : record;
}

function bridgeFunction(api: Record<string, unknown>, names: readonly string[]): (() => unknown) | undefined {
  for (const name of names) {
    const candidate = api[name];
    if (typeof candidate === 'function') return (candidate as () => unknown).bind(api);
  }
  return undefined;
}

function bridgeFromWindow(): UpdateBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const api = asRecord((window as unknown as { electronAPI?: unknown }).electronAPI);
  if (!api) return undefined;

  const invoke = typeof api.invoke === 'function'
    ? (method: string) => () => (api.invoke as (channel: string) => unknown)(method)
    : undefined;
  const method = (direct: readonly string[], command: string): (() => unknown) | undefined =>
    bridgeFunction(api, direct) || invoke?.(command);
  const bridge: UpdateBridge = {
    getState: method(['updateGetState', 'updatesGetState', 'getUpdateState'], UPDATE_COMMANDS.getState),
    getReceipt: method(['updateGetReceipt', 'updatesGetReceipt', 'getUpdateReceipt'], 'updates:receipt'),
    collectBlockers: method(['updateCollectBlockers', 'updatesCollectBlockers', 'collectUpdateBlockers'], UPDATE_COMMANDS.collectBlockers),
    getCapabilities: (artifactType) => {
      const direct = api.updateGetCapabilities || api.updatesGetCapabilities;
      if (typeof direct === 'function') return (direct as (value?: string | null) => unknown).call(api, artifactType);
      if (invoke) return (api.invoke as (channel: string, payload?: unknown) => unknown)('updates:capabilities', { artifactType });
      return undefined;
    },
    checkNow: method(['updateCheckNow', 'updatesCheckNow'], UPDATE_COMMANDS.checkNow),
    downloadNow: method(['updateDownloadNow', 'updatesDownloadNow'], UPDATE_COMMANDS.downloadNow),
    installNow: method(['updateInstallNow', 'updatesInstallNow'], UPDATE_COMMANDS.installNow),
    skipVersion: method(['updateSkipVersion', 'updatesSkipVersion'], UPDATE_COMMANDS.skipVersion),
    remindLater: method(['updateRemindLater', 'updatesRemindLater'], UPDATE_COMMANDS.remindLater),
    cancelDownload: method(['updateCancelDownload', 'updatesCancelDownload'], UPDATE_COMMANDS.cancelDownload),
    retry: method(['updateRetry', 'updatesRetry'], UPDATE_COMMANDS.retry),
  };
  return Object.values(bridge).some((entry) => typeof entry === 'function') ? bridge : undefined;
}

const EMPTY_ACTIONS: Readonly<Record<UpdateUserAction, boolean>> = {
  checkNow: false,
  downloadNow: false,
  installNow: false,
  skipVersion: false,
  remindLater: false,
  cancelDownload: false,
  retry: false,
};

const INITIAL_STATE_BASE: Omit<UpdatesStoreSnapshot, 'actions'> = {
  state: 'idle',
  currentVersion: 'unknown',
  currentBuild: 'unknown',
  channel: 'stable',
  platform: 'unknown',
  arch: 'unknown',
  descriptor: null,
  lastCheckedAt: null,
  download: null,
  skippedVersion: null,
  remindLaterUntil: null,
  lastAction: null,
  presentation: presentationFor(null),
  blockers: [],
  receipt: null,
  capabilities: null,
  error: null,
  busyAction: null,
  loading: false,
  bridgeStatus: 'deferred',
  bridgeMessage: UPDATE_BRIDGE_DEFERRED,
};

function actionMap(
  state: UpdatesStoreSnapshot,
  bridge: UpdateBridge | undefined,
): Readonly<Record<UpdateUserAction, boolean>> {
  if (!bridge || state.busyAction) return EMPTY_ACTIONS;
  return Object.fromEntries(UPDATE_USER_ACTIONS.map((action) => [
    action,
    Boolean(typeof bridge[action] === 'function')
      && (UPDATE_ACTIONS_ALLOWED_FROM[action] as readonly string[]).includes(state.state)
      && (action !== 'installNow' || state.blockers.length === 0),
  ])) as Readonly<Record<UpdateUserAction, boolean>>;
}

export function createUpdatesStore(providedBridge?: UpdateBridge): UpdatesStore {
  const candidate = providedBridge ?? bridgeFromWindow();
  const bridge = candidate && Object.values(candidate).some((entry) => typeof entry === 'function')
    ? candidate
    : undefined;
  let state: UpdatesStoreSnapshot = {
    ...INITIAL_STATE_BASE,
    bridgeStatus: bridge ? 'ready' : 'deferred',
    bridgeMessage: bridge ? null : UPDATE_BRIDGE_DEFERRED,
    actions: EMPTY_ACTIONS,
  };
  const listeners = new Set<() => void>();
  let refreshToken = 0;

  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const commit = (patch: Partial<UpdatesStoreSnapshot>) => {
    const next = { ...state, ...patch } as UpdatesStoreSnapshot;
    next.actions = actionMap(next, bridge);
    state = next;
    emit();
  };

  const statePatch = (raw: unknown): Partial<UpdatesStoreSnapshot> | null => {
    const record = stateRecord(raw);
    if (!record || !isState(record.state)) return null;
    const descriptor = Object.prototype.hasOwnProperty.call(record, 'descriptor')
      ? descriptorSummary(record.descriptor)
      : state.descriptor;
    return {
      state: record.state,
      currentVersion: stringValue(record.currentVersion, state.currentVersion),
      currentBuild: stringValue(record.currentBuild, state.currentBuild),
      channel: record.channel === 'beta' ? 'beta' : record.channel === 'stable' ? 'stable' : state.channel,
      platform: stringValue(record.platform, state.platform),
      arch: stringValue(record.arch, state.arch),
      descriptor,
      lastCheckedAt: Object.prototype.hasOwnProperty.call(record, 'lastCheckedAt')
        ? nullableString(record.lastCheckedAt)
        : state.lastCheckedAt,
      download: Object.prototype.hasOwnProperty.call(record, 'download')
        ? downloadProgress(record.download)
        : state.download,
      skippedVersion: Object.prototype.hasOwnProperty.call(record, 'skippedVersion')
        ? nullableString(record.skippedVersion)
        : state.skippedVersion,
      remindLaterUntil: Object.prototype.hasOwnProperty.call(record, 'remindLaterUntil')
        ? nullableString(record.remindLaterUntil)
        : state.remindLaterUntil,
      lastAction: Object.prototype.hasOwnProperty.call(record, 'lastAction')
        ? (isAction(record.lastAction) ? record.lastAction : null)
        : state.lastAction,
      error: Object.prototype.hasOwnProperty.call(record, 'error')
        ? (record.error ? errorView(record.error) : null)
        : state.error,
      presentation: presentationFor(descriptor),
    };
  };

  const updateFromActionResult = (raw: unknown, action: UpdateUserAction) => {
    const record = asRecord(raw);
    const nestedReceipt = record?.receipt;
    const patch = statePatch(raw);
    const receipt = receiptSummary(nestedReceipt) || receiptSummary(raw);
    commit({
      ...(patch || {}),
      ...(receipt ? { receipt } : {}),
      ...(action === 'skipVersion' || action === 'remindLater' || action === 'cancelDownload'
        ? { blockers: [], error: null }
        : {}),
      busyAction: null,
    });
  };

  const refreshBlockers = async (): Promise<void> => {
    if (!bridge) {
      commit({ bridgeStatus: 'deferred', bridgeMessage: UPDATE_BRIDGE_DEFERRED });
      return;
    }
    if (typeof bridge.collectBlockers !== 'function') return;
    try {
      const raw = await bridge.collectBlockers();
      commit({
        blockers: blockersFrom(raw),
        bridgeStatus: 'ready',
        bridgeMessage: null,
      });
    } catch (error) {
      commit({ error: errorView(error), bridgeStatus: 'ready', bridgeMessage: null });
    }
  };

  const refresh = async (): Promise<void> => {
    if (!bridge) {
      commit({ bridgeStatus: 'deferred', bridgeMessage: UPDATE_BRIDGE_DEFERRED, loading: false });
      return;
    }
    const token = ++refreshToken;
    commit({ loading: true, error: null, bridgeStatus: 'ready', bridgeMessage: null });
    try {
      let patch: Partial<UpdatesStoreSnapshot> = {};
      if (typeof bridge.getState === 'function') {
        const raw = await bridge.getState();
        const nextPatch = statePatch(raw);
        if (nextPatch) patch = { ...patch, ...nextPatch };
      }
      if (typeof bridge.collectBlockers === 'function') {
        patch.blockers = blockersFrom(await bridge.collectBlockers());
      }
      if (typeof bridge.getReceipt === 'function') {
        patch.receipt = receiptSummary(await bridge.getReceipt());
      }
      if (typeof bridge.getCapabilities === 'function') {
        patch.capabilities = capabilitiesSummary(await bridge.getCapabilities(
          (patch.descriptor || state.descriptor)?.artifactType || null,
        ));
      }
      if (token !== refreshToken) return;
      commit({ ...patch, loading: false, bridgeStatus: 'ready', bridgeMessage: null });
    } catch (error) {
      if (token !== refreshToken) return;
      commit({ loading: false, error: errorView(error), bridgeStatus: 'ready', bridgeMessage: null });
    }
  };

  const runAction = async (action: UpdateUserAction): Promise<void> => {
    if (!bridge || typeof bridge[action] !== 'function') {
      commit({ bridgeStatus: 'deferred', bridgeMessage: UPDATE_BRIDGE_DEFERRED });
      return;
    }
    if (!state.actions[action] || state.busyAction) return;

    // Claim the busy slot synchronously so a concurrent invocation observes
    // the guard before this call awaits blocker collection.
    commit({ busyAction: action, error: null });
    // Collect before install so a known blocker disables the button and never
    // pretends that a critical update can bypass readiness.
    if (action === 'installNow' && typeof bridge.collectBlockers === 'function') {
      try {
        const blockers = blockersFrom(await bridge.collectBlockers());
        if (blockers.length > 0) {
          commit({
            busyAction: null,
            blockers,
            error: {
              code: 'UPDATE_BLOCKED',
              message: 'Install refused while readiness blockers are present.',
              details: safeDetails({ kind: 'blockers', reasons: blockers }),
            },
          });
          return;
        }
        commit({ blockers: [] });
      } catch (error) {
        commit({ busyAction: null, error: errorView(error) });
        return;
      }
    }

    try {
      const result = await bridge[action]!();
      updateFromActionResult(result, action);
      if (action === 'installNow' && typeof bridge.getReceipt === 'function') {
        const receipt = receiptSummary(await bridge.getReceipt());
        if (receipt) commit({ receipt });
      }
    } catch (error) {
      let patch: Partial<UpdatesStoreSnapshot> = { error: errorView(error), busyAction: null };
      const view = errorView(error);
      const reasons = asRecord(view.details)?.reasons;
      const blocked = blockersFrom(reasons);
      if (blocked.length > 0) patch.blockers = blocked;
      if (typeof bridge.getState === 'function') {
        try {
          const nextPatch = statePatch(await bridge.getState());
          if (nextPatch) patch = { ...nextPatch, ...patch };
        } catch {
          // Preserve the original typed action error when state refresh fails.
        }
      }
      commit(patch);
    }
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh,
    refreshBlockers,
    checkNow: () => runAction('checkNow'),
    downloadNow: () => runAction('downloadNow'),
    installNow: () => runAction('installNow'),
    skipVersion: () => runAction('skipVersion'),
    remindLater: () => runAction('remindLater'),
    cancelDownload: () => runAction('cancelDownload'),
    retry: () => runAction('retry'),
  };
}

export const updatesStore = createUpdatesStore();

export function useUpdatesStore(store: UpdatesStore = updatesStore): UpdatesStoreSnapshot {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
