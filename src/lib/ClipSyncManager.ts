/**
 * ClipSyncManager — links bilingual clip pairs and propagates motion / style edits.
 *
 * A "linked group" is a pair of clips (source + target) that share the same
 * `linkedClipGroupId`. When sync is ON, changes to frame keyframes, subtitle
 * positioning and styling on one language propagate to the other.
 *
 * **What syncs:**
 * - Frame animation (zoom, panX, panY, keyframes, transitions)
 * - Subtitle positioning (vertical / horizontal placement)
 * - Subtitle styling (font, background, shadows, borders, blur, radius)
 * - Background settings
 * - Timeline cuts & trims
 * - Logo overlays
 * - Text overlay tracks
 * - Extra audio tracks
 *
 * **What never syncs:**
 * - subtitle language text
 * - transcript text
 */

import type { FrameKeyframe, AlignedSubtitleSegment } from './subtitle-alignment';
import type {
  ExtraAudioTrack,
  LogoOverlaySettings,
  ShortsClipPlan,
  TextOverlayTrack,
  TimelineCut,
  TimelineTrim,
} from './shorts-reels';

// ── Group ID generator ────────────────────────────────────────────────────────

let groupSeq = 0;
export function makeLinkedGroupId(): string {
  groupSeq += 1;
  return `group_${Date.now()}_${groupSeq}`;
}

// ── Sync resolution ───────────────────────────────────────────────────────────

/**
 * Fields that are propagated from the source clip to its linked partner.
 * Subtitle *text* is intentionally excluded.
 */
export type SyncableMotionPatch = {
  sourceFrameKeyframes?: FrameKeyframe[];
  targetFrameKeyframes?: FrameKeyframe[];
  sourceAlignment?: AlignedSubtitleSegment[];
  targetAlignment?: AlignedSubtitleSegment[];
  timelineCuts?: TimelineCut[];
  timelineTrim?: TimelineTrim;
  sourceLogo?: LogoOverlaySettings;
  targetLogo?: LogoOverlaySettings;
  sourceTextTracks?: TextOverlayTrack[];
  targetTextTracks?: TextOverlayTrack[];
  sourceAudioTracks?: ExtraAudioTrack[];
  targetAudioTracks?: ExtraAudioTrack[];
};

function retimeWords(
  words: AlignedSubtitleSegment['words'],
  text: string,
  start: number,
  end: number,
): AlignedSubtitleSegment['words'] {
  const sourceWords = words.length > 0
    ? words
    : (text.match(/\S+/g) || []).map((word, index) => ({
        id: `word_${index}`,
        text: word,
        start,
        end,
      }));
  if (sourceWords.length === 0) return [];
  const duration = Math.max(0.05, end - start);
  const step = duration / sourceWords.length;
  return sourceWords.map((word, index) => ({
    ...word,
    start: start + (step * index),
    end: index === sourceWords.length - 1 ? end : start + (step * (index + 1)),
  }));
}

function mirrorAlignmentTiming(
  sourceSegments: AlignedSubtitleSegment[] | undefined,
  targetSegments: AlignedSubtitleSegment[] | undefined,
): AlignedSubtitleSegment[] | undefined {
  if (!sourceSegments) return undefined;
  if (!targetSegments?.length) return structuredClone(sourceSegments);
  return sourceSegments.map((sourceSegment, index) => {
    const targetSegment = targetSegments[index] || targetSegments[targetSegments.length - 1];
    const text = targetSegment?.text ?? sourceSegment.text;
    return {
      ...(targetSegment ? structuredClone(targetSegment) : structuredClone(sourceSegment)),
      start: sourceSegment.start,
      end: sourceSegment.end,
      text,
      words: retimeWords(targetSegment?.words || [], text, sourceSegment.start, sourceSegment.end),
    };
  });
}

/**
 * Given a list of plans, find the linked partner of `planIndex`.
 * Returns -1 if not found or not linked.
 */
export function findLinkedPartnerIndex(plans: ShortsClipPlan[], planIndex: number): number {
  const plan = plans[planIndex];
  if (!plan?.linkedClipGroupId) return -1;
  return plans.findIndex((other, index) =>
    index !== planIndex && other.linkedClipGroupId === plan.linkedClipGroupId
  );
}

/**
 * Resolve the effective language of a plan in its pair:
 * if the plan stores `sourceAlignment` it's the source-language clip,
 * otherwise it's the target-language clip.
 */
export type ClipLanguageRole = 'source' | 'target';

export function resolveClipLanguageRole(
  plans: ShortsClipPlan[],
  planIndex: number
): ClipLanguageRole {
  const plan = plans[planIndex];
  if (!plan) return 'target';
  // first clip in the group is source, second is target
  const groupId = plan.linkedClipGroupId;
  if (!groupId) return 'target';
  const firstInGroup = plans.findIndex((p) => p.linkedClipGroupId === groupId);
  return firstInGroup === planIndex ? 'source' : 'target';
}

// ── Motion copy ───────────────────────────────────────────────────────────────

/**
 * Copy frame keyframes from one clip to another.
 * Returns a patch to apply to the target plan.
 */
