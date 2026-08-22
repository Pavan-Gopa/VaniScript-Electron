import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronRight,
  CirclePause,
  FolderOpen,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
  XCircle,
} from 'lucide-react';
import type { BatchJob, BatchProfile } from '../../shared/contracts/batch.ts';
import {
  batchStore,
  filterBatchJobs,
  getBatchBadgeState,
  getBatchControlState,
  getVirtualRows,
  useBatchStore,
  type BatchStore,
} from '../stores/batchStore';

const FILTERS = ['all', 'pending', 'running', 'completed', 'failed', 'collision', 'cancelled'] as const;
export interface BatchWorkspaceProps {
  store?: BatchStore;
  onBack?: () => void;
}

const ROW_HEIGHT = 58;
const VIEWPORT_HEIGHT = 560;

const buttonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  minHeight: 32,
  padding: '7px 11px',
  borderRadius: 8,
  border: '1px solid var(--bg-card-border)',
  background: 'rgba(255,255,255,0.055)',
  color: 'var(--text-1)',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 700,
};

const mutedStyle: React.CSSProperties = { color: 'var(--text-2)', fontSize: 11 };

function stateLabel(state: BatchJob['state']): string {
  if (state === 'done') return 'completed';
  if (state === 'blockedOutputCollision') return 'collision';
  return state;
}

function stateColor(state: BatchJob['state']): string {
  if (state === 'done') return '#40e887';
  if (state === 'failed' || state === 'blockedOutputCollision') return '#ff7070';
  if (state === 'running') return 'var(--accent)';
  if (state === 'cancelled') return '#b9a5ff';
  return 'var(--text-1)';
}

function badgeColor(badge: string): string {
  if (badge === 'failed') return '#ff7070';
  if (badge === 'paused') return '#b9a5ff';
  if (badge === 'running') return 'var(--accent)';
  return 'var(--text-2)';
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function profileLabel(profile: BatchProfile): string {
  return `${profile.name} · ${profile.recursive ? 'recursive' : 'top-level only'}`;
}

function JsonBlock({ value }: { value: unknown }): React.ReactElement {
  return (
    <pre style={{
      margin: 0,
      padding: 9,
      borderRadius: 7,
      background: 'rgba(0,0,0,0.2)',
      color: 'var(--text-1)',
      fontFamily: 'var(--font-mono, monospace)',
      fontSize: 10,
      lineHeight: 1.45,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      maxHeight: 150,
      overflow: 'auto',
    }}>
      {JSON.stringify(value ?? {}, null, 2)}
    </pre>
  );
}

function IssueStrip({ issues }: { issues: readonly { type: string; message: string; path?: string }[] }): React.ReactElement | null {
  if (issues.length === 0) return null;
  return (
    <div
      role="status"
      aria-label="Batch issues"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 9,
        padding: '9px 12px',
        borderRadius: 9,
        border: '1px solid rgba(255,112,112,0.34)',
        background: 'rgba(255,92,92,0.09)',
        color: '#ffb7b7',
        fontSize: 11,
      }}
    >
      <AlertTriangle size={15} aria-hidden="true" style={{ flex: '0 0 auto', marginTop: 1 }} />
      <div style={{ display: 'grid', gap: 4 }}>
        <strong>Batch needs attention</strong>
        {issues.slice(0, 4).map((issue, index) => (
          <span key={`${issue.type}-${issue.message}-${index}`}>
            {issue.type}: {issue.message}{issue.path ? ` · ${issue.path}` : ''}
          </span>
        ))}
        {issues.length > 4 && <span>+{issues.length - 4} more issues</span>}
      </div>
    </div>
  );
}

