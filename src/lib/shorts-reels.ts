import type { AlignedSubtitleSegment, FrameKeyframe } from './subtitle-alignment';
import type { BackgroundSettings, ShortsSubtitleStyle } from './shorts-render';
import { renderPrompt, type PromptSettingsMap } from './prompt-presets';

/** A cut region removed from the clip timeline via razor/delete. */
export type TimelineCut = {
  /** Start of the removed section, relative to clip start (seconds). */
  startSec: number;
  /** End of the removed section, relative to clip start (seconds). */
  endSec: number;
};

/** Edge trim applied to the clip without changing the source timecodes. */
export type TimelineTrim = {
  /** Seconds trimmed from the start. */
  trimStartSec: number;
  /** Seconds trimmed from the end. */
  trimEndSec: number;
};

export type LogoOverlaySettings = {
  id: string;
  src: string;
  name?: string;
  size: number;
  opacity: number;
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  hidden?: boolean;
};

export type IntroOutroOverlaySettings = {
  id: string;
  src: string;
  name?: string;
  duration: number; // 1 to 5 seconds
  x: number; // 0 to 100
  y: number; // 0 to 100
  scale: number; // 0.1 to 2.0
  animation: 'none' | 'fade' | 'pulse' | 'bounce';
  hidden?: boolean;
  speed?: number; // 0 to 2.0 (representing 0% to 200%)
  transitionSec?: number; // 0 to 3.0 seconds
};

export type TextOverlayBlock = {
  id: string;
  startSec: number;
  endSec: number;
  text: string;
  hidden?: boolean;
};

export type TextOverlayTrack = {
  id: string;
  name: string;
  hidden?: boolean;
  muted?: boolean;
  blocks: TextOverlayBlock[];
  style?: Partial<ShortsSubtitleStyle>;
};

export type ExtraAudioTrack = {
  id: string;
  name: string;
  src: string;
  /** Browser-only preview URL. Export continues to use src. */
  previewSrc?: string;
  startSec: number;
  trimStartSec: number;
  trimEndSec: number;
  volume: number;
  fadeInSec: number;
  fadeOutSec: number;
  muted?: boolean;
};

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

  /** Groups source + target clips so edits can be synced. */
  linkedClipGroupId?: string;
  /** Whether frame/style sync is active for this clip. */
  syncEnabled?: boolean;
  /** Timeline cuts (razor tool removals). */
  timelineCuts?: TimelineCut[];
  /** Edge trim. */
  timelineTrim?: TimelineTrim;
  /** Background compositor settings. */
  backgroundSettings?: BackgroundSettings;
  /** Shared/fallback overlay state. */
  logo?: LogoOverlaySettings;
  textTracks?: TextOverlayTrack[];
  audioTracks?: ExtraAudioTrack[];
  intro?: IntroOutroOverlaySettings;
  outro?: IntroOutroOverlaySettings;
  /** Language-specific overlay state for bilingual clips. */
  sourceLogo?: LogoOverlaySettings;
  targetLogo?: LogoOverlaySettings;
  sourceTextTracks?: TextOverlayTrack[];
  targetTextTracks?: TextOverlayTrack[];
  sourceAudioTracks?: ExtraAudioTrack[];
  targetAudioTracks?: ExtraAudioTrack[];
  sourceIntro?: IntroOutroOverlaySettings;
  targetIntro?: IntroOutroOverlaySettings;
  sourceOutro?: IntroOutroOverlaySettings;
  targetOutro?: IntroOutroOverlaySettings;
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
  existingClips?: Pick<ShortsClipPlan, 'start' | 'end' | 'title'>[];
  promptPresets?: PromptSettingsMap;
};

export type AppendShortsPlansResult = {
  plans: ShortsClipPlan[];
  addedIndexes: number[];
  skippedOverlapping: ShortsClipPlan[];
};

