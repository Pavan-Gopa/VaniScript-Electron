import test from 'node:test';
import assert from 'node:assert/strict';
import { addVariantsToGlossaryEntry, applyGlossaryToText, buildGlossaryPromptBlock, createGlossaryEntry } from './glossary';

test('applyGlossaryToText replaces variants without touching embedded words', () => {
  const entry = createGlossaryEntry({
    variants: ['Jipatake Maharaj', 'Jay Pataka'],
    source: 'Jayapataka Maharaja',
    translation: 'Джаяпатака Махарадж',
  });

  const result = applyGlossaryToText(
    'Jipatake Maharaj came. Jay Pataka spoke. NotJay Pataka stays.',
    [entry],
    'source'
  );

  assert.equal(result.text, 'Jayapataka Maharaja came. Jayapataka Maharaja spoke. NotJay Pataka stays.');
  assert.equal(result.count, 2);
});

test('applyGlossaryToText can replace translated variants', () => {
  const entry = createGlossaryEntry({
    variants: ['Джай Патака Махарадж'],
    source: 'Jayapataka Maharaja',
    translation: 'Джаяпатака Махарадж',
  });

  const result = applyGlossaryToText('Джай Патака Махарадж сказал.', [entry], 'translation');

  assert.equal(result.text, 'Джаяпатака Махарадж сказал.');
  assert.equal(result.count, 1);
});

test('buildGlossaryPromptBlock renders compact terminology instructions', () => {
  const entry = createGlossaryEntry({
    variants: ['Jipatake Maharaj'],
    source: 'Jayapataka Maharaja',
    translation: 'Джаяпатака Махарадж',
  });

  assert.equal(
    buildGlossaryPromptBlock([entry]),
    'Glossary terms to preserve:\n- Jipatake Maharaj => Jayapataka Maharaja => Джаяпатака Махарадж'
  );
});

test('buildGlossaryPromptBlock supports source-only terminology', () => {
  const entry = createGlossaryEntry({
    variants: ['Maypur'],
    source: 'Mayapur',
    translation: '',
  });

  assert.equal(
    buildGlossaryPromptBlock([entry]),
    'Glossary terms to preserve:\n- Maypur => Mayapur'
  );
});

test('addVariantsToGlossaryEntry adds new wrong spellings without duplicating correct terms', () => {
  const entry = createGlossaryEntry({
    variants: ['Jayapataka Maharaj'],
    source: 'Jayapatākā Swami',
    translation: 'Джаяпатака Свами',
  });

  const updated = addVariantsToGlossaryEntry(entry, ['Jaya Patak Maharaj', 'Jayapataka Maharaj', 'Jayapatākā Swami']);

  assert.deepEqual(updated.variants, ['Jayapataka Maharaj', 'Jaya Patak Maharaj']);
  assert.equal(updated.source, 'Jayapatākā Swami');
  assert.equal(updated.translation, 'Джаяпатака Свами');
});

test('updated existing glossary entry immediately applies the newly added variant', () => {
  const entry = createGlossaryEntry({
    variants: ['Jayapataka Maharaj'],
    source: 'Jayapatākā Swami',
    translation: 'Джаяпатака Свами',
  });
  const updated = addVariantsToGlossaryEntry(entry, ['Jipatak Maharaj']);

  const result = applyGlossaryToText('Then Jipatak Maharaj spoke.', [updated], 'source');

  assert.equal(result.text, 'Then Jayapatākā Swami spoke.');
  assert.equal(result.count, 1);
});
