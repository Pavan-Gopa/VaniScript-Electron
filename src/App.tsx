import React, { useState, useEffect, useCallback } from 'react';
import { Settings, Sun, Moon, ChevronRight } from 'lucide-react';
import { AppSettings, SessionState, ChunkData, UsageStats, AppScreen } from './types';
import { loadSettings, saveSettings, loadUsage, saveUsage, applyTheme, DEFAULT_SETTINGS } from './services/storage';
import { transcribeChunkGemini, transcribeChunkOpenAI, fileToBase64 } from './services/transcription';
import { computeCutPoints, cutPointsToSeconds } from './services/smart-slicer';
import { SettingsModal } from './components/SettingsModal';
import { WorkspaceView } from './components/WorkspaceView';
import { ChunkReview } from './components/ChunkReview';

// ─── Logo ─────────────────────────────────────────────────────────────────────
function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 100 100" fill="none">
      <circle cx="50" cy="50" r="48" stroke="#d4a853" strokeWidth="4" />
      <circle cx="50" cy="50" r="12" fill="#d4a853" opacity="0.8" />
      <path d="M50 8 L50 28 M50 72 L50 92 M8 50 L28 50 M72 50 L92 50" stroke="#d4a853" strokeWidth="3" strokeLinecap="round" />
      <path d="M22 22 L36 36 M64 64 L78 78 M78 22 L64 36 M36 64 L22 78" stroke="#d4a853" strokeWidth="2.5" strokeLinecap="round" opacity="0.6" />
    </svg>
  );
}

