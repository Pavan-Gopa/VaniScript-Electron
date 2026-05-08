import { LocalModelState } from '../types';

export interface LLAMACPPTranslationModelDescriptor {
  id: string;
  label: string;
  repositoryId: string;
  fileName: string;
  downloadSize: string;
  qualityTier: 'light' | 'balanced' | 'quality';
  recommended?: boolean;
}

export const LLAMACPP_TRANSLATION_MODELS: LLAMACPPTranslationModelDescriptor[] = [
  {
    id: 'qwen35-08b-instruct-q4_k_m',
    label: 'Qwen 3.5 0.8B Q4_K_M',
    repositoryId: 'bartowski/Qwen_Qwen3.5-0.8B-GGUF',
    fileName: 'Qwen_Qwen3.5-0.8B-Q4_K_M.gguf',
    downloadSize: '~0.56 GB',
    qualityTier: 'light',
  },
  {
    id: 'qwen35-2b-instruct-q4_k_m',
    label: 'Qwen 3.5 2B Q4_K_M',
    repositoryId: 'bartowski/Qwen_Qwen3.5-2B-GGUF',
    fileName: 'Qwen_Qwen3.5-2B-Q4_K_M.gguf',
    downloadSize: '~1.33 GB',
    qualityTier: 'balanced',
    recommended: true,
  },
  {
    id: 'qwen35-4b-instruct-q4_k_m',
    label: 'Qwen 3.5 4B Q4_K_M',
    repositoryId: 'bartowski/Qwen_Qwen3.5-4B-GGUF',
    fileName: 'Qwen_Qwen3.5-4B-Q4_K_M.gguf',
    downloadSize: '~2.87 GB',
    qualityTier: 'quality',
  },
  {
    id: 'gemma-4-2b-it-q4_k_m',
    label: 'Gemma 4 2B IT Q4_K_M',
    repositoryId: 'bartowski/google_gemma-4-E2B-it-GGUF',
    fileName: 'google_gemma-4-E2B-it-Q4_K_M.gguf',
    downloadSize: '~3.46 GB',
    qualityTier: 'balanced',
  },
  {
    id: 'gemma-4-4b-it-q4_k_m',
    label: 'Gemma 4 4B IT Q4_K_M',
    repositoryId: 'bartowski/google_gemma-4-E4B-it-GGUF',
    fileName: 'google_gemma-4-E4B-it-Q4_K_M.gguf',
    downloadSize: '~5.41 GB',
    qualityTier: 'quality',
  },
];

export function getRecommendedTranslationModel(): LLAMACPPTranslationModelDescriptor | undefined {
  return LLAMACPP_TRANSLATION_MODELS.find((model) => model.recommended) ?? LLAMACPP_TRANSLATION_MODELS[0];
}

export function createDefaultTranslationModelStateMap(): Record<string, LocalModelState> {
  return Object.fromEntries(
    LLAMACPP_TRANSLATION_MODELS.map((model) => [
      model.id,
      {
        status: 'not_downloaded',
        label: model.label,
        runtime: 'llamacpp',
      } satisfies LocalModelState,
    ])
  );
}
