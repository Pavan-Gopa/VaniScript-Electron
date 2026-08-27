import test from 'node:test';
import assert from 'node:assert/strict';
import { markOnboardingCompletedForBuild, shouldShowOnboardingForBuild } from './onboarding';
import { DEFAULT_SETTINGS } from '../services/storage';

test('onboarding completion is scoped to the current build id', () => {
  assert.equal(shouldShowOnboardingForBuild(DEFAULT_SETTINGS, 'build-a'), true);

  const completed = markOnboardingCompletedForBuild(DEFAULT_SETTINGS, 'build-a');

  assert.equal(completed.annotationMode, false);
  assert.equal(completed.completedOnboardingBuildId, 'build-a');
  assert.equal(shouldShowOnboardingForBuild(completed, 'build-a'), false);
  assert.equal(shouldShowOnboardingForBuild(completed, 'build-b'), true);
});

test('changing help locale does not clear build-scoped onboarding completion', () => {
  const completed = markOnboardingCompletedForBuild({ ...DEFAULT_SETTINGS, helpLocale: 'en' }, 'build-a');
  const russian = { ...completed, helpLocale: 'ru' };

  assert.equal(russian.completedOnboardingBuildId, 'build-a');
  assert.equal(russian.annotationMode, false);
  assert.equal(shouldShowOnboardingForBuild(russian, 'build-a'), false);
  assert.equal(shouldShowOnboardingForBuild(russian, 'build-b'), true);
});
