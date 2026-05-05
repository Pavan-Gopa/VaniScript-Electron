export type AppScreen = 'workspace' | 'review' | 'export';
export type OutputFormat = 'TXT' | 'SRT' | 'VTT' | 'Markdown';
export type Theme = 'dark' | 'light';
export type FontSize = 'sm' | 'md' | 'lg' | 'xl';
export type SliceMode = 'silence' | 'fixed';
export type TranscriptionProvider = string;
export type TranslationProvider = string;

export interface LocalModelState {
  status: 'not_downloaded' | 'downloading' | 'downloaded' | 'failed';
  progress?: number;
  label: string;
  path?: string | null;
  error?: string;
}

export interface AppSettings {
  // API
  geminiKey: string;
  openaiKey: string;
  anthropicKey: string;
  // Appearance
  theme: Theme;
  fontSize: FontSize;
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
  };
}

// Window extension for Electron API
declare global {
  interface Window {
    electronAPI?: {
      isElectron: boolean;
      openFile: () => Promise<string | null>;
      saveFile: (opts: { defaultName: string; filters?: any[] }) => Promise<string | null>;
      writeFile: (opts: { filePath: string; content: string }) => Promise<{ success: boolean; error?: string }>;
      readFileBuffer: (opts: { filePath: string }) => Promise<any>;
      ffmpegGetPath: () => Promise<string>;
      ffmpegConvertToWav: (opts: { inputPath: string }) => Promise<{ success: boolean; outputPath: string; error?: string; stderr?: string }>;
      ffmpegSliceChunks: (opts: { inputPath: string; cutPoints: number[] }) => Promise<{ success: boolean; chunkPaths: string[]; error?: string }>;
      ffmpegGetDuration: (opts: { inputPath: string }) => Promise<{ success: boolean; durationSec: number }>;
      localInstallAsrModel: (opts: { modelId: string }) => Promise<{ ok: boolean; id: string; path?: string | null; error?: string }>;
      localRemoveAsrModel: (opts: { modelId: string }) => Promise<{ ok: boolean; id: string; error?: string }>;
      localTranscribeChunk: (opts: {
        modelId: string;
        chunkPath: string;
        options?: { language?: string; forceCpu?: boolean; threads?: number };
      }) => Promise<{ text: string; segments?: Array<{ t0?: number; t1?: number; text?: string }>; engine?: string; durationMs?: number }>;
      getVersion: () => Promise<string>;
      getPlatform: () => Promise<string>;
      getUserDataPath: () => Promise<string>;
      openExternal: (url: string) => Promise<void>;
    };
  }
}
