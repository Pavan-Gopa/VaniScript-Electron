import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSyncPatch, toggleSync } from './ClipSyncManager';
import type { ShortsClipPlan } from './shorts-reels';

test('buildSyncPatch mirrors source subtitle timing to target without replacing target text', () => {
  const plans: ShortsClipPlan[] = [{
    start: '00:00',
    end: '00:10',
    title: 'Target',
    summary: '',
    hook: '',
    languageMode: 'bilingual',
    linkedClipGroupId: 'group-1',
    syncEnabled: true,
    sourceAlignment: [{
      id: 'source-1',
      start: 1,
      end: 3,
      text: 'Krishna speaks',
      words: [],
    }],
    targetAlignment: [{
      id: 'target-1',
      start: 1,
      end: 3,
      text: 'Кришна говорит',
      words: [],
    }],
  }];

  const changedSource = [{
    id: 'source-1',
    start: 2,
    end: 4.5,
    text: 'Krishna speaks',
    words: [],
  }];

  const result = buildSyncPatch(
    [{ ...plans[0], sourceAlignment: changedSource }],
    0,
    { sourceAlignment: changedSource },
  );

  assert.equal(result?.partnerIndex, 0);
  assert.equal(result?.patch.targetAlignment?.[0]?.start, 2);
  assert.equal(result?.patch.targetAlignment?.[0]?.end, 4.5);
  assert.equal(result?.patch.targetAlignment?.[0]?.text, 'Кришна говорит');
});

test('buildSyncPatch mirrors every clip-level synced editor parameter', () => {
  const sourceKeyframes = [{ id: 'kf-1', time: 0, x: 12, y: -6, zoom: 1.35, backgroundColor: '#123456' }];
  const sourceAlignment = [{ id: 'source-1', start: 1.2, end: 2.8, text: 'Source text', words: [] }];
  const timelineCuts = [{ startSec: 3, endSec: 4.25 }];
  const timelineTrim = { trimStartSec: 0.5, trimEndSec: 1.5 };
  const sourceLogo = { id: 'logo-1', src: '/tmp/logo.png', size: 1.2, opacity: 0.7 };
  const sourceTextTracks = [{
    id: 'text-track-1',
    name: 'CTA',
    blocks: [{ id: 'text-block-1', startSec: 1, endSec: 3, text: 'Subscribe' }],
  }];
  const sourceAudioTracks = [{
    id: 'audio-track-1',
    name: 'Music',
    src: '/tmp/music.mp3',
    startSec: 0,
    trimStartSec: 0,
    trimEndSec: 0,
    volume: 0.4,
    fadeInSec: 1,
    fadeOutSec: 1,
  }];
  const backgroundSettings = {
    solidEnabled: true,
    solidColor: '#334455',
    blurEnabled: true,
    blurStrength: 18,
    blurScale: 1.4,
    gradientEnabled: true,
    gradientType: 'linear' as const,
    gradientColorA: '#111111',
    gradientColorB: '#999999',
    gradientAngle: 45,
    gradientOpacity: 0.7,
    featherEnabled: true,
    featherTop: 22,
    featherBottom: 33,
    featherLeft: 11,
    featherRight: 17,
    frameGuideColor: '#ffaa19',
    frameGuideOpacity: 0.5,
    frameGuideBorderWidth: 4,
    frameGuideBlur: 7,
    frameGuideBorderOpacity: 0.8,
  };
  const plans: ShortsClipPlan[] = [{
    start: '00:00',
    end: '00:10',
    title: 'Target',
    summary: '',
    hook: '',
    languageMode: 'bilingual',
    linkedClipGroupId: 'group-1',
    syncEnabled: true,
    targetAlignment: [{ id: 'target-1', start: 0, end: 1, text: 'Target text', words: [] }],
    sourceAlignment: [],
    sourceFrameKeyframes: [],
    targetFrameKeyframes: [],
  }];

  const patch = {
    sourceAlignment,
    sourceFrameKeyframes: sourceKeyframes,
    timelineCuts,
    timelineTrim,
    backgroundSettings,
    sourceLogo,
    sourceTextTracks,
    sourceAudioTracks,
  };
  const result = buildSyncPatch([{ ...plans[0], ...patch }], 0, patch);

  assert.deepEqual(result?.patch.targetFrameKeyframes, sourceKeyframes);
  assert.equal(result?.patch.targetAlignment?.[0]?.start, 1.2);
  assert.equal(result?.patch.targetAlignment?.[0]?.end, 2.8);
  assert.equal(result?.patch.targetAlignment?.[0]?.text, 'Target text');
  assert.deepEqual(result?.patch.timelineCuts, timelineCuts);
  assert.deepEqual(result?.patch.timelineTrim, timelineTrim);
  assert.deepEqual(result?.patch.backgroundSettings, backgroundSettings);
  assert.deepEqual(result?.patch.targetLogo, sourceLogo);
  assert.deepEqual(result?.patch.targetTextTracks, sourceTextTracks);
  assert.deepEqual(result?.patch.targetAudioTracks, sourceAudioTracks);
});

