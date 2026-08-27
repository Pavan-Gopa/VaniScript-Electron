import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackgroundSettings, defaultBackgroundSettings, type ShortsSubtitleStyle } from '../../lib/shorts-render';
import { Download, Pause, Play, Save, Scissors, SplitSquareHorizontal, Trash2, Link2, Unlink2, Undo2, Redo2, Languages, Repeat, RotateCcw, CheckCheck, X, HelpCircle, Sparkles } from 'lucide-react';
import { formatPlaybackClock } from '../../lib/karaoke';
import {
  AlignedSubtitleSegment,
  cuesToAlignedSegments,
  FrameKeyframe,
  materializeFrameKeyframesForSave,
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
import type { ExtraAudioTrack, LogoOverlaySettings, TextOverlayBlock, TextOverlayTrack, IntroOutroOverlaySettings } from '../../lib/shorts-reels';
import { AudioTrackManager } from './AudioTrackManager';
import { LogoManager } from './LogoManager';
import { TextTrackManager } from './TextTrackManager';
import { IntroOutroManager } from './IntroOutroManager';
import { loadSettings, saveSettings } from '../../services/storage';
import { OnboardingTour } from '../OnboardingTour';
import { currentBuildId } from '../../lib/build-info';
import { markOnboardingCompletedForBuild, shouldShowOnboardingForBuild } from '../../lib/onboarding';
import { assistantStore } from '../../stores/assistantStore';
import { paneStore } from '../../stores/paneStore';

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
  initialLogo?: LogoOverlaySettings;
  initialTextTracks?: TextOverlayTrack[];
  initialAudioTracks?: ExtraAudioTrack[];
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
  onSaveLogo?: (logo?: LogoOverlaySettings) => void;
  onSaveTextTracks?: (tracks: TextOverlayTrack[]) => void;
  onSaveAudioTracks?: (tracks: ExtraAudioTrack[]) => void;
  initialIntro?: IntroOutroOverlaySettings;
  initialOutro?: IntroOutroOverlaySettings;
  onSaveIntro?: (intro?: IntroOutroOverlaySettings) => void;
  onSaveOutro?: (outro?: IntroOutroOverlaySettings) => void;
  onResetAll?: () => void;
  onSettingsChange?: (settings: ShortsSettings) => void;
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

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    const type = target.type ? target.type.toLowerCase() : 'text';
    const textInputTypes = ['text', 'search', 'url', 'email', 'password', 'number', 'tel'];
    return textInputTypes.includes(type);
  }
  if (target.isContentEditable) return true;
  const closestText = target.closest('input, textarea, [contenteditable="true"], [role="textbox"]');
  if (closestText instanceof HTMLElement) {
    if (closestText instanceof HTMLTextAreaElement) return true;
    if (closestText instanceof HTMLInputElement) {
      const type = closestText.type ? closestText.type.toLowerCase() : 'text';
      const textInputTypes = ['text', 'search', 'url', 'email', 'password', 'number', 'tel'];
      return textInputTypes.includes(type);
    }
    return true;
  }
  return false;
}

