import React, { useState, useRef } from 'react';
import { Upload, Mic, Square, FileAudio, ChevronRight, AlertCircle, Scissors } from 'lucide-react';
import { SessionState, AppSettings, AudioMetadata } from '../types';

interface WorkspaceViewProps {
  settings: AppSettings;
  onStartSession: (session: Partial<SessionState>) => void;
}

const LANGS = [
  { value: 'auto', label: 'Auto-Detect' },
  { value: 'bn', label: 'Bengali (বাংলা)' },
  { value: 'en', label: 'English' },
  { value: 'ru', label: 'Russian' },
  { value: 'hi', label: 'Hindi' },
  { value: 'sa', label: 'Sanskrit' },
];
const TARGET_LANGS = [
  { value: 'none', label: 'No Translation' },
  { value: 'Russian', label: 'Russian' },
  { value: 'English', label: 'English' },
  { value: 'Hindi', label: 'Hindi' },
  { value: 'Spanish', label: 'Spanish' },
  { value: 'French', label: 'French' },
];

function extractMetadata(filename: string): AudioMetadata {
  const stem = filename.replace(/\.[^/.]+$/, '');
  const dateMatch = stem.match(/\b(\d{2,4}[-._]\d{2}[-._]\d{2,4}|\d{8})\b/);
  const date = dateMatch?.[0] ?? '';
  const namePattern = /\b((?:[A-Z][a-z]+\s*){1,4}(?:Swami|Maharaja|Das|Dasa|Bhakti|Goswami|Thakur|Prabhu))\b/i;
  const nameMatch = stem.match(namePattern);
  const lecturer = nameMatch?.[0]?.trim() ?? '';
  return { date, location: '', lecturer, participants: '' };
}

