import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { TextOverlayTrack } from '../../lib/shorts-reels';

type Props = {
  tracks: TextOverlayTrack[];
  onChange: (tracks: TextOverlayTrack[]) => void;
};

function makeTrack(index: number): TextOverlayTrack {
  return {
    id: `text_track_${Date.now()}_${index}`,
    name: `Text Track ${index + 1}`,
    blocks: [],
  };
}

export function TextTrackManager({ tracks, onChange }: Props) {
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
          </div>
          <small>Track {trackIndex + 1}. Add and edit its blocks from the center timeline editor.</small>
        </div>
      ))}
    </section>
  );
}
