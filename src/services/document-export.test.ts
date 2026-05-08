import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDocumentExportPrompt,
  combineLocalMarkdownParts,
  combineDocumentExportParts,
  localDocumentBatchLimit,
  splitDocumentExportInput,
  sanitizeDocumentExportOutput,
} from './document-export';

test('buildDocumentExportPrompt instructs AI to format markdown without editing text', () => {
  const prompt = buildDocumentExportPrompt({
    format: 'Markdown',
    targetLang: 'Russian',
    text: 'Дата: 2020\n\nТекст лекции.',
  });

  assert.match(prompt, /formatting editor/i);
  assert.match(prompt, /Do not rewrite/i);
  assert.match(prompt, /Russian Markdown document/i);
  assert.match(prompt, /Содержание|table of contents/i);
});

test('buildDocumentExportPrompt passes subtitle layout settings as constraints', () => {
  const prompt = buildDocumentExportPrompt({
    format: 'SRT',
    targetLang: 'Russian',
    text: '1\n00:00:00,000 --> 00:00:10,000\nШрила Прабхупада говорил.',
    subtitleMaxCharsPerLine: 22,
    subtitleMaxLines: 2,
  });

  assert.match(prompt, /SRT/);
  assert.match(prompt, /22 characters/);
  assert.match(prompt, /2 lines/);
  assert.match(prompt, /Do not split proper names/i);
});

test('sanitizeDocumentExportOutput unwraps fenced AI output', () => {
  assert.equal(
    sanitizeDocumentExportOutput('```markdown\n# Title\n\nText\n```'),
    '# Title\n\nText'
  );
});

test('splitDocumentExportInput keeps subtitle cues together for local AI batches', () => {
  const srt = [
    '1\n00:00:00,000 --> 00:00:02,000\nFirst cue.',
    '2\n00:00:02,000 --> 00:00:04,000\nSecond cue.',
    '3\n00:00:04,000 --> 00:00:06,000\nThird cue.',
  ].join('\n\n');

  const batches = splitDocumentExportInput(srt, 'SRT', 70);
  assert.equal(batches.length, 3);
  assert.match(batches[0], /^1\n00:00:00,000 -->/);
});

test('localDocumentBatchLimit uses larger batches for the 16k local export context', () => {
  assert.equal(localDocumentBatchLimit('Markdown'), 6000);
  assert.equal(localDocumentBatchLimit('SRT'), 4500);
  assert.equal(localDocumentBatchLimit('VTT'), 4500);
});

test('splitDocumentExportInput splits oversized markdown paragraphs instead of sending one huge prompt', () => {
  const longParagraph = Array.from({ length: 120 }, (_, index) => `Предложение ${index + 1} о Майяпуре и строительстве самадхи.`).join(' ');
  const batches = splitDocumentExportInput(longParagraph, 'Markdown', 700);

  assert.ok(batches.length > 1);
  assert.ok(batches.every((batch) => batch.length <= 850));
});

test('combineLocalMarkdownParts keeps one metadata block and one contents section', () => {
  const sourceDocument = [
    '# Маяпур',
    '',
    '**Дата:** 2020',
    '**Место:** Маяпур',
    '**Лектор:** Его Святейшество Кадамба Канана Свами',
    '',
    '---',
    '',
    '## Содержание',
    '',
    '1. Старое содержание',
    '',
    '## 1. Первый раздел',
    '',
    'Первый текст.',
  ].join('\n');
  const combined = combineLocalMarkdownParts([
    [
      '# Маяпур',
      '',
      '**Дата:** 2020',
      '',
      '## Содержание',
      '',
      '1. Подготовка',
      '',
      '## Подготовка',
      '',
      'Первый текст.',
    ].join('\n'),
    [
      '## Содержание',
      '',
      '1. Продолжение',
      '',
      '## Продолжение',
      '',
      'Второй текст.',
    ].join('\n'),
  ], sourceDocument, 'Russian');

  assert.equal((combined.match(/^# /gm) || []).length, 1);
  assert.equal((combined.match(/\*\*Дата:\*\*/g) || []).length, 1);
  assert.equal((combined.match(/^## Содержание$/gm) || []).length, 1);
  assert.match(combined, /## Подготовка/);
  assert.match(combined, /## Продолжение/);
  assert.match(combined, /Первый текст/);
  assert.match(combined, /Второй текст/);
});

test('combineDocumentExportParts renumbers SRT and keeps one VTT header', () => {
  assert.equal(
    combineDocumentExportParts([
      '1\n00:00:00,000 --> 00:00:02,000\nFirst.',
      '1\n00:00:02,000 --> 00:00:04,000\nSecond.',
    ], 'SRT'),
    '1\n00:00:00,000 --> 00:00:02,000\nFirst.\n\n2\n00:00:02,000 --> 00:00:04,000\nSecond.'
  );

  assert.equal(
    combineDocumentExportParts([
      'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nFirst.',
      'WEBVTT\n\n00:00:02.000 --> 00:00:04.000\nSecond.',
    ], 'VTT'),
    'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nFirst.\n\n00:00:02.000 --> 00:00:04.000\nSecond.'
  );
});
