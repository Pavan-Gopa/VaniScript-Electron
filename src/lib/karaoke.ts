import type { TranscriptCue, TranscriptWord } from '../types';

export interface KaraokePlainLine {
  kind: 'plain';
  text: string;
}

export interface KaraokeTimedLine {
  kind: 'timed';
  timestamp: string;
  startSec: number;
  endSec: number;
  text: string;
  words: string[];
  // Exact per-word timing when this line was built from structured cues
  // (canonical TranscriptCue.words). When present, activeWordIndex uses real
  // word timestamps instead of the ratio-based approximation.
  timedWords?: TranscriptWord[];
}

export type KaraokeLine = KaraokePlainLine | KaraokeTimedLine;

// Matches an inline `[mm:ss]` / `[h:mm:ss]` timestamp marker (with optional
// fractional seconds). Used to decide whether a chunk's text carries its own
// marker timing (Electron-native) vs. clean text that must be driven by cues.
const INLINE_TIMESTAMP_PATTERN = /\[(?:(?:\d+:)?\d{2}:\d{2}(?:[.,]\d{1,3})?)\]/;

export function hasInlineTimestampMarkers(content: string): boolean {
  return INLINE_TIMESTAMP_PATTERN.test(String(content || ''));
}

export function formatPlaybackClock(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function parseTimestampToSeconds(value: string): number | null {
  const match = value.trim().match(/^(?:(\d+):)?(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!match) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = match[4] ? Number(match[4].padEnd(3, '0')) / 1000 : 0;
  return (hours * 3600) + (minutes * 60) + seconds + millis;
}

function shouldOffsetRelativeTimestamps(startSeconds: number[], fallbackStartSec: number, fallbackEndSec: number): boolean {
  if (fallbackStartSec <= 0 || startSeconds.length === 0) return false;
  const chunkDurationSec = Math.max(0, fallbackEndSec - fallbackStartSec);
  const maxStartSec = Math.max(...startSeconds);
  const allTimestampsBeforeChunk = startSeconds.every((startSec) => startSec < fallbackStartSec - 0.5);
  const timestampsFitInsideChunk = chunkDurationSec <= 0 || maxStartSec <= chunkDurationSec + 10;
  return allTimestampsBeforeChunk && timestampsFitInsideChunk;
}

function splitKaraokeBlocks(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const marker = /(^|\n)\s*\[((?:(?:\d+:)?\d{2}:\d{2}(?:[.,]\d{1,3})?))\]\s*/g;
  const matches = [...normalized.matchAll(marker)];
  if (matches.length <= 1) {
    return normalized
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean);
  }

  const blocks: string[] = [];
  const firstIndex = matches[0].index ?? 0;
  const leading = normalized.slice(0, firstIndex).trim();
  if (leading) blocks.push(leading);

  matches.forEach((match, index) => {
    const start = (match.index ?? 0) + match[1].length;
    const nextStart = index + 1 < matches.length ? (matches[index + 1].index ?? normalized.length) : normalized.length;
    const block = normalized.slice(start, nextStart).trim();
    if (block) blocks.push(block);
  });

  return blocks;
}

export function normalizeRelativeTimestamps(content: string, fallbackStartSec: number, fallbackEndSec: number): string {
  const markers = [...content.matchAll(/\[([^\]]+)\]/g)]
    .map((match) => ({ raw: match[1], seconds: parseTimestampToSeconds(match[1]) }))
    .filter((marker): marker is { raw: string; seconds: number } => marker.seconds !== null);

  if (!shouldOffsetRelativeTimestamps(markers.map((marker) => marker.seconds), fallbackStartSec, fallbackEndSec)) {
    return content;
  }

  return content.replace(/\[([^\]]+)\]/g, (full, raw) => {
    const seconds = parseTimestampToSeconds(raw);
    if (seconds === null) return full;
    return `[${formatPlaybackClock(seconds + fallbackStartSec)}]`;
  });
}

