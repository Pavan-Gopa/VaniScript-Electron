import { GoogleGenAI } from '@google/genai';
import { renderPrompt, type PromptSettingsMap } from '../lib/prompt-presets';

function collapseDuplicateTimestamps(text: string): string {
  return text.replace(/(\[\d{2}:\d{2}(?::\d{2})?\])(?:\s*\1)+/g, '$1');
}

export function sanitizeLiteraryPolishOutput(rawText: string, originalText = ''): string {
  let text = String(rawText ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:\w+)?\s*([\s\S]*?)```/g, '$1')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^\s*(?:Here is|Here's|Below is)[^\n]*:\s*/i, '')
    .trim();

  const marked = text.match(/<<<RESULT>>>\s*([\s\S]*?)(?:<<<END>>>|$)/i);
  if (marked?.[1]) text = marked[1].trim();

  text = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:(?:revised|polished|improved|edited|final)\s+)?(?:russian|translation|перевод|русский)\s*:\s*/i, '').trimEnd())
    .filter((line) => !/^\s*(?:(?:revised|polished|improved|edited|final)\s+)?(?:russian|translation|перевод|русский)\s*:?\s*$/i.test(line))
    .join('\n')
    .trim();

  text = collapseDuplicateTimestamps(text)
    .replace(/^(?:\s*\[\d{2}:\d{2}(?::\d{2})?\]){2,}\s*/g, (match) => {
      const first = match.match(/\[\d{2}:\d{2}(?::\d{2})?\]/)?.[0] ?? '';
      return first ? `${first} ` : '';
    })
    .trim();

  if (!text && originalText) return originalText.trim();
  return text;
}

export function buildLiteraryPolishPrompt(opts: {
  text: string;
  targetLang: string;
  speakerHint?: string;
  glossaryBlock?: string;
  promptPresets?: PromptSettingsMap;
}): string {
  return renderPrompt(opts.promptPresets, 'literaryPolishUser', {
    targetLang: opts.targetLang,
    speakerHintLine: opts.speakerHint ? `Context: ${opts.speakerHint}.` : '',
    glossaryBlock: opts.glossaryBlock || '',
    russianPolishRule: opts.targetLang.toLowerCase().includes('russian')
      ? '7. For Russian, avoid literal calques. Use natural Russian syntax and correct agreement, for example "отвечать за строительство", not "быть ответственным из конструкции".'
      : '',
    text: opts.text,
  });
}

export async function polishTranslationWithGemini(opts: {
  text: string;
  targetLang: string;
  apiKey: string;
  speakerHint?: string;
  glossaryBlock?: string;
  promptPresets?: PromptSettingsMap;
}): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: buildLiteraryPolishPrompt(opts),
    config: {
      systemInstruction: renderPrompt(opts.promptPresets, 'literaryPolishSystem', { targetLang: opts.targetLang }),
      temperature: 0.2,
    },
  });
  return sanitizeLiteraryPolishOutput(response.text ?? '', opts.text);
}

export async function polishTranslationWithOpenAI(opts: {
  text: string;
  targetLang: string;
  apiKey: string;
  speakerHint?: string;
  glossaryBlock?: string;
  promptPresets?: PromptSettingsMap;
}): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: renderPrompt(opts.promptPresets, 'literaryPolishSystem', { targetLang: opts.targetLang }) },
        { role: 'user', content: buildLiteraryPolishPrompt(opts) },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI polish error: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  return sanitizeLiteraryPolishOutput(json.choices?.[0]?.message?.content ?? '', opts.text);
}

export async function polishTranslationWithClaude(opts: {
  text: string;
  targetLang: string;
  apiKey: string;
  speakerHint?: string;
  glossaryBlock?: string;
  promptPresets?: PromptSettingsMap;
}): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      temperature: 0.2,
      system: renderPrompt(opts.promptPresets, 'literaryPolishSystem', { targetLang: opts.targetLang }),
      messages: [{ role: 'user', content: buildLiteraryPolishPrompt(opts) }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic polish error: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  const text = Array.isArray(json.content)
    ? json.content.map((block: { type?: string; text?: string }) => block.type === 'text' ? (block.text ?? '') : '').join('').trim()
    : '';
  return sanitizeLiteraryPolishOutput(text, opts.text);
}

export async function polishTranslationLocally(opts: {
  modelId: string;
  text: string;
  targetLang: string;
  speakerHint?: string;
  glossaryBlock?: string;
  promptPresets?: PromptSettingsMap;
}): Promise<string> {
  if (!window.electronAPI) throw new Error('Local polish requires the Electron runtime.');
  const result = await window.electronAPI.localTranslateText({
    modelId: opts.modelId,
    mode: 'custom',
    text: buildLiteraryPolishPrompt(opts),
    targetLang: opts.targetLang,
    speakerHint: opts.speakerHint,
    glossaryBlock: opts.glossaryBlock,
    maxTokens: Math.max(256, Math.min(1200, Math.ceil(opts.text.length * 1.6))),
    maxOutputChars: 30000,
  });
  return sanitizeLiteraryPolishOutput(result.text ?? '', opts.text);
}
