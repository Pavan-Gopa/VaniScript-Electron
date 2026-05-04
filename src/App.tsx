import React, { useState, useEffect, useRef } from 'react';
import { Settings } from 'lucide-react';
import { AppSettings, ChunkData, UsageStats } from './types';
import { loadSettings, saveSettings, loadUsage, saveUsage, applyTheme } from './services/storage';
import { transcribeChunkGemini, transcribeChunkOpenAI, fileToBase64 } from './services/transcription';
import { computeCutPoints, cutPointsToSeconds } from './services/smart-slicer';
import { SettingsModal } from './components/SettingsModal';
import { Workspace } from './components/Workspace';
import { ConfigPanel, SessionConfig } from './components/ConfigPanel';
import { Logo } from './components/Logo';

// ─── App screens ──────────────────────────────────────────────────────────────
type Screen = 'upload' | 'config' | 'processing' | 'review' | 'export';

// ─── Session data ──────────────────────────────────────────────────────────────
interface Session {
  sourceFile: string;
  sourceFileName: string;
  config: SessionConfig;
  chunks: ChunkData[];
  currentIndex: number;
  targetLang: string;
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [usage, setUsage] = useState<UsageStats>(() => loadUsage());
  const [showSettings, setShowSettings] = useState(false);
  const [screen, setScreen] = useState<Screen>('upload');
  const [sourceFile, setSourceFile] = useState('');
  const [sourceFileName, setSourceFileName] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [procMsg, setProcMsg] = useState('');
  const [procProgress, setProcProgress] = useState(0);
  const transcribingRef = useRef(false);

  // Apply theme
  useEffect(() => { applyTheme(settings.theme, settings.fontSize); }, [settings.theme, settings.fontSize]);

  const handleSaveSettings = (s: AppSettings) => { saveSettings(s); setSettings(s); };

  // ─── File selected → go to config ─────────────────────────────────────────
  const handleFileSelected = (path: string, name: string) => {
    setSourceFile(path);
    setSourceFileName(name);
    setScreen('config');
  };

  // ─── Start engine → process audio → review ────────────────────────────────
  const handleStartEngine = async (cfg: SessionConfig) => {
    setScreen('processing');
    setProcProgress(5);
    setProcMsg('Converting audio format…');

    try {
      // 1. Convert to WAV
      let wavPath = sourceFile;
      if (window.electronAPI) {
        const res = await window.electronAPI.ffmpegConvertToWav({ inputPath: sourceFile });
        if (!res.success) throw new Error('FFmpeg conversion failed');
        wavPath = res.outputPath;
      }
      setProcProgress(20);

      // 2. Duration
      let durationSec = 3600; // default fallback
      if (window.electronAPI) {
        const dur = await window.electronAPI.ffmpegGetDuration({ inputPath: wavPath });
        if (dur.success) durationSec = dur.durationSec;
      }
      setProcProgress(30);

      // 3. Cut points
      setProcMsg('Analyzing audio for optimal split points…');
      const targetMs = settings.chunkDurationMin * 60 * 1000;
      let cutSec: number[] = [];

      if (settings.sliceMode === 'silence' && window.electronAPI) {
        const buf = await window.electronAPI.readFileBuffer({ filePath: wavPath });
        if (buf.success) {
          const pcm = new Int16Array(buf.data, buf.byteOffset, buf.byteLength / 2);
          cutSec = cutPointsToSeconds(computeCutPoints(pcm, 16000, targetMs, settings.silenceThreshDb, settings.minSilenceMs));
        }
      } else {
        for (let t = settings.chunkDurationMin * 60; t < durationSec; t += settings.chunkDurationMin * 60) cutSec.push(t);
      }
      setProcProgress(50);

      // 4. Slice
      setProcMsg(`Splitting into ${cutSec.length + 1} chunks…`);
      let chunkPaths: string[] = [wavPath];
      if (window.electronAPI && cutSec.length > 0) {
        const res = await window.electronAPI.ffmpegSliceChunks({ inputPath: wavPath, cutPoints: cutSec });
        if (res.success) chunkPaths = res.chunkPaths;
      }
      setProcProgress(75);

      // 5. Build chunks
      const bounds = [0, ...cutSec, durationSec];
      const chunks: ChunkData[] = chunkPaths.map((fp, i) => ({
        index: i, filePath: fp,
        durationSec: bounds[i + 1] - bounds[i],
        startSec: bounds[i], endSec: bounds[i + 1],
        original: '', translated: '', status: 'pending', approved: false,
      }));
      setProcProgress(90);
      setProcMsg('Uploading audio and initializing Gemini AI…');

      const newSession: Session = {
        sourceFile, sourceFileName, config: cfg, chunks,
        currentIndex: 0,
        targetLang: cfg.targetLang,
      };
      setSession(newSession);
      setProcProgress(100);

      // Move to review and transcribe first chunk
      setScreen('review');
      transcribeChunk(newSession, 0, chunks[0], settings, cfg);

    } catch (err) {
      console.error('Processing failed:', err);
      // Return to config so user doesn't lose their work
      setScreen('config');
    }
  };

