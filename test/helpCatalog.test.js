'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const catalog = require('../shared/help-catalog.js');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

const nativeFixture = fixture('help-catalog.native.json');
const searchFixture = fixture('help-search.json');
const contextFixture = fixture('help-context.json');

const languages = ['en', 'ru'];

function topicMap(topics) {
  return new Map(topics.map((topic) => [topic.id, topic]));
}

test('projects the native 19-topic bilingual catalog in stable order', () => {
  const english = catalog.listHelpTopics({ language: 'en' });
  const russian = catalog.listHelpTopics({ language: 'ru' });
  assert.ok(english.length >= 19);
  assert.deepEqual(english.map((topic) => topic.id), nativeFixture.nativeTopicIDs);
  assert.deepEqual(english.map((topic) => topic.id), nativeFixture.parity.englishIDs);
  assert.deepEqual(russian.map((topic) => topic.id), nativeFixture.parity.russianIDs);
  assert.deepEqual(english.map((topic) => topic.id), russian.map((topic) => topic.id));
  assert.notEqual(english[0].title, russian[0].title);
  for (const id of nativeFixture.requiredTopicIDs) assert.ok(english.some((topic) => topic.id === id));

  for (const [id, expected] of Object.entries(nativeFixture.representativeTopics)) {
    const en = catalog.getHelpTopic({ id, language: 'en' });
    const ru = catalog.getHelpTopic({ id, language: 'ru' });
    assert.ok(en, `missing English topic ${id}`);
    assert.ok(ru, `missing Russian topic ${id}`);
    assert.equal(en.category, expected.category);
    assert.equal(en.screen, expected.screen);
    for (const language of ['en', 'ru']) {
      const actual = language === 'en' ? en : ru;
      const expectedProjection = expected[language];
      assert.equal(actual.title, expectedProjection.title);
      assert.equal(actual.summary, expectedProjection.summary);
      assert.deepEqual(actual.requirements, expectedProjection.requirements);
      assert.deepEqual(actual.steps, expectedProjection.steps);
      assert.deepEqual(actual.troubleshooting, expectedProjection.troubleshooting);
      assert.deepEqual(actual.relatedTopicIDs, expectedProjection.relatedTopicIDs);
    }
  }
});

test('normalizes locales and preserves the help/translation-language boundary', () => {
  assert.equal(catalog.normalizeHelpLanguage('ru'), 'ru');
  assert.equal(catalog.normalizeHelpLanguage(' RU-RU '), 'ru');
  assert.equal(catalog.normalizeHelpLanguage('Russian'), 'ru');
  assert.equal(catalog.normalizeHelpLanguage('en-US'), 'en');
  assert.equal(catalog.normalizeHelpLanguage('fr-FR'), 'en');
  assert.equal(catalog.normalizeHelpLanguage(''), 'en');
  assert.equal(catalog.normalizeHelpLanguage(undefined), 'en');
  assert.equal(catalog.normalizeHelpLanguage(null), 'en');
  assert.equal(catalog.normalizeHelpLanguage(42), 'en');
  assert.equal(catalog.normalizeHelpLanguage(undefined, 'ru'), 'ru');
  assert.equal(catalog.normalizeHelpLanguage('', 'ru'), 'ru');
  assert.equal(catalog.normalizeHelpLanguage('fr', 'ru'), 'en');
  assert.equal(catalog.normalizeHelpScreen('workspace'), 'upload');
  assert.equal(catalog.normalizeHelpScreen('alignment-editor'), 'visualEditor');
  assert.equal(catalog.normalizeHelpScreen('visual-editor'), 'visualEditor');
  assert.equal(catalog.normalizeHelpScreen('unknown-future-screen'), 'upload');

  assert.equal(catalog.getHelpTopic({ id: ' EXPORT-DOCUMENTS ', language: 'ru' }).title, 'Экспорт документов транскрипта');
  assert.equal(catalog.getHelpTopic({ id: 'not-a-topic', language: 'en' }), null);
  assert.equal(catalog.getHelpTopic({ id: '  ', language: 'en' }), null);
});