// ─── Processing screen ────────────────────────────────────────────────────────
function ProcessingScreen({ message, progress }: { message: string; progress: number }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24 }}>
      <Logo />
      <div className="spinner spinner-lg" />
      <div style={{ textAlign: 'center', maxWidth: 400 }}>
        <p style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>{message}</p>
        <div className="progress-bar" style={{ width: 320 }}>
          <div className="progress-fill" style={{ width: `${progress}%`, transition: 'width 0.5s ease' }} />
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [usage, setUsage] = useState<UsageStats>(() => loadUsage());
  const [showSettings, setShowSettings] = useState(false);
  const [screen, setScreen] = useState<AppScreen>('workspace');
  const [session, setSession] = useState<SessionState | null>(null);
  const [processing, setProcessing] = useState(false);
  const [procMessage, setProcMessage] = useState('');
  const [procProgress, setProcProgress] = useState(0);

  // Apply theme on settings change
  useEffect(() => {
    applyTheme(settings.theme, settings.fontSize);
  }, [settings.theme, settings.fontSize]);

  const handleSaveSettings = (s: AppSettings) => {
    saveSettings(s);
    setSettings(s);
  };

  // ─── Start processing session ────────────────────────────────────────────────
  const handleStartSession = useCallback(async (partial: Partial<SessionState>) => {
    if (!partial.sourceFile) return;

    setProcessing(true);
    setProcProgress(5);
    setProcMessage('Converting audio format…');

    try {
      // 1. Convert to WAV 16kHz
      let wavPath: string;
      if (window.electronAPI) {
        const res = await window.electronAPI.ffmpegConvertToWav({ inputPath: partial.sourceFile });
        if (!res.success) throw new Error('FFmpeg conversion failed');
        wavPath = res.outputPath;
        setProcProgress(20);
      } else {
        // Web fallback: use original file
        wavPath = partial.sourceFile;
      }

      // 2. Get duration
      let durationSec = 0;
      if (window.electronAPI) {
        const dur = await window.electronAPI.ffmpegGetDuration({ inputPath: wavPath });
        durationSec = dur.durationSec;
      }
      setProcProgress(30);

      // 3. Compute cut points
      setProcMessage('Analyzing audio for optimal chunk points…');
      const targetMs = settings.chunkDurationMin * 60 * 1000;
      let cutPointsSec: number[] = [];

      if (settings.sliceMode === 'silence' && window.electronAPI) {
        // Read PCM for silence detection
        const buf = await window.electronAPI.readFileBuffer({ filePath: wavPath });
        if (buf.success) {
          const pcm = new Int16Array(buf.data, buf.byteOffset, buf.byteLength / 2);
          const cutMs = computeCutPoints(pcm, 16000, targetMs, settings.silenceThreshDb, settings.minSilenceMs);
          cutPointsSec = cutPointsToSeconds(cutMs);
        }
      } else {
        // Fixed interval slicing
        for (let t = settings.chunkDurationMin * 60; t < durationSec; t += settings.chunkDurationMin * 60) {
          cutPointsSec.push(t);
        }
      }
      setProcProgress(50);

      // 4. Slice into chunk files
      setProcMessage(`Splitting into ${cutPointsSec.length + 1} chunks…`);
      let chunkPaths: string[] = [wavPath];
      if (window.electronAPI && cutPointsSec.length > 0) {
        const sliceRes = await window.electronAPI.ffmpegSliceChunks({ inputPath: wavPath, cutPoints: cutPointsSec });
        if (sliceRes.success) chunkPaths = sliceRes.chunkPaths;
      }
      setProcProgress(70);

      // 5. Build chunk data
      const boundaries = [0, ...cutPointsSec, durationSec || settings.chunkDurationMin * 60];
      const chunks: ChunkData[] = chunkPaths.map((fp, i) => ({
        index: i,
        filePath: fp,
        durationSec: boundaries[i + 1] - boundaries[i],
        startSec: boundaries[i],
        endSec: boundaries[i + 1],
        original: '',
        translated: '',
        status: 'pending',
        approved: false,
      }));
      setProcProgress(80);

      // 6. Initialize session
      const newSession: SessionState = {
        sourceFile: partial.sourceFile,
        sourceFileName: partial.sourceFileName ?? '',
        durationSec,
        metadata: partial.metadata ?? { date: '', location: '', lecturer: '', participants: '' },
        sourceLang: partial.sourceLang ?? settings.defaultSourceLang,
        targetLang: partial.targetLang ?? settings.defaultTargetLang,
        transcriptionProvider: partial.transcriptionProvider ?? settings.transcriptionProvider,
        translationProvider: partial.translationProvider ?? settings.translationProvider,
        outputFormats: partial.outputFormats ?? ['TXT'],
        chunks,
        currentChunkIndex: 0,
      };

      setSession(newSession);
      setProcProgress(100);
      setProcessing(false);
      setScreen('review');

      // 7. Start transcribing first chunk immediately
      transcribeChunk(newSession, 0, newSession.chunks[0]);

    } catch (err) {
      console.error(err);
      setProcessing(false);
      setProcMessage('');
    }
  }, [settings]);

  // ─── Transcribe a single chunk ───────────────────────────────────────────────
  const transcribeChunk = async (sess: SessionState, index: number, chunk: ChunkData) => {
    setSession(prev => {
      if (!prev) return prev;
      const updated = [...prev.chunks];
      updated[index] = { ...updated[index], status: 'processing' };
      return { ...prev, chunks: updated };
    });

    try {
      let original = '', translated = '';
      const apiKey = sess.transcriptionProvider === 'openai' ? settings.openaiKey : settings.geminiKey;
      const config = {
        sourceLang: sess.sourceLang, targetLang: sess.targetLang,
        speakerHint: sess.metadata.lecturer, formats: sess.outputFormats,
      };

      if (sess.transcriptionProvider === 'gemini') {
        // Read file and convert to base64
        let blob: Blob;
        if (window.electronAPI) {
          const res = await window.electronAPI.readFileBuffer({ filePath: chunk.filePath });
          blob = new Blob([new Uint8Array(res.data, res.byteOffset, res.byteLength)], { type: 'audio/wav' });
        } else {
          blob = new Blob([], { type: 'audio/wav' });
        }
        const b64 = await fileToBase64(blob);
        ({ original, translated } = await transcribeChunkGemini(b64, 'audio/wav', config, apiKey));
      } else if (sess.transcriptionProvider === 'openai') {
        let blob: Blob = new Blob([], { type: 'audio/wav' });
        if (window.electronAPI) {
          const res = await window.electronAPI.readFileBuffer({ filePath: chunk.filePath });
          blob = new Blob([new Uint8Array(res.data, res.byteOffset, res.byteLength)], { type: 'audio/wav' });
        }
        ({ original, translated } = await transcribeChunkOpenAI(blob, config, apiKey));
      }

      setSession(prev => {
        if (!prev) return prev;
        const updated = [...prev.chunks];
        updated[index] = { ...updated[index], original, translated, status: 'done' };
        return { ...prev, chunks: updated };
      });
    } catch (err) {
      console.error(`Chunk ${index} failed:`, err);
      setSession(prev => {
        if (!prev) return prev;
        const updated = [...prev.chunks];
        updated[index] = { ...updated[index], status: 'error' };
        return { ...prev, chunks: updated };
      });
    }
  };

  // ─── Approve chunk and move to next ──────────────────────────────────────────
  const handleApprove = (nextIndex: number) => {
    setSession(prev => {
      if (!prev) return prev;
      const updated = { ...prev, currentChunkIndex: nextIndex };
      // Auto-transcribe next chunk if pending
      const nextChunk = prev.chunks[nextIndex];
      if (nextChunk?.status === 'pending') {
        transcribeChunk(updated, nextIndex, nextChunk);
      }
      return updated;
    });
  };

  const handleUpdateChunk = (index: number, patch: Partial<ChunkData>) => {
    setSession(prev => {
      if (!prev) return prev;
      const updated = [...prev.chunks];
      updated[index] = { ...updated[index], ...patch };
      return { ...prev, chunks: updated };
    });
  };

  const handleExport = () => setScreen('export');

  const handleNewSession = () => {
    setSession(null);
    setScreen('workspace');
  };

  // ─── Export screen (simple) ───────────────────────────────────────────────────
  const ExportScreen = () => {
    if (!session) return null;
    const allOriginal = session.chunks.map((c, i) => `\n\n=== Chunk ${i + 1} [${formatTime(c.startSec)} - ${formatTime(c.endSec)}] ===\n${c.original}`).join('');
    const allTranslated = session.chunks.map((c, i) => `\n\n=== Chunk ${i + 1} ===\n${c.translated}`).join('');

    const download = (content: string, name: string) => {
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
    };

    const stem = session.sourceFileName.replace(/\.[^/.]+$/, '');
    return (
      <div className="main-content">
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
          <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Transcription Complete</h2>
          <p className="text-muted text-sm">{session.chunks.length} chunks · {session.sourceFileName}</p>
        </div>
        <div>
          <p className="section-title">Download Results</p>
          <div className="grid-2">
            <div className="card card-sm">
              <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Original Transcription</p>
              <button className="btn btn-secondary w-full" onClick={() => download(allOriginal, `${stem}_original.txt`)}>
                Download TXT
              </button>
            </div>
            {session.targetLang !== 'none' && (
              <div className="card card-sm">
                <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Translation → {session.targetLang}</p>
                <button className="btn btn-primary w-full" onClick={() => download(allTranslated, `${stem}_${session.targetLang.toLowerCase()}.txt`)}>
                  Download TXT
                </button>
              </div>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <button className="btn btn-secondary btn-lg" onClick={handleNewSession}>New Session</button>
        </div>
      </div>
    );
  };

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  return (
    <div className="app-shell">
      {/* Titlebar */}
      <div className="titlebar">
        <div className="titlebar-logo">
          <Logo />
          <span className="titlebar-title">VaniScript</span>
        </div>

        {session && (
          <div style={{ marginLeft: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              onClick={() => setScreen('workspace')}
              style={{ fontSize: 12, color: screen === 'workspace' ? 'var(--accent)' : 'var(--text-2)', cursor: 'pointer', fontWeight: 500 }}
            >
              Workspace
            </span>
            <ChevronRight size={12} color="var(--text-3)" />
            <span
              onClick={() => setScreen('review')}
              style={{ fontSize: 12, color: screen === 'review' ? 'var(--accent)' : 'var(--text-2)', cursor: 'pointer', fontWeight: 500 }}
            >
              Review
            </span>
            {screen === 'export' && (
              <>
                <ChevronRight size={12} color="var(--text-3)" />
                <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 500 }}>Export</span>
              </>
            )}
          </div>
        )}

        <div className="titlebar-spacer" />
        <div className="titlebar-actions">
          {/* Theme toggle */}
          <button
            className="btn btn-ghost btn-icon"
            title="Toggle theme"
            onClick={() => handleSaveSettings({ ...settings, theme: settings.theme === 'dark' ? 'light' : 'dark' })}
          >
            {settings.theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button className="btn btn-ghost btn-icon" title="Settings" onClick={() => setShowSettings(true)}>
            <Settings size={16} />
          </button>
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {processing ? (
          <ProcessingScreen message={procMessage} progress={procProgress} />
        ) : screen === 'workspace' || !session ? (
          <WorkspaceView settings={settings} onStartSession={handleStartSession} />
        ) : screen === 'review' && session ? (
          <ChunkReview
            session={session}
            onUpdateChunk={handleUpdateChunk}
            onApprove={handleApprove}
            onExport={handleExport}
          />
        ) : (
          <ExportScreen />
        )}
      </div>

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
  );
}