function QueueRow({
  job,
  selected,
  virtualTop,
  onSelect,
}: {
  job: BatchJob;
  selected: boolean;
  virtualTop: number;
  onSelect: () => void;
}): React.ReactElement {
  const progress = Math.round(Math.max(0, Math.min(1, job.progress)) * 100);
  return (
    <button
      type="button"
      data-testid="batch-queue-row"
      aria-label={`Batch job ${job.sourcePath}`}
      aria-pressed={selected}
      onClick={onSelect}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: ROW_HEIGHT,
        transform: `translateY(${virtualTop}px)`,
        display: 'grid',
        gridTemplateColumns: 'minmax(170px, 1.35fr) minmax(150px, 1fr) 92px 114px 70px',
        alignItems: 'center',
        gap: 10,
        padding: '7px 11px',
        textAlign: 'left',
        border: 0,
        borderBottom: '1px solid rgba(255,255,255,0.055)',
        background: selected ? 'rgba(245,166,35,0.12)' : 'transparent',
        color: 'var(--text-1)',
        cursor: 'pointer',
      }}
    >
      <span style={{ minWidth: 0, display: 'grid', gap: 2 }}>
        <strong title={job.sourcePath} style={{ color: 'var(--text-0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }}>
          {job.sourcePath}
        </strong>
        <span style={{ ...mutedStyle, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={job.outputPath || undefined}>→ {job.outputPath || 'no output'}</span>
        <span style={mutedStyle}>{job.jobId.slice(0, 12)} · {formatTimestamp(job.updatedAt)}</span>
      </span>
      <span style={{ minWidth: 0, display: 'grid', gap: 4 }}>
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, fontSize: 10 }}>
          <span>{job.phase}</span>
          <strong>{progress}%</strong>
        </span>
        <span aria-label={`${progress}% complete`} style={{ height: 5, borderRadius: 99, overflow: 'hidden', background: 'rgba(255,255,255,0.1)' }}>
          <span style={{ display: 'block', width: `${progress}%`, height: '100%', borderRadius: 'inherit', background: stateColor(job.state) }} />
        </span>
      </span>
      <span style={{ color: stateColor(job.state), fontSize: 10, fontWeight: 800, textTransform: 'uppercase' }}>{stateLabel(job.state)}</span>
      <span style={{ fontSize: 10 }}>attempt {job.attempt}/{job.maxAttempts}</span>
      <span style={{ fontSize: 10, textAlign: 'right' }}>{job.lastError ? <XCircle size={14} color="#ff7070" aria-label="has error" /> : '—'}</span>
    </button>
  );
}

export function BatchQueueTable({
  jobs,
  selectedJobId,
  onSelect,
}: {
  jobs: readonly BatchJob[];
  selectedJobId: string | null;
  onSelect: (jobId: string) => void;
}): React.ReactElement {
  const [scrollTop, setScrollTop] = useState(0);
  const virtual = getVirtualRows(jobs, scrollTop, VIEWPORT_HEIGHT, ROW_HEIGHT, 8);
  return (
    <div style={{ minWidth: 0, display: 'grid', gap: 0 }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(170px, 1.35fr) minmax(150px, 1fr) 92px 114px 70px',
        gap: 10,
        padding: '6px 11px',
        color: 'var(--text-2)',
        fontSize: 10,
        fontWeight: 800,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
      }}>
        <span>Source</span><span>Progress / phase</span><span>State</span><span>Attempts</span><span>Error</span>
      </div>
      <div
        data-testid="batch-queue-viewport"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        style={{ height: VIEWPORT_HEIGHT, overflowY: 'auto', border: '1px solid var(--bg-card-border)', borderRadius: 9, background: 'rgba(0,0,0,0.1)' }}
      >
        <div style={{ position: 'relative', height: virtual.totalHeight, minHeight: 56 }}>
          {virtual.rows.map((job, index) => (
            <QueueRow
              key={job.jobId}
              job={job}
              virtualTop={(virtual.start + index) * ROW_HEIGHT}
              selected={job.jobId === selectedJobId}
              onSelect={() => onSelect(job.jobId)}
            />
          ))}
          {jobs.length === 0 && <div style={{ padding: 28, color: 'var(--text-2)', textAlign: 'center', fontSize: 12 }}>No jobs match this view.</div>}
        </div>
      </div>
      <span style={{ ...mutedStyle, paddingTop: 6 }}>{jobs.length.toLocaleString()} jobs · virtual window {virtual.start + 1}–{virtual.end}</span>
    </div>
  );
}