test('filters categories without changing native order or IDs', () => {
  assert.deepEqual(
    catalog.listHelpTopics({ category: ' translation ', language: 'en' }).map((topic) => topic.id),
    ['translate', 'glossary'],
  );
  assert.deepEqual(
    catalog.listHelpTopics({ category: 'SETTINGS', language: 'ru' }).map((topic) => topic.id),
    ['manage-models', 'settings-agents'],
  );
  assert.equal(catalog.listHelpTopics({ category: 'missing', language: 'en' }).length, 0);
});

test('implements native bilingual search ranking and cross-language projections', () => {
  for (const queryCase of searchFixture.queries) {
    const matches = catalog.searchHelp(queryCase);
    assert.equal(matches[0]?.id, queryCase.expectedFirstID, queryCase.name);
    assert.ok(matches.length <= queryCase.limit, queryCase.name);
    assert.equal(matches[0]?.title, queryCase.expectedFirstTitle ?? matches[0]?.title, queryCase.name);
    if (queryCase.expectedLanguage === 'en') {
      assert.ok(matches[0]?.title && !/[А-Яа-яЁё]/u.test(matches[0].title), queryCase.name);
    } else {
      assert.ok(matches[0]?.title && /[А-Яа-яЁё]/u.test(matches[0].title), queryCase.name);
    }
  }

  const tie = catalog.searchHelp(searchFixture.tie);
  assert.deepEqual(tie.map((topic) => topic.id), searchFixture.tie.expectedIDs);
  assert.deepEqual(
    catalog.searchHelp({ query: 'экспорт', language: 'en', limit: 3 }).map((topic) => topic.title),
    ['Export transcript documents', 'Find and export Shorts'],
  );

  assert.deepEqual(
    catalog.searchHelp(searchFixture.empty).map((topic) => topic.id),
    searchFixture.empty.expectedIDs,
  );
  assert.deepEqual(
    catalog.searchHelp(searchFixture.noMatch).map((topic) => topic.id),
    searchFixture.noMatch.expectedIDs,
  );
  assert.equal(catalog.searchHelp({ query: 'quantum-banana-zxq-omega', language: 'en' }).length, 0);

  for (const limitCase of searchFixture.limits) {
    assert.equal(catalog.searchHelp(limitCase).length, limitCase.expectedCount, `limit ${limitCase.limit}`);
  }

  // Token matching is Unicode/diacritic insensitive but does not transliterate
  // or stem unrelated words.
  assert.equal(catalog.searchHelp({ query: 'SRT', language: 'en', limit: 1 })[0].id, 'export-documents');
  assert.equal(catalog.searchHelp({ query: 'субтитры', language: 'en', limit: 1 })[0].id, 'edit-cues');
  assert.equal(catalog.searchHelp({ query: 'transcribbbbb', language: 'en', limit: 10 }).length, 0);
});

test('returns clone-safe localized topic projections', () => {
  const first = catalog.listHelpTopics({ language: 'en' });
  first[0].title = 'mutated';
  first[0].steps.push('mutated');
  first.push({ id: 'mutated' });
  const second = catalog.listHelpTopics({ language: 'en' });
  assert.equal(second[0].title, 'Create your first project');
  assert.equal(second[0].steps.includes('mutated'), false);
  assert.equal(second.length, nativeFixture.nativeTopicIDs.length);

  const tour = catalog.getHelpTourDefinition('upload');
  tour.steps[0].targetSelector = 'mutated';
  assert.equal(catalog.getHelpTourDefinition('upload').steps[0].targetSelector, '[data-tour="settings-btn"]');
  assert.ok(Object.isFrozen(catalog.HELP_UI_COPY));
  assert.ok(Object.isFrozen(catalog.HELP_TOUR_DEFINITIONS));
});

test('maps every canonical contextual screen/state in both locales', () => {
  for (const contextCase of contextFixture.cases) {
    for (const language of languages) {
      const actual = catalog.contextualHelp({ ...contextCase.state, language });
      assert.deepEqual(actual, contextCase.expected[language], `${contextCase.name} ${language}`);
    }
  }

  assert.equal(catalog.contextualHelp({ screen: 'processing', processingProgress: -2, language: 'en' }).summary.includes('0%'), true);
  assert.equal(catalog.contextualHelp({ screen: 'processing', processingProgress: 2, language: 'en' }).summary.includes('100%'), true);
  assert.equal(catalog.contextualHelp({ screen: 'processing', processingProgress: 0.379, language: 'en' }).summary.includes('37%'), true);
  assert.equal(catalog.contextualHelp({ screen: 'alignment-editor', language: 'en' }).screen, 'visualEditor');
  assert.equal(catalog.contextualHelp({ screen: 'future-screen', language: 'en' }).screen, 'upload');
});

