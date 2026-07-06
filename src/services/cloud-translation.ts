import { GoogleGenAI } from '@google/genai';
import { renderPrompt, type PromptSettingsMap } from '../lib/prompt-presets';
import {
  buildStructuredTranslationPrompt,
  splitTextForStructuredTranslation,
  translateSegmentsWithStructuredFallback,
  type StructuredTextSegment,
} from './structured-translation';

export function buildTranslationPrompt(
  text: string,
  targetLang: string,
  speakerHint: string,
  glossaryBlock = '',
  promptPresets?: PromptSettingsMap
): string {
  return renderPrompt(promptPresets, 'translationUser', {
    targetLang,
    speakerHintLine: speakerHint ? `Primary speaker hint: ${speakerHint}.` : '',
    glossaryBlock,
    text,
  });
}

export async function translateTextWithGemini(
  text: string,
  targetLang: string,
  apiKey: string,
  speakerHint: string,
  glossaryBlock = '',
  promptPresets?: PromptSettingsMap
): Promise<string> {
  const structuredSegments = splitTextForStructuredTranslation(text);
  if (structuredSegments.length > 1) {
    const ai = new GoogleGenAI({ apiKey });
    const translated = await translateSegmentsWithStructuredFallback({
      segments: structuredSegments,
      requestBatch: async (segments: StructuredTextSegment[]) => {
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: buildStructuredTranslationPrompt({ targetLang, speakerHint, glossaryBlock, segments, promptPresets }),
          config: {
            systemInstruction: renderPrompt(promptPresets, 'translationSystem', { targetLang }),
            temperature: 0.05,
            responseMimeType: 'application/json',
          },
        });
        return response.text?.trim() ?? '';
      },
    });
    return translated.map((segment) => segment.text).join('\n\n').trim();
  }

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: buildTranslationPrompt(text, targetLang, speakerHint, glossaryBlock, promptPresets),
    config: {
      systemInstruction: renderPrompt(promptPresets, 'translationSystem', { targetLang }),
      temperature: 0.1,
    },
  });
  return response.text?.trim() ?? '';
}

export async function translateTextWithOpenAI(
  text: string,
  targetLang: string,
  apiKey: string,
  speakerHint: string,
  glossaryBlock = '',
  promptPresets?: PromptSettingsMap
): Promise<string> {
  const structuredSegments = splitTextForStructuredTranslation(text);
  if (structuredSegments.length > 1) {
    const translated = await translateSegmentsWithStructuredFallback({
      segments: structuredSegments,
      requestBatch: async (segments: StructuredTextSegment[]) => {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: renderPrompt(promptPresets, 'translationSystem', { targetLang }) },
              { role: 'user', content: buildStructuredTranslationPrompt({ targetLang, speakerHint, glossaryBlock, segments, promptPresets }) },
            ],
            temperature: 0.05,
          }),
        });

        if (!response.ok) {
          throw new Error(`OpenAI translation error: ${response.status} ${response.statusText}`);
        }
        const json = await response.json();
        return json.choices?.[0]?.message?.content?.trim() ?? '';
      },
    });
    return translated.map((segment) => segment.text).join('\n\n').trim();
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: renderPrompt(promptPresets, 'translationSystem', { targetLang }) },
        { role: 'user', content: buildTranslationPrompt(text, targetLang, speakerHint, glossaryBlock, promptPresets) },
      ],
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI translation error: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  return json.choices?.[0]?.message?.content?.trim() ?? '';
}

export async function translateTextWithClaude(
  text: string,
  targetLang: string,
  apiKey: string,
  speakerHint: string,
  glossaryBlock = '',
  promptPresets?: PromptSettingsMap
): Promise<string> {
  const structuredSegments = splitTextForStructuredTranslation(text);
  if (structuredSegments.length > 1) {
    const translated = await translateSegmentsWithStructuredFallback({
      segments: structuredSegments,
      requestBatch: async (segments: StructuredTextSegment[]) => {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4096,
            temperature: 0.05,
            system: renderPrompt(promptPresets, 'translationSystem', { targetLang }),
            messages: [
              {
                role: 'user',
                content: buildStructuredTranslationPrompt({ targetLang, speakerHint, glossaryBlock, segments, promptPresets }),
              },
            ],
          }),
        });

        if (!response.ok) {
          throw new Error(`Anthropic translation error: ${response.status} ${response.statusText}`);
        }
        const json = await response.json();
        return Array.isArray(json.content)
          ? json.content.map((block: { type?: string; text?: string }) => block.type === 'text' ? (block.text ?? '') : '').join('').trim()
          : '';
      },
    });
    return translated.map((segment) => segment.text).join('\n\n').trim();
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      temperature: 0.1,
      system: renderPrompt(promptPresets, 'translationSystem', { targetLang }),
      messages: [
        {
          role: 'user',
          content: buildTranslationPrompt(text, targetLang, speakerHint, glossaryBlock, promptPresets),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic translation error: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  return Array.isArray(json.content)
    ? json.content.map((block: { type?: string; text?: string }) => block.type === 'text' ? (block.text ?? '') : '').join('').trim()
    : '';
}
