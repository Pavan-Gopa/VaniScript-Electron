import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Settings, Download, RefreshCw } from 'lucide-react';
import { AppSettings, ChunkData, UsageStats } from './types';
import { loadSettings, saveSettings, loadUsage, applyTheme } from './services/storage';
import { transcribeChunkGemini, transcribeChunkOpenAI, fileToBase64 } from './services/transcription';
import { computeCutPoints, cutPointsToSeconds } from './services/smart-slicer';
import { SettingsModal } from './components/SettingsModal';
import { Workspace } from './components/Workspace';
import { ConfigPanel, SessionConfig } from './components/ConfigPanel';
import { Logo } from './components/Logo';

type Screen = 'upload' | 'config' | 'processing' | 'review' | 'export';
type ViewMode = 'source' | 'translated' | 'dual';
type OutputFormat = 'TXT' | 'SRT' | 'VTT' | 'Markdown';

interface Session {
  sourceFile: string;
  sourceFileName: string;
  wavPath: string;
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
  const [viewMode, setViewMode] = useState<ViewMode>('dual');
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('TXT');
  const isTranscribing = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => { applyTheme(settings.theme, settings.fontSize); }, [settings.theme, settings.fontSize]);

  const handleSaveSettings = (s: AppSettings) => { saveSettings(s); setSettings(s); };

  const handleFileSelected = (path: string, name: string) => {
    setSourceFile(path); setSourceFileName(name); setScreen('config');
  };

  // ─── Transcribe one chunk ─────────────────────────────────────────────────
  const doTranscribe = useCallback(async (
    chunkFilePath: string,
    chunkIndex: number,
    cfg: SessionConfig,
    apiKey: string
  ) => {
    if (isTranscribing.current) return;
    isTranscribing.current = true;

    setSession(prev => {
      if (!prev) return prev;
      const c = [...prev.chunks];
      c[chunkIndex] = { ...c[chunkIndex], status: 'processing' };
      return { ...prev, chunks: c };
    });

    try {
      const transcConfig = {
        sourceLang: settingsRef.current.defaultSourceLang,
        targetLang: cfg.targetLang === 'same' ? '' : cfg.targetLang,
        speakerHint: cfg.lecturer,
        formats: cfg.formats,
      };

      let original = '', translated = '';

      if (cfg.provider === 'gemini') {
        // Read file via Electron IPC
        let blob: Blob;
        if (window.electronAPI) {
          const r = await window.electronAPI.readFileBuffer({ filePath: chunkFilePath });
          if (!r.success) throw new Error('Could not read audio file');
          blob = new Blob([new Uint8Array(r.data, r.byteOffset, r.byteLength)], { type: 'audio/wav' });
        } else {
          throw new Error('File reading requires Electron');
        }
        const b64 = await fileToBase64(blob);
        if (!b64) throw new Error('Failed to encode audio');
        ({ original, translated } = await transcribeChunkGemini(b64, 'audio/wav', transcConfig, apiKey));
      } else {
        let blob: Blob;
        if (window.electronAPI) {
          const r = await window.electronAPI.readFileBuffer({ filePath: chunkFilePath });
          if (!r.success) throw new Error('Could not read audio file');
          blob = new Blob([new Uint8Array(r.data, r.byteOffset, r.byteLength)], { type: 'audio/wav' });
        } else {
          throw new Error('File reading requires Electron');
        }
        ({ original, translated } = await transcribeChunkOpenAI(blob, transcConfig, apiKey));
      }

      setSession(prev => {
        if (!prev) return prev;
        const c = [...prev.chunks];
        c[chunkIndex] = { ...c[chunkIndex], original, translated, status: 'done' };
        return { ...prev, chunks: c };
      });
    } catch (err: any) {
      console.error(`Chunk ${chunkIndex} failed:`, err);
      setSession(prev => {
        if (!prev) return prev;
        const c = [...prev.chunks];
        c[chunkIndex] = { ...c[chunkIndex], status: 'error', original: `Error: ${err?.message ?? err}` };
        return { ...prev, chunks: c };
      });
    } finally {
      isTranscribing.current = false;
    }
  }, []);

  // ─── Start engine ─────────────────────────────────────────────────────────
  const handleStartEngine = async (cfg: SessionConfig) => {
    const apiKey = cfg.provider === 'openai' ? settings.openaiKey : settings.geminiKey;
    if (!apiKey?.trim()) {
      alert(`Please add your ${cfg.provider === 'gemini' ? 'Gemini' : 'OpenAI'} API key in Settings (⚙ button, top-right) first.`);
      return;
    }

    setScreen('processing');
    setProcProgress(5);
    setProcMsg('Converting audio format…');

    try {
      // 1. Convert to WAV 16kHz mono (with graceful fallback)
      let wavPath = sourceFile;
      let conversionFailed = false;
      if (window.electronAPI) {
        setProcMsg('Converting audio to WAV 16kHz…');
        const res = await window.electronAPI.ffmpegConvertToWav({ inputPath: sourceFile });
        if (res.success) {
          wavPath = res.outputPath;
        } else {
          // Fallback: use original file directly — Gemini accepts most formats
          conversionFailed = true;
          console.warn('FFmpeg conversion failed, using original file:', res.error);
          setProcMsg('Using original audio format…');
        }
      }
      setProcProgress(25);

      // 2. Get duration
      let durationSec = settings.chunkDurationMin * 60;
      if (window.electronAPI) {
        const dur = await window.electronAPI.ffmpegGetDuration({ inputPath: wavPath });
        if (dur.success && dur.durationSec > 0) durationSec = dur.durationSec;
      }
      setProcProgress(40);

      // 3. Compute cut points
      setProcMsg('Analyzing audio for optimal split points…');
      let cutSec: number[] = [];
      const targetMs = settings.chunkDurationMin * 60 * 1000;

      if (settings.sliceMode === 'silence' && window.electronAPI) {
        try {
          const buf = await window.electronAPI.readFileBuffer({ filePath: wavPath });
          if (buf.success && buf.byteLength > 0) {
            const pcm = new Int16Array(buf.data, buf.byteOffset, Math.floor(buf.byteLength / 2));
            cutSec = cutPointsToSeconds(computeCutPoints(pcm, 16000, targetMs, settings.silenceThreshDb, settings.minSilenceMs));
          }
        } catch { /* fall through to fixed */ }
      }

      // Fixed interval fallback
      if (cutSec.length === 0) {
        for (let t = settings.chunkDurationMin * 60; t < durationSec - 30; t += settings.chunkDurationMin * 60) {
          cutSec.push(Math.round(t));
        }
      }
      setProcProgress(60);

      // 4. Slice audio
      setProcMsg(`Creating ${cutSec.length + 1} audio segment(s)…`);
      let chunkPaths: string[] = [wavPath];
      if (window.electronAPI && cutSec.length > 0) {
        const sliceRes = await window.electronAPI.ffmpegSliceChunks({ inputPath: wavPath, cutPoints: cutSec });
        if (sliceRes.success && sliceRes.chunkPaths.length > 0) chunkPaths = sliceRes.chunkPaths;
      }
      setProcProgress(80);

      // 5. Build chunk objects
      const bounds = [0, ...cutSec, durationSec];
      const chunks: ChunkData[] = chunkPaths.map((fp, i) => ({
        index: i, filePath: fp,
        durationSec: (bounds[i + 1] ?? durationSec) - bounds[i],
        startSec: bounds[i],
        endSec: bounds[i + 1] ?? durationSec,
        original: '', translated: '', status: 'pending' as const, approved: false,
      }));

      setProcMsg('Uploading audio and initializing AI…');
      setProcProgress(90);

      const newSession: Session = {
        sourceFile, sourceFileName, wavPath, config: cfg, chunks,
        currentIndex: 0, targetLang: cfg.targetLang,
      };

      setSession(newSession);
      setProcProgress(100);
      setScreen('review');

      // Start transcribing first chunk
      doTranscribe(chunks[0].filePath, 0, cfg, apiKey);

    } catch (err: any) {
      console.error('Engine start failed:', err);
      setProcMsg(`Error: ${err?.message ?? String(err)}`);
      setTimeout(() => setScreen('config'), 3000);
    }
  };

  // ─── Handle chunk actions ─────────────────────────────────────────────────
  const handleApproveAndNext = () => {
    if (!session) return;
    const { currentIndex, chunks, config } = session;
    const nextIdx = currentIndex + 1;
    const apiKey = config.provider === 'openai' ? settings.openaiKey : settings.geminiKey;

    setSession(prev => {
      if (!prev) return prev;
      const c = [...prev.chunks];
      c[currentIndex] = { ...c[currentIndex], approved: true };
      return { ...prev, chunks: c, currentIndex: Math.min(nextIdx, c.length - 1) };
    });

    if (nextIdx >= chunks.length) { setScreen('export'); return; }

    const nextChunk = chunks[nextIdx];
    if (nextChunk?.status === 'pending') {
      setTimeout(() => doTranscribe(nextChunk.filePath, nextIdx, config, apiKey), 50);
    }
  };

  const handleRetry = (index: number) => {
    if (!session) return;
    const apiKey = session.config.provider === 'openai' ? settings.openaiKey : settings.geminiKey;
    doTranscribe(session.chunks[index].filePath, index, session.config, apiKey);
  };

  const handleUpdateChunk = (index: number, patch: Partial<ChunkData>) => {
    setSession(prev => {
      if (!prev) return prev;
      const c = [...prev.chunks]; c[index] = { ...c[index], ...patch };
      return { ...prev, chunks: c };
    });
  };

  // ─── Export helpers ───────────────────────────────────────────────────────
  const buildExport = (which: 'original' | 'translated', fmt: OutputFormat, chunks: ChunkData[]): string => {
    const getText = (c: ChunkData) => which === 'original' ? c.original : c.translated;
    const fmtTime = (s: number) => {
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    };

    if (fmt === 'SRT') {
      return chunks.map((c, i) =>
        `${i + 1}\n${fmtTime(c.startSec)},000 --> ${fmtTime(c.endSec)},000\n${getText(c)}\n`
      ).join('\n');
    }
    if (fmt === 'VTT') {
      return 'WEBVTT\n\n' + chunks.map((c, i) =>
        `${fmtTime(c.startSec)}.000 --> ${fmtTime(c.endSec)}.000\n${getText(c)}\n`
      ).join('\n');
    }
    if (fmt === 'Markdown') {
      return chunks.map((c, i) =>
        `## Segment ${i + 1} [${fmtTime(c.startSec)}–${fmtTime(c.endSec)}]\n\n${getText(c)}\n`
      ).join('\n---\n\n');
    }
    // TXT
    return chunks.map((c, i) => `[${fmtTime(c.startSec)}–${fmtTime(c.endSec)}]\n${getText(c)}`).join('\n\n');
  };

  const download = (content: string, name: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  const fmt = (sec: number) => {
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  // ─── Synchronized scroll ──────────────────────────────────────────────────
  const leftPaneRef = useRef<HTMLTextAreaElement>(null);
  const rightPaneRef = useRef<HTMLTextAreaElement>(null);
  const syncingRef = useRef(false);

  const handleLeftScroll = () => {
    if (syncingRef.current || !leftPaneRef.current || !rightPaneRef.current) return;
    syncingRef.current = true;
    const pct = leftPaneRef.current.scrollTop / (leftPaneRef.current.scrollHeight - leftPaneRef.current.clientHeight);
    rightPaneRef.current.scrollTop = pct * (rightPaneRef.current.scrollHeight - rightPaneRef.current.clientHeight);
    setTimeout(() => { syncingRef.current = false; }, 50);
  };

  const handleRightScroll = () => {
    if (syncingRef.current || !leftPaneRef.current || !rightPaneRef.current) return;
    syncingRef.current = true;
    const pct = rightPaneRef.current.scrollTop / (rightPaneRef.current.scrollHeight - rightPaneRef.current.clientHeight);
    leftPaneRef.current.scrollTop = pct * (leftPaneRef.current.scrollHeight - leftPaneRef.current.clientHeight);
    setTimeout(() => { syncingRef.current = false; }, 50);
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <>
      <div className="app-bg" />
      <div className="app-shell">
        <div className="drag-region" />

        {/* Settings button — only on non-review screens */}
        {screen !== 'review' && (
          <button className="settings-btn" onClick={() => setShowSettings(true)} title="Settings">
            <Settings size={15} />
          </button>
        )}

        {/* ── UPLOAD ── */}
        {screen === 'upload' && <Workspace onFileSelected={handleFileSelected} />}

        {/* ── CONFIG ── */}
        {screen === 'config' && (
          <ConfigPanel fileName={sourceFileName} onStart={handleStartEngine} onCancel={() => setScreen('upload')} />
        )}

        {/* ── PROCESSING ── */}
        {screen === 'processing' && (
          <div className="processing-screen">
            <div className="logo-header" style={{ marginBottom: 32 }}>
              <div className="logo-wrap"><Logo className="logo-img" /><span className="logo-name">VaniScript</span></div>
              <p className="logo-tagline">Professional Audio Transcription &amp; Translation Engine with<br />extreme verbatim accuracy.</p>
            </div>
            <div className="processing-card">
              <div className="spinner" />
              <p className="proc-title">Processing Data…</p>
              <div className="proc-bar-wrap">
                <div className="proc-bar"><div className="proc-fill" style={{ width: `${procProgress}%` }} /></div>
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

        {/* ── REVIEW ── */}
        {screen === 'review' && session && (() => {
          const chunk = session.chunks[session.currentIndex];
          const total = session.chunks.length;
          const approved = session.chunks.filter(c => c.approved).length;
          const stem = session.sourceFileName.replace(/\.[^/.]+$/, '');
          const hasTranslation = session.targetLang !== 'same' && session.targetLang !== '';

          return (
            <div className="review-screen">
              {/* ── Top bar ── */}
              <div className="review-topbar">
                <div className="review-tb-left">
                  <Logo className="review-logo" />
                  <span className="review-app-name">VaniScript</span>
                  <div className="review-status">
                    <div className="status-dot" />
                    <span>{chunk?.status === 'processing' ? 'Processing…' : chunk?.status === 'error' ? 'Error' : 'Ready'}</span>
                  </div>
                </div>

                <div className="review-tb-center">
                  {/* Format picker */}
                  <div className="review-fmt-group">
                    {(['TXT', 'SRT', 'VTT', 'Markdown'] as OutputFormat[]).map(f => (
                      <button key={f} className={`review-fmt-btn ${outputFormat === f ? 'active' : ''}`} onClick={() => setOutputFormat(f)}>{f}</button>
                    ))}
                  </div>
                  {/* View mode */}
                  <div className="review-view-group">
                    <button className={`review-view-btn ${viewMode === 'source' ? 'active' : ''}`} onClick={() => setViewMode('source')}>Source</button>
                    <button className={`review-view-btn ${viewMode === 'translated' ? 'active' : ''}`} onClick={() => setViewMode('translated')}>Translated</button>
                    <button className={`review-view-btn ${viewMode === 'dual' ? 'active-accent' : ''}`} onClick={() => setViewMode('dual')}>Dual View</button>
                  </div>
                </div>

                <div className="review-tb-right">
                  <button className="review-new-btn" onClick={() => { setSession(null); setSourceFile(''); setSourceFileName(''); setScreen('upload'); }}>
                    + New Session
                  </button>
                </div>
              </div>

              {/* ── Audio bar ── */}
              <div className="review-audio-bar">
                <span className="review-audio-label">ORIGINAL AUDIO</span>
                <audio controls src={`file://${session.wavPath}`} className="review-audio-player" />
              </div>

              {/* ── Progress bar (thin) ── */}
              <div className="review-thin-progress">
                <div className="review-thin-fill" style={{ width: `${Math.round((approved / total) * 100)}%` }} />
              </div>

              {/* ── Dual pane / single pane ── */}
              {chunk?.status === 'processing' || chunk?.status === 'pending' ? (
                <div className="review-loading">
                  <div className="spinner" />
                  <p>{chunk.status === 'pending' ? 'Waiting in queue…' : 'Transcribing with AI…'}</p>
                </div>
              ) : chunk?.status === 'error' ? (
                <div className="review-loading">
                  <p style={{ color: 'var(--red)', marginBottom: 12 }}>{chunk.original}</p>
                  <button className="btn-nav" onClick={() => handleRetry(session.currentIndex)}>
                    <RefreshCw size={13} /> Retry
                  </button>
                </div>
              ) : (
                <div className="review-panes" style={{ gridTemplateColumns: viewMode === 'dual' ? '1fr 1fr' : '1fr' }}>
                  {/* Original pane */}
                  {(viewMode === 'source' || viewMode === 'dual') && (
                    <div className="review-pane">
                      <div className="review-pane-header">
                        <span className="review-pane-label">ORIGINAL TRANSCRIPTION</span>
                        <button
                          className="review-dl-btn"
                          title="Download original"
                          onClick={() => download(buildExport('original', outputFormat, session.chunks), `${stem}_original.${outputFormat.toLowerCase()}`)}
                        >
                          <Download size={13} />
                        </button>
                      </div>
                      <textarea
                        ref={viewMode === 'dual' ? leftPaneRef : undefined}
                        className="review-textarea"
                        value={chunk?.original ?? ''}
                        onChange={e => handleUpdateChunk(session.currentIndex, { original: e.target.value })}
                        onScroll={viewMode === 'dual' ? handleLeftScroll : undefined}
                      />
                    </div>
                  )}

                  {/* Translation pane */}
                  {hasTranslation && (viewMode === 'translated' || viewMode === 'dual') && (
                    <div className="review-pane">
                      <div className="review-pane-header">
                        <span className="review-pane-label" style={{ color: 'var(--accent)' }}>TRANSLATED: {session.targetLang.toUpperCase()}</span>
                        <button
                          className="review-dl-btn"
                          title="Download translation"
                          onClick={() => download(buildExport('translated', outputFormat, session.chunks), `${stem}_${session.targetLang.toLowerCase()}.${outputFormat.toLowerCase()}`)}
                        >
                          <Download size={13} />
                        </button>
                      </div>
                      <textarea
                        ref={viewMode === 'dual' ? rightPaneRef : undefined}
                        className="review-textarea"
                        value={chunk?.translated ?? ''}
                        onChange={e => handleUpdateChunk(session.currentIndex, { translated: e.target.value })}
                        onScroll={viewMode === 'dual' ? handleRightScroll : undefined}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* ── Bottom action bar ── */}
              <div className="review-actions">
                <div className="review-chunk-info">
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>
                    Segment {session.currentIndex + 1} / {total} · {fmt(chunk?.startSec ?? 0)}–{fmt(chunk?.endSec ?? 0)}
                  </span>
                  <div className="proc-bar" style={{ width: 120 }}>
                    <div className="proc-fill" style={{ width: `${Math.round((approved / total) * 100)}%` }} />
                  </div>
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>{approved}/{total} approved</span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn-nav"
                    disabled={session.currentIndex === 0}
                    onClick={() => setSession(p => p ? { ...p, currentIndex: p.currentIndex - 1 } : p)}
                  >‹ Previous</button>
                  <button className="btn-approve" onClick={handleApproveAndNext}>
                    {session.currentIndex < total - 1 ? '✓ Approve & Next ›' : '✓ Complete & Export'}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── EXPORT ── */}
        {screen === 'export' && session && (() => {
          const stem = session.sourceFileName.replace(/\.[^/.]+$/, '');
          return (
            <div className="export-screen">
              <div className="export-card">
                <div style={{ fontSize: 48 }}>✅</div>
                <div>
                  <p style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Transcription Complete</p>
                  <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>
                    {session.chunks.length} segments · {session.sourceFileName}
                  </p>
                </div>
                <div className="export-dl-grid">
                  {(['TXT', 'SRT', 'VTT', 'Markdown'] as OutputFormat[]).map(f => (
                    <button key={f} className="btn-dl btn-dl-secondary" onClick={() => download(buildExport('original', f, session.chunks), `${stem}_original.${f.toLowerCase()}`)}>
                      ⬇ {f}
                    </button>
                  ))}
                  {session.targetLang !== 'same' && (['TXT', 'SRT', 'VTT', 'Markdown'] as OutputFormat[]).map(f => (
                    <button key={`t-${f}`} className="btn-dl btn-dl-primary" onClick={() => download(buildExport('translated', f, session.chunks), `${stem}_${session.targetLang.toLowerCase()}.${f.toLowerCase()}`)}>
                      ⬇ {f} ({session.targetLang})
                    </button>
                  ))}
                </div>
                <button className="btn-cancel" onClick={() => { setSession(null); setSourceFile(''); setSourceFileName(''); setScreen('upload'); }}>
                  New Session
                </button>
              </div>
            </div>
          );
        })()}

        {showSettings && (
          <SettingsModal settings={settings} usage={usage} onSave={handleSaveSettings} onClose={() => setShowSettings(false)} />
        )}
      </div>
    </>
  );
}
