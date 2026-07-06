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
    qualityTier: 'light',
  },
  {
    id: 'qwen35-4b-instruct-q4_k_m',
    label: 'Qwen 3.5 4B Q4_K_M',
    repositoryId: 'bartowski/Qwen_Qwen3.5-4B-GGUF',
    fileName: 'Qwen_Qwen3.5-4B-Q4_K_M.gguf',
    downloadSize: '~2.87 GB',
    qualityTier: 'balanced',
    recommended: true,
  },
  {
    id: 'qwen35-9b-instruct-q4_k_m',
    label: 'Qwen 3.5 9B Q4_K_M',
    repositoryId: 'bartowski/Qwen_Qwen3.5-9B-GGUF',
    fileName: 'Qwen_Qwen3.5-9B-Q4_K_M.gguf',
    downloadSize: '~5.74 GB',
    qualityTier: 'quality',
  },
  // Optional: mamba2/hybrid requires a recent llama.cpp. The repository only ships Q4_K_M.
  {
    id: 'nemotron3-nano-4b-q4_k_m',
    label: 'NVIDIA Nemotron-3 Nano 4B Q4_K_M',
    repositoryId: 'nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF',
    fileName: 'NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf',
    downloadSize: '~2.84 GB',
    qualityTier: 'balanced',
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
