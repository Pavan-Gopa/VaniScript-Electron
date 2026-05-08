import { ChunkData, LanguageResult, OutputFormat } from '../types';
import { KaraokeTimedLine, parseKaraokeLines } from './karaoke';

type ReviewTextKind = 'original' | 'translated';

export type TranscriptExportOptions = {
  targetLang?: string;
  metadataSourceChunks?: ChunkData[];
  metadataFallback?: ExportMetadata;
  subtitleMaxCharsPerLine?: number;
  subtitleMaxLines?: number;
};

function formatClock(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
  ].join(':');
}

function getChunkText(chunk: Pick<ChunkData, 'original' | 'translated'>, which: ReviewTextKind): string {
  return which === 'original' ? chunk.original : chunk.translated;
}

function getChunkFormats(chunk: ChunkData, which: ReviewTextKind): LanguageResult | undefined {
  return which === 'original' ? chunk.originalFormats : chunk.translatedFormats;
}

function normalizeReviewText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/^(Date:[^\n]*?)\s+(Location:)/, '$1\n$2')
    .replace(/^(Date:[\s\S]*?\nLocation:[^\n]*?)\s+(Lecturer:)/, '$1\n$2')
    .replace(/^(Date:[\s\S]*?\nLocation:[\s\S]*?\nLecturer:[^\n]*?)\s+(Interviewer \/ Participants:)/, '$1\n$2')
    .replace(/(Interviewer \/ Participants:[^\n]+)\s+(\[\d{2}:\d{2}\])/, '$1\n\n$2')
    .replace(/([^\n])\s+(\[\d{2}:\d{2}\])/g, '$1\n\n$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildTimeRange(chunk: Pick<ChunkData, 'startSec' | 'endSec'>): string {
  return `${formatClock(chunk.startSec)}-${formatClock(chunk.endSec)}`;
}

function subtitleClock(totalSeconds: number, separator: ',' | '.'): string {
  return `${formatClock(totalSeconds)}${separator}000`;
}

function stripInlineTimestamps(text: string): string {
  return text
    .replace(/\[[^\]]+\]\s*/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getExportSourceText(chunk: ChunkData, which: ReviewTextKind): string {
  return normalizeReviewText(getChunkFormats(chunk, which)?.TXT || getChunkText(chunk, which));
}

type ExportMetadata = {
  date?: string;
  location?: string;
  lecturer?: string;
  participants?: string;
};

function metadataKey(rawKey: string): keyof ExportMetadata | null {
  if (rawKey === 'Date' || rawKey === 'Дата') return 'date';
  if (rawKey === 'Location' || rawKey === 'Место') return 'location';
  if (rawKey === 'Lecturer' || rawKey === 'Лектор') return 'lecturer';
  if (rawKey === 'Interviewer / Participants' || rawKey === 'Интервьюер / Участники') return 'participants';
  return null;
}

function extractMetadata(text: string): { metadata: ExportMetadata; body: string } {
  const lines = normalizeReviewText(text).split('\n');
  const metadata: ExportMetadata = {};
  let bodyStart = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      bodyStart = index + 1;
      break;
    }
    const match = line.match(/^(Date|Location|Lecturer|Interviewer \/ Participants|Дата|Место|Лектор|Интервьюер \/ Участники):\s*(.*)$/);
    if (!match) {
      bodyStart = index;
      break;
    }
    const key = metadataKey(match[1]);
    const value = match[2].trim();
    if (key) metadata[key] = value;
    bodyStart = index + 1;
  }

  return {
    metadata,
    body: lines.slice(bodyStart).join('\n').trim(),
  };
}

function collectMetadata(chunks: ChunkData[], which: ReviewTextKind): ExportMetadata {
  for (const chunk of chunks) {
    const metadata = extractMetadata(getExportSourceText(chunk, which)).metadata;
    if (metadata.date || metadata.location || metadata.lecturer || metadata.participants) return metadata;
  }
  return {};
}

