export interface CanonicalChunkSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface CanonicalChunk {
  chunkId: string;
  startMs: number;
  endMs: number;
  audioPath: string;
  status: 'queued' | 'chunking' | 'transcribing' | 'translating' | 'ready' | 'failed';
  originalText: string;
  translatedText: string | null;
  segments: CanonicalChunkSegment[];
  transcriptionProvider: string;
  translationProvider: string | null;
  formatCache: { txt?: string; srt?: string; vtt?: string; markdown?: string };
  error: string | null;
}

export interface ChunkQueueState {
  chunks: CanonicalChunk[];
  currentChunkId: string | null;
}

export function createChunkQueueState(chunks: CanonicalChunk[]): ChunkQueueState {
  return {
    chunks: chunks.map((chunk) => ({
      ...chunk,
      status: chunk.status || 'queued',
      originalText: chunk.originalText || '',
      translatedText: chunk.translatedText ?? null,
      segments: chunk.segments || [],
      formatCache: chunk.formatCache || {},
      error: chunk.error ?? null,
    })),
    currentChunkId: chunks[0]?.chunkId ?? null,
  };
}

export function markChunkReady(state: ChunkQueueState, chunkId: string): ChunkQueueState {
  return {
    ...state,
    currentChunkId: state.currentChunkId ?? chunkId,
    chunks: state.chunks.map((chunk) => (
      chunk.chunkId === chunkId ? { ...chunk, status: 'ready' } : chunk
    )),
  };
}

export function nextPrefetchIndex(state: ChunkQueueState): number {
  const currentIndex = state.chunks.findIndex((chunk) => chunk.chunkId === state.currentChunkId);
  if (currentIndex < 0) return 0;
  return Math.min(currentIndex + 1, Math.max(0, state.chunks.length - 1));
}
