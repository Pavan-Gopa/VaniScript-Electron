import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Settings, Download, RefreshCw, Play, Pause, FolderOpen, Share2, Trash2, Upload, Archive, ChevronDown, ChevronRight, ArrowLeft, Search } from 'lucide-react';
import { AppSettings, ChunkData, GlossaryEntry, LanguageResult, ProjectSummary, UsageStats } from './types';
import { loadSettings, saveSettings, loadUsage, applyTheme, trackUsage } from './services/storage';
import { transcribeChunkGemini, transcribeChunkOpenAI, fileToBase64 } from './services/transcription';
import { computeCutPoints, cutPointsToSeconds } from './services/smart-slicer';
import { SettingsModal } from './components/SettingsModal';
import { Workspace } from './components/Workspace';
import { ConfigPanel, SessionConfig } from './components/ConfigPanel';
import { Logo } from './components/Logo';
import { buildChunkPreview, buildTranscriptExport } from './lib/review-format';
import { audioMimeTypeForPath, createObjectAudioUrl } from './lib/audio-source';
import { TextPanel } from './components/TextPanel';
import { shouldTranslateChunk, translateTextLocally } from './services/local-translation';
import { getApiKeyForProvider, isCloudProvider, isLocalAsrProvider, isLocalTranslationProvider } from './lib/provider-runtime';
import { translateTextWithClaude, translateTextWithGemini, translateTextWithOpenAI } from './services/cloud-translation';
import { formatPlaybackClock, normalizeRelativeTimestamps, parseKaraokeLines } from './lib/karaoke';
import { addVariantsToGlossaryEntry, applyGlossaryToText, buildGlossaryPromptBlock, createGlossaryEntry } from './lib/glossary';
import { acceleratedSeekStep, bestTimedNavigationContent, nextTimedLineStart, shouldIgnoreReviewHotkeyTarget } from './lib/review-hotkeys';
import { reviewFragmentWithGeminiAudio } from './services/audio-review';
import { getAvailableTranscriptionProviders, getAvailableTranslationProviders, ProviderOption } from './lib/provider-registry';
import { polishTranslationLocally, polishTranslationWithClaude, polishTranslationWithGemini, polishTranslationWithOpenAI } from './services/literary-polish';
import { buildExportFileName } from './lib/export-filename';
import { filterGlossaryEntries, listGlossaryCategories } from './lib/glossary-management';
import {
  canOpenSidebarChunk,
  clampChunkIndex,
  isProjectExportReady,
  projectChunkNumbers,
} from './lib/project-navigation';
import { formatDocumentExportLocally, formatDocumentExportWithGemini, formatDocumentExportWithOpenAI } from './services/document-export';

type Screen = 'upload' | 'config' | 'processing' | 'review' | 'export';
type ViewMode = 'source' | 'translated' | 'dual';
type OutputFormat = 'TXT' | 'SRT' | 'VTT' | 'Markdown';

function isWavPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.wav');
}

interface Session {
  projectId?: string;
  createdAt?: string;
  updatedAt?: string;
  sourceFile: string;
  sourceFileName: string;
  wavPath: string;
  config: SessionConfig;
  chunks: ChunkData[];
  currentIndex: number;
  targetLang: string;
}

type LocalAsrSegment = { t0?: number; t1?: number; text?: string } | [number, number, string];
type GlossaryScope = 'current' | 'processed';
type GlossaryDraft = {
  mode: 'existing' | 'new';
  selectedText: string;
  lang: 'original' | 'translated';
  variants: string;
  source: string;
  translation: string;
  category: string;
  search: string;
  categoryFilter: string;
  existingEntryId?: string;
  scope: GlossaryScope;
};

function formatTimestamp(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function segmentSeconds(rawValue: unknown, chunkDurationSec: number): number {
  if (typeof rawValue === 'string') {
    const match = rawValue.trim().match(/^(?:(\d+):)?(\d{2}):(\d{2}(?:\.\d+)?)$/);
    if (match) {
      const hours = match[1] ? Number(match[1]) : 0;
      const minutes = Number(match[2]);
      const seconds = Number(match[3]);
      return (hours * 3600) + (minutes * 60) + seconds;
    }
  }
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) return 0;
  if (chunkDurationSec > 0 && value > chunkDurationSec * 100) return value / 1000;
  if (chunkDurationSec > 0 && value > chunkDurationSec * 10) return value / 100;
  return value;
}

function formatLocalTranscriptWithTimestamps(
  text: string,
  segments: LocalAsrSegment[] | undefined,
  chunkStartSec: number,
  chunkDurationSec: number
): string {
  const usableSegments = (segments || [])
    .map((segment) => {
      const start = Array.isArray(segment) ? segment[0] : segment.t0;
      const value = Array.isArray(segment) ? segment[2] : segment.text;
      return {
        startSec: chunkStartSec + segmentSeconds(start, chunkDurationSec),
        text: String(value || '').trim(),
      };
    })
    .filter((segment) => segment.text);

  if (usableSegments.length === 0) {
    const trimmed = text.trim();
    return trimmed ? `[${formatTimestamp(chunkStartSec)}] ${trimmed}` : '';
  }

  return usableSegments
    .map((segment) => `[${formatTimestamp(segment.startSec)}] ${segment.text}`)
    .join('\n\n');
}

function stripMetadataBlock(text: string): string {
  return text
    .replace(/^\s*(Date|Location|Lecturer|Interviewer \/ Participants):[^\n]*\n?/gim, '')
    .replace(/^\s*(Дата|Место|Лектор|Интервьюер \/ Участники):[^\n]*\n?/gim, '')
    .trim();
}

function localizedMetadataPrefix(cfg: SessionConfig, includeMetadata: boolean, targetLang: string): string {
  if (!includeMetadata) return '';
  const lang = targetLang.trim().toLowerCase();
  const russian = lang === 'ru' || lang === 'russian' || lang === 'русский';
  const rows = russian
    ? [
        `Дата: ${cfg.date || 'Неизвестно'}`,
        `Место: ${cfg.location || 'Неизвестно'}`,
        `Лектор: ${cfg.lecturer || 'Неизвестно'}`,
        `Интервьюер / Участники: ${cfg.participants || 'Нет'}`,
      ]
    : [
        `Date: ${cfg.date || 'Unknown'}`,
        `Location: ${cfg.location || 'Unknown'}`,
        `Lecturer: ${cfg.lecturer || 'Unknown'}`,
        `Interviewer / Participants: ${cfg.participants || 'None'}`,
      ];
  return `${rows.join('\n')}\n\n`;
}

function renderProviderOptions(options: ProviderOption[]) {
  const cloud = options.filter((option) => option.group === 'cloud');
  const local = options.filter((option) => option.group === 'local');
  return (
    <>
      {cloud.length > 0 && (
        <optgroup label="Cloud">
          {cloud.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </optgroup>
      )}
      {local.length > 0 && (
        <optgroup label="Local">
          {local.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </optgroup>
      )}
    </>
  );
}

function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil(String(text || '').length / 4));
}

function gibibytes(bytes: number): number {
  return bytes / 1024 / 1024 / 1024;
}

