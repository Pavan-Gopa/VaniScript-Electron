'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { JSDOM } = require('jsdom');
require('tsx/cjs');

const catalog = require('../shared/help-catalog.js');
const { OnboardingTour } = require('../src/components/OnboardingTour.tsx');

function waitForRender(milliseconds = 100) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('catalog-backed tour renders localized content and centers when its target is absent', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
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
  const consoleErrors = [];
  const previousConsoleError = console.error;
  console.error = (...args) => {
    const message = args.map((value) => String(value)).join(' ');
    consoleErrors.push(message);
    if (!message.includes('Maximum update depth exceeded')) previousConsoleError(...args);
  };
  const root = ReactDOMClient.createRoot(dom.window.document.getElementById('root'));
  const renderTour = (helpLocale) => React.createElement(OnboardingTour, {
    activeScreen: 'upload',
    settings: { annotationMode: true, helpLocale },
    onToggleAnnotationMode: () => {},
    onHelpLocaleChange: () => {},
  });

  try {
    root.render(renderTour('en'));
    await waitForRender();

    const englishTopic = catalog.getHelpTopic({ id: 'settings-agents', language: 'en' });
    assert.ok(englishTopic);
    const englishBubble = dom.window.document.querySelector('.onboarding-bubble');
    assert.ok(englishBubble);
    assert.equal(englishBubble.querySelector('h4').textContent, englishTopic.title);
    assert.equal(englishBubble.querySelector('.onboarding-bubble-body p').textContent, englishTopic.steps[0]);
    assert.equal(englishBubble.querySelector('.onboarding-step-counter').textContent, 'Step 1/4');
    assert.equal(englishBubble.querySelector('.onboarding-btn-next').textContent, 'Next ›');
    assert.equal(englishBubble.querySelector('.onboarding-btn-skip').textContent, 'Skip walkthrough');
    assert.equal(englishBubble.style.left, `${dom.window.innerWidth / 2 - 190}px`);
    assert.equal(englishBubble.style.top, `${dom.window.innerHeight / 2 - 90}px`);
    assert.equal(dom.window.document.querySelector('.onboarding-spotlight'), null);
    assert.equal(dom.window.document.querySelector('.onboarding-svg-overlay'), null);

    root.render(renderTour('ru'));
    await waitForRender();

    const russianTopic = catalog.getHelpTopic({ id: 'settings-agents', language: 'ru' });
    assert.ok(russianTopic);
    const russianBubble = dom.window.document.querySelector('.onboarding-bubble');
    assert.ok(russianBubble);
    assert.equal(russianBubble.querySelector('h4').textContent, russianTopic.title);
    assert.equal(russianBubble.querySelector('.onboarding-bubble-body p').textContent, russianTopic.steps[0]);
    assert.equal(russianBubble.querySelector('.onboarding-step-counter').textContent, 'Шаг 1/4');
    assert.equal(russianBubble.querySelector('.onboarding-btn-next').textContent, 'Далее ›');
    assert.equal(russianBubble.querySelector('.onboarding-btn-skip').textContent, 'Пропустить экскурсию');
    assert.match(dom.window.document.querySelector('.onboarding-mini-badge').textContent, /Help Tour · Пропустить экскурсию/);
    assert.equal(dom.window.document.querySelector('.onboarding-spotlight'), null);
    assert.equal(dom.window.document.querySelector('.onboarding-svg-overlay'), null);
    assert.deepEqual(
      consoleErrors.filter((message) => message.includes('Maximum update depth exceeded')),
      [],
      'catalog-backed tour must not loop its positioning effect',
    );
  } finally {
    root.unmount();
    await waitForRender(0);
    console.error = previousConsoleError;
    Object.defineProperties(globalThis, {
      window: { value: previous.window, writable: true, configurable: true },
      document: { value: previous.document, writable: true, configurable: true },
      navigator: { value: previous.navigator, writable: true, configurable: true },
      HTMLElement: { value: previous.HTMLElement, writable: true, configurable: true },
      Node: { value: previous.Node, writable: true, configurable: true },
    });
  }
});

test('processing has no mounted empty tour and can transition to an actionable screen', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
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
  const uncaughtErrors = [];
  const root = ReactDOMClient.createRoot(dom.window.document.getElementById('root'), {
    onUncaughtError: (error) => uncaughtErrors.push(error),
  });
  const renderTour = (activeScreen) => React.createElement(OnboardingTour, {
    activeScreen,
    settings: { annotationMode: true, helpLocale: 'en' },
    onToggleAnnotationMode: () => {},
    onHelpLocaleChange: () => {},
  });

  try {
    root.render(renderTour('processing'));
    await waitForRender();
    assert.equal(dom.window.document.querySelector('.onboarding-tour-root'), null);

    root.render(renderTour('upload'));
    await waitForRender();
    assert.deepEqual(
      uncaughtErrors.map((error) => error.message).filter((message) => message.includes('Rendered')),
      [],
      'tour must transition from processing without violating the Rules of Hooks',
    );
  } finally {
    root.unmount();
    await waitForRender(0);
    Object.defineProperties(globalThis, {
      window: { value: previous.window, writable: true, configurable: true },
      document: { value: previous.document, writable: true, configurable: true },
      navigator: { value: previous.navigator, writable: true, configurable: true },
      HTMLElement: { value: previous.HTMLElement, writable: true, configurable: true },
      Node: { value: previous.Node, writable: true, configurable: true },
    });
  }
});

