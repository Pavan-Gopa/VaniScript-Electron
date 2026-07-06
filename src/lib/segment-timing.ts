export type TimedWord = {
  text: string;
  start: number;
  end: number;
};

export type TimedCue = {
  startSec: number;
  endSec: number;
  text: string;
};

export type CueTimingOptions = {
  maxCueDurationSec?: number;
  maxCharsPerCue?: number;
  maxWordsPerCue?: number;
  minCueDurationSec?: number;
};

const DEFAULT_MAX_CUE_DURATION_SEC = 3.5;
const DEFAULT_MAX_CHARS_PER_CUE = 42;
const DEFAULT_MAX_WORDS_PER_CUE = 10;
const DEFAULT_MIN_CUE_DURATION_SEC = 0.18;
const ABBREVIATIONS = new Set([
  'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.', 'st.',
  'u.s.', 'u.k.', 'e.g.', 'i.e.', 'etc.',
]);

function cleanWordText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function sentenceEndsWord(text: string): boolean {
  const clean = cleanWordText(text).toLowerCase();
  if (!clean || ABBREVIATIONS.has(clean)) return false;
  return /[.!?。！？]$/.test(clean);
}

function formatClock(seconds: number, separator: ',' | '.'): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const whole = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    `${String(whole).padStart(2, '0')}${separator}${String(ms).padStart(3, '0')}`,
  ].join(':');
}

function formatShortTimestamp(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const secs = safe % 60;
  return `[${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}]`;
}

function cueFromWords(words: TimedWord[]): TimedCue | null {
  const clean = words
    .map((word) => cleanWordText(word.text))
    .filter(Boolean);
  if (clean.length === 0) return null;
  const first = words[0];
  const last = words[words.length - 1];
  return {
    startSec: Math.max(0, first.start),
    endSec: Math.max(first.start + DEFAULT_MIN_CUE_DURATION_SEC, last.end),
    text: clean.join(' '),
  };
}

export function buildReadableCuesFromWords(
  rawWords: TimedWord[],
  options: CueTimingOptions = {},
): TimedCue[] {
  const maxCueDurationSec = options.maxCueDurationSec ?? DEFAULT_MAX_CUE_DURATION_SEC;
  const maxCharsPerCue = options.maxCharsPerCue ?? DEFAULT_MAX_CHARS_PER_CUE;
  const maxWordsPerCue = options.maxWordsPerCue ?? DEFAULT_MAX_WORDS_PER_CUE;
  const minCueDurationSec = options.minCueDurationSec ?? DEFAULT_MIN_CUE_DURATION_SEC;
  const words = rawWords
    .map((word) => ({
      text: cleanWordText(word.text),
      start: Number(word.start),
      end: Number(word.end),
    }))
    .filter((word) => word.text && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start)
    .sort((a, b) => a.start - b.start);

  const cues: TimedCue[] = [];
  let current: TimedWord[] = [];

  const flush = () => {
    const cue = cueFromWords(current);
    if (cue) {
      cues.push({
        ...cue,
        endSec: Math.max(cue.startSec + minCueDurationSec, cue.endSec),
      });
    }
    current = [];
  };

  for (const word of words) {
    const candidate = [...current, word];
    const candidateText = candidate.map((part) => part.text).join(' ');
    const candidateDuration = candidate.at(-1)!.end - candidate[0].start;
    const tooLong = candidateText.length > maxCharsPerCue
      || candidate.length > maxWordsPerCue
      || candidateDuration > maxCueDurationSec;

    if (current.length > 0 && tooLong) {
      flush();
    }

    current.push(word);

    if (sentenceEndsWord(word.text)) {
      flush();
    }
  }
  flush();

  return cues;
}

function splitFallbackText(text: string, maxCharsPerCue: number): string[] {
  const sentences = text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const sourceParts = sentences.length > 0 ? sentences : [text.trim()].filter(Boolean);
  const parts: string[] = [];

  for (const sentence of sourceParts) {
    if (sentence.length <= maxCharsPerCue) {
      parts.push(sentence);
      continue;
    }
    const words = sentence.match(/\S+/g) || [];
    let current = '';
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (current && next.length > maxCharsPerCue) {
        parts.push(current);
        current = word;
      } else {
        current = next;
      }
    }
    if (current) parts.push(current);
  }

  return parts;
}

export function splitTextIntoReadableCues(
  text: string,
  durationSec: number,
  options: CueTimingOptions = {},
): TimedCue[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const maxCharsPerCue = options.maxCharsPerCue ?? DEFAULT_MAX_CHARS_PER_CUE;
  const parts = splitFallbackText(clean, maxCharsPerCue);
  const totalChars = Math.max(1, parts.reduce((sum, part) => sum + part.length, 0));
  const cues: TimedCue[] = [];
  let cursor = 0;

  parts.forEach((part, index) => {
    const share = part.length / totalChars;
    const nextCursor = index === parts.length - 1 ? durationSec : cursor + (durationSec * share);
    cues.push({
      startSec: Math.max(0, cursor),
      endSec: Math.max(cursor + (options.minCueDurationSec ?? DEFAULT_MIN_CUE_DURATION_SEC), nextCursor),
      text: part,
    });
    cursor = nextCursor;
  });

  return cues;
}

export function buildTimedTextFromWords(words: TimedWord[], options: CueTimingOptions = {}): string {
  return buildReadableCuesFromWords(words, options)
    .map((cue) => `${formatShortTimestamp(cue.startSec)} ${cue.text}`)
    .join('\n');
}

export function buildSrtFromTimedCues(cues: TimedCue[]): string {
  return cues
    .map((cue, index) => [
      String(index + 1),
      `${formatClock(cue.startSec, ',')} --> ${formatClock(cue.endSec, ',')}`,
      cue.text,
    ].join('\n'))
    .join('\n\n');
}

export function buildVttFromTimedCues(cues: TimedCue[]): string {
  const body = cues
    .map((cue) => `${formatClock(cue.startSec, '.')} --> ${formatClock(cue.endSec, '.')}\n${cue.text}`)
    .join('\n\n');
  return body ? `WEBVTT\n\n${body}` : 'WEBVTT';
}
