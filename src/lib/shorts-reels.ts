import type { AlignedSubtitleSegment, FrameKeyframe } from './subtitle-alignment';
import type { BackgroundSettings, ShortsSubtitleStyle } from './shorts-render';
import { renderPrompt, type PromptSettingsMap } from './prompt-presets';
// @ts-ignore Shared CommonJS module is consumed by both Vite and Electron Main.
import * as shortsStateShared from '../../shared/shorts-state.js';
import { isRealTranslationLanguage, translationLanguageKey } from '../../shared/media-translations.js';

/** Metadata archived for one canonical target language. */
export type ShortsClipTranslation = {
  language: string;
  title: string;
  summary: string;
  hook: string;
  category?: string;
  captionText?: string;
  provider?: string;
  updatedAt?: string;
};

/** A draft/input cut region removed from the clip timeline via razor/delete. */
export type TimelineCut = {
  /** Persisted identity for MCP/editor addressing. */
  stableID?: string;
  /** Start of the removed section, relative to clip start (seconds). */
  startSec: number;
  /** End of the removed section, relative to clip start (seconds). */
  endSec: number;
};

/** Canonical timeline cut emitted after session normalization. */
export type NormalizedTimelineCut = Omit<TimelineCut, 'stableID'> & {
  stableID: string;
};

/** Edge trim applied to the clip without changing the source timecodes. */
export type TimelineTrim = {
  /** Seconds trimmed from the start. */
  trimStartSec: number;
  /** Seconds trimmed from the end. */
  trimEndSec: number;
};

