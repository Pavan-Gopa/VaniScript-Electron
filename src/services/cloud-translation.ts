import { GoogleGenAI } from '@google/genai';

const VAISHNAVA_TRANSLATION_SYSTEM = `You are a precise translation engine for Gaudiya Vaishnava lectures.

RULES:
1. Preserve meaning exactly. Do not summarize.
2. Keep names and Sanskrit/Bengali philosophical terms in standard transliteration when natural.
3. Preserve every [MM:SS] timestamp marker exactly where it appears.
4. Preserve paragraph breaks and do not collapse the text into one paragraph.
5. Translate metadata labels naturally when the target language is not English.
6. Do not add commentary, notes, or explanations.
7. Return only the translated text.`;

function buildTranslationPrompt(text: string, targetLang: string, speakerHint: string, glossaryBlock = ''): string {
  return [
    `Translate the following transcript to ${targetLang}.`,
    speakerHint ? `Primary speaker hint: ${speakerHint}.` : '',
    glossaryBlock,
    'Keep all [MM:SS] timestamp markers unchanged.',
    'Keep metadata as a separate block at the top if present.',
    'Keep paragraph breaks. Do not return one dense paragraph.',
    'Return only the translated text.',
    '',
    text,
  ].filter(Boolean).join('\n');
}

export async function translateTextWithGemini(
  text: string,
  targetLang: string,
  apiKey: string,
  speakerHint: string,
  glossaryBlock = ''
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: buildTranslationPrompt(text, targetLang, speakerHint, glossaryBlock),
    config: {
      systemInstruction: VAISHNAVA_TRANSLATION_SYSTEM,
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
  glossaryBlock = ''
): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: VAISHNAVA_TRANSLATION_SYSTEM },
        { role: 'user', content: buildTranslationPrompt(text, targetLang, speakerHint, glossaryBlock) },
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
  glossaryBlock = ''
): Promise<string> {
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
      system: VAISHNAVA_TRANSLATION_SYSTEM,
      messages: [
        {
          role: 'user',
          content: buildTranslationPrompt(text, targetLang, speakerHint, glossaryBlock),
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
