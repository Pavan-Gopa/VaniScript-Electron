import test from 'node:test';
import assert from 'node:assert/strict';
import type { ShortsRenderProject } from '../render-engine/types';
import {
  createShortsExportEventGate,
  deepCloneDeepFreeze,
  deepFreeze,
  findDuplicateOutputPaths,
  isShortsExportProgressEvent,
  isShortsExportSnapshot,
  isShortsExportTerminalEvent,
  materializeShortsExportSnapshot,
  shortsExportFileName,
  validateShortsExportSnapshot,
  type ShortsExportOptions,
  type ShortsExportProgressEvent,
  type ShortsExportSnapshot,
  type ShortsExportSnapshotSeed,
  type ShortsExportTerminalEvent,
  type ShortsExportTerminalState,
} from './shorts-export-contract';

const SOURCE_URL = 'file:///source.mp4';

const options: ShortsExportOptions = {
  format: 'mp4',
  resolutionPreset: '1080p',
  frameRatePreset: '30',
  qualityPreset: 'balanced',
  subtitleBottomMargin: 96,
  subtitleUseCharsPerLine: true,
  subtitleUseLinesPerCue: true,
  subtitleMaxCharsPerLine: 34,
  subtitleMaxLines: 2,
};

function makeProject(id: string, title: string): ShortsRenderProject {
  return {
    id,
    title,
    inputVideoSrc: SOURCE_URL,
    sourceWidth: 1920,
    sourceHeight: 1080,
    width: 1080,
    height: 1920,
    fps: 30,
    clipStartSec: 1,
    clipEndSec: 11,
    durationSec: 10,
    durationInFrames: 300,
    subtitles: [{ id: `${id}-cue`, startSec: 0, endSec: 1, text: title }],
    captionStyle: {
      fontFamily: 'Cuprum',
      fontSize: 96,
      bold: true,
      textTransform: 'none',
      textColor: '#ffffff',
      boxColor: '#000000',
      boxOpacity: 0.4,
      boxWidth: 90,
      boxHeight: 12,
      edgeBlur: 0,
      letterSpacing: 0,
      lineSpacing: 1,
      edgeSoftness: 0,
      outline: 0,
      shadow: 0,
    },
    subtitleBottomMargin: 96,
    frameKeyframes: [{ id: `${id}-frame`, time: 0, x: 0, y: 0, zoom: 1 }],
    mediaSegments: [{ sourceStartSec: 1, sourceEndSec: 11, outputStartSec: 0, outputEndSec: 10 }],
  };
}

function makeSeed(clips: ShortsExportSnapshotSeed['clips']): ShortsExportSnapshotSeed {
  return {
    jobId: 'job-immutable-1',
    source: {
      inputVideoPath: '/media/source.mp4',
      inputVideoSrc: SOURCE_URL,
      sourceFileName: 'source.mp4',
    },
    options,
    clips,
    selectedUnits: clips.map(({ stableID, language }) => ({ stableID, language })),
    transcriptCueInputs: [{ id: 'cue-1', text: 'captured before awaiting probe' }],
    activeTranslationLanguage: 'Spanish',
  };
}

function makeClip(stableID: string, language: 'source' | 'target', title: string): ShortsExportSnapshotSeed['clips'][number] {
  return {
    stableID,
    language,
    title,
    project: makeProject(`${stableID}-${language}`, title),
    renderSeed: { stableID, language, title },
    selectedUnit: { stableID, language },
  };
}

function materialize(seed: ShortsExportSnapshotSeed = makeSeed([
  makeClip('plan-a', 'source', 'Alpha'),
])): ShortsExportSnapshot {
  return materializeShortsExportSnapshot(seed, {
    width: 1920,
    height: 1080,
    durationSec: 120,
    fps: 29.97,
  }, '/exports/shorts');
}

test('deep clone/freeze creates immutable plain values without freezing the source', () => {
  const source = { nested: { count: 2 }, list: [{ value: 'kept' }] };
  const frozen = deepCloneDeepFreeze(source);

  assert.notEqual(frozen, source);
  assert(Object.isFrozen(frozen));
  assert(Object.isFrozen(frozen.nested));
  assert(Object.isFrozen(frozen.list));
  assert(Object.isFrozen(frozen.list[0]));
  assert.equal(Reflect.set(frozen.nested as unknown as object, 'count', 9), false);
  assert.equal((frozen.nested as { count: number }).count, 2);
  source.nested.count = 7;
  source.list[0].value = 'changed';
  assert.equal((frozen.nested as { count: number }).count, 2);
  assert.equal((frozen.list[0] as { value: string }).value, 'kept');

  const inPlace = { nested: { value: true } };
  assert.equal(deepFreeze(inPlace), inPlace);
  assert(Object.isFrozen(inPlace));
  assert(Object.isFrozen(inPlace.nested));
});