  // ─── Transcribe a single chunk (doesn't touch screen state) ───────────────
  const transcribeChunk = async (
    sess: Session,
    index: number,
    chunk: ChunkData,
    currentSettings: AppSettings,
    cfg: SessionConfig
  ) => {
    if (transcribingRef.current) return;
    transcribingRef.current = true;

    setSession(prev => {
      if (!prev) return prev;
      const c = [...prev.chunks];
      c[index] = { ...c[index], status: 'processing' };
      return { ...prev, chunks: c };
    });

    try {
      const apiKey = cfg.provider === 'openai' ? currentSettings.openaiKey : currentSettings.geminiKey;
      const transcConfig = {
        sourceLang: currentSettings.defaultSourceLang,
        targetLang: cfg.targetLang === 'same' ? '' : cfg.targetLang,
        speakerHint: cfg.lecturer,
        formats: cfg.formats,
      };

      let original = '', translated = '';

      if (cfg.provider === 'gemini') {
        let blob: Blob = new Blob([], { type: 'audio/wav' });
        if (window.electronAPI) {
          const r = await window.electronAPI.readFileBuffer({ filePath: chunk.filePath });
          if (r.success) blob = new Blob([new Uint8Array(r.data, r.byteOffset, r.byteLength)], { type: 'audio/wav' });
        }
        const b64 = await fileToBase64(blob);
        ({ original, translated } = await transcribeChunkGemini(b64, 'audio/wav', transcConfig, apiKey));
      } else {
        let blob: Blob = new Blob([], { type: 'audio/wav' });
        if (window.electronAPI) {
          const r = await window.electronAPI.readFileBuffer({ filePath: chunk.filePath });
          if (r.success) blob = new Blob([new Uint8Array(r.data, r.byteOffset, r.byteLength)], { type: 'audio/wav' });
        }
        ({ original, translated } = await transcribeChunkOpenAI(blob, transcConfig, apiKey));
      }

      setSession(prev => {
        if (!prev) return prev;
        const c = [...prev.chunks];
        c[index] = { ...c[index], original, translated, status: 'done' };
        return { ...prev, chunks: c };
      });
    } catch (err) {
      console.error(`Chunk ${index} error:`, err);
      setSession(prev => {
        if (!prev) return prev;
        const c = [...prev.chunks];
        c[index] = { ...c[index], status: 'error' };
        return { ...prev, chunks: c };
      });
    } finally {
      transcribingRef.current = false;
    }
  };

  // ─── Approve and go to next chunk ─────────────────────────────────────────
  const handleApproveAndNext = () => {
    if (!session) return;
    const nextIdx = session.currentIndex + 1;

    setSession(prev => {
      if (!prev) return prev;
      const c = [...prev.chunks];
      c[prev.currentIndex] = { ...c[prev.currentIndex], approved: true };
      if (nextIdx >= c.length) return { ...prev, chunks: c };
      return { ...prev, chunks: c, currentIndex: nextIdx };
    });

    if (nextIdx >= session.chunks.length) {
      setScreen('export');
      return;
    }

    const nextChunk = session.chunks[nextIdx];
    if (nextChunk?.status === 'pending') {
      setTimeout(() => {
        setSession(prev => {
          if (!prev) return prev;
          transcribeChunk(prev, nextIdx, prev.chunks[nextIdx], settings, prev.config);
          return prev;
        });
      }, 100);
    }
  };

  const handleUpdateChunk = (index: number, patch: Partial<ChunkData>) => {
    setSession(prev => {
      if (!prev) return prev;
      const c = [...prev.chunks];
      c[index] = { ...c[index], ...patch };
      return { ...prev, chunks: c };
    });
  };

