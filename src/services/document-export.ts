import { GoogleGenAI } from '@google/genai';
import { OutputFormat } from '../types';

export type AiDocumentExportOptions = {
  format: OutputFormat;
  targetLang: string;
  text: string;
  subtitleMaxCharsPerLine?: number;
  subtitleMaxLines?: number;
};

export function sanitizeDocumentExportOutput(rawText: string): string {
  let text = String(rawText ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();

  const marked = text.match(/<<<DOCUMENT>>>\s*([\s\S]*?)(?:<<<END>>>|$)/i);
  if (marked?.[1]) text = marked[1].trim();

  text = text
    .replace(/^```(?:markdown|md|srt|vtt|txt|text)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/^\s*(?:Here is|Here's|Below is)[^\n]*:\s*/i, '')
    .trim();

  return text;
}

export function buildDocumentExportPrompt(opts: AiDocumentExportOptions): string {
  const lang = opts.targetLang || 'the target language';
  if (opts.format === 'Markdown') {
    return [
      `You are a formatting editor. Create a polished ${lang} Markdown document from the prepared transcript below.`,
      '',
      'Hard rules:',
      '1. Do not rewrite, paraphrase, summarize, correct, remove, or add transcript content.',
      '2. Preserve the transcript text exactly, except removing timestamp markers if present.',
      '3. You may add Markdown structure only: title, metadata block, table of contents, section headings, bold emphasis for short labels, horizontal rules, and paragraph breaks.',
      '4. Divide the document by meaning. Section headings must describe the actual topic of the section, not merely copy the first sentence.',
      '5. Preserve all metadata at the top and localize metadata labels to the document language.',
      '6. Return only the Markdown document. No notes or explanations.',
      '',
      'For Russian Markdown use Russian labels such as "Дата", "Место", "Лектор", "Интервьюер / Участники", and "Содержание".',
      '',
      '<<<TRANSCRIPT>>>',
      opts.text,
      '<<<DOCUMENT>>>',
    ].join('\n');
  }

  if (opts.format === 'SRT' || opts.format === 'VTT') {
    const maxChars = opts.subtitleMaxCharsPerLine ?? 42;
    const maxLines = opts.subtitleMaxLines ?? 2;
    return [
      `You are a professional subtitle formatter. Format the prepared transcript as valid ${opts.format}.`,
      '',
      'Hard rules:',
      '1. Do not rewrite, paraphrase, translate, correct, remove, or add spoken text.',
      '2. Keep timings accurate and monotonic. Preserve the provided timing boundaries as closely as possible.',
      `3. Prefer no more than ${maxChars} characters per line and no more than ${maxLines} lines per subtitle cue.`,
      '4. Break subtitles at natural phrase boundaries.',
      '5. Do not split proper names, titles, Sanskrit terms, or devotional names across subtitle cues or lines when avoidable.',
      '6. If a phrase would read badly when split, make the cue slightly shorter or longer rather than splitting the phrase awkwardly.',
      `7. Return only valid ${opts.format}. No notes, no markdown fences, no explanations.`,
      '',
      '<<<TRANSCRIPT>>>',
      opts.text,
      `<<<${opts.format}>>>`,
    ].join('\n');
  }

  return opts.text;
}

export function splitDocumentExportInput(text: string, format: OutputFormat, maxChars = 3500): string[] {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  if (format === 'SRT') {
    return splitBlocks(normalized, /\n{2,}/, maxChars);
  }

  if (format === 'VTT') {
    const body = normalized.replace(/^WEBVTT\s*\n+/i, '').trim();
    return splitBlocks(body, /\n{2,}/, maxChars).map((part) => `WEBVTT\n\n${part}`);
  }

  if (format === 'Markdown') {
    return splitBlocks(normalized, /\n{2,}/, maxChars);
  }

  return [normalized];
}

export function localDocumentBatchLimit(format: OutputFormat): number {
  if (format === 'Markdown') return 6000;
  if (format === 'SRT' || format === 'VTT') return 4500;
  return 12000;
}

function splitBlocks(text: string, separator: RegExp, maxChars: number): string[] {
  const blocks = text.split(separator).map((block) => block.trim()).filter(Boolean);
  const batches: string[] = [];
  let current = '';

  for (const block of blocks) {
    const blockParts = splitOversizedBlock(block, maxChars);
    for (const part of blockParts) {
      const next = current ? `${current}\n\n${part}` : part;
      if (next.length <= maxChars) {
        current = next;
        continue;
      }
      if (current) batches.push(current);
      current = part;
    }
  }

  if (current) batches.push(current);
  return batches.length > 0 ? batches : [text];
}

function splitOversizedBlock(block: string, maxChars: number): string[] {
  if (block.length <= maxChars) return [block];
  const units = block
    .split(/(?<=[.!?…。！？])\s+|\n+/)
    .map((unit) => unit.trim())
    .filter(Boolean);
  if (units.length <= 1) return splitByLength(block, maxChars);

  const parts: string[] = [];
  let current = '';
  for (const unit of units) {
    if (unit.length > maxChars) {
      if (current) {
        parts.push(current);
        current = '';
      }
      parts.push(...splitByLength(unit, maxChars));
      continue;
    }
    const next = current ? `${current} ${unit}` : unit;
    if (next.length <= maxChars) {
      current = next;
    } else {
      if (current) parts.push(current);
      current = unit;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function splitByLength(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 1) {
    const parts: string[] = [];
    for (let index = 0; index < text.length; index += maxChars) {
      parts.push(text.slice(index, index + maxChars));
    }
    return parts;
  }

  const parts: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) {
      current = next;
    } else {
      if (current) parts.push(current);
      current = word;
    }
  }
  if (current) parts.push(current);
  return parts;
}

export function combineDocumentExportParts(parts: string[], format: OutputFormat): string {
  const cleaned = parts.map(sanitizeDocumentExportOutput).filter(Boolean);
  if (format === 'SRT') {
    const cues = cleaned.flatMap((part) => part.split(/\n{2,}/).map((cue) => cue.trim()).filter(Boolean));
    return cues.map((cue, index) => {
      const lines = cue.split('\n');
      return [String(index + 1), ...lines.filter((line, lineIndex) => lineIndex !== 0 || !/^\d+$/.test(line.trim()))].join('\n');
    }).join('\n\n');
  }

  if (format === 'VTT') {
    const cues = cleaned
      .map((part) => part.replace(/^WEBVTT\s*\n+/i, '').trim())
      .filter(Boolean)
      .join('\n\n');
    return `WEBVTT\n\n${cues}`;
  }

  return cleaned.join('\n\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

function isRussianTarget(targetLang = ''): boolean {
  return /^(ru|rus|russian|русский|русский язык)$/i.test(targetLang.trim());
}

function markdownContentsTitle(targetLang = ''): string {
  return isRussianTarget(targetLang) ? 'Содержание' : 'Contents';
}

function defaultMarkdownTitle(targetLang = ''): string {
  return isRussianTarget(targetLang) ? 'Транскрипция' : 'Transcript';
}

function isMarkdownMetadataLine(line: string): boolean {
  return /^\s*(?:\*\*)?(?:Date|Location|Lecturer|Interviewer \/ Participants|Дата|Место|Лектор|Интервьюер \/ Участники)(?:\*\*)?\s*:/.test(line);
}

function isContentsHeading(line: string): boolean {
  return /^#{1,3}\s+(?:Содержание|Contents)\s*$/i.test(line.trim());
}

function stripMarkdownDocumentShell(markdown: string): string {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const body: string[] = [];
  let skippingContents = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#\s+/.test(trimmed)) continue;
    if (/^---+$/.test(trimmed)) continue;
    if (isMarkdownMetadataLine(trimmed)) continue;
    if (isContentsHeading(trimmed)) {
      skippingContents = true;
      continue;
    }
    if (skippingContents) {
      if (/^#{1,6}\s+/.test(trimmed)) {
        skippingContents = false;
      } else {
        continue;
      }
    }
    body.push(line);
  }

  return body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractMarkdownShell(markdown: string, targetLang = ''): { title: string; metadata: string } {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const title = lines.find((line) => /^#\s+/.test(line.trim()))?.trim() || `# ${defaultMarkdownTitle(targetLang)}`;
  const metadata = lines
    .filter((line) => isMarkdownMetadataLine(line.trim()))
    .map((line) => line.trim())
    .filter((line, index, arr) => arr.indexOf(line) === index)
    .join('\n');
  return { title, metadata };
}

function sanitizeLocalMarkdownBodyPart(rawText: string): string {
  const text = sanitizeDocumentExportOutput(rawText);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const body: string[] = [];
  let skippingContents = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#\s+/.test(trimmed)) continue;
    if (/^---+$/.test(trimmed)) continue;
    if (isMarkdownMetadataLine(trimmed)) continue;
    if (isContentsHeading(trimmed)) {
      skippingContents = true;
      continue;
    }
    if (skippingContents) {
      if (/^#{1,6}\s+/.test(trimmed)) {
        skippingContents = false;
      } else {
        continue;
      }
    }
    body.push(line);
  }

  return body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizedBlock(block: string): string {
  return block
    .replace(/^#+\s*/, '')
    .replace(/^\d+\.\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function mergeMarkdownBodyParts(parts: string[]): string {
  const blocks: string[] = [];
  for (const part of parts.map(sanitizeLocalMarkdownBodyPart).filter(Boolean)) {
    const partBlocks = part.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
    for (const block of partBlocks) {
      const previous = blocks[blocks.length - 1];
      if (previous && normalizedBlock(previous) === normalizedBlock(block)) continue;
      blocks.push(block);
    }
  }
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function markdownToc(body: string, targetLang = ''): string {
  const headings = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^##\s+/.test(line) && !isContentsHeading(line))
    .map((line) => line.replace(/^##\s+/, '').trim())
    .filter(Boolean);
  if (headings.length === 0) return '';
  return [`## ${markdownContentsTitle(targetLang)}`, headings.map((heading, index) => `${index + 1}. ${heading.replace(/^\d+\.\s*/, '')}`).join('\n')].join('\n\n');
}

export function combineLocalMarkdownParts(parts: string[], sourceDocument: string, targetLang = ''): string {
  const shell = extractMarkdownShell(sourceDocument, targetLang);
  const body = mergeMarkdownBodyParts(parts);
  const toc = markdownToc(body, targetLang);
  return [shell.title, shell.metadata, '---', toc, body]
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function buildLocalMarkdownPartPrompt(opts: AiDocumentExportOptions & { partIndex: number; totalParts: number }): string {
  const lang = opts.targetLang || 'the target language';
  return [
    `You are formatting part ${opts.partIndex + 1} of ${opts.totalParts} of a ${lang} Markdown document.`,
    '',
    'Hard rules:',
    '1. Return only Markdown body sections for this fragment.',
    '2. Do not include document title, metadata, table of contents, "Содержание", "Contents", or horizontal rules.',
    '3. Do not rewrite, paraphrase, summarize, correct, remove, or add transcript content.',
    '4. Remove timestamp markers if present.',
    '5. Add only meaningful section headings and paragraph breaks.',
    '6. If the fragment continues a previous topic, use a continuation heading only when it is genuinely needed.',
    '7. No notes, no explanations, no markdown fences.',
    '',
    '<<<TRANSCRIPT_FRAGMENT>>>',
    opts.text,
    '<<<DOCUMENT_PART>>>',
  ].join('\n');
}

export async function formatDocumentExportWithGemini(opts: AiDocumentExportOptions & { apiKey: string }): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: buildDocumentExportPrompt(opts),
    config: { temperature: 0.1 },
  });
  return sanitizeDocumentExportOutput(response.text ?? '');
}

export async function formatDocumentExportWithOpenAI(opts: AiDocumentExportOptions & { apiKey: string }): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      messages: [
        { role: 'system', content: 'You format prepared transcripts into final documents and subtitle files without changing the transcript text.' },
        { role: 'user', content: buildDocumentExportPrompt(opts) },
      ],
    }),
  });
  if (!response.ok) throw new Error(`OpenAI document export error: ${response.status} ${response.statusText}`);
  const json = await response.json();
  return sanitizeDocumentExportOutput(json.choices?.[0]?.message?.content ?? '');
}

export async function formatDocumentExportLocally(opts: AiDocumentExportOptions & { modelId: string }): Promise<string> {
  if (!window.electronAPI) throw new Error('Local document export requires the Electron runtime.');
  const localText = opts.format === 'Markdown' ? stripMarkdownDocumentShell(opts.text) : opts.text;
  const batches = splitDocumentExportInput(localText, opts.format, localDocumentBatchLimit(opts.format));
  const formattedParts: string[] = [];

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const prompt = opts.format === 'Markdown'
      ? buildLocalMarkdownPartPrompt({ ...opts, text: batch, partIndex: index, totalParts: batches.length })
      : buildDocumentExportPrompt({ ...opts, text: batch });
    const result = await window.electronAPI.localTranslateText({
      modelId: opts.modelId,
      mode: 'custom',
      text: prompt,
      targetLang: opts.targetLang,
      maxTokens: Math.max(1024, Math.min(5000, Math.ceil(batch.length * 1.4))),
      ctxSize: 16384,
      requestTimeoutMs: 180000,
      maxOutputChars: 70000,
    });
    const text = opts.format === 'Markdown'
      ? sanitizeLocalMarkdownBodyPart(result.text ?? '')
      : sanitizeDocumentExportOutput(result.text ?? '');
    if (text) formattedParts.push(text);
  }

  if (opts.format === 'Markdown') {
    return combineLocalMarkdownParts(formattedParts, opts.text, opts.targetLang);
  }

  return combineDocumentExportParts(formattedParts, opts.format);
}
