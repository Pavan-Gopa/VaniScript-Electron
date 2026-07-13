import { AppSettings, UsageStats } from '../types';
import { createDefaultTranslationModelStateMap } from '../lib/llamacpp-model-catalog';
import { DEFAULT_PROMPT_SETTINGS, normalizePromptSettings } from '../lib/prompt-presets';
import { mergeStarterGlossary, normalizeGlossaryCategory, STARTER_GLOSSARY } from '../lib/starter-glossary';

const SETTINGS_KEY = 'vs_settings_v1';
const USAGE_KEY = 'vs_usage_v1';

export const DEFAULT_SETTINGS: AppSettings = {
  geminiKey: '',
  openaiKey: '',
  anthropicKey: '',
  geminiBudgetUsd: 0,
  openaiBudgetUsd: 0,
  theme: 'dark',
  fontSize: 'md',
  fontScale: 1,
  fontFamily: 'mono',
  annotationMode: true,
  chunkDurationMin: 10,
  sliceMode: 'silence',
  silenceThreshDb: -16,
  minSilenceMs: 400,
  defaultSourceLang: 'auto',
  transcriptionProvider: 'gemini-cloud',
  translationProvider: 'qwen35-4b-instruct-q4_k_m',
  defaultTargetLang: 'Russian',
  localAsrModels: {
    'parakeet-english': { status: 'not_downloaded', label: 'Parakeet English', runtime: 'parakeet' },
    'whisper-medium-en': { status: 'not_downloaded', label: 'Whisper Medium English', runtime: 'whisper' },
    'whisper-large-v3': { status: 'not_downloaded', label: 'Whisper Large v3', runtime: 'whisper' },
  },
  localTranslationModels: createDefaultTranslationModelStateMap(),
  promptPresets: DEFAULT_PROMPT_SETTINGS,
  glossary: STARTER_GLOSSARY,
  chatRoute: 'api',
  chatGrokModel: 'grok-4.5',
};

const LEGACY_TRANSLATION_MODEL_IDS: Record<string, string> = {
  'qwen-3.5-2b-4bit': 'qwen35-2b-instruct-q4_k_m',
  'qwen-3.5-4b-instruct-4bit': 'qwen35-4b-instruct-q4_k_m',
  'qwen35-2b-4bit': 'qwen35-2b-instruct-q4_k_m',
  'qwen35-4b-optiq-4bit': 'qwen35-4b-instruct-q4_k_m',
};

function normalizePersistedModelState<T extends Record<string, any>>(
  modelMap: T | undefined,
  allowedModels: Record<string, any>
) {
  const normalized: Record<string, any> = {};
  for (const [id, state] of Object.entries(modelMap ?? {})) {
    const isAllowed = Object.prototype.hasOwnProperty.call(allowedModels, id);
    const isCustom = state?.custom === true && typeof state?.label === 'string';
    if (!isAllowed && !isCustom) continue;
    const baseline = isAllowed ? allowedModels[id] : {};
    normalized[id] = state?.status === 'downloading'
      ? {
          ...baseline,
          ...state,
          status: 'failed',
          error: state?.error || 'Previous download was interrupted. Retry the model download.',
          progress: undefined,
          progressLabel: undefined,
        }
      : {
          ...baseline,
          ...state,
        };
  }
  return normalized;
}

function normalizeTranslationModelStateMap(rawMap: Record<string, any> | undefined) {
  const normalized: Record<string, any> = {};
  for (const [id, state] of Object.entries(rawMap ?? {})) {
    const normalizedId = LEGACY_TRANSLATION_MODEL_IDS[id] ?? id;
    const isAllowed = Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS.localTranslationModels, normalizedId);
    const isCustom = state?.custom === true && typeof state?.label === 'string';
    if (!isAllowed && !isCustom) continue;
    const normalizedState = state?.status === 'downloading'
      ? {
          ...state,
          status: 'failed',
          error: state?.error || 'Previous download was interrupted. Retry the model download.',
          progress: undefined,
          progressLabel: undefined,
        }
      : state;
    normalized[normalizedId] = {
      ...(normalized[normalizedId] ?? {}),
      ...(DEFAULT_SETTINGS.localTranslationModels[normalizedId] ?? {}),
      ...normalizedState,
    };
  }
  return normalized;
}

