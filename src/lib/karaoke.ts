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
}

export type KaraokeLine = KaraokePlainLine | KaraokeTimedLine;

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
  const blocks = content
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

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

export function activeWordIndex(words: string[], startSec: number, endSec: number, currentSec: number): number {
  if (words.length === 0 || currentSec < startSec || currentSec >= endSec) return -1;
  const duration = Math.max(0.1, endSec - startSec);
  const ratio = Math.min(0.999, Math.max(0, (currentSec - startSec) / duration));
  return Math.min(words.length - 1, Math.floor(ratio * words.length));
}
