import type { FrameKeyframe } from '../lib/subtitle-alignment';
import type { RenderSubtitleCue, ShortsRenderProject, ShortsRenderProjectInput } from './types';

const DEFAULT_FRAME: FrameKeyframe = {
  id: 'frame_default',
  time: 0,
  x: 0,
  y: 0,
  zoom: 1,
  backgroundColor: '#000000',
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function smoothstep(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * (3 - (2 * t));
}

export function interpolateFrameState(keyframes: FrameKeyframe[] | undefined, timeSec: number): FrameKeyframe {
  const sorted = (keyframes || [])
    .filter((point) => Number.isFinite(point.time))
    .map((point) => ({
      ...point,
      time: Math.max(0, point.time),
      zoom: clamp(point.zoom || 1, 0.5, 3),
      x: clamp(point.x || 0, -100, 100),
      y: clamp(point.y || 0, -100, 100),
      backgroundColor: point.backgroundColor || '#000000',
    }))
    .sort((a, b) => a.time - b.time);

  if (sorted.length === 0) return DEFAULT_FRAME;
  if (sorted.length === 1 || timeSec <= sorted[0].time) return sorted[0];
  const last = sorted[sorted.length - 1];
  if (timeSec >= last.time) return last;

  const nextIndex = sorted.findIndex((point) => point.time >= timeSec);
  const from = sorted[Math.max(0, nextIndex - 1)];
  const to = sorted[nextIndex];
  const progress = smoothstep((timeSec - from.time) / Math.max(0.001, to.time - from.time));

  return {
    id: 'frame_interpolated',
    time: timeSec,
    x: from.x + ((to.x - from.x) * progress),
    y: from.y + ((to.y - from.y) * progress),
    zoom: from.zoom + ((to.zoom - from.zoom) * progress),
    backgroundColor: from.backgroundColor || to.backgroundColor || '#000000',
  };
}

export function normalizeRenderSubtitles(
  cues: Array<{ startSec: number; endSec: number; text: string }>,
  durationSec: number,
): RenderSubtitleCue[] {
  return cues
    .map((cue, index) => {
      const startSec = clamp(cue.startSec, 0, durationSec);
      const endSec = clamp(Math.max(startSec + 0.05, cue.endSec), 0, durationSec);
      return {
        id: `cue_${index}`,
        startSec,
        endSec,
        text: String(cue.text || '').replace(/\r\n/g, '\n').trim(),
      };
    })
    .filter((cue) => cue.text && cue.endSec > cue.startSec)
    .sort((a, b) => a.startSec - b.startSec);
}

export function buildShortsRenderProject(input: ShortsRenderProjectInput): ShortsRenderProject {
  const durationSec = Math.max(1, input.clipEndSec - input.clipStartSec);
  const fps = Math.max(1, Math.round(input.fps || 30));
  const keyframes = input.frameKeyframes?.length
    ? input.frameKeyframes
    : [{ ...DEFAULT_FRAME, backgroundColor: '#000000' }];

  return {
    id: input.id,
    title: input.title,
    inputVideoSrc: input.inputVideoSrc,
    sourceWidth: Math.max(1, Math.round(input.sourceWidth || 1920)),
    sourceHeight: Math.max(1, Math.round(input.sourceHeight || 1080)),
    width: input.outputWidth,
    height: input.outputHeight,
    fps,
    clipStartSec: input.clipStartSec,
    clipEndSec: input.clipEndSec,
    durationSec,
    durationInFrames: Math.max(1, Math.ceil(durationSec * fps)),
    subtitles: normalizeRenderSubtitles(input.cues, durationSec),
    captionStyle: input.style,
    subtitleBottomMargin: input.subtitleBottomMargin,
    frameKeyframes: keyframes,
  };
}
