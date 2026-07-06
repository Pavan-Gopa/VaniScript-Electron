import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, Check, RefreshCw, Download } from 'lucide-react';
import { ChunkData, SessionState } from '../types';

interface ChunkReviewProps {
  session: SessionState;
  onUpdateChunk: (index: number, patch: Partial<ChunkData>) => void;
  onApprove: (index: number) => void;
  onExport: () => void;
}

export function ChunkReview({ session, onUpdateChunk, onApprove, onExport }: ChunkReviewProps) {
  const { chunks, currentChunkIndex } = session;
  const chunk = chunks[currentChunkIndex];
  const total = chunks.length;
  const approved = chunks.filter(c => c.approved).length;
  const progress = Math.round((approved / total) * 100);

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  if (!chunk) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Chunk navigation bar */}
      <div className="chunk-nav">
        <span className="chunk-counter">
          Chunk {currentChunkIndex + 1} / {total}
        </span>
        <div className="progress-bar" style={{ flex: 1 }}>
          <div className="progress-fill" style={{ width: `${progress}%` }} />
        </div>
        <span className="badge badge-accent">{approved}/{total} approved</span>
        <span className="text-muted text-xs">{formatTime(chunk.startSec)} – {formatTime(chunk.endSec)}</span>
        {approved === total && (
          <button className="btn btn-primary" onClick={onExport}>
            <Download size={14} /> Export All
          </button>
        )}
      </div>

      {/* Audio player */}
      {chunk.filePath && (
        <div className="audio-player" style={{ margin: '12px 20px 0', flexShrink: 0 }}>
          <audio controls src={`file://${chunk.filePath}`} style={{ width: '100%', height: 32 }} />
        </div>
      )}

      {/* Status overlay for pending/processing */}
      {(chunk.status === 'pending' || chunk.status === 'processing') && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          <div className="spinner spinner-lg" />
          <p style={{ fontSize: 14, color: 'var(--text-1)' }}>
            {chunk.status === 'pending' ? 'Waiting to process…' : 'Transcribing chunk…'}
          </p>
        </div>
      )}

      {/* Review panes */}
      {chunk.status === 'done' && (
        <div style={{ flex: 1, minHeight: 0, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="review-grid" style={{ flex: 1, minHeight: 0 }}>
            {/* Original */}
            <div className="review-pane">
              <div className="review-pane-header">
                <span className="review-pane-label">Original Transcription</span>
              </div>
              <textarea
                className="review-textarea"
                value={chunk.original}
                onChange={e => onUpdateChunk(currentChunkIndex, { original: e.target.value })}
              />
            </div>

            {/* Translation (if present) */}
            {session.targetLang !== 'none' && (
              <div className="review-pane">
                <div className="review-pane-header">
                  <span className="review-pane-label" style={{ color: 'var(--accent)' }}>
                    Translation → {session.targetLang}
                  </span>
                </div>
                <textarea
                  className="review-textarea"
                  value={chunk.translated}
                  onChange={e => onUpdateChunk(currentChunkIndex, { translated: e.target.value })}
                />
              </div>
            )}

            {/* Single pane if no translation */}
            {session.targetLang === 'none' && (
              <div className="review-pane" style={{ background: 'var(--bg-2)', borderRadius: 'var(--radius-md)', padding: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <p className="text-muted text-sm" style={{ textAlign: 'center' }}>
                  No translation configured.<br/>Set target language in Settings.
                </p>
              </div>
            )}
          </div>

          {/* Action bar */}
          <div className="flex items-center justify-between" style={{ flexShrink: 0 }}>
            <button
              className="btn btn-secondary"
              disabled={currentChunkIndex === 0}
              onClick={() => onApprove(currentChunkIndex - 1)}
            >
              <ChevronLeft size={16} /> Previous
            </button>

            <button className="btn btn-ghost" title="Re-transcribe this chunk">
              <RefreshCw size={14} /> Re-transcribe
            </button>

            <button
              className="btn btn-primary btn-lg"
              onClick={() => {
                onUpdateChunk(currentChunkIndex, { approved: true });
                if (currentChunkIndex < total - 1) onApprove(currentChunkIndex + 1);
                else onExport();
              }}
            >
              {currentChunkIndex < total - 1 ? (
                <><Check size={16} /> Approve & Next <ChevronRight size={16} /></>
              ) : (
                <><Check size={16} /> Approve & Export</>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Error state */}
      {chunk.status === 'error' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <p style={{ color: 'var(--red)' }}>Transcription failed for this chunk.</p>
          <button className="btn btn-secondary"><RefreshCw size={14} /> Retry</button>
        </div>
      )}
    </div>
  );
}
