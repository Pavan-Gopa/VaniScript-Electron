export const PERFORMANCE_SCHEMA_VERSION = 1;

export const PERFORMANCE_BUDGETS = Object.freeze({
  projectSummaryPageLimit: 50,
  projectSummaryPageBytes: 256 * 1024,
  projectOuterDomNodes: 32,
  expandedChunkDomNodes: 56,
  batchRequestLimit: 250,
  batchQueueDomRows: 40,
  p95BatchPageMs: 160,
  batchPageBytes: 1024 * 1024,
  documentProjectionRows: 80,
  previewMaxBytes: 64 * 1024 * 1024,
  assistantMessageLimit: 100,
  assistantFlushWindowMs: 16.7,
  autosaveDebounceMs: 900,
  p95ProjectFirstPageMs: 100,
  p95RouteSwitchMs: 200,
  p95DocumentProjectionMs: 250,
  p95ActiveEditCommitMs: 16.7,
  p95VirtualScrollMs: 16.7,
  p95AssistantFlushMs: 16.7,
  mediaCloneHeapBytes: 128 * 1024 * 1024,
});

export const PERFORMANCE_CEILINGS = Object.freeze({
  projectFirstPageMs: 200,
  routeSwitchMs: 400,
  batchPageMs: 320,
  documentProjectionMs: 500,
  activeEditCommitMs: 50,
  virtualScrollMs: 50,
  assistantFlushMs: 50,
  mediaCloneHeapBytes: 192 * 1024 * 1024,
});

export interface PerformanceSample {
  name: string;
  durationMs: number;
  fixtureScale?: number;
  status?: 'pass' | 'fail';
}

export interface PerformanceSink {
  enabled: boolean;
  mark(name: string, fixtureScale?: number): () => PerformanceSample | null;
  record(sample: PerformanceSample): void;
  samples(): readonly PerformanceSample[];
}

function now(): number {
  return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
}

/** Optional numeric sink; production leaves it disabled and allocation-free. */
export function createPerformanceSink(enabled = false): PerformanceSink {
  const entries: PerformanceSample[] = [];
  return {
    enabled,
    mark(name, fixtureScale) {
      if (!enabled) return () => null;
      const startedAt = now();
      return () => {
        const sample = { name, fixtureScale, durationMs: Math.max(0, now() - startedAt) };
        entries.push(sample);
        return sample;
      };
    },
    record(sample) {
      if (enabled && Number.isFinite(sample.durationMs)) entries.push({ ...sample });
    },
    samples: () => entries,
  };
}

const disabledSink = createPerformanceSink(false);

export function recordPerformance(sample: PerformanceSample): void {
  disabledSink.record(sample);
}

export function percentile(samples: readonly number[], percentileValue: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[rank];
}

export function boundedWindowCount(start: number, end: number, hardLimit: number): number {
  return Math.max(0, Math.min(hardLimit, Math.max(0, Math.floor(end) - Math.floor(start))));
}

export function boundedPreviewLength(byteLength: number, maxBytes = PERFORMANCE_BUDGETS.previewMaxBytes): number {
  if (!Number.isFinite(byteLength) || byteLength < 0) return 0;
  return Math.min(Math.floor(byteLength), Math.max(0, Math.floor(maxBytes)));
}

export function satisfiesPerformanceInvariants(values: {
  projectDomNodes: number;
  chunkDomNodes: number;
  batchRequestLimit: number;
  batchDomRows: number;
  documentRows: number;
  assistantMessages: number;
  previewBytes: number;
}): boolean {
  return values.projectDomNodes <= PERFORMANCE_BUDGETS.projectOuterDomNodes
    && values.chunkDomNodes <= PERFORMANCE_BUDGETS.expandedChunkDomNodes
    && values.batchRequestLimit <= PERFORMANCE_BUDGETS.batchRequestLimit
    && values.batchDomRows <= PERFORMANCE_BUDGETS.batchQueueDomRows
    && values.documentRows <= PERFORMANCE_BUDGETS.documentProjectionRows
    && values.assistantMessages <= PERFORMANCE_BUDGETS.assistantMessageLimit
    && values.previewBytes <= PERFORMANCE_BUDGETS.previewMaxBytes;
}
