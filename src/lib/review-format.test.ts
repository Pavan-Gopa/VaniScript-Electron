import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChunkPreview, buildTranscriptExport } from './review-format';

const chunks = [
  {
    index: 0,
    filePath: '/tmp/chunk 0000.wav',
    durationSec: 65,
    startSec: 0,
    endSec: 65,
    original: 'First line',
    translated: 'Первая строка',
    status: 'done' as const,
    approved: true,
  },
  {
    index: 1,
    filePath: '/tmp/chunk 0001.wav',
    durationSec: 70,
    startSec: 65,
    endSec: 135,
    original: 'Second line',
    translated: 'Вторая строка',
    status: 'done' as const,
    approved: true,
  },
];

test('buildChunkPreview renders distinct output per format', () => {
  const txt = buildChunkPreview(chunks[0], 'original', 'TXT');
  const srt = buildChunkPreview(chunks[0], 'original', 'SRT');
  const vtt = buildChunkPreview(chunks[0], 'original', 'VTT');
  const markdown = buildChunkPreview(chunks[0], 'original', 'Markdown');

  assert.equal(txt, 'First line');
  assert.equal(srt, '1\n00:00:00,000 --> 00:01:05,000\nFirst line');
  assert.equal(vtt, 'WEBVTT\n\n00:00:00.000 --> 00:01:05.000\nFirst line');
  assert.equal(markdown, '## Segment 1 [00:00:00-00:01:05]\n\nFirst line');

  assert.notEqual(txt, srt);
  assert.notEqual(srt, vtt);
  assert.notEqual(vtt, markdown);
});

test('buildTranscriptExport formats full transcript for downloads', () => {
  assert.equal(
    buildTranscriptExport('original', 'TXT', chunks),
    'First line\n\nSecond line'
  );

  assert.equal(
    buildTranscriptExport('original', 'SRT', chunks),
    '1\n00:00:00,000 --> 00:01:05,000\nFirst line\n\n2\n00:01:05,000 --> 00:02:15,000\nSecond line\n'
  );

  assert.equal(
    buildTranscriptExport('translated', 'VTT', chunks),
    'WEBVTT\n\n00:00:00.000 --> 00:01:05.000\nПервая строка\n\n00:01:05.000 --> 00:02:15.000\nВторая строка\n'
  );
});

test('buildTranscriptExport regenerates subtitle cues from timed review text', () => {
  const timedChunks = [
    {
      ...chunks[0],
      endSec: 20,
      durationSec: 20,
      original: '[00:00] First sentence.\n\n[00:08] Second sentence.',
      originalFormats: {
        TXT: 'Date: Unknown\nLocation: Mayapur\nLecturer: Speaker\nInterviewer / Participants: None\n\n[00:00] First sentence.\n\n[00:08] Second sentence.',
        SRT: 'stale subtitle payload',
        VTT: 'stale vtt payload',
        Markdown: 'stale markdown payload',
      },
    },
    {
      ...chunks[1],
      startSec: 20,
      endSec: 35,
      durationSec: 15,
      original: '[00:20] Third sentence.',
    },
  ];

  assert.equal(
    buildTranscriptExport('original', 'SRT', timedChunks),
    '1\n00:00:00,000 --> 00:00:08,000\nFirst sentence.\n\n2\n00:00:08,000 --> 00:00:20,000\nSecond sentence.\n\n3\n00:00:20,000 --> 00:00:35,000\nThird sentence.\n'
  );

  assert.equal(
    buildTranscriptExport('original', 'VTT', timedChunks),
    'WEBVTT\n\n00:00:00.000 --> 00:00:08.000\nFirst sentence.\n\n00:00:08.000 --> 00:00:20.000\nSecond sentence.\n\n00:00:20.000 --> 00:00:35.000\nThird sentence.\n'
  );
});

