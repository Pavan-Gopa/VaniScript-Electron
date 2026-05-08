import { GoogleGenAI } from '@google/genai';

type ReviewMode = 'original' | 'translated';

export function buildAudioReviewPrompt(opts: {
  selectedText: string;
  mode: ReviewMode;
  targetLang: string;
  speakerHint?: string;
  glossaryBlock?: string;
}): string {
  const modeLabel = opts.mode === 'original'
    ? 'Original transcript correction'
    : `Translation correction to ${opts.targetLang}`;

  return [
    'You are doing an audio-aware review of a short highlighted transcript fragment.',
    `Mode: ${modeLabel}.`,
    opts.speakerHint ? `Speaker/context hint: ${opts.speakerHint}.` : '',
    opts.glossaryBlock || '',
    '',
    'Task:',
    '1. Listen to the audio and locate the highlighted fragment.',
    '2. Correct only this highlighted fragment.',
    '3. Preserve the spoken meaning exactly. Do not polish, summarize, or expand.',
    '4. Use glossary spellings and translations exactly when applicable.',
    opts.mode === 'translated'
      ? `5. Return the corrected replacement in ${opts.targetLang}.`
      : '5. Return the corrected replacement in the original spoken language.',
    '',
    'Highlighted fragment:',
    opts.selectedText,
    '',
    'Output only the corrected replacement text.',
    'Do not return analysis, notes, markdown, labels, or quote marks.',
  ].filter(Boolean).join('\n');
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