  const fmt = (sec: number) => {
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <div className="app-bg" />
      <div className="app-shell">
        {/* macOS drag region */}
        <div className="drag-region" />

        {/* Settings button */}
        <button className="settings-btn" onClick={() => setShowSettings(true)} title="Settings">
          <Settings size={15} />
        </button>

        {/* ── Screen: Upload ── */}
        {screen === 'upload' && (
          <Workspace onFileSelected={handleFileSelected} />
        )}

        {/* ── Screen: Config ── */}
        {screen === 'config' && (
          <ConfigPanel
            fileName={sourceFileName}
            onStart={handleStartEngine}
            onCancel={() => setScreen('upload')}
          />
        )}

        {/* ── Screen: Processing ── */}
        {screen === 'processing' && (
          <div className="processing-screen">
            <div className="logo-header" style={{ marginBottom: 32 }}>
              <div className="logo-wrap">
                <Logo className="logo-img" />
                <span className="logo-name">VaniScript</span>
              </div>
              <p className="logo-tagline">Professional Audio Transcription &amp; Translation Engine with<br />extreme verbatim accuracy.</p>
            </div>
            <div className="processing-card">
              <div className="spinner" />
              <p className="proc-title">Processing Data…</p>
              <div className="proc-bar-wrap">
                <div className="proc-bar">
                  <div className="proc-fill" style={{ width: `${procProgress}%` }} />
                </div>
              </div>
              <p className="proc-status">"{procMsg}"</p>
              <p className="proc-sub">This may take a moment depending on the length of the audio track.</p>
            </div>
            <div className="app-footer" style={{ marginTop: 32 }}>
              © 2026 VaniScript Audio Processor • Version 1.0.0<br />
              Optimized for Gaudiya Vaishnava Philosophical Lexicon &amp; Technical Terminology
            </div>
          </div>
        )}

        {/* ── Screen: Review ── */}
        {screen === 'review' && session && (() => {
          const chunk = session.chunks[session.currentIndex];
          const total = session.chunks.length;
          const approved = session.chunks.filter(c => c.approved).length;
          return (
            <div className="review-screen">
              <div className="review-topbar">
                <span className="review-topbar-title">{session.sourceFileName}</span>
                <span className="review-chunk-badge">Chunk {session.currentIndex + 1} / {total}</span>
                <div className="review-progress">
                  <div className="proc-bar">
                    <div className="proc-fill" style={{ width: `${Math.round((approved / total) * 100)}%` }} />
                  </div>
                </div>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>{fmt(chunk?.startSec ?? 0)} – {fmt(chunk?.endSec ?? 0)}</span>
              </div>

              {chunk?.filePath && (
                <div style={{ padding: '8px 16px 0', flexShrink: 0 }}>
                  <audio controls src={`file://${chunk.filePath}`} style={{ width: '100%', height: 32 }} />
                </div>
              )}

              {chunk?.status === 'processing' || chunk?.status === 'pending' ? (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
                  <div className="spinner" />
                  <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13 }}>
                    {chunk.status === 'pending' ? 'Waiting…' : 'Transcribing…'}
                  </p>
                </div>
              ) : (
                <div className="review-panes">
                  <div className="review-pane">
                    <span className="review-pane-label">Original Transcription</span>
                    <textarea
                      className="review-textarea"
                      value={chunk?.original ?? ''}
                      onChange={e => handleUpdateChunk(session.currentIndex, { original: e.target.value })}
                    />
                  </div>
                  <div className="review-pane">
                    <span className="review-pane-label" style={{ color: 'var(--accent)' }}>
                      Translation {session.targetLang !== 'same' ? `→ ${session.targetLang}` : '(none)'}
                    </span>
                    <textarea
                      className="review-textarea"
                      value={chunk?.translated ?? ''}
                      onChange={e => handleUpdateChunk(session.currentIndex, { translated: e.target.value })}
                      placeholder={session.targetLang === 'same' ? 'No translation configured.' : ''}
                    />
                  </div>
                </div>
              )}

              <div className="review-actions">
                <button
                  className="btn-nav"
                  disabled={session.currentIndex === 0}
                  onClick={() => setSession(p => p ? { ...p, currentIndex: p.currentIndex - 1 } : p)}
                >
                  ‹ Previous
                </button>
                <button className="btn-approve" onClick={handleApproveAndNext}>
                  {session.currentIndex < total - 1 ? '✓ Approve & Next ›' : '✓ Approve & Export'}
                </button>
              </div>
            </div>
          );
        })()}

        {/* ── Screen: Export ── */}
        {screen === 'export' && session && (() => {
          const stem = session.sourceFileName.replace(/\.[^/.]+$/, '');
          const allOrig = session.chunks.map((c, i) => `\n\n=== Chunk ${i + 1} [${fmt(c.startSec)}–${fmt(c.endSec)}] ===\n${c.original}`).join('');
          const allTrans = session.chunks.map((c, i) => `\n\n=== Chunk ${i + 1} ===\n${c.translated}`).join('');
          const dl = (content: string, name: string) => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
            a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a);
          };
          return (
            <div className="export-screen">
              <div className="export-card">
                <div style={{ fontSize: 48 }}>✅</div>
                <div>
                  <p style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Transcription Complete</p>
                  <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>{session.chunks.length} chunks · {session.sourceFileName}</p>
                </div>
                <div className="export-dl-grid">
                  <button className="btn-dl btn-dl-secondary" onClick={() => dl(allOrig, `${stem}_original.txt`)}>⬇ Original TXT</button>
                  {session.targetLang !== 'same' && (
                    <button className="btn-dl btn-dl-primary" onClick={() => dl(allTrans, `${stem}_${session.targetLang.toLowerCase()}.txt`)}>⬇ Translation TXT</button>
                  )}
                </div>
                <button className="btn-cancel" onClick={() => { setSession(null); setSourceFile(''); setSourceFileName(''); setScreen('upload'); }}>
                  New Session
                </button>
              </div>
            </div>
          );
        })()}

        {/* Settings modal */}
        {showSettings && (
          <SettingsModal
            settings={settings}
            usage={usage}
            onSave={handleSaveSettings}
            onClose={() => setShowSettings(false)}
          />
        )}
      </div>
    </>
  );
}
