import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, Save, Scissors, SplitSquareHorizontal, Trash2 } from 'lucide-react';
import { formatPlaybackClock } from '../../lib/karaoke';
import {
  AlignedSubtitleSegment,
  cuesToAlignedSegments,
  FrameKeyframe,
  mergeSegmentWithNext,
  moveWordToAdjacentSegment,
  normalizeSegments,
  splitSegment,
  updateSegmentText,
} from '../../lib/subtitle-alignment';
import { ShortsSettings } from '../ShortsReelsPanel';

type AlignmentCue = { startSec: number; endSec: number; text: string };

type Props = {
  isOpen: boolean;
  title: string;
  languageLabel: string;
  videoSrc: string;
  audioSrc: string;
  audioPath?: string;
  clipStartSec: number;
  clipEndSec: number;
  initialCues: AlignmentCue[];
  initialSegments?: AlignedSubtitleSegment[];
  initialFrameKeyframes?: FrameKeyframe[];
  settings: ShortsSettings;
  subtitleMaxCharsPerLine: number;
  subtitleMaxLines: number;
  onClose: () => void;
  onSave: (segments: AlignedSubtitleSegment[]) => void;
  onDraftChange?: (segments: AlignedSubtitleSegment[]) => void;
  onSaveFrameKeyframes?: (keyframes: FrameKeyframe[]) => void;
  onDraftFrameKeyframes?: (keyframes: FrameKeyframe[]) => void;
};

const MIN_DURATION = 0.25;

function pct(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (value / total) * 100));
}

function selectedSegmentAt(segments: AlignedSubtitleSegment[], currentSec: number): AlignedSubtitleSegment | null {
  return segments.find((segment) => currentSec >= segment.start && currentSec < segment.end) || null;
}

function interpolateFrameKeyframes(keyframes: FrameKeyframe[], time: number): FrameKeyframe | null {
  if (keyframes.length === 0) return null;
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (time <= first.time) return first;
  if (time >= last.time) return last;
  const next = sorted.find((point) => point.time >= time);
  const nextIndex = next ? sorted.indexOf(next) : -1;
  if (!next || nextIndex <= 0) return first;
  const prev = sorted[nextIndex - 1];
  const span = Math.max(0.001, next.time - prev.time);
  const linearT = (time - prev.time) / span;
  const t = linearT * linearT * (3 - (2 * linearT));
  return {
    id: 'interpolated',
    time,
    x: prev.x + ((next.x - prev.x) * t),
    y: prev.y + ((next.y - prev.y) * t),
    zoom: prev.zoom + ((next.zoom - prev.zoom) * t),
    backgroundColor: prev.backgroundColor || next.backgroundColor || '#000000',
  };
}