function collectExportMetadata(chunks: ChunkData[], which: ReviewTextKind, options: TranscriptExportOptions): ExportMetadata {
  const primary = collectMetadata(chunks, which);
  if (primary.date || primary.location || primary.lecturer || primary.participants) return primary;
  if (options.metadataSourceChunks?.length) {
    const source = collectMetadata(options.metadataSourceChunks, 'original');
    if (source.date || source.location || source.lecturer || source.participants) return source;
  }
  return options.metadataFallback || {};
}

function timedLinesForChunk(chunk: ChunkData, which: ReviewTextKind): KaraokeTimedLine[] {
  const { body } = extractMetadata(getExportSourceText(chunk, which));
  return parseKaraokeLines(body, chunk.startSec, chunk.endSec)
    .filter((line): line is KaraokeTimedLine => line.kind === 'timed' && stripInlineTimestamps(line.text).length > 0);
}

function collectSubtitleLines(chunks: ChunkData[], which: ReviewTextKind): KaraokeTimedLine[] {
  return chunks.flatMap((chunk) => {
    const timed = timedLinesForChunk(chunk, which);
    if (timed.length > 0) return timed;

    const { body } = extractMetadata(getExportSourceText(chunk, which));
    const text = stripInlineTimestamps(body);
    if (!text) return [];
    return [{
      kind: 'timed' as const,
      timestamp: formatClock(chunk.startSec),
      startSec: chunk.startSec,
      endSec: chunk.endSec,
      text,
      words: text.match(/\S+/g) || [],
    }];
  });
}

function isRussianTarget(targetLang = ''): boolean {
  return /^(ru|rus|russian|русский|русский язык)$/i.test(targetLang.trim());
}

function localizeMetadataValue(value: string | undefined, targetLang = ''): string {
  const text = (value || '').trim();
  if (!isRussianTarget(targetLang)) return text;
  if (/^(unknown|not specified|n\/a)$/i.test(text)) return 'Неизвестно';
  if (/^(none|no|not applicable)$/i.test(text)) return 'Нет';
  return text
    .replace(/\bMayapur\b/gi, 'Маяпур')
    .replace(/\bHis Holiness\b/g, 'Его Святейшество')
    .replace(/\bHH\b/g, 'Его Святейшество');
}

function metadataLabels(targetLang = '') {
  if (isRussianTarget(targetLang)) {
    return {
      date: 'Дата',
      location: 'Место',
      lecturer: 'Лектор',
      participants: 'Интервьюер / Участники',
      transcript: 'Транскрипция',
      contents: 'Содержание',
    };
  }
  return {
    date: 'Date',
    location: 'Location',
    lecturer: 'Lecturer',
    participants: 'Interviewer / Participants',
    transcript: 'Transcript',
    contents: 'Contents',
  };
}

