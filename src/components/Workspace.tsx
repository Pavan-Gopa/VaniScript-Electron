import React, { useEffect, useState, useRef } from 'react';
import { Logo } from './Logo';

interface WorkspaceProps {
  onFileSelected: (path: string, name: string) => void;
}

type RecordingMode = 'system' | 'microphone';

const SYSTEM_MIME_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=opus',
  'video/webm',
  'audio/webm;codecs=opus',
  'audio/webm',
];

const MICROPHONE_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

function getSupportedMimeType(mode: RecordingMode) {
  const candidates = mode === 'microphone' ? MICROPHONE_MIME_TYPES : SYSTEM_MIME_TYPES;
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function formatElapsed(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60).toString().padStart(2, '0');
  const s = (safe % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function Workspace({ onFileSelected }: WorkspaceProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isSavingRecording, setIsSavingRecording] = useState(false);
  const [recordingMode, setRecordingMode] = useState<RecordingMode>('system');
  const [recordingElapsedSec, setRecordingElapsedSec] = useState(0);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingSessionIdRef = useRef<string | null>(null);
  const appendQueueRef = useRef<Promise<void>>(Promise.resolve());
  const shouldSaveRecordingRef = useRef(true);
  const recordingStartedAtRef = useRef(0);

  useEffect(() => {
    if (!isRecording) return undefined;
    const timer = window.setInterval(() => {
      setRecordingElapsedSec((Date.now() - recordingStartedAtRef.current) / 1000);
    }, 250);
    return () => window.clearInterval(timer);
  }, [isRecording]);

  useEffect(() => {
    return () => {
      shouldSaveRecordingRef.current = false;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      const sessionId = recordingSessionIdRef.current;
      if (sessionId) {
        void window.electronAPI?.recordingCancel?.({ sessionId });
      }
    };
  }, []);

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

  const appendRecordingChunk = (sessionId: string, blob: Blob) => {
    const next = appendQueueRef.current.catch(() => undefined).then(async () => {
      const chunk = await blob.arrayBuffer();
      const result = await window.electronAPI?.recordingAppendChunk?.({ sessionId, chunk });
      if (!result?.success) throw new Error(result?.error || 'Could not write recording chunk.');
    });
    appendQueueRef.current = next;
    void next.catch((error) => {
      setRecordingError(error?.message || String(error));
    });
  };

  const cleanupRecordingResources = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
    recordingSessionIdRef.current = null;
    appendQueueRef.current = Promise.resolve();
  };

  const startRecording = async (mode: RecordingMode) => {
    try {
      if (!window.electronAPI?.recordingStart || !window.electronAPI?.recordingFinish) {
        throw new Error('Recording requires the Electron desktop app.');
      }
      setRecordingError(null);
      setRecordingMode(mode);
      shouldSaveRecordingRef.current = true;
      appendQueueRef.current = Promise.resolve();

      const stream = mode === 'system'
        ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        : await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });

      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error(mode === 'system'
          ? 'No audio track was shared. Select a browser tab/window and enable audio sharing.'
          : 'No microphone audio track is available.');
      }

      const mimeType = getSupportedMimeType(mode);
      const session = await window.electronAPI.recordingStart({
        mimeType,
        fileBaseName: mode === 'system' ? 'System Audio Recording' : 'Microphone Recording',
      });
      if (!session.success || !session.sessionId) throw new Error(session.error || 'Could not start recording session.');

      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = mr;
      streamRef.current = stream;
      recordingSessionIdRef.current = session.sessionId;
      recordingStartedAtRef.current = Date.now();
      setRecordingElapsedSec(0);

      mr.ondataavailable = (event) => {
        if (event.data.size > 0 && session.sessionId) appendRecordingChunk(session.sessionId, event.data);
      };
      mr.onstop = async () => {
        setIsRecording(false);
        setIsSavingRecording(true);
        try {
          await appendQueueRef.current;
          if (!shouldSaveRecordingRef.current) {
            await window.electronAPI?.recordingCancel?.({ sessionId: session.sessionId! });
            return;
          }
          const result = await window.electronAPI?.recordingFinish?.({ sessionId: session.sessionId! });
          if (!result?.success || !result.path) {
            throw new Error(result?.error || 'MP3 conversion failed.');
          }
          onFileSelected(result.path, result.name || result.path.split('/').pop() || 'recording.mp3');
        } catch (error: any) {
          await window.electronAPI?.recordingCancel?.({ sessionId: session.sessionId! });
          setRecordingError(error?.message || String(error));
        } finally {
          cleanupRecordingResources();
          setIsSavingRecording(false);
        }
      };
      const sharedVideoTrack = stream.getVideoTracks()[0];
      if (sharedVideoTrack) {
        sharedVideoTrack.onended = () => {
          if (mr.state !== 'inactive') mr.stop();
        };
      }
      mr.start(1000);
      setIsRecording(true);
    } catch (error: any) {
      cleanupRecordingResources();
      setIsRecording(false);
      setIsSavingRecording(false);
      setRecordingError(error?.message || String(error));
    }
  };

  const stopRecording = () => {
    shouldSaveRecordingRef.current = true;
    mediaRecorderRef.current?.requestData?.();
    if (mediaRecorderRef.current?.state !== 'inactive') mediaRecorderRef.current?.stop();
  };

  const cancelRecording = () => {
    shouldSaveRecordingRef.current = false;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    } else {
      const sessionId = recordingSessionIdRef.current;
      if (sessionId) void window.electronAPI?.recordingCancel?.({ sessionId });
      cleanupRecordingResources();
      setIsRecording(false);
      setIsSavingRecording(false);
    }
  };

  const openRecordingsFolder = () => {
    void window.electronAPI?.recordingOpenFolder?.();
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
        <div className={`source-card solid record-source-card ${isRecording ? 'recording' : ''}`}>
          <div className="source-card-icon" style={isRecording ? { borderColor: 'var(--red)', background: 'rgba(255,92,92,0.1)' } : {}}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={isRecording ? 'var(--red)' : 'currentColor'} strokeWidth="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"/></svg>
          </div>
          {isRecording ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="rec-dot" />
                <h3 style={{ color: 'var(--red)' }}>Recording {formatElapsed(recordingElapsedSec)}</h3>
              </div>
              <p>{recordingMode === 'system' ? 'Capturing shared system/browser audio.' : 'Capturing microphone input.'}</p>
              <div className="source-card-actions">
                <button className="btn-save" type="button" onClick={stopRecording}>Stop &amp; Save MP3</button>
                <button className="btn-cancel" type="button" onClick={cancelRecording}>Cancel</button>
              </div>
            </>
          ) : isSavingRecording ? (
            <>
              <h3>Converting to MP3…</h3>
              <p>Saving high-quality 320 kbps MP3 recording.</p>
            </>
          ) : (
            <>
              <h3>Record Audio Source</h3>
              <p>Capture browser/system audio or a connected microphone.</p>
              <div className="recording-source-tabs" role="group" aria-label="Recording source">
                <button
                  type="button"
                  className={`recording-mode-btn ${recordingMode === 'system' ? 'active' : ''}`}
                  onClick={() => setRecordingMode('system')}
                >
                  System
                </button>
                <button
                  type="button"
                  className={`recording-mode-btn ${recordingMode === 'microphone' ? 'active' : ''}`}
                  onClick={() => setRecordingMode('microphone')}
                >
                  Microphone
                </button>
              </div>
              <div className="source-card-actions">
                <button
                  className="btn-save"
                  type="button"
                  onClick={() => startRecording(recordingMode)}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/></svg>
                  Start
                </button>
                {window.electronAPI?.recordingOpenFolder && (
                  <button className="btn-cancel" type="button" onClick={openRecordingsFolder}>Recordings</button>
                )}
              </div>
              {recordingError && <p className="recording-error">{recordingError}</p>}
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
