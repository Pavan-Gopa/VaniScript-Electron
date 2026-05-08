import { OutputFormat } from '../types';

export type ExportFileNameInput = {
  sourceFileName: string;
  lecturer?: string;
  location?: string;
  date?: string;
  which: 'original' | 'translated';
  targetLang?: string;
  format: OutputFormat;
};

export function exportExtension(format: OutputFormat): string {
  return format === 'Markdown' ? 'md' : format.toLowerCase();
}

function cleanPart(value: string | undefined): string {
  const text = String(value || '').trim();
  if (!text || /^(unknown|неизвестно|none|нет|n\/a)$/i.test(text)) return '';
  return text
    .replace(/\.[^.]+$/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 72);
}

export function buildExportFileName(input: ExportFileNameInput): string {
  const sourceStem = cleanPart(input.sourceFileName) || 'VaniScript';
  const suffix = input.which === 'translated'
    ? cleanPart(input.targetLang) || 'translated'
    : 'original';
  const parts = [
    cleanPart(input.lecturer),
    cleanPart(input.location),
    cleanPart(input.date),
  ].filter(Boolean);
  const baseParts = parts.length > 0 ? parts : [sourceStem];
  const uniqueParts = baseParts.filter((part, index, arr) => arr.indexOf(part) === index);
  return `${[...uniqueParts, suffix].join('_')}.${exportExtension(input.format)}`;
}
