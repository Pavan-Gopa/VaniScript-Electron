import React, { useState } from 'react';
import { Settings as Gear } from 'lucide-react';
import { Logo } from './Logo';

interface ConfigPanelProps {
  fileName: string;
  onStart: (cfg: SessionConfig) => void;
  onCancel: () => void;
}

export interface SessionConfig {
  date: string;
  location: string;
  lecturer: string;
  participants: string;
  targetLang: string;
  formats: string[];
  provider: 'gemini' | 'openai';
}

const LANGS = [
  { value: 'same', label: 'Keep original (Same)' },
  { value: 'Russian', label: 'Russian' },
  { value: 'English', label: 'English' },
  { value: 'Hindi', label: 'Hindi' },
  { value: 'Spanish', label: 'Spanish' },
];

const FORMATS = ['SRT', 'VTT', 'TXT', 'Markdown'];

function extractDate(name: string) {
  const m = name.match(/\b(\d{4}[-._]\d{2}[-._]\d{2}|\d{8})\b/);
  return m?.[0] ?? '';
}
function extractLecturer(name: string) {
  const m = name.match(/\b((?:[A-Z][a-z]+\s*){1,4}(?:Swami|Maharaja|Das|Goswami|Thakur|Prabhu))\b/i);
  return m?.[0]?.trim() ?? '';
}

export function ConfigPanel({ fileName, onStart, onCancel }: ConfigPanelProps) {
  const [cfg, setCfg] = useState<SessionConfig>({
    date: extractDate(fileName),
    location: '',
    lecturer: extractLecturer(fileName),
    participants: '',
    targetLang: 'same',
    formats: ['TXT'],
    provider: 'gemini',
  });

  const toggleFormat = (f: string) =>
    setCfg(p => ({
      ...p,
      formats: p.formats.includes(f) ? p.formats.filter(x => x !== f) : [...p.formats, f],
    }));

  const upd = (patch: Partial<SessionConfig>) => setCfg(p => ({ ...p, ...patch }));

  return (
    <div className="main-screen">
      <div className="logo-header" style={{ marginBottom: 20 }}>
        <div className="logo-wrap">
          <Logo className="logo-img" />
          <span className="logo-name">VaniScript</span>
        </div>
        <p className="logo-tagline">
          Professional Audio Transcription &amp; Translation Engine with<br />extreme verbatim accuracy.
        </p>
      </div>

      <div className="config-panel">
        <div className="config-title">
          <Gear size={18} />
          Engine Configuration
        </div>

        <div className="field-group">
          <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginBottom: 4 }}>Audio Metadata</p>
          <div className="field-row">
            <div className="field">
              <label>Date</label>
              <input value={cfg.date} onChange={e => upd({ date: e.target.value })} placeholder="" />
            </div>
            <div className="field">
              <label>Location</label>
              <input value={cfg.location} onChange={e => upd({ location: e.target.value })} placeholder="" />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Lecturer</label>
              <input value={cfg.lecturer} onChange={e => upd({ lecturer: e.target.value })} placeholder="His Holiness..." />
            </div>
            <div className="field">
              <label>Interviewer / Participants</label>
              <input value={cfg.participants} onChange={e => upd({ participants: e.target.value })} placeholder="" />
            </div>
          </div>

          <div className="field-row" style={{ marginTop: 4 }}>
            <div className="field">
              <label>Target Language</label>
              <select value={cfg.targetLang} onChange={e => upd({ targetLang: e.target.value })}>
                {LANGS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Output Formats</label>
              <div className="format-btns">
                {FORMATS.map(f => (
                  <button
                    key={f}
                    className={`format-btn ${cfg.formats.includes(f) ? 'active' : ''}`}
                    onClick={() => toggleFormat(f)}
                  >{f}</button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="config-actions">
          <button className="btn-cancel" onClick={onCancel}>Cancel</button>
          <button
            className="btn-start"
            onClick={() => onStart(cfg)}
          >
            Initialize Engine
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>
        </div>
      </div>

      <div className="app-footer" style={{ marginTop: 20 }}>
        © 2026 VaniScript Audio Processor • Version 1.0.0<br />
        Optimized for Gaudiya Vaishnava Philosophical Lexicon &amp; Technical Terminology
      </div>
    </div>
  );
}
