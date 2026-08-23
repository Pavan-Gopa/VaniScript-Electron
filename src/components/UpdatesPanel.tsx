import React, { useEffect } from 'react';
import type { UpdateUserAction } from '../../shared/contracts/updates.ts';
import {
  UPDATE_BRIDGE_DEFERRED,
  blockerLabel,
  updatesStore,
  useUpdatesStore,
  type UpdatesStore,
} from '../stores/updatesStore';

export interface UpdatesPanelProps {
  store?: UpdatesStore;
}

const STATE_LABELS: Record<string, string> = {
  idle: 'Idle',
  checking: 'Checking for updates',
  upToDate: 'Up to date',
  available: 'Update available',
  downloading: 'Downloading',
  verifying: 'Verifying download',
  readyToInstall: 'Ready to install',
  installing: 'Installing',
  failed: 'Update failed',
};

const ACTION_LABELS: Record<UpdateUserAction, string> = {
  checkNow: 'Check now',
  downloadNow: 'Download',
  installNow: 'Install',
  skipVersion: 'Skip version',
  remindLater: 'Remind me later',
  cancelDownload: 'Cancel download',
  retry: 'Retry',
};

const ACTION_TEST_IDS: Record<UpdateUserAction, string> = {
  checkNow: 'updates-check',
  downloadNow: 'updates-download',
  installNow: 'updates-install',
  skipVersion: 'updates-skip',
  remindLater: 'updates-remind',
  cancelDownload: 'updates-cancel',
  retry: 'updates-retry',
};

const ACTION_STYLES: Record<UpdateUserAction, React.CSSProperties> = {
  checkNow: {},
  downloadNow: { background: 'rgba(245,166,35,0.16)', borderColor: 'rgba(245,166,35,0.42)' },
  installNow: { background: 'rgba(64,232,135,0.15)', borderColor: 'rgba(64,232,135,0.42)' },
  skipVersion: { background: 'transparent' },
  remindLater: { background: 'transparent' },
  cancelDownload: { background: 'transparent' },
  retry: { background: 'rgba(255,112,112,0.14)', borderColor: 'rgba(255,112,112,0.4)' },
};

const buttonStyle: React.CSSProperties = {
  minHeight: 31,
  padding: '6px 10px',
  borderRadius: 7,
  border: '1px solid rgba(255,255,255,0.17)',
  background: 'rgba(255,255,255,0.07)',
  color: 'var(--text-1)',
  fontSize: 11,
  fontWeight: 700,
  cursor: 'pointer',
};

const mutedStyle: React.CSSProperties = {
  color: 'var(--text-2)',
  fontSize: 11,
};

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return 'Size unavailable';
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function safeDetailsText(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return 'Details unavailable';
  }
}

function ActionButton({
  action,
  enabled,
  onAction,
}: {
  action: UpdateUserAction;
  enabled: boolean;
  onAction: (action: UpdateUserAction) => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      data-testid={ACTION_TEST_IDS[action]}
      data-update-action={action}
      disabled={!enabled}
      aria-disabled={!enabled}
      onClick={() => onAction(action)}
      style={{
        ...buttonStyle,
        ...ACTION_STYLES[action],
        opacity: enabled ? 1 : 0.45,
        cursor: enabled ? 'pointer' : 'not-allowed',
      }}
    >
      {ACTION_LABELS[action]}
    </button>
  );
}

