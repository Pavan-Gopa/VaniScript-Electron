import React, { useRef } from 'react';
import { Music, Plus, Trash2 } from 'lucide-react';
import type { ExtraAudioTrack } from '../../lib/shorts-reels';

type FileWithPath = File & { path?: string };

type Props = {
  tracks: ExtraAudioTrack[];
  durationSec: number;
  onChange: (tracks: ExtraAudioTrack[]) => void;
};

function fileSource(file: File): string {
  const diskPath = (file as FileWithPath).path;
  return diskPath ? encodeURI(`file://${diskPath}`) : URL.createObjectURL(file);
}

function makeTrack(file: File, index: number, durationSec: number): ExtraAudioTrack {
  return {
    id: `audio_track_${Date.now()}_${index}`,
    name: file.name || `Audio Track ${index + 1}`,
    src: fileSource(file),
    previewSrc: URL.createObjectURL(file),
    startSec: 0,
    trimStartSec: 0,
    trimEndSec: 0,
    volume: 0.5,
    fadeInSec: 0,
    fadeOutSec: 0,
  };
}

export function AudioTrackManager({ tracks, durationSec, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const canAdd = tracks.length < 3;
  return (
    <section className="alignment-layer-section">
      <div className="alignment-layer-head">
        <div>
          <h4>Extra audio</h4>
          <p>Music, ambient sound, intro, or outro. Max 3 tracks.</p>
        </div>
        <button type="button" disabled={!canAdd} onClick={() => inputRef.current?.click()}>
          <Plus size={14} /> Audio Track
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="audio/mp3,audio/mpeg,audio/wav,audio/x-wav,audio/m4a,audio/aac"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (!file || !canAdd) return;
          onChange([...tracks, makeTrack(file, tracks.length, durationSec)]);
        }}
      />
      {tracks.length === 0 ? (
        <em className="alignment-layer-empty">No extra audio tracks.</em>
      ) : tracks.map((track) => (
        <div className="alignment-layer-card" key={track.id}>
          <div className="alignment-layer-title">
            <span><Music size={13} /> {track.name}</span>
            <button type="button" onClick={() => onChange(tracks.filter((item) => item.id !== track.id))}>
              <Trash2 size={13} />
            </button>
          </div>
          <div className="alignment-layer-actions">
            <label>
              <input
                type="checkbox"
                checked={!track.muted}
                onChange={(event) => onChange(tracks.map((item) => item.id === track.id ? { ...item, muted: !event.currentTarget.checked } : item))}
              />
              Audible
            </label>
          </div>
          {[
            ['Start', 'startSec', 0, durationSec, 0.05],
            ['Trim In', 'trimStartSec', 0, durationSec, 0.05],
            ['Trim Out', 'trimEndSec', 0, durationSec, 0.05],
            ['Fade In', 'fadeInSec', 0, 10, 0.1],
            ['Fade Out', 'fadeOutSec', 0, 10, 0.1],
            ['Volume', 'volume', 0, 1, 0.05],
          ].map(([label, key, min, max, step]) => (
            <label key={String(key)}>
              <span>{label}</span>
              <input
                type="range"
                min={Number(min)}
                max={Number(max)}
                step={Number(step)}
                value={Number(track[key as keyof ExtraAudioTrack])}
                onChange={(event) => onChange(tracks.map((item) => item.id === track.id ? {
                  ...item,
                  [key as string]: Number(event.currentTarget.value),
                } : item))}
              />
              <b>{key === 'volume' ? `${Math.round(track.volume * 100)}%` : `${Number(track[key as keyof ExtraAudioTrack]).toFixed(1)}s`}</b>
            </label>
          ))}
        </div>
      ))}
    </section>
  );
}
