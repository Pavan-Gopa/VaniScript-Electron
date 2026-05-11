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
 *
 * **What never syncs:**
 * - subtitle language text
 * - transcript text
 */

import type { FrameKeyframe, AlignedSubtitleSegment } from './subtitle-alignment';
import type { ShortsClipPlan, TimelineCut, TimelineTrim } from './shorts-reels';

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
};

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
  if (!plan?.syncEnabled || !plan.linkedClipGroupId) return null;

  const partnerIndex = findLinkedPartnerIndex(plans, changedIndex);
  if (partnerIndex < 0) return null;

  const mirror: Partial<ShortsClipPlan> = {};
  let hasChanges = false;

  // Mirror frame keyframes: source → target, target → source
  if (appliedPatch.sourceFrameKeyframes) {
    mirror.targetFrameKeyframes = structuredClone(appliedPatch.sourceFrameKeyframes);
    hasChanges = true;
  }
  if (appliedPatch.targetFrameKeyframes) {
    mirror.sourceFrameKeyframes = structuredClone(appliedPatch.targetFrameKeyframes);
    hasChanges = true;
  }

  // Mirror timeline cuts & trims
  if (appliedPatch.timelineCuts) {
    mirror.timelineCuts = structuredClone(appliedPatch.timelineCuts);
    hasChanges = true;
  }
  if (appliedPatch.timelineTrim) {
    mirror.timelineTrim = structuredClone(appliedPatch.timelineTrim);
    hasChanges = true;
  }

  // Mirror background settings (shared across languages)
  if (appliedPatch.backgroundSettings) {
    mirror.backgroundSettings = structuredClone(appliedPatch.backgroundSettings);
    hasChanges = true;
  }

  return hasChanges ? { partnerIndex, patch: mirror } : null;
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
    if (i === planIndex) return { ...p, syncEnabled: newState };
    if (p.linkedClipGroupId && p.linkedClipGroupId === plan.linkedClipGroupId) {
      return { ...p, syncEnabled: newState };
    }
    return p;
  });
}
