import { useSyncExternalStore } from 'react';
import {
  BATCH_COMMANDS,
  type BatchBadgeState,
  type BatchFilter,
  type BatchIssue,
  type BatchJob,
  type BatchJobDetails,
  type BatchProfile,
  type BatchProfileInput,
  type BatchQueueSnapshot,
} from '../../shared/contracts/batch.ts';
import * as virtualWindowModule from '../lib/virtual-window.ts';
import type { VirtualRows, VirtualWindow } from '../lib/virtual-window.ts';

type VirtualWindowExports = {
  getVirtualRows<T>(items: readonly T[], scrollTop: number, viewportHeight: number, rowHeight?: number, overscan?: number): VirtualRows<T>;
  getVirtualWindow(itemCount: number, scrollTop: number, viewportHeight: number, rowHeight?: number, overscan?: number): VirtualWindow;
};
const moduleValue: unknown = 'default' in virtualWindowModule ? virtualWindowModule.default : virtualWindowModule;
const virtualWindowExports = moduleValue as VirtualWindowExports;
export const getVirtualRows = virtualWindowExports.getVirtualRows;
export const getVirtualWindow = virtualWindowExports.getVirtualWindow;

export interface BatchBridge {
  invoke<R = unknown>(method: string, args?: unknown): Promise<R>;
}

export type BatchCommandName =
  | typeof BATCH_COMMANDS.scan
  | typeof BATCH_COMMANDS.start
  | typeof BATCH_COMMANDS.pauseAfterCurrent
  | typeof BATCH_COMMANDS.resume
  | typeof BATCH_COMMANDS.drain;

export type BatchBusyAction =
  | BatchCommandName
  | typeof BATCH_COMMANDS.createProfile
  | typeof BATCH_COMMANDS.retry
  | typeof BATCH_COMMANDS.cancel;

export interface BatchControlState {
  canScan: boolean;
  canStart: boolean;
  canPauseAfterCurrent: boolean;
  canResume: boolean;
  canDrain: boolean;
}
export interface BatchJobsPage {
  jobs: readonly BatchJob[];
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
  nextOffset: number | null;
}

export interface BatchStoreSnapshot {
  profiles: readonly BatchProfile[];
  jobs: readonly BatchJob[];
  jobsTotal: number;
  jobsHasMore: boolean;
  jobsNextOffset: number | null;
  issues: readonly BatchIssue[];
  selectedJobId: string | null;
  selectedDetails: BatchJobDetails | null;
  filter: BatchFilter;
  query: string;
  scheduler: BatchQueueSnapshot;
  loading: boolean;
  busyAction: BatchBusyAction | null;
  error: string | null;
  lastUpdatedAt: string | null;
}

export interface BatchStore {
  getState(): BatchStoreSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  loadMoreJobs(): Promise<void>;
  setFilter(filter: BatchFilter): void;
  setQuery(query: string): void;
  selectJob(jobId: string | null): Promise<void>;
  createProfile(input: BatchProfileInput): Promise<void>;
  pickFolder(): Promise<void>;
  scan(): Promise<void>;
  start(): Promise<void>;
  pauseAfterCurrent(): Promise<void>;
  resume(): Promise<void>;
  drain(): Promise<void>;
  retry(jobId: string): Promise<void>;
  cancel(jobId: string): Promise<void>;
  startPolling(intervalMs?: number): () => void;
}

const JOB_PAGE_LIMIT = 250;

function filterState(filter: BatchFilter): BatchJob['state'] | undefined {
  if (filter === 'pending' || filter === 'running' || filter === 'failed' || filter === 'cancelled') return filter;
  if (filter === 'completed') return 'done';
  if (filter === 'collision') return 'blockedOutputCollision';
  return undefined;
}

