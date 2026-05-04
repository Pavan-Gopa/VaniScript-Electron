import React, { useState } from 'react';
import { X, Key, Cpu, Palette, Scissors, Mic, BarChart2, Eye, EyeOff } from 'lucide-react';
import { AppSettings, UsageStats } from '../types';
import { DEFAULT_SETTINGS } from '../services/storage';

interface SettingsModalProps {
  settings: AppSettings;
  usage: UsageStats;
  onSave: (s: AppSettings) => void;
  onClose: () => void;
}

const TABS = [
  { id: 'api', label: 'API Keys', icon: Key },
  { id: 'models', label: 'Models', icon: Cpu },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'chunking', label: 'Chunking', icon: Scissors },
  { id: 'transcription', label: 'Transcription', icon: Mic },
  { id: 'stats', label: 'Statistics', icon: BarChart2 },
] as const;

type TabId = typeof TABS[number]['id'];

function ApiKeyField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label className="label">{label}</label>
      <div style={{ position: 'relative' }}>
        <input
          type={show ? 'text' : 'password'}
          className="input"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder ?? 'Enter API key...'}
          style={{ paddingRight: 40, userSelect: 'text' }}
        />
        <button
          className="btn btn-ghost btn-icon"
          onClick={() => setShow(p => !p)}
          style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', padding: 4 }}
          title={show ? 'Hide' : 'Show'}
        >
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <p className="section-title">{title}</p>
      <div className="card card-sm" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {children}
      </div>
    </div>
  );
}

