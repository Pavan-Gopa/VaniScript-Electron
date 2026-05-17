import React, { useEffect, useState, useRef } from 'react';
import { Logo } from './Logo';

interface WorkspaceProps {
  onFileSelected: (path: string, name: string) => void;
}

type RecordingMode = 'system' | 'microphone';

interface RecordingPreview {
  sessionId: string;
  url: string;
  mode: RecordingMode;
  bytes?: number;
}

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
  const [isPreparingPreview, setIsPreparingPreview] = useState(false);
  const [recordingMode, setRecordingMode] = useState<RecordingMode>('system');
  const [recordingElapsedSec, setRecordingElapsedSec] = useState(0);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [recordingPreview, setRecordingPreview] = useState<RecordingPreview | null>(null);
  const [audioLevels, setAudioLevels] = useState<number[]>(Array.from({ length: 36 }, () => 0.12));
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingSessionIdRef = useRef<string | null>(null);
  const previewSessionIdRef = useRef<string | null>(null);
  const appendQueueRef = useRef<Promise<void>>(Promise.resolve());
  const shouldSaveRecordingRef = useRef(true);
  const recordingStartedAtRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserFrameRef = useRef<number | null>(null);

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
      const previewSessionId = previewSessionIdRef.current;
      if (previewSessionId) {
        void window.electronAPI?.recordingCancel?.({ sessionId: previewSessionId });
      }
      stopAudioMeter();
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

  const stopAudioMeter = () => {
    if (analyserFrameRef.current !== null) {
      cancelAnimationFrame(analyserFrameRef.current);
      analyserFrameRef.current = null;
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => undefined);
      audioContextRef.current = null;
    }
    setAudioLevels(Array.from({ length: 36 }, () => 0.12));
  };

  const startAudioMeter = (stream: MediaStream) => {
    stopAudioMeter();
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextCtor) return;
    const context = new AudioContextCtor();
    const analyser = context.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.72;
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    audioContextRef.current = context;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const buckets = 36;
      const next = Array.from({ length: buckets }, (_, index) => {
        const start = Math.floor(index * data.length / buckets);
        const end = Math.max(start + 1, Math.floor((index + 1) * data.length / buckets));
        let sum = 0;
        for (let i = start; i < end; i += 1) sum += data[i] || 0;
        return Math.max(0.08, Math.min(1, (sum / (end - start)) / 255));
      });
      setAudioLevels(next);
      analyserFrameRef.current = requestAnimationFrame(tick);
    };
    tick();
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
      if (!window.electronAPI?.recordingStart || !window.electronAPI?.recordingPreview || !window.electronAPI?.recordingFinish) {
        throw new Error('Recording requires the Electron desktop app.');
      }
      setRecordingError(null);
      setRecordingPreview(null);
      setRecordingMode(mode);
      shouldSaveRecordingRef.current = true;
      appendQueueRef.current = Promise.resolve();

      const stream = mode === 'system'
        ? await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          } as MediaTrackConstraints,
        })
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
      startAudioMeter(stream);

      mr.ondataavailable = (event) => {
        if (event.data.size > 0 && session.sessionId) appendRecordingChunk(session.sessionId, event.data);
      };
      mr.onstop = async () => {
        setIsRecording(false);
        setIsPreparingPreview(true);
        stopAudioMeter();
        try {
          await appendQueueRef.current;
          if (!shouldSaveRecordingRef.current) {
            await window.electronAPI?.recordingCancel?.({ sessionId: session.sessionId! });
            return;
          }
          const result = await window.electronAPI?.recordingPreview?.({ sessionId: session.sessionId! });
          if (!result?.success || !result.url) {
            throw new Error(result?.error || 'Recording preview failed.');
          }
          previewSessionIdRef.current = session.sessionId!;
          setRecordingPreview({
            sessionId: session.sessionId!,
            url: result.url,
            mode,
            bytes: result.bytes,
          });
        } catch (error: any) {
          await window.electronAPI?.recordingCancel?.({ sessionId: session.sessionId! });
          setRecordingError(error?.message || String(error));
        } finally {
          cleanupRecordingResources();
          setIsPreparingPreview(false);
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
      stopAudioMeter();
      setIsRecording(false);
      setIsPreparingPreview(false);
      setIsSavingRecording(false);
      const message = error?.name === 'NotSupportedError'
        ? 'System capture is not available for this source. Try a browser tab/window with audio sharing, or use Microphone/virtual audio input.'
        : error?.message || String(error);
      setRecordingError(message);
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
      stopAudioMeter();
      setIsRecording(false);
      setIsPreparingPreview(false);
      setIsSavingRecording(false);
    }
  };

  const saveRecordingPreview = async () => {
    if (!recordingPreview || !window.electronAPI?.recordingFinish) return;
    setIsSavingRecording(true);
    setRecordingError(null);
    try {
      const result = await window.electronAPI.recordingFinish({ sessionId: recordingPreview.sessionId });
      if (!result.success || !result.path) throw new Error(result.error || 'MP3 conversion failed.');
      previewSessionIdRef.current = null;
      setRecordingPreview(null);
      onFileSelected(result.path, result.name || result.path.split('/').pop() || 'recording.mp3');
    } catch (error: any) {
      setRecordingError(error?.message || String(error));
    } finally {
      setIsSavingRecording(false);
    }
  };

  const discardRecordingPreview = async () => {
    if (recordingPreview?.sessionId) {
      await window.electronAPI?.recordingCancel?.({ sessionId: recordingPreview.sessionId });
    }
    previewSessionIdRef.current = null;
    setRecordingPreview(null);
    setRecordingError(null);
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
              <div className="recording-meter" aria-hidden="true">
                {audioLevels.map((level, index) => (
                  <span key={index} style={{ height: `${Math.round(18 + level * 42)}px` }} />
                ))}
              </div>
              <div className="source-card-actions">
                <button className="btn-save" type="button" onClick={stopRecording}>Stop &amp; Review</button>
                <button className="btn-cancel" type="button" onClick={cancelRecording}>Cancel</button>
              </div>
            </>
          ) : isPreparingPreview || isSavingRecording ? (
            <>
              <h3>{isSavingRecording ? 'Converting to MP3…' : 'Preparing preview…'}</h3>
              <p>{isSavingRecording ? 'Saving high-quality 320 kbps MP3 recording.' : 'Loading the captured audio for review.'}</p>
              <div className="recording-meter muted" aria-hidden="true">
                {audioLevels.map((level, index) => (
                  <span key={index} style={{ height: `${Math.round(18 + level * 42)}px` }} />
                ))}
              </div>
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

      {recordingPreview && (
        <div className="recording-review-backdrop" role="dialog" aria-modal="true" aria-label="Review recording">
          <div className="recording-review-modal">
            <button className="recording-review-close" type="button" onClick={discardRecordingPreview} aria-label="Close recording review">×</button>
            <div className="source-card-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
            </div>
            <h3>Review Recording</h3>
            <p>{recordingPreview.mode === 'system' ? 'Listen to the captured system/browser audio before sending it to transcription.' : 'Listen to the microphone recording before sending it to transcription.'}</p>
            <audio className="recording-review-player" controls src={recordingPreview.url} />
            {recordingError && <p className="recording-error">{recordingError}</p>}
            <div className="recording-review-actions">
              <button className="btn-cancel" type="button" onClick={discardRecordingPreview}>Retake</button>
              <button className="btn-save" type="button" onClick={saveRecordingPreview} disabled={isSavingRecording}>
                {isSavingRecording ? 'Saving MP3…' : 'Save & Continue'}
              </button>
            </div>
          </div>
        </div>
      )}

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