export function WorkspaceView({ settings, onStartSession }: WorkspaceViewProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [sourceFile, setSourceFile] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [metadata, setMetadata] = useState<AudioMetadata>({ date: '', location: '', lecturer: '', participants: '' });
  const [sourceLang, setSourceLang] = useState(settings.defaultSourceLang);
  const [targetLang, setTargetLang] = useState(settings.defaultTargetLang);
  const [transcProvider, setTranscProvider] = useState(settings.transcriptionProvider);
  const [error, setError] = useState('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async () => {
    if (window.electronAPI) {
      const fp = await window.electronAPI.openFile();
      if (fp) loadFile(fp, fp.split('/').pop() ?? fp);
    } else {
      fileInputRef.current?.click();
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) loadFile((f as any).path ?? f.name, f.name);
  };

  const loadFile = (fp: string, name: string) => {
    setSourceFile(fp);
    setFileName(name);
    setMetadata(extractMetadata(name));
    setError('');
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) {
      // In web mode or if path available
      loadFile((f as any).path ?? f.name, f.name);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (stream.getAudioTracks().length === 0) {
        setError("No audio track. Enable 'Share audio' when selecting a tab/window.");
        stream.getTracks().forEach(t => t.stop()); return;
      }
      const opts = MediaRecorder.isTypeSupported('audio/webm') ? { mimeType: 'audio/webm' } : undefined;
      const mr = new MediaRecorder(stream, opts);
      mediaRecorderRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType });
        const fakeFile = new File([blob], `Recorded_${Date.now()}.webm`, { type: mr.mimeType });
        loadFile((fakeFile as any).path ?? fakeFile.name, fakeFile.name);
        stream.getTracks().forEach(t => t.stop());
        setIsRecording(false);
      };
      stream.getVideoTracks()[0].onended = () => { if (mr.state !== 'inactive') mr.stop(); };
      mr.start();
      setIsRecording(true); setError('');
    } catch { setError('Failed to start recording. Grant permission and enable audio sharing.'); }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state !== 'inactive') mediaRecorderRef.current?.stop();
  };

  const canStart = !!(sourceFile || fileName) && (settings.geminiKey || settings.openaiKey || transcProvider === 'whisper-local');

  const handleStart = () => {
    onStartSession({
      sourceFile, sourceFileName: fileName, metadata,
      sourceLang, targetLang,
      transcriptionProvider: transcProvider,
      translationProvider: targetLang === 'none' ? 'none' : settings.translationProvider,
      outputFormats: ['TXT'],
    });
  };

  return (
    <div className="main-content">
      {/* Source selection */}
      <div>
        <p className="section-title">Audio Source</p>
        <div className="grid-2">
          {/* File drop zone */}
          <div
            className={`drop-zone ${isDragging ? 'drag-over' : ''}`}
            onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={handleFileSelect}
          >
            <input ref={fileInputRef} type="file" accept="audio/*,video/*" style={{ display: 'none' }} onChange={handleFileInputChange} />
            {sourceFile ? (
              <>
                <FileAudio size={36} className="drop-zone-icon" />
                <h3 style={{ wordBreak: 'break-all', fontSize: 14 }}>{fileName}</h3>
                <p style={{ fontSize: 12 }}>Click to change file</p>
              </>
            ) : (
              <>
                <Upload size={36} className="drop-zone-icon" />
                <h3>Upload Audio / Video</h3>
                <p>Drag & drop or click to browse<br/>MP3, WAV, M4A, MP4, FLAC…</p>
              </>
            )}
          </div>

          {/* System audio recording */}
          <div
            className="drop-zone"
            style={{
              borderStyle: 'solid',
              borderColor: isRecording ? 'var(--red)' : 'var(--border)',
              background: isRecording ? 'rgba(248,113,113,0.05)' : 'var(--surface)',
              cursor: 'default',
            }}
          >
            {isRecording ? (
              <>
                <div className="flex items-center gap-2">
                  <div className="rec-dot" />
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--red)' }}>Recording…</span>
                </div>
                <p style={{ fontSize: 12 }}>Play audio in another app or browser tab</p>
                <button className="btn btn-danger" onClick={stopRecording}>
                  <Square size={14} fill="currentColor" /> Stop & Use
                </button>
              </>
            ) : (
              <>
                <Mic size={36} className="drop-zone-icon" />
                <h3>Record System Audio</h3>
                <p>Capture from YouTube, video player,<br/>or any browser tab</p>
                <button className="btn btn-secondary" onClick={startRecording}>
                  <Mic size={14} /> Start Capture
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Metadata */}
      {(sourceFile || fileName) && (
        <div>
          <p className="section-title">Lecture Metadata</p>
          <div className="card card-sm">
            <div className="grid-2">
              {[
                { key: 'date', label: 'Date' },
                { key: 'location', label: 'Location' },
                { key: 'lecturer', label: 'Lecturer / Speaker' },
                { key: 'participants', label: 'Participants' },
              ].map(f => (
                <div key={f.key}>
                  <label className="label">{f.label}</label>
                  <input
                    className="input"
                    value={(metadata as any)[f.key]}
                    onChange={e => setMetadata(p => ({ ...p, [f.key]: e.target.value }))}
                    style={{ userSelect: 'text' }}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Session config */}
      <div>
        <p className="section-title">Session Configuration</p>
        <div className="card card-sm">
          <div className="grid-3">
            <div>
              <label className="label">Source Language</label>
              <select className="input" value={sourceLang} onChange={e => setSourceLang(e.target.value)}>
                {LANGS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Translate To</label>
              <select className="input" value={targetLang} onChange={e => setTargetLang(e.target.value)}>
                {TARGET_LANGS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Transcription Engine</label>
              <select className="input" value={transcProvider} onChange={e => setTranscProvider(e.target.value as any)}>
                <option value="gemini">Google Gemini</option>
                <option value="openai">OpenAI Whisper</option>
                <option value="whisper-local">Local Whisper</option>
              </select>
            </div>
          </div>

          <div className="divider" />

          <div className="flex items-center gap-3" style={{ flexWrap: 'wrap' }}>
            <div className="flex items-center gap-2 text-xs text-muted">
              <Scissors size={12} />
              Chunks: <strong style={{ color: 'var(--accent)' }}>{settings.chunkDurationMin} min</strong>
              · {settings.sliceMode === 'silence' ? '🔇 by silence' : '⏱ fixed'}
              · <span style={{ color: 'var(--text-3)', fontSize: 11 }}>Configure in Settings</span>
            </div>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2" style={{ color: 'var(--red)', fontSize: 13, background: 'rgba(248,113,113,0.08)', padding: '10px 14px', borderRadius: 'var(--radius-md)', border: '1px solid rgba(248,113,113,0.2)' }}>
          <AlertCircle size={15} /> {error}
        </div>
      )}

      {/* API warning */}
      {!settings.geminiKey && !settings.openaiKey && transcProvider !== 'whisper-local' && (
        <div className="flex items-center gap-2" style={{ color: 'var(--accent)', fontSize: 12, background: 'var(--accent-dim)', padding: '10px 14px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-accent)' }}>
          <AlertCircle size={14} /> No API key configured. Go to Settings → API Keys.
        </div>
      )}

      {/* Start button */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn btn-primary btn-lg" disabled={!canStart} onClick={handleStart}>
          Begin Transcription <ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}
