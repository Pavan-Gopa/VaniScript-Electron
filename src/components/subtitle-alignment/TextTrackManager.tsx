import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { TextOverlayBlock, TextOverlayTrack } from '../../lib/shorts-reels';
import { formatPlaybackClock } from '../../lib/karaoke';

type Props = {
  tracks: TextOverlayTrack[];
  currentSec: number;
  durationSec: number;
  onChange: (tracks: TextOverlayTrack[]) => void;
};

function makeTrack(index: number): TextOverlayTrack {
  return {
    id: `text_track_${Date.now()}_${index}`,
    name: `Text Track ${index + 1}`,
    blocks: [],
  };
}

function makeBlock(currentSec: number, durationSec: number): TextOverlayBlock {
  const startSec = Math.min(Math.max(0, currentSec), Math.max(0, durationSec - 2));
  return {
    id: `text_block_${Date.now()}`,
    startSec,
    endSec: Math.min(durationSec, startSec + 3),
    text: '',
  };
}

export function TextTrackManager({ tracks, currentSec, durationSec, onChange }: Props) {
  const canAddTrack = tracks.length < 3;
  return (
    <section className="alignment-layer-section">
      <div className="alignment-layer-head">
        <div>
          <h4>Text overlays</h4>
          <p>CTA, speaker names, references, or event notes. Max 3 tracks.</p>
        </div>
        <button
          type="button"
          disabled={!canAddTrack}
          onClick={() => onChange([...tracks, makeTrack(tracks.length)])}
        >
          <Plus size={14} /> Text Track
        </button>
      </div>
      {tracks.length === 0 ? (
        <em className="alignment-layer-empty">No text tracks yet.</em>
      ) : tracks.map((track, trackIndex) => (
        <div className="alignment-layer-card" key={track.id}>
          <div className="alignment-layer-title">
            <input
              value={track.name}
              onChange={(event) => onChange(tracks.map((item) => item.id === track.id ? { ...item, name: event.currentTarget.value } : item))}
            />
            <button type="button" onClick={() => onChange(tracks.filter((item) => item.id !== track.id))}>
              <Trash2 size={13} />
            </button>
          </div>
          <div className="alignment-layer-actions">
            <label>
              <input
                type="checkbox"
                checked={!track.hidden}
                onChange={(event) => onChange(tracks.map((item) => item.id === track.id ? { ...item, hidden: !event.currentTarget.checked } : item))}
              />
              Visible
            </label>
            <button
              type="button"
              onClick={() => onChange(tracks.map((item) => item.id === track.id ? { ...item, blocks: [...item.blocks, makeBlock(currentSec, durationSec)] } : item))}
            >
              <Plus size={13} /> Add Text Block
            </button>
          </div>
          {track.blocks.length === 0 ? (
            <em className="alignment-layer-empty">No blocks on this track.</em>
          ) : track.blocks.map((block) => (
            <div className="alignment-text-block-editor" key={block.id}>
              <textarea
                placeholder="[ Empty Text Block ]"
                value={block.text}
                onChange={(event) => onChange(tracks.map((item) => item.id === track.id ? {
                  ...item,
                  blocks: item.blocks.map((candidate) => candidate.id === block.id ? { ...candidate, text: event.currentTarget.value } : candidate),
                } : item))}
              />
              <div className="alignment-layer-time-row">
                <label>
                  <span>Start</span>
                  <input
                    type="number"
                    min={0}
                    max={durationSec}
                    step={0.05}
                    value={block.startSec.toFixed(2)}
                    onChange={(event) => {
                      const startSec = Math.min(Math.max(0, Number(event.currentTarget.value)), Math.max(0, block.endSec - 0.1));
                      onChange(tracks.map((item) => item.id === track.id ? {
                        ...item,
                        blocks: item.blocks.map((candidate) => candidate.id === block.id ? { ...candidate, startSec } : candidate),
                      } : item));
                    }}
                  />
                </label>
                <label>
                  <span>End</span>
                  <input
                    type="number"
                    min={0}
                    max={durationSec}
                    step={0.05}
                    value={block.endSec.toFixed(2)}
                    onChange={(event) => {
                      const endSec = Math.min(durationSec, Math.max(block.startSec + 0.1, Number(event.currentTarget.value)));
                      onChange(tracks.map((item) => item.id === track.id ? {
                        ...item,
                        blocks: item.blocks.map((candidate) => candidate.id === block.id ? { ...candidate, endSec } : candidate),
                      } : item));
                    }}
                  />
                </label>
                <span>{formatPlaybackClock(block.startSec)} → {formatPlaybackClock(block.endSec)}</span>
                <button type="button" onClick={() => onChange(tracks.map((item) => item.id === track.id ? {
                  ...item,
                  blocks: item.blocks.filter((candidate) => candidate.id !== block.id),
                } : item))}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
          <small>Track {trackIndex + 1} uses the current subtitle style unless a future preset overrides it.</small>
        </div>
      ))}
    </section>
  );
}
