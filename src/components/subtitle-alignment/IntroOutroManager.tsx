import React, { useRef } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import type { IntroOutroOverlaySettings } from '../../lib/shorts-reels';

type Props = {
  type: 'intro' | 'outro';
  title: string;
  description: string;
  data?: IntroOutroOverlaySettings;
  onChange: (data?: IntroOutroOverlaySettings) => void;
};

function readImageDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Image could not be read.'));
    reader.readAsDataURL(file);
  });
}

export function IntroOutroManager({ type, title, description, data, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <section className="alignment-layer-section">
      <div className="alignment-layer-head">
        <div>
          <h4>{title}</h4>
          <p>{description}</p>
        </div>
        <button type="button" onClick={() => inputRef.current?.click()}>
          <ImagePlus size={14} /> Upload Graphic
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/svg+xml,image/webp"
        hidden
        onChange={async (event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (!file) return;
          const src = await readImageDataUrl(file);
          if (!src) return;
          onChange({
            id: data?.id || `${type}_${Date.now()}`,
            src,
            name: file.name,
            duration: data?.duration ?? 3,
            x: 50,
            y: data?.y ?? 50,
            scale: data?.scale ?? 0.5,
            animation: data?.animation ?? 'fade',
            speed: data?.speed ?? 1.0,
            hidden: false,
          });
        }}
      />
      {data?.src ? (
        <div className="alignment-layer-card">
          <div className="alignment-layer-title">
            <span>{data.name || `${type === 'intro' ? 'Intro' : 'Outro'} Graphic`}</span>
            <button type="button" onClick={() => onChange(undefined)} title={`Remove ${type}`}>
              <Trash2 size={13} />
            </button>
          </div>
          <label style={{ gridTemplateColumns: '140px minmax(0, 1fr) 58px' }}>
            <span>Duration</span>
            <input
              type="range"
              min={1}
              max={5}
              step={0.5}
              value={data.duration}
              onChange={(event) => onChange({ ...data, duration: Number(event.currentTarget.value) })}
            />
            <b>{data.duration.toFixed(1)}s</b>
          </label>
          <label style={{ gridTemplateColumns: '140px minmax(0, 1fr) 58px' }}>
            <span>Vertical Position (Y)</span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={data.y}
              onChange={(event) => onChange({ ...data, y: Number(event.currentTarget.value) })}
            />
            <b>{data.y}%</b>
          </label>
          <label style={{ gridTemplateColumns: '140px minmax(0, 1fr) 58px' }}>
            <span>Scale / Size</span>
            <input
              type="range"
              min={50}
              max={500}
              step={10}
              value={Math.round(data.scale * 100)}
              onChange={(event) => onChange({ ...data, scale: Number(event.currentTarget.value) / 100 })}
            />
            <b>{Math.round(data.scale * 100)}%</b>
          </label>
          <label style={{ gridTemplateColumns: '140px minmax(0, 1fr) 58px' }}>
            <span>Animation Speed</span>
            <input
              type="range"
              min={0}
              max={200}
              step={10}
              value={Math.round((data.speed ?? 1.0) * 100)}
              onChange={(event) => onChange({ ...data, speed: Number(event.currentTarget.value) / 100 })}
            />
            <b>{Math.round((data.speed ?? 1.0) * 100)}%</b>
          </label>
          <label style={{ gridTemplateColumns: '140px minmax(0, 1fr)' }}>
            <span>Animation Preset</span>
            <select
              value={data.animation ?? 'fade'}
              onChange={(event) => onChange({ ...data, animation: event.currentTarget.value as any })}
            >
              <option value="none">None</option>
              <option value="fade">Fade</option>
              <option value="pulse">Pulse</option>
              <option value="bounce">Jerk down</option>
            </select>
          </label>
        </div>
      ) : (
        <em className="alignment-layer-empty">No {type} graphic uploaded.</em>
      )}
    </section>
  );
}