test('materialized snapshot survives a JSON round trip with the same wire shape', () => {
  const snapshot = materialize();
  const roundTrip = JSON.parse(JSON.stringify(snapshot)) as unknown;

  assert.deepEqual(roundTrip, snapshot);
  assert.equal(isShortsExportSnapshot(roundTrip), true);
  assert.equal(validateShortsExportSnapshot(roundTrip).ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(roundTrip, 'renderSeed'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(roundTrip, 'selectedUnits'), false);
});

test('materialization sorts selection units and derives deterministic one-based names', () => {
  const snapshot = materialize(makeSeed([
    makeClip('plan-b', 'target', 'Beta/Title'),
    makeClip('plan-a', 'target', 'Alpha'),
    makeClip('plan-b', 'source', 'Beta/Title'),
    makeClip('plan-a', 'source', 'Alpha'),
  ]));

  assert.deepEqual(snapshot.clips.map((clip) => [clip.ordinal, clip.stableID, clip.language]), [
    [1, 'plan-a', 'source'],
    [2, 'plan-a', 'target'],
    [3, 'plan-b', 'source'],
    [4, 'plan-b', 'target'],
  ]);
  assert.deepEqual(snapshot.clips.map((clip) => clip.fileName), [
    '01_source_Alpha.mp4',
    '02_target_Alpha.mp4',
    '03_source_Beta_Title.mp4',
    '04_target_Beta_Title.mp4',
  ]);
  assert.deepEqual(snapshot.clips.map((clip) => clip.outputPath), [
    '/exports/shorts/01_source_Alpha.mp4',
    '/exports/shorts/02_target_Alpha.mp4',
    '/exports/shorts/03_source_Beta_Title.mp4',
    '/exports/shorts/04_target_Beta_Title.mp4',
  ]);
  assert.equal(shortsExportFileName(3, 'target', 'Beta/Title', '.mov'), '03_target_Beta_Title.mov');
});

test('duplicate output paths are reported and invalidate a snapshot', () => {
  const snapshot = materialize(makeSeed([
    makeClip('plan-a', 'source', 'Same'),
    makeClip('plan-b', 'source', 'Same'),
  ]));
  const duplicate = JSON.parse(JSON.stringify(snapshot)) as {
    clips: Array<{ outputPath: string }>;
  };
  duplicate.clips[1].outputPath = duplicate.clips[0].outputPath;

  assert.deepEqual(findDuplicateOutputPaths(duplicate.clips), [duplicate.clips[0].outputPath]);
  const validation = validateShortsExportSnapshot(duplicate);
  assert.equal(validation.ok, false);
  if (!validation.ok) assert.equal(validation.issues.some((issue) => issue.code === 'DUPLICATE_OUTPUT_PATH'), true);
});

test('mutating seed plans, settings, and cue inputs after creation cannot alter the frozen snapshot', () => {
  const seed = makeSeed([makeClip('plan-a', 'source', 'Original')]);
  const snapshot = materialize(seed);
  const mutableProject = seed.clips[0].project as ShortsRenderProject;
  mutableProject.title = 'Mutated title';
  mutableProject.subtitles[0].text = 'Mutated cue';
  (seed.options as { format: 'mp4' | 'mov' }).format = 'mov';
  (seed.transcriptCueInputs as Array<{ text: string }>)[0].text = 'Mutated transcript';

  assert.equal(snapshot.options.format, 'mp4');
  assert.equal(snapshot.clips[0].project.title, 'Original');
  assert.equal(snapshot.clips[0].project.subtitles[0].text, 'Original');
  assert.equal(snapshot.clips[0].fileName, '01_source_Original.mp4');
  assert(Object.isFrozen(snapshot.clips[0].project.subtitles[0]));
});

test('progress and terminal type guards accept contract events and reject non-JSON values', () => {
  assert.equal(isShortsExportProgressEvent({
    jobId: 'job-1', sequence: 1, kind: 'starting', clipIndex: 0,
    completed: 0, current: 1, total: 2, progress: 0, stage: 'prepare', message: 'Starting',
  }), true);
  assert.equal(isShortsExportProgressEvent({
    jobId: 'job-1', sequence: 1, kind: 'progress', clipIndex: 0,
    completed: 0, current: 1, total: 2, progress: 0.5, stage: 'render', message: () => 'not JSON',
  }), false);
  assert.equal(isShortsExportTerminalEvent({
    jobId: 'job-1', sequence: 2, kind: 'terminal', state: 'succeeded',
    progress: 1, total: 1, completed: 1, outputs: ['/exports/shorts/01_source_Alpha.mp4'],
    message: 'Complete', cleanupComplete: true,
  }), true);
});

function makeGateProgressEvent(jobId: string, sequence: number, progress: number): ShortsExportProgressEvent {
  return {
    jobId,
    sequence,
    kind: 'progress',
    clipIndex: 0,
    completed: 0,
    current: 1,
    total: 2,
    progress,
    stage: 'render',
    message: `Progress ${progress}`,
  };
}

function makeGateTerminalEvent(
  jobId: string,
  sequence: number,
  state: ShortsExportTerminalState,
  progress: number,
): ShortsExportTerminalEvent {
  return {
    jobId,
    sequence,
    kind: 'terminal',
    state,
    progress,
    total: 2,
    completed: state === 'succeeded' ? 2 : 0,
    outputs: state === 'succeeded' ? ['/exports/shorts/01_source_Alpha.mp4'] : [],
    message: state === 'succeeded' ? 'Complete' : `Export ${state}`,
    cleanupComplete: true,
  };
}

test('shorts export event gate enforces sequence, job, terminal, and monotonic progress rules', () => {
  const gate = createShortsExportEventGate({ jobId: 'job-ordered' });

  assert.ok(gate.accept(makeGateProgressEvent('job-ordered', 2, 0.8)));
  assert.equal(gate.state.sequence, 2);
  assert.equal(gate.state.percent, 0.8);

  assert.ok(gate.accept(makeGateProgressEvent('job-ordered', 3, 0.4)));
  assert.equal(gate.state.sequence, 3);
  assert.equal(gate.state.percent, 0.8);
  assert.equal(gate.accept(makeGateProgressEvent('job-ordered', 3, 0.9)), null);
  assert.equal(gate.accept(makeGateProgressEvent('stale-job', 4, 0.9)), null);

  const terminal = makeGateTerminalEvent('job-ordered', 4, 'failed', 0.7);
  assert.ok(gate.accept(terminal));
  assert.equal(gate.state.sequence, 4);
  assert.equal(gate.state.percent, 0.8);
  assert.equal(gate.state.terminal, true);
  assert.equal(gate.state.lastTerminal, terminal);
  assert.equal(gate.accept(makeGateProgressEvent('job-ordered', 5, 1)), null);
  assert.equal(gate.accept(makeGateTerminalEvent('job-ordered', 6, 'failed', 1)), null);
});

test('failed terminal resets at retry entry so a retry without close accepts its own session once', () => {
  const gate = createShortsExportEventGate({ jobId: 'job-first' });
  const failed = makeGateTerminalEvent('job-first', 1, 'failed', 0);

  assert.ok(gate.accept(failed));
  assert.equal(gate.state.lastTerminal, failed);
  assert.equal(gate.accept(makeGateProgressEvent('job-first', 2, 0.5)), null);

  gate.reset({ jobId: 'job-retry' });
  assert.equal(gate.state.jobId, 'job-retry');
  assert.equal(gate.state.sequence, 0);
  assert.equal(gate.state.percent, 0);
  assert.equal(gate.state.terminal, false);
  assert.equal(gate.state.lastTerminal, null);
  assert.equal(gate.accept(makeGateProgressEvent('job-first', 2, 0.5)), null);

  const progress = makeGateProgressEvent('job-retry', 1, 0.5);
  const terminal = makeGateTerminalEvent('job-retry', 2, 'failed', 1);
  assert.ok(gate.accept(progress));
  assert.equal(gate.state.lastTerminal, null);
  assert.ok(gate.accept(terminal));
  assert.equal(gate.state.lastTerminal, terminal);
  assert.equal(gate.accept(makeGateTerminalEvent('job-retry', 3, 'failed', 1)), null);
});

test('succeeded terminal state makes retry eligibility false', () => {
  const gate = createShortsExportEventGate({ jobId: 'job-success' });
  const terminal = makeGateTerminalEvent('job-success', 1, 'succeeded', 1);

  assert.ok(gate.accept(terminal));
  const state = gate.state;
  assert.equal(state.lastTerminal?.state, 'succeeded');
  assert.equal(state.terminal, true);
  assert.equal(['failed', 'cancelled'].includes(state.lastTerminal?.state ?? ''), false);
});