function metadataBlock(metadata: ExportMetadata, targetLang = ''): string {
  const labels = metadataLabels(targetLang);
  const lines = [
    metadata.date ? `${labels.date}: ${localizeMetadataValue(metadata.date, targetLang)}` : '',
    metadata.location ? `${labels.location}: ${localizeMetadataValue(metadata.location, targetLang)}` : '',
    metadata.lecturer ? `${labels.lecturer}: ${localizeMetadataValue(metadata.lecturer, targetLang)}` : '',
    metadata.participants ? `${labels.participants}: ${localizeMetadataValue(metadata.participants, targetLang)}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

function markdownMetadata(metadata: ExportMetadata, targetLang = ''): string {
  const labels = metadataLabels(targetLang);
  return [
    metadata.date ? `**${labels.date}:** ${localizeMetadataValue(metadata.date, targetLang)}` : '',
    metadata.location ? `**${labels.location}:** ${localizeMetadataValue(metadata.location, targetLang)}` : '',
    metadata.lecturer ? `**${labels.lecturer}:** ${localizeMetadataValue(metadata.lecturer, targetLang)}` : '',
    metadata.participants ? `**${labels.participants}:** ${localizeMetadataValue(metadata.participants, targetLang)}` : '',
  ].filter(Boolean).join('\n');
}

function groupTimedLines(lines: KaraokeTimedLine[]): { startSec: number; text: string }[] {
  const groups: { startSec: number; text: string }[] = [];
  let current: { startSec: number; parts: string[]; chars: number; endSec: number } | null = null;

  for (const line of lines) {
    const text = stripInlineTimestamps(line.text);
    if (!text) continue;
    const shouldStartNew = !current || (line.startSec - current.startSec) >= 180 || current.chars + text.length > 900;
    if (shouldStartNew) {
      if (current) groups.push({ startSec: current.startSec, text: current.parts.join(' ') });
      current = { startSec: line.startSec, parts: [text], chars: text.length, endSec: line.endSec };
    } else if (current) {
      current.parts.push(text);
      current.chars += text.length + 1;
      current.endSec = line.endSec;
    }
  }

  if (current) groups.push({ startSec: current.startSec, text: current.parts.join(' ') });
  return groups;
}

function buildTxtExportBody(chunks: ChunkData[], which: ReviewTextKind): string {
  return chunks.map((chunk) => {
    const timed = timedLinesForChunk(chunk, which);
    if (timed.length > 0) {
      return groupTimedLines(timed)
        .map((group) => `[${formatClock(group.startSec)}] ${group.text}`)
        .join('\n\n');
    }
    return stripInlineTimestamps(extractMetadata(getExportSourceText(chunk, which)).body);
  }).filter(Boolean).join('\n\n');
}

function safeSubtitleChars(value: number | undefined): number {
  return Math.max(8, Math.min(80, Math.round(value || 42)));
}

function safeSubtitleLines(value: number | undefined): number {
  return Math.max(1, Math.min(3, Math.round(value || 2)));
}

function wrapWords(words: string[], maxChars: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if ((current.length + 1 + word.length) <= maxChars) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function splitSubtitleLine(line: KaraokeTimedLine, options: TranscriptExportOptions): { startSec: number; endSec: number; text: string }[] {
  const maxChars = safeSubtitleChars(options.subtitleMaxCharsPerLine);
  const maxLines = safeSubtitleLines(options.subtitleMaxLines);
  const text = stripInlineTimestamps(line.text);
  const words = text.match(/\S+/g) || [];
  if (words.length === 0) return [];

  const wrappedLines = wrapWords(words, maxChars);
  const cueLineGroups: string[][] = [];
  for (let index = 0; index < wrappedLines.length; index += maxLines) {
    cueLineGroups.push(wrappedLines.slice(index, index + maxLines));
  }

  const duration = Math.max(0.1, line.endSec - line.startSec);
  return cueLineGroups.map((group, index) => {
    const startSec = line.startSec + ((duration / cueLineGroups.length) * index);
    const endSec = index === cueLineGroups.length - 1
      ? line.endSec
      : line.startSec + ((duration / cueLineGroups.length) * (index + 1));
    return {
      startSec,
      endSec,
      text: group.join('\n'),
    };
  });
}

function subtitleCues(chunks: ChunkData[], which: ReviewTextKind, options: TranscriptExportOptions) {
  return collectSubtitleLines(chunks, which).flatMap((line) => splitSubtitleLine(line, options));
}

function makeSectionTitle(text: string, index: number, targetLang = ''): string {
  const cleaned = stripInlineTimestamps(text)
    .replace(/[*_`>#-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const firstSentence = cleaned.split(/(?<=[.!?。！？])\s+/)[0] || cleaned;
  const words = firstSentence.split(/\s+/).filter(Boolean).slice(0, isRussianTarget(targetLang) ? 7 : 8);
  const title = words.join(' ').replace(/[.,;:!?]+$/g, '');
  return title || `${metadataLabels(targetLang).transcript} ${index + 1}`;
}

function buildSrtCue(chunk: Pick<ChunkData, 'index' | 'startSec' | 'endSec' | 'original' | 'translated'>, which: ReviewTextKind): string {
  return [
    String(chunk.index + 1),
    `${formatClock(chunk.startSec)},000 --> ${formatClock(chunk.endSec)},000`,
    getChunkText(chunk, which),
  ].join('\n');
}

function buildVttCue(chunk: Pick<ChunkData, 'startSec' | 'endSec' | 'original' | 'translated'>, which: ReviewTextKind): string {
  return [
    `${formatClock(chunk.startSec)}.000 --> ${formatClock(chunk.endSec)}.000`,
    getChunkText(chunk, which),
  ].join('\n');
}

export function buildChunkPreview(
  chunk: ChunkData,
  which: ReviewTextKind,
  format: OutputFormat,
  options: TranscriptExportOptions = {}
): string {
  const formatted = getChunkFormats(chunk, which)?.[format];
  if (formatted) {
    if (format === 'TXT') {
      const normalized = normalizeReviewText(formatted);
      if (which === 'translated' && options.targetLang) {
        const parsed = extractMetadata(normalized);
        const metadata = parsed.metadata.date || parsed.metadata.location || parsed.metadata.lecturer || parsed.metadata.participants
          ? `${metadataBlock(parsed.metadata, options.targetLang)}\n\n`
          : '';
        return `${metadata}${parsed.body}`.trim();
      }
      return normalized;
    }
    return formatted;
  }

  if (format === 'TXT') return normalizeReviewText(getChunkText(chunk, which));
  if (format === 'SRT') return buildSrtCue(chunk, which);
  if (format === 'VTT') return `WEBVTT\n\n${buildVttCue(chunk, which)}`;
  return `## Segment ${chunk.index + 1} [${buildTimeRange(chunk)}]\n\n${getChunkText(chunk, which)}`;
}

export function buildTranscriptExport(
  which: ReviewTextKind,
  format: OutputFormat,
  chunks: ChunkData[],
  options: TranscriptExportOptions = {}
): string {
  if (format === 'TXT') {
    const metadata = metadataBlock(collectExportMetadata(chunks, which, options), options.targetLang);
    const body = buildTxtExportBody(chunks, which);
    return [metadata, body].filter(Boolean).join('\n\n').trim();
  }

  if (format === 'SRT') {
    const cues = subtitleCues(chunks, which, options).map((line, index) => [
      String(index + 1),
      `${subtitleClock(line.startSec, ',')} --> ${subtitleClock(line.endSec, ',')}`,
      line.text,
    ].join('\n'));
    return `${cues.join('\n\n')}\n`;
  }

  if (format === 'VTT') {
    const cues = subtitleCues(chunks, which, options).map((line) => [
      `${subtitleClock(line.startSec, '.')} --> ${subtitleClock(line.endSec, '.')}`,
      line.text,
    ].join('\n'));
    return `WEBVTT\n\n${cues.join('\n\n')}\n`;
  }

  const metadata = collectExportMetadata(chunks, which, options);
  const labels = metadataLabels(options.targetLang);
  const title = metadata.location && !/^(unknown|неизвестно)$/i.test(metadata.location) ? metadata.location : labels.transcript;
  const meta = markdownMetadata(metadata, options.targetLang);
  const groups = groupTimedLines(collectSubtitleLines(chunks, which));
  const sections = groups.length > 0
    ? groups.map((group, index) => ({
      title: makeSectionTitle(group.text, index, options.targetLang),
      text: group.text,
    }))
    : [];
  const toc = sections.length > 0
    ? [`## ${labels.contents}`, sections.map((section, index) => `${index + 1}. ${section.title}`).join('\n')].join('\n\n')
    : '';
  const body = sections.length > 0
    ? sections.map((section, index) => `## ${index + 1}. ${section.title}\n\n${section.text}`).join('\n\n')
    : chunks.map((chunk) => stripInlineTimestamps(extractMetadata(getExportSourceText(chunk, which)).body)).filter(Boolean).join('\n\n');
  return [`# ${title}`, meta, '---', toc, body].filter(Boolean).join('\n\n').trim();
}
