import { AppSettings, ChunkData, SessionConfig, SourceMediaInfo } from '../types';
import { SourceMediaKind, sourceMediaKind } from '../lib/media-source';
import { computeCutPoints, cutPointsToSeconds } from './smart-slicer';

// Startup media preparation pipeline, extracted verbatim from App.tsx
// `handleStartEngine`. Owns: WAV conversion/extract, duration probe, silence
// or fixed-interval cut points, slicing, chunk construction and best-effort
// source media info. UI state (screens, session storage, transcription
// handoff) stays in App; this module only reports progress/stage snapshots.

/** Subset of `window.electronAPI` consumed during startup preparation. */
export interface MediaPreparationBridge {
  ffmpegConvertToWav: (opts: { inputPath: string }) => Promise<{ success: boolean; outputPath: string; error?: string; stderr?: string }>;
  ffmpegExtractAudioForTranscription?: (opts: { inputPath: string }) => Promise<{ success: boolean; outputPath: string; error?: string; stderr?: string }>;
  ffmpegGetDuration: (opts: { inputPath: string }) => Promise<{ success: boolean; durationSec: number }>;
  readFileBuffer: (opts: { filePath: string }) => Promise<{ success: boolean; data: ArrayBuffer; byteLength: number; byteOffset?: number }>;
  ffmpegSliceChunks: (opts: { inputPath: string; cutPoints: number[] }) => Promise<{ success: boolean; chunkPaths: string[]; error?: string }>;
  ffmpegGetSourceMediaInfo?: (opts: { inputPath: string; durationSec: number }) => Promise<SourceMediaInfo | null>;
}

/**
 * Processing snapshot emitted in pipeline order. `stage` mirrors the old
 * procMsg setter, `progress` the procProgress milestones.
 */
export interface MediaPreparationSnapshot {
  stage?: string;
  progress?: number;
}

export type ReportPreparationSnapshot = (snapshot: MediaPreparationSnapshot) => void;

export interface MediaPreparationInput {
  sourceFile: string;
  sourceFileName: string;
  config: SessionConfig;
  /** Chunking settings slice read by the pipeline. */
  chunking: Pick<AppSettings, 'chunkDurationMin' | 'sliceMode' | 'silenceThreshDb' | 'minSilenceMs'>;
}

export interface MediaPreparationDependencies {
  /** Absent/null bridge skips every FFmpeg/filesystem stage (no-window parity). */
  bridge?: MediaPreparationBridge | null;
  report: ReportPreparationSnapshot;
  /** Non-fatal diagnostics channel; defaults to console.warn. */
  warn?: (message: string, detail?: unknown) => void;
}

/**
 * Prepared-session core returned to the composition root. App's `Session`
 * extends this with project/shorts-only fields.
 */
export interface PreparedMediaSession {
  sourceFile: string;
  sourceFileName: string;
  sourceMediaKind: SourceMediaKind;
  originalVideoPath?: string;
  wavPath: string;
  config: SessionConfig;
  chunks: ChunkData[];
  currentIndex: number;
  targetLang: string;
  sourceMediaInfo?: SourceMediaInfo;
}

function isWavPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.wav');
}

export async function prepareMediaSession(
  input: MediaPreparationInput,
  deps: MediaPreparationDependencies
): Promise<PreparedMediaSession> {
  const { sourceFile, sourceFileName, config, chunking } = input;
  const { bridge, report } = deps;
  const warn = deps.warn ?? ((message: string, detail?: unknown) => console.warn(message, detail));

  report({ progress: 5 });
  report({ stage: 'Converting audio format…' });

  // 1. Convert to WAV 16kHz mono (with graceful fallback)
  let wavPath = sourceFile;
  const mediaKind = sourceMediaKind(sourceFile);
  const originalVideoPath = mediaKind === 'video' ? sourceFile : undefined;
  if (bridge) {
    report({ stage: mediaKind === 'video' ? 'Extracting audio from video…' : 'Converting audio to WAV 16kHz…' });
    const res = mediaKind === 'video' && bridge.ffmpegExtractAudioForTranscription
      ? await bridge.ffmpegExtractAudioForTranscription({ inputPath: sourceFile })
      : await bridge.ffmpegConvertToWav({ inputPath: sourceFile });
    if (res.success) {
      wavPath = res.outputPath;
    } else {
      // Fallback: use original file directly — Gemini accepts most formats
      warn('FFmpeg conversion failed, using original file:', res.error);
      report({ stage: 'Using original audio format…' });
    }
  }
  report({ progress: 25 });

  // 2. Get duration
  let durationSec = chunking.chunkDurationMin * 60;
  if (bridge) {
    const dur = await bridge.ffmpegGetDuration({ inputPath: wavPath });
    if (dur.success && dur.durationSec > 0) durationSec = dur.durationSec;
  }
  report({ progress: 40 });

  // 3. Compute cut points
  report({ stage: 'Analyzing audio for optimal split points…' });
  let cutSec: number[] = [];
  const targetMs = chunking.chunkDurationMin * 60 * 1000;

  if (chunking.sliceMode === 'silence' && bridge && isWavPath(wavPath)) {
    try {
      const buf = await bridge.readFileBuffer({ filePath: wavPath });
      if (buf.success && buf.byteLength > 0) {
        const pcm = new Int16Array(buf.data, buf.byteOffset ?? 0, Math.floor(buf.byteLength / 2));
        cutSec = cutPointsToSeconds(computeCutPoints(pcm, 16000, targetMs, chunking.silenceThreshDb, chunking.minSilenceMs));
      }
    } catch { /* fall through to fixed */ }
  }

  // Fixed interval fallback
  if (cutSec.length === 0) {
    for (let t = chunking.chunkDurationMin * 60; t < durationSec - 30; t += chunking.chunkDurationMin * 60) {
      cutSec.push(Math.round(t));
    }
  }
  report({ progress: 60 });

  // 4. Slice audio
  report({ stage: `Creating ${cutSec.length + 1} audio segment(s)…` });
  let chunkPaths: string[] = [wavPath];
  if (bridge && cutSec.length > 0) {
    const sliceRes = await bridge.ffmpegSliceChunks({ inputPath: wavPath, cutPoints: cutSec });
    if (sliceRes.success && sliceRes.chunkPaths.length > 0) chunkPaths = sliceRes.chunkPaths;
  }
  report({ progress: 80 });

  // 5. Build chunk objects
  const bounds = [0, ...cutSec, durationSec];
  const chunks: ChunkData[] = chunkPaths.map((fp, i) => ({
    index: i, filePath: fp,
    durationSec: (bounds[i + 1] ?? durationSec) - bounds[i],
    startSec: bounds[i],
    endSec: bounds[i + 1] ?? durationSec,
    original: '', translated: '', status: 'pending' as const, approved: false,
  }));

  report({ stage: 'Reading source media details…' });
  let sourceMediaInfo: SourceMediaInfo | undefined;
  if (bridge?.ffmpegGetSourceMediaInfo) {
    try {
      const info = await bridge.ffmpegGetSourceMediaInfo({
        inputPath: sourceFile,
        durationSec: durationSec
      });
      if (info) sourceMediaInfo = info;
    } catch (e) {
      warn('Could not read source media info:', e);
    }
  }

  report({ stage: 'Uploading audio and initializing AI…' });
  report({ progress: 90 });
  report({ progress: 100 });

  return {
    sourceFile, sourceFileName, sourceMediaKind: mediaKind, originalVideoPath, wavPath, config, chunks,
    currentIndex: 0, targetLang: config.targetLang, sourceMediaInfo,
  };
}
