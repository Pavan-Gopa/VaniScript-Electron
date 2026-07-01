import { AppSettings, LocalModelState } from '../types';
import { getAvailableTranscriptionProviders, getAvailableTranslationProviders } from '../lib/provider-registry';

export interface DiskModelStatus {
  status: 'downloaded' | 'downloading' | 'not_found' | 'failed' | 'incomplete';
  path?: string | null;
  error?: string;
}

export interface DiskModelStatusSnapshot {
  asr?: Record<string, DiskModelStatus>;
  translation?: Record<string, DiskModelStatus>;
}

function normalizeMissingModel(state: LocalModelState): LocalModelState {
  return {
    ...state,
    status: 'not_downloaded',
    path: null,
    progress: undefined,
    progressLabel: undefined,
    error: undefined,
  };
}

function applyDiskStatus(
  models: Record<string, LocalModelState>,
  statuses: Record<string, DiskModelStatus> | undefined
): Record<string, LocalModelState> {
  const next: Record<string, LocalModelState> = { ...models };
  for (const [modelId, state] of Object.entries(models)) {
    if (state.status === 'downloading') continue;
    const disk = statuses?.[modelId];

    if (disk?.status === 'downloaded' && disk.path) {
      next[modelId] = {
        ...state,
        status: 'downloaded',
        path: disk.path,
        progress: 1,
        progressLabel: undefined,
        error: undefined,
      };
      continue;
    }

    if (state.status === 'downloaded' || state.status === 'failed' || state.path || state.progress !== undefined || state.progressLabel) {
      next[modelId] = normalizeMissingModel(state);
    }
  }
  return next;
}

export function reconcileLocalModelStatesWithDisk(
  settings: AppSettings,
  disk: DiskModelStatusSnapshot
): AppSettings {
  let next: AppSettings = {
    ...settings,
    localAsrModels: applyDiskStatus(settings.localAsrModels, disk.asr),
    localTranslationModels: applyDiskStatus(settings.localTranslationModels, disk.translation),
  };

  if (
    next.transcriptionProvider
    && next.localAsrModels[next.transcriptionProvider]?.status !== 'downloaded'
  ) {
    next = {
      ...next,
      transcriptionProvider: getAvailableTranscriptionProviders(next)[0]?.id ?? '',
    };
  }

  if (
    next.translationProvider
    && next.localTranslationModels[next.translationProvider]?.status !== 'downloaded'
  ) {
    next = {
      ...next,
      translationProvider: getAvailableTranslationProviders(next, next.defaultTargetLang).providers[0]?.id ?? '',
    };
  }

  return next;
}
