'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const { JSDOM } = require('jsdom');
require('tsx/cjs');

const catalog = require('../shared/help-catalog.js');
const panel = require('../src/components/HelpCenterPanel.tsx');
const storage = require('../src/services/storage.ts');

function renderPanel(props = {}) {
  return ReactDOMServer.renderToStaticMarkup(React.createElement(panel.HelpCenterPanel, {
    isOpen: true,
    locale: 'en',
    context: { screen: 'review', hasSession: true },
    onClose: () => {},
    onLocaleChange: () => {},
    onStartHelpTour: () => {},
    ...props,
  }));
}

test('Help Center exposes the three catalog-backed drawer views', () => {
  assert.deepEqual(
    panel.HELP_CENTER_VIEW_OPTIONS.map((option) => option.id),
    ['search', 'current', 'checklist'],
  );
  assert.deepEqual(
    panel.HELP_CENTER_VIEW_OPTIONS.map((option) => option.copyKey),
    ['search', 'currentScreen', 'checklist'],
  );
  const state = panel.deriveHelpCenterState({
    language: 'ru-RU',
    view: 'current',
    context: { screen: 'alignment-editor', hasSession: true, hasShortsPlans: true },
  });
  assert.equal(state.language, 'ru');
  assert.equal(state.canonicalScreen, 'visualEditor');
  assert.equal(state.current.screen, 'visualEditor');
  assert.deepEqual(state.current.recommendedTopicIDs, ['visual-editor', 'create-shorts']);
  assert.equal(state.checklist.steps.length, 8);
});

test('search, unavailable topic, and localized projections fail closed', () => {
  const noMatch = panel.deriveHelpCenterState({
    language: 'en',
    view: 'search',
    query: 'quantum-banana-zxq-omega',
    context: { screen: 'upload' },
  });
  assert.deepEqual(noMatch.results, []);
  assert.equal(noMatch.selectedTopic, null);

  const unavailable = panel.deriveHelpCenterState({
    language: 'ru',
    view: 'search',
    selectedTopicId: 'does-not-exist',
    context: { screen: 'upload' },
  });
  assert.equal(unavailable.selectedTopicId, 'does-not-exist');
  assert.equal(unavailable.selectedTopic, null);
  assert.equal(unavailable.language, 'ru');

  const russian = panel.deriveHelpCenterState({
    language: 'ru',
    view: 'checklist',
    context: { screen: 'review', hasSession: true },
  });
  assert.match(russian.checklist.title, /Чек-лист/);
  assert.match(russian.current.title, /Проверьте/);
  assert.equal(catalog.HELP_UI_COPY.ru.noResults, 'Ничего не найдено');
});

test('storage seeds, canonicalizes, and round-trips the app-wide help locale', () => {
  const values = new Map();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { language: 'ru-RU' },
  });

  try {
    const seeded = storage.loadSettings();
    assert.equal(seeded.helpLocale, 'ru');
    storage.saveSettings({ ...seeded, helpLocale: 'ru' });
    assert.equal(JSON.parse(values.get('vs_settings_v1')).helpLocale, 'ru');
    assert.equal(storage.loadSettings().helpLocale, 'ru');

    storage.saveSettings({ ...seeded, helpLocale: 'fr' });
    assert.equal(JSON.parse(values.get('vs_settings_v1')).helpLocale, 'en');
    assert.equal(storage.loadSettings().helpLocale, 'en');
  } finally {
    if (previousLocalStorage) Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
    else delete globalThis.localStorage;
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
  }
});

test('SSR renders EN/RU drawer chrome and catalog content without topic literals in JSX', () => {
  const english = renderPanel({ initialView: 'current', locale: 'en' });
  assert.match(english, /Current screen/);
  assert.match(english, /Help Center/);
  assert.match(english, /Checklist/);
  assert.match(english, /Start Help Tour/);
  assert.match(english, /Review and approve the transcript/);
  assert.match(english, /role="dialog"/);
  assert.match(english, /data-testid="help-center-panel"/);

  const russian = renderPanel({ initialView: 'checklist', locale: 'ru' });
  assert.match(russian, /Текущий экран/);
  assert.match(russian, /Чек-лист/);
  assert.match(russian, /Запустить Help Tour/);
  assert.match(russian, /Чек-лист первого проекта/);
});

test('JSDOM locale, tour, and Escape callbacks are wired through the drawer controls', async () => {
  const dom = new JSDOM('<!doctype html><html><body><button id="origin">origin</button><div id="root"></div></body></html>', {
    url: 'http://localhost',
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
  };
  Object.defineProperties(globalThis, {
    window: { value: dom.window, writable: true, configurable: true },
    document: { value: dom.window.document, writable: true, configurable: true },
    navigator: { value: dom.window.navigator, writable: true, configurable: true },
    HTMLElement: { value: dom.window.HTMLElement, writable: true, configurable: true },
    Node: { value: dom.window.Node, writable: true, configurable: true },
  });

  const ReactDOMClient = require('react-dom/client');
  const calls = { locales: [], close: 0, tour: 0 };
  const root = ReactDOMClient.createRoot(dom.window.document.getElementById('root'));
  root.render(React.createElement(panel.HelpCenterPanel, {
    isOpen: true,
    locale: 'en',
    context: { screen: 'upload' },
    initialView: 'search',
    onClose: () => { calls.close += 1; },
    onLocaleChange: (locale) => calls.locales.push(locale),
    onStartHelpTour: () => { calls.tour += 1; },
  }));

  await new Promise((resolve) => setTimeout(resolve, 20));
  const drawer = dom.window.document.querySelector('[data-testid="help-center-panel"]');
  assert.ok(drawer);
  const localeButtons = drawer.querySelectorAll('.help-center-locale button');
  localeButtons[1].click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  drawer.querySelector('.help-center-tour-button').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.tour, 1);
  assert.equal(calls.close, 2);

  root.unmount();
  await new Promise((resolve) => setTimeout(resolve, 0));
  Object.defineProperties(globalThis, {
    window: { value: previous.window, writable: true, configurable: true },
    document: { value: previous.document, writable: true, configurable: true },
    navigator: { value: previous.navigator, writable: true, configurable: true },
    HTMLElement: { value: previous.HTMLElement, writable: true, configurable: true },
    Node: { value: previous.Node, writable: true, configurable: true },
  });
});
