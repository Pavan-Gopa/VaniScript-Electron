import { renderPrompt, type PromptSettingsMap } from '../lib/prompt-presets';

export function shouldTranslateChunk(targetLang: string): boolean {
  return targetLang.trim().toLowerCase() !== 'same';
}

function splitOversizedParagraph(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) return [paragraph];
  const sentences = paragraph.match(/[^.!?。！？]+[.!?。！？]*/g) ?? [paragraph];
  const parts: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence.trim()}` : sentence.trim();
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    if (current) parts.push(current);
    if (sentence.length <= maxChars) {
      current = sentence.trim();
    } else {
      for (let i = 0; i < sentence.length; i += maxChars) {
        parts.push(sentence.slice(i, i + maxChars).trim());
      }
      current = '';
    }
  }

  if (current) parts.push(current);
  return parts.filter(Boolean);
}

export function splitLocalTranslationBatches(text: string, maxChars = 1400): string[] {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => splitOversizedParagraph(part, maxChars));

  const batches: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    if (current) batches.push(current);
    current = paragraph;
  }

  if (current) batches.push(current);
  return batches.length > 0 ? batches : [text.trim()].filter(Boolean);
}

function restoreLeadingTimestamp(source: string, translated: string): string {
  if (/\[\d{2}:\d{2}\]/.test(translated)) return translated;
  const match = source.match(/\[\d{2}:\d{2}\]/);
  return match ? `${match[0]} ${translated}` : translated;
}

export async function translateTextLocally(opts: {
  modelId: string;
  text: string;
  targetLang: string;
  speakerHint?: string;
  glossaryBlock?: string;
  promptPresets?: PromptSettingsMap;
}): Promise<string> {
  if (!window.electronAPI) {
    throw new Error('Local translation requires the Electron runtime.');
  }

  const batches = splitLocalTranslationBatches(opts.text);
  const translated: string[] = [];

  for (const batch of batches) {
    const maxTokens = Math.max(256, Math.min(1200, Math.ceil(batch.length * 1.4)));
    const prompt = renderPrompt(opts.promptPresets, 'localTranslationUser', {
      targetLang: opts.targetLang,
      speakerHintLine: opts.speakerHint ? `Context: ${opts.speakerHint}` : '',
      glossaryBlock: opts.glossaryBlock || '',
      text: batch,
    });
    const result = await window.electronAPI.localTranslateText({
      ...opts,
      mode: 'custom',
      text: prompt,
      maxTokens,
      maxOutputChars: 60000,
    });
    const text = result.text?.trim();
    if (text) translated.push(restoreLeadingTimestamp(batch, text));
  }

  return translated.join('\n\n').trim();
}
