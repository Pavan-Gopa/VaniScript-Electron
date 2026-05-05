import { AppSettings, UsageStats } from '../types';

const SETTINGS_KEY = 'vs_settings_v1';
const USAGE_KEY = 'vs_usage_v1';

export const DEFAULT_SETTINGS: AppSettings = {
  geminiKey: '',
  openaiKey: '',
  anthropicKey: '',
  theme: 'dark',
  fontSize: 'md',
  chunkDurationMin: 10,
  sliceMode: 'silence',
  silenceThreshDb: -16,
  minSilenceMs: 400,
  defaultSourceLang: 'auto',
  transcriptionProvider: 'gemini-cloud',
  translationProvider: 'gemini-cloud',
  defaultTargetLang: 'Russian',
  localAsrModels: {
    'parakeet-english': { status: 'not_downloaded', label: 'Parakeet English' },
    'whisper-medium-en': { status: 'not_downloaded', label: 'Whisper Medium English' },
    'whisper-large-v3': { status: 'not_downloaded', label: 'Whisper Large v3' },
  },
  localTranslationModels: {
    'qwen-3.5-2b-4bit': { status: 'not_downloaded', label: 'Qwen 3.5 2B 4-bit' },
    'qwen-3.5-4b-instruct-4bit': { status: 'not_downloaded', label: 'Qwen 3.5 4B Instruct 4-bit' },
    'gemma-4-2b-4bit': { status: 'not_downloaded', label: 'Gemma 4 2B 4-bit' },
    'gemma-4-4b-4bit': { status: 'not_downloaded', label: 'Gemma 4 4B 4-bit' },
  },
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
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
    },
  };
  saveUsage(updated);
  return updated;
}

export function applyTheme(theme: 'dark' | 'light', fontSize: string): void {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.setAttribute('data-font-size', fontSize);
}
