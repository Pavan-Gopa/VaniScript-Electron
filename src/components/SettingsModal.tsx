import React, { useState, useCallback, useRef } from 'react';
import { AppSettings, UsageStats } from '../types';
import { DEFAULT_SETTINGS, saveUsage } from '../services/storage';
import { X, Eye, EyeOff } from 'lucide-react';

const TABS = ['API Keys', 'Models', 'Appearance', 'Chunking', 'Transcription', 'Statistics'];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="s-field">
      <span className="s-label">{label}</span>
      {children}
    </div>
  );
}

function ApiKey({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <Field label={label}>
      <div className="s-input-wrap">
        <input
          type={show ? 'text' : 'password'}
          className="s-input"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
        />
        <button className="s-eye" onClick={() => setShow(p => !p)}>
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </Field>
  );
}

interface Props { settings: AppSettings; usage: UsageStats; onSave: (s: AppSettings) => void; onClose: () => void; }

export function SettingsModal({ settings, usage, onSave, onClose }: Props) {
  const [s, setS] = useState<AppSettings>({ ...settings });
  const [tab, setTab] = useState(0);
  const upd = (p: Partial<AppSettings>) => setS(prev => ({ ...prev, ...p }));

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2>⚙️ Settings</h2>
          <button className="modal-close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="modal-tabs">
          {TABS.map((t, i) => (
            <button key={t} className={`modal-tab ${tab === i ? 'active' : ''}`} onClick={() => setTab(i)}>{t}</button>
          ))}
        </div>

        <div className="modal-body">

          {/* API Keys */}
          {tab === 0 && (
            <div className="s-section">
              <div className="s-card" style={{ gap: 14 }}>
                <ApiKey label="Google Gemini API Key" value={s.geminiKey} onChange={v => upd({ geminiKey: v })} placeholder="AIza..." />
                <ApiKey label="OpenAI API Key" value={s.openaiKey} onChange={v => upd({ openaiKey: v })} placeholder="sk-..." />
                <ApiKey label="Anthropic API Key" value={s.anthropicKey} onChange={v => upd({ anthropicKey: v })} placeholder="sk-ant-..." />
              </div>
              <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)', marginTop: 10, lineHeight: 1.6 }}>
                Keys are stored locally and never sent anywhere except the respective API provider.
              </p>
            </div>
          )}

          {/* Models */}
          {tab === 1 && (
            <div>
              <div className="s-section">
                <p className="s-section-title">Transcription</p>
                <div className="s-card">
                  <Field label="Default Provider">
                    <select className="s-input s-select" value={s.transcriptionProvider} onChange={e => upd({ transcriptionProvider: e.target.value as any })}>
                      <option value="gemini">Google Gemini (Cloud)</option>
                      <option value="openai">OpenAI Whisper (Cloud)</option>
                      <option value="whisper-local">Whisper Local (Offline)</option>
                    </select>
                  </Field>
                </div>
              </div>
              <div className="s-section">
                <p className="s-section-title">Translation</p>
                <div className="s-card">
                  <Field label="Default Provider">
                    <select className="s-input s-select" value={s.translationProvider} onChange={e => upd({ translationProvider: e.target.value as any })}>
                      <option value="gemini">Google Gemini</option>
                      <option value="openai">OpenAI GPT</option>
                      <option value="none">No Translation</option>
                    </select>
                  </Field>
                </div>
              </div>
            </div>
          )}

          {/* Appearance */}
          {tab === 2 && (
            <div>
              <div className="s-section">
                <p className="s-section-title">Color Theme</p>
                <div className="s-theme-grid">
                  {(['dark', 'light'] as const).map(t => (
                    <button key={t} className={`s-theme-btn ${s.theme === t ? 'active' : ''}`} onClick={() => upd({ theme: t })}>
                      <span className="emoji">{t === 'dark' ? '🌙' : '☀️'}</span>
                      <span className="name">{t === 'dark' ? 'Dark' : 'Light'}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="s-section">
                <p className="s-section-title">Font Size</p>
                <div className="s-pills">
                  {(['sm', 'md', 'lg', 'xl'] as const).map(sz => (
                    <button key={sz} className={`s-pill ${s.fontSize === sz ? 'active' : ''}`} onClick={() => upd({ fontSize: sz })}>
                      {sz === 'sm' ? 'Small' : sz === 'md' ? 'Medium' : sz === 'lg' ? 'Large' : 'X-Large'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Chunking — LARGEST TAB, sets modal height */}
          {tab === 3 && (
            <div>
              <div className="s-section">
                <p className="s-section-title">Chunk Duration</p>
                <div className="s-card">
                  <div>
                    <div className="s-slider-row">
                      <span className="s-label">Target Duration</span>
                      <span className="s-badge">{s.chunkDurationMin} min</span>
                    </div>
                    <input type="range" min={2} max={20} step={1} value={s.chunkDurationMin} onChange={e => upd({ chunkDurationMin: +e.target.value })} />
                    <div className="s-range-labels"><span>2 min</span><span>20 min</span></div>
                  </div>
                </div>
              </div>
              <div className="s-section">
                <p className="s-section-title">Slice Mode</p>
                <div className="s-card">
                  <div className="s-pills">
                    <button className={`s-pill ${s.sliceMode === 'silence' ? 'active' : ''}`} onClick={() => upd({ sliceMode: 'silence' })}>🔇 By Silence (Smart)</button>
                    <button className={`s-pill ${s.sliceMode === 'fixed' ? 'active' : ''}`} onClick={() => upd({ sliceMode: 'fixed' })}>⏱ Fixed Intervals</button>
                  </div>
                  <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', lineHeight: 1.5 }}>
                    {s.sliceMode === 'silence'
                      ? 'Cuts placed at natural speech pauses. Recommended.'
                      : 'Cuts every N minutes regardless of speech content.'}
                  </p>
                </div>
              </div>
              {s.sliceMode === 'silence' && (
                <div className="s-section">
                  <p className="s-section-title">Silence Detection</p>
                  <div className="s-card">
                    <div>
                      <div className="s-slider-row">
                        <span className="s-label">Silence Threshold</span>
                        <span className="s-badge">{s.silenceThreshDb} dB</span>
                      </div>
                      <input type="range" min={-40} max={-6} step={1} value={s.silenceThreshDb} onChange={e => upd({ silenceThreshDb: +e.target.value })} />
                      <div className="s-range-labels"><span>-40 dB</span><span>-6 dB</span></div>
                    </div>
                    <div>
                      <div className="s-slider-row">
                        <span className="s-label">Minimum Pause</span>
                        <span className="s-badge">{s.minSilenceMs} ms</span>
                      </div>
                      <input type="range" min={100} max={2000} step={100} value={s.minSilenceMs} onChange={e => upd({ minSilenceMs: +e.target.value })} />
                      <div className="s-range-labels"><span>100ms</span><span>2000ms</span></div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Transcription */}
          {tab === 4 && (
            <div>
              <div className="s-section">
                <p className="s-section-title">Language Defaults</p>
                <div className="s-card">
                  <Field label="Default Source Language">
                    <select className="s-input s-select" value={s.defaultSourceLang} onChange={e => upd({ defaultSourceLang: e.target.value })}>
                      <option value="auto">Auto-Detect</option>
                      <option value="bn">Bengali</option>
                      <option value="en">English</option>
                      <option value="ru">Russian</option>
                      <option value="hi">Hindi</option>
                    </select>
                  </Field>
                  <Field label="Default Translation Target">
                    <select className="s-input s-select" value={s.defaultTargetLang} onChange={e => upd({ defaultTargetLang: e.target.value })}>
                      <option value="same">Same (No Translation)</option>
                      <option value="Russian">Russian</option>
                      <option value="English">English</option>
                      <option value="Hindi">Hindi</option>
                    </select>
                  </Field>
                </div>
              </div>
              <div style={{ background: 'rgba(245,166,35,0.07)', border: '1px solid rgba(245,166,35,0.2)', borderRadius: 10, padding: '12px 14px' }}>
                <p style={{ fontSize: 12, color: 'rgba(245,166,35,0.9)', lineHeight: 1.7 }}>
                  🕉 Pre-optimized for Gaudiya Vaishnava terminology — Sanskrit transliteration, Acharya names, Scripture references.
                </p>
              </div>
            </div>
          )}

          {/* Statistics */}
          {tab === 5 && (
            <div>
              <p className="s-section-title">API Usage by Provider</p>
              {Object.keys(usage).length === 0 ? (
                <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.3)', textAlign: 'center', paddingTop: 40 }}>No usage recorded yet.</p>
              ) : Object.entries(usage).map(([provider, stats]) => (
                <div key={provider} className="s-stats-item">
                  <div className="s-stats-header">
                    <span className="s-stats-name">{provider}</span>
                    <span className="s-badge">{stats.sessions} sessions</span>
                  </div>
                  <div className="s-stats-grid">
                    <div className="s-stats-cell"><div className="val">{stats.inputTokens.toLocaleString()}</div><div className="lbl">Input tokens</div></div>
                    <div className="s-stats-cell"><div className="val">{stats.outputTokens.toLocaleString()}</div><div className="lbl">Output tokens</div></div>
                    <div className="s-stats-cell"><div className="val">{stats.audioMinutes.toFixed(1)}</div><div className="lbl">Audio min</div></div>
                  </div>
                </div>
              ))}
              <button className="btn-danger-sm" style={{ marginTop: 12 }} onClick={() => { saveUsage({}); window.location.reload(); }}>Reset Statistics</button>
            </div>
          )}

        </div>

        <div className="modal-footer">
          <button className="btn-ghost-sm" onClick={() => setS({ ...DEFAULT_SETTINGS })}>Reset Defaults</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-ghost-sm" onClick={onClose}>Cancel</button>
            <button className="btn-save" onClick={() => { onSave(s); onClose(); }}>Save Settings</button>
          </div>
        </div>
      </div>
    </div>
  );
}
