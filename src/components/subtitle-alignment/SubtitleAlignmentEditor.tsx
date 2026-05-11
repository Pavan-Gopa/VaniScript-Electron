import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackgroundSettings, defaultBackgroundSettings } from '../../lib/shorts-render';
import { Download, Pause, Play, Save, Scissors, SplitSquareHorizontal, Trash2, Link2, Unlink2, Undo2, Redo2, Languages, Repeat, RotateCcw, CheckCheck, X } from 'lucide-react';
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
import {
  addCut,
  removeCut,
  retimeSubtitlesAfterCut,
  retimeKeyframesAfterCut,
  effectiveDuration,
  UndoRedoStack,
  type UndoableState,
  type TimelineCut,
  type TimelineTrim,
  type BoundaryResolution,
} from '../../lib/TimelineCutEngine';
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
  initialCuts?: TimelineCut[];
  initialTrim?: TimelineTrim;
  initialBackgroundSettings?: import('../../lib/shorts-render').BackgroundSettings;
  settings: ShortsSettings;
  subtitleMaxCharsPerLine: number;
  subtitleMaxLines: number;
  /** Whether sync with linked clip is active */
  syncEnabled?: boolean;
  /** Whether a linked partner exists */
  hasLinkedPartner?: boolean;
  /** Current display language for Source/Target toggle */
  currentLanguage?: 'source' | 'target';
  onClose: () => void;
  onSave: (segments: AlignedSubtitleSegment[]) => void;
  onDraftChange?: (segments: AlignedSubtitleSegment[]) => void;
  onSaveFrameKeyframes?: (keyframes: FrameKeyframe[]) => void;
  onDraftFrameKeyframes?: (keyframes: FrameKeyframe[]) => void;
  onToggleSync?: () => void;
  onImportMotion?: () => void;
  onSaveCuts?: (cuts: TimelineCut[]) => void;
  onSaveTrim?: (trim: TimelineTrim) => void;
  onSaveBackgroundSettings?: (bg: import('../../lib/shorts-render').BackgroundSettings) => void;
  /** Switch between source/target language inside the editor */
  onSwitchLanguage?: (lang: 'source' | 'target') => void;
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
  initialCuts,
  initialTrim,
  initialBackgroundSettings,
  settings,
  subtitleMaxCharsPerLine,
  subtitleMaxLines,
  syncEnabled,
  hasLinkedPartner,
  onClose,
  onSave,
  onDraftChange,
  onSaveFrameKeyframes,
  onDraftFrameKeyframes,
  onToggleSync,
  onImportMotion,
  onSaveCuts,
  onSaveTrim,
  onSaveBackgroundSettings,
  currentLanguage,
  onSwitchLanguage,
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
  // ── New state for timeline surgery ──
  const [cuts, setCuts] = useState<TimelineCut[]>([]);
  const [trim, setTrim] = useState<TimelineTrim>({ trimStartSec: 0, trimEndSec: 0 });
  const [razorActive, setRazorActive] = useState(false);
  const [razorStart, setRazorStart] = useState<number | null>(null);
  const [trimDragState, setTrimDragState] = useState<{ edge: 'start' | 'end'; pointerX: number; original: number } | null>(null);
  const [looping, setLooping] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false); // green ✓ feedback after save
  const [bgSettings, setBgSettings] = useState<BackgroundSettings>(initialBackgroundSettings || defaultBackgroundSettings());
  const [inspectorTab, setInspectorTab] = useState<'frame' | 'background'>('frame');
  const blurVideoRef = useRef<HTMLVideoElement>(null);
  const undoStackRef = useRef(new UndoRedoStack());
  const [undoTick, setUndoTick] = useState(0); // force re-render on undo/redo
  // ── Refs for playback (avoid stale closures in RAF/timeupdate) ──
  const cutsRef = useRef<TimelineCut[]>([]);
  const trimRef = useRef<TimelineTrim>({ trimStartSec: 0, trimEndSec: 0 });
  const loopingRef = useRef(false);
  cutsRef.current = cuts;
  trimRef.current = trim;
  loopingRef.current = looping;
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
      backgroundColor: frameGuideColor,
    }];
  }, [frameGuideColor, frameKeyframes, framePanX, framePanY, frameZoom]);

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
    setFrameGuideColor(initialFrameKeyframes?.[0]?.backgroundColor || '#000000');
    setTimelineZoom(1);
     setFrameKeyframes((initialFrameKeyframes || []).map((keyframe) => ({
      ...keyframe,
      time: Math.min(Math.max(0, keyframe.time), clipDurationSec),
      zoom: Math.min(Math.max(0.5, keyframe.zoom), 2),
      x: Math.min(Math.max(-50, keyframe.x), 50),
      y: Math.min(Math.max(-30, keyframe.y), 30),
      backgroundColor: keyframe.backgroundColor || '#000000',
    })).sort((a, b) => a.time - b.time));
    setCuts(initialCuts || []);
    setTrim(initialTrim || { trimStartSec: 0, trimEndSec: 0 });
    setRazorActive(false);
    setRazorStart(null);
    undoStackRef.current.clear();
    window.setTimeout(() => { initializedRef.current = true; }, 0);
  }, [clipDurationSec, clipEndSec, clipStartSec, initialCues, initialCuts, initialFrameKeyframes, initialSegments, initialTrim, isOpen, languageLabel, settings.zoom, title]);

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
      // Undo: Cmd+Z / Ctrl+Z
      if ((event.metaKey || event.ctrlKey) && event.key === 'z' && !event.shiftKey) {
        event.preventDefault();
        performUndo();
      }
      // Redo: Cmd+Shift+Z / Ctrl+Shift+Z
      if ((event.metaKey || event.ctrlKey) && event.key === 'z' && event.shiftKey) {
        event.preventDefault();
        performRedo();
      }
      // Delete/Backspace: remove cut region under playhead
      if (event.key === 'Backspace' || event.key === 'Delete') {
        const cutIndex = cuts.findIndex((c) => currentSec >= c.startSec && currentSec <= c.endSec);
        if (cutIndex >= 0) {
          event.preventDefault();
          pushUndo();
          setCuts((prev) => removeCut(prev, cutIndex));
        }
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [currentSec, cuts, isOpen, onClose]);

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

  // Trim drag handling
  useEffect(() => {
    if (!trimDragState) return;
    const trackEl = waveformTrackRef.current || timelineRef.current;
    if (!trackEl) return;
    const rect = trackEl.getBoundingClientRect();
    const pxPerSec = rect.width / clipDurationSec;
    const move = (event: PointerEvent) => {
      const deltaPx = event.clientX - trimDragState.pointerX;
      const deltaSec = deltaPx / pxPerSec;
      if (trimDragState.edge === 'start') {
        setTrim((prev: TimelineTrim) => ({
          ...prev,
          trimStartSec: Math.max(0, Math.min(clipDurationSec * 0.45, trimDragState.original + deltaSec)),
        }));
      } else {
        setTrim((prev: TimelineTrim) => ({
          ...prev,
          trimEndSec: Math.max(0, Math.min(clipDurationSec * 0.45, trimDragState.original - deltaSec)),
        }));
      }
    };
    const up = () => setTrimDragState(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [clipDurationSec, trimDragState]);

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
    setFrameGuideColor(frame.backgroundColor || '#000000');
  }, [currentSec, frameKeyframes, isOpen]);

  // Playback boundaries derived from trim
  const playStart = trim.trimStartSec;
  const playEnd = clipDurationSec - trim.trimEndSec;

  /** Find the cut region the given time falls inside, reading from ref for RAF safety. */
  function findCutAtRef(sec: number): TimelineCut | null {
    return cutsRef.current.find((c) => sec >= c.startSec && sec < c.endSec) || null;
  }

  /** Same but using state directly (for render-time logic). */
  function findCutAt(sec: number): TimelineCut | null {
    return cuts.find((c) => sec >= c.startSec && sec < c.endSec) || null;
  }

  /** If sec falls inside a cut, return the endSec of that cut; otherwise return sec unchanged. */
  function skipCut(sec: number): number {
    const hit = findCutAt(sec);
    return hit ? hit.endSec : sec;
  }

  /** Skip using ref (for RAF/timeupdate). */
  function skipCutRef(sec: number): number {
    const hit = findCutAtRef(sec);
    return hit ? hit.endSec : sec;
  }

  useEffect(() => {
    if (!isOpen || !playing) return;
    let frameId = 0;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      const video = videoRef.current;
      const audio = audioRef.current;

      // Always schedule next frame first (never let the loop die)
      frameId = window.requestAnimationFrame(tick);

      // Only process when video is actually playing
      if (!video || video.paused || video.seeking) return;

      let local = video.currentTime - clipStartSec;
      const currentTrim = trimRef.current;
      const currentPlayEnd = clipDurationSec - currentTrim.trimEndSec;
      const currentPlayStart = currentTrim.trimStartSec;

      // Skip over cut regions (read from ref for latest data)
      const hit = findCutAtRef(local);
      if (hit) {
        const jumpTo = hit.endSec + 0.02;
        video.currentTime = clipStartSec + jumpTo;
        if (audio) audio.currentTime = clipStartSec + jumpTo;
        setCurrentSec(jumpTo);
        return; // wait for next frame after seek
      }

      // Respect trim end / loop
      if (local >= currentPlayEnd - 0.02) {
        if (loopingRef.current) {
          const restart = skipCutRef(currentPlayStart);
          video.currentTime = clipStartSec + restart;
          if (audio) audio.currentTime = clipStartSec + restart;
          setCurrentSec(restart);
        } else {
          stopped = true;
          window.cancelAnimationFrame(frameId);
          video.pause();
          audio?.pause();
          setCurrentSec(currentPlayEnd);
          setPlaying(false);
        }
      } else {
        setCurrentSec(Math.min(Math.max(0, local), clipDurationSec));
      }
    };
    frameId = window.requestAnimationFrame(tick);
    return () => { stopped = true; window.cancelAnimationFrame(frameId); };
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
    if (blurVideoRef.current) blurVideoRef.current.currentTime = clipStartSec + safe;
    setCurrentSec(safe);
  }

  function seek(nextLocalSec: number) {
    // If seeking lands inside a cut, skip to end of cut
    const adjusted = skipCut(nextLocalSec);
    syncMedia(adjusted);
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
      // If at end or past trim end, restart from trim start
      let startAt = currentSec;
      if (startAt >= playEnd - 0.05 || startAt < playStart) {
        startAt = skipCut(playStart);
      }
      // Skip cut if starting inside one
      startAt = skipCut(startAt);
      syncMedia(startAt);
      if (audio) {
        audio.currentTime = clipStartSec + startAt;
        await audio.play().catch(() => undefined);
      }
      video.currentTime = clipStartSec + startAt;
      await video.play();
      blurVideoRef.current?.play().catch(() => undefined);
      setPlaying(true);
    } else {
      video.pause();
      audio?.pause();
      blurVideoRef.current?.pause();
      setPlaying(false);
    }
  }

  function handleTimeUpdate() {
    // Cut/trim/loop skipping is handled exclusively by the RAF tick loop.
    // This handler just updates currentSec for scrub display when not playing
    // (e.g. after a manual seek or when video fires timeupdate while paused).
    const video = videoRef.current;
    if (!video || playing) return; // RAF tick handles it when playing
    const local = video.currentTime - clipStartSec;
    setCurrentSec(Math.min(Math.max(0, local), clipDurationSec));
  }

  /** Reset everything to the initial state as if opening the editor for the first time. */
  function resetToInitial() {
    if (!confirm('Reset all edits? This will discard all changes and restore the clip to its initial state.')) return;
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
    setFrameGuideColor('#000000');
    setFrameKeyframes([]);
    setCuts([]);
    setTrim({ trimStartSec: 0, trimEndSec: 0 });
    setRazorActive(false);
    setRazorStart(null);
    undoStackRef.current.clear();
    syncMedia(0);
  }

  function startDrag(event: React.PointerEvent, segment: AlignedSubtitleSegment, mode: 'move' | 'start' | 'end') {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.stopPropagation();
    pushUndo();
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
    onSaveCuts?.(cuts);
    onSaveTrim?.(trim);
    onSaveBackgroundSettings?.(bgSettings);
    // Show green flash feedback, don't close the modal
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 2000);
  }

  function getCurrentUndoState(): UndoableState {
    return { segments, frameKeyframes, cuts, trim };
  }

  function pushUndo() {
    undoStackRef.current.push(getCurrentUndoState());
  }

  function performUndo() {
    const restored = undoStackRef.current.undo(getCurrentUndoState());
    if (!restored) return;
    setSegments(restored.segments);
    setFrameKeyframes(restored.frameKeyframes);
    setCuts(restored.cuts);
    setTrim(restored.trim);
    setUndoTick((t) => t + 1);
  }

  function performRedo() {
    const restored = undoStackRef.current.redo(getCurrentUndoState());
    if (!restored) return;
    setSegments(restored.segments);
    setFrameKeyframes(restored.frameKeyframes);
    setCuts(restored.cuts);
    setTrim(restored.trim);
    setUndoTick((t) => t + 1);
  }

  function handleRazorCut(startSec: number, endSec: number) {
    if (endSec <= startSec + 0.1) return;
    pushUndo();
    const newCut: TimelineCut = { startSec, endSec };
    const nextCuts = addCut(cuts, newCut, clipDurationSec);
    const nextSegments = retimeSubtitlesAfterCut(segments, newCut, clipDurationSec, 'trim');
    const nextKeyframes = retimeKeyframesAfterCut(frameKeyframes, newCut);
    setCuts(nextCuts);
    setSegments(nextSegments);
    setFrameKeyframes(nextKeyframes);
    setRazorActive(false);
    setRazorStart(null);
  }

  return (
    <div className="alignment-backdrop">
      <div className="alignment-editor">
        <div className="alignment-head">
          <div>
            <h3>{title}</h3>
            <p>{languageLabel} · {formatPlaybackClock(clipStartSec)} → {formatPlaybackClock(clipEndSec)}</p>
          </div>
          <div className="alignment-head-actions">
            {/* Source / Target language toggle */}
            {onSwitchLanguage && (
              <div className="alignment-lang-toggle">
                <button
                  type="button"
                  className={`btn-dl btn-dl-lang ${currentLanguage === 'source' ? 'active' : ''}`}
                  onClick={() => onSwitchLanguage('source')}
                >Source</button>
                <button
                  type="button"
                  className={`btn-dl btn-dl-lang ${currentLanguage === 'target' ? 'active' : ''}`}
                  onClick={() => onSwitchLanguage('target')}
                >Target</button>
              </div>
            )}
            {/* Sync toggle — always visible when callback exists */}
            {onToggleSync && (
              <button
                type="button"
                className={`btn-dl btn-dl-sync ${syncEnabled ? 'sync-on' : 'sync-off'}`}
                onClick={onToggleSync}
                title={syncEnabled ? 'Sync ON — edits propagate to linked clip' : 'Sync OFF — click to enable sync'}
              >
                {syncEnabled ? <Link2 size={14} /> : <Unlink2 size={14} />}
                {syncEnabled ? 'Sync' : 'Sync'}
              </button>
            )}
            {hasLinkedPartner && onImportMotion && (
              <button
                type="button"
                className="btn-dl btn-dl-secondary"
                onClick={onImportMotion}
                title="Copy motion keyframes from the linked clip"
              >
                <Download size={14} /> Import Motion
              </button>
            )}
            <button
              type="button"
              className="btn-dl btn-dl-icon"
              onClick={performUndo}
              disabled={!undoStackRef.current.canUndo}
              title="Undo (⌘Z)"
            >
              <Undo2 size={14} />
            </button>
            <button
              type="button"
              className="btn-dl btn-dl-icon"
              onClick={performRedo}
              disabled={!undoStackRef.current.canRedo}
              title="Redo (⌘⇧Z)"
            >
              <Redo2 size={14} />
            </button>
            <button type="button" className="btn-dl btn-dl-secondary" onClick={() => setInspectorOpen((open) => !open)}>
              {inspectorOpen ? 'Hide inspector' : 'Show inspector'}
            </button>
            <button
              type="button"
              className="btn-dl btn-dl-danger"
              onClick={resetToInitial}
              title="Reset all changes to initial state"
            >
              <RotateCcw size={14} /> Reset
            </button>
            <button
              type="button"
              className={`btn-dl btn-dl-primary alignment-save-btn ${savedFlash ? 'save-flash' : ''}`}
              onClick={save}
              title="Save edits (stays open)"
            >
              {savedFlash ? <CheckCheck size={14} /> : <Save size={14} />}
              {savedFlash ? 'Saved!' : 'Save edits'}
            </button>
          </div>
          {/* X close button — far top-right corner */}
          <button
            type="button"
            className="alignment-close-x"
            onClick={onClose}
            title="Close visual editor"
          >
            <X size={16} />
          </button>
        </div>

        <div className={`alignment-workspace ${inspectorOpen ? '' : 'inspector-closed'}`}>
          <div className="alignment-left">
        <div className="alignment-main">
          <div className="alignment-preview" style={{ backgroundColor: bgSettings.solidEnabled ? bgSettings.solidColor : '#000000' }}>
            {/* Blur background video layer */}
            {bgSettings.blurEnabled && (
              <video
                ref={blurVideoRef}
                src={videoSrc}
                muted
                playsInline
                className="alignment-blur-bg"
                style={{
                  filter: `blur(${bgSettings.blurStrength}px)`,
                  transform: `scale(${bgSettings.blurScale})`,
                }}
                onLoadedMetadata={() => {
                  if (blurVideoRef.current && videoRef.current) {
                    blurVideoRef.current.currentTime = videoRef.current.currentTime;
                  }
                }}
              />
            )}
            {/* Gradient overlay */}
            {bgSettings.gradientEnabled && (
              <div
                className="alignment-gradient-overlay"
                style={{
                  background: bgSettings.gradientType === 'radial'
                    ? `radial-gradient(ellipse at center, ${bgSettings.gradientColorA}, ${bgSettings.gradientColorB})`
                    : `linear-gradient(${bgSettings.gradientAngle}deg, ${bgSettings.gradientColorA}, ${bgSettings.gradientColorB})`,
                  opacity: bgSettings.gradientOpacity,
                }}
              />
            )}
            <video
              ref={videoRef}
              src={videoSrc}
              muted
              playsInline
              style={{
                transform: `translate(${framePanX}%, ${framePanY}%) scale(${frameZoom})`,
                ...(bgSettings.featherEnabled ? {
                  WebkitMaskImage: `linear-gradient(to bottom, transparent 0px, black ${bgSettings.featherTop}px, black calc(100% - ${bgSettings.featherBottom}px), transparent 100%)`,
                  maskImage: `linear-gradient(to bottom, transparent 0px, black ${bgSettings.featherTop}px, black calc(100% - ${bgSettings.featherBottom}px), transparent 100%)`,
                } : {}),
              }}
              onLoadedMetadata={() => syncMedia(currentSec)}
              onTimeUpdate={handleTimeUpdate}
            />
            <div className="alignment-frame-guide" ref={frameGuideRef} style={{
              '--frame-guide-opacity': bgSettings.frameGuideOpacity ?? 0.75,
              '--frame-guide-border-width': `${bgSettings.frameGuideBorderWidth ?? 2}px`,
              '--frame-guide-blur': `${bgSettings.frameGuideBlur ?? 0}px`,
              '--frame-guide-border-color': (() => {
                const c = (bgSettings.frameGuideColor ?? '#ffaa19').replace('#', '');
                const r = parseInt(c.slice(0, 2), 16);
                const g = parseInt(c.slice(2, 4), 16);
                const b = parseInt(c.slice(4, 6), 16);
                const a = bgSettings.frameGuideBorderOpacity ?? 1;
                return `rgba(${r},${g},${b},${a})`;
              })(),
            } as React.CSSProperties}>
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
          <button
            type="button"
            className={`alignment-razor-btn ${razorActive ? 'active' : ''}`}
            onClick={() => { setRazorActive((r) => !r); setRazorStart(null); }}
            title="Razor tool — click two points on the timeline to cut a section"
          >
            <Scissors size={14} /> {razorActive ? 'Cancel Razor' : 'Razor'}
          </button>
          <button
            type="button"
            className={`alignment-loop-btn ${looping ? 'active' : ''}`}
            onClick={() => setLooping((l) => !l)}
            title={looping ? 'Loop ON — playback will loop within trim boundaries' : 'Loop OFF'}
          >
            <Repeat size={14} /> {looping ? 'Loop ON' : 'Loop'}
          </button>
          {cuts.length > 0 && (
            <span className="alignment-cut-badge">{cuts.length} cut{cuts.length !== 1 ? 's' : ''}</span>
          )}
          {(trim.trimStartSec > 0 || trim.trimEndSec > 0) && (
            <span className="alignment-time-chip" style={{ fontSize: '10px' }}>
              In: {formatPlaybackClock(playStart)} — Out: {formatPlaybackClock(playEnd)}
            </span>
          )}
        </div>

        {/* ── Multi-track timeline ── */}
        <div className="alignment-multitrack" onWheel={handleTimelineWheel}>
          {/* Video track label */}
          <div className="alignment-track-row alignment-track-video">
            <span className="alignment-track-label">Video</span>
            <div
              className="alignment-track-content"
              style={{ width: `${timelineZoom * 100}%` }}
            >
              <div className="alignment-track-bar" />
              {/* Trim handles */}
              {trim.trimStartSec > 0 && (
                <div className="alignment-trim-region trim-start" style={{ width: `${pct(trim.trimStartSec, clipDurationSec)}%` }} />
              )}
              {trim.trimEndSec > 0 && (
                <div className="alignment-trim-region trim-end" style={{ width: `${pct(trim.trimEndSec, clipDurationSec)}%` }} />
              )}
              <div
                className="alignment-trim-handle trim-handle-start"
                style={{ left: `${pct(trim.trimStartSec, clipDurationSec)}%` }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  pushUndo();
                  setTrimDragState({ edge: 'start', pointerX: e.clientX, original: trim.trimStartSec });
                }}
              />
              <div
                className="alignment-trim-handle trim-handle-end"
                style={{ right: `${pct(trim.trimEndSec, clipDurationSec)}%` }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  pushUndo();
                  setTrimDragState({ edge: 'end', pointerX: e.clientX, original: trim.trimEndSec });
                }}
              />
              {/* Cut regions */}
              {cuts.map((cut, i) => (
                <div
                  key={i}
                  className="alignment-cut-region"
                  style={{ left: `${pct(cut.startSec, clipDurationSec)}%`, width: `${pct(cut.endSec - cut.startSec, clipDurationSec)}%` }}
                  title={`Cut: ${formatPlaybackClock(cut.startSec)} → ${formatPlaybackClock(cut.endSec)} — press Backspace to delete`}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    pushUndo();
                    setCuts((prev) => removeCut(prev, i));
                  }}
                  onClick={() => {
                    seek(cut.startSec);
                  }}
                />
              ))}
              <b className="alignment-track-playhead" style={{ left: `${pct(currentSec, clipDurationSec)}%` }} />
            </div>
          </div>

          {/* Audio waveform track */}
          <div className="alignment-track-row alignment-track-audio">
            <span className="alignment-track-label">Audio</span>
            <div
              className="alignment-track-content"
              ref={waveformTrackRef}
              style={{ width: `${timelineZoom * 100}%` }}
              onPointerDown={(event) => {
                event.preventDefault();
                if (razorActive) {
                  const rect = waveformTrackRef.current?.getBoundingClientRect();
                  if (!rect || rect.width <= 0) return;
                  const sec = ((event.clientX - rect.left) / rect.width) * clipDurationSec;
                  if (razorStart === null) {
                    setRazorStart(sec);
                  } else {
                    const start = Math.min(razorStart, sec);
                    const end = Math.max(razorStart, sec);
                    handleRazorCut(start, end);
                  }
                } else {
                  seekFromPointer(event.clientX, waveformTrackRef.current);
                  setScrubbing(true);
                }
              }}
            >
              <div className="alignment-waveform-fill" style={{ width: `${pct(currentSec, clipDurationSec)}%` }} />
              {waveformPeaks.length > 0 ? waveformPeaks.map((peak, index) => (
                <i key={index} style={{ height: `${Math.max(5, peak * 100)}%` }} />
              )) : (
                <em>{waveformError || 'Loading waveform...'}</em>
              )}
              {razorStart !== null && (
                <div className="alignment-razor-mark" style={{ left: `${pct(razorStart, clipDurationSec)}%` }} />
              )}
              {cuts.map((cut, i) => (
                <div
                  key={`ac${i}`}
                  className="alignment-cut-region"
                  style={{ left: `${pct(cut.startSec, clipDurationSec)}%`, width: `${pct(cut.endSec - cut.startSec, clipDurationSec)}%` }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    pushUndo();
                    setCuts((prev) => removeCut(prev, i));
                  }}
                />
              ))}
              <b style={{ left: `${pct(currentSec, clipDurationSec)}%` }} />
            </div>
          </div>

          {/* Subtitle blocks track */}
          <div className="alignment-track-row alignment-track-subtitles">
            <span className="alignment-track-label">Subs</span>
            <div
              className="alignment-track-content alignment-timeline-track"
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
            {cuts.map((cut, i) => (
              <div
                key={`sc${i}`}
                className="alignment-cut-region"
                style={{ left: `${pct(cut.startSec, clipDurationSec)}%`, width: `${pct(cut.endSec - cut.startSec, clipDurationSec)}%` }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  pushUndo();
                  setCuts((prev) => removeCut(prev, i));
                }}
              />
            ))}
            <b className="alignment-track-playhead" style={{ left: `${pct(currentSec, clipDurationSec)}%` }} />
            </div>
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
                  <button type="button" onClick={() => { pushUndo(); setSegments((prev) => splitSegment(prev, selected.id, clipDurationSec)); }}><SplitSquareHorizontal size={14} /> Split</button>
                  <button type="button" onClick={() => { pushUndo(); setSegments((prev) => mergeSegmentWithNext(prev, selected.id, clipDurationSec)); }}><Scissors size={14} /> Merge next</button>
                  <button
                    type="button"
                    onClick={() => {
                      pushUndo();
                      setSegments((prev) => prev.filter((segment) => segment.id !== selected.id));
                      setSelectedId('');
                    }}
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                </div>
                <textarea
                  value={selected.text}
                  onFocus={() => pushUndo()}
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
            {/* Tab bar */}
            <div className="alignment-inspector-tabs">
              <button type="button" className={inspectorTab === 'frame' ? 'active' : ''} onClick={() => setInspectorTab('frame')}>Frame</button>
              <button type="button" className={inspectorTab === 'background' ? 'active' : ''} onClick={() => setInspectorTab('background')}>Background</button>
            </div>

            {inspectorTab === 'frame' && (
            <div className="alignment-frame-panel">
              <h4>Frame animation</h4>
              <p>Adjust the frame, then press Add point. Transitions between points are smooth.</p>
              <label>
                <span>Guide</span>
                <input type="color"
                  value={bgSettings.frameGuideColor ?? '#ffaa19'}
                  onChange={(e) => setBgSettings((prev) => ({ ...prev, frameGuideColor: e.currentTarget.value }))} />
                <b>{bgSettings.frameGuideColor ?? '#ffaa19'}</b>
              </label>
              <label>
                <span>Dim</span>
                <input type="range" min={0} max={1} step={0.05}
                  value={bgSettings.frameGuideOpacity ?? 0.75}
                  onChange={(e) => setBgSettings((prev) => ({ ...prev, frameGuideOpacity: Number(e.currentTarget.value) }))} />
                <b>{Math.round((bgSettings.frameGuideOpacity ?? 0.75) * 100)}%</b>
              </label>
              <label>
                <span>Border</span>
                <input type="range" min={0} max={12} step={0.5}
                  value={bgSettings.frameGuideBorderWidth ?? 2}
                  onChange={(e) => setBgSettings((prev) => ({ ...prev, frameGuideBorderWidth: Number(e.currentTarget.value) }))} />
                <b>{bgSettings.frameGuideBorderWidth ?? 2}px</b>
              </label>
              <label>
                <span>Opacity</span>
                <input type="range" min={0} max={1} step={0.05}
                  value={bgSettings.frameGuideBorderOpacity ?? 1}
                  onChange={(e) => setBgSettings((prev) => ({ ...prev, frameGuideBorderOpacity: Number(e.currentTarget.value) }))} />
                <b>{Math.round((bgSettings.frameGuideBorderOpacity ?? 1) * 100)}%</b>
              </label>
              <label>
                <span>Glow</span>
                <input type="range" min={0} max={30} step={1}
                  value={bgSettings.frameGuideBlur ?? 0}
                  onChange={(e) => setBgSettings((prev) => ({ ...prev, frameGuideBlur: Number(e.currentTarget.value) }))} />
                <b>{bgSettings.frameGuideBlur ?? 0}px</b>
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
                    pushUndo();
                    const nextPoint: FrameKeyframe = {
                      id: `frame_${Date.now()}`,
                      time: currentSec,
                      x: framePanX,
                      y: framePanY,
                      zoom: frameZoom,
                      backgroundColor: frameGuideColor,
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
                  onClick={() => { pushUndo(); setFrameKeyframes([]); }}
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
                        setFrameGuideColor(point.backgroundColor || frameGuideColor);
                      }}
                    >
                      {index + 1}. {formatPlaybackClock(point.time)}
                    </button>
                    <span>{point.zoom.toFixed(2)}x · X {point.x} · Y {point.y}</span>
                    <button type="button" onClick={() => { pushUndo(); setFrameKeyframes((prev) => prev.filter((item) => item.id !== point.id)); }}>×</button>
                  </div>
                ))}
              </div>
            </div>
            )}

            {inspectorTab === 'background' && (
            <div className="alignment-frame-panel alignment-bg-panel">
              <h4>Background settings</h4>
              <p>Layer multiple background effects. Toggle each mode independently.</p>

              {/* ── Solid Color ── */}
              <div className="bg-section">
                <label className="bg-toggle">
                  <input type="checkbox" checked={bgSettings.solidEnabled} onChange={(e) => setBgSettings(prev => ({ ...prev, solidEnabled: e.target.checked }))} />
                  <span className="bg-toggle-label">Solid color</span>
                </label>
                {bgSettings.solidEnabled && (
                  <label>
                    <span>Color</span>
                    <input type="color" value={bgSettings.solidColor} onChange={(e) => setBgSettings(prev => ({ ...prev, solidColor: e.target.value }))} />
                    <b>{bgSettings.solidColor}</b>
                  </label>
                )}
              </div>

              {/* ── Blur Background ── */}
              <div className="bg-section">
                <label className="bg-toggle">
                  <input type="checkbox" checked={bgSettings.blurEnabled} onChange={(e) => setBgSettings(prev => ({ ...prev, blurEnabled: e.target.checked }))} />
                  <span className="bg-toggle-label">Blur background</span>
                </label>
                {bgSettings.blurEnabled && (
                  <>
                    <label>
                      <span>Blur</span>
                      <input type="range" min={1} max={80} step={1} value={bgSettings.blurStrength} onChange={(e) => setBgSettings(prev => ({ ...prev, blurStrength: Number(e.target.value) }))} />
                      <b>{bgSettings.blurStrength}px</b>
                    </label>
                    <label>
                      <span>Scale</span>
                      <input type="range" min={1} max={2} step={0.05} value={bgSettings.blurScale} onChange={(e) => setBgSettings(prev => ({ ...prev, blurScale: Number(e.target.value) }))} />
                      <b>{bgSettings.blurScale.toFixed(2)}x</b>
                    </label>
                  </>
                )}
              </div>

              {/* ── Gradient ── */}
              <div className="bg-section">
                <label className="bg-toggle">
                  <input type="checkbox" checked={bgSettings.gradientEnabled} onChange={(e) => setBgSettings(prev => ({ ...prev, gradientEnabled: e.target.checked }))} />
                  <span className="bg-toggle-label">Gradient overlay</span>
                </label>
                {bgSettings.gradientEnabled && (
                  <>
                    <label className="bg-type-row">
                      <span>Type</span>
                      <select value={bgSettings.gradientType} onChange={(e) => setBgSettings(prev => ({ ...prev, gradientType: e.target.value as 'linear' | 'radial' }))}>
                        <option value="linear">Linear</option>
                        <option value="radial">Radial</option>
                      </select>
                    </label>
                    <label>
                      <span>Color A</span>
                      <input type="color" value={bgSettings.gradientColorA} onChange={(e) => setBgSettings(prev => ({ ...prev, gradientColorA: e.target.value }))} />
                      <b>{bgSettings.gradientColorA}</b>
                    </label>
                    <label>
                      <span>Color B</span>
                      <input type="color" value={bgSettings.gradientColorB} onChange={(e) => setBgSettings(prev => ({ ...prev, gradientColorB: e.target.value }))} />
                      <b>{bgSettings.gradientColorB}</b>
                    </label>
                    {bgSettings.gradientType === 'linear' && (
                      <label>
                        <span>Angle</span>
                        <input type="range" min={0} max={360} step={1} value={bgSettings.gradientAngle} onChange={(e) => setBgSettings(prev => ({ ...prev, gradientAngle: Number(e.target.value) }))} />
                        <b>{bgSettings.gradientAngle}°</b>
                      </label>
                    )}
                    <label>
                      <span>Opacity</span>
                      <input type="range" min={0} max={1} step={0.05} value={bgSettings.gradientOpacity} onChange={(e) => setBgSettings(prev => ({ ...prev, gradientOpacity: Number(e.target.value) }))} />
                      <b>{(bgSettings.gradientOpacity * 100).toFixed(0)}%</b>
                    </label>
                  </>
                )}
              </div>

              {/* ── Edge Feather ── */}
              <div className="bg-section">
                <label className="bg-toggle">
                  <input type="checkbox" checked={bgSettings.featherEnabled} onChange={(e) => setBgSettings(prev => ({ ...prev, featherEnabled: e.target.checked }))} />
                  <span className="bg-toggle-label">Edge feather</span>
                </label>
                {bgSettings.featherEnabled && (
                  <>
                    <label>
                      <span>Top</span>
                      <input type="range" min={0} max={100} step={1} value={bgSettings.featherTop} onChange={(e) => setBgSettings(prev => ({ ...prev, featherTop: Number(e.target.value) }))} />
                      <b>{bgSettings.featherTop}px</b>
                    </label>
                    <label>
                      <span>Bottom</span>
                      <input type="range" min={0} max={100} step={1} value={bgSettings.featherBottom} onChange={(e) => setBgSettings(prev => ({ ...prev, featherBottom: Number(e.target.value) }))} />
                      <b>{bgSettings.featherBottom}px</b>
                    </label>
                  </>
                )}
              </div>
            </div>
            )}
          </div>
          )}
        </div>
      </div>
    </div>
  );
}
