/**
 * TimelineCutEngine — Non-destructive razor tool, ripple delete, and subtitle retiming.
 *
 * All operations work on in-memory data structures (TimelineCut[], TimelineTrim,
 * AlignedSubtitleSegment[]). No FFmpeg is invoked until final export.
 *
 * ## Concepts
 *
 * **TimelineCut**: A region [startSec, endSec] removed from the clip.
 *                  Multiple cuts are stored sorted and non-overlapping.
 *
 * **TimelineTrim**: Edge trim — seconds removed from the start/end edges.
 *
 * **Ripple delete**: After removing a section, all subsequent timestamps
 *                    shift backwards by the removed duration.
 *
 * **Subtitle boundary**: When a cut overlaps a subtitle cue, the engine
 *                         detects the overlap type (full, partial-start,
 *                         partial-end, split) for user resolution.
 */

import type { AlignedSubtitleSegment } from './subtitle-alignment';
import type { TimelineCut, TimelineTrim } from './shorts-reels';

export type { TimelineCut, TimelineTrim };

// ── Cut management ────────────────────────────────────────────────────────────

/**
 * Add a cut to the cut list. Merges overlapping/adjacent cuts.
 * Returns a new sorted, non-overlapping array.
 */
export function addCut(
  existing: TimelineCut[],
  newCut: TimelineCut,
  clipDurationSec: number
): TimelineCut[] {
  const cut: TimelineCut = {
    startSec: Math.max(0, newCut.startSec),
    endSec: Math.min(clipDurationSec, newCut.endSec),
  };
  if (cut.endSec <= cut.startSec) return existing;

  const all = [...existing, cut].sort((a, b) => a.startSec - b.startSec);
  const merged: TimelineCut[] = [];

  for (const item of all) {
    const last = merged[merged.length - 1];
    if (last && item.startSec <= last.endSec + 0.01) {
      last.endSec = Math.max(last.endSec, item.endSec);
    } else {
      merged.push({ ...item });
    }
  }

  return merged;
}

/**
 * Remove a cut by index.
 */
export function removeCut(existing: TimelineCut[], index: number): TimelineCut[] {
  return existing.filter((_, i) => i !== index);
}

/**
 * Total seconds removed by all cuts.
 */
export function totalCutDuration(cuts: TimelineCut[]): number {
  return cuts.reduce((sum, cut) => sum + Math.max(0, cut.endSec - cut.startSec), 0);
}

// ── Trim management ───────────────────────────────────────────────────────────

export function applyTrim(
  trim: TimelineTrim | undefined,
  trimStartSec: number,
  trimEndSec: number,
  clipDurationSec: number
): TimelineTrim {
  return {
    trimStartSec: Math.max(0, Math.min(clipDurationSec * 0.9, trimStartSec)),
    trimEndSec: Math.max(0, Math.min(clipDurationSec * 0.9, trimEndSec)),
  };
}

/**
 * Effective clip duration after trims and cuts.
 */
export function effectiveDuration(
  clipDurationSec: number,
  cuts: TimelineCut[],
  trim: TimelineTrim | undefined
): number {
  const trimmed = (trim?.trimStartSec || 0) + (trim?.trimEndSec || 0);
  return Math.max(0, clipDurationSec - trimmed - totalCutDuration(cuts));
}

// ── Ripple-adjusted time mapping ──────────────────────────────────────────────

/**
 * Map a "source" time (in the original clip) to the "output" time
 * (after all cuts are removed and the timeline is ripple-closed).
 *
 * Returns -1 if the time falls inside a cut.
 */
export function sourceToOutputTime(
  sourceSec: number,
  cuts: TimelineCut[],
  trim: TimelineTrim | undefined
): number {
  const trimStart = trim?.trimStartSec || 0;
  const adjusted = sourceSec - trimStart;
  if (adjusted < 0) return -1;

  let offset = 0;
  for (const cut of cuts) {
    const cutStart = cut.startSec - trimStart;
    const cutEnd = cut.endSec - trimStart;
    if (adjusted >= cutStart && adjusted <= cutEnd) return -1; // inside a cut
    if (adjusted > cutEnd) offset += Math.max(0, cut.endSec - cut.startSec);
  }

  return Math.max(0, adjusted - offset);
}

/**
 * Map an "output" time back to the original source time.
 */
export function outputToSourceTime(
  outputSec: number,
  cuts: TimelineCut[],
  trim: TimelineTrim | undefined
): number {
  const trimStart = trim?.trimStartSec || 0;
  let accumulated = 0;
  let sourceSec = outputSec + trimStart;

  for (const cut of cuts) {
    if (sourceSec + accumulated >= cut.startSec) {
      accumulated += Math.max(0, cut.endSec - cut.startSec);
    }
  }

  return sourceSec + accumulated;
}

