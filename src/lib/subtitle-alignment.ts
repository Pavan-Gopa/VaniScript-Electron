export type AlignedWord = {
  id: string;
  text: string;
  start: number;
  end: number;
};

export type AlignedSubtitleSegment = {
  id: string;
  start: number;
  end: number;
  text: string;
  words: AlignedWord[];
};

export type FrameKeyframe = {
  id: string;
  time: number;
  x: number;
  y: number;
  zoom: number;
  backgroundColor?: string;
};

export type AlignedSubtitleCue = {
  startSec: number;
  endSec: number;
  text: string;
};

const MIN_SEGMENT_DURATION = 0.25;
const FRAME_KEYFRAME_SNAP_SECONDS = 0.15;
type NormalizeOptions = { keepEmpty?: boolean };

function makeId(prefix: string, index: number): string {
  return `${prefix}_${index}_${Math.random().toString(36).slice(2, 8)}`;
}

export function clampTime(value: number, durationSec: number): number {
  return Math.min(Math.max(0, value), Math.max(0, durationSec));
}

export function inferWordsForSegment(segment: Omit<AlignedSubtitleSegment, 'words'>): AlignedWord[] {
  const words = segment.text.match(/\S+/g) || [];
  if (words.length === 0) return [];
  const duration = Math.max(MIN_SEGMENT_DURATION, segment.end - segment.start);
  const step = duration / words.length;
  return words.map((text, index) => ({
    id: makeId('word', index),
    text,
    start: segment.start + (step * index),
    end: index === words.length - 1 ? segment.end : segment.start + (step * (index + 1)),
  }));
}

export function cuesToAlignedSegments(cues: AlignedSubtitleCue[], clipDurationSec: number): AlignedSubtitleSegment[] {
  return cues
    .filter((cue) => cue.text.trim())
    .map((cue, index) => {
      const start = clampTime(cue.startSec, clipDurationSec);
      const end = Math.max(start + MIN_SEGMENT_DURATION, clampTime(cue.endSec, clipDurationSec));
      const base = {
        id: makeId('sub', index),
        start,
        end: clampTime(end, clipDurationSec),
        text: cue.text.trim(),
      };
      return {
        ...base,
        words: inferWordsForSegment(base),
      };
    });
}

function cleanEditableText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeSegments(
  segments: AlignedSubtitleSegment[],
  clipDurationSec: number,
  options: NormalizeOptions = {}
): AlignedSubtitleSegment[] {
  const prepared = options.keepEmpty ? segments : segments.filter((segment) => segment.text.trim());
  return prepared
    .map((segment, index) => {
      const start = clampTime(segment.start, clipDurationSec);
      const end = clampTime(Math.max(start + MIN_SEGMENT_DURATION, segment.end), clipDurationSec);
      const text = cleanEditableText(segment.text);
      const words = segment.words.length > 0
        ? segment.words.map((word) => ({
            ...word,
            start: clampTime(word.start, clipDurationSec),
            end: clampTime(Math.max(word.start + 0.05, word.end), clipDurationSec),
          }))
        : inferWordsForSegment({ id: segment.id || makeId('sub', index), start, end, text });
      return {
        id: segment.id || makeId('sub', index),
        start,
        end,
        text,
        words,
      };
    })
    .sort((a, b) => a.start - b.start);
}

export function alignedSegmentsToCues(segments: AlignedSubtitleSegment[]): AlignedSubtitleCue[] {
  return normalizeSegments(segments, Math.max(0, ...segments.map((segment) => segment.end))).map((segment) => ({
    startSec: segment.start,
    endSec: segment.end,
    text: segment.text,
  }));
}

export function updateSegmentText(
  segments: AlignedSubtitleSegment[],
  segmentId: string,
  text: string,
  clipDurationSec: number
): AlignedSubtitleSegment[] {
  return normalizeSegments(segments.map((segment) => {
    if (segment.id !== segmentId) return segment;
    const next = { ...segment, text };
    return { ...next, words: inferWordsForSegment(next) };
  }), clipDurationSec, { keepEmpty: true });
}