function normalizeTranslationProviderId(providerId: string | undefined) {
  if (providerId === 'claude-cloud') return DEFAULT_SETTINGS.translationProvider;
  return LEGACY_TRANSLATION_MODEL_IDS[providerId ?? ''] ?? providerId ?? DEFAULT_SETTINGS.translationProvider;
}

function normalizeCloudProviderId(providerId: string | undefined, fallback: string) {
  return providerId === 'claude-cloud' ? fallback : (providerId ?? fallback);
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, glossary: [...STARTER_GLOSSARY] };
    const parsed = JSON.parse(raw);
    const parsedGlossary = Array.isArray(parsed.glossary)
      ? parsed.glossary.map((entry: any) => ({
          ...entry,
          category: normalizeGlossaryCategory(entry.category ? String(entry.category) : undefined),
          translations: entry.translations ?? (entry.translation ? { Default: entry.translation } : {}),
          remember: entry.remember !== false,
        }))
      : [];
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      annotationMode: parsed.annotationMode !== false,
      completedOnboardingBuildId: typeof parsed.completedOnboardingBuildId === 'string' ? parsed.completedOnboardingBuildId : undefined,
      transcriptionProvider: normalizeCloudProviderId(parsed.transcriptionProvider, DEFAULT_SETTINGS.transcriptionProvider),
      translationProvider: normalizeTranslationProviderId(parsed.translationProvider),
      geminiBudgetUsd: Number(parsed.geminiBudgetUsd ?? 0) || 0,
      openaiBudgetUsd: Number(parsed.openaiBudgetUsd ?? 0) || 0,
      localAsrModels: {
        ...DEFAULT_SETTINGS.localAsrModels,
        ...normalizePersistedModelState(parsed.localAsrModels, DEFAULT_SETTINGS.localAsrModels),
      },
      localTranslationModels: {
        ...DEFAULT_SETTINGS.localTranslationModels,
        ...normalizeTranslationModelStateMap(parsed.localTranslationModels),
      },
      promptPresets: normalizePromptSettings(parsed.promptPresets),
      glossary: mergeStarterGlossary(parsedGlossary),
    };
  } catch {
    return { ...DEFAULT_SETTINGS, glossary: [...STARTER_GLOSSARY] };
  }
}

export function saveSettings(s: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export function loadUsage(): UsageStats {
  try {
    const raw = localStorage.getItem(USAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveUsage(u: UsageStats): void {
  localStorage.setItem(USAGE_KEY, JSON.stringify(u));
}

export function trackUsage(
  usage: UsageStats,
  provider: string,
  delta: { inputTokens?: number; outputTokens?: number; audioMinutes?: number }
): UsageStats {
  const existing = usage[provider] ?? { sessions: 0, inputTokens: 0, outputTokens: 0, audioMinutes: 0, lastUsed: '' };
  const updated: UsageStats = {
    ...usage,
    [provider]: {
      sessions: existing.sessions + 1,
      inputTokens: existing.inputTokens + (delta.inputTokens ?? 0),
      outputTokens: existing.outputTokens + (delta.outputTokens ?? 0),
      audioMinutes: existing.audioMinutes + (delta.audioMinutes ?? 0),
      lastUsed: new Date().toISOString(),
      lastInputTokens: delta.inputTokens ?? 0,
      lastOutputTokens: delta.outputTokens ?? 0,
    },
  };
  saveUsage(updated);
  return updated;
}

export function applyTheme(theme: 'dark' | 'light', fontSize: string, fontScale = 1, fontFamily = 'mono'): void {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.setAttribute('data-font-size', fontSize);
  document.documentElement.setAttribute('data-font-family', fontFamily);
  document.documentElement.style.setProperty('--app-font-scale', String(fontScale));
}