// ── Subtitle retiming after cuts ──────────────────────────────────────────────

export type SubtitleOverlapKind =
  | 'none'         // subtitle is fully outside the cut
  | 'inside'       // subtitle is fully inside the cut → delete
  | 'overlap-start' // cut removes the beginning of the subtitle
  | 'overlap-end'   // cut removes the end of the subtitle
  | 'split';         // cut splits the subtitle into two parts

/**
 * Detect how a subtitle segment overlaps with a cut region.
 */
export function detectOverlap(
  segment: { start: number; end: number },
  cut: TimelineCut
): SubtitleOverlapKind {
  if (segment.end <= cut.startSec || segment.start >= cut.endSec) return 'none';
  if (segment.start >= cut.startSec && segment.end <= cut.endSec) return 'inside';
  if (segment.start < cut.startSec && segment.end > cut.endSec) return 'split';
  if (segment.start < cut.startSec) return 'overlap-end';
  return 'overlap-start';
}

export type BoundaryResolution = 'trim' | 'split' | 'delete';

/**
 * Apply a single cut to a subtitle segment list with automatic resolution.
 * After the cut, all subsequent subtitles shift backwards (ripple).
 *
 * @param resolution How to handle partially overlapping subtitles:
 *   - 'trim': truncate the subtitle at the cut boundary
 *   - 'split': split the subtitle into two parts
 *   - 'delete': remove any overlapping subtitle entirely
 */
export function retimeSubtitlesAfterCut(
  segments: AlignedSubtitleSegment[],
  cut: TimelineCut,
  clipDurationSec: number,
  resolution: BoundaryResolution = 'trim'
): AlignedSubtitleSegment[] {
  const cutDuration = cut.endSec - cut.startSec;
  if (cutDuration <= 0) return segments;

  const result: AlignedSubtitleSegment[] = [];

  for (const seg of segments) {
    const overlap = detectOverlap(seg, cut);

    switch (overlap) {
      case 'none': {
        // If segment is after the cut, shift it back
        if (seg.start >= cut.endSec) {
          result.push({
            ...seg,
            start: seg.start - cutDuration,
            end: seg.end - cutDuration,
            words: seg.words.map((w) => ({
              ...w,
              start: w.start - cutDuration,
              end: w.end - cutDuration,
            })),
          });
        } else {
          result.push(seg);
        }
        break;
      }

      case 'inside': {
        // Fully inside cut — always remove
        break;
      }

      case 'overlap-start': {
        // Cut removes the beginning of the subtitle
        if (resolution === 'delete') break;
        // Trim: keep only the part after the cut
        const newStart = cut.endSec - cutDuration; // ripple-adjusted
        result.push({
          ...seg,
          start: newStart,
          end: seg.end - cutDuration,
          words: seg.words
            .filter((w) => w.end > cut.endSec)
            .map((w) => ({
              ...w,
              start: Math.max(newStart, w.start - cutDuration),
              end: w.end - cutDuration,
            })),
        });
        break;
      }

      case 'overlap-end': {
        // Cut removes the end of the subtitle
        if (resolution === 'delete') break;
        result.push({
          ...seg,
          end: cut.startSec,
          words: seg.words
            .filter((w) => w.start < cut.startSec)
            .map((w) => ({
              ...w,
              end: Math.min(cut.startSec, w.end),
            })),
        });
        break;
      }

      case 'split': {
        if (resolution === 'delete') break;
        if (resolution === 'trim') {
          // Keep only the part before the cut (simpler)
          result.push({
            ...seg,
            end: cut.startSec,
            words: seg.words
              .filter((w) => w.start < cut.startSec)
              .map((w) => ({ ...w, end: Math.min(cut.startSec, w.end) })),
          });
          // And the part after the cut
          const afterStart = cut.endSec - cutDuration;
          result.push({
            ...seg,
            id: `${seg.id}_split`,
            start: afterStart,
            end: seg.end - cutDuration,
            words: seg.words
              .filter((w) => w.end > cut.endSec)
              .map((w) => ({
                ...w,
                start: Math.max(afterStart, w.start - cutDuration),
                end: w.end - cutDuration,
              })),
          });
          break;
        }
        // resolution === 'split' — same as trim above but intentional
        result.push({
          ...seg,
          end: cut.startSec,
          words: seg.words
            .filter((w) => w.start < cut.startSec)
            .map((w) => ({ ...w, end: Math.min(cut.startSec, w.end) })),
        });
        const splitAfterStart = cut.endSec - cutDuration;
        result.push({
          ...seg,
          id: `${seg.id}_split`,
          start: splitAfterStart,
          end: seg.end - cutDuration,
          words: seg.words
            .filter((w) => w.end > cut.endSec)
            .map((w) => ({
              ...w,
              start: Math.max(splitAfterStart, w.start - cutDuration),
              end: w.end - cutDuration,
            })),
        });
        break;
      }
    }
  }

  return result
    .filter((seg) => seg.end > seg.start + 0.01)
    .sort((a, b) => a.start - b.start);
}