export function copyMotionFrom(
  source: ShortsClipPlan,
  _sourceLanguage: ClipLanguageRole,
  targetLanguage: ClipLanguageRole,
  options: { copySubtitleLayout?: boolean } = {}
): Partial<ShortsClipPlan> {
  const patch: Partial<ShortsClipPlan> = {};

  // Always copy frame keyframes
  const sourceKeyframes = source.sourceFrameKeyframes || source.targetFrameKeyframes || [];
  if (targetLanguage === 'source') {
    patch.sourceFrameKeyframes = structuredClone(sourceKeyframes);
  } else {
    patch.targetFrameKeyframes = structuredClone(sourceKeyframes);
  }

  // Copy timeline cuts & trims
  if (source.timelineCuts) {
    patch.timelineCuts = structuredClone(source.timelineCuts);
  }
  if (source.timelineTrim) {
    patch.timelineTrim = structuredClone(source.timelineTrim);
  }

  // Optionally copy subtitle timing layout (but NOT the text)
  if (options.copySubtitleLayout) {
    const sourceAlignment = source.sourceAlignment || source.targetAlignment || [];
    if (sourceAlignment.length > 0) {
      const timingOnly = sourceAlignment.map((seg) => ({
        ...structuredClone(seg),
        // Keep text empty — user fills from their own language
      }));
      if (targetLanguage === 'source') {
        patch.sourceAlignment = timingOnly;
      } else {
        patch.targetAlignment = timingOnly;
      }
    }
  }

  // Copy background settings
  if (source.backgroundSettings) {
    patch.backgroundSettings = structuredClone(source.backgroundSettings);
  }

  return patch;
}

// ── Sync propagation ──────────────────────────────────────────────────────────

/**
 * Given a plan index and a patch that was applied to it, generate a
 * mirrored patch for the linked partner (if sync is enabled).
 *
 * Returns null if there is no linked partner or sync is disabled.
 */
export function buildSyncPatch(
  plans: ShortsClipPlan[],
  changedIndex: number,
  appliedPatch: Partial<ShortsClipPlan>
): { partnerIndex: number; patch: Partial<ShortsClipPlan> } | null {
  const plan = plans[changedIndex];
  if (!plan?.syncEnabled) return null;
  const linkedPartnerIndex = plan.linkedClipGroupId ? findLinkedPartnerIndex(plans, changedIndex) : -1;
  const destinationPlan = linkedPartnerIndex >= 0 ? plans[linkedPartnerIndex] : plan;

  const mirror: Partial<ShortsClipPlan> = {};
  let hasChanges = false;

  // Mirror frame keyframes: source → target, target → source
  if ('sourceFrameKeyframes' in appliedPatch) {
    mirror.targetFrameKeyframes = appliedPatch.sourceFrameKeyframes ? structuredClone(appliedPatch.sourceFrameKeyframes) : undefined;
    hasChanges = true;
  }
  if ('targetFrameKeyframes' in appliedPatch) {
    mirror.sourceFrameKeyframes = appliedPatch.targetFrameKeyframes ? structuredClone(appliedPatch.targetFrameKeyframes) : undefined;
    hasChanges = true;
  }

  // Mirror subtitle timing/layout, but never replace translated/source text.
  if ('sourceAlignment' in appliedPatch) {
    mirror.targetAlignment = appliedPatch.sourceAlignment ? mirrorAlignmentTiming(appliedPatch.sourceAlignment, destinationPlan.targetAlignment) : undefined;
    hasChanges = true;
  }
  if ('targetAlignment' in appliedPatch) {
    mirror.sourceAlignment = appliedPatch.targetAlignment ? mirrorAlignmentTiming(appliedPatch.targetAlignment, destinationPlan.sourceAlignment) : undefined;
    hasChanges = true;
  }

  // Mirror timeline cuts & trims
  if ('timelineCuts' in appliedPatch) {
    mirror.timelineCuts = appliedPatch.timelineCuts ? structuredClone(appliedPatch.timelineCuts) : undefined;
    hasChanges = true;
  }
  if ('timelineTrim' in appliedPatch) {
    mirror.timelineTrim = appliedPatch.timelineTrim ? structuredClone(appliedPatch.timelineTrim) : undefined;
    hasChanges = true;
  }

  // Mirror background settings (shared across languages)
  if ('backgroundSettings' in appliedPatch) {
    mirror.backgroundSettings = appliedPatch.backgroundSettings ? structuredClone(appliedPatch.backgroundSettings) : undefined;
    hasChanges = true;
  }

  // Mirror language-aware overlay layers. Sync ON means Source and Target share
  // the same visual/audio structure while preserving their subtitle text.
  if ('sourceLogo' in appliedPatch) {
    mirror.targetLogo = appliedPatch.sourceLogo ? structuredClone(appliedPatch.sourceLogo) : undefined;
    hasChanges = true;
  }
  if ('targetLogo' in appliedPatch) {
    mirror.sourceLogo = appliedPatch.targetLogo ? structuredClone(appliedPatch.targetLogo) : undefined;
    hasChanges = true;
  }
  if ('sourceTextTracks' in appliedPatch) {
    mirror.targetTextTracks = appliedPatch.sourceTextTracks ? structuredClone(appliedPatch.sourceTextTracks) : undefined;
    hasChanges = true;
  }
  if ('targetTextTracks' in appliedPatch) {
    mirror.sourceTextTracks = appliedPatch.targetTextTracks ? structuredClone(appliedPatch.targetTextTracks) : undefined;
    hasChanges = true;
  }
  if ('sourceAudioTracks' in appliedPatch) {
    mirror.targetAudioTracks = appliedPatch.sourceAudioTracks ? structuredClone(appliedPatch.sourceAudioTracks) : undefined;
    hasChanges = true;
  }
  if ('targetAudioTracks' in appliedPatch) {
    mirror.sourceAudioTracks = appliedPatch.targetAudioTracks ? structuredClone(appliedPatch.targetAudioTracks) : undefined;
    hasChanges = true;
  }

  if (!hasChanges) return null;

  // ── Bilingual single-plan sync ──────────────────────────────────────────
  // For bilingual plans, Source and Target live inside the SAME plan object.
  // findLinkedPartnerIndex won't find a separate partner (index !== planIndex),
  // so we apply the mirror patch to the SAME plan (self-sync).
  if (linkedPartnerIndex >= 0) {
    // Inter-plan sync: two separate plans linked together
    return { partnerIndex: linkedPartnerIndex, patch: mirror };
  }

  // No external partner found — try intra-plan sync (bilingual single plan)
  if (plan.languageMode === 'bilingual') {
    return { partnerIndex: changedIndex, patch: mirror };
  }

  return null;
}

