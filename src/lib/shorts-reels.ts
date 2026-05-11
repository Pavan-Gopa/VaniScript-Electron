import type { AlignedSubtitleSegment, FrameKeyframe } from './subtitle-alignment';

export type ShortsClipPlan = {
  start: string;
  end: string;
  title: string;
  summary: string;
  hook: string;
  category?: string;
  sourceTitle?: string;
  sourceSummary?: string;
  sourceHook?: string;
  sourceCategory?: string;
  targetTitle?: string;
  targetSummary?: string;
  targetHook?: string;
  targetCategory?: string;
  captionText?: string;
  sourceCaptionText?: string;
  targetCaptionText?: string;
  sourceAlignment?: AlignedSubtitleSegment[];
  targetAlignment?: AlignedSubtitleSegment[];
  sourceFrameKeyframes?: FrameKeyframe[];
  targetFrameKeyframes?: FrameKeyframe[];
  languageMode?: ShortsPlanLanguageMode;
};

export type ShortsPlanLanguageMode = 'source' | 'target' | 'bilingual';

export type ShortsPlanOptions = {
  transcript: string;
  count: number;
  minDurationSec: number;
  maxDurationSec: number;
  outputLanguage: string;
  speakerName?: string;
  mode?: ShortsPlanLanguageMode;
};

export function buildShortsPrompt(opts: ShortsPlanOptions): string {
  const modeInstruction = opts.mode === 'source'
    ? 'Analyze the source-language transcript and write title, summary, hook, category, and captionText in the source language.'
    : opts.mode === 'bilingual'
      ? 'Analyze the paired source and target transcript. Choose moments that work well in both languages. For every item, write sourceTitle, sourceSummary, sourceHook, sourceCategory, sourceCaptionText in the source language, and targetTitle, targetSummary, targetHook, targetCategory, targetCaptionText in the target language. Also set title, summary, hook, category, captionText equal to the target-language values.'
      : `Analyze the target-language transcript and write title, summary, hook, category, and captionText in ${opts.outputLanguage}.`;
  const captionSchema = opts.mode === 'bilingual'
    ? 'Return only a JSON array. Each item must contain: start, end, title, summary, hook, category, captionText, sourceTitle, sourceSummary, sourceHook, sourceCategory, sourceCaptionText, targetTitle, targetSummary, targetHook, targetCategory, targetCaptionText.'
    : 'Return only a JSON array. Each item must contain: start, end, title, summary, hook, category, captionText.';
  return [
    'You are selecting clips for YouTube Shorts, Instagram Reels, and TikTok.',
    'Context: Vaishnava lecture. Prefer moments with a clear story, paradox, emotional point, practical teaching, or memorable quote.',
    opts.speakerName?.trim()
      ? `Speaker metadata: ${opts.speakerName.trim()}. When describing who is speaking, use this name or a respectful shortened form such as Maharaj or Swami. Do not write generic phrases like "the speaker", "the speaker shares", "спикер", or "говорящий" when this metadata is available.`
      : 'Speaker metadata is unknown. If you refer to the person speaking, use a generic phrase such as "the speaker".',
    `Find exactly ${opts.count} candidate clips.`,
    `Each clip must be between ${opts.minDurationSec} and ${opts.maxDurationSec} seconds.`,
    modeInstruction,
    captionSchema,
    'captionText is the exact short-form subtitle script for this clip. It is not a summary.',
    'captionText must contain many dense timestamped subtitle cues, one cue per line, formatted exactly as "[MM:SS] text".',
    'Use absolute timestamps from the transcript, not relative timestamps. The first caption timestamp should be the clip start or the first spoken line inside the clip.',
    'Create a new caption cue roughly every 1.5-4 seconds, or whenever the spoken phrase naturally changes.',
    'Never put a whole 45-180 second clip into one or two caption cues. That makes the reel unusable.',
    'Each caption cue should fit on a phone screen: aim for one line, maximum two short lines, usually 3-10 words or about 18-42 characters.',
    'Preserve meaning and spoken order. Do not add commentary, explanations, markdown, numbering, or speaker labels inside captionText.',
    'For bilingual output, sourceCaptionText and targetCaptionText must use the same timestamp markers and the same number/order of cues so both videos stay aligned.',
    'Example captionText format: "[04:56] The spiritual city is\\n[04:59] the spiritual character of His residence\\n[05:03] In building the city of Mayapur"',
    'Use short category tags such as story, philosophy, quote, teaching, humor, or history.',
    'Do not invent timestamps. Use only timestamps from the transcript.',
    '',
    'Transcript:',
    opts.transcript,
  ].join('\n');
}

export function parseShortsPlanResponse(text: string): ShortsClipPlan[] {
  const clean = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('Shorts plan response did not contain a JSON array.');
  const parsed = JSON.parse(clean.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('Shorts plan response was not an array.');
  return parsed
    .map((item) => ({
      start: String(item.start || ''),
      end: String(item.end || ''),
      title: String(item.title || ''),
      summary: String(item.summary || ''),
      hook: String(item.hook || ''),
      category: String(item.category || 'clip'),
      captionText: item.captionText ? String(item.captionText) : undefined,
      sourceTitle: item.sourceTitle ? String(item.sourceTitle) : undefined,
      sourceSummary: item.sourceSummary ? String(item.sourceSummary) : undefined,
      sourceHook: item.sourceHook ? String(item.sourceHook) : undefined,
      sourceCategory: item.sourceCategory ? String(item.sourceCategory) : undefined,
      sourceCaptionText: item.sourceCaptionText ? String(item.sourceCaptionText) : undefined,
      targetTitle: item.targetTitle ? String(item.targetTitle) : undefined,
      targetSummary: item.targetSummary ? String(item.targetSummary) : undefined,
      targetHook: item.targetHook ? String(item.targetHook) : undefined,
      targetCategory: item.targetCategory ? String(item.targetCategory) : undefined,
      targetCaptionText: item.targetCaptionText ? String(item.targetCaptionText) : undefined,
    }))
    .filter((item) => item.start && item.end && item.title);
}

export function parseTimestampToSeconds(timestamp: string): number {
  const clean = timestamp.trim().replace(/^\[/, '').replace(/\]$/, '');
  const parts = clean.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  if (parts.length === 2) return (parts[0] * 60) + parts[1];
  return parts[0] || 0;
}

export function secondsToShortsTimestamp(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function validateShortClip(
  clip: { startSec: number; endSec: number },
  minDurationSec: number,
  maxDurationSec: number
): { ok: boolean; durationSec: number; reason?: string } {
  const durationSec = clip.endSec - clip.startSec;
  if (durationSec < minDurationSec) return { ok: false, durationSec, reason: 'Clip is shorter than minimum duration.' };
  if (durationSec > maxDurationSec) return { ok: false, durationSec, reason: 'Clip is longer than maximum duration.' };
  return { ok: true, durationSec };
}
