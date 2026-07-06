import React, { useEffect, useState } from 'react';
import { parseTimestampToSeconds, secondsToShortsTimestamp, type ShortsClipPlan } from '../lib/shorts-reels';

type Props = {
  isOpen: boolean;
  plan: ShortsClipPlan | null;
  isBusy: boolean;
  onClose: () => void;
  onRegenerate: (startTimestamp: string, endTimestamp: string) => void;
};

function timestampInputToSeconds(value: string): number {
  return parseTimestampToSeconds(value);
}

function validateRange(
  startSec: number,
  endSec: number
): { ok: boolean; reason?: string } {
  if (endSec <= startSec) return { ok: false, reason: 'End must be after start.' };
  const duration = endSec - startSec;
  if (duration < 10) return { ok: false, reason: 'Clip must be at least 10 seconds.' };
  if (duration > 300) return { ok: false, reason: 'Clip must be at most 5 minutes.' };
  return { ok: true };
}

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

  const startSec = timestampInputToSeconds(startValue);
  const endSec = timestampInputToSeconds(endValue);
  const durationSec = Math.max(0, endSec - startSec);
  const validation = validateRange(startSec, endSec);

  const originalStartSec = parseTimestampToSeconds(plan.start);
  const originalEndSec = parseTimestampToSeconds(plan.end);
  const originalDuration = Math.max(0, originalEndSec - originalStartSec);
  const delta = durationSec - originalDuration;

  const handleRegenerate = () => {
    if (!validation.ok || isBusy) return;
    onRegenerate(
      secondsToShortsTimestamp(startSec),
      secondsToShortsTimestamp(endSec)
    );
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
              Duration: <strong>{durationSec}s</strong>
              {delta !== 0 && (
                <span className={`replace-clip-delta ${delta > 0 ? 'longer' : 'shorter'}`}>
                  {delta > 0 ? `+${delta}s` : `${delta}s`}
                </span>
              )}
            </span>
          </div>

          {!validation.ok && validation.reason && (
            <div className="replace-clip-error">{validation.reason}</div>
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
            disabled={!validation.ok || isBusy}
            onClick={handleRegenerate}
          >
            {isBusy ? 'Regenerating...' : 'Regenerate Clip'}
          </button>
        </div>
      </div>
    </div>
  );
}