export function SettingsModal({ settings, usage, onSave, onClose }: SettingsModalProps) {
  const [s, setS] = useState<AppSettings>({ ...settings });
  const [activeTab, setActiveTab] = useState<TabId>('api');
  const upd = (patch: Partial<AppSettings>) => setS(p => ({ ...p, ...patch }));

  const handleSave = () => { onSave(s); onClose(); };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        {/* Header */}
        <div className="modal-header">
          <h2>⚙️ Settings</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose}><X size={18} /></button>
        </div>

        {/* Tabs */}
        <div className="tab-bar" style={{ overflowX: 'auto' }}>
          {TABS.map(t => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                className={`tab ${activeTab === t.id ? 'active' : ''}`}
                onClick={() => setActiveTab(t.id)}
              >
                <Icon size={13} style={{ marginRight: 5, verticalAlign: 'middle' }} />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="modal-body">
          <div className="modal-tab-content">

            {/* ── API Keys ── */}
            {activeTab === 'api' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                <Section title="Cloud Providers">
                  <ApiKeyField label="Google Gemini API Key" value={s.geminiKey} onChange={v => upd({ geminiKey: v })} placeholder="AIza..." />
                  <ApiKeyField label="OpenAI API Key" value={s.openaiKey} onChange={v => upd({ openaiKey: v })} placeholder="sk-..." />
                  <ApiKeyField label="Anthropic API Key" value={s.anthropicKey} onChange={v => upd({ anthropicKey: v })} placeholder="sk-ant-..." />
                </Section>
                <p className="text-xs text-muted mt-4" style={{ lineHeight: 1.6 }}>
                  Keys are stored locally on your device and never sent anywhere except the respective API provider.
                </p>
              </div>
            )}

            {/* ── Models ── */}
            {activeTab === 'models' && (
              <div>
                <Section title="Transcription Provider">
                  <div>
                    <label className="label">Default Provider</label>
                    <select className="input" value={s.transcriptionProvider} onChange={e => upd({ transcriptionProvider: e.target.value as any })}>
                      <option value="gemini">Google Gemini (Cloud)</option>
                      <option value="openai">OpenAI Whisper (Cloud)</option>
                      <option value="whisper-local">Whisper Local (Offline)</option>
                    </select>
                  </div>
                </Section>
                <Section title="Translation Provider">
                  <div>
                    <label className="label">Default Provider</label>
                    <select className="input" value={s.translationProvider} onChange={e => upd({ translationProvider: e.target.value as any })}>
                      <option value="gemini">Google Gemini</option>
                      <option value="openai">OpenAI GPT</option>
                      <option value="anthropic">Anthropic Claude</option>
                      <option value="ollama">Ollama (Local)</option>
                      <option value="none">No Translation</option>
                    </select>
                  </div>
                </Section>
                <div className="card card-sm mt-4" style={{ background: 'var(--accent-dim)', borderColor: 'var(--border-accent)' }}>
                  <p className="text-sm text-accent" style={{ lineHeight: 1.6 }}>
                    🕉 Local Whisper model management coming in the next update. Models will be downloaded once and stored on your device.
                  </p>
                </div>
              </div>
            )}

            {/* ── Appearance ── */}
            {activeTab === 'appearance' && (
              <div>
                <Section title="Color Theme">
                  <div className="grid-2">
                    {(['dark', 'light'] as const).map(t => (
                      <button
                        key={t}
                        onClick={() => upd({ theme: t })}
                        style={{
                          padding: '16px', borderRadius: 'var(--radius-md)',
                          border: `2px solid ${s.theme === t ? 'var(--accent)' : 'var(--border)'}`,
                          background: s.theme === t ? 'var(--accent-dim)' : 'var(--surface)',
                          cursor: 'pointer', transition: 'var(--transition)',
                        }}
                      >
                        <div style={{ fontSize: 24, marginBottom: 4 }}>{t === 'dark' ? '🌙' : '☀️'}</div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: s.theme === t ? 'var(--accent)' : 'var(--text-1)' }}>
                          {t === 'dark' ? 'Dark' : 'Light'}
                        </div>
                      </button>
                    ))}
                  </div>
                </Section>
                <Section title="Font Size">
                  <div className="pill-group">
                    {(['sm', 'md', 'lg', 'xl'] as const).map(sz => (
                      <button
                        key={sz}
                        className={`pill pill-accent ${s.fontSize === sz ? 'active' : ''}`}
                        onClick={() => upd({ fontSize: sz })}
                        style={{ flex: 1 }}
                      >
                        {sz === 'sm' ? 'Small' : sz === 'md' ? 'Medium' : sz === 'lg' ? 'Large' : 'X-Large'}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted">Preview: {s.fontSize === 'sm' ? '13px' : s.fontSize === 'md' ? '15px' : s.fontSize === 'lg' ? '17px' : '20px'}</p>
                </Section>
              </div>
            )}

            {/* ── Chunking ── */}
            {activeTab === 'chunking' && (
              <div>
                <Section title="Chunk Duration">
                  <div className="slider-wrap">
                    <div className="flex justify-between items-center">
                      <span className="label" style={{ margin: 0 }}>Target Duration</span>
                      <span className="badge badge-accent">{s.chunkDurationMin} min</span>
                    </div>
                    <input
                      type="range" min={2} max={20} step={1}
                      value={s.chunkDurationMin}
                      onChange={e => upd({ chunkDurationMin: Number(e.target.value) })}
                    />
                    <div className="slider-labels"><span>2 min</span><span>20 min</span></div>
                  </div>
                  <p className="text-xs text-muted">Lectures are split into chunks of approximately this duration before transcription.</p>
                </Section>
                <Section title="Slice Mode">
                  <div className="pill-group">
                    <button className={`pill pill-accent ${s.sliceMode === 'silence' ? 'active' : ''}`} onClick={() => upd({ sliceMode: 'silence' })} style={{ flex: 1 }}>
                      🔇 By Silence (Smart)
                    </button>
                    <button className={`pill pill-accent ${s.sliceMode === 'fixed' ? 'active' : ''}`} onClick={() => upd({ sliceMode: 'fixed' })} style={{ flex: 1 }}>
                      ⏱ Fixed Intervals
                    </button>
                  </div>
                  <p className="text-xs text-muted">
                    {s.sliceMode === 'silence'
                      ? 'Cuts are placed at natural pauses in speech. Recommended for lectures.'
                      : 'Cuts every N minutes regardless of speech. Faster but may cut mid-word.'}
                  </p>
                </Section>
                {s.sliceMode === 'silence' && (
                  <Section title="Silence Detection Parameters">
                    <div>
                      <div className="flex justify-between items-center mb-2">
                        <label className="label" style={{ margin: 0 }}>Silence Threshold</label>
                        <span className="badge badge-accent">{s.silenceThreshDb} dB</span>
                      </div>
                      <input type="range" min={-40} max={-6} step={1} value={s.silenceThreshDb} onChange={e => upd({ silenceThreshDb: Number(e.target.value) })} />
                      <div className="slider-labels"><span>-40 dB (sensitive)</span><span>-6 dB (strict)</span></div>
                    </div>
                    <div>
                      <div className="flex justify-between items-center mb-2">
                        <label className="label" style={{ margin: 0 }}>Minimum Pause Length</label>
                        <span className="badge badge-accent">{s.minSilenceMs} ms</span>
                      </div>
                      <input type="range" min={100} max={2000} step={100} value={s.minSilenceMs} onChange={e => upd({ minSilenceMs: Number(e.target.value) })} />
                      <div className="slider-labels"><span>100ms</span><span>2000ms</span></div>
                    </div>
                  </Section>
                )}
              </div>
            )}

            {/* ── Transcription ── */}
            {activeTab === 'transcription' && (
              <div>
                <Section title="Language Defaults">
                  <div>
                    <label className="label">Default Source Language</label>
                    <select className="input" value={s.defaultSourceLang} onChange={e => upd({ defaultSourceLang: e.target.value })}>
                      <option value="auto">Auto-Detect</option>
                      <option value="bn">Bengali (বাংলা)</option>
                      <option value="en">English</option>
                      <option value="ru">Russian</option>
                      <option value="hi">Hindi</option>
                      <option value="sa">Sanskrit</option>
                    </select>
                  </div>
                  <div>
                    <label className="label">Default Target Language (Translation)</label>
                    <select className="input" value={s.defaultTargetLang} onChange={e => upd({ defaultTargetLang: e.target.value })}>
                      <option value="none">No Translation</option>
                      <option value="Russian">Russian</option>
                      <option value="English">English</option>
                      <option value="Hindi">Hindi</option>
                      <option value="Spanish">Spanish</option>
                      <option value="French">French</option>
                      <option value="German">German</option>
                    </select>
                  </div>
                </Section>
                <div className="card card-sm mt-4" style={{ background: 'var(--accent-dim)', borderColor: 'var(--border-accent)' }}>
                  <p className="text-sm text-accent" style={{ lineHeight: 1.8 }}>
                    🕉 The engine is pre-optimized for Gaudiya Vaishnava terminology:<br/>
                    Sanskrit transliteration · Acharya names · Scripture references · Philosophical terms
                  </p>
                </div>
              </div>
            )}

            {/* ── Statistics ── */}
            {activeTab === 'stats' && (
              <div>
                <p className="section-title">API Usage by Provider</p>
                {Object.keys(usage).length === 0 ? (
                  <div className="card card-sm" style={{ textAlign: 'center', padding: '32px' }}>
                    <p className="text-muted text-sm">No usage recorded yet.</p>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {Object.entries(usage).map(([provider, stats]) => (
                      <div key={provider} className="card card-sm">
                        <div className="flex justify-between items-center mb-2">
                          <span style={{ fontSize: 13, fontWeight: 700, textTransform: 'capitalize' }}>{provider}</span>
                          <span className="badge badge-accent">{stats.sessions} sessions</span>
                        </div>
                        <div className="grid-3" style={{ gap: 8 }}>
                          <div>
                            <div className="text-xs text-muted">Input tokens</div>
                            <div className="font-mono text-sm">{stats.inputTokens.toLocaleString()}</div>
                          </div>
                          <div>
                            <div className="text-xs text-muted">Output tokens</div>
                            <div className="font-mono text-sm">{stats.outputTokens.toLocaleString()}</div>
                          </div>
                          <div>
                            <div className="text-xs text-muted">Audio (min)</div>
                            <div className="font-mono text-sm">{stats.audioMinutes.toFixed(1)}</div>
                          </div>
                        </div>
                        {stats.lastUsed && (
                          <p className="text-xs text-muted mt-2">Last used: {new Date(stats.lastUsed).toLocaleDateString()}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <button className="btn btn-danger mt-4 btn" onClick={() => { localStorage.removeItem('vs_usage_v1'); window.location.reload(); }}>
                  Reset Statistics
                </button>
              </div>
            )}

          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-between items-center" style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          <button className="btn btn-ghost" onClick={() => setS({ ...DEFAULT_SETTINGS })}>Reset to Defaults</button>
          <div className="flex gap-2">
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave}>Save Settings</button>
          </div>
        </div>
      </div>
    </div>
  );
}
