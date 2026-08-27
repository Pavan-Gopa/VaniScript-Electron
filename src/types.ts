import type { PromptSettingsMap } from './lib/prompt-presets';
import type {
  ShortsExportEvent,
  ShortsExportSnapshot,
  ShortsExportTerminalEvent,
} from './lib/shorts-export-contract';
export type HyperFramesExportStartFailure = Readonly<{
  success: false;
  error?: string;
  errorCode?: string;
  message?: string;
}>;
export type HyperFramesExportStartResult = ShortsExportTerminalEvent | HyperFramesExportStartFailure;
export type HyperFramesExportCancelResult = Readonly<{
  success: boolean;
  accepted: boolean;
  state?: 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'not_found';
  errorCode?: string;
  error?: string;
}>;

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
		  runtime?: 'whisper' | 'parakeet' | 'llamacpp' | 'mlx' | 'ggml' | 'gguf';
  custom?: boolean;
  unsupported?: boolean;
		}

export interface LocalDiskModelStatus {
  status: 'downloaded' | 'downloading' | 'not_found' | 'failed' | 'incomplete';
  path?: string | null;
  bytesDownloaded?: number;
  completedFiles?: number;
  totalFiles?: number;
  currentFileName?: string | null;
  error?: string;
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
  annotationMode?: boolean;
  completedOnboardingBuildId?: string;
  helpLocale?: 'en' | 'ru';
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
  // Chat assistant routing (Grok MCP vs Gemini API vs Qwen MCP)
  chatRoute?: 'mcp' | 'api' | 'qwen';
  chatGrokModel?: string;
  chatQwenModel?: string;
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

export interface SessionConfig {
  date: string;
  location: string;
  lecturer: string;
  participants: string;
  targetLang: string;
  formats: string[];
  transcriptionProvider: TranscriptionProvider;
  translationProvider: TranslationProvider;
}

export interface LanguageResult {
  TXT?: string;
  SRT?: string;
  VTT?: string;
  Markdown?: string;
}

// One archived translation of a chunk. Mirrors TranslationVariant in the
// Apple Silicon edition's SessionModels.swift (same JSON keys), so archives
// round-trip across editions. `translationsByLanguage` (keyed by the
// lowercased display language, see shared/media-translations.js) is the
// authority; `translated`/`translatedCues`/`translatedFormats` are eager
// projections of the current active variant.
export interface TranslationVariant {
  language: string;
  text: string;
  cues?: TranscriptCue[];
  formats?: LanguageResult;
  provider?: string;
  updatedAt?: string;
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
  // Structured karaoke cues. Canonical source of truth for playback highlighting,
  // shared verbatim with the Apple Silicon (Swift) edition (same JSON keys:
  // startSec/endSec/text/words). Optional so legacy projects (inline [mm:ss]
  // markers in `original`/`translated`) keep working via marker fallback.
  originalCues?: TranscriptCue[];
  translatedCues?: TranscriptCue[];
  // Multi-language archive authority. Keyed by canonical language key
  // (lowercased display name). Optional so legacy single-language sessions
  // keep working via the eager projection fields above.
  translationsByLanguage?: Record<string, TranslationVariant>;
}

// Mirrors TranscriptWord/TranscriptCue in SessionModels.swift (no custom
// CodingKeys on the Swift side), so the JSON round-trips across editions.
export interface TranscriptWord {
  startSec: number;
  endSec: number;
  text: string;
}

export interface TranscriptCue {
  startSec: number;
  endSec: number;
  text: string;
  words?: TranscriptWord[];
}

export interface SessionState {
  sourceFile: string | null;  // original file path
  sourceFileName: string;
  durationSec: number;
  metadata: AudioMetadata;
  sourceLang: string;
  targetLang: string;
  // Canonical multi-language selection state (P3E.D2). The legacy
  // `selectedTranslationLanguage` field is load-only input and is stripped by
  // shared normalization — it must never appear on a persisted session.
  activeTranslationLanguage?: string;
  availableTranslationLanguages?: string[];
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
  sourceMediaInfo?: SourceMediaInfo;
}

// Window extension for Electron API
declare global {
  interface Window {
    electronAPI?: {
      isElectron: boolean;
      migrateLegacySettings?: (payload: { settings?: unknown; usage?: unknown; clientVersion?: string }) => Promise<{ ok: boolean; summary?: unknown; error?: string; errorCode?: string }>;
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
      recordingStart: (opts: { mimeType?: string; fileBaseName?: string }) => Promise<{ success: boolean; sessionId?: string; error?: string }>;
      recordingAppendChunk: (opts: { sessionId: string; chunk: ArrayBuffer }) => Promise<{ success: boolean; bytes?: number; error?: string }>;
      recordingPreview: (opts: { sessionId: string }) => Promise<{ success: boolean; path?: string; url?: string; bytes?: number; mimeType?: string; error?: string }>;
      recordingFinish: (opts: { sessionId: string }) => Promise<{ success: boolean; path?: string; name?: string; directory?: string; bytes?: number; error?: string; stderr?: string }>;
      recordingCancel: (opts: { sessionId: string }) => Promise<{ success: boolean; error?: string }>;
      recordingOpenFolder: () => Promise<{ success: boolean; directory?: string; error?: string }>;
      linkImportStart: (opts: { url: string; mode: 'video' | 'audio'; jobId?: string }) => Promise<{
        success: boolean;
        path?: string;
        name?: string;
        directory?: string;
        url?: string;
        mode?: 'video' | 'audio';
        error?: string;
        stderr?: string;
        cancelled?: boolean;
      }>;
      linkImportCancel: (opts: { jobId: string }) => Promise<{ success: boolean; error?: string }>;
      linkImportOpenFolder: () => Promise<{ success: boolean; directory?: string; error?: string }>;
      onLinkImportProgress: (callback: (payload: {
        jobId?: string;
        status?: 'starting' | 'resolving' | 'downloading' | 'processing' | 'complete' | 'error' | 'cancelled';
        progress?: number;
        message?: string;
        speed?: string;
        eta?: string;
      }) => void) => () => void;
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
      hyperframesExportShorts: (snapshot: ShortsExportSnapshot) => Promise<HyperFramesExportStartResult>;
      hyperframesCancelExport: (opts: { jobId: string }) => Promise<HyperFramesExportCancelResult>;
      onHyperframesExportProgress: (callback: (payload: ShortsExportEvent) => void) => () => void;
	      localInstallAsrModel: (opts: { modelId: string }) => Promise<{ ok: boolean; id: string; path?: string | null; error?: string }>;
	      localRemoveAsrModel: (opts: { modelId: string }) => Promise<{ ok: boolean; id: string; error?: string }>;
	      localTranscribeChunk: (opts: {
        modelId: string;
        chunkPath: string;
        options?: { language?: string; forceCpu?: boolean; threads?: number };
	      }) => Promise<{ text: string; segments?: Array<{ t0?: number; t1?: number; text?: string }>; engine?: string; durationMs?: number }>;
      localScanModels: () => Promise<{
        ok: boolean;
        root?: string;
        entries?: Array<{
          name: string;
          runtime: 'mlx' | 'gguf' | 'ggml' | 'whisperkit';
          role: 'asr' | 'polish' | 'unsupported';
          supported: boolean;
          path?: string;
        }>;
        error?: string;
      }>;
	      localReconcileModels: (opts: { asrIds: string[]; translationIds: string[] }) => Promise<{
	        ok: boolean;
	        asr: Record<string, LocalDiskModelStatus>;
	        translation: Record<string, LocalDiskModelStatus>;
	        error?: string;
	      }>;
      onLocalModelsUpdated: (callback: (payload: {
        root?: string;
        entries?: Array<{
          name: string;
          runtime: 'mlx' | 'gguf' | 'ggml' | 'whisperkit';
          role: 'asr' | 'polish' | 'unsupported';
          supported: boolean;
          path?: string;
        }>;
      }) => void) => () => void;
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
	        path?: string | null;
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
      onOpenSettings: (callback: () => void) => () => void;
      openPath: (path: string) => Promise<string>;
      showItemInFolder: (path: string) => Promise<void>;
      ffmpegGetSourceMediaInfo: (opts: { inputPath: string; originalURL?: string; title?: string; durationSec?: number }) => Promise<SourceMediaInfo | null>;
      openExternal: (url: string) => Promise<void>;
      onMcpCallTool?: (callback: (payload: { name: string; arguments: any; requestId: string }) => void) => () => void;
      mcpToolResponse?: (payload: { requestId: string; success: boolean; result?: any; error?: string }) => Promise<any>;
      onMcpBuildTranscriptArtifact?: (callback: (payload: { requestId: string; arguments: { side?: string; format?: string; language?: string | null } }) => void) => () => void;
      mcpBuildTranscriptArtifactResponse?: (payload: { requestId: string; success: boolean; result?: TranscriptArtifactProjection; error?: string }) => Promise<void>;
      onMcpGetActiveProject?: (callback: (payload: { requestId: string }) => void) => () => void;
      mcpGetActiveProjectResponse?: (payload: { requestId: string; success: boolean; result?: string | null; error?: string }) => Promise<void>;
      onMcpGetExportReadiness?: (callback: (payload: { requestId: string }) => void) => () => void;
      mcpGetExportReadinessResponse?: (payload: { requestId: string; success: boolean; result?: McpExportReadiness; error?: string }) => Promise<void>;
      grokChat?: (payload: { messages: Array<{ role: string; text: string }>; systemPrompt?: string; model?: string }) => Promise<{ ok: boolean; error?: string }>;
      onGrokChunk?: (callback: (payload: { text: string }) => void) => () => void;
      onGrokError?: (callback: (payload: { error: string; message?: string }) => void) => () => void;
      onGrokDone?: (callback: (payload: { text?: string }) => void) => () => void;
      qwenChat?: (payload: { messages: Array<{ role: string; text: string }>; systemPrompt?: string; model?: string }) => Promise<{ ok: boolean; error?: string }>;
      onQwenChunk?: (callback: (payload: { text: string }) => void) => () => void;
      onQwenError?: (callback: (payload: { error: string; message?: string }) => void) => () => void;
      onQwenDone?: (callback: (payload: { text?: string }) => void) => () => void;
    };
  }
}

// Renderer-built transcript artifact returned over the S4-C compute bridge.
export interface TranscriptArtifactProjection {
  content: string;
  fileName: string;
}

// Session snapshot consumed by the MCP list_export_options / validate_export
// preflight projections. Field names mirror the native readiness envelope.
export type McpExportReadiness = {
  sessionAvailable: boolean;
  chunkCount: number;
  originalNonEmptyCount: number;
  shortsPlanCount: number;
  sourceVideoPath: string | null;
};

export interface SourceMediaInfo {
  originalURL?: string;
  filePath: string;
  fileName: string;
  title?: string;
  kind: 'audio' | 'video';
  durationSec?: number;
  fileSizeBytes?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  videoCodec?: string;
  audioCodec?: string;
  container?: string;
  writingApplication?: string;
  overallBitrateBps?: number;
  videoBitrateBps?: number;
  audioBitrateBps?: number;
  audioSampleRateHz?: number;
  audioChannelCount?: number;
  importedAt?: string;
}
