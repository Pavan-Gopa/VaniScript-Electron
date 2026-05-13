import React, { useRef } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import type { LogoOverlaySettings } from '../../lib/shorts-reels';

type FileWithPath = File & { path?: string };

type Props = {
  logo?: LogoOverlaySettings;
  onChange: (logo?: LogoOverlaySettings) => void;
};

function fileSource(file: File): string {
  return (file as FileWithPath).path || URL.createObjectURL(file);
}

export function LogoManager({ logo, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <section className="alignment-layer-section">
      <div className="alignment-layer-head">
        <div>
          <h4>Logo</h4>
          <p>Fixed top-left overlay. Position stays inside safe margins.</p>
        </div>
        <button type="button" onClick={() => inputRef.current?.click()}>
          <ImagePlus size={14} /> Upload Logo
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/svg+xml,image/webp"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (!file) return;
          onChange({
            id: logo?.id || `logo_${Date.now()}`,
            src: fileSource(file),
            name: file.name,
            size: logo?.size ?? 1,
            opacity: logo?.opacity ?? 1,
            hidden: false,
          });
        }}
      />
      {logo?.src ? (
        <div className="alignment-layer-card">
          <div className="alignment-layer-title">
            <span>{logo.name || 'Logo'}</span>
            <button type="button" onClick={() => onChange(undefined)} title="Remove logo">
              <Trash2 size={13} />
            </button>
          </div>
          <label>
            <span>Size</span>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={logo.size}
              onChange={(event) => onChange({ ...logo, size: Number(event.currentTarget.value) })}
            />
            <b>{Math.round(logo.size * 100)}%</b>
          </label>
          <label>
            <span>Opacity</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={logo.opacity}
              onChange={(event) => onChange({ ...logo, opacity: Number(event.currentTarget.value) })}
            />
            <b>{Math.round(logo.opacity * 100)}%</b>
          </label>
        </div>
      ) : (
        <em className="alignment-layer-empty">No logo uploaded.</em>
      )}
    </section>
  );
}
