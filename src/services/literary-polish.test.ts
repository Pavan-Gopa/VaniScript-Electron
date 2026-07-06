import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLiteraryPolishPrompt, sanitizeLiteraryPolishOutput } from './literary-polish';

test('buildLiteraryPolishPrompt requests natural target-language translation without dropping timestamps', () => {
  const prompt = buildLiteraryPolishPrompt({
    text: '[00:39] Это было очень дословно переведено.',
    targetLang: 'Russian',
    speakerHint: 'Lecture',
    glossaryBlock: 'Glossary terms to preserve:\n- Mayapur => Майяпур',
  });

  assert.match(prompt, /sounds natural, fluent, and literary in Russian/i);
  assert.match(prompt, /Preserve every existing \[MM:SS\] timestamp/i);
  assert.match(prompt, /Do not add a new timestamp/i);
  assert.match(prompt, /Revised Russian/i);
  assert.match(prompt, /Do not add new meaning/i);
  assert.match(prompt, /Mayapur/);
});

test('sanitizeLiteraryPolishOutput strips labels and duplicate timestamps', () => {
  const output = sanitizeLiteraryPolishOutput(`
Revised Russian:
[00:02] [00:02][00:02] Когда я прибыл в 1985 году,
`);

  assert.equal(output, '[00:02] Когда я прибыл в 1985 году,');
});