function normalizePage(value: unknown): BatchJobsPage {
  const record = asRecord(value);
  const jobs = asJobs(value);
  const limit = typeof record?.limit === 'number' && Number.isInteger(record.limit) && record.limit > 0
    ? record.limit
    : jobs.length;
  const offset = typeof record?.offset === 'number' && Number.isInteger(record.offset) && record.offset >= 0
    ? record.offset
    : 0;
  const total = typeof record?.total === 'number' && Number.isInteger(record.total) && record.total >= 0
    ? record.total
    : offset + jobs.length;
  const nextOffset = typeof record?.nextOffset === 'number' && Number.isInteger(record.nextOffset) && record.nextOffset > offset
    ? record.nextOffset
    : null;
  return {
    jobs,
    limit,
    offset,
    total,
    hasMore: record?.hasMore === true || nextOffset !== null,
    nextOffset,
  };
}

function mergeHeadJobs(previous: readonly BatchJob[], page: BatchJobsPage): BatchJob[] {
  const headCount = Math.max(page.limit, page.jobs.length);
  const headIds = new Set(page.jobs.map((job) => job.jobId));
  const retainedTail = previous
    .slice(Math.min(headCount, previous.length))
    .filter((job) => !headIds.has(job.jobId));
  return [...page.jobs, ...retainedTail];
}


const EMPTY_SCHEDULER: BatchQueueSnapshot = {
  mode: 'stopped',
  activeJobId: null,
  badge: 'idle',
  updatedAt: '',
};

