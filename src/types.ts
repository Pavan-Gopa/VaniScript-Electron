import type { PromptSettingsMap } from './lib/prompt-presets';

export type AppScreen = 'workspace' | 'review' | 'export';
export type OutputFormat = 'TXT' | 'SRT' | 'VTT' | 'Markdown';
export type Theme = 'dark' | 'light';
export type FontSize = 'sm' | 'md' | 'lg' | 'xl';
export type FontFamily = 'mono' | 'sans' | 'serif';
export type SliceMode = 'silence' | 'fixed';
export type TranscriptionProvider = string;
export type TranslationProvider = string;

export interface LocalModelState {
  status: 'not_downloaded' | 'downloading' | 'downloaded' | 'failed';
  progress?: number;
  progressLabel?: string;
  label: string;
  path?: string | null;
  error?: string;
  runtime?: 'whisper' | 'parakeet' | 'llamacpp' | 'mlx';
}

export interface AppSettings {
  // API
  geminiKey: string;
  openaiKey: string;
  anthropicKey: string;
  geminiBudgetUsd: number;
  openaiBudgetUsd: number;
  // Appearance
  theme: Theme;
  fontSize: FontSize;
  fontScale: number;
  fontFamily: FontFamily;
  // Chunking
  chunkDurationMin: number;   // 2-20
  sliceMode: SliceMode;
  silenceThreshDb: number;    // e.g. -16
  minSilenceMs: number;       // e.g. 400
  // Transcription
  defaultSourceLang: string;
  transcriptionProvider: TranscriptionProvider;
  // Translation
  translationProvider: TranslationProvider;
  defaultTargetLang: string;
  // Local models
  localAsrModels: Record<string, LocalModelState>;
  localTranslationModels: Record<string, LocalModelState>;
  promptPresets: PromptSettingsMap;
  glossary: GlossaryEntry[];
}