test('tour card closes via skip, finish, and badge, and survives adversarial screen transitions', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
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
  const consoleErrors = [];
  const uncaughtErrors = [];
  const previousConsoleError = console.error;
  console.error = (...args) => {
    const message = args.map((value) => String(value)).join(' ');
    consoleErrors.push(message);
    if (!message.includes('Maximum update depth exceeded')) previousConsoleError(...args);
  };
  const root = ReactDOMClient.createRoot(dom.window.document.getElementById('root'), {
    onUncaughtError: (error) => uncaughtErrors.push(error),
  });

  let activeScreen = 'upload';
  let annotationMode = true;
  const closeCalls = [];
  const renderTour = () => React.createElement(OnboardingTour, {
    activeScreen,
    settings: { annotationMode, helpLocale: 'en' },
    onToggleAnnotationMode: (enabled) => closeCalls.push(enabled),
    onHelpLocaleChange: () => {},
  });

  const doc = dom.window.document;
  const click = (element) => element.dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  const stepCounter = () => doc.querySelector('.onboarding-step-counter').textContent;

  try {
    root.render(renderTour());
    await waitForRender();
    assert.equal(stepCounter(), 'Step 1/4');

    // Mid-tour jump to another actionable screen: definition memo swaps and step resets.
    click(doc.querySelector('.onboarding-btn-next'));
    await waitForRender();
    assert.equal(stepCounter(), 'Step 2/4');
    activeScreen = 'config';
    root.render(renderTour());
    await waitForRender();
    assert.equal(stepCounter(), 'Step 1/4');

    // Actionable -> processing -> actionable round trip keeps hook order stable both ways.
    activeScreen = 'processing';
    root.render(renderTour());
    await waitForRender();
    assert.equal(doc.querySelector('.onboarding-tour-root'), null);
    activeScreen = 'config';
    root.render(renderTour());
    await waitForRender();
    assert.ok(doc.querySelector('.onboarding-bubble'));

    // Finishing the last step asks the parent to close the card.
    for (let i = 0; i < 3; i += 1) {
      click(doc.querySelector('.onboarding-btn-next'));
      await waitForRender();
    }
    assert.equal(stepCounter(), 'Step 4/4');
    assert.equal(doc.querySelector('.onboarding-btn-next').textContent, 'Finish');
    click(doc.querySelector('.onboarding-btn-next'));
    assert.deepEqual(closeCalls, [false]);

    // Parent honoring the close unmounts the card entirely.
    annotationMode = false;
    root.render(renderTour());
    await waitForRender();
    assert.equal(doc.querySelector('.onboarding-tour-root'), null);

    // Reopened tour closes through the skip button.
    annotationMode = true;
    activeScreen = 'upload';
    root.render(renderTour());
    await waitForRender();
    assert.ok(doc.querySelector('.onboarding-bubble'));
    click(doc.querySelector('.onboarding-btn-skip'));
    assert.deepEqual(closeCalls, [false, false]);

    // The persistent mini badge also closes the tour.
    root.render(renderTour());
    await waitForRender();
    click(doc.querySelector('.onboarding-mini-badge'));
    assert.deepEqual(closeCalls, [false, false, false]);

    // alignment-editor maps to the six-step visual editor tour.
    activeScreen = 'alignment-editor';
    root.render(renderTour());
    await waitForRender();
    assert.ok(doc.querySelector('.onboarding-bubble'));
    assert.equal(stepCounter(), 'Step 1/6');

    assert.deepEqual(
      consoleErrors.filter((message) => message.includes('Maximum update depth exceeded')),
      [],
      'screen-to-screen tour transitions must not loop the positioning effect',
    );
    assert.deepEqual(
      uncaughtErrors.map((error) => error.message).filter((message) => message.includes('Rendered')),
      [],
      'tour must keep a stable hook order across every transition',
    );
  } finally {
    root.unmount();
    await waitForRender(0);
    console.error = previousConsoleError;
    Object.defineProperties(globalThis, {
      window: { value: previous.window, writable: true, configurable: true },
      document: { value: previous.document, writable: true, configurable: true },
      navigator: { value: previous.navigator, writable: true, configurable: true },
      HTMLElement: { value: previous.HTMLElement, writable: true, configurable: true },
      Node: { value: previous.Node, writable: true, configurable: true },
    });
  }
});