test('keeps the complete eight-step onboarding route in both locales', () => {
  for (const language of languages) {
    const checklist = catalog.onboardingChecklist({ language });
    assert.equal(checklist.steps.length, 8);
    assert.equal(checklist.topicIDs.length, 7);
    assert.equal(checklist.steps[3].includes('Initialize Engine'), true);
    assert.equal(checklist.steps[4].includes('Approve & Next'), true);
    assert.equal(checklist.steps[7].includes('Help Tour'), true);
    assert.deepEqual(checklist.topicIDs, [
      'getting-started',
      'manage-models',
      'configure-engine',
      'review-transcript',
      'glossary',
      'export-documents',
      'create-shorts',
    ]);
  }
  assert.notEqual(catalog.onboardingChecklist({ language: 'en' }).title, catalog.onboardingChecklist({ language: 'ru' }).title);
});

test('covers all mandatory catalog-backed tour targets and fail-closed processing', () => {
  const requiredTargets = {
    upload: [
      '[data-tour="settings-btn"]',
      '[data-tour="workspace-dropzone"]',
      '[data-tour="workspace-record-card"]',
      '[data-tour="workspace-link-card"]',
    ],
    config: [
      '[data-tour="config-metadata"]',
      '[data-tour="target-lang-select"]',
      '[data-tour="transcription-model-select"]',
      '[data-tour="start-engine-btn"]',
    ],
    review: [
      '[data-tour="review-audio-bar"]',
      '[data-tour="review-pane-original"]',
      '[data-tour="review-pane-translation"]',
      '[data-tour="review-editing-model"]',
      '[data-tour="review-view-group"]',
      '[data-tour="previous-segment-btn"]',
      '[data-tour="approve-next-btn"]',
    ],
    export: [
      '[data-tour="export-documents"]',
      '[data-tour="shorts-find-moments"]',
      '[data-tour="shorts-choose-clips"]',
      '[data-tour="shorts-edit-clip"]',
      '[data-tour="shorts-export-settings"]',
      '[data-tour="shorts-export-actions"]',
      '[data-tour="export-footer-actions"]',
    ],
    settings: Array.from({ length: 9 }, (_, index) => `[data-tour="settings-tab-${index}"]`),
    visualEditor: [
      '.alignment-lang-toggle',
      '.btn-dl-sync',
      '.alignment-preview',
      '.alignment-multitrack',
      '.alignment-right',
      '.alignment-save-btn',
    ],
  };
  const allIDs = new Set(catalog.listHelpTopics({ language: 'en' }).map((topic) => topic.id));
  for (const [screen, targets] of Object.entries(requiredTargets)) {
    const definition = catalog.getHelpTourDefinition(screen);
    assert.ok(definition);
    assert.deepEqual(definition.steps.map((step) => step.targetSelector), targets);
    for (const step of definition.steps) assert.ok(allIDs.has(step.topicId), `${screen}:${step.topicId}`);
  }
  assert.equal(catalog.getHelpTourDefinition('alignment-editor').screen, 'visualEditor');
  assert.equal(catalog.getHelpTourDefinition('processing'), null);
  assert.equal(catalog.getHelpTourDefinition('unknown'), null);
});

test('keeps localized summaries and full topic detail available to adapters', () => {
  const topic = catalog.getHelpTopic({ id: 'export-documents', language: 'en' });
  const summary = catalog.getHelpTopicSummary(topic, 'ru');
  assert.deepEqual(summary, {
    id: 'export-documents',
    category: 'Export',
    screen: 'export',
    title: 'Экспорт документов транскрипта',
    summary: 'Экспортируйте исходный текст или перевод в TXT, SRT, VTT или Markdown.',
  });
  assert.deepEqual(catalog.toHelpTopicDictionary('embedded-chat', 'ru'), catalog.getHelpTopic({ id: 'embedded-chat', language: 'ru' }));
  assert.equal(catalog.getHelpTopicSummary('not-found', 'en'), null);
  assert.deepEqual(topicMap(catalog.listHelpTopics({ language: 'en' })).get('visual-editor').relatedTopicIDs, ['create-shorts']);
});