test('buildSyncPatch syncs a bilingual source/target plan even without a linked group id', () => {
  const sourceAlignment = [{ id: 'source-1', start: 3, end: 5, text: 'Source text', words: [] }];
  const sourceFrameKeyframes = [{ id: 'kf-1', time: 0, x: -9, y: 6, zoom: 1.55, backgroundColor: '#ffaa19' }];
  const result = buildSyncPatch([{
    start: '00:00',
    end: '00:10',
    title: 'Bilingual',
    summary: '',
    hook: '',
    languageMode: 'bilingual',
    syncEnabled: true,
    sourceAlignment,
    targetAlignment: [{ id: 'target-1', start: 0, end: 1, text: 'Target text', words: [] }],
    sourceFrameKeyframes,
    targetFrameKeyframes: [],
  }], 0, { sourceAlignment, sourceFrameKeyframes });

  assert.equal(result?.partnerIndex, 0);
  assert.deepEqual(result?.patch.targetFrameKeyframes, sourceFrameKeyframes);
  assert.equal(result?.patch.targetAlignment?.[0]?.start, 3);
  assert.equal(result?.patch.targetAlignment?.[0]?.end, 5);
  assert.equal(result?.patch.targetAlignment?.[0]?.text, 'Target text');
});

test('buildSyncPatch mirrors linked pair timing using the partner language text', () => {
  const changedSource = [{ id: 'source-1', start: 4, end: 7, text: 'Source text', words: [] }];
  const plans: ShortsClipPlan[] = [{
    start: '00:00',
    end: '00:10',
    title: 'Source card',
    summary: '',
    hook: '',
    languageMode: 'source',
    linkedClipGroupId: 'pair-1',
    syncEnabled: true,
    sourceAlignment: changedSource,
  }, {
    start: '00:00',
    end: '00:10',
    title: 'Target card',
    summary: '',
    hook: '',
    languageMode: 'target',
    linkedClipGroupId: 'pair-1',
    syncEnabled: true,
    targetAlignment: [{ id: 'target-1', start: 0, end: 1, text: 'Текст перевода', words: [] }],
  }];

  const result = buildSyncPatch(plans, 0, { sourceAlignment: changedSource });

  assert.equal(result?.partnerIndex, 1);
  assert.equal(result?.patch.targetAlignment?.[0]?.start, 4);
  assert.equal(result?.patch.targetAlignment?.[0]?.end, 7);
  assert.equal(result?.patch.targetAlignment?.[0]?.text, 'Текст перевода');
});

test('toggleSync enables bilingual sync by copying existing source editor parameters to target', () => {
  const plans: ShortsClipPlan[] = [{
    start: '00:00',
    end: '00:10',
    title: 'Target',
    summary: '',
    hook: '',
    languageMode: 'bilingual',
    linkedClipGroupId: 'group-1',
    syncEnabled: false,
    sourceAlignment: [{ id: 'source-1', start: 2, end: 4, text: 'Source text', words: [] }],
    targetAlignment: [{ id: 'target-1', start: 0, end: 1, text: 'Target text', words: [] }],
    sourceFrameKeyframes: [{ id: 'kf-1', time: 0, x: 8, y: 4, zoom: 1.4, backgroundColor: '#abcdef' }],
    timelineCuts: [{ startSec: 5, endSec: 6 }],
    timelineTrim: { trimStartSec: 1, trimEndSec: 2 },
    backgroundSettings: {
      solidEnabled: true,
      solidColor: '#112233',
      blurEnabled: false,
      blurStrength: 12,
      blurScale: 1.1,
      gradientEnabled: false,
      gradientType: 'linear',
      gradientColorA: '#000000',
      gradientColorB: '#ffffff',
      gradientAngle: 90,
      gradientOpacity: 0.5,
      featherEnabled: false,
      featherTop: 0,
      featherBottom: 0,
      featherLeft: 0,
      featherRight: 0,
      frameGuideColor: '#ffaa19',
      frameGuideOpacity: 0.75,
      frameGuideBorderWidth: 2,
      frameGuideBlur: 0,
      frameGuideBorderOpacity: 1,
    },
  }];

  const [updated] = toggleSync(plans, 0);

  assert.equal(updated.syncEnabled, true);
  assert.deepEqual(updated.targetFrameKeyframes, plans[0].sourceFrameKeyframes);
  assert.equal(updated.targetAlignment?.[0]?.start, 2);
  assert.equal(updated.targetAlignment?.[0]?.end, 4);
  assert.equal(updated.targetAlignment?.[0]?.text, 'Target text');
  assert.deepEqual(updated.timelineCuts, plans[0].timelineCuts);
  assert.deepEqual(updated.timelineTrim, plans[0].timelineTrim);
  assert.deepEqual(updated.backgroundSettings, plans[0].backgroundSettings);
});

test('buildSyncPatch does not mirror source alignment to target if targetAlignment is empty/undefined', () => {
  const plans: ShortsClipPlan[] = [{
    start: '00:00',
    end: '00:10',
    title: 'Target',
    summary: '',
    hook: '',
    languageMode: 'bilingual',
    linkedClipGroupId: 'group-1',
    syncEnabled: true,
    sourceAlignment: [{
      id: 'source-1',
      start: 1,
      end: 3,
      text: 'Krishna speaks',
      words: [],
    }],
    targetAlignment: undefined,
  }];

  const changedSource = [{
    id: 'source-1',
    start: 2,
    end: 4.5,
    text: 'Krishna speaks',
    words: [],
  }];

  const result = buildSyncPatch(
    [{ ...plans[0], sourceAlignment: changedSource }],
    0,
    { sourceAlignment: changedSource },
  );

  assert.equal(result?.partnerIndex, 0);
  assert.equal(result?.patch.targetAlignment, undefined);
});

