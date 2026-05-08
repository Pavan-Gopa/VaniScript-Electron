import { AppSettings, LocalModelState } from '../types';

export type ProviderGroup = 'cloud' | 'local';
export type ProviderKind = 'transcription' | 'translation';
export type ProviderKeyRequirement = 'gemini' | 'openai';

export interface ProviderOption {
  id: string;
  label: string;
  group: ProviderGroup;
  kind: ProviderKind;
  requiresKey?: ProviderKeyRequirement;
}

function downloadedLocalModels(
  models: Record<string, LocalModelState> | undefined,
  kind: ProviderKind
): ProviderOption[] {
  return Object.entries(models ?? {})
    .filter(([, state]) => state.status === 'downloaded')
    .map(([id, state]) => ({
      id,
      label: state.label,
      group: 'local' as const,
      kind,
    }));
}

export function getAvailableTranscriptionProviders(settings: AppSettings): ProviderOption[] {
  const cloud: ProviderOption[] = [];

  if (settings.geminiKey.trim()) {
    cloud.push({ id: 'gemini-cloud', label: 'Gemini Cloud', group: 'cloud', kind: 'transcription', requiresKey: 'gemini' });
  }
  if (settings.openaiKey.trim()) {
    cloud.push({ id: 'gpt-cloud', label: 'GPT Cloud', group: 'cloud', kind: 'transcription', requiresKey: 'openai' });
  }
  return [...cloud, ...downloadedLocalModels(settings.localAsrModels, 'transcription')];
}

export function getAvailableTranslationProviders(settings: AppSettings, targetLang: string): {
  enabled: boolean;
  providers: ProviderOption[];
} {
  if (targetLang.trim().toLowerCase() === 'same') {
    return { enabled: false, providers: [] };
  }

  const cloud: ProviderOption[] = [];

  if (settings.geminiKey.trim()) {
    cloud.push({ id: 'gemini-cloud', label: 'Gemini Cloud', group: 'cloud', kind: 'translation', requiresKey: 'gemini' });
  }
  if (settings.openaiKey.trim()) {
    cloud.push({ id: 'gpt-cloud', label: 'GPT Cloud', group: 'cloud', kind: 'translation', requiresKey: 'openai' });
  }
  return {
    enabled: true,
    providers: [...cloud, ...downloadedLocalModels(settings.localTranslationModels, 'translation')],
  };
}