export interface GlossaryEntry {
  id: string;
  variants: string[];
  source: string;
  translation: string;
  category?: string;
  translations?: Record<string, string>;
  remember: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AudioMetadata {
  date: string;
  location: string;
  lecturer: string;
  participants: string;
}

export interface LanguageResult {
  TXT?: string;
  SRT?: string;
  VTT?: string;
  Markdown?: string;
}

export interface ChunkData {
  index: number;
  filePath: string;           // local WAV path
  durationSec: number;
  startSec: number;
  endSec: number;
  original: string;
  translated: string;
  originalFormats?: LanguageResult;
  translatedFormats?: LanguageResult;
  unrecognizedFragments?: string[];
  status: 'pending' | 'processing' | 'done' | 'error';
  approved: boolean;
}

export interface SessionState {
  sourceFile: string | null;  // original file path
  sourceFileName: string;
  durationSec: number;
  metadata: AudioMetadata;
  sourceLang: string;
  targetLang: string;
  transcriptionProvider: TranscriptionProvider;
  translationProvider: TranslationProvider;
  outputFormats: OutputFormat[];
  chunks: ChunkData[];
  currentChunkIndex: number;
}

export interface UsageStats {
  [provider: string]: {
    sessions: number;
    inputTokens: number;
    outputTokens: number;
    audioMinutes: number;
    lastUsed: string;
    lastInputTokens?: number;
    lastOutputTokens?: number;
  };
}

export interface ProjectSummary {
  id: string;
  name: string;
  sourceFileName: string;
  updatedAt: string;
  createdAt: string;
  currentIndex: number;
  totalChunks: number;
  approvedChunks: number;
  targetLang: string;
}

// Window extension for Electron API
declare global {
  interface Window {
    electronAPI?: {
      isElectron: boolean;
      openFile: () => Promise<string | null>;
      openGenericFile: (opts?: { filters?: any[] }) => Promise<string | null>;
      saveFile: (opts: { defaultName: string; filters?: any[] }) => Promise<string | null>;
      openDirectory: () => Promise<string | null>;
      writeFile: (opts: { filePath: string; content: string }) => Promise<{ success: boolean; error?: string }>;
      deleteFiles: (opts: { filePaths: string[] }) => Promise<{ success: boolean; error?: string }>;
      writeTempTextFile: (opts: { fileName: string; content: string }) => Promise<{ success: boolean; filePath?: string; error?: string }>;
      createTempPath: (opts: { fileName: string }) => Promise<{ success: boolean; filePath?: string; error?: string }>;
      readTextFile: (opts: { filePath: string }) => Promise<{ success: boolean; content?: string; error?: string }>;
      readFileBuffer: (opts: { filePath: string }) => Promise<any>;
      pathToFileUrl: (opts: { filePath: string }) => Promise<{ success: boolean; url?: string; error?: string }>;
      ffmpegGetPath: () => Promise<string>;
      ffmpegConvertToWav: (opts: { inputPath: string }) => Promise<{ success: boolean; outputPath: string; error?: string; stderr?: string }>;
      ffmpegExtractAudioForTranscription: (opts: { inputPath: string }) => Promise<{ success: boolean; outputPath: string; error?: string; stderr?: string }>;
      ffmpegSliceChunks: (opts: { inputPath: string; cutPoints: number[] }) => Promise<{ success: boolean; chunkPaths: string[]; error?: string }>;
      ffmpegGetDuration: (opts: { inputPath: string }) => Promise<{ success: boolean; durationSec: number }>;
      ffmpegGetVideoInfo: (opts: { inputPath: string }) => Promise<{ success: boolean; width?: number; height?: number; durationSec?: number; fps?: number; error?: string }>;
      ffmpegExtractWaveformPeaks: (opts: {
        inputPath: string;
        startSec: number;
        durationSec: number;
        peakCount?: number;
      }) => Promise<{ success: boolean; peaks?: number[]; error?: string; stderr?: string }>;
      ffmpegRenderShortPreviewFrame: (opts: {
        inputVideoPath: string;
        outputPath: string;
        atSec: number;
        videoFilter: string;
        videoFilterGraph?: string;
        assSubtitlePath: string;
      }) => Promise<{ success: boolean; outputPath?: string; error?: string; stderr?: string }>;
      ffmpegExportShortClip: (opts: {
        inputVideoPath: string;
        outputPath: string;
        startSec: number;
        durationSec: number;
        videoFilter: string;
        videoFilterGraph?: string;
        assSubtitlePath: string;
        crf?: number;
        format?: 'mp4' | 'mov';
      }) => Promise<{ success: boolean; outputPath?: string; error?: string; stderr?: string }>;
      hyperframesExportShortClip: (opts: {
        jobId?: string;
        project: any;
        inputVideoPath: string;
        outputPath: string;
        format?: 'mp4' | 'mov';
        qualityPreset?: 'compact' | 'balanced' | 'high';
      }) => Promise<{ success: boolean; outputPath?: string; error?: string; stderr?: string; cancelled?: boolean }>;
      hyperframesCancelExport: (opts: { jobId: string }) => Promise<{ success: boolean; error?: string }>;
      onHyperframesExportProgress: (callback: (payload: {
        jobId?: string;
        status?: string;
        progress?: number;
        stage?: string;
        message?: string;
      }) => void) => () => void;
      localInstallAsrModel: (opts: { modelId: string }) => Promise<{ ok: boolean; id: string; path?: string | null; error?: string }>;
      localRemoveAsrModel: (opts: { modelId: string }) => Promise<{ ok: boolean; id: string; error?: string }>;
      localTranscribeChunk: (opts: {
        modelId: string;
        chunkPath: string;
        options?: { language?: string; forceCpu?: boolean; threads?: number };
      }) => Promise<{ text: string; segments?: Array<{ t0?: number; t1?: number; text?: string }>; engine?: string; durationMs?: number }>;
      localInstallTranslationModel: (opts: { modelId: string }) => Promise<{ ok: boolean; id: string; path?: string | null; error?: string }>;
      localRemoveTranslationModel: (opts: { modelId: string }) => Promise<{ ok: boolean; id: string; error?: string }>;
      localResolveTranslationModelPath: (opts: { modelId: string }) => Promise<{ ok: boolean; id: string; path?: string | null; error?: string }>;
      localTranslateText: (opts: {
        modelId: string;
        mode?: 'translate' | 'polish' | 'custom';
        text: string;
        targetLang: string;
        speakerHint?: string;
        glossaryBlock?: string;
        maxTokens?: number;
        maxOutputChars?: number;
        ctxSize?: number;
        requestTimeoutMs?: number;
      }) => Promise<{ text: string; backendName?: string; loadTimeMilliseconds?: number }>;
      localGetModelDownloadStatus: (opts: {
        kind: 'asr' | 'translation';
        modelId: string;
      }) => Promise<{
        ok: boolean;
        kind: 'asr' | 'translation';
        modelId: string;
        status?: string;
        bytesDownloaded?: number;
        completedFiles?: number;
        totalFiles?: number;
        currentFileName?: string | null;
        error?: string;
      }>;
      onLocalModelDownloadProgress: (
        callback: (payload: {
          kind: 'asr' | 'translation';
          runtime: 'whisper' | 'parakeet' | 'llamacpp';
          modelId: string;
          status: string;
          percent: number;
          received?: number;
          total?: number;
          currentFile?: number;
          totalFiles?: number;
          fileName?: string | null;
        }) => void
      ) => () => void;
      projectList: () => Promise<{ ok: boolean; projects?: ProjectSummary[]; error?: string }>;
      projectSave: (project: any) => Promise<{ ok: boolean; project?: any; error?: string }>;
      projectLoad: (opts: { id: string }) => Promise<{ ok: boolean; project?: any; error?: string }>;
      projectDelete: (opts: { id: string }) => Promise<{ ok: boolean; error?: string }>;
      projectClearAll: () => Promise<{ ok: boolean; error?: string }>;
      projectExport: (opts: { id: string }) => Promise<{ ok: boolean; filePath?: string; error?: string }>;
      projectExportAll: () => Promise<{ ok: boolean; filePath?: string; error?: string }>;
      projectImport: () => Promise<{ ok: boolean; project?: any; error?: string }>;
      getVersion: () => Promise<string>;
      getPlatform: () => Promise<string>;
      getUserDataPath: () => Promise<string>;
      getSystemMemoryInfo: () => Promise<{ totalBytes: number; freeBytes: number; platform: string; arch: string }>;
      openExternal: (url: string) => Promise<void>;
    };
  }
}