function existingRangesInstruction(existingClips: Pick<ShortsClipPlan, 'start' | 'end' | 'title'>[] = []): string {
  const ranges = existingClips
    .filter((clip) => clip.start && clip.end)
    .map((clip, index) => {
      const title = clip.title?.trim() ? ` - ${clip.title.trim()}` : '';
      return `${index + 1}. ${clip.start} -> ${clip.end}${title}`;
    });
  if (ranges.length === 0) return '';
  return [
    'Already selected ranges:',
    ...ranges,
    'Do not choose moments that overlap any already selected range. Find different, non-overlapping moments outside these ranges.',
  ].join('\n');
}

export function buildShortsPrompt(opts: ShortsPlanOptions): string {
  const existingRanges = existingRangesInstruction(opts.existingClips);
  const modeInstruction = opts.mode === 'source'
    ? 'Analyze the source-language transcript and write title, summary, hook, category, and captionText in the source language.'
    : opts.mode === 'bilingual'
      ? 'Analyze the paired source and target transcript. Choose moments that work well in both languages. For every item, write sourceTitle, sourceSummary, sourceHook, sourceCategory, sourceCaptionText in the source language, and targetTitle, targetSummary, targetHook, targetCategory, targetCaptionText in the target language. Also set title, summary, hook, category, captionText equal to the target-language values.'
      : `Analyze the target-language transcript and write title, summary, hook, category, and captionText in ${opts.outputLanguage}.`;
  const captionSchema = opts.mode === 'bilingual'
    ? 'Return only a JSON array. Each item must contain: start, end, title, summary, hook, category, captionText, sourceTitle, sourceSummary, sourceHook, sourceCategory, sourceCaptionText, targetTitle, targetSummary, targetHook, targetCategory, targetCaptionText.'
    : 'Return only a JSON array. Each item must contain: start, end, title, summary, hook, category, captionText.';
  const speakerMetadataLine = opts.speakerName?.trim()
    ? `Speaker metadata: ${opts.speakerName.trim()}. When describing who is speaking, use this name or a respectful shortened form such as Maharaj or Swami. Do not write generic phrases like "the speaker", "the speaker shares", "спикер", or "говорящий" when this metadata is available.`
    : 'Speaker metadata is unknown. If you refer to the person speaking, use a generic phrase such as "the speaker".';
  const basePrompt = renderPrompt(opts.promptPresets, 'shortsPlanner', {
    speakerMetadataLine,
    count: opts.count,
    minDurationSec: opts.minDurationSec,
    maxDurationSec: opts.maxDurationSec,
    modeInstruction,
    captionSchema,
    existingRangesBlock: existingRanges,
    transcript: opts.transcript,
  });
  return existingRanges && !basePrompt.includes(existingRanges)
    ? [basePrompt, existingRanges].filter(Boolean).join('\n\n')
    : basePrompt;
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

function clipRange(plan: Pick<ShortsClipPlan, 'start' | 'end'>): { startSec: number; endSec: number } {
  const startSec = parseTimestampToSeconds(plan.start);
  const endSec = parseTimestampToSeconds(plan.end);
  return { startSec: Math.min(startSec, endSec), endSec: Math.max(startSec, endSec) };
}

function overlapSeconds(
  a: { startSec: number; endSec: number },
  b: { startSec: number; endSec: number }
): number {
  return Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));
}

export function appendNonOverlappingShortsPlans(
  existingPlans: ShortsClipPlan[],
  incomingPlans: ShortsClipPlan[],
  minOverlapSec = 1
): AppendShortsPlansResult {
  const plans = [...existingPlans];
  const addedIndexes: number[] = [];
  const skippedOverlapping: ShortsClipPlan[] = [];

  for (const incoming of incomingPlans) {
    const incomingRange = clipRange(incoming);
    const overlaps = plans.some((plan) => overlapSeconds(incomingRange, clipRange(plan)) > minOverlapSec);
    if (overlaps) {
      skippedOverlapping.push(incoming);
      continue;
    }
    addedIndexes.push(plans.length);
    plans.push(incoming);
  }

  return { plans, addedIndexes, skippedOverlapping };
}
