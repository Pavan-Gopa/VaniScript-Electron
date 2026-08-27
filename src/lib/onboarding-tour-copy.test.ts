import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getHelpTopic, getHelpTourDefinition, listHelpTopics } from '../../shared/help-catalog';

type CatalogTourStep = {
  topicId: string;
  topicStep: number | null;
};

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
} as const;

function readLiveSettingsTabs(): string[] {
  const source = readFileSync('src/components/SettingsModal.tsx', 'utf8');
  const tabsMatch = source.match(/const TABS = \[([\s\S]*?)\];/);
  assert.ok(tabsMatch, 'SettingsModal should define its live TABS array');

  const tabs: string[] = [];
  for (const match of tabsMatch[1].matchAll(/'([^']+)'/g)) {
    tabs.push(match[1]);
  }
  assert.ok(tabs.length > 0, 'live settings tabs should not be empty');
  return tabs;
}

const expectedSettingsTopicIDs: Record<string, string> = {
  'API Keys': 'embedded-chat',
  Models: 'manage-models',
  Appearance: 'help-tour',
  Glossary: 'glossary',
  Chunking: 'configure-engine',
  Transcription: 'configure-engine',
  Prompts: 'configure-engine',
  Agents: 'settings-agents',
  Updates: 'troubleshoot-unavailable',
};

test('onboarding tour consumes catalog definitions for every required target', () => {
  const tourSource = readFileSync('src/components/OnboardingTour.tsx', 'utf8');
  assert.match(tourSource, /getHelpTourDefinition/);
  assert.match(tourSource, /getHelpTopic/);
  assert.match(tourSource, /HELP_UI_COPY/);
  assert.match(tourSource, /activeStep\.topicStep/);
  assert.match(tourSource, /activeStep\.topicStep === null/);
  assert.doesNotMatch(tourSource, /\bSTEPS_BY_SCREEN\b/);
  assert.doesNotMatch(tourSource, /activeTopic\.steps\[activeStep\.stepIndex\]/);

  const topicIDs = Object.fromEntries(listHelpTopics({ language: 'en' }).map((topic) => [topic.id, true]));
  for (const [screen, targets] of Object.entries(requiredTargets)) {
    const definition = getHelpTourDefinition(screen);
    assert.ok(definition, `${screen} tour definition should exist`);
    assert.deepEqual(definition.steps.map((step) => step.targetSelector), targets);
    for (const [tourOrdinal, step] of definition.steps.entries()) {
      const catalogStep = step as typeof step & CatalogTourStep;
      assert.equal(topicIDs[step.topicId], true, `${screen}:${step.id} references a catalog topic`);
      assert.equal(step.stepIndex, tourOrdinal, `${screen}:${step.id} keeps tour order separate`);
      assert.ok(Object.prototype.hasOwnProperty.call(step, 'topicStep'), `${screen}:${step.id} has a topic step`);
      assert.ok(getHelpTopic({ id: step.topicId, language: 'en' }));
      assert.ok(getHelpTopic({ id: step.topicId, language: 'ru' }));

      const topic = getHelpTopic({ id: step.topicId, language: 'en' });
      assert.ok(topic, `${screen}:${step.id} has an English catalog topic`);
      const topicStep = catalogStep.topicStep;
      assert.ok(
        topicStep === null
          || (Number.isInteger(topicStep) && topicStep >= 0 && topicStep < topic.steps.length),
        `${screen}:${step.id} has a valid topic step or explicit summary sentinel`,
      );
    }
  }

  const liveSettingsTabs = readLiveSettingsTabs();
  const settingsDefinition = getHelpTourDefinition('settings');
  assert.ok(settingsDefinition);
  assert.equal(settingsDefinition.steps.length, liveSettingsTabs.length, 'settings tour follows the live tab count');
  for (const [index, tabName] of liveSettingsTabs.entries()) {
    const expectedTopicID = expectedSettingsTopicIDs[tabName];
    if (expectedTopicID === undefined) {
      assert.fail(`live settings tab ${tabName} has no expected tour mapping`);
    }
    assert.equal(settingsDefinition.steps[index].topicId, expectedTopicID, `${tabName} maps to its intended help topic`);
    if (tabName === 'Appearance' || tabName === 'Prompts') {
      const catalogStep = settingsDefinition.steps[index] as unknown as CatalogTourStep;
      assert.equal(catalogStep.topicStep, null, `${tabName} uses the explicit summary fallback`);
    }
  }

  const reviewDefinition = getHelpTourDefinition('review');
  assert.ok(reviewDefinition);
  const editCueStep = reviewDefinition.steps.find(
    (step) => step.topicId === 'edit-cues' && step.targetSelector === '[data-tour="review-pane-original"]',
  );
  assert.ok(editCueStep, 'review tour uses edit-cues for the original review pane');
  const editCueTopic = getHelpTopic({ id: 'edit-cues', language: 'en' });
  assert.ok(editCueTopic);
  const editCueTopicStep = (editCueStep as unknown as CatalogTourStep).topicStep;
  if (typeof editCueTopicStep !== 'number') {
    assert.fail('review edit-cues reference must not use the summary fallback');
  }
  assert.ok(
    Number.isInteger(editCueTopicStep)
      && editCueTopicStep >= 0
      && editCueTopicStep < editCueTopic.steps.length,
    'review edit-cues reference uses a valid topic step',
  );

  assert.equal(getHelpTourDefinition('alignment-editor')?.screen, 'visualEditor');
  assert.equal(getHelpTourDefinition('processing'), null);
  assert.equal(getHelpTourDefinition('unknown'), null);
});