const INITIAL_STATE: BatchStoreSnapshot = {
  profiles: [],
  jobs: [],
  jobsTotal: 0,
  jobsHasMore: false,
  jobsNextOffset: null,
  issues: [],
  selectedJobId: null,
  selectedDetails: null,
  filter: 'all',
  query: '',
  scheduler: EMPTY_SCHEDULER,
  loading: false,
  busyAction: null,
  error: null,
  lastUpdatedAt: null,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asProfiles(value: unknown): BatchProfile[] {
  if (Array.isArray(value)) return value as BatchProfile[];
  const record = asRecord(value);
  return Array.isArray(record?.profiles) ? record.profiles as BatchProfile[] : [];
}

function asJobs(value: unknown): BatchJob[] {
  if (Array.isArray(value)) return value as BatchJob[];
  const record = asRecord(value);
  return Array.isArray(record?.jobs) ? record.jobs as BatchJob[] : [];
}

function asIssues(value: unknown): BatchIssue[] {
  if (Array.isArray(value)) return value as BatchIssue[];
  const record = asRecord(value);
  return Array.isArray(record?.issues) ? record.issues as BatchIssue[] : [];
}

function asDetails(value: unknown): BatchJobDetails | null {
  const record = asRecord(value);
  if (!record || !asRecord(record.job)) return null;
  return record as unknown as BatchJobDetails;
}

function asScheduler(value: unknown): BatchQueueSnapshot {
  const record = asRecord(value);
  if (!record) return EMPTY_SCHEDULER;
  const mode = record.mode;
  const badge = record.badge;
  return {
    mode: mode === 'running' || mode === 'paused' || mode === 'pause-after-current' ? mode : 'stopped',
    activeJobId: typeof record.activeJobId === 'string' ? record.activeJobId : null,
    badge: badge === 'running' || badge === 'paused' || badge === 'failed' ? badge : 'idle',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  };
}

function bridgeFromWindow(): BatchBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const candidate = (window as unknown as { electronAPI?: unknown }).electronAPI;
  const record = asRecord(candidate);
  return record && typeof record.invoke === 'function'
    ? record as unknown as BatchBridge
    : undefined;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export function filterBatchJobs(
  jobs: readonly BatchJob[],
  filter: BatchFilter,
  query = '',
): BatchJob[] {
  const needle = query.trim().toLowerCase();
  return jobs.filter((job) => {
    const matchesFilter = filter === 'all'
      || filter === 'pending' && job.state === 'pending'
      || filter === 'running' && job.state === 'running'
      || filter === 'completed' && job.state === 'done'
      || filter === 'failed' && job.state === 'failed'
      || filter === 'collision' && job.state === 'blockedOutputCollision'
      || filter === 'cancelled' && job.state === 'cancelled';
    if (!matchesFilter) return false;
    if (!needle) return true;
    return [job.jobId, job.sourcePath, job.outputPath, job.state, job.phase, job.lastError]
      .some((value) => typeof value === 'string' && value.toLowerCase().includes(needle));
  });
}

export function getBatchControlState(scheduler: BatchQueueSnapshot): BatchControlState {
  const mode = scheduler.mode;
  return {
    canScan: true,
    canStart: mode === 'stopped',
    canPauseAfterCurrent: mode === 'running',
    canResume: mode === 'paused' || mode === 'pause-after-current',
    canDrain: mode === 'running' || mode === 'paused' || mode === 'pause-after-current',
  };
}

export function getBatchBadgeState(
  scheduler: BatchQueueSnapshot,
  jobs: readonly BatchJob[],
): BatchBadgeState {
  if (jobs.some((job) => job.state === 'failed' || job.state === 'blockedOutputCollision')) return 'failed';
  return scheduler.badge;
}


export function createBatchStore(providedBridge?: BatchBridge): BatchStore {
  const bridge = providedBridge ?? bridgeFromWindow();
  let state = INITIAL_STATE;
  const listeners = new Set<() => void>();
  let refreshToken = 0;
  let jobsRequestToken = 0;
  let pollingTimer: ReturnType<typeof setInterval> | null = null;
  let pollingInFlight = false;
  let loadingMore = false;
  let queryTimer: ReturnType<typeof setTimeout> | null = null;

  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const update = (patch: Partial<BatchStoreSnapshot>) => {
    state = { ...state, ...patch };
    emit();
  };
  const invoke = async <T,>(method: string, args?: unknown): Promise<T> => {
    if (!bridge) throw new Error('Batch IPC bridge is unavailable.');
    return bridge.invoke<T>(method, args);
  };
  const jobsArgs = (offset: number) => ({
    limit: JOB_PAGE_LIMIT,
    offset,
    ...(filterState(state.filter) ? { state: filterState(state.filter) } : {}),
    ...(state.query.trim() ? { query: state.query.trim() } : {}),
  });

  const refresh = async ({ preserveLoadedJobs = false }: { preserveLoadedJobs?: boolean } = {}): Promise<void> => {
    const token = ++refreshToken;
    const requestToken = preserveLoadedJobs ? jobsRequestToken : ++jobsRequestToken;
    if (!preserveLoadedJobs) {
      loadingMore = false;
      update({
        loading: true,
        error: null,
        jobs: [],
        jobsTotal: 0,
        jobsHasMore: false,
        jobsNextOffset: null,
      });
    } else {
      update({ error: null });
    }
    try {
      const [profilesResult, jobsResult, schedulerResult, issuesResult] = await Promise.all([
        invoke(BATCH_COMMANDS.listProfiles, { limit: 1000, offset: 0 }),
        invoke(BATCH_COMMANDS.listJobs, jobsArgs(0)),
        invoke(BATCH_COMMANDS.getState),
        invoke(BATCH_COMMANDS.listIssues),
      ]);
      if (token !== refreshToken || requestToken !== jobsRequestToken) return;
      const page = normalizePage(jobsResult);
      if (preserveLoadedJobs) {
        const previousJobs = state.jobs;
        const headCount = Math.max(page.limit, page.jobs.length);
        const hasLoadedTail = previousJobs.length > headCount;
        update({
          profiles: asProfiles(profilesResult),
          jobs: mergeHeadJobs(previousJobs, page),
          jobsTotal: page.total,
          jobsHasMore: hasLoadedTail ? state.jobsHasMore : page.hasMore,
          jobsNextOffset: hasLoadedTail ? state.jobsNextOffset : page.nextOffset,
          scheduler: asScheduler(schedulerResult),
          issues: asIssues(issuesResult),
          loading: false,
          lastUpdatedAt: new Date().toISOString(),
        });
      } else {
        update({
          profiles: asProfiles(profilesResult),
          jobs: [...page.jobs],
          jobsTotal: page.total,
          jobsHasMore: page.hasMore,
          jobsNextOffset: page.nextOffset,
          scheduler: asScheduler(schedulerResult),
          issues: asIssues(issuesResult),
          loading: false,
          lastUpdatedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      if (token !== refreshToken) return;
      update({ loading: false, error: errorText(error) });
    }
  };

  const loadMoreJobs = async (): Promise<void> => {
    if (loadingMore || !state.jobsHasMore || state.jobsNextOffset === null) return;
    const offset = state.jobsNextOffset;
    const requestToken = jobsRequestToken;
    loadingMore = true;
    try {
      const page = normalizePage(await invoke(BATCH_COMMANDS.listJobs, jobsArgs(offset)));
      if (requestToken !== jobsRequestToken || state.jobsNextOffset !== offset || page.offset !== offset) return;
      const byId = new Map(state.jobs.map((job) => [job.jobId, job]));
      for (const job of page.jobs) byId.set(job.jobId, job);
      update({
        jobs: [...byId.values()],
        jobsTotal: page.total,
        jobsHasMore: page.hasMore,
        jobsNextOffset: page.nextOffset,
        lastUpdatedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (requestToken === jobsRequestToken) update({ error: errorText(error) });
    } finally {
      loadingMore = false;
    }
  };

  const selectJob = async (jobId: string | null): Promise<void> => {
    update({ selectedJobId: jobId, selectedDetails: null, error: null });
    if (!jobId) return;
    try {
      const details = await invoke(BATCH_COMMANDS.getJobDetails, { jobId });
      update({ selectedDetails: asDetails(details) });
    } catch (error) {
      update({ error: errorText(error) });
    }
  };

  const createProfile = async (input: BatchProfileInput): Promise<void> => {
    update({ busyAction: BATCH_COMMANDS.createProfile, error: null });
    try {
      await invoke(BATCH_COMMANDS.createProfile, input);
      await refresh();
    } catch (error) {
      update({ error: errorText(error) });
    } finally {
      update({ busyAction: null });
    }
  };

  const pickFolder = async (): Promise<void> => {
    try {
      const result = await invoke<unknown>('dialog:openDirectory');
      const record = asRecord(result);
      const path = typeof result === 'string'
        ? result
        : typeof record?.path === 'string'
          ? record.path
          : null;
      if (!path) return;
      const name = path.split(/[\\/]/).filter(Boolean).pop() || 'Batch folder';
      await createProfile({ name, sourcePath: path, enabled: true, recursive: true, config: {} });
    } catch (error) {
      update({ error: errorText(error) });
    }
  };

  const runCommand = async (method: BatchBusyAction, args?: unknown): Promise<void> => {
    update({ busyAction: method, error: null });
    try {
      await invoke(method, args);
      await refresh();
    } catch (error) {
      update({ error: errorText(error) });
    } finally {
      update({ busyAction: null });
    }
  };

  const startPolling = (intervalMs = 1500): (() => void) => {
    if (pollingTimer) clearInterval(pollingTimer);
    const tick = () => {
      if (pollingInFlight) return;
      pollingInFlight = true;
      void refresh({ preserveLoadedJobs: true }).finally(() => { pollingInFlight = false; });
    };
    pollingTimer = setInterval(tick, Math.max(250, intervalMs));
    return () => {
      if (pollingTimer) clearInterval(pollingTimer);
      pollingTimer = null;
    };
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    loadMoreJobs,
    setFilter: (filter) => {
      update({ filter, jobs: [], jobsTotal: 0, jobsHasMore: false, jobsNextOffset: null });
      void refresh();
    },
    setQuery: (query) => {
      update({ query, jobs: [], jobsTotal: 0, jobsHasMore: false, jobsNextOffset: null });
      if (queryTimer) clearTimeout(queryTimer);
      queryTimer = setTimeout(() => {
        queryTimer = null;
        void refresh();
      }, 150);
    },
    selectJob,
    createProfile,
    pickFolder,
    scan: () => runCommand(BATCH_COMMANDS.scan),
    start: () => runCommand(BATCH_COMMANDS.start),
    pauseAfterCurrent: () => runCommand(BATCH_COMMANDS.pauseAfterCurrent),
    resume: () => runCommand(BATCH_COMMANDS.resume),
    drain: () => runCommand(BATCH_COMMANDS.drain),
    retry: (jobId) => runCommand(BATCH_COMMANDS.retry, { jobId }),
    cancel: (jobId) => runCommand(BATCH_COMMANDS.cancel, { jobId }),
    startPolling,
  };
}

export const batchStore = createBatchStore();

export function useBatchStore(store: BatchStore = batchStore): BatchStoreSnapshot {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
