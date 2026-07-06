import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceSelectedText } from './text-revision';

test('replaceSelectedText edits inside the selected karaoke line instead of first duplicate', () => {
  const content = '[09:55] Mayapur is sacred.\n\n[10:04] Mayapur is here.';

  const result = replaceSelectedText(content, {
    selectedText: 'Mayapur',
    replacementText: 'Mayapur Dham',
    contextText: 'Mayapur is here.',
  });

  assert.equal(result.changed, true);
  assert.equal(result.text, '[09:55] Mayapur is sacred.\n\n[10:04] Mayapur Dham is here.');
});

test('replaceSelectedText tolerates normalized selection whitespace', () => {
  const content = '[09:55] Jayapataka\nMaharaja spoke.';

  const result = replaceSelectedText(content, {
    selectedText: 'Jayapataka Maharaja',
    replacementText: 'Jayapataka Swami',
    contextText: 'Jayapataka Maharaja spoke.',
  });

  assert.equal(result.changed, true);
  assert.equal(result.text, '[09:55] Jayapataka Swami spoke.');
});

test('replaceSelectedText preserves the timestamp when replacing a full timed line body', () => {
  const content = '[00:32] И часть подготовки к празднику заключалась в небольшом строительстве.';

  const result = replaceSelectedText(content, {
    selectedText: 'И часть подготовки к празднику заключалась в небольшом строительстве.',
    replacementText: 'Итак, однажды Бхавананда отвечал за строительство здесь, в Майяпуре.',
    contextText: 'И часть подготовки к празднику заключалась в небольшом строительстве.',
  });

  assert.equal(result.changed, true);
  assert.equal(result.text, '[00:32] Итак, однажды Бхавананда отвечал за строительство здесь, в Майяпуре.');
});

test('replaceSelectedText keeps replacement timestamp-free when editing only a word', () => {
  const content = '[00:39] Он был в Майпуре.';

  const result = replaceSelectedText(content, {
    selectedText: 'Майпуре',
    replacementText: 'Майяпуре',
    contextText: 'Он был в Майпуре.',
  });

  assert.equal(result.changed, true);
  assert.equal(result.text, '[00:39] Он был в Майяпуре.');
});

test('replaceSelectedText preserves timestamp when the selection includes the timestamp marker', () => {
  const content = '[00:39] Итак, однажды он был здесь в Майпуре.';

  const result = replaceSelectedText(content, {
    selectedText: '[00:39] Итак, однажды он был здесь в Майпуре.',
    replacementText: 'Итак, однажды он был здесь в Майяпуре.',
    contextText: 'Итак, однажды он был здесь в Майпуре.',
  });

  assert.equal(result.changed, true);
  assert.equal(result.text, '[00:39] Итак, однажды он был здесь в Майяпуре.');
});

test('replaceSelectedText does not duplicate timestamps returned by polish', () => {
  const content = '[00:02] Когда я приехал в 1985 году,';

  const result = replaceSelectedText(content, {
    selectedText: '[00:02] Когда я приехал в 1985 году,',
    replacementText: '[00:02][00:02] Когда я прибыл в 1985 году,',
    contextText: 'Когда я приехал в 1985 году,',
  });

  assert.equal(result.changed, true);
  assert.equal(result.text, '[00:02] Когда я прибыл в 1985 году,');
});

test('replaceSelectedText can delete a selected timestamp marker', () => {
  const content = '[00:02] [00:02] Когда я приехал в 1985 году,';

  const result = replaceSelectedText(content, {
    selectedText: '[00:02] ',
    replacementText: '',
  });

  assert.equal(result.changed, true);
  assert.equal(result.text, '[00:02] Когда я приехал в 1985 году,');
});
