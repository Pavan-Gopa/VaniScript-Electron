import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTaggedTranscriptionResult } from './tagged-result';

test('parseTaggedTranscriptionResult extracts separate format blocks and fragments', () => {
  const raw = `
[ORIGINAL_TXT]
Date: Unknown

[00:00] Plain transcript
[/ORIGINAL_TXT]
[TRANSLATED_TXT]
Дата: Неизвестно

[00:00] Перевод
[/TRANSLATED_TXT]
[ORIGINAL_SRT]
1
00:00:00,000 --> 00:00:02,000
Plain transcript
[/ORIGINAL_SRT]
[ORIGINAL_VTT]
WEBVTT

00:00:00.000 --> 00:00:02.000
Plain transcript
[/ORIGINAL_VTT]
[ORIGINAL_MARKDOWN]
# Title

Paragraph.
[/ORIGINAL_MARKDOWN]
UNRECOGNIZED FRAGMENTS LIST
- {unclear word}
- {another fragment}
`;

  const result = parseTaggedTranscriptionResult(raw);

  assert.equal(result.original.TXT, 'Date: Unknown\n\n[00:00] Plain transcript');
  assert.equal(result.translated?.TXT, 'Дата: Неизвестно\n\n[00:00] Перевод');
  assert.equal(result.original.SRT, '1\n00:00:00,000 --> 00:00:02,000\nPlain transcript');
  assert.equal(result.original.VTT, 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nPlain transcript');
  assert.equal(result.original.Markdown, '# Title\n\nParagraph.');
  assert.deepEqual(result.unrecognizedFragments, ['- {unclear word}', '- {another fragment}']);
});

test('parseTaggedTranscriptionResult falls back to plain txt when tags are absent', () => {
  const result = parseTaggedTranscriptionResult('Simple raw text\nUNRECOGNIZED FRAGMENTS LIST\n- None');

  assert.equal(result.original.TXT, 'Simple raw text');
  assert.deepEqual(result.unrecognizedFragments, ['- None']);
});