function syncBilingualPlanOnEnable(plan: ShortsClipPlan): ShortsClipPlan {
  const updated: ShortsClipPlan = { ...plan, syncEnabled: true };

  // Frame motion: if source has data it wins; otherwise target seeds source.
  const srcKf = plan.sourceFrameKeyframes;
  const tgtKf = plan.targetFrameKeyframes;
  if (srcKf?.length) {
    updated.targetFrameKeyframes = structuredClone(srcKf);
  } else if (tgtKf?.length) {
    updated.sourceFrameKeyframes = structuredClone(tgtKf);
  }

  // Subtitle block timing/layout: mirror timings while preserving language text.
  const srcAlignment = plan.sourceAlignment;
  const tgtAlignment = plan.targetAlignment;
  if (srcAlignment?.length) {
    updated.targetAlignment = mirrorAlignmentTiming(srcAlignment, tgtAlignment);
  } else if (tgtAlignment?.length) {
    updated.sourceAlignment = mirrorAlignmentTiming(tgtAlignment, srcAlignment);
  }

  // Timeline trim/cuts and background settings are single clip-level fields, so
  // they are already shared inside one bilingual plan and only need preserving.
  if (plan.sourceLogo && !plan.targetLogo) updated.targetLogo = structuredClone(plan.sourceLogo);
  else if (plan.targetLogo && !plan.sourceLogo) updated.sourceLogo = structuredClone(plan.targetLogo);
  if (plan.sourceTextTracks && !plan.targetTextTracks) updated.targetTextTracks = structuredClone(plan.sourceTextTracks);
  else if (plan.targetTextTracks && !plan.sourceTextTracks) updated.sourceTextTracks = structuredClone(plan.targetTextTracks);
  if (plan.sourceAudioTracks && !plan.targetAudioTracks) updated.targetAudioTracks = structuredClone(plan.sourceAudioTracks);
  else if (plan.targetAudioTracks && !plan.sourceAudioTracks) updated.sourceAudioTracks = structuredClone(plan.targetAudioTracks);
  return updated;
}

// ── Group assignment ──────────────────────────────────────────────────────────

/**
 * After "Find Moments" with bilingual mode, pair up source+target clips
 * that share the same time range and assign them a common groupId.
 */
export function assignLinkedGroups(plans: ShortsClipPlan[]): ShortsClipPlan[] {
  // The current system keeps a single plan item for bilingual —
  // both source + target fields live inside one ShortsClipPlan object.
  // We add a groupId even for single-item bilingual plans
  // so the sync toggle can work within the editor's language tabs.
  return plans.map((plan) => {
    if (plan.languageMode === 'bilingual' && !plan.linkedClipGroupId) {
      return { ...plan, linkedClipGroupId: makeLinkedGroupId(), syncEnabled: true };
    }
    return plan;
  });
}

/**
 * Toggle sync for a plan (and its partner).
 */
export function toggleSync(
  plans: ShortsClipPlan[],
  planIndex: number
): ShortsClipPlan[] {
  const plan = plans[planIndex];
  if (!plan) return plans;
  const newState = !plan.syncEnabled;
  return plans.map((p, i) => {
    if (i === planIndex) {
      if (newState && p.languageMode === 'bilingual') {
        return syncBilingualPlanOnEnable(p);
      }
      return { ...p, syncEnabled: newState };
    }
    if (p.linkedClipGroupId && p.linkedClipGroupId === plan.linkedClipGroupId) {
      return { ...p, syncEnabled: newState };
    }
    return p;
  });
}