export function UpdatesPanel({ store }: UpdatesPanelProps): React.ReactElement {
  const effectiveStore = store ?? updatesStore;
  const updates = useUpdatesStore(effectiveStore);
  useEffect(() => {
    void effectiveStore.refresh();
  }, [effectiveStore]);

  const descriptor = updates.descriptor;
  const critical = updates.presentation.emphasis === 'critical';
  const stateLabel = STATE_LABELS[updates.state] || updates.state;
  const invokeAction = (action: UpdateUserAction) => {
    void updatesAction(effectiveStore, action);
  };
  const progress = updates.download ? Math.round(updates.download.fraction * 100) : null;
  const installBlocked = updates.blockers.length > 0;

  return (
    <section
      data-testid="updates-panel"
      aria-label="Application updates"
      style={{
        display: 'grid',
        gap: 12,
        padding: 14,
        borderRadius: 10,
        border: critical ? '1px solid rgba(255,112,112,0.58)' : '1px solid rgba(255,255,255,0.12)',
        background: critical ? 'rgba(255,84,84,0.08)' : 'rgba(255,255,255,0.035)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
          <strong style={{ fontSize: 14 }}>Application updates</strong>
          <span data-testid="updates-current-version" style={mutedStyle}>
            Current version {updates.currentVersion} · build {updates.currentBuild} · {updates.channel}
          </span>
        </div>
        <span
          data-testid="updates-state"
          aria-live="polite"
          style={{
            color: critical ? '#ffb7b7' : updates.state === 'failed' ? '#ff9696' : 'var(--text-2)',
            fontSize: 10,
            fontWeight: 800,
            textTransform: 'uppercase',
            textAlign: 'right',
          }}
        >
          {stateLabel}
        </span>
      </div>

      {updates.bridgeStatus === 'deferred' && (
        <div
          data-testid="updates-bridge"
          role="status"
          style={{
            padding: '9px 10px',
            borderRadius: 7,
            background: 'rgba(255,255,255,0.05)',
            color: 'var(--text-2)',
            fontSize: 11,
          }}
        >
          {updates.bridgeMessage || UPDATE_BRIDGE_DEFERRED}
        </div>
      )}

      {descriptor ? (
        <div
          data-testid="updates-descriptor"
          style={{
            display: 'grid',
            gap: 6,
            padding: 11,
            borderRadius: 8,
            border: critical ? '1px solid rgba(255,112,112,0.38)' : '1px solid rgba(255,255,255,0.1)',
            background: critical ? 'rgba(255,112,112,0.1)' : 'rgba(0,0,0,0.12)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <strong style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{descriptor.title}</strong>
            <span style={{ ...mutedStyle, whiteSpace: 'nowrap' }}>v{descriptor.version} · build {descriptor.build}</span>
          </div>
          {critical && (
            <strong data-testid="updates-critical" style={{ color: '#ffb7b7', fontSize: 11 }}>
              Critical update — readiness and save protections still apply.
            </strong>
          )}
          {!critical && descriptor.informational && (
            <span data-testid="updates-informational" style={{ color: 'var(--text-2)', fontSize: 11 }}>Informational release</span>
          )}
          {descriptor.notes && <p style={{ ...mutedStyle, margin: 0, whiteSpace: 'pre-wrap' }}>{descriptor.notes}</p>}
          <span style={mutedStyle}>
            {descriptor.platform}/{descriptor.arch} · {descriptor.channel} · {formatBytes(descriptor.sizeBytes)}
            {descriptor.publishDate ? ` · published ${formatDate(descriptor.publishDate)}` : ''}
          </span>
          {descriptor.infoUrl && (
            <a href={descriptor.infoUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontSize: 11 }}>
              Release notes
            </a>
          )}
        </div>
      ) : updates.state === 'upToDate' ? (
        <div data-testid="updates-up-to-date" style={mutedStyle}>You are up to date.</div>
      ) : null}

      {progress !== null && (updates.state === 'downloading' || updates.state === 'verifying' || updates.state === 'readyToInstall') && (
        <div data-testid="updates-progress" style={{ display: 'grid', gap: 5 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', ...mutedStyle }}>
            <span>{updates.state === 'verifying' ? 'Verifying download' : 'Download progress'}</span>
            <strong>{progress}%</strong>
          </div>
          <div aria-label={`${progress}% downloaded`} style={{ height: 5, borderRadius: 99, overflow: 'hidden', background: 'rgba(255,255,255,0.11)' }}>
            <div style={{ width: `${progress}%`, height: '100%', background: critical ? '#ff7070' : 'var(--accent)' }} />
          </div>
        </div>
      )}

      {updates.blockers.length > 0 && (
        <div
          data-testid="updates-blockers"
          role="alert"
          aria-label="Update readiness blockers"
          style={{
            display: 'grid',
            gap: 6,
            padding: '9px 10px',
            borderRadius: 8,
            border: '1px solid rgba(255,176,32,0.4)',
            background: 'rgba(255,176,32,0.1)',
          }}
        >
          <strong style={{ color: '#ffd37a', fontSize: 11 }}>Install is waiting for these blockers to clear</strong>
          {updates.blockers.map((blocker, index) => (
            <div key={`${blocker.category}-${blocker.message}-${index}`} data-testid="updates-blocker" style={{ display: 'grid', gap: 2, ...mutedStyle }}>
              <strong style={{ color: 'var(--text-1)' }}>{blocker.label || blockerLabel(blocker.category)}</strong>
              <span>{blocker.message}</span>
              {blocker.details !== undefined && <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 10 }}>{safeDetailsText(blocker.details)}</span>}
            </div>
          ))}
          <span style={{ ...mutedStyle, fontSize: 10 }}>After they clear, press Install again.</span>
        </div>
      )}

      {updates.error && (
        <div
          data-testid="updates-error"
          role="alert"
          style={{
            display: 'grid',
            gap: 4,
            padding: '9px 10px',
            borderRadius: 8,
            border: `1px solid ${updates.error.code === 'TAMPERED' ? 'rgba(255,112,112,0.56)' : 'rgba(255,176,32,0.4)'}`,
            background: updates.error.code === 'TAMPERED' ? 'rgba(255,84,84,0.12)' : 'rgba(255,176,32,0.1)',
          }}
        >
          <strong style={{ color: updates.error.code === 'TAMPERED' ? '#ffb7b7' : '#ffd37a' }}>
            {updates.error.code === 'TAMPERED' ? 'Update rejected: tampered feed or artifact' : updates.error.code}
          </strong>
          <span style={mutedStyle}>{updates.error.message}</span>
          {updates.error.details !== undefined && (
            <span data-testid="updates-error-details" style={{ ...mutedStyle, fontFamily: 'var(--font-mono, monospace)', fontSize: 10 }}>
              {safeDetailsText(updates.error.details)}
            </span>
          )}
        </div>
      )}

      {updates.capabilities?.userMessage && (
        <div data-testid="updates-capabilities" style={mutedStyle}>
          {updates.capabilities.userMessage}
        </div>
      )}

      <div data-testid="updates-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
        <ActionButton action="checkNow" enabled={updates.actions.checkNow} onAction={invokeAction} />
        <ActionButton action="downloadNow" enabled={updates.actions.downloadNow} onAction={invokeAction} />
        <ActionButton action="installNow" enabled={updates.actions.installNow && !installBlocked} onAction={invokeAction} />
        <ActionButton action="skipVersion" enabled={updates.actions.skipVersion} onAction={invokeAction} />
        <ActionButton action="remindLater" enabled={updates.actions.remindLater} onAction={invokeAction} />
        <ActionButton action="cancelDownload" enabled={updates.actions.cancelDownload} onAction={invokeAction} />
        <ActionButton action="retry" enabled={updates.actions.retry} onAction={invokeAction} />
      </div>

      {updates.receipt && (
        <div data-testid="updates-receipt" style={{ display: 'grid', gap: 3, ...mutedStyle }}>
          <strong style={{ color: 'var(--text-1)', fontSize: 11 }}>Last update</strong>
          <span>
            {updates.receipt.fromVersion} → {updates.receipt.toVersion} · {updates.receipt.outcome} · {formatDate(updates.receipt.timestamp)}
          </span>
        </div>
      )}

      {updates.loading && <span data-testid="updates-loading" style={mutedStyle}>Refreshing update status…</span>}
    </section>
  );
}

async function updatesAction(updates: UpdatesStore, action: UpdateUserAction): Promise<void> {
  if (action === 'checkNow') return updates.checkNow();
  if (action === 'downloadNow') return updates.downloadNow();
  if (action === 'installNow') return updates.installNow();
  if (action === 'skipVersion') return updates.skipVersion();
  if (action === 'remindLater') return updates.remindLater();
  if (action === 'cancelDownload') return updates.cancelDownload();
  return updates.retry();
}
