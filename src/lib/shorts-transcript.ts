import type { ChunkData } from '../types';
import { cuesToKaraokeLines, formatPlaybackClock, KaraokeTimedLine, parseKaraokeLines } from './karaoke';

export type ShortsTranscriptSide = 'source' | 'target';
export type ShortsTranscriptMode = ShortsTranscriptSide | 'bilingual';

function textForSide(chunk: ChunkData, side: ShortsTranscriptSide): string {
  return side === 'source' ? chunk.original : chunk.translated;
}

function linesForChunk(chunk: ChunkData, side: ShortsTranscriptSide): KaraokeTimedLine[] {
  const structured = cuesToKaraokeLines(side === 'source' ? chunk.originalCues : chunk.translatedCues);
  if (structured.length > 0) return structured;

  return parseKaraokeLines(textForSide(chunk, side), chunk.startSec, chunk.endSec)
    .filter((line): line is KaraokeTimedLine => line.kind === 'timed' && line.text.trim().length > 0);
}

export function collectShortsTranscriptLines(chunks: ChunkData[], side: ShortsTranscriptSide): KaraokeTimedLine[] {
  return chunks
    .filter((chunk) => chunk.status === 'done')
    .flatMap((chunk) => linesForChunk(chunk, side))
    .filter((line) => line.text.trim().length > 0)
    .sort((a, b) => a.startSec - b.startSec);
}

function singleSideTranscript(chunks: ChunkData[], side: ShortsTranscriptSide): string {
  return collectShortsTranscriptLines(chunks, side)
    .map((line) => `[${formatPlaybackClock(line.startSec)}] ${line.text.trim()}`)
    .join('\n\n');
}

function nearestLine(lines: KaraokeTimedLine[], startSec: number): KaraokeTimedLine | null {
  return lines.reduce<KaraokeTimedLine | null>((best, candidate) => {
    const bestDistance = best ? Math.abs(best.startSec - startSec) : Number.POSITIVE_INFINITY;
    const distance = Math.abs(candidate.startSec - startSec);
    return distance < bestDistance ? candidate : best;
  }, null);
}

export function buildShortsTranscriptText(chunks: ChunkData[], mode: ShortsTranscriptMode): string {
  if (mode === 'source' || mode === 'target') return singleSideTranscript(chunks, mode);

  const sourceLines = collectShortsTranscriptLines(chunks, 'source');
  const targetLines = collectShortsTranscriptLines(chunks, 'target');
  return sourceLines.map((sourceLine) => {
    const targetLine = nearestLine(targetLines, sourceLine.startSec);
    return [
      `[${formatPlaybackClock(sourceLine.startSec)}]`,
      `Source: ${sourceLine.text.trim()}`,
      targetLine ? `Target: ${targetLine.text.trim()}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

export function buildShortsCuesForClip(
  chunks: ChunkData[],
  side: ShortsTranscriptSide,
  clipStartSec: number,
  clipEndSec: number
): { startSec: number; endSec: number; text: string }[] {
  return collectShortsTranscriptLines(chunks, side)
    .filter((line) => line.endSec > clipStartSec && line.startSec < clipEndSec)
    .map((line) => ({
      startSec: Math.max(0, line.startSec - clipStartSec),
      endSec: Math.max(0.5, Math.min(clipEndSec, line.endSec) - clipStartSec),
      text: line.text.trim(),
    }))
    .filter((cue) => cue.text.length > 0);
}
