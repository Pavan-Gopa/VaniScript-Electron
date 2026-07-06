import { KaraokeLine, KaraokeTimedLine } from './karaoke';

const TIMED_LINE_NAVIGATION_EPSILON_SEC = 0.1;

export function acceleratedSeekStep(isRepeat: boolean, repeatCount: number): number {
  if (!isRepeat || repeatCount < 5) return 1;
  if (repeatCount < 12) return 3;
  return 5;
}

export function nextTimedLineStart(lines: KaraokeLine[], currentSec: number, direction: -1 | 1): number | null {
  const timed = lines.filter((line): line is KaraokeTimedLine => line.kind === 'timed');
  if (timed.length === 0) return null;

  const nearMarkerIndex = timed.findIndex(
    (line) => Math.abs(currentSec - line.startSec) <= TIMED_LINE_NAVIGATION_EPSILON_SEC,
  );
  if (nearMarkerIndex >= 0) {
    return timed[Math.max(0, Math.min(timed.length - 1, nearMarkerIndex + direction))].startSec;
  }

  const currentIndex = timed.findIndex((line) => currentSec >= line.startSec && currentSec < line.endSec);
  if (currentIndex >= 0) {
    return timed[Math.max(0, Math.min(timed.length - 1, currentIndex + direction))].startSec;
  }

  if (direction > 0) {
    return (timed.find((line) => line.startSec > currentSec) ?? timed[timed.length - 1]).startSec;
  }

  return ([...timed].reverse().find((line) => line.startSec < currentSec) ?? timed[0]).startSec;
}

export function bestTimedNavigationContent(original: string, translated: string): string {
  const originalCount = (original.match(/^\s*\[[^\]]+\]/gm) ?? []).length;
  const translatedCount = (translated.match(/^\s*\[[^\]]+\]/gm) ?? []).length;
  if (originalCount === 0 && translatedCount > 0) return translated;
  return original;
}

export function shouldIgnoreReviewHotkeyTarget(target: Pick<HTMLElement, 'tagName'> & { type?: string; isContentEditable?: boolean } | null): boolean {
  if (!target) return false;
  const tagName = target.tagName.toUpperCase();
  if (target.isContentEditable) return true;
  if (tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
  if (tagName !== 'INPUT') return false;
  return !['range', 'button', 'checkbox', 'radio'].includes(String(target.type || '').toLowerCase());
}