/**
 * Apply edge trim to subtitles — removes subtitles outside the trim window
 * and adjusts timestamps.
 */
export function retimeSubtitlesAfterTrim(
  segments: AlignedSubtitleSegment[],
  trim: TimelineTrim,
  clipDurationSec: number
): AlignedSubtitleSegment[] {
  const effectiveEnd = clipDurationSec - trim.trimEndSec;
  return segments
    .filter((seg) => seg.end > trim.trimStartSec && seg.start < effectiveEnd)
    .map((seg) => ({
      ...seg,
      start: Math.max(0, seg.start - trim.trimStartSec),
      end: Math.min(effectiveEnd - trim.trimStartSec, seg.end - trim.trimStartSec),
      words: seg.words.map((w) => ({
        ...w,
        start: Math.max(0, w.start - trim.trimStartSec),
        end: Math.min(effectiveEnd - trim.trimStartSec, w.end - trim.trimStartSec),
      })),
    }))
    .filter((seg) => seg.end > seg.start + 0.01);
}

// ── Frame keyframe retiming after cuts ────────────────────────────────────────

import type { FrameKeyframe } from './subtitle-alignment';

/**
 * Retime frame keyframes after a cut — remove keyframes inside the cut
 * and shift subsequent ones backwards.
 */
export function retimeKeyframesAfterCut(
  keyframes: FrameKeyframe[],
  cut: TimelineCut
): FrameKeyframe[] {
  const cutDuration = cut.endSec - cut.startSec;
  if (cutDuration <= 0) return keyframes;

  return keyframes
    .filter((kf) => kf.time < cut.startSec || kf.time >= cut.endSec)
    .map((kf) => kf.time >= cut.endSec
      ? { ...kf, time: kf.time - cutDuration }
      : kf
    );
}

// ── Undo / Redo ───────────────────────────────────────────────────────────────

export type UndoableState = {
  segments: AlignedSubtitleSegment[];
  frameKeyframes: FrameKeyframe[];
  cuts: TimelineCut[];
  trim: TimelineTrim;
};

const MAX_UNDO_STACK = 50;

export class UndoRedoStack {
  private undoStack: UndoableState[] = [];
  private redoStack: UndoableState[] = [];

  push(state: UndoableState): void {
    this.undoStack.push(structuredClone(state));
    if (this.undoStack.length > MAX_UNDO_STACK) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  undo(currentState: UndoableState): UndoableState | null {
    if (this.undoStack.length === 0) return null;
    this.redoStack.push(structuredClone(currentState));
    return this.undoStack.pop()!;
  }

  redo(currentState: UndoableState): UndoableState | null {
    if (this.redoStack.length === 0) return null;
    this.undoStack.push(structuredClone(currentState));
    return this.redoStack.pop()!;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

// ── FFmpeg export helpers ─────────────────────────────────────────────────────

/**
 * Build an FFmpeg select expression that keeps only the non-cut regions.
 * Used for `select` filter during final export.
 *
 * Example output: "between(t,0,5)+between(t,8,15)"
 */
export function buildFfmpegSelectExpression(
  cuts: TimelineCut[],
  trim: TimelineTrim | undefined,
  clipDurationSec: number
): string {
  const trimStart = trim?.trimStartSec || 0;
  const trimEnd = trim?.trimEndSec || 0;
  const effectiveEnd = clipDurationSec - trimEnd;

  // Build the "keep" regions (gaps between cuts)
  const keep: Array<{ start: number; end: number }> = [];
  let cursor = trimStart;

  const sortedCuts = [...cuts].sort((a, b) => a.startSec - b.startSec);

  for (const cut of sortedCuts) {
    if (cut.startSec > cursor) {
      keep.push({ start: cursor, end: cut.startSec });
    }
    cursor = Math.max(cursor, cut.endSec);
  }

  if (cursor < effectiveEnd) {
    keep.push({ start: cursor, end: effectiveEnd });
  }

  if (keep.length === 0) return '0'; // edge case: everything was cut

  return keep
    .map((region) => `between(t\\,${region.start.toFixed(3)}\\,${region.end.toFixed(3)})`)
    .join('+');
}