function releaseTypingFocus() {
  if (isTypingTarget(document.activeElement)) {
    (document.activeElement as HTMLElement).blur();
  }
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

function computeIntroOutroStyle(
  item: IntroOutroOverlaySettings,
  elapsed: number,
  frameScale: number
): { opacity: number; transform: string; width: string } {
  const baseWidth = 300 * frameScale * item.scale;
  let opacity = 1;
  let scale = 1;
  let translateY = 0;

  const fadeDuration = Math.min(0.5, item.duration * 0.15);
  if (elapsed < fadeDuration) {
    opacity = elapsed / fadeDuration;
  } else if (elapsed > item.duration - fadeDuration) {
    opacity = Math.max(0, (item.duration - elapsed) / fadeDuration);
  }

  const speedFactor = item.speed !== undefined ? item.speed : 1.0;

  if (item.animation === 'pulse') {
    const period = 1.5;
    const progress = ((elapsed * speedFactor) % period) / period;
    scale = 1 + 0.06 * Math.sin(progress * 2 * Math.PI);
  }

  if (item.animation === 'bounce') {
    const period = 1.2;
    const progress = ((elapsed * speedFactor) % period) / period;
    if (progress < 0.4) {
      translateY = 15 * Math.sin((progress / 0.4) * Math.PI);
    } else if (progress < 0.7) {
      translateY = -4 * Math.sin(((progress - 0.4) / 0.3) * Math.PI);
    } else if (progress < 0.9) {
      translateY = 4 * Math.sin(((progress - 0.7) / 0.2) * Math.PI);
    } else {
      translateY = 0;
    }
  }

  return {
    opacity: Math.max(0, Math.min(1, opacity)),
    transform: `translate(-50%, -50%) scale(${scale}) translateY(${translateY * frameScale}px)`,
    width: `${baseWidth}px`,
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
  initialLogo,
  initialTextTracks,
  initialAudioTracks,
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
  onSaveLogo,
  onSaveTextTracks,
  onSaveAudioTracks,
  initialIntro,
  initialOutro,
  onSaveIntro,
  onSaveOutro,
  onResetAll,
  onSettingsChange,
  currentLanguage,
  onSwitchLanguage,
}: Props) {
  const clipDurationSec = Math.max(1, clipEndSec - clipStartSec);
  const onboardingBuildId = useMemo(() => currentBuildId(), []);
  const [annotationMode, setAnnotationMode] = useState(() => {
    try {
      const settings = loadSettings();
      return shouldShowOnboardingForBuild(settings, onboardingBuildId) || settings.annotationMode === true;
    } catch {
      return true;
    }
  });
  const [helpLocale, setHelpLocale] = useState<'en' | 'ru'>(() => {
    try {
      return loadSettings().helpLocale ?? 'en';
    } catch {
      return 'en';
    }
  });
  const handleHelpLocaleChange = useCallback((locale: 'en' | 'ru') => {
    setHelpLocale(locale);
    try {
      saveSettings({ ...loadSettings(), helpLocale: locale });
    } catch (e) {
      console.error(e);
    }
  }, []);
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
  const [overlayDragState, setOverlayDragState] = useState<{
    kind: 'text' | 'audio';
    trackId: string;
    blockId?: string;
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
  const [timelinePanDrag, setTimelinePanDrag] = useState<{ pointerX: number; scrollLeft: number } | null>(null);
  const [looping, setLooping] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false); // green ✓ feedback after save
  const [bgSettings, setBgSettings] = useState<BackgroundSettings>(initialBackgroundSettings || defaultBackgroundSettings());
  const [inspectorTab, setInspectorTab] = useState<'style' | 'frame' | 'background' | 'layers'>('style');
  const [logo, setLogo] = useState<LogoOverlaySettings | undefined>(initialLogo);
  const [textTracks, setTextTracks] = useState<TextOverlayTrack[]>(initialTextTracks || []);
  const [audioTracks, setAudioTracks] = useState<ExtraAudioTrack[]>(initialAudioTracks || []);
  const [intro, setIntro] = useState<IntroOutroOverlaySettings | undefined>(initialIntro);
  const [outro, setOutro] = useState<IntroOutroOverlaySettings | undefined>(initialOutro);
  const [selectedTextBlock, setSelectedTextBlock] = useState<{ trackId: string; blockId: string } | null>(null);
  const [styleTarget, setStyleTarget] = useState<string>('subtitles');

  const introActive = intro && !intro.hidden;
  const outroActive = outro && !outro.hidden;
  const introDuration = introActive ? (intro?.duration || 0) : 0;
  const outroDuration = outroActive ? (outro?.duration || 0) : 0;
  const virtualDuration = introDuration + clipDurationSec + outroDuration;
  const blurVideoRef = useRef<HTMLVideoElement>(null);
  const undoStackRef = useRef(new UndoRedoStack());
  const [undoTick, setUndoTick] = useState(0); // force re-render on undo/redo
  // ── Refs for playback (avoid stale closures in RAF/timeupdate) ──
  const segmentsRef = useRef<AlignedSubtitleSegment[]>([]);
  const cutsRef = useRef<TimelineCut[]>([]);
  const trimRef = useRef<TimelineTrim>({ trimStartSec: 0, trimEndSec: 0 });
  const loopingRef = useRef(false);
  const frameZoomRef = useRef(settings.zoom);
  const framePanXRef = useRef(0);
  const framePanYRef = useRef(0);
  const frameKeyframesRef = useRef<FrameKeyframe[]>([]);
  const bgSettingsRef = useRef<BackgroundSettings>(initialBackgroundSettings || defaultBackgroundSettings());
  segmentsRef.current = segments;
  cutsRef.current = cuts;
  trimRef.current = trim;
  loopingRef.current = looping;
  frameZoomRef.current = frameZoom;
  framePanXRef.current = framePanX;
  framePanYRef.current = framePanY;
  frameKeyframesRef.current = frameKeyframes;
  bgSettingsRef.current = bgSettings;
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const extraAudioRefs = useRef(new Map<string, HTMLAudioElement>());
  const multitrackRef = useRef<HTMLDivElement>(null);
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
      backgroundColor: bgSettings.frameGuideColor ?? '#ffaa19',
    }];
  }, [bgSettings.frameGuideColor, frameKeyframes, framePanX, framePanY, frameZoom]);

  useEffect(() => {
    if (!isOpen) return;
    const clipKey = `${title}|${clipStartSec}|${clipEndSec}`;
    const isClipChange = initKeyRef.current !== clipKey;
    if (isClipChange) {
      initKeyRef.current = clipKey;
    }
    initializedRef.current = false;
    const next = initialSegments?.length
      ? normalizeSegments(initialSegments, clipDurationSec, { keepEmpty: true })
      : cuesToAlignedSegments(initialCues, clipDurationSec);
    segmentsRef.current = next;
    setSegments(next);
    setSelectedId(next[0]?.id || '');
    const nextBg = initialBackgroundSettings || defaultBackgroundSettings();
    const seededBg = {
      ...nextBg,
      frameGuideColor: nextBg.frameGuideColor || '#ffaa19',
    };
    bgSettingsRef.current = seededBg;
    setBgSettings(seededBg);
    const nextFrameKeyframes = (initialFrameKeyframes || []).map((keyframe) => ({
      ...keyframe,
      time: Math.min(Math.max(0, keyframe.time), clipDurationSec),
      zoom: Math.min(Math.max(0.5, keyframe.zoom), 2),
      x: Math.min(Math.max(-50, keyframe.x), 50),
      y: Math.min(Math.max(-30, keyframe.y), 30),
      backgroundColor: keyframe.backgroundColor || '#000000',
    })).sort((a, b) => a.time - b.time);
    frameKeyframesRef.current = nextFrameKeyframes;
    setFrameKeyframes(nextFrameKeyframes);
    cutsRef.current = initialCuts || [];
    setCuts(cutsRef.current);
    trimRef.current = initialTrim || { trimStartSec: 0, trimEndSec: 0 };
    setTrim(trimRef.current);
    setLogo(initialLogo ? structuredClone(initialLogo) : undefined);
    setTextTracks(initialTextTracks ? structuredClone(initialTextTracks) : []);
    setAudioTracks(initialAudioTracks ? structuredClone(initialAudioTracks) : []);
    setIntro(initialIntro ? structuredClone(initialIntro) : undefined);
    setOutro(initialOutro ? structuredClone(initialOutro) : undefined);

    if (isClipChange) {
      setCurrentSec(0);
      setPlaying(false);
      setFrameZoom(settings.zoom);
      setFramePanX(0);
      setFramePanY(0);
      frameZoomRef.current = settings.zoom;
      framePanXRef.current = 0;
      framePanYRef.current = 0;
      setTimelineZoom(1);
      setRazorActive(false);
      setRazorStart(null);
      undoStackRef.current.clear();
    }
    const timer = window.setTimeout(() => {
      initializedRef.current = true;
    }, 50);
    return () => {
      window.clearTimeout(timer);
    };
  }, [clipDurationSec, clipEndSec, clipStartSec, initialAudioTracks, initialBackgroundSettings, initialCues, initialCuts, initialFrameKeyframes, initialLogo, initialSegments, initialTextTracks, initialTrim, isOpen, settings.zoom, title, initialIntro, initialOutro]);

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
    if (!isOpen || !initializedRef.current || !onSaveCuts) return;
    const timer = window.setTimeout(() => {
      onSaveCuts(cuts);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [cuts, isOpen, onSaveCuts]);

  useEffect(() => {
    if (!isOpen || !initializedRef.current || !onSaveTrim) return;
    const timer = window.setTimeout(() => {
      onSaveTrim(trim);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [isOpen, onSaveTrim, trim]);

  useEffect(() => {
    if (!isOpen || !initializedRef.current || !onSaveLogo) return;
    const timer = window.setTimeout(() => onSaveLogo(logo), 150);
    return () => window.clearTimeout(timer);
  }, [isOpen, logo, onSaveLogo]);

  useEffect(() => {
    if (!isOpen || !initializedRef.current || !onSaveTextTracks) return;
    const timer = window.setTimeout(() => onSaveTextTracks(textTracks), 150);
    return () => window.clearTimeout(timer);
  }, [isOpen, onSaveTextTracks, textTracks]);

  useEffect(() => {
    if (!isOpen || !initializedRef.current || !onSaveAudioTracks) return;
    const timer = window.setTimeout(() => onSaveAudioTracks(audioTracks), 150);
    return () => window.clearTimeout(timer);
  }, [audioTracks, isOpen, onSaveAudioTracks]);

  useEffect(() => {
    if (!isOpen || !initializedRef.current || !onSaveIntro) return;
    const timer = window.setTimeout(() => onSaveIntro(intro), 150);
    return () => window.clearTimeout(timer);
  }, [isOpen, intro, onSaveIntro]);

  useEffect(() => {
    if (!isOpen || !initializedRef.current || !onSaveOutro) return;
    const timer = window.setTimeout(() => onSaveOutro(outro), 150);
    return () => window.clearTimeout(timer);
  }, [isOpen, outro, onSaveOutro]);

  useEffect(() => {
    if (!isOpen || !initializedRef.current || !onSaveBackgroundSettings) return;
    const timer = window.setTimeout(() => onSaveBackgroundSettings(backgroundSettingsWithEffectReference(bgSettings)), 150);
    return () => window.clearTimeout(timer);
  }, [bgSettings, frameGuideSize.height, isOpen, onSaveBackgroundSettings]);

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
      if (isTypingTarget(event.target)) return;
      if (event.key === 'Escape') onClose();
      if ((event.code === 'Space' || event.key === ' ') && !event.repeat) {
        event.preventDefault();
        event.stopPropagation();
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
          setCuts((prev) => {
            const next = removeCut(prev, cutIndex);
            cutsRef.current = next;
            return next;
          });
        }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => document.removeEventListener('keydown', keydown, true);
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
    const pxPerSec = rect.width / virtualDuration;
    const move = (event: PointerEvent) => {
      const deltaPx = event.clientX - trimDragState.pointerX;
      const deltaSec = deltaPx / pxPerSec;
      if (trimDragState.edge === 'start') {
        setTrim((prev: TimelineTrim) => {
          const next = {
            ...prev,
            trimStartSec: Math.max(0, Math.min(clipDurationSec * 0.45, trimDragState.original + deltaSec)),
          };
          trimRef.current = next;
          return next;
        });
      } else {
        setTrim((prev: TimelineTrim) => {
          const next = {
            ...prev,
            trimEndSec: Math.max(0, Math.min(clipDurationSec * 0.45, trimDragState.original - deltaSec)),
          };
          trimRef.current = next;
          return next;
        });
      }
    };
    const up = () => setTrimDragState(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [clipDurationSec, virtualDuration, trimDragState]);

  useEffect(() => {
    if (!dragState) return;
    const move = (event: PointerEvent) => {
      const deltaSec = (event.clientX - dragState.pointerX) / dragState.pixelsPerSecond;
      setSegments((prev) => {
        const next = normalizeSegments(prev.map((segment) => {
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
        }), clipDurationSec, { keepEmpty: true });
        segmentsRef.current = next;
        return next;
      });
    };
    const up = () => setDragState(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [clipDurationSec, dragState]);

  useEffect(() => {
    if (!overlayDragState) return;
    const move = (event: PointerEvent) => {
      const deltaSec = (event.clientX - overlayDragState.pointerX) / overlayDragState.pixelsPerSecond;

      if (overlayDragState.kind === 'audio') {
        setAudioTracks((prev) => prev.map((track) => {
          if (track.id !== overlayDragState.trackId) return track;
          if (overlayDragState.mode === 'move') {
            const duration = Math.max(MIN_DURATION, overlayDragState.originalEnd - overlayDragState.originalStart);
            const startSec = Math.min(Math.max(0, overlayDragState.originalStart + deltaSec), Math.max(0, clipDurationSec - duration));
            return { ...track, startSec, trimEndSec: Math.max(0, clipDurationSec - (startSec + duration)) };
          }
          if (overlayDragState.mode === 'start') {
            const startSec = Math.min(Math.max(0, overlayDragState.originalStart + deltaSec), overlayDragState.originalEnd - MIN_DURATION);
            return { ...track, startSec };
          }
          const endSec = Math.max(track.startSec + MIN_DURATION, Math.min(clipDurationSec, overlayDragState.originalEnd + deltaSec));
          return { ...track, trimEndSec: Math.max(0, clipDurationSec - endSec) };
        }));
        return;
      }

      setTextTracks((prev) => prev.map((track) => {
        if (track.id !== overlayDragState.trackId) return track;
        return {
          ...track,
          blocks: track.blocks.map((block) => {
            if (block.id !== overlayDragState.blockId) return block;
            if (overlayDragState.mode === 'move') {
              const duration = overlayDragState.originalEnd - overlayDragState.originalStart;
              const startSec = Math.min(Math.max(0, overlayDragState.originalStart + deltaSec), Math.max(0, clipDurationSec - duration));
              return { ...block, startSec, endSec: startSec + duration };
            }
            if (overlayDragState.mode === 'start') {
              return { ...block, startSec: Math.min(Math.max(0, overlayDragState.originalStart + deltaSec), block.endSec - MIN_DURATION) };
            }
            return { ...block, endSec: Math.max(block.startSec + MIN_DURATION, Math.min(clipDurationSec, overlayDragState.originalEnd + deltaSec)) };
          }),
        };
      }));
    };
    const up = () => setOverlayDragState(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [clipDurationSec, overlayDragState]);

  useEffect(() => {
    if (!timelinePanDrag) return;
    const move = (event: PointerEvent) => {
      const container = multitrackRef.current;
      if (!container) return;
      event.preventDefault();
      container.scrollLeft = timelinePanDrag.scrollLeft - (event.clientX - timelinePanDrag.pointerX);
    };
    const up = () => setTimelinePanDrag(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [timelinePanDrag]);

  const active = useMemo(() => {
    const introActive = intro && !intro.hidden;
    const outroActive = outro && !outro.hidden;
    const introDuration = introActive ? (intro?.duration || 0) : 0;
    const outroDuration = outroActive ? (outro?.duration || 0) : 0;

    const activeVideoStartVirtual = trim.trimStartSec + introDuration;
    const activeVideoEndVirtual = activeVideoStartVirtual + (clipDurationSec - trim.trimStartSec - trim.trimEndSec);

    if (introActive && currentSec >= trim.trimStartSec && currentSec < activeVideoStartVirtual) {
      return null;
    }
    if (outroActive && currentSec >= activeVideoEndVirtual && currentSec < activeVideoEndVirtual + outroDuration) {
      return null;
    }

    const physicalSec = currentSec - introDuration;
    return selectedSegmentAt(segments, physicalSec);
  }, [currentSec, segments, trim, intro, outro, clipDurationSec]);

  const selected = useMemo(() => {
    if (selectedId) {
      const found = segments.find((s) => s.id === selectedId);
      if (found) return found;
    }
    const introActive = intro && !intro.hidden;
    const introDuration = introActive ? (intro?.duration || 0) : 0;
    const physicalSec = currentSec - introDuration;
    return selectedSegmentAt(segments, physicalSec);
  }, [currentSec, segments, selectedId, intro]);
  const activeTextBlocks = useMemo(() => textTracks
    .filter((track) => !track.hidden && !track.muted)
    .flatMap((track, trackIndex) => track.blocks
      .filter((block) => !block.hidden && block.text.trim() && currentSec >= block.startSec && currentSec < block.endSec)
      .map((block) => ({ ...block, trackIndex, style: track.style }))), [currentSec, textTracks]);
  const selectedTextTrack = useMemo(
    () => textTracks.find((track) => track.id === selectedTextBlock?.trackId) || null,
    [selectedTextBlock?.trackId, textTracks],
  );
  const selectedTextOverlay = useMemo(() => (
    selectedTextTrack?.blocks.find((block) => block.id === selectedTextBlock?.blockId) || null
  ), [selectedTextBlock?.blockId, selectedTextTrack]);
  const subtitleStyle = useMemo<ShortsSubtitleStyle>(() => ({
    fontFamily: settings.subtitleFontFamily,
    fontSize: settings.subtitleFontSize,
    bold: settings.subtitleBold,
    textTransform: settings.subtitleTextTransform,
    textColor: settings.subtitleTextColor,
    boxColor: settings.subtitleBoxColor,
    boxOpacity: settings.subtitleBoxOpacity,
    boxWidth: settings.subtitleBoxWidth,
    boxHeight: settings.subtitleBoxHeight,
    edgeBlur: settings.subtitleBoxBlur,
    letterSpacing: settings.subtitleLetterSpacing,
    lineSpacing: settings.subtitleLineSpacing,
    edgeSoftness: settings.subtitleEdgeSoftness,
    outline: settings.subtitleOutline ?? 2,
    outlineColor: settings.subtitleOutlineColor ?? '#000000',
    outlineOpacity: settings.subtitleOutlineOpacity ?? 0.58,
    shadow: settings.subtitleShadowDistance ?? settings.subtitleShadow ?? 6,
    shadowColor: settings.subtitleShadowColor ?? '#000000',
    shadowOpacity: settings.subtitleShadowOpacity ?? 0.72,
    shadowBlur: settings.subtitleShadowBlur ?? 3,
    shadowDistance: settings.subtitleShadowDistance ?? 6,
    shadowAngle: settings.subtitleShadowAngle ?? 90,
  }), [settings]);
  const styleTargetTrack = styleTarget === 'subtitles' ? null : textTracks.find((track) => track.id === styleTarget) || null;
  const activeStyle: ShortsSubtitleStyle = {
    ...subtitleStyle,
    ...(styleTargetTrack?.style || {}),
  };
  const boxAlpha = Math.round(settings.subtitleBoxOpacity * 255).toString(16).padStart(2, '0');
  const previewCaption = active?.text || '';
  const captionLineClamp = settings.subtitleUseLinesPerCue ? Math.max(1, subtitleMaxLines) : undefined;
  const captionMaxWidth = settings.subtitleUseCharsPerLine ? `${Math.max(8, subtitleMaxCharsPerLine)}ch` : '100%';
  const frameScale = frameGuideSize.height > 0 ? frameGuideSize.height / 1920 : 1;
  const captionFontSize = Math.max(1, settings.subtitleFontSize * frameScale);
  const captionPaddingY = Math.max(1, captionFontSize * 0.12 * settings.subtitleBoxHeight);
  const captionPaddingX = Math.max(1, captionPaddingY * 1.45);
  const captionRadius = settings.subtitleEdgeSoftness >= 0.95
    ? 9999
    : (settings.subtitleEdgeSoftness * 80 * frameScale);
  const captionBlur = Math.max(0, settings.subtitleBoxBlur * frameScale);
  const captionBottom = Math.max(0, settings.subtitleBottomMargin * frameScale);
  const captionLetterSpacing = settings.subtitleLetterSpacing * frameScale;
  
  function captionPreviewStyleFor(style: ShortsSubtitleStyle, bottomPx: number, fontFactor = 1): React.CSSProperties {
    const fontSize = Math.max(10, style.fontSize * frameScale * fontFactor);
    const paddingY = Math.max(1, fontSize * 0.12 * style.boxHeight);
    const paddingX = Math.max(1, paddingY * 1.45);
    
    // Dynamic Outline
    const textStroke = Math.max(0, style.outline ?? 2) * frameScale;
    const outlineColor = style.outlineColor ?? '#000000';
    const outlineOpacity = style.outlineOpacity ?? 0.58;
    const outlineHexOpacity = Math.round(outlineOpacity * 255).toString(16).padStart(2, '0');
    const textStrokeColor = `${outlineColor}${outlineHexOpacity}`;

    // Dynamic Shadow
    const dist = (style.shadowDistance ?? style.shadow ?? 6) * frameScale;
    const rad = ((style.shadowAngle ?? 90) * Math.PI) / 180;
    const shadowX = dist * Math.cos(rad);
    const shadowY = dist * Math.sin(rad);
    const shadowBlur = (style.shadowBlur ?? 3) * frameScale;
    const shadowColor = style.shadowColor ?? '#000000';
    const shadowOpacity = style.shadowOpacity ?? 0.72;
    const shadowHexOpacity = Math.round(shadowOpacity * 255).toString(16).padStart(2, '0');

    const shadows: string[] = [];
    if (dist > 0 || shadowBlur > 0) {
      shadows.push(`${shadowX}px ${shadowY}px ${shadowBlur}px ${shadowColor}${shadowHexOpacity}`);
    }
    const textShadow = shadows.length > 0 ? shadows.join(', ') : 'none';

    return {
      color: style.textColor,
      fontFamily: style.fontFamily,
      fontSize: `${fontSize}px`,
      fontWeight: style.bold ? 850 : 600,
      letterSpacing: `${style.letterSpacing * frameScale}px`,
      lineHeight: style.lineSpacing,
      width: `${style.boxWidth}%`,
      maxWidth: captionMaxWidth,
      bottom: `${bottomPx}px`,
      padding: `${paddingY}px ${paddingX}px`,
      textShadow,
      WebkitTextStroke: textStroke > 0 ? `${textStroke.toFixed(2)}px ${textStrokeColor}` : '0 transparent',
      paintOrder: 'stroke fill',
      position: 'absolute',
      overflow: 'visible',
    };
  }
  const logoSafeMargin = Math.max(8, 40 * frameScale);
  const logoPosition = logo?.position ?? 'top-left';
  const logoPlacementStyle: React.CSSProperties = {
    width: `${Math.round(120 * frameScale * (logo?.size ?? 1))}px`,
    opacity: logo?.opacity ?? 1,
    top: logoPosition.startsWith('top') ? `${logoSafeMargin}px` : undefined,
    bottom: logoPosition.startsWith('bottom') ? `${logoSafeMargin}px` : undefined,
    left: logoPosition.endsWith('left') ? `${logoSafeMargin}px` : undefined,
    right: logoPosition.endsWith('right') ? `${logoSafeMargin}px` : undefined,
  };

  useEffect(() => {
    if (!isOpen) return;
    if (selectedTextBlock) return;
    const nextSelectedId = active?.id || '';
    setSelectedId((current) => current === nextSelectedId ? current : nextSelectedId);
  }, [active?.id, isOpen, selectedTextBlock]);

  useEffect(() => {
    if (styleTarget === 'subtitles') return;
    if (!textTracks.some((track) => track.id === styleTarget)) setStyleTarget('subtitles');
  }, [styleTarget, textTracks]);

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
    frameZoomRef.current = frame.zoom;
    framePanXRef.current = frame.x;
    framePanYRef.current = frame.y;
    bgSettingsRef.current = bgSettingsRef.current.frameGuideColor
      ? bgSettingsRef.current
      : { ...bgSettingsRef.current, frameGuideColor: '#ffaa19' };
  }, [currentSec, frameKeyframes, isOpen]);

  // Playback boundaries derived from trim, adjusted for intro/outro graphic durations

  const playStart = trim.trimStartSec;
  const playEnd = introDuration + clipDurationSec - trim.trimEndSec + outroDuration;

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

  function extraAudioEnd(track: ExtraAudioTrack): number {
    return Math.max(track.startSec, clipDurationSec - Math.max(0, track.trimEndSec));
  }

  function extraAudioGain(track: ExtraAudioTrack, localSec: number): number {
    const start = track.startSec; // Allow negative start times (relative to original video start)
    const end = extraAudioEnd(track);
    if (track.muted || localSec < start || localSec > end) return 0;
    const local = localSec - start;
    const duration = Math.max(0.05, end - start);
    let gain = Math.min(Math.max(track.volume, 0), 1);
    if (track.fadeInSec > 0) gain *= Math.min(1, Math.max(0, local / track.fadeInSec));
    if (track.fadeOutSec > 0) gain *= Math.min(1, Math.max(0, (duration - local) / track.fadeOutSec));
    return Math.min(Math.max(gain, 0), 1);
  }

  function syncExtraAudio(virtualSec: number, shouldPlay: boolean) {
    audioTracks.forEach((track) => {
      const node = extraAudioRefs.current.get(track.id);
      if (!node) return;
      
      const introActive = intro && !intro.hidden;
      const introDuration = introActive ? (intro?.duration || 0) : 0;
      
      // Calculate active physical second that corresponds to this virtual coordinate
      const localSec = virtualSec - introDuration;
      
      const gain = extraAudioGain(track, localSec);
      const active = gain > 0;
      const targetTime = Math.max(0, track.trimStartSec + Math.max(0, localSec - track.startSec));
      
      node.volume = gain;
      if (!active) {
        node.pause();
        if (Math.abs(node.currentTime - Math.max(0, track.trimStartSec)) > 0.25) {
          node.currentTime = Math.max(0, track.trimStartSec);
        }
        return;
      }
      if (Number.isFinite(targetTime) && Math.abs(node.currentTime - targetTime) > 0.25) {
        node.currentTime = targetTime;
      }
      if (shouldPlay && node.paused) {
        node.play().catch(() => undefined);
      }
    });
  }

  function mapVirtualToPhysical(virtualSec: number, currentTrim: TimelineTrim): number {
    const introActive = intro && !intro.hidden;
    const outroActive = outro && !outro.hidden;
    const introDuration = introActive ? (intro?.duration || 0) : 0;
    const outroDuration = outroActive ? (outro?.duration || 0) : 0;

    if (virtualSec < currentTrim.trimStartSec) {
      return Math.max(0, virtualSec);
    }
    if (virtualSec >= currentTrim.trimStartSec && virtualSec < currentTrim.trimStartSec + introDuration) {
      return currentTrim.trimStartSec;
    }
    const activeVideoEndVirtual = currentTrim.trimStartSec + introDuration + (clipDurationSec - currentTrim.trimStartSec - currentTrim.trimEndSec);
    if (virtualSec >= currentTrim.trimStartSec + introDuration && virtualSec < activeVideoEndVirtual) {
      return virtualSec - introDuration;
    }
    const outroEndVirtual = activeVideoEndVirtual + outroDuration;
    if (virtualSec >= activeVideoEndVirtual && virtualSec < outroEndVirtual) {
      return clipDurationSec - currentTrim.trimEndSec;
    }
    return Math.min(clipDurationSec, virtualSec - introDuration - outroDuration);
  }

  function mapPhysicalToVirtual(physicalSec: number, currentTrim: TimelineTrim): number {
    const introActive = intro && !intro.hidden;
    const outroActive = outro && !outro.hidden;
    const introDuration = introActive ? (intro?.duration || 0) : 0;
    const outroDuration = outroActive ? (outro?.duration || 0) : 0;

    if (physicalSec < currentTrim.trimStartSec) {
      return physicalSec;
    }
    if (physicalSec >= currentTrim.trimStartSec && physicalSec <= clipDurationSec - currentTrim.trimEndSec) {
      return physicalSec + introDuration;
    }
    return physicalSec + introDuration + outroDuration;
  }

  const lastTimeRef = useRef(0);
  const currentSecRef = useRef(0);
  currentSecRef.current = currentSec;

  useEffect(() => {
    if (!isOpen || !playing) return;
    let frameId = 0;
    let stopped = false;
    lastTimeRef.current = performance.now();

    const tick = () => {
      if (stopped) return;
      const video = videoRef.current;
      const audio = audioRef.current;

      // Always schedule next frame first (never let the loop die)
      frameId = window.requestAnimationFrame(tick);

      const now = performance.now();
      const delta = (now - lastTimeRef.current) / 1000;
      lastTimeRef.current = now;

      if (!video) return;

      const currentTrim = trimRef.current;
      const introActive = intro && !intro.hidden;
      const outroActive = outro && !outro.hidden;
      const introDuration = introActive ? (intro?.duration || 0) : 0;
      const outroDuration = outroActive ? (outro?.duration || 0) : 0;

      const currentPlayStart = currentTrim.trimStartSec; // virtual coordinates start at trimStartSec
      const currentPlayEnd = introDuration + clipDurationSec - currentTrim.trimEndSec + outroDuration; // virtual coordinates end

      let nextSec = currentSecRef.current;

      const activeVideoStartVirtual = currentTrim.trimStartSec + introDuration;
      const activeVideoEndVirtual = activeVideoStartVirtual + (clipDurationSec - currentTrim.trimStartSec - currentTrim.trimEndSec);
      const outroEndVirtual = activeVideoEndVirtual + outroDuration;

      // 1. Playback Clock advancement in Virtual Coordinates
      if (nextSec < currentTrim.trimStartSec) {
        // We are in trimmed start
        nextSec = currentPlayStart;
      } else if (nextSec < activeVideoStartVirtual) {
        // We are in the Intro region
        if (!video.paused) video.pause();
        if (audio && !audio.paused) audio.pause();

        nextSec += delta;

        if (nextSec >= activeVideoStartVirtual) {
          // Transition into main video
          nextSec = activeVideoStartVirtual;
          video.currentTime = clipStartSec + currentTrim.trimStartSec;
          if (audio) audio.currentTime = clipStartSec + currentTrim.trimStartSec;
          video.play().catch(() => undefined);
          audio?.play().catch(() => undefined);
          blurVideoRef.current?.play().catch(() => undefined);
        }
      } else if (nextSec >= activeVideoEndVirtual && nextSec < outroEndVirtual) {
        // We are in the Outro region
        if (!video.paused) video.pause();
        if (audio && !audio.paused) audio.pause();
        if (blurVideoRef.current && !blurVideoRef.current.paused) blurVideoRef.current.pause();

        nextSec += delta;
      } else if (nextSec >= outroEndVirtual) {
        // Trimmed end region
        nextSec = outroEndVirtual;
      } else {
        // We are in the Main video region
        if (video.paused && playing && !video.seeking) {
          video.play().catch(() => undefined);
          audio?.play().catch(() => undefined);
          blurVideoRef.current?.play().catch(() => undefined);
        }
        
        // Sync virtual playhead with actual video play time
        const physicalSec = Math.max(0, video.currentTime - clipStartSec);
        nextSec = physicalSec + introDuration;

        // Skip over cut regions (read from ref for latest data)
        const hit = findCutAtRef(physicalSec);
        if (hit) {
          const jumpTo = hit.endSec + 0.02;
          video.currentTime = clipStartSec + jumpTo;
          if (audio) audio.currentTime = clipStartSec + jumpTo;
          nextSec = jumpTo + introDuration;
        }

        if (nextSec >= activeVideoEndVirtual) {
          nextSec = activeVideoEndVirtual;
          if (!video.paused) video.pause();
          if (audio && !audio.paused) audio.pause();
          if (blurVideoRef.current && !blurVideoRef.current.paused) blurVideoRef.current.pause();
        }
      }

      // 2. Main audio volume fades based on active intro/outro
      let mainVideoVolume = 1;
      const introFadeSec = introActive ? (intro?.transitionSec ?? 1.0) : 1.0;
      const outroFadeSec = outroActive ? (outro?.transitionSec ?? 1.0) : 1.0;

      if (introActive && nextSec >= currentTrim.trimStartSec && nextSec < activeVideoStartVirtual) {
        mainVideoVolume = 0;
      } else if (outroActive && nextSec >= activeVideoEndVirtual && nextSec < outroEndVirtual) {
        mainVideoVolume = 0;
      } else {
        if (introActive && introFadeSec > 0 && nextSec >= activeVideoStartVirtual && nextSec <= activeVideoStartVirtual + introFadeSec) {
          mainVideoVolume = (nextSec - activeVideoStartVirtual) / introFadeSec;
        }
        if (outroActive && outroFadeSec > 0 && nextSec >= activeVideoEndVirtual - outroFadeSec && nextSec <= activeVideoEndVirtual) {
          mainVideoVolume = Math.min(mainVideoVolume, (activeVideoEndVirtual - nextSec) / outroFadeSec);
        }
      }

      if (audio) {
        audio.volume = Math.max(0, Math.min(1, mainVideoVolume));
      }

      // 3. Respect trim end / loop
      if (nextSec >= currentPlayEnd - 0.02) {
        if (loopingRef.current) {
          const restart = currentPlayStart;
          nextSec = restart;
          const physicalRestart = mapVirtualToPhysical(restart, currentTrim);
          if (restart >= activeVideoStartVirtual && restart <= activeVideoEndVirtual) {
            video.currentTime = clipStartSec + physicalRestart;
            if (audio) audio.currentTime = clipStartSec + physicalRestart;
            video.play().catch(() => undefined);
            audio?.play().catch(() => undefined);
          } else {
            if (!video.paused) video.pause();
            if (audio && !audio.paused) audio.pause();
          }
        } else {
          stopped = true;
          window.cancelAnimationFrame(frameId);
          video.pause();
          audio?.pause();
          extraAudioRefs.current.forEach((node) => node.pause());
          nextSec = currentPlayEnd;
          setPlaying(false);
        }
      }

      // 4. Sync extra audios (using virtual time so they play smoothly during Intro/Outro)
      syncExtraAudio(nextSec, playing && (nextSec < activeVideoStartVirtual || nextSec > activeVideoEndVirtual || !video.paused));
      
      currentSecRef.current = nextSec;
      setCurrentSec(nextSec);
    };

    frameId = window.requestAnimationFrame(tick);
    return () => { stopped = true; window.cancelAnimationFrame(frameId); };
  }, [audioTracks, clipDurationSec, clipStartSec, isOpen, playing, intro, outro]);

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

  function syncMedia(virtualSec: number) {
    const safeV = Math.min(Math.max(0, virtualSec), virtualDuration);
    const videoTime = mapVirtualToPhysical(safeV, trim);
    if (videoRef.current) videoRef.current.currentTime = clipStartSec + videoTime;
    if (audioRef.current) audioRef.current.currentTime = clipStartSec + videoTime;
    if (blurVideoRef.current) blurVideoRef.current.currentTime = clipStartSec + videoTime;
    syncExtraAudio(safeV, false);
    setCurrentSec(safeV);
  }

  function seek(virtualSec: number) {
    releaseTypingFocus();
    const safeV = Math.min(Math.max(0, virtualSec), virtualDuration);
    
    const activeVideoStartVirtual = trim.trimStartSec + introDuration;
    const activeVideoEndVirtual = activeVideoStartVirtual + (clipDurationSec - trim.trimStartSec - trim.trimEndSec);
    const outroEndVirtual = activeVideoEndVirtual + outroDuration;
    
    if (
      (introActive && safeV >= trim.trimStartSec && safeV < activeVideoStartVirtual) ||
      (outroActive && safeV >= activeVideoEndVirtual && safeV < outroEndVirtual)
    ) {
      // Seek directly inside Intro/Outro blocks without double-mapping and resetting playhead
      syncMedia(safeV);
      return;
    }
    
    const physicalSec = mapVirtualToPhysical(safeV, trim);
    const adjustedPhysical = skipCut(physicalSec);
    syncMedia(mapPhysicalToVirtual(adjustedPhysical, trim));
  }

  function seekFromPointer(clientX: number, element: HTMLElement | null) {
    const rect = element?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    seek(((clientX - rect.left) / rect.width) * virtualDuration);
  }

  function handleTimelineWheel(event: React.WheelEvent) {
    const container = multitrackRef.current;
    if (!container) return;

    if (event.altKey) {
      event.preventDefault();
      const rect = container.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const contentX = container.scrollLeft + cursorX;
      const oldScrollWidth = Math.max(container.clientWidth, container.scrollWidth);
      const anchorRatio = oldScrollWidth > 0 ? contentX / oldScrollWidth : 0;
      const factor = event.deltaY > 0 ? 0.88 : 1.14;

      setTimelineZoom((current) => {
        const next = Math.min(12, Math.max(1, current * factor));
        window.requestAnimationFrame(() => {
          const nextScrollWidth = Math.max(container.clientWidth, container.scrollWidth);
          container.scrollLeft = Math.max(0, (anchorRatio * nextScrollWidth) - cursorX);
        });
        return next;
      });
      return;
    }

    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      const primaryDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      container.scrollLeft += primaryDelta;
    }
  }

  async function togglePlayback() {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video) return;
    if (!playing) {
      // If at end or past play end, restart from play start
      let startAt = currentSec;
      if (startAt >= playEnd - 0.05 || startAt < playStart) {
        startAt = playStart;
      }
      
      const activeVideoStartVirtual = trim.trimStartSec + introDuration;
      const activeVideoEndVirtual = activeVideoStartVirtual + (clipDurationSec - trim.trimStartSec - trim.trimEndSec);
      
      if (
        !(introActive && startAt >= trim.trimStartSec && startAt < activeVideoStartVirtual) &&
        !(outroActive && startAt >= activeVideoEndVirtual && startAt < playEnd)
      ) {
        // Only do double-mapping and skip-cut if we are NOT inside the Intro or Outro regions
        const physicalSec = mapVirtualToPhysical(startAt, trim);
        const adjustedPhysical = skipCut(physicalSec);
        startAt = mapPhysicalToVirtual(adjustedPhysical, trim);
      }

      lastTimeRef.current = performance.now();
      syncMedia(startAt);

      if (startAt >= trim.trimStartSec + introDuration && startAt <= introDuration + clipDurationSec - trim.trimEndSec) {
        const videoTime = mapVirtualToPhysical(startAt, trim);
        if (audio) {
          audio.currentTime = clipStartSec + videoTime;
          await audio.play().catch(() => undefined);
        }
        video.currentTime = clipStartSec + videoTime;
        try {
          await video.play();
          blurVideoRef.current?.play().catch(() => undefined);
        } catch (error) {
          console.warn('Visual editor video playback failed.', error);
          audio?.pause();
          blurVideoRef.current?.pause();
        }
      }
      syncExtraAudio(startAt, true);
      setPlaying(true);
    } else {
      video.pause();
      audio?.pause();
      extraAudioRefs.current.forEach((node) => node.pause());
      blurVideoRef.current?.pause();
      setPlaying(false);
    }
  }

  function handleTimeUpdate() {
    const video = videoRef.current;
    if (!video || playing) return; // RAF tick handles it when playing
    
    // Check if the current virtual playhead is in Intro or Outro regions
    const activeVideoStartVirtual = trim.trimStartSec + introDuration;
    const activeVideoEndVirtual = activeVideoStartVirtual + (clipDurationSec - trim.trimStartSec - trim.trimEndSec);
    const outroEndVirtual = activeVideoEndVirtual + outroDuration;
    
    if (
      (introActive && currentSec >= trim.trimStartSec && currentSec < activeVideoStartVirtual) ||
      (outroActive && currentSec >= activeVideoEndVirtual && currentSec < outroEndVirtual)
    ) {
      // While in Intro/Outro, don't let paused video seek events override the virtual playhead
      return;
    }
    
    const local = video.currentTime - clipStartSec;
    const safe = Math.min(Math.max(0, local), clipDurationSec);
    const virtualSec = mapPhysicalToVirtual(safe, trim);
    syncExtraAudio(virtualSec, false);
    setCurrentSec(virtualSec);
  }

  /** Reset everything to the initial state as if opening the editor for the first time. */
  function resetToInitial() {
    if (!confirm('Reset all edits? This will discard all changes and restore the clip to its initial state.')) return;
    const next = initialSegments?.length
      ? normalizeSegments(initialSegments, clipDurationSec, { keepEmpty: true })
      : cuesToAlignedSegments(initialCues, clipDurationSec);
    segmentsRef.current = next;
    setSegments(next);
    setSelectedId(next[0]?.id || '');
    setCurrentSec(0);
    setPlaying(false);
    // Reset frame animation
    setFrameZoom(settings.zoom);
    setFramePanX(0);
    setFramePanY(0);
    frameZoomRef.current = settings.zoom;
    framePanXRef.current = 0;
    framePanYRef.current = 0;
    frameKeyframesRef.current = [];
    setFrameKeyframes([]);
    // Reset background settings to defaults
    const resetBg = defaultBackgroundSettings();
    bgSettingsRef.current = resetBg;
    setBgSettings(resetBg);
    // Reset timeline surgery
    cutsRef.current = [];
    setCuts([]);
    trimRef.current = { trimStartSec: 0, trimEndSec: 0 };
    setTrim(trimRef.current);
    setRazorActive(false);
    setRazorStart(null);
    setLogo(undefined);
    setIntro(undefined);
    setOutro(undefined);
    setTextTracks([]);
    setAudioTracks([]);
    undoStackRef.current.clear();
    syncMedia(0);
    // ── Persist the reset immediately (save callbacks use the computed defaults) ──
    if (onResetAll) {
      onResetAll();
    } else {
      onSave(next);
      onSaveFrameKeyframes?.([]);
      onSaveCuts?.([]);
      onSaveTrim?.({ trimStartSec: 0, trimEndSec: 0 });
      onSaveBackgroundSettings?.(resetBg);
      onSaveLogo?.(undefined);
      onSaveTextTracks?.([]);
      onSaveAudioTracks?.([]);
      onSaveIntro?.(undefined);
      onSaveOutro?.(undefined);
    }
  }

  function startDrag(event: React.PointerEvent, segment: AlignedSubtitleSegment, mode: 'move' | 'start' | 'end') {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.stopPropagation();
    pushUndo();
    setSelectedId(segment.id);
    setSelectedTextBlock(null);
    setDragState({
      id: segment.id,
      mode,
      pointerX: event.clientX,
      originalStart: segment.start,
      originalEnd: segment.end,
      pixelsPerSecond: Math.max(1, rect.width / virtualDuration),
    });
  }

  function startTextBlockDrag(event: React.PointerEvent, trackId: string, block: TextOverlayTrack['blocks'][number], mode: 'move' | 'start' | 'end') {
    const rect = (event.currentTarget.parentElement as HTMLElement | null)?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedTextBlock({ trackId, blockId: block.id });
    setSelectedId('');
    setStyleTarget(trackId);
    setOverlayDragState({
      kind: 'text',
      trackId,
      blockId: block.id,
      mode,
      pointerX: event.clientX,
      originalStart: block.startSec,
      originalEnd: block.endSec,
      pixelsPerSecond: Math.max(1, rect.width / virtualDuration),
    });
  }

  function startAudioTrackDrag(event: React.PointerEvent, track: ExtraAudioTrack, mode: 'move' | 'start' | 'end') {
    const rect = (event.currentTarget.parentElement as HTMLElement | null)?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.stopPropagation();
    setOverlayDragState({
      kind: 'audio',
      trackId: track.id,
      mode,
      pointerX: event.clientX,
      originalStart: track.startSec,
      originalEnd: extraAudioEnd(track),
      pixelsPerSecond: Math.max(1, rect.width / virtualDuration),
    });
  }

  function materializeFrameDraft(overrides: Partial<Pick<FrameKeyframe, 'x' | 'y' | 'zoom' | 'backgroundColor'>> = {}): FrameKeyframe[] {
    const latestBg = bgSettingsRef.current;
    return materializeFrameKeyframesForSave({
      frameKeyframes: frameKeyframesRef.current,
      currentSec,
      clipDurationSec,
      framePanX: overrides.x ?? framePanXRef.current,
      framePanY: overrides.y ?? framePanYRef.current,
      frameZoom: overrides.zoom ?? frameZoomRef.current,
      backgroundColor: overrides.backgroundColor ?? latestBg.frameGuideColor ?? '#ffaa19',
    });
  }

  function persistFrameControls(overrides: Partial<Pick<FrameKeyframe, 'x' | 'y' | 'zoom' | 'backgroundColor'>> = {}) {
    if (typeof overrides.zoom === 'number') frameZoomRef.current = overrides.zoom;
    if (typeof overrides.x === 'number') framePanXRef.current = overrides.x;
    if (typeof overrides.y === 'number') framePanYRef.current = overrides.y;
    if (overrides.backgroundColor) {
      bgSettingsRef.current = { ...bgSettingsRef.current, frameGuideColor: overrides.backgroundColor };
    }
    const nextKeyframes = materializeFrameDraft(overrides);
    frameKeyframesRef.current = nextKeyframes;
    setFrameKeyframes(nextKeyframes);
    onDraftFrameKeyframes?.(nextKeyframes);
  }

  function updateBackgroundSettings(updater: (prev: BackgroundSettings) => BackgroundSettings) {
    const next = updater(bgSettingsRef.current);
    bgSettingsRef.current = next;
    setBgSettings(next);
  }

  function backgroundSettingsWithEffectReference(settings: BackgroundSettings): BackgroundSettings {
    const referenceHeight = Math.round(frameGuideSize.height || 0);
    return referenceHeight > 0
      ? { ...settings, effectReferenceHeight: referenceHeight }
      : settings;
  }

  function patchCaptionSettings(partial: Partial<ShortsSettings>) {
    onSettingsChange?.({ ...settings, ...partial });
  }

  function stylePatchToSettings(partial: Partial<ShortsSubtitleStyle>): Partial<ShortsSettings> {
    const next: Partial<ShortsSettings> = {};
    if (partial.fontFamily !== undefined) next.subtitleFontFamily = partial.fontFamily;
    if (partial.fontSize !== undefined) next.subtitleFontSize = partial.fontSize;
    if (partial.bold !== undefined) next.subtitleBold = partial.bold;
    if (partial.textTransform !== undefined) next.subtitleTextTransform = partial.textTransform;
    if (partial.textColor !== undefined) next.subtitleTextColor = partial.textColor;
    if (partial.boxColor !== undefined) next.subtitleBoxColor = partial.boxColor;
    if (partial.boxOpacity !== undefined) next.subtitleBoxOpacity = partial.boxOpacity;
    if (partial.boxWidth !== undefined) next.subtitleBoxWidth = partial.boxWidth;
    if (partial.boxHeight !== undefined) next.subtitleBoxHeight = partial.boxHeight;
    if (partial.edgeBlur !== undefined) next.subtitleBoxBlur = partial.edgeBlur;
    if (partial.letterSpacing !== undefined) next.subtitleLetterSpacing = partial.letterSpacing;
    if (partial.lineSpacing !== undefined) next.subtitleLineSpacing = partial.lineSpacing;
    if (partial.edgeSoftness !== undefined) next.subtitleEdgeSoftness = partial.edgeSoftness;
    if (partial.outline !== undefined) next.subtitleOutline = partial.outline;
    if (partial.outlineColor !== undefined) next.subtitleOutlineColor = partial.outlineColor;
    if (partial.outlineOpacity !== undefined) next.subtitleOutlineOpacity = partial.outlineOpacity;
    if (partial.shadowColor !== undefined) next.subtitleShadowColor = partial.shadowColor;
    if (partial.shadowOpacity !== undefined) next.subtitleShadowOpacity = partial.shadowOpacity;
    if (partial.shadowBlur !== undefined) next.subtitleShadowBlur = partial.shadowBlur;
    if (partial.shadowDistance !== undefined) next.subtitleShadowDistance = partial.shadowDistance;
    if (partial.shadowAngle !== undefined) next.subtitleShadowAngle = partial.shadowAngle;
    return next;
  }

  function patchActiveStyle(partial: Partial<ShortsSubtitleStyle>) {
    if (styleTarget === 'subtitles') {
      patchCaptionSettings(stylePatchToSettings(partial));
      return;
    }
    setTextTracks((prev) => prev.map((track) => (
      track.id === styleTarget
        ? { ...track, style: { ...(track.style || {}), ...partial } }
        : track
    )));
  }

  function addTextOverlayBlock() {
    pushUndo();
    const startSec = Math.min(Math.max(0, currentSec), Math.max(0, clipDurationSec - 1));
    const block: TextOverlayBlock = {
      id: `text_block_${Date.now()}`,
      startSec,
      endSec: Math.min(clipDurationSec, startSec + 3),
      text: '',
    };
    setTextTracks((prev) => {
      const trackId = styleTarget !== 'subtitles' && prev.some((track) => track.id === styleTarget)
        ? styleTarget
        : prev[0]?.id || `text_track_${Date.now()}_0`;
      const next = prev.length === 0
        ? [{ id: trackId, name: 'Text Track 1', blocks: [block] }]
        : prev.map((track) => track.id === trackId ? { ...track, blocks: [...track.blocks, block] } : track);
      setSelectedTextBlock({ trackId, blockId: block.id });
      setSelectedId('');
      setStyleTarget(trackId);
      return next;
    });
  }

  function updateSelectedTextBlock(partial: Partial<TextOverlayBlock>) {
    if (!selectedTextBlock) return;
    setTextTracks((prev) => prev.map((track) => (
      track.id === selectedTextBlock.trackId
        ? {
          ...track,
          blocks: track.blocks.map((block) => block.id === selectedTextBlock.blockId ? { ...block, ...partial } : block),
        }
        : track
    )));
  }

  function deleteSelectedTextBlock() {
    if (!selectedTextBlock) return;
    setTextTracks((prev) => prev.map((track) => (
      track.id === selectedTextBlock.trackId
        ? { ...track, blocks: track.blocks.filter((block) => block.id !== selectedTextBlock.blockId) }
        : track
    )));
    setSelectedTextBlock(null);
  }

  function persistEditorState(showFeedback = false) {
    const normalized = normalizeSegments(segmentsRef.current, clipDurationSec, { keepEmpty: true });
    const savedFrameKeyframes = materializeFrameDraft();
    const savedBackgroundSettings = backgroundSettingsWithEffectReference(bgSettingsRef.current);
    segmentsRef.current = normalized;
    setSegments(normalized);
    frameKeyframesRef.current = savedFrameKeyframes;
    setFrameKeyframes(savedFrameKeyframes);
    onSave(normalized);
    onSaveFrameKeyframes?.(savedFrameKeyframes);
    onSaveCuts?.(cutsRef.current);
    onSaveTrim?.(trimRef.current);
    onSaveBackgroundSettings?.(savedBackgroundSettings);
    onSaveLogo?.(logo);
    onSaveTextTracks?.(textTracks);
    onSaveAudioTracks?.(audioTracks);
    // Show green flash feedback, don't close the modal
    if (showFeedback) {
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    }
  }

  function save() {
    persistEditorState(true);
  }

  function addEmptySubtitleBlock() {
    pushUndo();
    const start = Math.min(Math.max(0, currentSec), Math.max(0, clipDurationSec - 1));
    const segment: AlignedSubtitleSegment = {
      id: `manual_sub_${Date.now()}`,
      start,
      end: Math.min(clipDurationSec, start + 2),
      text: '',
      words: [],
    };
    setSegments((prev) => {
      const next = normalizeSegments([...prev, segment], clipDurationSec, { keepEmpty: true });
      segmentsRef.current = next;
      return next;
    });
    setSelectedId(segment.id);
    setSelectedTextBlock(null);
  }

  function switchLanguage(language: 'source' | 'target') {
    if (language === currentLanguage) return;
    persistEditorState(false);
    onSwitchLanguage?.(language);
  }

  function getCurrentUndoState(): UndoableState {
    return {
      segments: segmentsRef.current,
      frameKeyframes: frameKeyframesRef.current,
      cuts: cutsRef.current,
      trim: trimRef.current,
    };
  }

  function pushUndo() {
    undoStackRef.current.push(getCurrentUndoState());
  }

  function performUndo() {
    const restored = undoStackRef.current.undo(getCurrentUndoState());
    if (!restored) return;
    segmentsRef.current = restored.segments;
    setSegments(restored.segments);
    frameKeyframesRef.current = restored.frameKeyframes;
    setFrameKeyframes(restored.frameKeyframes);
    cutsRef.current = restored.cuts;
    setCuts(restored.cuts);
    trimRef.current = restored.trim;
    setTrim(restored.trim);
    setUndoTick((t) => t + 1);
  }

  function performRedo() {
    const restored = undoStackRef.current.redo(getCurrentUndoState());
    if (!restored) return;
    segmentsRef.current = restored.segments;
    setSegments(restored.segments);
    frameKeyframesRef.current = restored.frameKeyframes;
    setFrameKeyframes(restored.frameKeyframes);
    cutsRef.current = restored.cuts;
    setCuts(restored.cuts);
    trimRef.current = restored.trim;
    setTrim(restored.trim);
    setUndoTick((t) => t + 1);
  }

  function handleRazorCut(startSec: number, endSec: number) {
    if (endSec <= startSec + 0.1) return;
    pushUndo();
    const newCut: TimelineCut = { startSec, endSec };
    const nextCuts = addCut(cutsRef.current, newCut, clipDurationSec);
    const nextSegments = retimeSubtitlesAfterCut(segmentsRef.current, newCut, clipDurationSec, 'trim');
    const nextKeyframes = retimeKeyframesAfterCut(frameKeyframesRef.current, newCut);
    cutsRef.current = nextCuts;
    setCuts(nextCuts);
    segmentsRef.current = nextSegments;
    setSegments(nextSegments);
    frameKeyframesRef.current = nextKeyframes;
    setFrameKeyframes(nextKeyframes);
    setRazorActive(false);
    setRazorStart(null);
  }

  // Main video opacity calculations
  const mainVideoOpacity = (() => {
    const introActive = intro && !intro.hidden;
    const outroActive = outro && !outro.hidden;
    const introDuration = introActive ? (intro?.duration || 0) : 0;
    const outroDuration = outroActive ? (outro?.duration || 0) : 0;

    // During Intro, main video is fully hidden
    if (introActive && currentSec >= trim.trimStartSec && currentSec < trim.trimStartSec + introDuration) {
      return 0;
    }
    // During Outro, main video is fully hidden
    const outroStart = clipDurationSec - trim.trimEndSec + introDuration;
    if (outroActive && currentSec >= outroStart && currentSec < outroStart + outroDuration) {
      return 0;
    }
    // In trimmed-out regions, video is hidden
    if (currentSec < trim.trimStartSec || currentSec > outroStart + outroDuration) {
      return 0;
    }

    let opacity = 1;
    // Fade in right after Intro ends
    const introFadeSec = introActive ? (intro?.transitionSec ?? 1.0) : 1.0;
    const activeVideoStart = trim.trimStartSec + introDuration;
    if (introActive && introFadeSec > 0 && currentSec >= activeVideoStart && currentSec <= activeVideoStart + introFadeSec) {
      opacity = (currentSec - activeVideoStart) / introFadeSec;
    }
    // Fade out right before Outro starts
    const outroFadeSec = outroActive ? (outro?.transitionSec ?? 1.0) : 1.0;
    if (outroActive && outroFadeSec > 0 && currentSec >= outroStart - outroFadeSec && currentSec <= outroStart) {
      opacity = Math.min(opacity, (outroStart - currentSec) / outroFadeSec);
    }
    return Math.max(0, Math.min(1, opacity));
  })();

  const activeVideoDuration = Math.max(0, clipDurationSec - trim.trimStartSec - trim.trimEndSec);

  const N = waveformPeaks.length;
  const safeClipDur = clipDurationSec || 1;
  const startIndex = N > 0 ? Math.round((trim.trimStartSec / safeClipDur) * N) : 0;
  const endIndex = N > 0 ? Math.round(((clipDurationSec - trim.trimEndSec) / safeClipDur) * N) : 0;

  const startPeaks = waveformPeaks.slice(0, startIndex);
  const activePeaks = waveformPeaks.slice(startIndex, endIndex);
  const endPeaks = waveformPeaks.slice(endIndex);

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
                  onClick={() => switchLanguage('source')}
                >Source</button>
                <button
                  type="button"
                  className={`btn-dl btn-dl-lang ${currentLanguage === 'target' ? 'active' : ''}`}
                  onClick={() => switchLanguage('target')}
                >Target</button>
              </div>
            )}
            {/* Sync toggle — always visible when callback exists */}
            {onToggleSync && (
              <button
                type="button"
                className={`btn-dl btn-dl-sync ${syncEnabled ? 'sync-on' : 'sync-off'}`}
                onClick={() => {
                  persistEditorState(false);
                  onToggleSync();
                }}
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
            <button
              type="button"
              className={`btn-dl btn-dl-icon ${annotationMode ? 'active' : ''}`}
              onClick={() => {
                const nextMode = !annotationMode;
                setAnnotationMode(nextMode);
                try {
                  const s = loadSettings();
                  saveSettings(nextMode ? { ...s, annotationMode: true } : markOnboardingCompletedForBuild(s, onboardingBuildId));
                } catch (e) {
                  console.error(e);
                }
              }}
              title={annotationMode ? "Disable Help Tour" : "Enable Help Tour"}
            >
              <HelpCircle size={14} style={{ color: annotationMode ? 'var(--accent)' : 'inherit' }} />
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
              className="btn-dl btn-dl-secondary"
              data-testid="send-to-assistant-editor"
              onClick={() => {
                const selectedText = selectedTextOverlay?.text || selected?.text || '';
                assistantStore.queueSelection({
                  source: 'editor',
                  text: selectedText || `${title} ${formatPlaybackClock(clipStartSec)}-${formatPlaybackClock(clipEndSec)}`,
                  label: title,
                });
                paneStore.setChatSidebar(true);
              }}
            >
              <Sparkles size={14} /> Send to Assistant
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
                  opacity: 1,
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
                opacity: mainVideoOpacity,
                ...(bgSettings.featherEnabled ? {
                  WebkitMaskImage: `linear-gradient(to bottom, transparent 0px, black ${bgSettings.featherTop ?? 0}px, black calc(100% - ${bgSettings.featherBottom ?? 0}px), transparent 100%)`,
                  maskImage: `linear-gradient(to bottom, transparent 0px, black ${bgSettings.featherTop ?? 0}px, black calc(100% - ${bgSettings.featherBottom ?? 0}px), transparent 100%)`,
                } : {}),
              }}
              onLoadedMetadata={() => syncMedia(currentSec)}
              onTimeUpdate={handleTimeUpdate}
            />
            <div className="alignment-frame-guide" ref={frameGuideRef} style={{
              '--frame-guide-opacity': bgSettings.frameGuideOpacity ?? 0.5,
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
                  ...captionPreviewStyleFor(subtitleStyle, captionBottom),
                  WebkitLineClamp: captionLineClamp,
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background: `${settings.subtitleBoxColor}${boxAlpha}`,
                    borderRadius: `${captionRadius}px`,
                    filter: captionBlur > 0 ? `blur(${captionBlur}px)` : undefined,
                    zIndex: -1,
                    pointerEvents: 'none',
                  }}
                />
                <span style={{ position: 'relative', zIndex: 1 }}>
                  {settings.subtitleTextTransform === 'uppercase' ? previewCaption.toUpperCase() : previewCaption}
                </span>
              </div>
            )}
            {activeTextBlocks.map((block) => {
              const blockStyle = { ...subtitleStyle, ...(block.style || {}) };
              const blockAlpha = Math.round(Math.min(Math.max(blockStyle.boxOpacity ?? 0.5, 0), 1) * 255).toString(16).padStart(2, '0');
              const blockRadius = blockStyle.edgeSoftness >= 0.95
                ? 9999
                : (blockStyle.edgeSoftness * 80 * frameScale);
              const blockBlur = Math.max(0, blockStyle.edgeBlur * frameScale);
              return (
                <div
                  key={block.id}
                  className="alignment-caption-preview alignment-text-overlay-preview"
                  style={captionPreviewStyleFor(
                    blockStyle,
                    captionBottom + ((block.trackIndex + 1) * (captionFontSize * 1.65)),
                    0.82,
                  )}
                >
                  <div
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      bottom: 0,
                      background: `${blockStyle.boxColor}${blockAlpha}`,
                      borderRadius: `${blockRadius}px`,
                      filter: blockBlur > 0 ? `blur(${blockBlur}px)` : undefined,
                      zIndex: -1,
                      pointerEvents: 'none',
                    }}
                  />
                  <span style={{ position: 'relative', zIndex: 1 }}>
                    {(block.style?.textTransform || settings.subtitleTextTransform) === 'uppercase' ? block.text.toUpperCase() : block.text}
                  </span>
                </div>
              );
            })}
            {logo?.src && !logo.hidden && (() => {
              const introActive = intro && !intro.hidden;
              const introDuration = introActive ? (intro?.duration || 0) : 0;
              const activeVideoStartVirtual = trim.trimStartSec + introDuration;
              const activeVideoEndVirtual = activeVideoStartVirtual + (clipDurationSec - trim.trimStartSec - trim.trimEndSec);

              if (currentSec >= activeVideoStartVirtual && currentSec <= activeVideoEndVirtual) {
                return (
                  <img
                    className="alignment-logo-overlay-preview"
                    src={logo.src}
                    alt={logo.name || 'Logo'}
                    style={logoPlacementStyle}
                  />
                );
              }
              return null;
            })()}
             {intro?.src && !intro.hidden && currentSec >= trim.trimStartSec && currentSec <= trim.trimStartSec + introDuration && (() => {
              const elapsed = currentSec - trim.trimStartSec;
              const style = computeIntroOutroStyle(intro, elapsed, frameScale);
              return (
                <img
                  className="alignment-intro-overlay-preview"
                  src={intro.src}
                  alt={intro.name || 'Intro'}
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: `${intro.y}%`,
                    pointerEvents: 'none',
                    height: 'auto',
                    zIndex: 10,
                    ...style,
                  }}
                />
              );
            })()}
            {outro?.src && !outro.hidden && (() => {
              const outroStart = clipDurationSec - trim.trimEndSec + introDuration;
              if (currentSec >= outroStart && currentSec <= outroStart + outroDuration) {
                const elapsed = currentSec - outroStart;
                const style = computeIntroOutroStyle(outro, elapsed, frameScale);
                return (
                  <img
                    className="alignment-outro-overlay-preview"
                    src={outro.src}
                    alt={outro.name || 'Outro'}
                    style={{
                      position: 'absolute',
                      left: '50%',
                      top: `${outro.y}%`,
                      pointerEvents: 'none',
                      height: 'auto',
                      zIndex: 10,
                      ...style,
                    }}
                  />
                );
              }
              return null;
            })()}
            </div>
          </div>
        </div>

        <div className="alignment-scrub-row">
          <button
            type="button"
            className="alignment-inline-play"
            onClick={togglePlayback}
            title="Play / pause (Space)"
          >
            {playing ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <span className="alignment-time-chip">{formatPlaybackClock(currentSec)} / {formatPlaybackClock(virtualDuration)}</span>
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
              In: {formatPlaybackClock(playStart + introDuration)} — Out: {formatPlaybackClock(playEnd)}
            </span>
          )}
        </div>

        {/* ── Multi-track timeline ── */}
        <div
          className={`alignment-multitrack ${timelinePanDrag ? 'panning' : ''}`}
          ref={multitrackRef}
          onWheel={handleTimelineWheel}
          onPointerDownCapture={(event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            event.stopPropagation();
            setTimelinePanDrag({
              pointerX: event.clientX,
              scrollLeft: multitrackRef.current?.scrollLeft || 0,
            });
          }}
        >
          {/* Video track label */}
          <div className="alignment-track-row alignment-track-video">
            <span className="alignment-track-label">Video</span>
            <div
              className="alignment-track-content"
              style={{ width: `${timelineZoom * 100}%` }}
            >
              <div className="alignment-track-bar" />
              
              {/* Trimmed-out start of original video */}
              {trim.trimStartSec > 0 && (
                <div
                  className="alignment-trim-region trim-start"
                  style={{
                    position: 'absolute',
                    left: 0,
                    width: `${pct(trim.trimStartSec, virtualDuration)}%`,
                    height: '100%',
                    top: 0,
                    zIndex: 2,
                  }}
                />
              )}

              {/* Shaded boundary for Intro in Video Track */}
              {introActive && (
                <div
                  className="alignment-intro-block"
                  style={{
                    position: 'absolute',
                    left: `${pct(trim.trimStartSec, virtualDuration)}%`,
                    width: `${pct(introDuration, virtualDuration)}%`,
                    height: '100%',
                    top: 0,
                    background: 'linear-gradient(90deg, rgba(147, 51, 234, 0.15) 0%, rgba(147, 51, 234, 0.3) 100%)',
                    borderLeft: '2px dashed #9333ea',
                    borderRight: '2px dashed #9333ea',
                    pointerEvents: 'none',
                    userSelect: 'none',
                    boxSizing: 'border-box',
                    zIndex: 2,
                  }}
                />
              )}

              {/* Shifting media container (Active Video) */}
              <div
                className="alignment-media-container"
                style={{
                  position: 'absolute',
                  left: `${pct(trim.trimStartSec + introDuration, virtualDuration)}%`,
                  width: `${pct(activeVideoDuration, virtualDuration)}%`,
                  height: '100%',
                  top: 0,
                }}
              >
                {/* Cut regions */}
                {cuts.map((cut, i) => {
                  if (cut.endSec <= trim.trimStartSec || cut.startSec >= clipDurationSec - trim.trimEndSec) return null;
                  const visibleStart = Math.max(trim.trimStartSec, cut.startSec);
                  const visibleEnd = Math.min(clipDurationSec - trim.trimEndSec, cut.endSec);
                  return (
                    <div
                      key={i}
                      className="alignment-cut-region"
                      style={{
                        left: `${pct(visibleStart - trim.trimStartSec, activeVideoDuration)}%`,
                        width: `${pct(visibleEnd - visibleStart, activeVideoDuration)}%`
                      }}
                      title={`Cut: ${formatPlaybackClock(cut.startSec)} → ${formatPlaybackClock(cut.endSec)} — press Backspace to delete`}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        pushUndo();
                        setCuts((prev) => {
                          const next = removeCut(prev, i);
                          cutsRef.current = next;
                          return next;
                        });
                      }}
                      onClick={() => {
                        seek(mapPhysicalToVirtual(cut.startSec, trim));
                      }}
                    />
                  );
                })}
              </div>

              {/* Shaded boundary for Outro in Video Track */}
              {outroActive && (
                <div
                  className="alignment-outro-block"
                  style={{
                    position: 'absolute',
                    left: `${pct(clipDurationSec - trim.trimEndSec + introDuration, virtualDuration)}%`,
                    width: `${pct(outroDuration, virtualDuration)}%`,
                    height: '100%',
                    top: 0,
                    background: 'linear-gradient(90deg, rgba(147, 51, 234, 0.3) 0%, rgba(147, 51, 234, 0.15) 100%)',
                    borderLeft: '2px dashed #9333ea',
                    borderRight: '2px dashed #9333ea',
                    pointerEvents: 'none',
                    userSelect: 'none',
                    boxSizing: 'border-box',
                    zIndex: 2,
                  }}
                />
              )}

              {/* Trimmed-out end of original video */}
              {trim.trimEndSec > 0 && (
                <div
                  className="alignment-trim-region trim-end"
                  style={{
                    position: 'absolute',
                    left: `${pct(virtualDuration - trim.trimEndSec, virtualDuration)}%`,
                    width: `${pct(trim.trimEndSec, virtualDuration)}%`,
                    height: '100%',
                    top: 0,
                    zIndex: 2,
                  }}
                />
              )}

              {/* Trim handles (positioned relative to virtual timeline) */}
              <div
                className="alignment-trim-handle trim-handle-start"
                style={{
                  left: `${pct(trim.trimStartSec + introDuration, virtualDuration)}%`,
                  zIndex: 4,
                }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  pushUndo();
                  setTrimDragState({ edge: 'start', pointerX: e.clientX, original: trim.trimStartSec });
                }}
              />
              <div
                className="alignment-trim-handle trim-handle-end"
                style={{
                  left: `${pct(clipDurationSec - trim.trimEndSec + introDuration, virtualDuration)}%`,
                  zIndex: 4,
                }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  pushUndo();
                  setTrimDragState({ edge: 'end', pointerX: e.clientX, original: trim.trimEndSec });
                }}
              />

              <b className="alignment-track-playhead" style={{ left: `${pct(currentSec, virtualDuration)}%`, zIndex: 10 }} />
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
                const rect = waveformTrackRef.current?.getBoundingClientRect();
                if (!rect || rect.width <= 0) return;
                const virtualSec = ((event.clientX - rect.left) / rect.width) * virtualDuration;
                const physicalSec = virtualSec - introDuration;
                if (razorActive) {
                  if (physicalSec >= 0 && physicalSec <= clipDurationSec) {
                    if (razorStart === null) {
                      setRazorStart(physicalSec);
                    } else {
                      const start = Math.min(razorStart, physicalSec);
                      const end = Math.max(razorStart, physicalSec);
                      handleRazorCut(start, end);
                    }
                  }
                } else {
                  seek(virtualSec);
                  setScrubbing(true);
                }
              }}
            >
              {waveformPeaks.length > 0 ? (
                <>
                  {/* Trimmed start peaks */}
                  {trim.trimStartSec > 0 && (
                    <div
                      className="alignment-waveform-section trimmed-start"
                      style={{
                        position: 'absolute',
                        left: 0,
                        width: `${pct(trim.trimStartSec, virtualDuration)}%`,
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        opacity: 0.35,
                      }}
                    >
                      {startPeaks.map((peak, index) => (
                        <i key={`start-${index}`} style={{ height: `${Math.max(5, peak * 100)}%` }} />
                      ))}
                    </div>
                  )}

                  {/* Intro block */}
                  {introActive && (
                    <div
                      className="alignment-intro-block-audio"
                      style={{
                        position: 'absolute',
                        left: `${pct(trim.trimStartSec, virtualDuration)}%`,
                        width: `${pct(introDuration, virtualDuration)}%`,
                        height: '100%',
                        background: 'rgba(147, 51, 234, 0.12)',
                        borderLeft: '1px dashed rgba(147, 51, 234, 0.4)',
                        borderRight: '1px dashed rgba(147, 51, 234, 0.4)',
                        boxSizing: 'border-box',
                        pointerEvents: 'none',
                        zIndex: 2,
                      }}
                    />
                  )}

                  {/* Active video peaks */}
                  <div
                    className="alignment-waveform-section active"
                    style={{
                      position: 'absolute',
                      left: `${pct(trim.trimStartSec + introDuration, virtualDuration)}%`,
                      width: `${pct(activeVideoDuration, virtualDuration)}%`,
                      height: '100%',
                      display: 'flex',
                      alignItems: 'center',
                    }}
                  >
                    <div
                      className="alignment-waveform-fill"
                      style={{
                        width: `${Math.min(100, pct(Math.max(0, currentSec - (trim.trimStartSec + introDuration)), activeVideoDuration))}%`
                      }}
                    />
                    {activePeaks.map((peak, index) => (
                      <i key={`active-${index}`} style={{ height: `${Math.max(5, peak * 100)}%` }} />
                    ))}

                    {razorStart !== null && (
                      <div className="alignment-razor-mark" style={{ left: `${pct(razorStart - trim.trimStartSec, activeVideoDuration)}%` }} />
                    )}
                    {cuts.map((cut, i) => {
                      if (cut.endSec <= trim.trimStartSec || cut.startSec >= clipDurationSec - trim.trimEndSec) return null;
                      const visibleStart = Math.max(trim.trimStartSec, cut.startSec);
                      const visibleEnd = Math.min(clipDurationSec - trim.trimEndSec, cut.endSec);
                      return (
                        <div
                          key={`ac${i}`}
                          className="alignment-cut-region"
                          style={{
                            left: `${pct(visibleStart - trim.trimStartSec, activeVideoDuration)}%`,
                            width: `${pct(visibleEnd - visibleStart, activeVideoDuration)}%`
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            pushUndo();
                            setCuts((prev) => {
                              const next = removeCut(prev, i);
                              cutsRef.current = next;
                              return next;
                            });
                          }}
                        />
                      );
                    })}
                  </div>

                  {/* Outro block */}
                  {outroActive && (
                    <div
                      className="alignment-outro-block-audio"
                      style={{
                        position: 'absolute',
                        left: `${pct(clipDurationSec - trim.trimEndSec + introDuration, virtualDuration)}%`,
                        width: `${pct(outroDuration, virtualDuration)}%`,
                        height: '100%',
                        background: 'rgba(147, 51, 234, 0.12)',
                        borderLeft: '1px dashed rgba(147, 51, 234, 0.4)',
                        borderRight: '1px dashed rgba(147, 51, 234, 0.4)',
                        boxSizing: 'border-box',
                        pointerEvents: 'none',
                        zIndex: 2,
                      }}
                    />
                  )}

                  {/* Trimmed end peaks */}
                  {trim.trimEndSec > 0 && (
                    <div
                      className="alignment-waveform-section trimmed-end"
                      style={{
                        position: 'absolute',
                        left: `${pct(virtualDuration - trim.trimEndSec, virtualDuration)}%`,
                        width: `${pct(trim.trimEndSec, virtualDuration)}%`,
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        opacity: 0.35,
                      }}
                    >
                      {endPeaks.map((peak, index) => (
                        <i key={`end-${index}`} style={{ height: `${Math.max(5, peak * 100)}%` }} />
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <em style={{ position: 'absolute', width: '100%', textAlign: 'center', left: 0 }}>
                  {waveformError || 'Loading waveform...'}
                </em>
              )}
              <b className="alignment-track-playhead" style={{ left: `${pct(currentSec, virtualDuration)}%`, zIndex: 10 }} />
            </div>
          </div>

          {audioTracks.map((track, trackIndex) => (
          <div className="alignment-track-row alignment-track-extra-audio" key={track.id}>
            <span className="alignment-track-label">Audio {trackIndex + 1}</span>
            <div className="alignment-track-content" style={{ width: `${timelineZoom * 100}%` }}>
              {/* Shaded boundaries for Intro/Outro */}
              {trim.trimStartSec > 0 && (
                <div
                  className="alignment-trim-region trim-start"
                  style={{
                    position: 'absolute',
                    left: 0,
                    width: `${pct(trim.trimStartSec, virtualDuration)}%`,
                    height: '100%',
                    top: 0,
                    zIndex: 2,
                  }}
                />
              )}
              {introActive && (
                <div
                  className="alignment-intro-block-audio"
                  style={{
                    position: 'absolute',
                    left: `${pct(trim.trimStartSec, virtualDuration)}%`,
                    width: `${pct(introDuration, virtualDuration)}%`,
                    height: '100%',
                    top: 0,
                    background: 'rgba(147, 51, 234, 0.08)',
                    borderLeft: '1px dashed rgba(147, 51, 234, 0.4)',
                    borderRight: '1px dashed rgba(147, 51, 234, 0.4)',
                    pointerEvents: 'none',
                    zIndex: 2,
                  }}
                />
              )}
              {outroActive && (
                <div
                  className="alignment-outro-block-audio"
                  style={{
                    position: 'absolute',
                    left: `${pct(clipDurationSec - trim.trimEndSec + introDuration, virtualDuration)}%`,
                    width: `${pct(outroDuration, virtualDuration)}%`,
                    height: '100%',
                    top: 0,
                    background: 'rgba(147, 51, 234, 0.08)',
                    borderLeft: '1px dashed rgba(147, 51, 234, 0.4)',
                    borderRight: '1px dashed rgba(147, 51, 234, 0.4)',
                    pointerEvents: 'none',
                    zIndex: 2,
                  }}
                />
              )}
              {trim.trimEndSec > 0 && (
                <div
                  className="alignment-trim-region trim-end"
                  style={{
                    position: 'absolute',
                    left: `${pct(virtualDuration - trim.trimEndSec, virtualDuration)}%`,
                    width: `${pct(trim.trimEndSec, virtualDuration)}%`,
                    height: '100%',
                    top: 0,
                    zIndex: 2,
                  }}
                />
              )}

              <div
                className={`alignment-overlay-block ${track.muted ? 'muted' : ''}`}
                style={{
                  left: `${pct(track.startSec + introDuration, virtualDuration)}%`,
                  width: `${Math.max(1, pct(Math.max(1, clipDurationSec - track.startSec - track.trimEndSec), virtualDuration))}%`,
                  '--fade-in-pct': `${Math.min(100, pct(track.fadeInSec, Math.max(0.05, extraAudioEnd(track) - track.startSec)))}%`,
                  '--fade-out-pct': `${Math.min(100, pct(track.fadeOutSec, Math.max(0.05, extraAudioEnd(track) - track.startSec)))}%`,
                  zIndex: 3,
                } as React.CSSProperties}
                onPointerDown={(event) => startAudioTrackDrag(event, track, 'move')}
                onDoubleClick={() => seek(mapPhysicalToVirtual(track.startSec, trim))}
              >
                <span className="alignment-resize left" onPointerDown={(event) => startAudioTrackDrag(event, track, 'start')} />
                <span className="alignment-audio-fade in" />
                {track.name}
                <span className="alignment-audio-fade out" />
                <button
                  type="button"
                  className="alignment-overlay-delete"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => setAudioTracks((prev) => prev.filter((candidate) => candidate.id !== track.id))}
                  title="Delete audio track"
                >
                  ×
                </button>
                <span className="alignment-resize right" onPointerDown={(event) => startAudioTrackDrag(event, track, 'end')} />
              </div>
              <b className="alignment-track-playhead" style={{ left: `${pct(currentSec, virtualDuration)}%`, zIndex: 10 }} />
            </div>
          </div>
          ))}

          {/* Subtitle blocks track */}
          <div className="alignment-track-row alignment-track-subtitles">
            <span className="alignment-track-label">Subs</span>
            <div
              className="alignment-track-content alignment-timeline-track"
              ref={timelineRef}
              style={{ width: `${timelineZoom * 100}%` }}
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) {
                  const rect = event.currentTarget.getBoundingClientRect();
                  if (!rect || rect.width <= 0) return;
                  const virtualSec = ((event.clientX - rect.left) / rect.width) * virtualDuration;
                  seek(virtualSec);
                }
              }}
            >
              {/* Shaded boundaries for Intro/Outro */}
              {trim.trimStartSec > 0 && (
                <div
                  className="alignment-trim-region trim-start"
                  style={{
                    position: 'absolute',
                    left: 0,
                    width: `${pct(trim.trimStartSec, virtualDuration)}%`,
                    height: '100%',
                    top: 0,
                    zIndex: 2,
                  }}
                />
              )}
              {introActive && (
                <div
                  className="alignment-intro-block-audio"
                  style={{
                    position: 'absolute',
                    left: `${pct(trim.trimStartSec, virtualDuration)}%`,
                    width: `${pct(introDuration, virtualDuration)}%`,
                    height: '100%',
                    top: 0,
                    background: 'rgba(147, 51, 234, 0.08)',
                    borderLeft: '1px dashed rgba(147, 51, 234, 0.4)',
                    borderRight: '1px dashed rgba(147, 51, 234, 0.4)',
                    pointerEvents: 'none',
                    zIndex: 2,
                  }}
                />
              )}
              {outroActive && (
                <div
                  className="alignment-outro-block-audio"
                  style={{
                    position: 'absolute',
                    left: `${pct(clipDurationSec - trim.trimEndSec + introDuration, virtualDuration)}%`,
                    width: `${pct(outroDuration, virtualDuration)}%`,
                    height: '100%',
                    top: 0,
                    background: 'rgba(147, 51, 234, 0.08)',
                    borderLeft: '1px dashed rgba(147, 51, 234, 0.4)',
                    borderRight: '1px dashed rgba(147, 51, 234, 0.4)',
                    pointerEvents: 'none',
                    zIndex: 2,
                  }}
                />
              )}
              {trim.trimEndSec > 0 && (
                <div
                  className="alignment-trim-region trim-end"
                  style={{
                    position: 'absolute',
                    left: `${pct(virtualDuration - trim.trimEndSec, virtualDuration)}%`,
                    width: `${pct(trim.trimEndSec, virtualDuration)}%`,
                    height: '100%',
                    top: 0,
                    zIndex: 2,
                  }}
                />
              )}

              {/* Shifting media container */}
              <div
                className="alignment-media-container"
                style={{
                  position: 'absolute',
                  left: `${pct(trim.trimStartSec + introDuration, virtualDuration)}%`,
                  width: `${pct(activeVideoDuration, virtualDuration)}%`,
                  height: '100%',
                  top: 0,
                }}
              >
                {segments.map((segment) => {
                  if (segment.end <= trim.trimStartSec || segment.start >= clipDurationSec - trim.trimEndSec) return null;
                  const left = pct(segment.start - trim.trimStartSec, activeVideoDuration);
                  const width = Math.max(0.6, pct(segment.end - segment.start, activeVideoDuration));
                  const activeClass = active?.id === segment.id ? 'active' : selected?.id === segment.id ? 'selected' : '';
                  return (
                    <div
                      key={segment.id}
                      className={`alignment-block ${activeClass}`}
                      style={{ left: `${left}%`, width: `${width}%` }}
                      onPointerDown={(event) => startDrag(event, segment, 'move')}
                      onDoubleClick={() => seek(mapPhysicalToVirtual(segment.start, trim))}
                    >
                      <span className="alignment-resize left" onPointerDown={(event) => startDrag(event, segment, 'start')} />
                      <strong>{segment.text}</strong>
                      <span className="alignment-resize right" onPointerDown={(event) => startDrag(event, segment, 'end')} />
                    </div>
                  );
                })}
                {cuts.map((cut, i) => {
                  if (cut.endSec <= trim.trimStartSec || cut.startSec >= clipDurationSec - trim.trimEndSec) return null;
                  const visibleStart = Math.max(trim.trimStartSec, cut.startSec);
                  const visibleEnd = Math.min(clipDurationSec - trim.trimEndSec, cut.endSec);
                  return (
                    <div
                      key={`sc${i}`}
                      className="alignment-cut-region"
                      style={{
                        left: `${pct(visibleStart - trim.trimStartSec, activeVideoDuration)}%`,
                        width: `${pct(visibleEnd - visibleStart, activeVideoDuration)}%`
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        pushUndo();
                        setCuts((prev) => {
                          const next = removeCut(prev, i);
                          cutsRef.current = next;
                          return next;
                        });
                      }}
                    />
                  );
                })}
              </div>
              <b className="alignment-track-playhead" style={{ left: `${pct(currentSec, virtualDuration)}%`, zIndex: 10 }} />
            </div>
          </div>

          {textTracks.map((track, trackIndex) => (
          <div className="alignment-track-row alignment-track-text-overlay" key={track.id}>
            <span className="alignment-track-label">Text {trackIndex + 1}</span>
            <div className="alignment-track-content alignment-timeline-track" style={{ width: `${timelineZoom * 100}%` }}>
              {/* Shaded boundaries for Intro/Outro */}
              {trim.trimStartSec > 0 && (
                <div
                  className="alignment-trim-region trim-start"
                  style={{
                    position: 'absolute',
                    left: 0,
                    width: `${pct(trim.trimStartSec, virtualDuration)}%`,
                    height: '100%',
                    top: 0,
                    zIndex: 2,
                  }}
                />
              )}
              {introActive && (
                <div
                  className="alignment-intro-block-audio"
                  style={{
                    position: 'absolute',
                    left: `${pct(trim.trimStartSec, virtualDuration)}%`,
                    width: `${pct(introDuration, virtualDuration)}%`,
                    height: '100%',
                    top: 0,
                    background: 'rgba(147, 51, 234, 0.08)',
                    borderLeft: '1px dashed rgba(147, 51, 234, 0.4)',
                    borderRight: '1px dashed rgba(147, 51, 234, 0.4)',
                    pointerEvents: 'none',
                    zIndex: 2,
                  }}
                />
              )}
              {outroActive && (
                <div
                  className="alignment-outro-block-audio"
                  style={{
                    position: 'absolute',
                    left: `${pct(clipDurationSec - trim.trimEndSec + introDuration, virtualDuration)}%`,
                    width: `${pct(outroDuration, virtualDuration)}%`,
                    height: '100%',
                    top: 0,
                    background: 'rgba(147, 51, 234, 0.08)',
                    borderLeft: '1px dashed rgba(147, 51, 234, 0.4)',
                    borderRight: '1px dashed rgba(147, 51, 234, 0.4)',
                    pointerEvents: 'none',
                    zIndex: 2,
                  }}
                />
              )}
              {trim.trimEndSec > 0 && (
                <div
                  className="alignment-trim-region trim-end"
                  style={{
                    position: 'absolute',
                    left: `${pct(virtualDuration - trim.trimEndSec, virtualDuration)}%`,
                    width: `${pct(trim.trimEndSec, virtualDuration)}%`,
                    height: '100%',
                    top: 0,
                    zIndex: 2,
                  }}
                />
              )}

              {track.blocks.map((block) => (
                <div
                  key={block.id}
                  className={`alignment-overlay-block ${track.hidden || block.hidden ? 'muted' : ''} ${selectedTextBlock?.blockId === block.id ? 'selected' : ''}`}
                  style={{
                    left: `${pct(block.startSec + introDuration, virtualDuration)}%`,
                    width: `${Math.max(0.8, pct(block.endSec - block.startSec, virtualDuration))}%`,
                    zIndex: 3,
                  }}
                  onPointerDown={(event) => startTextBlockDrag(event, track.id, block, 'move')}
                  onDoubleClick={() => seek(mapPhysicalToVirtual(block.startSec, trim))}
                >
                  <span className="alignment-resize left" onPointerDown={(event) => startTextBlockDrag(event, track.id, block, 'start')} />
                  {block.text || '[ Empty Text Block ]'}
                  <span className="alignment-resize right" onPointerDown={(event) => startTextBlockDrag(event, track.id, block, 'end')} />
                </div>
              ))}
              <b className="alignment-track-playhead" style={{ left: `${pct(currentSec, virtualDuration)}%`, zIndex: 10 }} />
            </div>
          </div>
          ))}
        </div>

        <audio ref={audioRef} src={audioSrc} className="review-audio-player-hidden" />
        {audioTracks.map((track) => (
          <audio
            key={track.id}
            ref={(node) => {
              if (node) extraAudioRefs.current.set(track.id, node);
              else extraAudioRefs.current.delete(track.id);
            }}
            src={track.previewSrc || track.src}
            preload="auto"
            className="review-audio-player-hidden"
          />
        ))}

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
                onClick={() => { setSelectedId(segment.id); setSelectedTextBlock(null); seek(segment.start); }}
              >
                <span>{formatPlaybackClock(segment.start)} → {formatPlaybackClock(segment.end)}</span>
                {segment.text}
              </button>
            ))}
            {textTracks.length > 0 && (
              <div className="alignment-text-track-list">
                <strong>Text overlays</strong>
                {textTracks.flatMap((track) => track.blocks.map((block) => (
                  <button
                    type="button"
                    key={`${track.id}-${block.id}`}
                    className={selectedTextBlock?.blockId === block.id ? 'active' : ''}
                    onClick={() => {
                      setSelectedTextBlock({ trackId: track.id, blockId: block.id });
                      setSelectedId('');
                      setStyleTarget(track.id);
                      seek(block.startSec);
                    }}
                  >
                    <span>{track.name}: {formatPlaybackClock(block.startSec)} → {formatPlaybackClock(block.endSec)}</span>
                    {block.text || '[ Empty Text Block ]'}
                  </button>
                )))}
              </div>
            )}
          </div>
          <div className="alignment-text-editor">
            {selectedTextOverlay ? (
              <>
                <div className="alignment-editor-toolbar">
                  <button type="button" onClick={addTextOverlayBlock}><SplitSquareHorizontal size={14} /> Add Text Block</button>
                  <button type="button" onClick={deleteSelectedTextBlock}><Trash2 size={14} /> Delete</button>
                </div>
                <textarea
                  placeholder="[ Empty Text Block ]"
                  value={selectedTextOverlay.text}
                  onChange={(event) => updateSelectedTextBlock({ text: event.currentTarget.value })}
                />
                <div className="alignment-layer-time-row">
                  <label>
                    <span>Start</span>
                    <input
                      type="number"
                      min={0}
                      max={clipDurationSec}
                      step={0.05}
                      value={selectedTextOverlay.startSec.toFixed(2)}
                      onChange={(event) => updateSelectedTextBlock({
                        startSec: Math.min(Math.max(0, Number(event.currentTarget.value)), Math.max(0, selectedTextOverlay.endSec - MIN_DURATION)),
                      })}
                    />
                  </label>
                  <label>
                    <span>End</span>
                    <input
                      type="number"
                      min={0}
                      max={clipDurationSec}
                      step={0.05}
                      value={selectedTextOverlay.endSec.toFixed(2)}
                      onChange={(event) => updateSelectedTextBlock({
                        endSec: Math.min(clipDurationSec, Math.max(selectedTextOverlay.startSec + MIN_DURATION, Number(event.currentTarget.value))),
                      })}
                    />
                  </label>
                  <span>{formatPlaybackClock(selectedTextOverlay.startSec)} → {formatPlaybackClock(selectedTextOverlay.endSec)}</span>
                </div>
              </>
            ) : selected ? (
              <>
                <div className="alignment-editor-toolbar">
                  <button type="button" onClick={() => {
                    pushUndo();
                    setSegments((prev) => {
                      const next = splitSegment(prev, selected.id, clipDurationSec);
                      segmentsRef.current = next;
                      return next;
                    });
                  }}><SplitSquareHorizontal size={14} /> Split</button>
                  <button type="button" onClick={addEmptySubtitleBlock}><SplitSquareHorizontal size={14} /> Add Subtitle Block</button>
                  <button type="button" onClick={addTextOverlayBlock}><SplitSquareHorizontal size={14} /> Add Text Block</button>
                  <button type="button" onClick={() => {
                    pushUndo();
                    setSegments((prev) => {
                      const next = mergeSegmentWithNext(prev, selected.id, clipDurationSec);
                      segmentsRef.current = next;
                      return next;
                    });
                  }}><Scissors size={14} /> Merge next</button>
                  <button
                    type="button"
                    onClick={() => {
                      pushUndo();
                      setSegments((prev) => {
                        const next = prev.filter((segment) => segment.id !== selected.id);
                        segmentsRef.current = next;
                        return next;
                      });
                      setSelectedId('');
                    }}
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                </div>
                <textarea
                  value={selected.text}
                  onFocus={() => pushUndo()}
                  onChange={(event) => {
                    const text = event.currentTarget.value;
                    setSegments((prev) => {
                      const next = updateSegmentText(prev, selected.id, text, clipDurationSec);
                      segmentsRef.current = next;
                      return next;
                    });
                  }}
                />
                <div className="alignment-word-row">
                  {selected.text.match(/\S+/g)?.map((word, index) => (
                    <span key={`${word}-${index}`}>
                      <button type="button" onClick={() => setSegments((prev) => {
                        const next = moveWordToAdjacentSegment(prev, selected.id, index, 'previous', clipDurationSec);
                        segmentsRef.current = next;
                        return next;
                      })}>←</button>
                      {word}
                      <button type="button" onClick={() => setSegments((prev) => {
                        const next = moveWordToAdjacentSegment(prev, selected.id, index, 'next', clipDurationSec);
                        segmentsRef.current = next;
                        return next;
                      })}>→</button>
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <div className="alignment-empty-editor">
                Select a subtitle or text block to edit.
                <button type="button" onClick={addTextOverlayBlock}><SplitSquareHorizontal size={14} /> Add Text Block</button>
              </div>
            )}
          </div>
        </div>
          </div>

          {inspectorOpen && (
          <div className="alignment-side">
            {/* Tab bar */}
            <div className="alignment-inspector-tabs">
              <button type="button" className={inspectorTab === 'style' ? 'active' : ''} onClick={() => setInspectorTab('style')}>Style</button>
              <button type="button" className={inspectorTab === 'frame' ? 'active' : ''} onClick={() => setInspectorTab('frame')}>Frame</button>
              <button type="button" className={inspectorTab === 'background' ? 'active' : ''} onClick={() => setInspectorTab('background')}>Background</button>
              <button type="button" className={inspectorTab === 'layers' ? 'active' : ''} onClick={() => setInspectorTab('layers')}>Layers</button>
            </div>

            {inspectorTab === 'style' && (
            <div className="alignment-frame-panel alignment-style-panel">
              <h4>Style</h4>
              <p>Subtitles and each text overlay track can have its own style.</p>
              <div className="alignment-style-target-tabs">
                <button type="button" className={styleTarget === 'subtitles' ? 'active' : ''} onClick={() => setStyleTarget('subtitles')}>Subtitles</button>
                {textTracks.map((track) => (
                  <button type="button" key={track.id} className={styleTarget === track.id ? 'active' : ''} onClick={() => setStyleTarget(track.id)}>
                    {track.name || 'Text Track'}
                  </button>
                ))}
              </div>
              <label>
                <span>Font</span>
                <select value={activeStyle.fontFamily} onChange={(event) => patchActiveStyle({ fontFamily: event.currentTarget.value })}>
                  <option value="Cuprum">Cuprum</option>
                  <option value="Oswald">Oswald</option>
                  <option value="Unbounded">Unbounded</option>
                  <option value="Montserrat">Montserrat</option>
                  <option value="Inter">Inter</option>
                  <option value="Arial">Arial</option>
                </select>
              </label>
              <div className="alignment-font-options-row">
                <label className="alignment-checkbox-label">
                  <input type="checkbox" checked={activeStyle.bold} onChange={(event) => patchActiveStyle({ bold: event.currentTarget.checked })} />
                  <span>Bold</span>
                </label>
                <select value={activeStyle.textTransform} onChange={(event) => patchActiveStyle({ textTransform: event.currentTarget.value as ShortsSettings['subtitleTextTransform'] })}>
                  <option value="uppercase">Uppercase</option>
                  <option value="title">Title Case</option>
                  <option value="none">Original Case</option>
                </select>
              </div>
              <label>
                <span>Size</span>
                <input type="range" min={30} max={200} step={1} value={activeStyle.fontSize} onChange={(event) => patchActiveStyle({ fontSize: Number(event.currentTarget.value) })} />
                <b>{activeStyle.fontSize}</b>
              </label>
              <label>
                <span>Text color</span>
                <input type="color" value={activeStyle.textColor} onChange={(event) => patchActiveStyle({ textColor: event.currentTarget.value })} />
                <b>{activeStyle.textColor}</b>
              </label>
              <label>
                <span>Letter spacing</span>
                <input type="range" min={-2} max={8} step={0.25} value={activeStyle.letterSpacing} onChange={(event) => patchActiveStyle({ letterSpacing: Number(event.currentTarget.value) })} />
                <b>{activeStyle.letterSpacing.toFixed(1)}</b>
              </label>
              <label>
                <span>Line spacing</span>
                <input type="range" min={0.8} max={1.6} step={0.05} value={activeStyle.lineSpacing} onChange={(event) => patchActiveStyle({ lineSpacing: Number(event.currentTarget.value) })} />
                <b>{activeStyle.lineSpacing.toFixed(2)}x</b>
              </label>
              <label>
                <span>Outline</span>
                <input type="range" min={0} max={10} step={0.5} value={activeStyle.outline ?? 2} onChange={(event) => patchActiveStyle({ outline: Number(event.currentTarget.value) })} />
                <b>{activeStyle.outline ?? 2}px</b>
              </label>
              <label>
                <span>Outline opacity</span>
                <input type="range" min={0} max={1} step={0.05} value={activeStyle.outlineOpacity ?? 0.58} onChange={(event) => patchActiveStyle({ outlineOpacity: Number(event.currentTarget.value) })} />
                <b>{Math.round((activeStyle.outlineOpacity ?? 0.58) * 100)}%</b>
              </label>
              <label>
                <span>Outline color</span>
                <input type="color" value={activeStyle.outlineColor ?? '#000000'} onChange={(event) => patchActiveStyle({ outlineColor: event.currentTarget.value })} />
                <b>{activeStyle.outlineColor ?? '#000000'}</b>
              </label>
              <label>
                <span>Shadow size</span>
                <input type="range" min={0} max={20} step={1} value={activeStyle.shadowDistance ?? 6} onChange={(event) => patchActiveStyle({ shadowDistance: Number(event.currentTarget.value) })} />
                <b>{activeStyle.shadowDistance ?? 6}px</b>
              </label>
              <label>
                <span>Shadow blur</span>
                <input type="range" min={0} max={20} step={1} value={activeStyle.shadowBlur ?? 3} onChange={(event) => patchActiveStyle({ shadowBlur: Number(event.currentTarget.value) })} />
                <b>{activeStyle.shadowBlur ?? 3}px</b>
              </label>
              <label>
                <span>Shadow angle</span>
                <input type="range" min={0} max={360} step={5} value={activeStyle.shadowAngle ?? 90} onChange={(event) => patchActiveStyle({ shadowAngle: Number(event.currentTarget.value) })} />
                <b>{activeStyle.shadowAngle ?? 90}°</b>
              </label>
              <label>
                <span>Shadow opacity</span>
                <input type="range" min={0} max={1} step={0.05} value={activeStyle.shadowOpacity ?? 0.72} onChange={(event) => patchActiveStyle({ shadowOpacity: Number(event.currentTarget.value) })} />
                <b>{Math.round((activeStyle.shadowOpacity ?? 0.72) * 100)}%</b>
              </label>
              <label>
                <span>Shadow color</span>
                <input type="color" value={activeStyle.shadowColor ?? '#000000'} onChange={(event) => patchActiveStyle({ shadowColor: event.currentTarget.value })} />
                <b>{activeStyle.shadowColor ?? '#000000'}</b>
              </label>
              <label>
                <span>Box color</span>
                <input type="color" value={activeStyle.boxColor} onChange={(event) => patchActiveStyle({ boxColor: event.currentTarget.value })} />
                <b>{activeStyle.boxColor}</b>
              </label>
              <label>
                <span>Box opacity</span>
                <input type="range" min={0} max={1} step={0.02} value={activeStyle.boxOpacity} onChange={(event) => patchActiveStyle({ boxOpacity: Number(event.currentTarget.value) })} />
                <b>{Math.round(activeStyle.boxOpacity * 100)}%</b>
              </label>
              <label>
                <span>Box width</span>
                <input type="range" min={48} max={96} step={1} value={activeStyle.boxWidth} onChange={(event) => patchActiveStyle({ boxWidth: Number(event.currentTarget.value) })} />
                <b>{activeStyle.boxWidth}%</b>
              </label>
              <label>
                <span>Box height</span>
                <input type="range" min={0.5} max={5.0} step={0.05} value={activeStyle.boxHeight} onChange={(event) => patchActiveStyle({ boxHeight: Number(event.currentTarget.value) })} />
                <b>{activeStyle.boxHeight.toFixed(2)}x</b>
              </label>
              <label>
                <span>Edge softness</span>
                <input type="range" min={0} max={1} step={0.05} value={activeStyle.edgeSoftness} onChange={(event) => patchActiveStyle({ edgeSoftness: Number(event.currentTarget.value) })} />
                <b>{Math.round(activeStyle.edgeSoftness * 100)}%</b>
              </label>
              <label>
                <span>Edge blur</span>
                <input type="range" min={0} max={80} step={1} value={activeStyle.edgeBlur} onChange={(event) => patchActiveStyle({ edgeBlur: Number(event.currentTarget.value) })} />
                <b>{activeStyle.edgeBlur}px</b>
              </label>
              {styleTarget === 'subtitles' && (
                <label>
                  <span>Caption position</span>
                  <input type="range" min={0} max={1800} step={10} value={settings.subtitleBottomMargin} onChange={(event) => patchCaptionSettings({ subtitleBottomMargin: Number(event.currentTarget.value) })} />
                  <b>{settings.subtitleBottomMargin}</b>
                </label>
              )}
            </div>
            )}

            {inspectorTab === 'frame' && (
            <div className="alignment-frame-panel">
              <h4>Frame animation</h4>
              <p>Adjust the frame, then press Add point. Transitions between points are smooth.</p>
              <label>
                <span>Border color</span>
                <input type="color"
                  value={bgSettings.frameGuideColor ?? '#ffaa19'}
                  onChange={(e) => {
                    const frameGuideColor = e.currentTarget.value;
                    updateBackgroundSettings((prev) => ({ ...prev, frameGuideColor }));
                  }} />
                <b>{bgSettings.frameGuideColor ?? '#ffaa19'}</b>
              </label>
              <label>
                <span>Dim</span>
                <input type="range" min={0} max={1} step={0.05}
                  value={bgSettings.frameGuideOpacity ?? 0.5}
                  onChange={(e) => updateBackgroundSettings((prev) => ({ ...prev, frameGuideOpacity: Number(e.currentTarget.value) }))} />
                <b>{Math.round((bgSettings.frameGuideOpacity ?? 0.5) * 100)}%</b>
              </label>
              <label>
                <span>Border</span>
                <input type="range" min={0} max={12} step={0.5}
                  value={bgSettings.frameGuideBorderWidth ?? 2}
                  onChange={(e) => updateBackgroundSettings((prev) => ({ ...prev, frameGuideBorderWidth: Number(e.currentTarget.value) }))} />
                <b>{bgSettings.frameGuideBorderWidth ?? 2}px</b>
              </label>
              <label>
                <span>Opacity</span>
                <input type="range" min={0} max={1} step={0.05}
                  value={bgSettings.frameGuideBorderOpacity ?? 1}
                  onChange={(e) => updateBackgroundSettings((prev) => ({ ...prev, frameGuideBorderOpacity: Number(e.currentTarget.value) }))} />
                <b>{Math.round((bgSettings.frameGuideBorderOpacity ?? 1) * 100)}%</b>
              </label>
              <label>
                <span>Glow</span>
                <input type="range" min={0} max={30} step={1}
                  value={bgSettings.frameGuideBlur ?? 0}
                  onChange={(e) => updateBackgroundSettings((prev) => ({ ...prev, frameGuideBlur: Number(e.currentTarget.value) }))} />
                <b>{bgSettings.frameGuideBlur ?? 0}px</b>
              </label>
              <label>
                <span>Zoom</span>
                <input type="range" min={0.5} max={2} step={0.01} value={frameZoom} onChange={(event) => {
                  const zoom = Number(event.currentTarget.value);
                  setFrameZoom(zoom);
                  persistFrameControls({ zoom });
                }} />
                <b>{frameZoom.toFixed(2)}x</b>
              </label>
              <label>
                <span>Pan X</span>
                <input type="range" min={-50} max={50} step={1} value={framePanX} onChange={(event) => {
                  const x = Number(event.currentTarget.value);
                  setFramePanX(x);
                  persistFrameControls({ x });
                }} />
                <b>{framePanX}</b>
              </label>
              <label>
                <span>Pan Y</span>
                <input type="range" min={-30} max={30} step={1} value={framePanY} onChange={(event) => {
                  const y = Number(event.currentTarget.value);
                  setFramePanY(y);
                  persistFrameControls({ y });
                }} />
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
                      backgroundColor: bgSettings.frameGuideColor ?? '#ffaa19',
                    };
                    setFrameKeyframes((prev) => {
                      const next = [
                        ...prev.filter((point) => Math.abs(point.time - currentSec) > 0.15),
                        nextPoint,
                      ].sort((a, b) => a.time - b.time);
                      frameKeyframesRef.current = next;
                      onDraftFrameKeyframes?.(next);
                      return next;
                    });
                  }}
                >
                  Add point
                </button>
                <button
                  type="button"
                  onClick={() => {
                    pushUndo();
                    frameKeyframesRef.current = [];
                    setFrameKeyframes([]);
                    onDraftFrameKeyframes?.([]);
                  }}
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
                        frameZoomRef.current = point.zoom;
                        framePanXRef.current = point.x;
                        framePanYRef.current = point.y;
                        updateBackgroundSettings((prev) => ({ ...prev, frameGuideColor: point.backgroundColor || prev.frameGuideColor || '#ffaa19' }));
                      }}
                    >
                      {index + 1}. {formatPlaybackClock(point.time)}
                    </button>
                    <span>{point.zoom.toFixed(2)}x · X {point.x} · Y {point.y}</span>
                    <button type="button" onClick={() => {
                      pushUndo();
                      setFrameKeyframes((prev) => {
                        const next = prev.filter((item) => item.id !== point.id);
                        frameKeyframesRef.current = next;
                        onDraftFrameKeyframes?.(next);
                        return next;
                      });
                    }}>×</button>
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
                  <input type="checkbox" checked={bgSettings.solidEnabled} onChange={(e) => updateBackgroundSettings(prev => ({ ...prev, solidEnabled: e.target.checked }))} />
                  <span className="bg-toggle-label">Solid color</span>
                </label>
                {bgSettings.solidEnabled && (
                  <label>
                    <span>Color</span>
                    <input type="color" value={bgSettings.solidColor} onChange={(e) => updateBackgroundSettings(prev => ({ ...prev, solidColor: e.target.value }))} />
                    <b>{bgSettings.solidColor}</b>
                  </label>
                )}
              </div>

              {/* ── Blur Background ── */}
              <div className="bg-section">
                <label className="bg-toggle">
                  <input type="checkbox" checked={bgSettings.blurEnabled} onChange={(e) => updateBackgroundSettings(prev => ({ ...prev, blurEnabled: e.target.checked }))} />
                  <span className="bg-toggle-label">Blur background</span>
                </label>
                {bgSettings.blurEnabled && (
                  <>
                    <label>
                      <span>Blur</span>
                      <input type="range" min={1} max={80} step={1} value={bgSettings.blurStrength} onChange={(e) => updateBackgroundSettings(prev => ({ ...prev, blurStrength: Number(e.target.value) }))} />
                      <b>{bgSettings.blurStrength}px</b>
                    </label>
                    <label>
                      <span>Scale</span>
                      <input type="range" min={1} max={2} step={0.05} value={bgSettings.blurScale} onChange={(e) => updateBackgroundSettings(prev => ({ ...prev, blurScale: Number(e.target.value) }))} />
                      <b>{bgSettings.blurScale.toFixed(2)}x</b>
                    </label>
                  </>
                )}
              </div>

              {/* ── Gradient ── */}
              <div className="bg-section">
                <label className="bg-toggle">
                  <input type="checkbox" checked={bgSettings.gradientEnabled} onChange={(e) => updateBackgroundSettings(prev => ({ ...prev, gradientEnabled: e.target.checked }))} />
                  <span className="bg-toggle-label">Gradient overlay</span>
                </label>
                {bgSettings.gradientEnabled && (
                  <>
                    <label className="bg-type-row">
                      <span>Type</span>
                      <select value={bgSettings.gradientType} onChange={(e) => updateBackgroundSettings(prev => ({ ...prev, gradientType: e.target.value as 'linear' | 'radial' }))}>
                        <option value="linear">Linear</option>
                        <option value="radial">Radial</option>
                      </select>
                    </label>
                    <label>
                      <span>Color A</span>
                      <input type="color" value={bgSettings.gradientColorA} onChange={(e) => updateBackgroundSettings(prev => ({ ...prev, gradientColorA: e.target.value }))} />
                      <b>{bgSettings.gradientColorA}</b>
                    </label>
                    <label>
                      <span>Color B</span>
                      <input type="color" value={bgSettings.gradientColorB} onChange={(e) => updateBackgroundSettings(prev => ({ ...prev, gradientColorB: e.target.value }))} />
                      <b>{bgSettings.gradientColorB}</b>
                    </label>
                    {bgSettings.gradientType === 'linear' && (
                      <label>
                        <span>Angle</span>
                        <input type="range" min={0} max={360} step={1} value={bgSettings.gradientAngle} onChange={(e) => updateBackgroundSettings(prev => ({ ...prev, gradientAngle: Number(e.target.value) }))} />
                        <b>{bgSettings.gradientAngle}°</b>
                      </label>
                    )}
                    <label>
                      <span>Opacity</span>
                      <input type="range" min={0} max={1} step={0.05} value={bgSettings.gradientOpacity} onChange={(e) => updateBackgroundSettings(prev => ({ ...prev, gradientOpacity: Number(e.target.value) }))} />
                      <b>{(bgSettings.gradientOpacity * 100).toFixed(0)}%</b>
                    </label>
                  </>
                )}
              </div>

              {/* ── Edge Feather ── */}
              <div className="bg-section">
                <label className="bg-toggle">
                  <input type="checkbox" checked={bgSettings.featherEnabled} onChange={(e) => updateBackgroundSettings(prev => ({ ...prev, featherEnabled: e.target.checked }))} />
                  <span className="bg-toggle-label">Edge feather</span>
                </label>
                {bgSettings.featherEnabled && (
                  <>
                    <label>
                      <span>Top</span>
                      <input type="range" min={0} max={100} step={1} value={bgSettings.featherTop ?? 0} onChange={(e) => updateBackgroundSettings(prev => ({ ...prev, featherTop: Number(e.target.value) }))} />
                      <b>{bgSettings.featherTop ?? 0}px</b>
                    </label>
                    <label>
                      <span>Bottom</span>
                      <input type="range" min={0} max={100} step={1} value={bgSettings.featherBottom ?? 0} onChange={(e) => updateBackgroundSettings(prev => ({ ...prev, featherBottom: Number(e.target.value) }))} />
                      <b>{bgSettings.featherBottom ?? 0}px</b>
                    </label>
                  </>
                )}
              </div>
            </div>
            )}

            {inspectorTab === 'layers' && (
            <div className="alignment-frame-panel alignment-layers-panel">
              <LogoManager logo={logo} onChange={setLogo} />
              <IntroOutroManager
                type="intro"
                title="Intro Graphic"
                description="Custom overlay displayed at the start of the video clip."
                data={intro}
                onChange={setIntro}
              />
              <IntroOutroManager
                type="outro"
                title="Outro Graphic"
                description="Custom overlay displayed at the end of the video clip."
                data={outro}
                onChange={setOutro}
              />
              <TextTrackManager
                tracks={textTracks}
                onChange={setTextTracks}
              />
              <AudioTrackManager
                tracks={audioTracks}
                durationSec={clipDurationSec}
                onChange={setAudioTracks}
              />
            </div>
            )}
          </div>
          )}
        {annotationMode && (
          <OnboardingTour
            activeScreen="alignment-editor"
            settings={{ ...loadSettings(), annotationMode, helpLocale }}
            onToggleAnnotationMode={(enabled) => {
              setAnnotationMode(enabled);
              try {
                const s = loadSettings();
                saveSettings(enabled ? { ...s, annotationMode: true } : markOnboardingCompletedForBuild(s, onboardingBuildId));
              } catch (e) {
                console.error(e);
              }
            }}
            onHelpLocaleChange={handleHelpLocaleChange}
          />
        )}
        </div>
      </div>
    </div>
  );
}