export function parseKaraokeLines(content: string, fallbackStartSec: number, fallbackEndSec: number): KaraokeLine[] {
  const blocks = splitKaraokeBlocks(content);

  const parsed: KaraokeLine[] = blocks.map((block) => {
    const match = block.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
    if (!match) return { kind: 'plain', text: block };

    const startSec = parseTimestampToSeconds(match[1]);
    if (startSec === null) return { kind: 'plain', text: block };

    const text = match[2].trim();
    return {
      kind: 'timed',
      timestamp: match[1],
      startSec,
      endSec: fallbackEndSec,
      text,
      words: text.match(/\S+/g) || [],
    };
  });

  const timedLines = parsed.filter((line): line is KaraokeTimedLine => line.kind === 'timed');
  if (shouldOffsetRelativeTimestamps(timedLines.map((line) => line.startSec), fallbackStartSec, fallbackEndSec)) {
    timedLines.forEach((line) => {
      line.startSec += fallbackStartSec;
      line.timestamp = formatPlaybackClock(line.startSec);
    });
  }

  for (let i = 0; i < parsed.length; i += 1) {
    const line = parsed[i];
    if (line.kind !== 'timed') continue;

    const nextTimed = parsed.slice(i + 1).find((candidate): candidate is KaraokeTimedLine => candidate.kind === 'timed');
    line.endSec = nextTimed?.startSec ?? fallbackEndSec;
    if (line.endSec <= line.startSec) {
      line.endSec = Math.max(line.startSec + 1, fallbackEndSec || line.startSec + 1);
    }
  }

  if (parsed.length === 0 && content.trim()) {
    return [{
      kind: 'timed',
      timestamp: formatPlaybackClock(fallbackStartSec),
      startSec: fallbackStartSec,
      endSec: Math.max(fallbackEndSec, fallbackStartSec + 1),
      text: content.trim(),
      words: content.trim().match(/\S+/g) || [],
    }];
  }

  return parsed;
}

export function activeWordIndex(
  words: string[],
  startSec: number,
  endSec: number,
  currentSec: number,
  timedWords?: TranscriptWord[]
): number {
  if (words.length === 0 && (!timedWords || timedWords.length === 0)) return -1;
  if (currentSec < startSec || currentSec >= endSec) return -1;

  // Exact per-word timing when available (canonical cues carry TranscriptWord
  // seconds from WhisperKit / OpenAI word timestamps).
  if (timedWords && timedWords.length > 0) {
    const exact = timedWords.findIndex((w) => currentSec >= w.startSec && currentSec < w.endSec);
    if (exact >= 0) return Math.min(exact, Math.max(0, words.length - 1));
    // In a gap between words: snap to the most recent word that has started.
    let lastStarted = -1;
    for (let i = 0; i < timedWords.length; i += 1) {
      if (timedWords[i].startSec <= currentSec) lastStarted = i;
      else break;
    }
    if (lastStarted >= 0) return Math.min(lastStarted, Math.max(0, words.length - 1));
    return 0;
  }

  // Ratio-based fallback (inline marker lines / cues without word timing).
  if (words.length === 0) return -1;
  const duration = Math.max(0.1, endSec - startSec);
  const ratio = Math.min(0.999, Math.max(0, (currentSec - startSec) / duration));
  return Math.min(words.length - 1, Math.floor(ratio * words.length));
}

// Convert canonical structured cues into karaoke lines for rendering. Mirrors
// the per-cue timing exactly and carries word-level timestamps through to
// `timedWords` so highlighting is sample-accurate when available.
export function cuesToKaraokeLines(cues: TranscriptCue[] | undefined | null): KaraokeTimedLine[] {
  if (!cues || cues.length === 0) return [];
  const lines: KaraokeTimedLine[] = [];
  for (const cue of cues) {
    if (!cue || typeof cue.text !== 'string') continue;
    const text = cue.text.trim();
    if (!text) continue;
    const wordStrings = text.match(/\S+/g) || [];
    lines.push({
      kind: 'timed',
      timestamp: formatPlaybackClock(cue.startSec),
      startSec: cue.startSec,
      endSec: cue.endSec,
      text,
      words: wordStrings,
      timedWords: cue.words,
    });
  }
  return lines;
}