export function SubtitleAlignmentEditor({
  isOpen,
  title,
  languageLabel,
  videoSrc,
  audioSrc,
  audioPath,
  clipStartSec,
  clipEndSec,
  initialCues,
  initialSegments,
  initialFrameKeyframes,
  settings,
  subtitleMaxCharsPerLine,
  subtitleMaxLines,
  onClose,
  onSave,
  onDraftChange,
  onSaveFrameKeyframes,
  onDraftFrameKeyframes,
}: Props) {
  const clipDurationSec = Math.max(1, clipEndSec - clipStartSec);
  const [segments, setSegments] = useState<AlignedSubtitleSegment[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [currentSec, setCurrentSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [waveformPeaks, setWaveformPeaks] = useState<number[]>([]);
  const [waveformError, setWaveformError] = useState('');
  const [frameZoom, setFrameZoom] = useState(settings.zoom);
  const [framePanX, setFramePanX] = useState(0);
  const [framePanY, setFramePanY] = useState(0);
  const [frameBackgroundColor, setFrameBackgroundColor] = useState('#000000');
  const [frameKeyframes, setFrameKeyframes] = useState<FrameKeyframe[]>([]);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [scrubbing, setScrubbing] = useState(false);
  const [frameGuideSize, setFrameGuideSize] = useState({ width: 0, height: 0 });
  const [dragState, setDragState] = useState<{
    id: string;
    mode: 'move' | 'start' | 'end';
    pointerX: number;
    originalStart: number;
    originalEnd: number;
    pixelsPerSecond: number;
  } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const waveformTrackRef = useRef<HTMLDivElement>(null);
  const frameGuideRef = useRef<HTMLDivElement>(null);
  const segmentButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const initKeyRef = useRef('');
  const initializedRef = useRef(false);
  const effectiveFrameKeyframes = useMemo<FrameKeyframe[]>(() => {
    if (frameKeyframes.length > 0) return frameKeyframes;
    return [{
      id: 'frame_base',
      time: 0,
      x: framePanX,
      y: framePanY,
      zoom: frameZoom,
      backgroundColor: frameBackgroundColor,
    }];
  }, [frameBackgroundColor, frameKeyframes, framePanX, framePanY, frameZoom]);

  useEffect(() => {
    if (!isOpen) return;
    const initKey = `${title}|${languageLabel}|${clipStartSec}|${clipEndSec}`;
    if (initKeyRef.current === initKey) return;
    initKeyRef.current = initKey;
    initializedRef.current = false;
    const next = initialSegments?.length
      ? normalizeSegments(initialSegments, clipDurationSec)
      : cuesToAlignedSegments(initialCues, clipDurationSec);
    setSegments(next);
    setSelectedId(next[0]?.id || '');
    setCurrentSec(0);
    setPlaying(false);
    setFrameZoom(settings.zoom);
    setFramePanX(0);
    setFramePanY(0);
    setFrameBackgroundColor(initialFrameKeyframes?.[0]?.backgroundColor || '#000000');
    setTimelineZoom(1);
    setFrameKeyframes((initialFrameKeyframes || []).map((keyframe) => ({
      ...keyframe,
      time: Math.min(Math.max(0, keyframe.time), clipDurationSec),
      zoom: Math.min(Math.max(0.5, keyframe.zoom), 2),
      x: Math.min(Math.max(-50, keyframe.x), 50),
      y: Math.min(Math.max(-30, keyframe.y), 30),
      backgroundColor: keyframe.backgroundColor || '#000000',
    })).sort((a, b) => a.time - b.time));
    window.setTimeout(() => { initializedRef.current = true; }, 0);
  }, [clipDurationSec, clipEndSec, clipStartSec, initialCues, initialFrameKeyframes, initialSegments, isOpen, languageLabel, settings.zoom, title]);

  useEffect(() => {
    if (!isOpen || !initializedRef.current || !onDraftChange) return;
    const timer = window.setTimeout(() => {
      onDraftChange(normalizeSegments(segments, clipDurationSec, { keepEmpty: true }));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [clipDurationSec, isOpen, onDraftChange, segments]);

  useEffect(() => {
    if (!isOpen || !initializedRef.current || !onDraftFrameKeyframes) return;
    const timer = window.setTimeout(() => {
      onDraftFrameKeyframes(effectiveFrameKeyframes);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [effectiveFrameKeyframes, isOpen, onDraftFrameKeyframes]);

  useEffect(() => {
    if (!isOpen) return;
    const node = frameGuideRef.current;
    if (!node) return;
    const updateSize = () => {
      const rect = node.getBoundingClientRect();
      setFrameGuideSize({ width: rect.width, height: rect.height });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(node);
    return () => observer.disconnect();
  }, [isOpen, inspectorOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.code === 'Space') {
        event.preventDefault();
        void togglePlayback();
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const delta = event.key === 'ArrowLeft' ? -0.08 : 0.08;
        seek(currentSec + delta);
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [currentSec, isOpen, onClose]);

  useEffect(() => {
    if (!scrubbing) return;
    const move = (event: PointerEvent) => seekFromPointer(event.clientX, waveformTrackRef.current);
    const up = () => setScrubbing(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [scrubbing]);

  useEffect(() => {
    if (!dragState) return;
    const move = (event: PointerEvent) => {
      const deltaSec = (event.clientX - dragState.pointerX) / dragState.pixelsPerSecond;
      setSegments((prev) => normalizeSegments(prev.map((segment) => {
        if (segment.id !== dragState.id) return segment;
        if (dragState.mode === 'move') {
          const duration = dragState.originalEnd - dragState.originalStart;
          const start = Math.min(Math.max(0, dragState.originalStart + deltaSec), Math.max(0, clipDurationSec - duration));
          return { ...segment, start, end: start + duration };
        }
        if (dragState.mode === 'start') {
          return { ...segment, start: Math.min(Math.max(0, dragState.originalStart + deltaSec), segment.end - MIN_DURATION) };
        }
        return { ...segment, end: Math.max(segment.start + MIN_DURATION, Math.min(clipDurationSec, dragState.originalEnd + deltaSec)) };
      }), clipDurationSec));
    };
    const up = () => setDragState(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [clipDurationSec, dragState]);

  const selected = useMemo(() => segments.find((segment) => segment.id === selectedId) || selectedSegmentAt(segments, currentSec), [currentSec, segments, selectedId]);
  const active = useMemo(() => selectedSegmentAt(segments, currentSec), [currentSec, segments]);
  const boxAlpha = Math.round(settings.subtitleBoxOpacity * 255).toString(16).padStart(2, '0');
  const previewCaption = active?.text || '';
  const captionLineClamp = settings.subtitleUseLinesPerCue ? Math.max(1, subtitleMaxLines) : undefined;
  const captionMaxWidth = settings.subtitleUseCharsPerLine ? `${Math.max(8, subtitleMaxCharsPerLine)}ch` : '100%';
  const frameScale = frameGuideSize.height > 0 ? frameGuideSize.height / 1920 : 1;
  const captionFontSize = Math.max(1, settings.subtitleFontSize * frameScale);
  const captionPaddingY = Math.max(1, captionFontSize * 0.12 * settings.subtitleBoxHeight);
  const captionPaddingX = Math.max(1, captionPaddingY * 1.45);
  const captionRadius = Math.max(0, (4 + (settings.subtitleEdgeSoftness * 18)) * frameScale);
  const captionBlur = Math.max(0, settings.subtitleBoxBlur * frameScale);
  const captionBottom = Math.max(0, settings.subtitleBottomMargin * frameScale);
  const captionLetterSpacing = settings.subtitleLetterSpacing * frameScale;
  const captionTextShadow = `0 ${Math.max(1, 2 * frameScale)}px ${Math.max(1, 3 * frameScale)}px rgba(0,0,0,0.72)`;

  useEffect(() => {
    if (!isOpen) return;
    const nextSelectedId = active?.id || '';
    setSelectedId((current) => current === nextSelectedId ? current : nextSelectedId);
  }, [active?.id, isOpen]);

  useEffect(() => {
    if (!selectedId) return;
    segmentButtonRefs.current.get(selectedId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  useEffect(() => {
    if (!isOpen || frameKeyframes.length === 0) return;
    const frame = interpolateFrameKeyframes(frameKeyframes, currentSec);
    if (!frame) return;
    setFrameZoom(frame.zoom);
    setFramePanX(frame.x);
    setFramePanY(frame.y);
    setFrameBackgroundColor(frame.backgroundColor || '#000000');
  }, [currentSec, frameKeyframes, isOpen]);

  useEffect(() => {
    if (!isOpen || !playing) return;
    let frameId = 0;
    const tick = () => {
      const video = videoRef.current;
      if (video && !video.paused) {
        const local = video.currentTime - clipStartSec;
        setCurrentSec(Math.min(Math.max(0, local), clipDurationSec));
        frameId = window.requestAnimationFrame(tick);
      }
    };
    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [clipDurationSec, clipStartSec, isOpen, playing]);

  useEffect(() => {
    let cancelled = false;
    const loadWaveform = async () => {
      setWaveformPeaks([]);
      setWaveformError('');
      if (!isOpen || !audioPath || !window.electronAPI?.ffmpegExtractWaveformPeaks) return;
      const result = await window.electronAPI.ffmpegExtractWaveformPeaks({
        inputPath: audioPath,
        startSec: clipStartSec,
        durationSec: clipDurationSec,
        peakCount: 180,
      });
      if (cancelled) return;
      if (result.success && result.peaks?.length) {
        setWaveformPeaks(result.peaks);
      } else {
        setWaveformError(result.error || 'Waveform unavailable');
      }
    };
    void loadWaveform();
    return () => { cancelled = true; };
  }, [audioPath, clipDurationSec, clipStartSec, isOpen]);

  if (!isOpen) return null;

  function syncMedia(nextLocalSec: number) {
    const safe = Math.min(Math.max(0, nextLocalSec), clipDurationSec);
    if (videoRef.current) videoRef.current.currentTime = clipStartSec + safe;
    if (audioRef.current) audioRef.current.currentTime = clipStartSec + safe;
    setCurrentSec(safe);
  }

  function seek(nextLocalSec: number) {
    syncMedia(nextLocalSec);
  }

  function seekFromPointer(clientX: number, element: HTMLElement | null) {
    const rect = element?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    seek(((clientX - rect.left) / rect.width) * clipDurationSec);
  }

  function handleTimelineWheel(event: React.WheelEvent) {
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    const factor = event.deltaY > 0 ? 0.88 : 1.14;
    setTimelineZoom((current) => Math.min(8, Math.max(1, current * factor)));
  }

  async function togglePlayback() {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video) return;
    if (video.paused) {
      if (currentSec >= clipDurationSec - 0.05) syncMedia(0);
      if (audio) {
        audio.currentTime = clipStartSec + currentSec;
        await audio.play().catch(() => undefined);
      }
      video.currentTime = clipStartSec + currentSec;
      await video.play();
      setPlaying(true);
    } else {
      video.pause();
      audio?.pause();
      setPlaying(false);
    }
  }

  function handleTimeUpdate() {
    const video = videoRef.current;
    if (!video) return;
    const local = video.currentTime - clipStartSec;
    if (local >= clipDurationSec) {
      video.pause();
      audioRef.current?.pause();
      syncMedia(clipDurationSec);
      setPlaying(false);
      return;
    }
    setCurrentSec(Math.max(0, local));
  }

  function startDrag(event: React.PointerEvent, segment: AlignedSubtitleSegment, mode: 'move' | 'start' | 'end') {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(segment.id);
    setDragState({
      id: segment.id,
      mode,
      pointerX: event.clientX,
      originalStart: segment.start,
      originalEnd: segment.end,
      pixelsPerSecond: Math.max(1, rect.width / clipDurationSec),
    });
  }

  function save() {
    const normalized = normalizeSegments(segments, clipDurationSec);
    setSegments(normalized);
    onSave(normalized);
    onSaveFrameKeyframes?.(effectiveFrameKeyframes);
  }

  return (
    <div className="alignment-backdrop" onMouseDown={onClose}>
      <div className="alignment-editor" onMouseDown={(event) => event.stopPropagation()}>
        <div className="alignment-head">
          <div>
            <h3>{title}</h3>
            <p>{languageLabel} · {formatPlaybackClock(clipStartSec)} → {formatPlaybackClock(clipEndSec)}</p>
          </div>
          <div className="alignment-head-actions">
            <button type="button" className="btn-dl btn-dl-secondary" onClick={() => setInspectorOpen((open) => !open)}>
              {inspectorOpen ? 'Hide inspector' : 'Show inspector'}
            </button>
            <button type="button" className="btn-dl btn-dl-secondary" onClick={onClose}>Close</button>
            <button type="button" className="btn-dl btn-dl-primary" onClick={save}><Save size={14} /> Save edits</button>
          </div>
        </div>

        <div className={`alignment-workspace ${inspectorOpen ? '' : 'inspector-closed'}`}>
          <div className="alignment-left">
        <div className="alignment-main">
          <div className="alignment-preview" style={{ backgroundColor: frameBackgroundColor }}>
            <video
              ref={videoRef}
              src={videoSrc}
              muted
              playsInline
              style={{
                transform: `translate(${framePanX}%, ${framePanY}%) scale(${frameZoom})`,
              }}
              onLoadedMetadata={() => syncMedia(currentSec)}
              onTimeUpdate={handleTimeUpdate}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
            />
            <div className="alignment-frame-guide" ref={frameGuideRef}>
            {previewCaption && (
              <div
                className="alignment-caption-preview"
                style={{
                  background: `${settings.subtitleBoxColor}${boxAlpha}`,
                  color: settings.subtitleTextColor,
                  fontFamily: settings.subtitleFontFamily,
                  fontSize: `${captionFontSize}px`,
                  fontWeight: settings.subtitleBold ? 850 : 600,
                  letterSpacing: `${captionLetterSpacing}px`,
                  lineHeight: settings.subtitleLineSpacing,
                  width: `${settings.subtitleBoxWidth}%`,
                  maxWidth: captionMaxWidth,
                  bottom: `${captionBottom}px`,
                  padding: `${captionPaddingY}px ${captionPaddingX}px`,
                  borderRadius: `${captionRadius}px`,
                  boxShadow: captionBlur > 0 ? `0 0 ${captionBlur}px ${settings.subtitleBoxColor}${boxAlpha}` : undefined,
                  textShadow: captionTextShadow,
                  WebkitLineClamp: captionLineClamp,
                }}
              >
                {settings.subtitleTextTransform === 'uppercase' ? previewCaption.toUpperCase() : previewCaption}
              </div>
            )}
            </div>
          </div>
        </div>

        <div className="alignment-scrub-row" onWheel={handleTimelineWheel}>
          <button
            type="button"
            className="alignment-inline-play"
            onClick={togglePlayback}
            title="Play / pause (Space)"
          >
            {playing ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <span className="alignment-time-chip">{formatPlaybackClock(currentSec)} / {formatPlaybackClock(clipDurationSec)}</span>
          <div
            className="alignment-waveform"
            title="Drag to scrub. Cmd/Ctrl + mouse wheel zooms the timeline."
            onPointerDown={(event) => {
              event.preventDefault();
              seekFromPointer(event.clientX, waveformTrackRef.current);
              setScrubbing(true);
            }}
          >
            <div
              ref={waveformTrackRef}
              className="alignment-waveform-track"
              style={{ width: `${timelineZoom * 100}%` }}
            >
              <div className="alignment-waveform-fill" style={{ width: `${pct(currentSec, clipDurationSec)}%` }} />
              {waveformPeaks.length > 0 ? waveformPeaks.map((peak, index) => (
                <i key={index} style={{ height: `${Math.max(5, peak * 100)}%` }} />
              )) : (
                <em>{waveformError || 'Loading real waveform...'}</em>
              )}
              <b style={{ left: `${pct(currentSec, clipDurationSec)}%` }} />
            </div>
          </div>
        </div>

        <div className="alignment-timeline" onWheel={handleTimelineWheel}>
          <div
            className="alignment-timeline-track"
            ref={timelineRef}
            style={{ width: `${timelineZoom * 100}%` }}
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) seekFromPointer(event.clientX, event.currentTarget);
            }}
          >
          {segments.map((segment) => {
            const left = pct(segment.start, clipDurationSec);
            const width = Math.max(0.6, pct(segment.end - segment.start, clipDurationSec));
            const activeClass = active?.id === segment.id ? 'active' : selected?.id === segment.id ? 'selected' : '';
            return (
              <div
                key={segment.id}
                className={`alignment-block ${activeClass}`}
                style={{ left: `${left}%`, width: `${width}%` }}
                onPointerDown={(event) => startDrag(event, segment, 'move')}
                onDoubleClick={() => seek(segment.start)}
              >
                <span className="alignment-resize left" onPointerDown={(event) => startDrag(event, segment, 'start')} />
                <strong>{segment.text}</strong>
                <span className="alignment-resize right" onPointerDown={(event) => startDrag(event, segment, 'end')} />
              </div>
            );
          })}
          </div>
        </div>

        <audio ref={audioRef} src={audioSrc} className="review-audio-player-hidden" />

        <div className="alignment-edit-panel">
          <div className="alignment-segment-list">
            {segments.map((segment) => (
              <button
                type="button"
                key={segment.id}
                ref={(node) => {
                  if (node) segmentButtonRefs.current.set(segment.id, node);
                  else segmentButtonRefs.current.delete(segment.id);
                }}
                className={segment.id === selected?.id ? 'active' : ''}
                onClick={() => { setSelectedId(segment.id); seek(segment.start); }}
              >
                <span>{formatPlaybackClock(segment.start)} → {formatPlaybackClock(segment.end)}</span>
                {segment.text}
              </button>
            ))}
          </div>
          <div className="alignment-text-editor">
            {selected ? (
              <>
                <div className="alignment-editor-toolbar">
                  <button type="button" onClick={() => setSegments((prev) => splitSegment(prev, selected.id, clipDurationSec))}><SplitSquareHorizontal size={14} /> Split</button>
                  <button type="button" onClick={() => setSegments((prev) => mergeSegmentWithNext(prev, selected.id, clipDurationSec))}><Scissors size={14} /> Merge next</button>
                  <button
                    type="button"
                    onClick={() => {
                      setSegments((prev) => prev.filter((segment) => segment.id !== selected.id));
                      setSelectedId('');
                    }}
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                </div>
                <textarea
                  value={selected.text}
                  onChange={(event) => setSegments((prev) => updateSegmentText(prev, selected.id, event.currentTarget.value, clipDurationSec))}
                />
                <div className="alignment-word-row">
                  {selected.text.match(/\S+/g)?.map((word, index) => (
                    <span key={`${word}-${index}`}>
                      <button type="button" onClick={() => setSegments((prev) => moveWordToAdjacentSegment(prev, selected.id, index, 'previous', clipDurationSec))}>←</button>
                      {word}
                      <button type="button" onClick={() => setSegments((prev) => moveWordToAdjacentSegment(prev, selected.id, index, 'next', clipDurationSec))}>→</button>
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <div className="alignment-empty-editor">Select a subtitle block to edit text and word placement.</div>
            )}
          </div>
        </div>
          </div>

          {inspectorOpen && (
          <div className="alignment-side">
            <div className="alignment-frame-panel">
              <h4>Frame animation</h4>
              <p>Adjust the frame, then press Add point. Transitions between points are smooth.</p>
              <label>
                <span>Bg</span>
                <input type="color" value={frameBackgroundColor} onChange={(event) => setFrameBackgroundColor(event.currentTarget.value)} />
                <b>{frameBackgroundColor}</b>
              </label>
              <label>
                <span>Zoom</span>
                <input type="range" min={0.5} max={2} step={0.01} value={frameZoom} onChange={(event) => setFrameZoom(Number(event.currentTarget.value))} />
                <b>{frameZoom.toFixed(2)}x</b>
              </label>
              <label>
                <span>Pan X</span>
                <input type="range" min={-50} max={50} step={1} value={framePanX} onChange={(event) => setFramePanX(Number(event.currentTarget.value))} />
                <b>{framePanX}</b>
              </label>
              <label>
                <span>Pan Y</span>
                <input type="range" min={-30} max={30} step={1} value={framePanY} onChange={(event) => setFramePanY(Number(event.currentTarget.value))} />
                <b>{framePanY}</b>
              </label>
              <div className="alignment-keyframe-actions">
                <button
                  type="button"
                  onClick={() => {
                    const nextPoint: FrameKeyframe = {
                      id: `frame_${Date.now()}`,
                      time: currentSec,
                      x: framePanX,
                      y: framePanY,
                      zoom: frameZoom,
                      backgroundColor: frameBackgroundColor,
                    };
                    setFrameKeyframes((prev) => [
                      ...prev.filter((point) => Math.abs(point.time - currentSec) > 0.15),
                      nextPoint,
                    ].sort((a, b) => a.time - b.time));
                  }}
                >
                  Add point
                </button>
                <button
                  type="button"
                  onClick={() => setFrameKeyframes([])}
                  disabled={frameKeyframes.length === 0}
                >
                  Clear
                </button>
              </div>
              <div className="alignment-keyframe-list">
                {frameKeyframes.length === 0 ? (
                  <em>No animation points yet.</em>
                ) : frameKeyframes.map((point, index) => (
                  <div key={point.id}>
                    <button
                      type="button"
                      onClick={() => {
                        seek(point.time);
                        setFrameZoom(point.zoom);
                        setFramePanX(point.x);
                        setFramePanY(point.y);
                        setFrameBackgroundColor(point.backgroundColor || frameBackgroundColor);
                      }}
                    >
                      {index + 1}. {formatPlaybackClock(point.time)}
                    </button>
                    <span>{point.zoom.toFixed(2)}x · X {point.x} · Y {point.y}</span>
                    <button type="button" onClick={() => setFrameKeyframes((prev) => prev.filter((item) => item.id !== point.id))}>×</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
          )}
        </div>
      </div>
    </div>
  );
}
