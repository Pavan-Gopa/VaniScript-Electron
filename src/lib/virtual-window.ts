export interface VirtualWindow {
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
}

export interface VirtualRows<T> extends VirtualWindow {
  rows: readonly T[];
}

export interface VariableVirtualWindow extends VirtualWindow {
  offsetAt(index: number): number;
}

/**
 * Dependency-free fixed-row window math shared by the Batch queue and the
 * project/chunk surfaces. The helpers deliberately clamp every input so a
 * malformed scroll event cannot produce negative DOM ranges.
 */
export function getVirtualWindow(
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = 58,
  overscan = 6,
): VirtualWindow {
  const count = Math.max(0, Math.floor(itemCount));
  const height = Math.max(1, rowHeight);
  const viewport = Math.max(1, viewportHeight);
  const top = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  const first = Math.min(count, Math.floor(top / height));
  const visible = Math.ceil(viewport / height);
  const extra = Math.max(0, Math.floor(overscan));
  const start = Math.max(0, first - extra);
  const end = Math.min(count, first + visible + extra);
  return {
    start,
    end: Math.max(start, end),
    offsetTop: start * height,
    totalHeight: count * height,
  };
}

export function getVirtualRows<T>(
  items: readonly T[],
  scrollTop: number,
  viewportHeight: number,
  rowHeight = 58,
  overscan = 6,
): VirtualRows<T> {
  const window = getVirtualWindow(items.length, scrollTop, viewportHeight, rowHeight, overscan);
  return { ...window, rows: items.slice(window.start, window.end) };
}

/**
 * Return a variable-height outer-list range. Items use one of two fixed slot
 * heights; the expanded item is still fixed-height and owns its own inner
 * virtual viewport. `gap` is part of each slot so the sparse absolute layout
 * has the same geometry as the old flex list.
 */
export function getVariableVirtualWindow(
  itemCount: number,
  expandedIndex: number,
  scrollTop: number,
  viewportHeight: number,
  collapsedHeight = 96,
  expandedHeight = 430,
  gap = 10,
  overscan = 2,
): VariableVirtualWindow {
  const count = Math.max(0, Math.floor(itemCount));
  const expanded = Number.isInteger(expandedIndex) && expandedIndex >= 0 && expandedIndex < count
    ? expandedIndex
    : -1;
  const collapsedSlot = Math.max(1, collapsedHeight) + Math.max(0, gap);
  const expandedSlot = Math.max(1, expandedHeight) + Math.max(0, gap);
  const expandedDelta = expandedSlot - collapsedSlot;
  const offsetAt = (index: number): number => {
    const normalized = Math.max(0, Math.floor(index));
    return normalized * collapsedSlot + (expanded >= 0 && normalized > expanded ? expandedDelta : 0);
  };
  const totalHeight = count * collapsedSlot + (expanded >= 0 ? expandedDelta : 0);
  const top = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  const viewport = Math.max(1, viewportHeight);
  const firstVisibleIndex = (position: number): number => {
    if (count === 0) return 0;
    if (expanded < 0 || position < expanded * collapsedSlot) {
      return Math.min(count, Math.floor(position / collapsedSlot));
    }
    const expandedStart = expanded * collapsedSlot;
    const expandedEnd = expandedStart + expandedSlot;
    if (position < expandedEnd) return expanded;
    return Math.min(count, expanded + 1 + Math.floor((position - expandedEnd) / collapsedSlot));
  };
  const firstIndexAtOrAfter = (position: number): number => {
    if (count === 0) return 0;
    if (expanded < 0 || position <= expanded * collapsedSlot) {
      return Math.min(count, Math.ceil(position / collapsedSlot));
    }
    const expandedStart = expanded * collapsedSlot;
    const expandedEnd = expandedStart + expandedSlot;
    if (position <= expandedEnd) return Math.min(count, expanded + 1);
    return Math.min(count, expanded + 1 + Math.ceil((position - expandedEnd) / collapsedSlot));
  };
  const first = firstVisibleIndex(top);
  const endVisible = firstIndexAtOrAfter(top + viewport);
  const extra = Math.max(0, Math.floor(overscan));
  const start = Math.max(0, first - extra);
  const end = Math.min(count, endVisible + extra);
  return {
    start,
    end: Math.max(start, end),
    offsetTop: offsetAt(start),
    totalHeight,
    offsetAt,
  };
}

export function getChunkRowWindow(
  totalChunks: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = 36,
  overscan = 4,
): VirtualWindow {
  return getVirtualWindow(
    Math.ceil(Math.max(0, Math.floor(totalChunks)) / 2),
    scrollTop,
    viewportHeight,
    rowHeight,
    overscan,
  );
}

/** Ensure a focused/active item is materialized without widening the DOM. */
export function includeIndexInVirtualWindow(window: VirtualWindow, index: number): VirtualWindow {
  if (!Number.isInteger(index) || index < 0) return window;
  if (index >= window.start && index < window.end) return window;
  const distance = Math.max(1, window.end - window.start);
  if (index < window.start) {
    return { ...window, start: index, end: Math.min(window.start + distance, index + distance) };
  }
  return { ...window, start: Math.max(0, index - distance + 1), end: index + 1 };
}