test('buildTranscriptExport creates clean TXT and Markdown documents from timed text', () => {
  const timedChunks = [
    {
      ...chunks[0],
      originalFormats: {
        TXT: 'Date: Unknown\nLocation: Mayapur\nLecturer: Speaker\nInterviewer / Participants: None\n\n[00:00] First sentence.\n\n[00:08] Second sentence.',
      },
      original: '[00:00] First sentence.\n\n[00:08] Second sentence.',
    },
    {
      ...chunks[1],
      startSec: 65,
      endSec: 135,
      original: '[01:05] Third sentence.',
    },
  ];

  const txt = buildTranscriptExport('original', 'TXT', timedChunks);
  assert.match(txt, /^Date: Unknown\nLocation: Mayapur\nLecturer: Speaker/m);
  assert.match(txt, /\[00:00:00\] First sentence\. Second sentence\./);
  assert.match(txt, /\[00:01:05\] Third sentence\./);

  const markdown = buildTranscriptExport('original', 'Markdown', timedChunks);
  assert.match(markdown, /^# Mayapur/m);
  assert.match(markdown, /\*\*Lecturer:\*\* Speaker/m);
  assert.match(markdown, /First sentence\. Second sentence\./);
  assert.doesNotMatch(markdown, /\[\d{2}:\d{2}/);
});

test('buildTranscriptExport localizes translated metadata using source metadata fallback', () => {
  const sourceChunks = [{
    ...chunks[0],
    originalFormats: {
      TXT: 'Date: Unknown\nLocation: Mayapur\nLecturer: His Holiness Kadamba Kanana Swami\nInterviewer / Participants: None\n\n[00:00] Source sentence.',
    },
  }];
  const translatedChunks = [{
    ...chunks[0],
    translated: '[00:00] Переведённое предложение.',
  }];

  const txt = buildTranscriptExport('translated', 'TXT', translatedChunks, {
    targetLang: 'Russian',
    metadataSourceChunks: sourceChunks,
  });

  assert.match(txt, /^Дата: Неизвестно\nМесто: Маяпур\nЛектор: Его Святейшество Kadamba Kanana Swami\nИнтервьюер \/ Участники: Нет/m);
  assert.match(txt, /\[00:00:00\] Переведённое предложение\./);

  const markdown = buildTranscriptExport('translated', 'Markdown', translatedChunks, {
    targetLang: 'Russian',
    metadataSourceChunks: sourceChunks,
  });

  assert.match(markdown, /^# Mayapur/m);
  assert.match(markdown, /\*\*Место:\*\* Маяпур/m);
  assert.match(markdown, /\*\*Лектор:\*\* Его Святейшество Kadamba Kanana Swami/m);
  assert.match(markdown, /## Содержание/m);
  assert.match(markdown, /## 1\. Переведённое предложение/m);
  assert.doesNotMatch(markdown, /\*\*Lecturer:\*\*/);
});

test('buildTranscriptExport wraps SRT and VTT cues by subtitle export settings', () => {
  const subtitleChunks = [{
    ...chunks[0],
    startSec: 0,
    endSec: 12,
    original: '[00:00] One two three four five six seven eight nine ten eleven twelve.',
  }];

  const srt = buildTranscriptExport('original', 'SRT', subtitleChunks, {
    subtitleMaxCharsPerLine: 16,
    subtitleMaxLines: 2,
  });

  assert.match(srt, /1\n00:00:00,000 --> 00:00:04,000\nOne two three\nfour five six/);
  assert.match(srt, /2\n00:00:04,000 --> 00:00:08,000\nseven eight nine\nten eleven/);
  assert.match(srt, /3\n00:00:08,000 --> 00:00:12,000\ntwelve\./);

  const vtt = buildTranscriptExport('original', 'VTT', subtitleChunks, {
    subtitleMaxCharsPerLine: 16,
    subtitleMaxLines: 2,
  });
  assert.match(vtt, /^WEBVTT\n\n00:00:00\.000 --> 00:00:04\.000/m);
});