/** Draft/input shape accepted from planners, MCP, and legacy persisted data. */
export type ShortsClipPlan = {
  stableID?: string;
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
  translationsByLanguage?: Record<string, ShortsClipTranslation>;
  languageMode?: ShortsPlanLanguageMode;
  sourceAlignment?: AlignedSubtitleSegment[];
  targetAlignment?: AlignedSubtitleSegment[];
  sourceFrameKeyframes?: FrameKeyframe[];
  targetFrameKeyframes?: FrameKeyframe[];
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
  /** Per-plan subtitle style snapshot, preserved by ledger moves. */
  subtitleStyle?: ShortsSubtitleStyle;
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

/** Canonical Shorts plan emitted after session normalization. */
export type NormalizedShortsClipPlan = Omit<ShortsClipPlan, 'stableID' | 'languageMode' | 'timelineCuts'> & {
  stableID: string;
  languageMode: ShortsPlanLanguageMode;
  timelineCuts?: NormalizedTimelineCut[];
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

export type ShortsTimestampParseResult = {
  ok: boolean;
  seconds: number | null;
  canonical: string | null;
  message?: string;
};

export type ShortsValidationIssue = {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  entityId?: string;
};

export type ShortsPlanValidationOptions = {
  minDurationSec?: number;
  maxDurationSec?: number;
  sourceDurationSec?: number | null;
  session?: unknown;
  projection?: 'source' | 'target';
  activeLanguage?: string;
  activePlans?: ShortsClipPlan[];
  rejectedPlans?: ShortsClipPlan[];
  excludePlanId?: string;
  overlapThresholdSec?: number;
};

export type ShortsPlanValidationResult = {
  valid: boolean;
  planId: string;
  startSec: number | null;
  endSec: number | null;
  durationSec: number | null;
  issues: ShortsValidationIssue[];
};

export type ShortsSettingsValidationResult = {
  ok: boolean;
  minDurationSec: number;
  maxDurationSec: number;
  reason?: string;
};

export type ShortsMutationSuccess<T> = {
  success: true;
  value: T;
  validation: ShortsPlanValidationResult;
};

export type ShortsMutationFailure = {
  success: false;
  validation: ShortsPlanValidationResult;
  code: string;
  message: string;
  issues: ShortsValidationIssue[];
};

export type ShortsMutationResult<T> = ShortsMutationSuccess<T> | ShortsMutationFailure;

export type AppendShortsPlansOptions = ShortsPlanValidationOptions & {
  excludedPlans?: ShortsClipPlan[];
};

export type ShortsExportSelection = {
  plan: ShortsClipPlan;
  language: 'source' | 'target';
};

export type ShortsExportPreflightResult = {
  valid: boolean;
  results: ShortsPlanValidationResult[];
  issues: ShortsValidationIssue[];
};

export type ShortsPlanProjection = {
  available: boolean;
  languageKey?: string;
  title: string;
  summary: string;
  hook: string;
  category: string;
  captionText: string;
  variant?: ShortsClipTranslation | null;
};

export type ShortsMetadataInput = Pick<ShortsClipTranslation, 'title' | 'summary' | 'hook'>
  & Partial<Pick<ShortsClipTranslation, 'category' | 'captionText'>>;


export type AppendShortsPlansResult = {
  plans: ShortsClipPlan[];
  addedIndexes: number[];
  skippedOverlapping: ShortsClipPlan[];
};

export type ShortsDisplayLanguage = 'source' | 'target';
export type ShortsSelectionKey = `${string}:${ShortsDisplayLanguage}`;

export type ShortsSessionState = {
  [key: string]: unknown;
  shortsPlans: ShortsClipPlan[];
  shortsRejectedPlans: ShortsClipPlan[];
};

export type ShortsLedgerMutationSuccess = {
  success: true;
  session: ShortsSessionState;
  plan: ShortsClipPlan;
};

export type ShortsLedgerMutationFailure = {
  success: false;
  code: string;
  message: string;
  issues: ShortsValidationIssue[];
  validation?: ShortsPlanValidationResult;
};

export type ShortsLedgerMutationResult =
  | ShortsLedgerMutationSuccess
  | ShortsLedgerMutationFailure;

export type ShortsRestoreOptions = Omit<
  ShortsPlanValidationOptions,
  'activePlans' | 'rejectedPlans' | 'excludePlanId' | 'projection'
>;

function existingRangesInstruction(existingClips: Pick<ShortsClipPlan, 'start' | 'end' | 'title'>[] = []): string {
  const ranges = existingClips
    .filter((clip) => clip.start && clip.end)
    .map((clip, index) => {
      const title = clip.title?.trim() ? ` - ${clip.title.trim()}` : '';
      return `${index + 1}. ${clip.start} -> ${clip.end}${title}`;
    });
  if (ranges.length === 0) return '';

  const excludedWindows = existingClips
    .map((clip, index) => {
      const range = parsePlanRange(clip);
      if (!range) return '';
      const title = clip.title?.trim() ? ` - ${clip.title.trim()}` : '';
      return `${index + 1}. ${secondsToShortsTimestamp(Math.max(0, range.startSec - 15))} -> ${secondsToShortsTimestamp(range.endSec + 15)}${title}`;
    })
    .filter(Boolean);

  return [
    'Already selected ranges (including rejected plans):',
    ...ranges,
    'Do not choose moments that overlap any already selected range or rejected range.',
    '',
    'Excluded timeline windows (selected or rejected ranges plus 15 seconds of context on both sides):',
    ...excludedWindows,
    'Do not inspect, quote, continue, summarize, or select anything from the excluded timeline windows above.',
    'Find different, non-overlapping moments outside these windows.',
  ].join('\n');
}


export function validateShortsPlanSettings(
  minDurationSec: number,
  maxDurationSec: number
): ShortsSettingsValidationResult {
  const min = Number(minDurationSec);
  const max = Number(maxDurationSec);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return {
      ok: false,
      minDurationSec: min,
      maxDurationSec: max,
      reason: 'AI Shorts duration settings must be finite numbers.',
    };
  }
  if (min < 10 || max > 300 || min > max) {
    return {
      ok: false,
      minDurationSec: min,
      maxDurationSec: max,
      reason: 'AI Shorts duration settings must satisfy 10 <= min <= max <= 300 seconds.',
    };
  }
  return { ok: true, minDurationSec: min, maxDurationSec: max };
}

export function buildShortsPrompt(opts: ShortsPlanOptions): string {
  const settingsValidation = validateShortsPlanSettings(opts.minDurationSec, opts.maxDurationSec);
  if (!settingsValidation.ok) throw new Error(settingsValidation.reason);
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
  return parsed.map((item: Record<string, unknown> | null) => {
    const value = item && typeof item === 'object' ? item : {};
    const optionalText = (field: string): string | undefined => {
      const raw = value[field];
      return raw === undefined || raw === null ? undefined : String(raw);
    };
    return {
      start: value.start === undefined || value.start === null ? '' : String(value.start),
      end: value.end === undefined || value.end === null ? '' : String(value.end),
      title: value.title === undefined || value.title === null ? '' : String(value.title),
      summary: value.summary === undefined || value.summary === null ? '' : String(value.summary),
      hook: value.hook === undefined || value.hook === null ? '' : String(value.hook),
      category: value.category === undefined || value.category === null ? 'clip' : String(value.category),
      captionText: optionalText('captionText'),
      sourceTitle: optionalText('sourceTitle'),
      sourceSummary: optionalText('sourceSummary'),
      sourceHook: optionalText('sourceHook'),
      sourceCategory: optionalText('sourceCategory'),
      sourceCaptionText: optionalText('sourceCaptionText'),
      targetTitle: optionalText('targetTitle'),
      targetSummary: optionalText('targetSummary'),
      targetHook: optionalText('targetHook'),
      targetCategory: optionalText('targetCategory'),
      targetCaptionText: optionalText('targetCaptionText'),
    };
  });
}

const sharedShortsState = shortsStateShared as unknown as {
  normalizeShortsSessionState: (
    session: Record<string, unknown>,
    idFactory?: () => string
  ) => ShortsSessionState;
  parseShortsTimestamp: (timestamp: unknown) => ShortsTimestampParseResult;
  secondsToShortsTimestamp: (totalSeconds: number) => string;
  parseShortsPlanRange: (
    plan: Pick<ShortsClipPlan, 'start' | 'end'>
  ) => { startSec: number; endSec: number } | null;
  resolveShortsSourceDuration: (session: unknown) => number | null;
  validateShortsPlan: (
    plan: ShortsClipPlan,
    options?: ShortsPlanValidationOptions
  ) => ShortsPlanValidationResult;
  validateShortsPlanRestore: (
    plan: ShortsClipPlan,
    options?: Omit<ShortsPlanValidationOptions, 'excludePlanId' | 'projection'>
  ) => ShortsPlanValidationResult;
  sourceShortsPlanProjection: (plan: ShortsClipPlan) => ShortsPlanProjection;
  activeShortsPlanProjection: (plan: ShortsClipPlan, activeLanguage: unknown) => ShortsPlanProjection;
  shortsPlanProjection: (
    plan: ShortsClipPlan,
    projection: 'source' | 'target',
    activeLanguage: unknown
  ) => ShortsPlanProjection;
  shortsTranslationForLanguage: (
    plan: ShortsClipPlan,
    activeLanguage: unknown
  ) => { key: string; variant: ShortsClipTranslation } | null;
  collectShortsTranslationLanguages: (
    plans: ShortsClipPlan[],
    rejectedPlans: ShortsClipPlan[],
    activeLanguage: string | undefined,
    declaredLanguages: string[] | undefined
  ) => string[];
  upsertShortsPlanTranslation: (
    plan: ShortsClipPlan,
    activeLanguage: string | undefined,
    input: ShortsMetadataInput & Partial<Pick<ShortsClipTranslation, 'language' | 'provider' | 'updatedAt'>>
  ) => ShortsClipPlan;
  attachShortsPlanActiveTranslation: (
    plan: ShortsClipPlan,
    activeLanguage: string | undefined

  ) => ShortsClipPlan;
};
export const selectShortsSourceProjection = (
  plan: ShortsClipPlan
): ShortsPlanProjection => sharedShortsState.sourceShortsPlanProjection(plan);

export const selectShortsTargetProjection = (
  plan: ShortsClipPlan,
  activeLanguage: string | { activeTranslationLanguage?: string } | undefined
): ShortsPlanProjection => sharedShortsState.activeShortsPlanProjection(plan, activeLanguage);

export const selectShortsPlanProjection = (
  plan: ShortsClipPlan,
  projection: 'source' | 'target',
  activeLanguage: string | { activeTranslationLanguage?: string } | undefined
): ShortsPlanProjection => sharedShortsState.shortsPlanProjection(plan, projection, activeLanguage);

export const shortsTranslationForLanguage = sharedShortsState.shortsTranslationForLanguage;

export const collectAvailableShortsTranslationLanguages = (
  session: {
    shortsPlans?: ShortsClipPlan[];
    shortsRejectedPlans?: ShortsClipPlan[];
    activeTranslationLanguage?: string;
    availableTranslationLanguages?: string[];
  }
): string[] => sharedShortsState.collectShortsTranslationLanguages(
  session?.shortsPlans ?? [],
  session?.shortsRejectedPlans ?? [],
  session?.activeTranslationLanguage,
  session?.availableTranslationLanguages,
);

export const upsertShortsPlanTranslation = (
  plan: ShortsClipPlan,
  activeLanguage: string | undefined,
  input: ShortsMetadataInput & Partial<Pick<ShortsClipTranslation, 'language' | 'provider' | 'updatedAt'>>
): ShortsClipPlan => sharedShortsState.upsertShortsPlanTranslation(plan, activeLanguage, input);

export const attachShortsPlanActiveTranslation = (
  plan: ShortsClipPlan,
  activeLanguage: string | undefined
): ShortsClipPlan => sharedShortsState.attachShortsPlanActiveTranslation(plan, activeLanguage);

export function updateShortsPlanTargetMetadata(
  plan: ShortsClipPlan,
  activeLanguage: string | undefined,
  patch: Partial<ShortsClipPlan>
): ShortsClipPlan {
  const current = selectShortsTargetProjection(plan, activeLanguage);
  if (!activeLanguage || !isRealTranslationLanguage(activeLanguage)) return structuredClone(plan);
  const value = patch as Record<string, unknown>;
  const input: ShortsMetadataInput = {
    title: typeof value.targetTitle === 'string' ? value.targetTitle : typeof value.title === 'string' ? value.title : current.title,
    summary: typeof value.targetSummary === 'string' ? value.targetSummary : typeof value.summary === 'string' ? value.summary : current.summary,
    hook: typeof value.targetHook === 'string' ? value.targetHook : typeof value.hook === 'string' ? value.hook : current.hook,
  };
  if (typeof value.targetCategory === 'string') input.category = value.targetCategory;
  else if (typeof value.category === 'string') input.category = value.category;
  else if (current.category) input.category = current.category;
  if (typeof value.targetCaptionText === 'string') input.captionText = value.targetCaptionText;
  else if (typeof value.captionText === 'string') input.captionText = value.captionText;
  else if (current.captionText) input.captionText = current.captionText;
  const updated = upsertShortsPlanTranslation(plan, activeLanguage, input);
  return {
    ...updated,
    targetTitle: input.title,
    targetSummary: input.summary,
    targetHook: input.hook,
    ...(input.category !== undefined ? { targetCategory: input.category } : {}),
    ...(input.captionText !== undefined ? { targetCaptionText: input.captionText } : {}),
  };
}

export function projectShortsPlanForLanguage(
  plan: ShortsClipPlan,
  projection: 'source' | 'target',
  activeLanguage: string | { activeTranslationLanguage?: string } | undefined
): ShortsClipPlan {
  const selected = selectShortsPlanProjection(plan, projection, activeLanguage);
  return {
    ...plan,
    title: selected.title,
    summary: selected.summary,
    hook: selected.hook,
    category: selected.category,
    captionText: selected.captionText,
    ...(projection === 'source'
      ? {
          sourceTitle: selected.title,
          sourceSummary: selected.summary,
          sourceHook: selected.hook,
          sourceCategory: selected.category,
          sourceCaptionText: selected.captionText || undefined,
        }
      : {
          targetTitle: selected.title,
          targetSummary: selected.summary,
          targetHook: selected.hook,
          targetCategory: selected.category,
          targetCaptionText: selected.captionText || undefined,
        }),
  };
}

export function normalizeShortsCaptionText(value: unknown): string {
  return String(value ?? '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9\u00c0-\u024f\u0400-\u04ff]+/gi, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function shortsAlignmentMatchesCaption(
  segments: AlignedSubtitleSegment[] | undefined,
  captionText: string | undefined
): boolean {
  if (!Array.isArray(segments) || segments.length === 0 || !hasText(captionText)) return false;
  const alignedText = segments.map((segment) => segment.text || '').join(' ');
  return normalizeShortsCaptionText(alignedText) === normalizeShortsCaptionText(captionText);
}

export function parseShortsMetadataResponse(text: string): ShortsMetadataInput {
  const clean = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Shorts metadata response did not contain a JSON object.');
  const value = JSON.parse(clean.slice(start, end + 1));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Shorts metadata response was not an object.');
  }
  const field = (name: keyof ShortsMetadataInput): string => {
    const raw = (value as Record<string, unknown>)[name];
    return raw === undefined || raw === null ? '' : String(raw);
  };
  const result: ShortsMetadataInput = {
    title: field('title'),
    summary: field('summary'),
    hook: field('hook'),
  };
  if ((value as Record<string, unknown>).category !== undefined) result.category = field('category');
  if ((value as Record<string, unknown>).captionText !== undefined) result.captionText = field('captionText');
  return result;
}

/** Strict result API shared with Main; malformed input never becomes zero. */
export const parseShortsTimestamp = sharedShortsState.parseShortsTimestamp;


export const secondsToShortsTimestamp = sharedShortsState.secondsToShortsTimestamp;


function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function planID(plan: ShortsClipPlan): string {
  const value = (plan as unknown as Record<string, unknown>).stableID;
  if (typeof value === 'string' && value.trim()) return value;
  const legacy = (plan as unknown as Record<string, unknown>).id;
  return typeof legacy === 'string' && legacy.trim() ? legacy : '';
}

function parsePlanRange(
  plan: Pick<ShortsClipPlan, 'start' | 'end'>
): { startSec: number; endSec: number } | null {
  return sharedShortsState.parseShortsPlanRange(plan);
}

function canonicalRangeKey(plan: Pick<ShortsClipPlan, 'start' | 'end'>): string | null {
  const range = parsePlanRange(plan);
  return range ? `${range.startSec}:${range.endSec}` : null;
}

function ledgerPlanID(plan: ShortsClipPlan): string {
  return planID(plan).trim().toLowerCase();
}

function prepareShortsLedgerMutation(session: unknown): ShortsSessionState {
  const base = session !== null && typeof session === 'object' && !Array.isArray(session)
    ? session as Record<string, unknown>
    : {};
  const normalized = sharedShortsState.normalizeShortsSessionState(base);
  const newestByRange: ShortsClipPlan[] = [];
  for (const plan of normalized.shortsRejectedPlans) {
    const rangeKey = canonicalRangeKey(plan);
    if (rangeKey) {
      const previousIndex = newestByRange.findIndex((candidate) => canonicalRangeKey(candidate) === rangeKey);
      if (previousIndex >= 0) newestByRange.splice(previousIndex, 1);
    }
    newestByRange.push(plan);
  }
  return {
    ...normalized,
    shortsRejectedPlans: newestByRange.slice(-50),
  };
}

/**
 * Canonicalize the complete session before applying a rejected-ledger mutation.
 * The shared normalizer remains the sole identity/archive implementation;
 * this policy only applies the ledger's range replacement and size limit.
 */
export function applyShortsRejectedLedgerPolicy<T extends object>(
  session: T
): T & ShortsSessionState {
  return prepareShortsLedgerMutation(session) as T & ShortsSessionState;
}

export function shortsSelectionKey(
  stableID: string,
  language: ShortsDisplayLanguage
): ShortsSelectionKey {
  return `${stableID}:${language}` as ShortsSelectionKey;
}

export function shortsPlanExportLanguages(plan: ShortsClipPlan): ShortsDisplayLanguage[] {
  if (plan.languageMode === 'bilingual') return ['source', 'target'];
  return plan.languageMode === 'source' ? ['source'] : ['target'];
}

function ledgerFailure(
  code: string,
  message: string,
  validation?: ShortsPlanValidationResult
): ShortsLedgerMutationFailure {
  return {
    success: false,
    code,
    message,
    issues: validation?.issues ?? [],
    ...(validation ? { validation } : {}),
  };
}

export function removeShortsPlanToRejectedLedger(
  session: unknown,
  stableID: string
): ShortsLedgerMutationResult {
  const canonical = prepareShortsLedgerMutation(session);
  const targetID = String(stableID || '').trim().toLowerCase();
  const activeIndex = canonical.shortsPlans.findIndex((plan) => ledgerPlanID(plan) === targetID);
  if (!targetID || activeIndex < 0) {
    return ledgerFailure('PLAN_NOT_FOUND', `Shorts plan ${stableID || '(unknown)'} was not found.`);
  }

  const removed = canonical.shortsPlans[activeIndex];
  const removedRange = canonicalRangeKey(removed);
  const remainingRejected = canonical.shortsRejectedPlans.filter((plan) => {
    if (ledgerPlanID(plan) === targetID) return false;
    return !removedRange || canonicalRangeKey(plan) !== removedRange;
  });
  const next = prepareShortsLedgerMutation({
    ...canonical,
    shortsPlans: canonical.shortsPlans.filter((_, index) => index !== activeIndex),
    shortsRejectedPlans: [...remainingRejected, removed],
  });
  const stored = next.shortsRejectedPlans.find((plan) => ledgerPlanID(plan) === targetID);
  if (!stored) {
    return ledgerFailure('LEDGER_NORMALIZATION_FAILED', 'The removed Shorts plan could not be persisted in the rejected ledger.');
  }
  return { success: true, session: next, plan: stored };
}

export function restoreShortsPlanFromRejectedLedger(
  session: unknown,
  stableID: string,
  options: ShortsRestoreOptions = {}
): ShortsLedgerMutationResult {
  const canonical = prepareShortsLedgerMutation(session);
  const targetID = String(stableID || '').trim().toLowerCase();
  const rejectedIndex = canonical.shortsRejectedPlans.findIndex((plan) => ledgerPlanID(plan) === targetID);
  if (!targetID || rejectedIndex < 0) {
    return ledgerFailure('PLAN_NOT_FOUND', `Rejected Shorts plan ${stableID || '(unknown)'} was not found.`);
  }

  const restoredCandidate = canonical.shortsRejectedPlans[rejectedIndex];
  const remainingRejected = canonical.shortsRejectedPlans.filter((_, index) => index !== rejectedIndex);
  const validation = validateShortsPlanRestore(restoredCandidate, {
    ...options,
    session: options.session ?? canonical,
    activePlans: canonical.shortsPlans,
    rejectedPlans: remainingRejected,
  });
  if (!validation.valid) {
    return ledgerFailure(validation.issues.find((issue) => issue.severity === 'error')?.code || 'INVALID_RANGE', validation.issues.find((issue) => issue.severity === 'error')?.message || 'Rejected Shorts plan cannot be restored.', validation);
  }
  if (canonical.shortsPlans.some((plan) => ledgerPlanID(plan) === targetID)) {
    return ledgerFailure('DUPLICATE_PLAN_ID', `Shorts plan ${stableID} already exists among active plans.`, validation);
  }

  const next = prepareShortsLedgerMutation({
    ...canonical,
    shortsPlans: [...canonical.shortsPlans, restoredCandidate],
    shortsRejectedPlans: remainingRejected,
  });
  const restored = next.shortsPlans.find((plan) => ledgerPlanID(plan) === targetID);
  if (!restored) {
    return ledgerFailure('LEDGER_NORMALIZATION_FAILED', 'The rejected Shorts plan could not be restored with its stable identity.', validation);
  }
  return { success: true, session: next, plan: restored };
}

export function sortShortsSelectionKeys(
  keys: Iterable<ShortsSelectionKey>
): ShortsSelectionKey[] {
  return Array.from(keys).sort((left, right) => {
    const leftSeparator = left.lastIndexOf(':');
    const rightSeparator = right.lastIndexOf(':');
    const leftID = left.slice(0, leftSeparator);
    const rightID = right.slice(0, rightSeparator);
    if (leftID < rightID) return -1;
    if (leftID > rightID) return 1;
    const leftLanguage = left.slice(leftSeparator + 1);
    const rightLanguage = right.slice(rightSeparator + 1);
    return leftLanguage < rightLanguage ? -1 : leftLanguage > rightLanguage ? 1 : 0;
  });
}

export function resolveShortsSourceDuration(session: unknown): number | null {
  return sharedShortsState.resolveShortsSourceDuration(session);
}

function inferProjection(plan: ShortsClipPlan): 'source' | 'target' {
  return plan.languageMode === 'target' || plan.languageMode === 'bilingual' ? 'target' : 'source';
}

export function validateShortsPlan(
  plan: ShortsClipPlan,
  options: ShortsPlanValidationOptions = {}
): ShortsPlanValidationResult {
  return sharedShortsState.validateShortsPlan(plan, options);
}

export function validateShortsPlanRestore(
  plan: ShortsClipPlan,
  options: Omit<ShortsPlanValidationOptions, 'excludePlanId' | 'projection'> = {}
): ShortsPlanValidationResult {
  return sharedShortsState.validateShortsPlanRestore(plan, options);
}

export function validateShortsExportSelection(
  units: ShortsExportSelection[],
  options: Omit<ShortsPlanValidationOptions, 'projection'> = {}
): ShortsExportPreflightResult {
  const results = units.map(({ plan, language }) => validateShortsPlan(plan, {
    ...options,
    projection: language,
  }));
  return {
    valid: results.every((result) => result.valid),
    results,
    issues: results.flatMap((result) => result.issues),
  };
}

export class ShortsValidationError extends Error {
  readonly validation: ShortsPlanValidationResult;
  readonly code: string;
  readonly issues: ShortsValidationIssue[];

  constructor(validation: ShortsPlanValidationResult) {
    const firstError = validation.issues.find((issue) => issue.severity === 'error');
    super(firstError?.message || 'Shorts plan validation failed.');
    this.name = 'ShortsValidationError';
    this.validation = validation;
    this.code = firstError?.code || 'INVALID_RANGE';
    this.issues = validation.issues;
  }
}

function mutationFailure<T>(validation: ShortsPlanValidationResult): ShortsMutationResult<T> {
  const firstError = validation.issues.find((issue) => issue.severity === 'error');
  return {
    success: false,
    validation,
    code: firstError?.code || 'INVALID_RANGE',
    message: firstError?.message || 'Shorts plan validation failed.',
    issues: validation.issues,
  };
}
function clearReplacedRange(plan: ShortsClipPlan, start: string, end: string): ShortsClipPlan {
  return {
    ...plan,
    start,
    end,
    captionText: undefined,
    sourceCaptionText: undefined,
    targetCaptionText: undefined,
    sourceAlignment: undefined,
    targetAlignment: undefined,
    timelineCuts: [],
    timelineTrim: { trimStartSec: 0, trimEndSec: 0 },
  };
}

export function replaceShortsPlanRangeChecked(
  plan: ShortsClipPlan,
  startTimestamp: string,
  endTimestamp: string,
  options: ShortsPlanValidationOptions = {}
): ShortsMutationResult<ShortsClipPlan> {
  const start = parseShortsTimestamp(startTimestamp);
  const end = parseShortsTimestamp(endTimestamp);
  const candidate = {
    ...plan,
    start: start.ok && start.canonical !== null ? start.canonical : startTimestamp,
    end: end.ok && end.canonical !== null ? end.canonical : endTimestamp,
    timelineCuts: [],
  };
  const validation = validateShortsPlan(candidate, {
    ...options,
    projection: options.projection ?? inferProjection(plan),
    excludePlanId: options.excludePlanId ?? planID(plan),
  });
  if (!validation.valid) return mutationFailure(validation);
  return { success: true, value: clearReplacedRange(candidate, candidate.start, candidate.end), validation };
}

export function appendNonOverlappingShortsPlans(
  existingPlans: ShortsClipPlan[],
  incomingPlans: ShortsClipPlan[],
  minOverlapSecOrOptions: number | AppendShortsPlansOptions = 1,
  suppliedOptions: AppendShortsPlansOptions = {}
): AppendShortsPlansResult {
  const options = typeof minOverlapSecOrOptions === 'number' ? suppliedOptions : minOverlapSecOrOptions;
  const threshold = typeof minOverlapSecOrOptions === 'number'
    ? minOverlapSecOrOptions
    : (options.overlapThresholdSec ?? 1);
  const plans = [...existingPlans];
  const configuredActivePlans = options.activePlans ?? [];
  const addedIndexes: number[] = [];
  const skippedOverlapping: ShortsClipPlan[] = [];
  const rejectedPlans = [...(options.rejectedPlans ?? []), ...(options.excludedPlans ?? [])];

  for (const incoming of incomingPlans) {
    const validation = validateShortsPlan(incoming, {
      ...options,
      activePlans: configuredActivePlans.length > 0 ? [...configuredActivePlans, ...plans] : plans,
      rejectedPlans,
      overlapThresholdSec: threshold,
    });
    if (!validation.valid) {
      if (validation.issues.some((issue) => issue.code === 'OVERLAP_ACTIVE' || issue.code === 'OVERLAP_REJECTED')) {
        skippedOverlapping.push(incoming);
      }
      continue;
    }
    const canonicalIncoming = validation.startSec !== null && validation.endSec !== null
      ? {
          ...incoming,
          start: secondsToShortsTimestamp(validation.startSec),
          end: secondsToShortsTimestamp(validation.endSec),
        }
      : incoming;
    addedIndexes.push(plans.length);
    plans.push(canonicalIncoming);
  }

  return { plans, addedIndexes, skippedOverlapping };
}

export function replaceShortsPlanRange(
  plan: ShortsClipPlan,
  startTimestamp: string,
  endTimestamp: string
): ShortsClipPlan {
  const result = replaceShortsPlanRangeChecked(plan, startTimestamp, endTimestamp);
  if (!result.success) throw new ShortsValidationError(result.validation);
  return result.value;
}
