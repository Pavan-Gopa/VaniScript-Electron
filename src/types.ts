export type AppScreen = 'workspace' | 'review' | 'export';
export type OutputFormat = 'TXT' | 'SRT' | 'VTT' | 'Markdown';
export type Theme = 'dark' | 'light';
export type FontSize = 'sm' | 'md' | 'lg' | 'xl';
export type SliceMode = 'silence' | 'fixed';
export type TranscriptionProvider = 'gemini' | 'openai' | 'whisper-local';
export type TranslationProvider = 'gemini' | 'openai' | 'anthropic' | 'ollama' | 'none';

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
}

export interface AudioMetadata {
  date: string;
  location: string;
  lecturer: string;
  participants: string;
}

export interface ChunkData {
  index: number;
  filePath: string;           // local WAV path
  durationSec: number;
  startSec: number;
  endSec: number;
  original: string;
  translated: string;
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
      ffmpegConvertToWav: (opts: { inputPath: string }) => Promise<{ success: boolean; outputPath: string }>;
      ffmpegSliceChunks: (opts: { inputPath: string; cutPoints: number[] }) => Promise<{ success: boolean; chunkPaths: string[] }>;
      ffmpegGetDuration: (opts: { inputPath: string }) => Promise<{ success: boolean; durationSec: number }>;
      getVersion: () => Promise<string>;
      getPlatform: () => Promise<string>;
      getUserDataPath: () => Promise<string>;
      openExternal: (url: string) => Promise<void>;
    };
  }
}
