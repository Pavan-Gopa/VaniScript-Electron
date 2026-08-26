import React, { useEffect, useState } from 'react';
import { parseShortsTimestamp, validateShortsPlan, type ShortsClipPlan } from '../lib/shorts-reels';

type Props = {
  isOpen: boolean;
  plan: ShortsClipPlan | null;
  isBusy: boolean;
  onClose: () => void;
  onRegenerate: (startTimestamp: string, endTimestamp: string) => void;
};

export function ReplaceClipModal({
  isOpen,
  plan,
  isBusy,
  onClose,
  onRegenerate,
}: Props) {
  const [startValue, setStartValue] = useState('');
  const [endValue, setEndValue] = useState('');

  useEffect(() => {
    if (isOpen && plan) {
      setStartValue(plan.start);
      setEndValue(plan.end);
    }
  }, [isOpen, plan]);

  if (!isOpen || !plan) return null;

  const parsedStart = parseShortsTimestamp(startValue);
  const parsedEnd = parseShortsTimestamp(endValue);
  const canonicalStart = parsedStart.ok ? parsedStart.canonical : null;
  const canonicalEnd = parsedEnd.ok ? parsedEnd.canonical : null;
  const candidate = {
    ...plan,
    start: canonicalStart ?? startValue,
    end: canonicalEnd ?? endValue,
    timelineCuts: [],
  };
  const validation = validateShortsPlan(candidate, {
    minDurationSec: 10,
    maxDurationSec: 300,
    projection: 'source',
  });
  const validationIssue = validation.issues.find((issue) => issue.severity === 'error');
  const durationSec = validation.durationSec;
  const originalStart = parseShortsTimestamp(plan.start);
  const originalEnd = parseShortsTimestamp(plan.end);
  const originalDuration = originalStart.ok && originalEnd.ok
    && originalStart.seconds !== null && originalEnd.seconds !== null
    ? Math.max(0, originalEnd.seconds - originalStart.seconds)
    : null;
  const delta = durationSec !== null && originalDuration !== null ? durationSec - originalDuration : null;

  const handleRegenerate = () => {
    if (!validation.valid || canonicalStart === null || canonicalEnd === null || isBusy) return;
    onRegenerate(canonicalStart, canonicalEnd);
  };

  return (
    <div className="shorts-modal-backdrop" onMouseDown={onClose}>
      <div
        className="shorts-modal replace-clip-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="shorts-modal-head">
          <div>
            <h3>Replace Clip</h3>
            <p>
              Adjust the time range and regenerate subtitles for this clip.
              The language pairing ({plan.languageMode || 'target'}) is preserved.
            </p>
          </div>
          <button type="button" onClick={onClose}>×</button>
        </div>

        <div className="replace-clip-body">
          <div className="replace-clip-time-row">
            <label>
              <span className="replace-clip-label">Start time</span>
              <input
                type="text"
                className="replace-clip-input"
                value={startValue}
                onChange={(e) => setStartValue(e.currentTarget.value)}
                placeholder="04:56"
              />
              <span className="replace-clip-hint">
                Original: {plan.start}
              </span>
            </label>
            <label>
              <span className="replace-clip-label">End time</span>
              <input
                type="text"
                className="replace-clip-input"
                value={endValue}
                onChange={(e) => setEndValue(e.currentTarget.value)}
                placeholder="06:10"
              />
              <span className="replace-clip-hint">
                Original: {plan.end}
              </span>
            </label>
          </div>

          <div className="replace-clip-stats">
            <span>
              Duration: <strong>{durationSec === null ? '—' : `${durationSec}s`}</strong>
              {delta !== null && delta !== 0 && (
                <span className={`replace-clip-delta ${delta > 0 ? 'longer' : 'shorter'}`}>
                  {delta > 0 ? `+${delta}s` : `${delta}s`}
                </span>
              )}
            </span>
          </div>

          {validationIssue && (
            <div className="replace-clip-error">{validationIssue.code}: {validationIssue.message}</div>
          )}
        </div>

        <div className="shorts-modal-actions">
          <button
            type="button"
            className="btn-dl btn-dl-secondary"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-dl btn-dl-primary"
            disabled={!validation.valid || isBusy}
            onClick={handleRegenerate}
          >
            {isBusy ? 'Regenerating...' : 'Regenerate Clip'}
          </button>
        </div>
      </div>
    </div>
  );
}
