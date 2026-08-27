'use strict';

// P4.D1 QA discrimination harness for the OnboardingTour repair.
//
// The focused regression (test/onboardingTour.test.js) guards two repaired
// defects: (1) fresh catalog definition identity on every render re-running
// the positioning effect into an update-depth loop, and (2) an early return
// before the last effect creating conditional hooks across the
// processing -> actionable transition. A green regression only proves the
// repaired component; it does not prove the test would still catch a
// regression. This harness reintroduces each defect in an isolated mutant
// copy of the component (product source untouched) and asserts the exact
// failure signature the regression watches for actually appears.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const os = require('node:os');
const React = require('react');
const { JSDOM } = require('jsdom');
require('tsx/cjs');

const repoRoot = join(__dirname, '..', '..');
const componentPath = join(repoRoot, 'src', 'components', 'OnboardingTour.tsx');
const source = readFileSync(componentPath, 'utf8');

const MEMO_LINE = 'const tourDefinition = useMemo(() => getHelpTourDefinition(activeScreen), [activeScreen]);';
const EARLY_RETURN = [
  '  // Disable tour if settings.annotationMode is false or if no steps exist.',
  '  if (!settings.annotationMode || steps.length === 0) {',
  '    return null;',
  '  }',
  '',
].join('\n');
const DRAG_EFFECT = [
  '  useEffect(() => {',
  '    if (!settings.annotationMode || !isDragging) return;',
].join('\n');

assert.ok(source.includes(MEMO_LINE), 'memoized tour definition not found — component drifted from the repaired shape');
assert.ok(source.includes(EARLY_RETURN), 'late early-return block not found — component drifted from the repaired shape');
assert.ok(source.includes(DRAG_EFFECT), 'drag effect not found — component drifted from the repaired shape');

const mutantDir = join(os.tmpdir(), `vaniscript-p4d1-qa-${process.pid}`);
mkdirSync(mutantDir, { recursive: true });
// Bare specifiers (react) inside the tmp sandbox resolve through a node_modules symlink.
if (!existsSync(join(mutantDir, 'node_modules'))) {
  symlinkSync(join(repoRoot, 'node_modules'), join(mutantDir, 'node_modules'), 'junction');
}

function toMutantSource(transform) {
  const next = transform(source);
  assert.notEqual(next, source, 'mutant transform must actually change the component source');
  return next
    .replace("from '../types'", `from ${JSON.stringify(join(repoRoot, 'src', 'types'))}`)
    .replace("from '../../shared/help-catalog'", `from ${JSON.stringify(join(repoRoot, 'shared', 'help-catalog'))}`);
}

function writeMutant(name, transform) {
  const file = join(mutantDir, `${name}.tsx`);
  writeFileSync(file, toMutantSource(transform));
  return file;
}

const noMemoMutant = writeMutant('no-memo', (src) => src.replace(
  MEMO_LINE,
  'const tourDefinition = getHelpTourDefinition(activeScreen);',
));

const conditionalHooksMutant = writeMutant('conditional-hooks', (src) => src
  .replace(`${EARLY_RETURN}\n`, '')
  .replace(DRAG_EFFECT, `${EARLY_RETURN}\n${DRAG_EFFECT}`));

function waitForRender(milliseconds = 150) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const GLOBAL_KEYS = ['window', 'document', 'navigator', 'HTMLElement', 'Node'];

async function renderScenario(componentFile, screens) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
  });
  const previous = {};
  for (const key of GLOBAL_KEYS) previous[key] = globalThis[key];
  Object.defineProperties(globalThis, {
    window: { value: dom.window, writable: true, configurable: true },
    document: { value: dom.window.document, writable: true, configurable: true },
    navigator: { value: dom.window.navigator, writable: true, configurable: true },
    HTMLElement: { value: dom.window.HTMLElement, writable: true, configurable: true },
    Node: { value: dom.window.Node, writable: true, configurable: true },
  });

  const ReactDOMClient = require('react-dom/client');
  const { OnboardingTour: Component } = require(componentFile);
  assert.equal(typeof Component, 'function', `mutant module must export the OnboardingTour component function: ${componentFile}`);
  const consoleErrors = [];
  const uncaughtErrors = [];
  const previousConsoleError = console.error;
  console.error = (...args) => {
    consoleErrors.push(args.map((value) => String(value)).join(' '));
  };
  const root = ReactDOMClient.createRoot(dom.window.document.getElementById('root'), {
    onUncaughtError: (error) => uncaughtErrors.push(error),
  });

  try {
    for (const screen of screens) {
      root.render(React.createElement(Component, {
        activeScreen: screen,
        settings: { annotationMode: true, helpLocale: 'en' },
        onToggleAnnotationMode: () => {},
        onHelpLocaleChange: () => {},
      }));
      await waitForRender();
    }
    await waitForRender(300);
    const messages = [...consoleErrors, ...uncaughtErrors.map((error) => error.message)];
    return {
      loopErrors: messages.filter((message) => message.includes('Maximum update depth exceeded')),
      hookErrors: messages.filter((message) => message.includes('Rendered')),
    };
  } finally {
    root.unmount();
    await waitForRender(0);
    console.error = previousConsoleError;
    const restore = {};
    for (const key of GLOBAL_KEYS) restore[key] = { value: previous[key], writable: true, configurable: true };
    Object.defineProperties(globalThis, restore);
  }
}

test('mutant without definition memo reproduces the update-depth loop the regression guards', async () => {
  const { loopErrors } = await renderScenario(noMemoMutant, ['upload']);
  assert.ok(
    loopErrors.length > 0,
    'expected the no-memo mutant to trip "Maximum update depth exceeded" — the regression is not discriminating',
  );
});

test('mutant with conditional hooks reproduces the Rules of Hooks crash the regression guards', async () => {
  const { hookErrors } = await renderScenario(conditionalHooksMutant, ['processing', 'upload']);
  assert.ok(
    hookErrors.length > 0,
    'expected the conditional-hooks mutant to trip "Rendered more hooks" — the regression is not discriminating',
  );
});

test('repaired component stays clean through every adversarial transition (control)', async () => {
  const control = await renderScenario(componentPath, [
    'upload',
    'config',
    'processing',
    'upload',
    'alignment-editor',
  ]);
  assert.deepEqual(control.loopErrors, [], 'repaired component must not loop');
  assert.deepEqual(control.hookErrors, [], 'repaired component must keep a stable hook order');
});

after(() => {
  rmSync(mutantDir, { recursive: true, force: true });
});
