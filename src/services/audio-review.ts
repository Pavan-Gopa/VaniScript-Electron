import { GoogleGenAI } from '@google/genai';
import { renderPrompt, type PromptSettingsMap } from '../lib/prompt-presets';

type ReviewMode = 'original' | 'translated';

export function buildAudioReviewPrompt(opts: {
  selectedText: string;
  mode: ReviewMode;
  targetLang: string;
  speakerHint?: string;
  glossaryBlock?: string;
  promptPresets?: PromptSettingsMap;
}): string {
  const modeLabel = opts.mode === 'original'
    ? 'Original transcript correction'
    : `Translation correction to ${opts.targetLang}`;

  return renderPrompt(opts.promptPresets, 'audioReview', {
    modeLabel,
    speakerHintLine: opts.speakerHint ? `Speaker/context hint: ${opts.speakerHint}.` : '',
    glossaryBlock: opts.glossaryBlock || '',
    returnLanguageRule: opts.mode === 'translated'
      ? `5. Return the corrected replacement in ${opts.targetLang}.`
      : '5. Return the corrected replacement in the original spoken language.',
    selectedText: opts.selectedText,
  });
}

export async function reviewFragmentWithGeminiAudio(opts: {
  audioBase64: string;
  mimeType: string;
  selectedText: string;
  mode: ReviewMode;
  targetLang: string;
  apiKey: string;
  speakerHint?: string;
  glossaryBlock?: string;
  promptPresets?: PromptSettingsMap;
}): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: {
      parts: [
        { inlineData: { data: opts.audioBase64, mimeType: opts.mimeType } },
        { text: buildAudioReviewPrompt(opts) },
      ],
    },
    config: {
      temperature: 0.1,
    },
  });

  return (response.text ?? '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
}