function localExportRecommendedMemoryBytes(modelId: string, format: OutputFormat): number {
  const id = modelId.toLowerCase();
  const markdownExtra = format === 'Markdown' ? 4 : 2;
  if (id.includes('4b')) return (24 + markdownExtra) * 1024 ** 3;
  if (id.includes('2b')) return (14 + markdownExtra) * 1024 ** 3;
  if (id.includes('0.8b') || id.includes('1b')) return (8 + markdownExtra) * 1024 ** 3;
  return (16 + markdownExtra) * 1024 ** 3;
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [usage, setUsage] = useState<UsageStats>(() => loadUsage());
  const [showSettings, setShowSettings] = useState(false);
  const [screen, setScreen] = useState<Screen>('upload');
  const [sourceFile, setSourceFile] = useState('');
  const [sourceFileName, setSourceFileName] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [procMsg, setProcMsg] = useState('');
  const [procProgress, setProcProgress] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>('dual');
  const outputFormat: OutputFormat = 'TXT';
  const [audioSrc, setAudioSrc] = useState('');
  const [audioStatus, setAudioStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [audioError, setAudioError] = useState('');
  const [audioCurrentSec, setAudioCurrentSec] = useState(0);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [subtitleMaxCharsPerLine, setSubtitleMaxCharsPerLine] = useState(42);
  const [subtitleMaxLines, setSubtitleMaxLines] = useState(2);
  const [exportingKey, setExportingKey] = useState('');
  const [glossaryDraft, setGlossaryDraft] = useState<GlossaryDraft | null>(null);
  const [editingProvider, setEditingProvider] = useState<string>(() => settings.translationProvider);
  const [projectSidebarOpen, setProjectSidebarOpen] = useState(false);
  const [projectSidebarClosing, setProjectSidebarClosing] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const isTranscribing = useRef(false);
  const autosaveTimerRef = useRef<number | null>(null);
  const autosaveSnapshotRef = useRef('');
  const projectSidebarCloseTimerRef = useRef<number | null>(null);
  const keyRepeatRef = useRef<Record<string, number>>({});
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const audioRef = useRef<HTMLAudioElement>(null);
  const currentAudioPath = useMemo(
    () => session?.chunks[session.currentIndex]?.filePath || session?.wavPath || session?.sourceFile || '',
    [session?.chunks, session?.currentIndex, session?.wavPath, session?.sourceFile]
  );
  const exportOptions = useMemo(() => ({
    targetLang: session?.targetLang,
    metadataSourceChunks: session?.chunks,
    metadataFallback: session?.config ? {
      date: session.config.date,
      location: session.config.location,
      lecturer: session.config.lecturer,
      participants: session.config.participants,
    } : undefined,
    subtitleMaxCharsPerLine,
    subtitleMaxLines,
  }), [session?.targetLang, session?.chunks, session?.config, subtitleMaxCharsPerLine, subtitleMaxLines]);

  useEffect(() => { applyTheme(settings.theme, settings.fontSize, settings.fontScale, settings.fontFamily); }, [settings.theme, settings.fontSize, settings.fontScale, settings.fontFamily]);

  const openProjectSidebar = useCallback(() => {
    if (projectSidebarCloseTimerRef.current) {
      window.clearTimeout(projectSidebarCloseTimerRef.current);
      projectSidebarCloseTimerRef.current = null;
    }
    setProjectSidebarClosing(false);
    setProjectSidebarOpen(true);
  }, []);

  const closeProjectSidebar = useCallback(() => {
    setProjectSidebarClosing(true);
    if (projectSidebarCloseTimerRef.current) window.clearTimeout(projectSidebarCloseTimerRef.current);
    projectSidebarCloseTimerRef.current = window.setTimeout(() => {
      setProjectSidebarOpen(false);
      setProjectSidebarClosing(false);
      projectSidebarCloseTimerRef.current = null;
    }, 190);
  }, []);

  useEffect(() => () => {
    if (projectSidebarCloseTimerRef.current) window.clearTimeout(projectSidebarCloseTimerRef.current);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const reconcileLocalTranslationModels = async () => {
      if (!window.electronAPI) return;

      const entries = await Promise.all(
        Object.keys(settingsRef.current.localTranslationModels).map(async (modelId) => ({
          modelId,
          result: await window.electronAPI!.localResolveTranslationModelPath({ modelId }),
        }))
      );

      if (cancelled) return;

      let changed = false;
      const nextTranslationModels = { ...settingsRef.current.localTranslationModels };
      for (const { modelId, result } of entries) {
        if (result.ok && result.path && nextTranslationModels[modelId]?.status !== 'downloaded') {
          nextTranslationModels[modelId] = {
            ...nextTranslationModels[modelId],
            status: 'downloaded',
            path: result.path,
            error: undefined,
          };
          changed = true;
        }
      }

      if (!changed) return;

      const nextSettings = {
        ...settingsRef.current,
        localTranslationModels: nextTranslationModels,
      };
      saveSettings(nextSettings);
      setSettings(nextSettings);
    };

    reconcileLocalTranslationModels();
    return () => { cancelled = true; };
  }, []);

  const refreshProjects = useCallback(async () => {
    if (!window.electronAPI?.projectList) return;
    const result = await window.electronAPI.projectList();
    if (result.ok && result.projects) setProjects(result.projects);
  }, []);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    if (!session || !window.electronAPI?.projectSave || (screen !== 'review' && screen !== 'export')) return;
    const snapshot = JSON.stringify({ screen, session });
    if (snapshot === autosaveSnapshotRef.current) return;
    if (autosaveTimerRef.current) window.clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = window.setTimeout(async () => {
      const currentSnapshot = JSON.stringify({ screen, session });
      autosaveSnapshotRef.current = currentSnapshot;
      const result = await window.electronAPI?.projectSave({
        id: session.projectId,
        name: session.sourceFileName.replace(/\.[^/.]+$/, '') || 'Untitled Project',
        createdAt: session.createdAt,
        screen,
        session,
      });
      if (result?.ok && result.project?.session) {
        setSession((prev) => {
          if (!prev) return prev;
          if (prev.projectId && prev.projectId === result.project.session.projectId) return prev;
          return result.project.session as Session;
        });
        void refreshProjects();
      }
    }, 900);
    return () => {
      if (autosaveTimerRef.current) window.clearTimeout(autosaveTimerRef.current);
    };
  }, [refreshProjects, screen, session]);

  useEffect(() => {
    let revokedUrl = '';
    let cancelled = false;

    const loadChunkAudio = async () => {
      if (!currentAudioPath) {
        setAudioSrc('');
        setAudioStatus('idle');
        setAudioError('');
        return;
      }

      if (!window.electronAPI) {
        setAudioSrc('');
        setAudioStatus('error');
        setAudioError('Electron file access is unavailable.');
        return;
      }

      setAudioStatus('loading');
      setAudioError('');
      setAudioCurrentSec(0);
      setAudioPlaying(false);

      const directUrl = await window.electronAPI.pathToFileUrl?.({ filePath: currentAudioPath });
      if (directUrl?.success && directUrl.url) {
        if (!cancelled) {
          setAudioSrc(directUrl.url);
          setAudioStatus('ready');
        }
        return;
      }

      const result = await window.electronAPI.readFileBuffer({ filePath: currentAudioPath });
      if (!result.success) {
        console.error('Failed to read audio for player:', result.error || currentAudioPath);
        if (!cancelled) {
          setAudioSrc('');
          setAudioStatus('error');
          setAudioError(result.error || 'Failed to read audio file.');
        }
        return;
      }

      const bytes = new Uint8Array(result.data, result.byteOffset, result.byteLength);
      const objectUrl = createObjectAudioUrl(bytes, audioMimeTypeForPath(currentAudioPath));
      revokedUrl = objectUrl;

      if (!cancelled) {
        setAudioSrc(objectUrl);
        setAudioStatus('ready');
      } else {
        URL.revokeObjectURL(objectUrl);
      }
    };

    loadChunkAudio();

    return () => {
      cancelled = true;
      if (revokedUrl) URL.revokeObjectURL(revokedUrl);
    };
  }, [currentAudioPath]);

  useEffect(() => {
    if (!session || !audioRef.current) return;
    const chunk = session.chunks[session.currentIndex];
    if (!chunk) return;

    const audio = audioRef.current;
    const seekToChunk = () => {
      audio.currentTime = 0;
      setAudioCurrentSec(0);
      setAudioPlaying(false);
    };

    if (audio.readyState >= 1) {
      seekToChunk();
    } else {
      audio.addEventListener('loadedmetadata', seekToChunk, { once: true });
    }

    return () => {
      audio.removeEventListener('loadedmetadata', seekToChunk);
    };
  }, [session?.currentIndex, currentAudioPath]);

  const seekCurrentAudio = useCallback((relativeSec: number) => {
    const activeChunk = session?.chunks[session.currentIndex];
    const audio = audioRef.current;
    if (!activeChunk || !audio || audioStatus !== 'ready') return;
    const next = Math.min(Math.max(relativeSec, 0), activeChunk.durationSec);
    audio.currentTime = next;
    setAudioCurrentSec(next);
  }, [audioStatus, session]);

  const toggleCurrentAudio = useCallback(async () => {
    const activeChunk = session?.chunks[session.currentIndex];
    const audio = audioRef.current;
    if (!activeChunk || !audio || audioStatus !== 'ready') return;
    if (audio.paused) {
      if (audio.currentTime >= activeChunk.durationSec) {
        audio.currentTime = 0;
        setAudioCurrentSec(0);
      }
      await audio.play();
    } else {
      audio.pause();
    }
  }, [audioStatus, session]);

  useEffect(() => {
    if (screen !== 'review' || !session) return;

    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        showSettings ||
        glossaryDraft ||
        shouldIgnoreReviewHotkeyTarget(target) ||
        target?.closest?.('.modal-overlay, .glossary-modal-backdrop')
      ) {
        return;
      }

      const chunk = session.chunks[session.currentIndex];
      if (!chunk) return;

      if (event.key === ' ') {
        event.preventDefault();
        void toggleCurrentAudio();
        return;
      }

      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        const repeatCount = event.repeat ? (keyRepeatRef.current[event.key] ?? 0) + 1 : 0;
        keyRepeatRef.current[event.key] = repeatCount;
        const currentOffsetSec = audioRef.current?.currentTime ?? audioCurrentSec;
        seekCurrentAudio(currentOffsetSec + (direction * acceleratedSeekStep(event.repeat, repeatCount)));
        return;
      }

      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const currentOffsetSec = audioRef.current?.currentTime ?? audioCurrentSec;
        const originalNavigationText = buildChunkPreview(chunk, 'original', 'TXT');
        const translatedNavigationText = buildChunkPreview(chunk, 'translated', 'TXT');
        const contentForNavigation = bestTimedNavigationContent(originalNavigationText, translatedNavigationText);
        const lines = parseKaraokeLines(contentForNavigation, chunk.startSec, chunk.endSec);
        const nextStart = nextTimedLineStart(lines, chunk.startSec + currentOffsetSec, direction);
        if (nextStart !== null) {
          seekCurrentAudio(nextStart - chunk.startSec);
        }
      }
    };

    const keyup = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        keyRepeatRef.current[event.key] = 0;
      }
    };

    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
    };
  }, [audioCurrentSec, glossaryDraft, screen, seekCurrentAudio, session, showSettings, toggleCurrentAudio]);

  const handleSaveSettings = (nextSettings: AppSettings) => {
    saveSettings(nextSettings);
    setSettings(nextSettings);

    setSession(prev => {
      if (!prev) return prev;
      const transcriptionProviders = getAvailableTranscriptionProviders(nextSettings);
      const transcriptionProvider = transcriptionProviders.some((provider) => provider.id === nextSettings.transcriptionProvider)
        ? nextSettings.transcriptionProvider
        : prev.config.transcriptionProvider;

      const translationProviders = getAvailableTranslationProviders(nextSettings, prev.targetLang).providers;
      const translationProvider = shouldTranslateChunk(prev.targetLang) && translationProviders.some((provider) => provider.id === nextSettings.translationProvider)
        ? nextSettings.translationProvider
        : prev.config.translationProvider;

      return {
        ...prev,
        config: {
          ...prev.config,
          transcriptionProvider,
          translationProvider,
        },
      };
    });

    const currentTargetLang = session?.targetLang ?? nextSettings.defaultTargetLang;
    const editingOptions = getAvailableTranslationProviders(nextSettings, currentTargetLang).providers;
    if (editingOptions.some((provider) => provider.id === nextSettings.translationProvider)) {
      setEditingProvider(nextSettings.translationProvider);
    }
  };

  const editingProviders = useMemo(
    () => getAvailableTranslationProviders(settings, session?.targetLang ?? settings.defaultTargetLang).providers,
    [settings, session?.targetLang]
  );
  const glossaryCategories = useMemo(() => listGlossaryCategories(settings.glossary), [settings.glossary]);
  const glossaryDraftMatches = useMemo(() => {
    if (!glossaryDraft || glossaryDraft.mode !== 'existing') return [];
    if (!glossaryDraft.search.trim() && glossaryDraft.categoryFilter === 'all') return [];
    return filterGlossaryEntries(settings.glossary, glossaryDraft.search, glossaryDraft.categoryFilter).slice(0, 20);
  }, [glossaryDraft, settings.glossary]);

  const recordCloudUsage = useCallback((
    providerId: string,
    delta: { inputText?: string; outputText?: string; inputTokens?: number; outputTokens?: number; audioMinutes?: number }
  ) => {
    if (!isCloudProvider(providerId)) return;
    setUsage((prev) => trackUsage(prev, providerId, {
      inputTokens: delta.inputTokens ?? estimateTokens(delta.inputText ?? ''),
      outputTokens: delta.outputTokens ?? estimateTokens(delta.outputText ?? ''),
      audioMinutes: delta.audioMinutes ?? 0,
    }));
  }, []);

  useEffect(() => {
    if (editingProviders.length === 0) return;
    if (!editingProviders.some((provider) => provider.id === editingProvider)) {
      setEditingProvider(editingProviders[0].id);
    }
  }, [editingProvider, editingProviders]);

  const handleFileSelected = (path: string, name: string) => {
    setSourceFile(path); setSourceFileName(name); setScreen('config');
  };

  const buildMetadataPrefix = useCallback((cfg: SessionConfig, includeMetadata: boolean) => {
    if (!includeMetadata) return '';
    return [
      `Date: ${cfg.date || 'Unknown'}`,
      `Location: ${cfg.location || 'Unknown'}`,
      `Lecturer: ${cfg.lecturer || 'Unknown'}`,
      `Interviewer / Participants: ${cfg.participants || 'None'}`,
      '',
    ].join('\n');
  }, []);

  const applyGlossaryEntryToChunk = useCallback((chunk: ChunkData, entry: GlossaryEntry): ChunkData => {
    const original = applyGlossaryToText(chunk.original, [entry], 'source').text;
    const translated = applyGlossaryToText(chunk.translated, [entry], 'translation').text;
    const applyFormats = (formats: LanguageResult | undefined, target: 'source' | 'translation') => {
      if (!formats) return formats;
      return Object.fromEntries(
        Object.entries(formats).map(([key, value]) => [
          key,
          typeof value === 'string' ? applyGlossaryToText(value, [entry], target).text : value,
        ])
      ) as LanguageResult;
    };

    return {
      ...chunk,
      original,
      translated,
      originalFormats: applyFormats(chunk.originalFormats, 'source'),
      translatedFormats: applyFormats(chunk.translatedFormats, 'translation'),
    };
  }, []);

  const openGlossaryDraft = useCallback((selectedText: string, lang: 'original' | 'translated') => {
    const cleaned = selectedText.replace(/\s+/g, ' ').trim();
    if (!cleaned) return;
    setGlossaryDraft({
      mode: 'existing',
      selectedText: cleaned,
      lang,
      variants: cleaned,
      source: lang === 'original' ? cleaned : '',
      translation: lang === 'translated' ? cleaned : '',
      category: '',
      search: '',
      categoryFilter: 'all',
      existingEntryId: undefined,
      scope: 'processed',
    });
  }, []);

  const canSaveGlossaryDraft = useCallback((draft: GlossaryDraft | null) => {
    if (!draft) return false;
    if (draft.mode === 'existing') return Boolean(draft.existingEntryId && draft.variants.trim());
    return Boolean(draft.source.trim() || draft.translation.trim());
  }, []);

  const saveGlossaryDraft = useCallback(() => {
    if (!glossaryDraft) return;
    const variants = glossaryDraft.variants.split(/[,;\n]/);
    let entry: GlossaryEntry | null = null;
    let nextGlossary = settingsRef.current.glossary;

    if (glossaryDraft.mode === 'existing') {
      if (!glossaryDraft.existingEntryId) return;
      const existing = settingsRef.current.glossary.find((item) => item.id === glossaryDraft.existingEntryId);
      if (!existing) return;
      entry = addVariantsToGlossaryEntry(existing, variants);
      nextGlossary = settingsRef.current.glossary.map((item) => item.id === entry?.id ? entry as GlossaryEntry : item);
    } else {
      entry = createGlossaryEntry({
        variants,
        source: glossaryDraft.source,
        translation: glossaryDraft.translation,
        category: glossaryDraft.category,
        translations: glossaryDraft.translation.trim() && session?.targetLang && session.targetLang !== 'same'
          ? { [session.targetLang]: glossaryDraft.translation.trim() }
          : undefined,
        remember: true,
      });
      nextGlossary = [...settingsRef.current.glossary, entry];
    }
    if (!entry.source && !entry.translation) return;

    const nextSettings = {
      ...settingsRef.current,
      glossary: nextGlossary,
    };
    saveSettings(nextSettings);
    setSettings(nextSettings);

    setSession(prev => {
      if (!prev) return prev;
      const chunks = prev.chunks.map((chunk) => {
        const shouldApply = glossaryDraft.scope === 'current'
          ? chunk.index === prev.currentIndex
          : chunk.status === 'done' || chunk.index === prev.currentIndex;
        return shouldApply ? applyGlossaryEntryToChunk(chunk, entry) : chunk;
      });
      return { ...prev, chunks };
    });
    setGlossaryDraft(null);
  }, [applyGlossaryEntryToChunk, glossaryDraft, session?.targetLang]);

  const runAudioAwareReview = useCallback(async (
    selectedText: string,
    mode: 'original' | 'translated'
  ): Promise<string> => {
    if (!session || !window.electronAPI) return selectedText;
    if (!settingsRef.current.geminiKey) {
      alert('Audio-Aware Review currently requires a Gemini API key in Settings.');
      return selectedText;
    }

    const chunk = session.chunks[session.currentIndex];
    if (!chunk?.filePath) return selectedText;

    const file = await window.electronAPI.readFileBuffer({ filePath: chunk.filePath });
    if (!file.success) {
      throw new Error(file.error || 'Could not read chunk audio for review.');
    }

    const blob = new Blob(
      [new Uint8Array(file.data, file.byteOffset, file.byteLength)],
      { type: audioMimeTypeForPath(chunk.filePath) }
    );
    const audioBase64 = await fileToBase64(blob);

    return reviewFragmentWithGeminiAudio({
      audioBase64,
      mimeType: blob.type,
      selectedText,
      mode,
      targetLang: session.targetLang,
      apiKey: settingsRef.current.geminiKey,
      speakerHint: session.config.lecturer,
      glossaryBlock: buildGlossaryPromptBlock(settingsRef.current.glossary),
    });
  }, [session]);

  const runLiteraryPolish = useCallback(async (selectedText: string): Promise<string> => {
    if (!session) return selectedText;
    const providerId = editingProvider || session.config.translationProvider;
    const glossaryBlock = buildGlossaryPromptBlock(settingsRef.current.glossary);
    const base = {
      text: selectedText,
      targetLang: session.targetLang,
      speakerHint: session.config.lecturer,
      glossaryBlock,
    };

    if (isLocalTranslationProvider(settingsRef.current, providerId)) {
      return polishTranslationLocally({ ...base, modelId: providerId });
    }

    const apiKey = getApiKeyForProvider(settingsRef.current, providerId);
    if (!apiKey) {
      alert('Selected editing model has no API key configured.');
      return selectedText;
    }

    let polished = selectedText;
    switch (providerId) {
      case 'gemini-cloud':
        polished = await polishTranslationWithGemini({ ...base, apiKey });
        break;
      case 'gpt-cloud':
        polished = await polishTranslationWithOpenAI({ ...base, apiKey });
        break;
      case 'claude-cloud':
        polished = await polishTranslationWithClaude({ ...base, apiKey });
        break;
      default:
        throw new Error(`Unsupported editing model: ${providerId}`);
    }

    recordCloudUsage(providerId, { inputText: selectedText, outputText: polished });
    return polished;
  }, [editingProvider, recordCloudUsage, session]);

  const translateWithProvider = useCallback(async (
    originalText: string,
    cfg: SessionConfig
  ) => {
    if (!shouldTranslateChunk(cfg.targetLang)) {
      return '';
    }

    const providerId = cfg.translationProvider;
    if (!providerId) {
      throw new Error('Translation is enabled, but no translation model is selected.');
    }

    if (isLocalTranslationProvider(settingsRef.current, providerId)) {
      return translateTextLocally({
        modelId: providerId,
        text: stripMetadataBlock(originalText),
        targetLang: cfg.targetLang,
        speakerHint: cfg.lecturer,
        glossaryBlock: buildGlossaryPromptBlock(settingsRef.current.glossary),
      });
    }

    const apiKey = getApiKeyForProvider(settingsRef.current, providerId);
    if (!apiKey) {
      throw new Error('The selected translation provider has no API key configured.');
    }

    switch (providerId) {
      case 'gemini-cloud':
        return translateTextWithGemini(stripMetadataBlock(originalText), cfg.targetLang, apiKey, cfg.lecturer, buildGlossaryPromptBlock(settingsRef.current.glossary));
      case 'gpt-cloud':
        return translateTextWithOpenAI(stripMetadataBlock(originalText), cfg.targetLang, apiKey, cfg.lecturer, buildGlossaryPromptBlock(settingsRef.current.glossary));
      case 'claude-cloud':
        return translateTextWithClaude(stripMetadataBlock(originalText), cfg.targetLang, apiKey, cfg.lecturer, buildGlossaryPromptBlock(settingsRef.current.glossary));
      default:
        throw new Error(`Unsupported translation provider: ${providerId}`);
    }
  }, []);

  // ─── Transcribe one chunk ─────────────────────────────────────────────────
  const doTranscribe = useCallback(async (
    chunkFilePath: string,
    chunkIndex: number,
    cfg: SessionConfig,
    transcriptionApiKey: string,
    chunkStartSec = 0,
    chunkDurationSec = 0
  ) => {
    if (isTranscribing.current) return;
    isTranscribing.current = true;

    setSession(prev => {
      if (!prev) return prev;
      const c = [...prev.chunks];
      c[chunkIndex] = { ...c[chunkIndex], status: 'processing' };
      return { ...prev, chunks: c };
    });

    try {
      const transcConfig = {
        sourceLang: settingsRef.current.defaultSourceLang,
        targetLang: '',
        speakerHint: cfg.lecturer,
        formats: ['TXT'],
        metadata: {
          date: cfg.date,
          location: cfg.location,
          lecturer: cfg.lecturer,
          participants: cfg.participants,
        },
        includeMetadata: chunkIndex === 0,
      };

      let original = '', translated = '';
      let originalFormats = undefined;
      let translatedFormats = undefined;
      let unrecognizedFragments: string[] = [];

      if (cfg.transcriptionProvider === 'gemini-cloud') {
        // Read file via Electron IPC
        let blob: Blob;
        if (window.electronAPI) {
          const r = await window.electronAPI.readFileBuffer({ filePath: chunkFilePath });
          if (!r.success) throw new Error('Could not read audio file');
          blob = new Blob(
            [new Uint8Array(r.data, r.byteOffset, r.byteLength)],
            { type: audioMimeTypeForPath(chunkFilePath) }
          );
        } else {
          throw new Error('File reading requires Electron');
        }
        const b64 = await fileToBase64(blob);
        if (!b64) throw new Error('Failed to encode audio');
        ({ original, originalFormats, unrecognizedFragments } = await transcribeChunkGemini(b64, blob.type, transcConfig, transcriptionApiKey));
        recordCloudUsage(cfg.transcriptionProvider, {
          inputTokens: Math.ceil((chunkDurationSec / 60) * 1000),
          outputText: original,
          audioMinutes: chunkDurationSec / 60,
        });
      } else if (cfg.transcriptionProvider === 'gpt-cloud') {
        let blob: Blob;
        if (window.electronAPI) {
          const r = await window.electronAPI.readFileBuffer({ filePath: chunkFilePath });
          if (!r.success) throw new Error('Could not read audio file');
          blob = new Blob([new Uint8Array(r.data, r.byteOffset, r.byteLength)], { type: 'audio/wav' });
        } else {
          throw new Error('File reading requires Electron');
        }
        ({ original, originalFormats, unrecognizedFragments } = await transcribeChunkOpenAI(blob, transcConfig, transcriptionApiKey));
        recordCloudUsage(cfg.transcriptionProvider, {
          inputTokens: Math.ceil((chunkDurationSec / 60) * 1000),
          outputText: original,
          audioMinutes: chunkDurationSec / 60,
        });
      } else if (cfg.transcriptionProvider === 'claude-cloud') {
        throw new Error('Claude Cloud transcription is not implemented yet.');
      } else if (isLocalAsrProvider(settingsRef.current, cfg.transcriptionProvider)) {
        if (!window.electronAPI) {
          throw new Error('Local transcription requires the Electron runtime.');
        }
        const local = await window.electronAPI.localTranscribeChunk({
          modelId: cfg.transcriptionProvider,
          chunkPath: chunkFilePath,
          options: {
            language: settingsRef.current.defaultSourceLang === 'auto' ? undefined : settingsRef.current.defaultSourceLang,
          },
        });
        original = formatLocalTranscriptWithTimestamps(local.text?.trim() ?? '', local.segments, chunkStartSec, chunkDurationSec);
        originalFormats = {
          TXT: `${buildMetadataPrefix(cfg, chunkIndex === 0)}${original}`.trim(),
        };
      } else {
        throw new Error(`Unsupported transcription provider: ${cfg.transcriptionProvider}`);
      }

      if (settingsRef.current.glossary.length > 0) {
        original = normalizeRelativeTimestamps(original, chunkStartSec, chunkStartSec + chunkDurationSec);
        original = applyGlossaryToText(original, settingsRef.current.glossary, 'source').text;
        if (originalFormats?.TXT) {
          originalFormats = {
            ...originalFormats,
            TXT: applyGlossaryToText(normalizeRelativeTimestamps(originalFormats.TXT, chunkStartSec, chunkStartSec + chunkDurationSec), settingsRef.current.glossary, 'source').text,
          };
        }
      } else {
        original = normalizeRelativeTimestamps(original, chunkStartSec, chunkStartSec + chunkDurationSec);
        if (originalFormats?.TXT) {
          originalFormats = {
            ...originalFormats,
            TXT: normalizeRelativeTimestamps(originalFormats.TXT, chunkStartSec, chunkStartSec + chunkDurationSec),
          };
        }
      }

      if (shouldTranslateChunk(cfg.targetLang)) {
        translated = await translateWithProvider(original, cfg);
        recordCloudUsage(cfg.translationProvider, {
          inputText: stripMetadataBlock(original),
          outputText: translated,
        });
        translated = normalizeRelativeTimestamps(translated, chunkStartSec, chunkStartSec + chunkDurationSec);
        if (settingsRef.current.glossary.length > 0) {
          translated = applyGlossaryToText(translated, settingsRef.current.glossary, 'translation').text;
        }
        translatedFormats = {
          TXT: `${localizedMetadataPrefix(cfg, chunkIndex === 0, cfg.targetLang)}${stripMetadataBlock(translated)}`.trim(),
        };
      }

      setSession(prev => {
        if (!prev) return prev;
        const c = [...prev.chunks];
        c[chunkIndex] = {
          ...c[chunkIndex],
          original,
          translated,
          originalFormats,
          translatedFormats,
          unrecognizedFragments,
          status: 'done',
        };
        return { ...prev, chunks: c };
      });
    } catch (err: any) {
      console.error(`Chunk ${chunkIndex} failed:`, err);
      setSession(prev => {
        if (!prev) return prev;
        const c = [...prev.chunks];
        c[chunkIndex] = { ...c[chunkIndex], status: 'error', original: `Error: ${err?.message ?? err}` };
        return { ...prev, chunks: c };
      });
    } finally {
      isTranscribing.current = false;
    }
  }, [buildMetadataPrefix, recordCloudUsage, translateWithProvider]);

  // ─── Start engine ─────────────────────────────────────────────────────────
  const handleStartEngine = async (cfg: SessionConfig) => {
    const transcriptionApiKey = getApiKeyForProvider(settings, cfg.transcriptionProvider);
    if (isCloudProvider(cfg.transcriptionProvider) && !transcriptionApiKey) {
      alert('Please add the API key for the selected transcription provider in Settings first.');
      return;
    }

    if (shouldTranslateChunk(cfg.targetLang) && !cfg.translationProvider) {
      alert('Choose a translation model or set target language to Same.');
      return;
    }

    if (shouldTranslateChunk(cfg.targetLang) && isCloudProvider(cfg.translationProvider)) {
      const translationApiKey = getApiKeyForProvider(settings, cfg.translationProvider);
      if (!translationApiKey) {
        alert('Please add the API key for the selected translation provider in Settings first.');
        return;
      }
    }

    setScreen('processing');
    setProcProgress(5);
    setProcMsg('Converting audio format…');

    try {
      // 1. Convert to WAV 16kHz mono (with graceful fallback)
      let wavPath = sourceFile;
      if (window.electronAPI) {
        setProcMsg('Converting audio to WAV 16kHz…');
        const res = await window.electronAPI.ffmpegConvertToWav({ inputPath: sourceFile });
        if (res.success) {
          wavPath = res.outputPath;
        } else {
          // Fallback: use original file directly — Gemini accepts most formats
          console.warn('FFmpeg conversion failed, using original file:', res.error);
          setProcMsg('Using original audio format…');
        }
      }
      setProcProgress(25);

      // 2. Get duration
      let durationSec = settings.chunkDurationMin * 60;
      if (window.electronAPI) {
        const dur = await window.electronAPI.ffmpegGetDuration({ inputPath: wavPath });
        if (dur.success && dur.durationSec > 0) durationSec = dur.durationSec;
      }
      setProcProgress(40);

      // 3. Compute cut points
      setProcMsg('Analyzing audio for optimal split points…');
      let cutSec: number[] = [];
      const targetMs = settings.chunkDurationMin * 60 * 1000;

      if (settings.sliceMode === 'silence' && window.electronAPI && isWavPath(wavPath)) {
        try {
          const buf = await window.electronAPI.readFileBuffer({ filePath: wavPath });
          if (buf.success && buf.byteLength > 0) {
            const pcm = new Int16Array(buf.data, buf.byteOffset, Math.floor(buf.byteLength / 2));
            cutSec = cutPointsToSeconds(computeCutPoints(pcm, 16000, targetMs, settings.silenceThreshDb, settings.minSilenceMs));
          }
        } catch { /* fall through to fixed */ }
      }

      // Fixed interval fallback
      if (cutSec.length === 0) {
        for (let t = settings.chunkDurationMin * 60; t < durationSec - 30; t += settings.chunkDurationMin * 60) {
          cutSec.push(Math.round(t));
        }
      }
      setProcProgress(60);

      // 4. Slice audio
      setProcMsg(`Creating ${cutSec.length + 1} audio segment(s)…`);
      let chunkPaths: string[] = [wavPath];
      if (window.electronAPI && cutSec.length > 0) {
        const sliceRes = await window.electronAPI.ffmpegSliceChunks({ inputPath: wavPath, cutPoints: cutSec });
        if (sliceRes.success && sliceRes.chunkPaths.length > 0) chunkPaths = sliceRes.chunkPaths;
      }
      setProcProgress(80);

      // 5. Build chunk objects
      const bounds = [0, ...cutSec, durationSec];
      const chunks: ChunkData[] = chunkPaths.map((fp, i) => ({
        index: i, filePath: fp,
        durationSec: (bounds[i + 1] ?? durationSec) - bounds[i],
        startSec: bounds[i],
        endSec: bounds[i + 1] ?? durationSec,
        original: '', translated: '', status: 'pending' as const, approved: false,
      }));

      setProcMsg('Uploading audio and initializing AI…');
      setProcProgress(90);

      const newSession: Session = {
        sourceFile, sourceFileName, wavPath, config: cfg, chunks,
        currentIndex: 0, targetLang: cfg.targetLang,
      };

      setSession(newSession);
      setProcProgress(100);
      setScreen('review');

      // Start transcribing first chunk
      doTranscribe(chunks[0].filePath, 0, cfg, transcriptionApiKey, chunks[0].startSec, chunks[0].durationSec);

    } catch (err: any) {
      console.error('Engine start failed:', err);
      setProcMsg(`Error: ${err?.message ?? String(err)}`);
      setTimeout(() => setScreen('config'), 3000);
    }
  };

  // ─── Handle chunk actions ─────────────────────────────────────────────────
  const handleApproveAndNext = () => {
    if (!session) return;
    const activeConfig = {
      ...session.config,
      transcriptionProvider: settingsRef.current.transcriptionProvider || session.config.transcriptionProvider,
      translationProvider: shouldTranslateChunk(session.targetLang)
        ? (settingsRef.current.translationProvider || session.config.translationProvider)
        : session.config.translationProvider,
    };
    const { currentIndex, chunks } = session;
    const nextIdx = currentIndex + 1;
    const transcriptionApiKey = getApiKeyForProvider(settingsRef.current, activeConfig.transcriptionProvider);

    setSession(prev => {
      if (!prev) return prev;
      const c = [...prev.chunks];
      c[currentIndex] = { ...c[currentIndex], approved: true };
      return { ...prev, config: activeConfig, chunks: c, currentIndex: Math.min(nextIdx, c.length - 1) };
    });

    if (nextIdx >= chunks.length) { setScreen('export'); return; }

    const nextChunk = chunks[nextIdx];
    if (nextChunk?.status === 'pending') {
      setTimeout(() => doTranscribe(nextChunk.filePath, nextIdx, activeConfig, transcriptionApiKey, nextChunk.startSec, nextChunk.durationSec), 50);
    }
  };

  const handleRetry = (index: number) => {
    if (!session) return;
    const activeConfig = {
      ...session.config,
      transcriptionProvider: settingsRef.current.transcriptionProvider || session.config.transcriptionProvider,
      translationProvider: shouldTranslateChunk(session.targetLang)
        ? (settingsRef.current.translationProvider || session.config.translationProvider)
        : session.config.translationProvider,
    };
    const transcriptionApiKey = getApiKeyForProvider(settingsRef.current, activeConfig.transcriptionProvider);
    const chunk = session.chunks[index];
    setSession(prev => prev ? { ...prev, config: activeConfig } : prev);
    doTranscribe(chunk.filePath, index, activeConfig, transcriptionApiKey, chunk.startSec, chunk.durationSec);
  };

  const openProject = async (
    id: string,
    options: { chunkIndex?: number; screen?: Extract<Screen, 'review' | 'export'> } = {},
  ) => {
    const result = await window.electronAPI?.projectLoad({ id });
    if (!result?.ok || !result.project?.session) {
      alert(result?.error || 'Could not open project.');
      return;
    }
    const loadedProjectSession = result.project.session as Session;
    const nextIndex = typeof options.chunkIndex === 'number'
      ? clampChunkIndex(options.chunkIndex, loadedProjectSession.chunks.length)
      : clampChunkIndex(loadedProjectSession.currentIndex, loadedProjectSession.chunks.length);
    const loaded = { ...loadedProjectSession, currentIndex: nextIndex };
    setSourceFile(loaded.sourceFile);
    setSourceFileName(loaded.sourceFileName);
    setSession(loaded);
    setScreen(options.screen ?? (typeof options.chunkIndex === 'number' ? 'review' : (result.project.screen === 'export' ? 'export' : 'review')));
    closeProjectSidebar();
  };

  const toggleProjectExpanded = (projectId: string) => {
    setExpandedProjectId((current) => current === projectId ? null : projectId);
  };

  const openCurrentSessionChunk = (chunkIndex: number) => {
    const nextIndex = clampChunkIndex(chunkIndex, session?.chunks.length ?? 0);
    setSession((prev) => {
      if (!prev) return prev;
      return { ...prev, currentIndex: nextIndex };
    });
    setScreen('review');
    closeProjectSidebar();
  };

  const openProjectChunk = (project: ProjectSummary, chunkIndex: number) => {
    if (!canOpenSidebarChunk(chunkIndex, project.currentIndex, project.totalChunks)) return;
    if (session?.projectId === project.id) {
      openCurrentSessionChunk(chunkIndex);
      return;
    }
    void openProject(project.id, { chunkIndex, screen: 'review' });
  };

  const openProjectExport = (project: ProjectSummary) => {
    if (!isProjectExportReady(project.totalChunks, project.approvedChunks)) return;
    if (session?.projectId === project.id) {
      setScreen('export');
      closeProjectSidebar();
      return;
    }
    void openProject(project.id, { screen: 'export' });
  };

  const importProject = async () => {
    const result = await window.electronAPI?.projectImport();
    if (!result?.ok || !result.project?.session) {
      if (result?.error && result.error !== 'Import cancelled') alert(result.error);
      return;
    }
    await refreshProjects();
    const loaded = result.project.session as Session;
    setSourceFile(loaded.sourceFile);
    setSourceFileName(loaded.sourceFileName);
    setSession(loaded);
    setScreen(result.project.screen === 'export' ? 'export' : 'review');
    closeProjectSidebar();
  };

  const deleteProject = async (id: string) => {
    if (!confirm('Delete this saved VaniScript project? This cannot be undone.')) return;
    const result = await window.electronAPI?.projectDelete({ id });
    if (!result?.ok) {
      alert(result?.error || 'Could not delete project.');
      return;
    }
    if (session?.projectId === id) {
      setSession(null);
      setSourceFile('');
      setSourceFileName('');
      setScreen('upload');
    }
    await refreshProjects();
  };

  const exportProject = async (id: string) => {
    const result = await window.electronAPI?.projectExport({ id });
    if (!result?.ok && result?.error !== 'Export cancelled') alert(result?.error || 'Project export failed.');
  };

  const exportAllProjects = async () => {
    const result = await window.electronAPI?.projectExportAll();
    if (!result?.ok && result?.error !== 'Export cancelled') alert(result?.error || 'Library export failed.');
  };

  const clearProjectArchive = async () => {
    if (!confirm('Delete every saved VaniScript project from the archive? This cannot be undone.')) return;
    const result = await window.electronAPI?.projectClearAll();
    if (!result?.ok) {
      alert(result?.error || 'Could not clear project archive.');
      return;
    }
    setSession(null);
    setSourceFile('');
    setSourceFileName('');
    setScreen('upload');
    await refreshProjects();
  };

  const handleUpdateChunk = (index: number, patch: Partial<ChunkData>) => {
    setSession(prev => {
      if (!prev) return prev;
      const c = [...prev.chunks]; c[index] = { ...c[index], ...patch };
      return { ...prev, chunks: c };
    });
  };

  const download = (content: string, name: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  const confirmLocalExportCapacity = async (providerId: string, format: OutputFormat): Promise<boolean> => {
    if (format === 'TXT' || !isLocalTranslationProvider(settingsRef.current, providerId)) return true;
    let memory: Awaited<ReturnType<NonNullable<typeof window.electronAPI>['getSystemMemoryInfo']>> | undefined;
    try {
      memory = await window.electronAPI?.getSystemMemoryInfo?.();
    } catch (error) {
      console.warn('Could not read system memory for local export preflight; continuing export.', error);
      return true;
    }
    if (!memory?.totalBytes) return true;
    const recommendedBytes = localExportRecommendedMemoryBytes(providerId, format);
    if (memory.totalBytes >= recommendedBytes) return true;
    const totalGb = gibibytes(memory.totalBytes).toFixed(1);
    const recommendedGb = gibibytes(recommendedBytes).toFixed(0);
    return confirm([
      `Local AI ${format} export may be unstable on this computer.`,
      '',
      `Installed unified/system memory: ${totalGb} GB`,
      `Recommended for this model/export: ${recommendedGb} GB`,
      '',
      'Use Gemini/OpenAI export for this document, or continue locally anyway?',
    ].join('\n'));
  };

  const buildAiExport = async (which: 'original' | 'translated', format: OutputFormat, baseText: string): Promise<string> => {
    if (!session || format === 'TXT') return baseText;
    const providerId = editingProvider || session.config.translationProvider;
    const targetLang = which === 'translated' ? session.targetLang : (session.config.targetLang === 'same' ? 'English' : session.config.targetLang);
    const base = {
      format,
      targetLang,
      text: baseText,
      subtitleMaxCharsPerLine,
      subtitleMaxLines,
    };

    try {
      if (isLocalTranslationProvider(settingsRef.current, providerId)) {
        const result = await formatDocumentExportLocally({ ...base, modelId: providerId });
        return result.trim() || baseText;
      }

      const apiKey = getApiKeyForProvider(settingsRef.current, providerId);
      if (!apiKey) return baseText;

      if (providerId === 'gemini-cloud') {
        const result = await formatDocumentExportWithGemini({ ...base, apiKey });
        recordCloudUsage(providerId, { inputText: baseText, outputText: result });
        return result.trim() || baseText;
      }
      if (providerId === 'gpt-cloud') {
        const result = await formatDocumentExportWithOpenAI({ ...base, apiKey });
        recordCloudUsage(providerId, { inputText: baseText, outputText: result });
        return result.trim() || baseText;
      }
    } catch (error) {
      console.warn('AI document export failed; falling back to deterministic export.', error);
    }

    return baseText;
  };

  const handleExportDownload = async (which: 'original' | 'translated', format: OutputFormat) => {
    if (!session) return;
    const key = `${which}-${format}`;
    const providerId = editingProvider || session.config.translationProvider;
    try {
      const canContinue = await confirmLocalExportCapacity(providerId, format);
      if (!canContinue) return;
      setExportingKey(key);
      const baseText = buildTranscriptExport(which, format, session.chunks, exportOptions);
      const content = await buildAiExport(which, format, baseText);
      const fileName = buildExportFileName({
        sourceFileName: session.sourceFileName,
        lecturer: session.config.lecturer,
        location: session.config.location,
        date: session.config.date,
        which,
        targetLang: which === 'translated' ? session.targetLang : undefined,
        format,
      });
      download(content, fileName);
    } catch (error) {
      console.error('Export failed.', error);
      alert(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExportingKey('');
    }
  };

  const fmt = (sec: number) => formatPlaybackClock(sec);

  // ─── Synchronized scroll ──────────────────────────────────────────────────
  const leftPaneRef = useRef<HTMLDivElement>(null);
  const rightPaneRef = useRef<HTMLDivElement>(null);
  const syncingRef = useRef(false);

  const handleLeftScroll = () => {
    if (syncingRef.current || !leftPaneRef.current || !rightPaneRef.current) return;
    syncingRef.current = true;
    const pct = leftPaneRef.current.scrollTop / (leftPaneRef.current.scrollHeight - leftPaneRef.current.clientHeight);
    rightPaneRef.current.scrollTop = pct * (rightPaneRef.current.scrollHeight - rightPaneRef.current.clientHeight);
    setTimeout(() => { syncingRef.current = false; }, 50);
  };

  const handleRightScroll = () => {
    if (syncingRef.current || !leftPaneRef.current || !rightPaneRef.current) return;
    syncingRef.current = true;
    const pct = rightPaneRef.current.scrollTop / (rightPaneRef.current.scrollHeight - rightPaneRef.current.clientHeight);
    leftPaneRef.current.scrollTop = pct * (leftPaneRef.current.scrollHeight - leftPaneRef.current.clientHeight);
    setTimeout(() => { syncingRef.current = false; }, 50);
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <>
      <div className="app-bg" />
      <div className="app-shell">
        <div className="drag-region" />

        {/* Settings button */}
        {screen !== 'review' && (
          <div className="corner-actions">
            <button className="settings-btn inline" onClick={openProjectSidebar} title="Projects">
              <FolderOpen size={15} />
            </button>
            <button className="settings-btn inline" onClick={() => setShowSettings(true)} title="Settings">
              <Settings size={15} />
            </button>
          </div>
        )}

        {/* ── UPLOAD ── */}
        {screen === 'upload' && <Workspace onFileSelected={handleFileSelected} />}

        {/* ── CONFIG ── */}
        {screen === 'config' && (
          <ConfigPanel fileName={sourceFileName} settings={settings} onStart={handleStartEngine} onCancel={() => setScreen('upload')} />
        )}

        {/* ── PROCESSING ── */}
        {screen === 'processing' && (
          <div className="processing-screen">
            <div className="logo-header" style={{ marginBottom: 32 }}>
              <div className="logo-wrap"><Logo className="logo-img" /><span className="logo-name">VaniScript</span></div>
              <p className="logo-tagline">Professional Audio Transcription &amp; Translation Engine with<br />extreme verbatim accuracy.</p>
            </div>
            <div className="processing-card">
              <div className="spinner" />
              <p className="proc-title">Processing Data…</p>
              <div className="proc-bar-wrap">
                <div className="proc-bar"><div className="proc-fill" style={{ width: `${procProgress}%` }} /></div>
              </div>
              <p className="proc-status">"{procMsg}"</p>
              <p className="proc-sub">This may take a moment depending on the length of the audio track.</p>
            </div>
            <div className="app-footer" style={{ marginTop: 32 }}>
              © 2026 VaniScript Audio Processor • Version 1.0.0<br />
              Optimized for Gaudiya Vaishnava Philosophical Lexicon &amp; Technical Terminology
            </div>
          </div>
        )}

        {/* ── REVIEW ── */}
        {screen === 'review' && session && (() => {
          const chunk = session.chunks[session.currentIndex];
          const total = session.chunks.length;
          const approved = session.chunks.filter(c => c.approved).length;
          const hasTranslation = session.targetLang !== 'same' && session.targetLang !== '';
          const originalPreview = chunk ? buildChunkPreview(chunk, 'original', outputFormat, exportOptions) : '';
          const translatedPreview = chunk ? buildChunkPreview(chunk, 'translated', outputFormat, exportOptions) : '';
          const isEditableTextMode = outputFormat === 'TXT';
          const globalAudioTimeSec = (chunk?.startSec ?? 0) + audioCurrentSec;
          const audioStatusLabel =
            audioStatus === 'loading' ? 'Loading audio...' :
            audioStatus === 'error' ? 'Audio unavailable' :
            audioStatus === 'ready' ? 'Audio ready' :
            'No audio';
          const toggleAudioPlayback = async () => {
            await toggleCurrentAudio();
          };
          const seekAudio = (value: number) => {
            seekCurrentAudio(value);
          };

          return (
            <div className="review-screen">
              {/* ── Top bar ── */}
              <div className="review-topbar">
                <div className="review-tb-left">
                  <Logo className="review-logo" />
                  <span className="review-app-name">VaniScript</span>
                  <div className="review-status">
                    <div className="status-dot" />
                    <span>{chunk?.status === 'processing' ? 'Processing…' : chunk?.status === 'error' ? 'Error' : 'Ready'}</span>
                  </div>
                </div>

                <div className="review-tb-center">
                  {hasTranslation && editingProviders.length > 0 && (
                    <div className="review-editing-model">
                      <span>Editing Model</span>
                      <select value={editingProvider} onChange={(event) => setEditingProvider(event.target.value)}>
                        {renderProviderOptions(editingProviders)}
                      </select>
                    </div>
                  )}
                  {/* View mode */}
                  <div className="review-view-group">
                    <button className={`review-view-btn ${viewMode === 'source' ? 'active' : ''}`} onClick={() => setViewMode('source')}>Source</button>
                    <button className={`review-view-btn ${viewMode === 'translated' ? 'active' : ''}`} onClick={() => setViewMode('translated')}>Translated</button>
                    <button className={`review-view-btn ${viewMode === 'dual' ? 'active-accent' : ''}`} onClick={() => setViewMode('dual')}>Dual View</button>
                  </div>
                </div>

                <div className="review-tb-right">
                  <button className="review-icon-btn" onClick={openProjectSidebar} title="Projects">
                    <FolderOpen size={14} />
                  </button>
                  <button className="review-icon-btn" onClick={() => setShowSettings(true)} title="Settings">
                    <Settings size={14} />
                  </button>
                  <button className="review-new-btn" onClick={() => { setSession(null); setSourceFile(''); setSourceFileName(''); setScreen('upload'); }}>
                    + New Session
                  </button>
                </div>
              </div>

              {/* ── Audio bar ── */}
              <div className="review-audio-bar">
                <span className="review-audio-label">CURRENT SEGMENT AUDIO</span>
                <div className={`review-audio-control ${audioStatus !== 'ready' ? 'disabled' : ''}`}>
                  <button
                    className="review-audio-play"
                    onClick={toggleAudioPlayback}
                    disabled={audioStatus !== 'ready'}
                    title={audioPlaying ? 'Pause' : 'Play'}
                  >
                    {audioPlaying ? <Pause size={14} /> : <Play size={14} />}
                  </button>
                  <span className="review-audio-time">
                    {formatPlaybackClock(globalAudioTimeSec)} / {formatPlaybackClock(chunk?.endSec ?? 0)}
                  </span>
                  <input
                    className="review-audio-range"
                    type="range"
                    min={0}
                    max={Math.max(0.1, chunk?.durationSec ?? 0.1)}
                    step={0.05}
                    value={Math.min(audioCurrentSec, chunk?.durationSec ?? 0)}
                    onChange={(event) => seekAudio(Number(event.currentTarget.value))}
                    disabled={audioStatus !== 'ready'}
                  />
                </div>
                <audio
                  ref={audioRef}
                  key={audioSrc}
                  src={audioSrc}
                  className="review-audio-player-hidden"
                  onLoadStart={() => {
                    setAudioStatus('loading');
                    setAudioError('');
                    setAudioCurrentSec(0);
                    setAudioPlaying(false);
                  }}
                  onLoadedMetadata={(event) => {
                    event.currentTarget.currentTime = 0;
                    setAudioCurrentSec(0);
                  }}
                  onCanPlay={() => {
                    setAudioStatus('ready');
                    setAudioError('');
                  }}
                  onTimeUpdate={(event) => {
                    const activeChunk = session.chunks[session.currentIndex];
                    if (!activeChunk) return;
                    if (event.currentTarget.currentTime >= activeChunk.durationSec) {
                      event.currentTarget.pause();
                      setAudioCurrentSec(activeChunk.durationSec);
                      setAudioPlaying(false);
                      return;
                    }
                    setAudioCurrentSec(event.currentTarget.currentTime);
                  }}
                  onPlay={(event) => {
                    const activeChunk = session.chunks[session.currentIndex];
                    if (!activeChunk) return;
                    if (event.currentTarget.currentTime < 0 || event.currentTarget.currentTime >= activeChunk.durationSec) {
                      event.currentTarget.currentTime = 0;
                      setAudioCurrentSec(0);
                    }
                    setAudioPlaying(true);
                  }}
                  onPause={() => setAudioPlaying(false)}
                  onEnded={() => setAudioPlaying(false)}
                  onError={(event) => {
                    const code = event.currentTarget.error?.code;
                    const detail = code ? `Audio element error code ${code}` : 'Audio element could not decode the current source.';
                    console.error('Audio playback error:', detail, currentAudioPath);
                    setAudioStatus('error');
                    setAudioError(detail);
                  }}
                />
                <span className={`review-audio-state ${audioStatus === 'error' ? 'error' : ''}`}>{audioStatusLabel}</span>
              </div>
              {audioError && <div className="review-audio-error">{audioError}</div>}

              {/* ── Progress bar (thin) ── */}
              <div className="review-thin-progress">
                <div className="review-thin-fill" style={{ width: `${Math.round((approved / total) * 100)}%` }} />
              </div>

              {/* ── Dual pane / single pane ── */}
              {chunk?.status === 'processing' || chunk?.status === 'pending' ? (
                <div className="review-loading">
                  <div className="spinner" />
                  <p>{chunk.status === 'pending' ? 'Waiting in queue…' : 'Transcribing with AI…'}</p>
                </div>
              ) : chunk?.status === 'error' ? (
                <div className="review-loading">
                  <p style={{ color: 'var(--red)', marginBottom: 12 }}>{chunk.original}</p>
                  <button className="btn-nav" onClick={() => handleRetry(session.currentIndex)}>
                    <RefreshCw size={13} /> Retry
                  </button>
                </div>
              ) : (
                <div className="review-panes" style={{ gridTemplateColumns: viewMode === 'dual' ? '1fr 1fr' : '1fr' }}>
                  {/* Original pane */}
                  {(viewMode === 'source' || viewMode === 'dual') && (
                    <div className="review-pane">
                      <div className="review-pane-header">
                        <span className="review-pane-label">ORIGINAL TRANSCRIPTION</span>
                        <button
                          className="review-dl-btn"
                          title="Download original"
                          onClick={() => download(buildTranscriptExport('original', outputFormat, session.chunks, exportOptions), buildExportFileName({
                            sourceFileName: session.sourceFileName,
                            lecturer: session.config.lecturer,
                            location: session.config.location,
                            date: session.config.date,
                            which: 'original',
                            format: outputFormat,
                          }))}
                        >
                          <Download size={13} />
                        </button>
                      </div>
                      <TextPanel
                        content={originalPreview}
                        format={outputFormat}
                        lang="original"
                        scrollRef={viewMode === 'dual' ? leftPaneRef : { current: null }}
                        onScroll={viewMode === 'dual' ? handleLeftScroll : (() => {})}
                        onUpdateContent={(val) => {
                          if (!isEditableTextMode) return;
                          handleUpdateChunk(session.currentIndex, {
                            original: val,
                            originalFormats: {
                              ...(chunk?.originalFormats || {}),
                              TXT: val,
                            },
                          });
                        }}
                        onAiReprocess={(selected) => runAudioAwareReview(selected, 'original')}
                        onAddToGlossary={openGlossaryDraft}
                        karaokeEnabled={outputFormat === 'TXT'}
                        karaokeTimeSec={globalAudioTimeSec}
                        karaokeStartSec={chunk?.startSec ?? 0}
                        karaokeEndSec={chunk?.endSec ?? 0}
                      />
                    </div>
                  )}

                  {/* Translation pane */}
                  {hasTranslation && (viewMode === 'translated' || viewMode === 'dual') && (
                    <div className="review-pane">
                      <div className="review-pane-header">
                        <span className="review-pane-label" style={{ color: 'var(--accent)' }}>TRANSLATED: {session.targetLang.toUpperCase()}</span>
                        <button
                          className="review-dl-btn"
                          title="Download translation"
                          onClick={() => download(buildTranscriptExport('translated', outputFormat, session.chunks, exportOptions), buildExportFileName({
                            sourceFileName: session.sourceFileName,
                            lecturer: session.config.lecturer,
                            location: session.config.location,
                            date: session.config.date,
                            which: 'translated',
                            targetLang: session.targetLang,
                            format: outputFormat,
                          }))}
                        >
                          <Download size={13} />
                        </button>
                      </div>
                      <TextPanel
                        content={translatedPreview}
                        format={outputFormat}
                        lang="translated"
                        scrollRef={viewMode === 'dual' ? rightPaneRef : { current: null }}
                        onScroll={viewMode === 'dual' ? handleRightScroll : (() => {})}
                        onUpdateContent={(val) => {
                          if (!isEditableTextMode) return;
                          handleUpdateChunk(session.currentIndex, {
                            translated: val,
                            translatedFormats: {
                              ...(chunk?.translatedFormats || {}),
                              TXT: val,
                            },
                          });
                        }}
                        onAiReprocess={(selected) => runAudioAwareReview(selected, 'translated')}
                        onPolishTranslation={runLiteraryPolish}
                        onAddToGlossary={openGlossaryDraft}
                        karaokeEnabled={outputFormat === 'TXT'}
                        karaokeTimeSec={globalAudioTimeSec}
                        karaokeStartSec={chunk?.startSec ?? 0}
                        karaokeEndSec={chunk?.endSec ?? 0}
                      />
                    </div>
                  )}
                </div>
              )}

              {viewMode !== 'dual' && (chunk?.unrecognizedFragments?.length || 0) > 0 && (
                <div className="review-fragments">
                  <div className="review-fragments-title">UNRECOGNIZED FRAGMENTS</div>
                  <ul className="review-fragments-list">
                    {chunk?.unrecognizedFragments?.map((fragment, index) => (
                      <li key={index}>{fragment}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* ── Bottom action bar ── */}
              <div className="review-actions">
                <div className="review-chunk-info">
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>
                    Segment {session.currentIndex + 1} / {total} · {fmt(chunk?.startSec ?? 0)}–{fmt(chunk?.endSec ?? 0)}
                  </span>
                  <div className="proc-bar" style={{ width: 120 }}>
                    <div className="proc-fill" style={{ width: `${Math.round((approved / total) * 100)}%` }} />
                  </div>
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>{approved}/{total} approved</span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn-nav"
                    disabled={session.currentIndex === 0}
                    onClick={() => setSession(p => p ? { ...p, currentIndex: p.currentIndex - 1 } : p)}
                  >‹ Previous</button>
                  <button className="btn-approve" onClick={handleApproveAndNext}>
                    {session.currentIndex < total - 1 ? '✓ Approve & Next ›' : '✓ Complete & Export'}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── EXPORT ── */}
        {screen === 'export' && session && (() => (
            <div className="export-screen">
              <div className="export-card">
                <div style={{ fontSize: 48 }}>✅</div>
                <div>
                  <p style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Transcription Complete</p>
                  <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>
                    {session.chunks.length} segments · {session.sourceFileName}
                  </p>
                </div>
                <div className="export-dl-grid">
                  {(['TXT', 'SRT', 'VTT', 'Markdown'] as OutputFormat[]).map(f => (
                    <button
                      key={f}
                      className="btn-dl btn-dl-secondary"
                      disabled={Boolean(exportingKey)}
                      onClick={() => handleExportDownload('original', f)}
                    >
                      {exportingKey === `original-${f}` ? 'Formatting…' : `⬇ ${f}`}
                    </button>
                  ))}
                  {session.targetLang !== 'same' && (['TXT', 'SRT', 'VTT', 'Markdown'] as OutputFormat[]).map(f => (
                    <button
                      key={`t-${f}`}
                      className="btn-dl btn-dl-primary"
                      disabled={Boolean(exportingKey)}
                      onClick={() => handleExportDownload('translated', f)}
                    >
                      {exportingKey === `translated-${f}` ? 'Formatting…' : `⬇ ${f} (${session.targetLang})`}
                    </button>
                  ))}
                </div>
                <div className="export-subtitle-settings">
                  <div className="export-subtitle-title">Subtitle Layout</div>
                  <label className="export-slider-row">
                    <span>Characters per line</span>
                    <input
                      type="range"
                      min={16}
                      max={64}
                      step={1}
                      value={subtitleMaxCharsPerLine}
                      onChange={(event) => setSubtitleMaxCharsPerLine(Number(event.currentTarget.value))}
                    />
                    <strong>{subtitleMaxCharsPerLine}</strong>
                  </label>
                  <label className="export-slider-row">
                    <span>Lines per cue</span>
                    <input
                      type="range"
                      min={1}
                      max={3}
                      step={1}
                      value={subtitleMaxLines}
                      onChange={(event) => setSubtitleMaxLines(Number(event.currentTarget.value))}
                    />
                    <strong>{subtitleMaxLines}</strong>
                  </label>
                </div>
                <div className="export-actions">
                  <button className="btn-cancel" onClick={() => setScreen('review')}>
                    <ArrowLeft size={14} /> Back to Chunks
                  </button>
                  <button className="btn-cancel" onClick={openProjectSidebar}>
                    <FolderOpen size={14} /> Sessions
                  </button>
                  <button className="btn-cancel" onClick={() => { setSession(null); setSourceFile(''); setSourceFileName(''); setScreen('upload'); }}>
                    New Session
                  </button>
                </div>
              </div>
            </div>
        ))()}

        {showSettings && (
          <SettingsModal settings={settings} usage={usage} onSave={handleSaveSettings} onClose={() => setShowSettings(false)} />
        )}

        {projectSidebarOpen && (
          <div className={`project-sidebar-backdrop ${projectSidebarClosing ? 'closing' : ''}`} onMouseDown={closeProjectSidebar}>
            <aside className="project-sidebar" onMouseDown={(event) => event.stopPropagation()}>
              <div className="project-sidebar-header">
                <div>
                  <div className="project-sidebar-title">Sessions</div>
                  <div className="project-sidebar-subtitle">Autosaved in Documents/VaniScript Projects</div>
                </div>
                <button
                  type="button"
                  className="review-icon-btn"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={closeProjectSidebar}
                >
                  ×
                </button>
              </div>
              <div className="project-sidebar-actions">
                <button className="btn-save" onClick={importProject}><Upload size={14} /> Import</button>
                <button className="btn-ghost-sm" onClick={exportAllProjects}><Archive size={14} /> Export All</button>
              </div>
              <div className="project-list">
                {projects.length === 0 ? (
                  <div className="project-empty">No saved sessions yet.</div>
                ) : projects.map((project) => {
                  const isExpanded = expandedProjectId === project.id;
                  const isActiveProject = session?.projectId === project.id;
                  const exportReady = isProjectExportReady(project.totalChunks, project.approvedChunks);
                  return (
                    <div key={project.id} className={`project-item ${isActiveProject ? 'active' : ''} ${isExpanded ? 'expanded' : ''}`}>
                      <button
                        className="project-open"
                        onClick={() => toggleProjectExpanded(project.id)}
                        aria-expanded={isExpanded}
                      >
                        <span className="project-title-row">
                          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          <span className="project-name">{project.name}</span>
                        </span>
                        <span className="project-meta">
                          {project.currentIndex + 1}/{Math.max(1, project.totalChunks)} chunks · {project.approvedChunks} approved · {project.targetLang || 'Same'}
                        </span>
                        <span className="project-date">{new Date(project.updatedAt).toLocaleString()}</span>
                      </button>
                      <div className="project-item-actions">
                        <button title="Share project" onClick={() => exportProject(project.id)}><Share2 size={13} /></button>
                        <button title="Delete project" onClick={() => deleteProject(project.id)}><Trash2 size={13} /></button>
                      </div>
                      {isExpanded && (
                        <div className="project-chunk-list">
                          {projectChunkNumbers(project.totalChunks).map((chunkNumber) => {
                            const chunkIndex = chunkNumber - 1;
                            const isCurrentChunk = isActiveProject && session?.currentIndex === chunkIndex;
                            const canOpenChunk = canOpenSidebarChunk(chunkIndex, project.currentIndex, project.totalChunks);
                            return (
                              <button
                                key={chunkNumber}
                                className={`project-chunk-btn ${isCurrentChunk ? 'active' : ''} ${canOpenChunk ? '' : 'locked'}`}
                                disabled={!canOpenChunk}
                                onClick={() => openProjectChunk(project, chunkIndex)}
                              >
                                <span>Chunk {chunkNumber}</span>
                                {chunkIndex === project.currentIndex && <span className="project-chunk-pill">last</span>}
                              </button>
                            );
                          })}
                          {exportReady && (
                            <button
                              type="button"
                              className="project-export-btn"
                              onClick={() => openProjectExport(project)}
                            >
                              <Download size={13} />
                              Export
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="project-sidebar-footer">
                <button className="btn-danger-sm" onClick={clearProjectArchive}>Clear Archive</button>
              </div>
            </aside>
          </div>
        )}

        {glossaryDraft && (() => {
          const selectedEntry = glossaryDraft.existingEntryId
            ? settings.glossary.find((entry) => entry.id === glossaryDraft.existingEntryId)
            : undefined;
          return (
            <div className="glossary-modal-backdrop" onMouseDown={() => setGlossaryDraft(null)}>
              <div className="glossary-modal" onMouseDown={(event) => event.stopPropagation()}>
                <div className="glossary-modal-title">Add to Glossary</div>
                <p className="glossary-modal-subtitle">
                  Add the selected misspelling to an existing term, or create a new glossary term.
                </p>
                <div className="glossary-mode-tabs">
                  <button
                    type="button"
                    className={glossaryDraft.mode === 'existing' ? 'active' : ''}
                    onClick={() => setGlossaryDraft({ ...glossaryDraft, mode: 'existing', existingEntryId: undefined, search: '' })}
                  >
                    Add to existing
                  </button>
                  <button
                    type="button"
                    className={glossaryDraft.mode === 'new' ? 'active' : ''}
                    onClick={() => setGlossaryDraft({
                      ...glossaryDraft,
                      mode: 'new',
                      existingEntryId: undefined,
                      source: glossaryDraft.lang === 'original' ? glossaryDraft.selectedText : '',
                      translation: glossaryDraft.lang === 'translated' ? glossaryDraft.selectedText : '',
                    })}
                  >
                    Create new term
                  </button>
                </div>

                {glossaryDraft.mode === 'existing' ? (
                  <>
                    <div className="glossary-field">
                      <label>Find existing glossary term</label>
                      <div className="glossary-search-row">
                        <select
                          value={glossaryDraft.categoryFilter}
                          onChange={(event) => setGlossaryDraft({ ...glossaryDraft, categoryFilter: event.target.value, existingEntryId: undefined })}
                        >
                          <option value="all">All categories</option>
                          {glossaryCategories.map((category) => (
                            <option key={category} value={category}>{category}</option>
                          ))}
                        </select>
                        <div className="glossary-search-input">
                          <Search size={14} />
                          <input
                            value={glossaryDraft.search}
                            onChange={(event) => setGlossaryDraft({ ...glossaryDraft, search: event.target.value, existingEntryId: undefined })}
                            placeholder="Type to find an existing term or wrong variant..."
                          />
                        </div>
                      </div>
                      <div className="glossary-match-list">
                        {glossaryDraftMatches.length === 0 ? (
                          <span className="glossary-match-empty">
                            {glossaryDraft.search.trim() || glossaryDraft.categoryFilter !== 'all'
                              ? 'No matching term. Switch to “Create new term” if this is new terminology.'
                              : 'Choose a category or type in the search field to find an existing glossary term.'}
                          </span>
                        ) : glossaryDraftMatches.map((entry) => (
                          <button
                            key={entry.id}
                            type="button"
                            className={`glossary-match-btn ${glossaryDraft.existingEntryId === entry.id ? 'active' : ''}`}
                            onClick={() => setGlossaryDraft({
                              ...glossaryDraft,
                              existingEntryId: entry.id,
                              source: entry.source,
                              translation: entry.translation,
                              category: entry.category ?? '',
                              search: entry.source,
                            })}
                          >
                            <span>{entry.source}</span>
                            <small>{entry.translation}{entry.category ? ` · ${entry.category}` : ''}</small>
                          </button>
                        ))}
                      </div>
                    </div>
                    {selectedEntry ? (
                      <div className="glossary-selected-term">
                        <strong>{selectedEntry.source}</strong>
                        <span>{selectedEntry.translation || 'No translation'}</span>
                        {selectedEntry.category && <small>{selectedEntry.category}</small>}
                      </div>
                    ) : (
                      <div className="glossary-existing-note">Select the existing term that should receive the new wrong variant.</div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="glossary-field-row">
                      <div className="glossary-field">
                        <label>Correct source term</label>
                        <input
                          value={glossaryDraft.source}
                          onChange={(event) => setGlossaryDraft({ ...glossaryDraft, source: event.target.value })}
                          placeholder="Jayapataka Maharaja"
                        />
                      </div>
                      <div className="glossary-field">
                        <label>Correct translation</label>
                        <input
                          value={glossaryDraft.translation}
                          onChange={(event) => setGlossaryDraft({ ...glossaryDraft, translation: event.target.value })}
                          placeholder="Джаяпатака Махарадж"
                        />
                      </div>
                    </div>
                    <div className="glossary-field">
                      <label>Category</label>
                      <input
                        value={glossaryDraft.category}
                        onChange={(event) => setGlossaryDraft({ ...glossaryDraft, category: event.target.value })}
                        placeholder="Acharyas / Teachers, Sacred places..."
                      />
                    </div>
                  </>
                )}

                <div className="glossary-field">
                  <label>{glossaryDraft.mode === 'existing' ? 'New wrong variants to add' : 'Wrong variants'}</label>
                  <textarea
                    value={glossaryDraft.variants}
                    onChange={(event) => setGlossaryDraft({ ...glossaryDraft, variants: event.target.value })}
                    placeholder="One variant per line, or separate with commas"
                  />
                </div>
                <div className="glossary-field">
                  <label>Apply to</label>
                  <select
                    value={glossaryDraft.scope}
                    onChange={(event) => setGlossaryDraft({ ...glossaryDraft, scope: event.target.value as GlossaryScope })}
                  >
                    <option value="processed">All processed chunks and future sessions</option>
                    <option value="current">Current chunk and future sessions</option>
                  </select>
                </div>
                <div className="glossary-actions">
                  <button className="btn-ghost-sm" onClick={() => setGlossaryDraft(null)}>Cancel</button>
                  <button
                    className="btn-save"
                    disabled={!canSaveGlossaryDraft(glossaryDraft)}
                    onClick={saveGlossaryDraft}
                  >
                    {glossaryDraft.mode === 'existing' ? 'Add Variant' : 'Save Term'}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </>
  );
}
