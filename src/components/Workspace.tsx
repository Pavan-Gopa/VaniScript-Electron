import React, { useState, useRef, useCallback } from 'react';
import { Logo } from './Logo';

interface WorkspaceProps {
  onFileSelected: (path: string, name: string) => void;
}

export function Workspace({ onFileSelected }: WorkspaceProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const handlePickFile = async () => {
    if (window.electronAPI) {
      const fp = await window.electronAPI.openFile();
      if (fp) onFileSelected(fp, fp.split('/').pop() ?? fp);
    } else {
      fileInputRef.current?.click();
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onFileSelected((f as any).path ?? f.name, f.name);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) onFileSelected((f as any).path ?? f.name, f.name);
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType });
        const name = `Recorded_${Date.now()}.webm`;
        onFileSelected(name, name);
        stream.getTracks().forEach(t => t.stop());
        setIsRecording(false);
      };
      stream.getVideoTracks()[0].onended = () => { if (mr.state !== 'inactive') mr.stop(); };
      mr.start();
      setIsRecording(true);
    } catch { setIsRecording(false); }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state !== 'inactive') mediaRecorderRef.current?.stop();
  };

  return (
    <div className="main-screen">
      <div className="logo-header">
        <div className="logo-wrap">
          <Logo className="logo-img" />
          <span className="logo-name">VaniScript</span>
        </div>
        <p className="logo-tagline">
          Professional Audio Transcription &amp; Translation Engine with<br />extreme verbatim accuracy.
        </p>
      </div>

      <div className="source-cards">
        <input ref={fileInputRef} type="file" accept="audio/*,video/*" style={{ display: 'none' }} onChange={handleInputChange} />
        {/* Upload card */}
        <div
          className={`source-card ${isDragging ? 'drag-over' : ''}`}
          onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={handlePickFile}
        >
          <div className="source-card-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          </div>
          <h3>Upload Audio Source</h3>
          <p>Drag &amp; drop or click to select.</p>
        </div>

        {/* Record card */}
        <div className={`source-card solid ${isRecording ? 'recording' : ''}`}>
          <div className="source-card-icon" style={isRecording ? { borderColor: 'var(--red)', background: 'rgba(255,92,92,0.1)' } : {}}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={isRecording ? 'var(--red)' : 'currentColor'} strokeWidth="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"/></svg>
          </div>
          {isRecording ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="rec-dot" />
                <h3 style={{ color: 'var(--red)' }}>Recording…</h3>
              </div>
              <p>Play audio in another window or browser tab</p>
              <button className="btn-cancel" style={{ width: 'auto', padding: '8px 20px' }} onClick={stopRecording}>Stop &amp; Use</button>
            </>
          ) : (
            <>
              <h3>Record System Audio</h3>
              <p>Capture audio from a browser tab or window.</p>
              <button
                className="btn-cancel"
                style={{ width: 'auto', padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 6 }}
                onClick={startRecording}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/></svg>
                Start Recording
              </button>
            </>
          )}
        </div>
      </div>

      <div className="app-footer">
        <div className="app-footer-brand">
          <Logo className="app-footer-logo" />
          <span>VaniScript</span>
        </div>
        © 2026 VaniScript Audio Processor • Version 1.0.0<br />
        Optimized for Gaudiya Vaishnava Philosophical Lexicon &amp; Technical Terminology
      </div>
    </div>
  );
}