export function splitSegment(
  segments: AlignedSubtitleSegment[],
  segmentId: string,
  clipDurationSec: number
): AlignedSubtitleSegment[] {
  const index = segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0) return segments;
  const segment = segments[index];
  const words = segment.text.match(/\S+/g) || [];
  if (words.length < 2 || segment.end - segment.start < MIN_SEGMENT_DURATION * 2) return segments;
  const pivot = Math.ceil(words.length / 2);
  const mid = segment.start + ((segment.end - segment.start) * (pivot / words.length));
  const first = {
    id: makeId('sub', index),
    start: segment.start,
    end: mid,
    text: words.slice(0, pivot).join(' '),
  };
  const second = {
    id: makeId('sub', index + 1),
    start: mid,
    end: segment.end,
    text: words.slice(pivot).join(' '),
  };
  return normalizeSegments([
    ...segments.slice(0, index),
    { ...first, words: inferWordsForSegment(first) },
    { ...second, words: inferWordsForSegment(second) },
    ...segments.slice(index + 1),
  ], clipDurationSec);
}

export function mergeSegmentWithNext(
  segments: AlignedSubtitleSegment[],
  segmentId: string,
  clipDurationSec: number
): AlignedSubtitleSegment[] {
  const index = segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0 || index >= segments.length - 1) return segments;
  const current = segments[index];
  const next = segments[index + 1];
  const merged = {
    id: current.id,
    start: current.start,
    end: next.end,
    text: `${current.text} ${next.text}`.replace(/\s+/g, ' ').trim(),
  };
  return normalizeSegments([
    ...segments.slice(0, index),
    { ...merged, words: inferWordsForSegment(merged) },
    ...segments.slice(index + 2),
  ], clipDurationSec);
}

export function moveWordToAdjacentSegment(
  segments: AlignedSubtitleSegment[],
  segmentId: string,
  wordIndex: number,
  direction: 'previous' | 'next',
  clipDurationSec: number
): AlignedSubtitleSegment[] {
  const segmentIndex = segments.findIndex((segment) => segment.id === segmentId);
  const targetIndex = direction === 'previous' ? segmentIndex - 1 : segmentIndex + 1;
  if (segmentIndex < 0 || targetIndex < 0 || targetIndex >= segments.length) return segments;
  const sourceWords: string[] = [...(segments[segmentIndex].text.match(/\S+/g) || [])];
  if (wordIndex < 0 || wordIndex >= sourceWords.length) return segments;
  const [word] = sourceWords.splice(wordIndex, 1);
  const targetWords: string[] = [...(segments[targetIndex].text.match(/\S+/g) || [])];
  if (direction === 'previous') targetWords.push(word);
  else targetWords.unshift(word);

  return normalizeSegments(segments.map((segment, index) => {
    if (index === segmentIndex) {
      const next = { ...segment, text: sourceWords.join(' ') };
      return { ...next, words: inferWordsForSegment(next) };
    }
    if (index === targetIndex) {
      const next = { ...segment, text: targetWords.join(' ') };
      return { ...next, words: inferWordsForSegment(next) };
    }
    return segment;
  }), clipDurationSec);
}

type MaterializeFrameKeyframesOptions = {
  frameKeyframes: FrameKeyframe[];
  currentSec: number;
  clipDurationSec: number;
  framePanX: number;
  framePanY: number;
  frameZoom: number;
  backgroundColor?: string;
};

export function materializeFrameKeyframesForSave({
  frameKeyframes,
  currentSec,
  clipDurationSec,
  framePanX,
  framePanY,
  frameZoom,
  backgroundColor,
}: MaterializeFrameKeyframesOptions): FrameKeyframe[] {
  const snapTarget = frameKeyframes.find((point) => Math.abs(point.time - currentSec) <= FRAME_KEYFRAME_SNAP_SECONDS);
  const currentPoint: FrameKeyframe = {
    id: snapTarget?.id || `frame_${Date.now()}`,
    time: frameKeyframes.length > 0 ? currentSec : 0,
    x: framePanX,
    y: framePanY,
    zoom: frameZoom,
    backgroundColor,
  };
  const next = frameKeyframes.length === 0
    ? [currentPoint]
    : snapTarget
      ? frameKeyframes.map((point) => point.id === snapTarget.id ? currentPoint : point)
      : [...frameKeyframes, currentPoint];

  return next
    .map((point) => ({
      ...point,
      time: clampTime(point.time, clipDurationSec),
      zoom: Math.min(Math.max(0.5, point.zoom), 2),
      x: Math.min(Math.max(-50, point.x), 50),
      y: Math.min(Math.max(-30, point.y), 30),
      backgroundColor: point.backgroundColor || backgroundColor,
    }))
    .sort((a, b) => a.time - b.time);
}
