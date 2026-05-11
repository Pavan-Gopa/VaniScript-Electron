import type { FrameKeyframe } from '../lib/subtitle-alignment';
import type { TimelineCut, TimelineTrim } from '../lib/shorts-reels';
import type { RenderMediaSegment, RenderSubtitleCue, ShortsRenderProject, ShortsRenderProjectInput } from './types';

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

function normalizeTrim(trim: TimelineTrim | undefined, clipDurationSec: number): TimelineTrim {
  const trimStartSec = clamp(Number(trim?.trimStartSec) || 0, 0, Math.max(0, clipDurationSec));
  const trimEndSec = clamp(Number(trim?.trimEndSec) || 0, 0, Math.max(0, clipDurationSec - trimStartSec));
  return { trimStartSec, trimEndSec };
}

function normalizeCuts(cuts: TimelineCut[] | undefined, clipDurationSec: number, trim: TimelineTrim): TimelineCut[] {
  const trimStart = trim.trimStartSec;
  const trimEnd = clipDurationSec - trim.trimEndSec;
  if (trimEnd <= trimStart) return [];

  const sorted = (cuts || [])
    .map((cut) => ({
      startSec: clamp(Number(cut.startSec) || 0, trimStart, trimEnd),
      endSec: clamp(Number(cut.endSec) || 0, trimStart, trimEnd),
    }))
    .filter((cut) => cut.endSec > cut.startSec + 0.01)
    .sort((a, b) => a.startSec - b.startSec);

  const merged: TimelineCut[] = [];
  for (const cut of sorted) {
    const last = merged[merged.length - 1];
    if (last && cut.startSec <= last.endSec + 0.01) {
      last.endSec = Math.max(last.endSec, cut.endSec);
    } else {
      merged.push({ ...cut });
    }
  }
  return merged;
}

export function buildRenderMediaSegments(
  clipStartSec: number,
  clipEndSec: number,
  cuts: TimelineCut[] | undefined,
  trim: TimelineTrim | undefined,
): RenderMediaSegment[] {
  const clipDurationSec = Math.max(0, clipEndSec - clipStartSec);
  const normalizedTrim = normalizeTrim(trim, clipDurationSec);
  const normalizedCuts = normalizeCuts(cuts, clipDurationSec, normalizedTrim);
  const windowStart = normalizedTrim.trimStartSec;
  const windowEnd = clipDurationSec - normalizedTrim.trimEndSec;
  const mediaSegments: RenderMediaSegment[] = [];
  let cursor = windowStart;
  let outputCursor = 0;

  const pushSegment = (start: number, end: number) => {
    if (end <= start + 0.01) return;
    const duration = end - start;
    mediaSegments.push({
      sourceStartSec: clipStartSec + start,
      sourceEndSec: clipStartSec + end,
      outputStartSec: outputCursor,
      outputEndSec: outputCursor + duration,
    });
    outputCursor += duration;
  };

  for (const cut of normalizedCuts) {
    pushSegment(cursor, cut.startSec);
    cursor = Math.max(cursor, cut.endSec);
  }
  pushSegment(cursor, windowEnd);

  return mediaSegments.length > 0
    ? mediaSegments
    : [{
        sourceStartSec: clipStartSec,
        sourceEndSec: clipEndSec,
        outputStartSec: 0,
        outputEndSec: clipDurationSec,
      }];
}

function shiftCuesForTrim(
  cues: Array<{ startSec: number; endSec: number; text: string }>,
  trimStartSec: number,
): Array<{ startSec: number; endSec: number; text: string }> {
  if (trimStartSec <= 0) return cues;
  return cues.map((cue) => ({
    ...cue,
    startSec: cue.startSec - trimStartSec,
    endSec: cue.endSec - trimStartSec,
  }));
}

function shiftKeyframesForTrim(keyframes: FrameKeyframe[], trimStartSec: number, durationSec: number): FrameKeyframe[] {
  if (trimStartSec <= 0) return keyframes.filter((point) => point.time <= durationSec + 0.01);
  const baseFrame = {
    ...interpolateFrameState(keyframes, trimStartSec),
    id: 'frame_trim_start',
    time: 0,
  };
  const shifted = keyframes
    .map((point) => ({ ...point, time: point.time - trimStartSec }))
    .filter((point) => point.time >= -0.01 && point.time <= durationSec + 0.01)
    .map((point) => ({ ...point, time: Math.max(0, point.time) }));
  return [baseFrame, ...shifted.filter((point) => point.time > 0.01)];
}

export function buildShortsRenderProject(input: ShortsRenderProjectInput): ShortsRenderProject {
  const clipDurationSec = Math.max(0, input.clipEndSec - input.clipStartSec);
  const trim = normalizeTrim(input.timelineTrim, clipDurationSec);
  const cuts = normalizeCuts(input.timelineCuts, clipDurationSec, trim);
  const mediaSegments = buildRenderMediaSegments(input.clipStartSec, input.clipEndSec, cuts, trim);
  const durationSec = Math.max(0.05, mediaSegments[mediaSegments.length - 1]?.outputEndSec || clipDurationSec || 1);
  const fps = Math.max(1, Math.round(input.fps || 30));
  const initialKeyframes = input.frameKeyframes?.length
    ? input.frameKeyframes
    : [{ ...DEFAULT_FRAME, backgroundColor: '#000000' }];
  const keyframes = shiftKeyframesForTrim(initialKeyframes, trim.trimStartSec, durationSec);

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
    subtitles: normalizeRenderSubtitles(shiftCuesForTrim(input.cues, trim.trimStartSec), durationSec),
    captionStyle: input.style,
    subtitleBottomMargin: input.subtitleBottomMargin,
    frameKeyframes: keyframes.length ? keyframes : [{ ...DEFAULT_FRAME, backgroundColor: initialKeyframes[0]?.backgroundColor || '#000000' }],
    mediaSegments,
    timelineCuts: cuts,
    timelineTrim: trim,
    backgroundSettings: input.backgroundSettings,
  };
}
