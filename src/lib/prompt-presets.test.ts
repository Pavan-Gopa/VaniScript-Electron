import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROMPT_SETTINGS,
  normalizePromptSettings,
  renderPrompt,
  resolvePromptTemplate,
} from './prompt-presets';

test('prompt presets fall back to default templates until a custom slot is selected', () => {
  const settings = normalizePromptSettings({
    translationUser: {
      active: 'custom1',
      custom: {
        custom1: 'Translate into {{targetLang}} with glossary:\n{{glossaryBlock}}\n\n{{text}}',
      },
    },
  });

  assert.equal(resolvePromptTemplate(DEFAULT_PROMPT_SETTINGS, 'translationUser').includes('Translate the following transcript'), true);
  assert.equal(resolvePromptTemplate(settings, 'translationUser'), 'Translate into {{targetLang}} with glossary:\n{{glossaryBlock}}\n\n{{text}}');
  assert.match(renderPrompt(settings, 'translationUser', {
    targetLang: 'Russian',
    glossaryBlock: 'Māyāpur => Майяпур',
    text: '[00:01] Mayapur',
  }), /Translate into Russian/);
});

test('empty custom slots safely fall back to the default prompt', () => {
  const settings = normalizePromptSettings({
    shortsPlanner: {
      active: 'custom2',
      custom: { custom2: '   ' },
    },
  });

  assert.equal(resolvePromptTemplate(settings, 'shortsPlanner'), resolvePromptTemplate(DEFAULT_PROMPT_SETTINGS, 'shortsPlanner'));
});

test('unknown persisted prompt ids are ignored and missing defaults are restored', () => {
  const settings = normalizePromptSettings({
    unknownPrompt: { active: 'custom1', custom: { custom1: 'bad' } },
  } as any);

  assert.equal((settings as any).unknownPrompt, undefined);
  assert.ok(settings.transcriptionSystem);
  assert.ok(settings.documentMarkdown);
  assert.ok(settings.structuredTranslationUser);
});
