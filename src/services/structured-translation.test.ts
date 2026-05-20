import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStructuredTranslationResponse,
  splitTextForStructuredTranslation,
  translateSegmentsWithStructuredFallback,
} from './structured-translation';
import { normalizePromptSettings } from '../lib/prompt-presets';

test('parseStructuredTranslationResponse accepts strict array output and preserves ids', () => {
  const parsed = parseStructuredTranslationResponse('```json\n[{"id":"a","text":"Один"},{"id":"b","text":"Два"}]\n```', ['a', 'b']);

  assert.deepEqual(parsed, [
    { id: 'a', text: 'Один' },
    { id: 'b', text: 'Два' },
  ]);
});

test('parseStructuredTranslationResponse accepts a translations wrapper if a provider adds one', () => {
  const parsed = parseStructuredTranslationResponse('{"translations":[{"id":"a","text":"Один"}]}', ['a']);

  assert.deepEqual(parsed, [{ id: 'a', text: 'Один' }]);
});

test('parseStructuredTranslationResponse rejects dropped or reordered items', () => {
  assert.throws(
    () => parseStructuredTranslationResponse('[{"id":"b","text":"Два"},{"id":"a","text":"Один"}]', ['a', 'b']),
    /does not match requested segment order/,
  );
  assert.throws(
    () => parseStructuredTranslationResponse('[{"id":"a","text":"Один"}]', ['a', 'b']),
    /Expected 2 translated segments/,
  );
});

test('translateSegmentsWithStructuredFallback splits recursively when a batch response is invalid', async () => {
  const calls: string[][] = [];
  const result = await translateSegmentsWithStructuredFallback({
    segments: [
      { id: '1', text: '[00:00] First.' },
      { id: '2', text: '[00:02] Second.' },
      { id: '3', text: '[00:04] Third.' },
      { id: '4', text: '[00:06] Fourth.' },
    ],
    requestBatch: async (segments) => {
      calls.push(segments.map((segment) => segment.id));
      if (segments.length > 1) return '[{"id":"broken","text":"missing"}]';
      return JSON.stringify([{ id: segments[0].id, text: `${segments[0].text} translated` }]);
    },
  });

  assert.deepEqual(result.map((segment) => segment.id), ['1', '2', '3', '4']);
  assert.deepEqual(result.map((segment) => segment.text), [
    '[00:00] First. translated',
    '[00:02] Second. translated',
    '[00:04] Third. translated',
    '[00:06] Fourth. translated',
  ]);
  assert.ok(calls.some((ids) => ids.join(',') === '1,2,3,4'));
  assert.ok(calls.some((ids) => ids.join(',') === '1'));
});

test('splitTextForStructuredTranslation keeps timestamp paragraphs addressable', () => {
  const segments = splitTextForStructuredTranslation('[00:00] First paragraph.\n\n[00:12] Second paragraph.');

  assert.deepEqual(segments, [
    { id: 'seg_1', text: '[00:00] First paragraph.' },
    { id: 'seg_2', text: '[00:12] Second paragraph.' },
  ]);
});

test('splitTextForStructuredTranslation separates dense timestamp lines without blank paragraphs', () => {
  const segments = splitTextForStructuredTranslation('[00:00] First line.\n[00:03] Second line.\n[00:06] Third line.');

  assert.deepEqual(segments.map((segment) => segment.text), [
    '[00:00] First line.',
    '[00:03] Second line.',
    '[00:06] Third line.',
  ]);
});

test('buildStructuredTranslationPrompt uses the editable prompt preset', async () => {
  const { buildStructuredTranslationPrompt } = await import('./structured-translation');
  const prompt = buildStructuredTranslationPrompt({
    targetLang: 'Russian',
    segments: [{ id: 'seg_1', text: '[00:00] Mayapur' }],
    promptPresets: normalizePromptSettings({
      structuredTranslationUser: {
        active: 'custom1',
        custom: { custom1: 'CUSTOM {{targetLang}} {{segmentsJson}}' },
      },
    }),
  });

  assert.match(prompt, /^CUSTOM Russian/);
  assert.match(prompt, /"id": "seg_1"/);
});