function JobDetails({ store, job }: { store: BatchStore; job: BatchJob | null }): React.ReactElement {
  const state = useBatchStore(store);
  const details = state.selectedDetails;
  if (!job) {
    return <div style={{ ...mutedStyle, padding: 16 }}>Select a job to inspect its fingerprint, config, checkpoints, and events.</div>;
  }
  const canRetry = job.state === 'failed' || job.state === 'blockedOutputCollision';
  const canCancel = job.state === 'pending' || job.state === 'running';
  return (
    <div style={{ display: 'grid', gap: 12, minHeight: 0, overflow: 'auto', paddingRight: 2 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 15, color: 'var(--text-0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.sourcePath}</h2>
          <span style={mutedStyle}>{job.jobId}</span>
        </div>
        <span style={{ color: stateColor(job.state), fontSize: 10, fontWeight: 800, textTransform: 'uppercase' }}>{stateLabel(job.state)}</span>
      </div>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
        {canRetry && <button type="button" style={buttonStyle} disabled={state.busyAction !== null} onClick={() => void store.retry(job.jobId)}><RotateCcw size={13} /> Retry</button>}
        {canCancel && <button type="button" style={{ ...buttonStyle, color: '#ff9b9b' }} disabled={state.busyAction !== null} onClick={() => void store.cancel(job.jobId)}><XCircle size={13} /> Cancel</button>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, fontSize: 10 }}>
        <span><b>Output</b><br />{job.outputPath || '—'}</span>
        <span><b>Updated</b><br />{formatTimestamp(job.updatedAt)}</span>
        <span><b>Started</b><br />{formatTimestamp(job.startedAt)}</span>
        <span><b>Completed</b><br />{formatTimestamp(job.completedAt)}</span>
      </div>
      {job.lastError && <div style={{ color: '#ff9b9b', fontSize: 11 }}><b>Last error:</b> {job.lastError}</div>}
      <section>
        <h3 style={{ margin: '0 0 6px', fontSize: 11 }}>Fingerprint</h3>
        <JsonBlock value={job.sourceFingerprint} />
      </section>
      <section>
        <h3 style={{ margin: '0 0 6px', fontSize: 11 }}>Config snapshot</h3>
        <JsonBlock value={job.configSnapshot} />
      </section>
      <section>
        <h3 style={{ margin: '0 0 6px', fontSize: 11 }}>Checkpoints ({details?.checkpoints.length ?? 0})</h3>
        <JsonBlock value={details?.checkpoints ?? []} />
      </section>
      <section>
        <h3 style={{ margin: '0 0 6px', fontSize: 11 }}>Events ({details?.events.length ?? 0})</h3>
        <JsonBlock value={(details?.events ?? []).slice(-12)} />
      </section>
    </div>
  );
}

export function BatchWorkspace({ store = batchStore, onBack }: BatchWorkspaceProps): React.ReactElement {
  const state = useBatchStore(store);
  const controls = getBatchControlState(state.scheduler);
  const badge = getBatchBadgeState(state.scheduler, state.jobs);
  const [dragging, setDragging] = useState(false);
  const visibleJobs = useMemo(() => filterBatchJobs(state.jobs, state.filter, state.query), [state.jobs, state.filter, state.query]);
  const selectedJob = state.jobs.find((job) => job.jobId === state.selectedJobId) || null;
  const droppedPathRef = useRef<string | null>(null);

  useEffect(() => {
    void store.refresh();
    return store.startPolling();
  }, [store]);

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0] as (File & { path?: string }) | undefined;
    const path = file?.path;
    if (!path || droppedPathRef.current === path) return;
    droppedPathRef.current = path;
    const name = path.split(/[\\/]/).filter(Boolean).pop() || 'Batch folder';
    void store.createProfile({ name, sourcePath: path, enabled: true, recursive: true, config: {} });
  };

  return (
    <section
      aria-label="Batch workspace"
      data-testid="batch-workspace"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 6,
        display: 'grid',
        gridTemplateRows: 'auto auto auto minmax(0, 1fr)',
        gap: 12,
        padding: '58px 30px 22px',
        overflow: 'hidden',
        background: 'var(--bg, #0a0a12)',
        color: 'var(--text-0)',
      }}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {onBack && <button type="button" aria-label="Back to Projects" style={{ ...buttonStyle, padding: '7px 9px' }} onClick={onBack}><ChevronRight size={15} style={{ transform: 'rotate(180deg)' }} /></button>}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <h1 style={{ margin: 0, fontSize: 22, color: 'var(--text-0)' }}>Batch</h1>
              <span data-testid="batch-status-badge" style={{ color: badgeColor(badge), border: `1px solid ${badgeColor(badge)}`, borderRadius: 99, padding: '3px 8px', fontSize: 10, fontWeight: 800, textTransform: 'uppercase' }}>{badge}</span>
            </div>
            <p style={{ ...mutedStyle, margin: '4px 0 0' }}>Folder profiles, durable queue, and recoverable transcription jobs.</p>
          </div>
        </div>
        <button type="button" style={buttonStyle} onClick={() => void store.refresh()} disabled={state.loading}><RefreshCw size={14} className={state.loading ? 'spin' : undefined} /> Refresh</button>
      </header>

      <IssueStrip issues={state.issues} />

      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" style={buttonStyle} onClick={() => void store.pickFolder()} disabled={state.busyAction !== null}><FolderOpen size={14} /> Add Folder</button>
          <button type="button" style={{ ...buttonStyle, color: 'var(--accent)' }} onClick={() => void store.scan()} disabled={!controls.canScan || state.busyAction !== null}><Search size={14} /> Scan</button>
          <button type="button" style={{ ...buttonStyle, color: 'var(--accent)' }} onClick={() => void store.start()} disabled={!controls.canStart || state.busyAction !== null}><Play size={14} /> Start</button>
          <button type="button" style={buttonStyle} onClick={() => void store.pauseAfterCurrent()} disabled={!controls.canPauseAfterCurrent || state.busyAction !== null}><CirclePause size={14} /> Pause after current</button>
          <button type="button" style={buttonStyle} onClick={() => void store.resume()} disabled={!controls.canResume || state.busyAction !== null}><Pause size={14} /> Resume</button>
          <button type="button" style={{ ...buttonStyle, color: '#ff9b9b' }} onClick={() => void store.drain()} disabled={!controls.canDrain || state.busyAction !== null}><Square size={13} /> Stop after current</button>
          <span style={{ ...mutedStyle, marginLeft: 'auto' }}>Mode: {state.scheduler.mode}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          {FILTERS.map((filter) => (
            <button
              type="button"
              key={filter}
              aria-pressed={state.filter === filter}
              style={{ ...buttonStyle, minHeight: 27, padding: '5px 9px', fontSize: 10, color: state.filter === filter ? 'var(--accent)' : 'var(--text-2)', borderColor: state.filter === filter ? 'var(--accent)' : 'var(--bg-card-border)' }}
              onClick={() => store.setFilter(filter)}
            >
              {filter}
            </button>
          ))}
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto', minWidth: 180 }}>
            <Search size={13} color="var(--text-2)" />
            <input
              aria-label="Filter batch jobs"
              value={state.query}
              onChange={(event) => store.setQuery(event.target.value)}
              placeholder="Search paths, phase, errors…"
              style={{ width: '100%', border: '1px solid var(--bg-card-border)', borderRadius: 7, padding: '6px 8px', background: 'rgba(255,255,255,0.045)', color: 'var(--text-0)', fontSize: 11 }}
            />
          </label>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr) minmax(260px, 320px)', gap: 13, minHeight: 0 }}>
        <aside style={{ minHeight: 0, overflowY: 'auto', display: 'grid', alignContent: 'start', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 12 }}>Folder profiles ({state.profiles.length})</h2>
          {state.profiles.length === 0 ? (
            <div style={{ ...mutedStyle, padding: 12, border: '1px dashed var(--bg-card-border)', borderRadius: 8 }}>Add a folder or drop one here to create a profile. Nothing starts automatically.</div>
          ) : state.profiles.map((profile) => (
            <div key={profile.profileId} style={{ padding: 10, borderRadius: 8, border: `1px solid ${profile.enabled ? 'var(--bg-card-border)' : 'rgba(255,255,255,0.04)'}`, background: 'rgba(255,255,255,0.035)', opacity: profile.enabled ? 1 : 0.55 }}>
              <strong style={{ display: 'block', fontSize: 11 }}>{profileLabel(profile)}</strong>
              <span title={profile.sourcePath} style={{ ...mutedStyle, display: 'block', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{profile.sourcePath}</span>
              <span style={{ ...mutedStyle, display: 'block', marginTop: 5 }}>{profile.enabled ? 'enabled' : 'disabled'} · updated {formatTimestamp(profile.updatedAt)}</span>
              <span style={{ ...mutedStyle, display: 'block', marginTop: 5 }}>config: {Object.keys(profile.config || {}).length > 0 ? Object.keys(profile.config).join(', ') : 'default'}</span>
            </div>
          ))}
          {dragging && <div style={{ padding: 12, borderRadius: 8, border: '1px dashed var(--accent)', color: 'var(--accent)', fontSize: 11 }}>Drop folder to add profile</div>}
        </aside>

        <main style={{ minWidth: 0, minHeight: 0, display: 'grid', alignContent: 'start' }}>
          <BatchQueueTable jobs={visibleJobs} selectedJobId={state.selectedJobId} onSelect={(jobId) => void store.selectJob(jobId)} />
        </main>

        <aside style={{ minWidth: 0, minHeight: 0, padding: 13, borderRadius: 10, border: '1px solid var(--bg-card-border)', background: 'rgba(255,255,255,0.035)' }}>
          <JobDetails store={store} job={selectedJob} />
        </aside>
      </div>
      {state.error && <div role="alert" style={{ position: 'absolute', left: 30, right: 30, bottom: 14, padding: '8px 11px', borderRadius: 7, background: 'rgba(255,92,92,0.14)', border: '1px solid rgba(255,112,112,0.35)', color: '#ffb7b7', fontSize: 11 }}>{state.error}</div>}
    </section>
  );
}
