export {
  getChunkRowWindow,
  getVariableVirtualWindow,
  includeIndexInVirtualWindow,
} from './virtual-window';

export function projectChunkNumbers(totalChunks: number): number[] {
  const count = Math.max(0, Math.floor(totalChunks));
  return Array.from({ length: count }, (_, index) => index + 1);
}

export function clampChunkIndex(index: number, totalChunks: number): number {
  const maxIndex = Math.max(0, Math.floor(totalChunks) - 1);
  return Math.max(0, Math.min(maxIndex, Math.floor(index)));
}

export function canOpenSidebarChunk(chunkIndex: number, currentIndex: number, totalChunks: number): boolean {
  const total = Math.max(0, Math.floor(totalChunks));
  const index = Math.floor(chunkIndex);
  if (index < 0 || index >= total) return false;
  return index <= clampChunkIndex(currentIndex, total);
}

export function isProjectExportReady(totalChunks: number, approvedChunks: number): boolean {
  const total = Math.max(0, Math.floor(totalChunks));
  const approved = Math.max(0, Math.floor(approvedChunks));
  return total > 0 && approved >= total;
}
