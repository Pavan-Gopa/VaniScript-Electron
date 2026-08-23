'use strict';

// P3E.D1 — Media processing coordinator parity tests.
//
// `prepareMediaSession` owns the startup media preparation mechanics that used
// to live inline in App.tsx `handleStartEngine`. These tests defend the
// observable contract of that extraction against injected fakes only — no
// React, no global window, no real FFmpeg:
//
//   - video happy path: extract-audio bridge choice, duration probe on the
//     converted WAV, fixed-interval slicing, chunk bounds/status fields,
//     best-effort source media info, and the exact ordered stage/progress
//     snapshot stream (the old procMsg/procProgress milestones);
//   - real silence analysis over a crafted PCM fixture (loud signal with one
//     deterministic silence notch) producing the expected single cut point;
//   - conversion failure: warning + original-path fallback, then a successful
//     session built from the original media;
//   - no bridge: every bridge stage skipped, settings-derived duration and a
//     single unsplit chunk, milestones still emitted;
//   - silence read/analysis failures falling through to fixed intervals
//     silently (the catch is deliberately quiet — no warning);
//   - slice failure or empty output retaining the existing single-path
//     behavior (including the unchanged "Creating N segments" message quirk);
//   - source media info failures being warned and strictly non-fatal.

const test = require('node:test');
const assert = require('node:assert/strict');
require('tsx/cjs');

const { prepareMediaSession } = require('../src/services/media-processing-coordinator.ts');

// --- Fixtures -----------------------------------------------------------------

const CONFIG = {
  date: '2026-08-23',
  location: 'Mayapur',
  lecturer: 'Test Lecturer',
  participants: '',
  targetLang: 'Russian',
  formats: ['TXT'],
  transcriptionProvider: 'gemini',
  translationProvider: 'gemini',
};

const FIXED_CHUNKING = { chunkDurationMin: 2, sliceMode: 'fixed', silenceThreshDb: -16, minSilenceMs: 400 };

/** Fake bridge recording every call as [method, opts] entries. */
function makeBridge(overrides = {}) {
  const calls = [];
  const record = (name, fn) => async (opts) => {
    calls.push([name, opts]);
    return fn(opts);
  };
  const bridge = {
    ffmpegConvertToWav: record('ffmpegConvertToWav', () => ({ success: true, outputPath: '/prep/source.wav' })),
    ffmpegGetDuration: record('ffmpegGetDuration', () => ({ success: true, durationSec: 300 })),
    readFileBuffer: record('readFileBuffer', () => ({ success: false })),
    ffmpegSliceChunks: record('ffmpegSliceChunks', (opts) => ({
      success: true,
      // N cut points yield N + 1 segments, matching the main-process slicer.
      chunkPaths: Array.from({ length: opts.cutPoints.length + 1 }, (_, i) => `/prep/seg-${i + 1}.wav`),
    })),
    ffmpegGetSourceMediaInfo: record('ffmpegGetSourceMediaInfo', (opts) => ({
      filePath: opts.inputPath,
      fileName: 'fixture',
      kind: 'audio',
      durationSec: opts.durationSec,
    })),
    ...overrides,
  };
  // Overridden methods still record because overrides receive the recorder too.
  for (const [name, value] of Object.entries(overrides)) {
    if (typeof value === 'function') {
      bridge[name] = async (opts) => {
        calls.push([name, opts]);
        return value(opts);
      };
    } else if (value === undefined) {
      delete bridge[name];
    }
  }
  return { bridge, calls };
}

/** Deps whose snapshots/warnings are recorded in arrival order. */
function recordingDeps(bridge) {
  const snapshots = [];
  const warnings = [];
  const deps = {
    ...(bridge ? { bridge } : {}),
    report: (snapshot) => snapshots.push(snapshot),
    warn: (message, detail) => warnings.push([message, detail]),
  };
  return { deps, snapshots, warnings };
}

function callsOf(calls, name) {
  return calls.filter(([method]) => method === name);
}

/**
 * 150 s of 16 kHz PCM: constant-amplitude everywhere except one fully silent
 * notch from 116 s to 126 s. The slicer's 20 ms energy windows quantize the
 * notch to the region [116000, 126000] ms, so the single 120 s target cut
 * deterministically lands on its midpoint: 121000 ms -> 121 s.
 */
function silenceNotchPcm() {
  const SAMPLE_RATE = 16000;
  const samples = new Int16Array(150 * SAMPLE_RATE);
  samples.fill(8000);
  samples.fill(0, 116 * SAMPLE_RATE, 126 * SAMPLE_RATE);
  return samples;
}

/** Full milestone stream for a bridge-backed run with a successful conversion. */
function expectedSnapshots(conversionStage, segmentCount) {
  return [
    { progress: 5 },
    { stage: 'Converting audio format…' },
    { stage: conversionStage },
    { progress: 25 },
    { progress: 40 },
    { stage: 'Analyzing audio for optimal split points…' },
    { progress: 60 },
    { stage: `Creating ${segmentCount} audio segment(s)…` },
    { progress: 80 },
    { stage: 'Reading source media details…' },
    { stage: 'Uploading audio and initializing AI…' },
    { progress: 90 },
    { progress: 100 },
  ];
}

function expectedChunk(index, filePath, startSec, endSec) {
  return {
    index,
    filePath,
    durationSec: endSec - startSec,
    startSec,
    endSec,
    original: '',
    translated: '',
    status: 'pending',
    approved: false,
  };
}

// --- Tests --------------------------------------------------------------------

test('video happy path uses the extract-audio bridge and preserves the exact milestone stream', async () => {
  const { bridge, calls } = makeBridge({
    ffmpegExtractAudioForTranscription: () => Promise.resolve({ success: true, outputPath: '/prep/lecture.wav' }),
  });
  const { deps, snapshots, warnings } = recordingDeps(bridge);

  const prepared = await prepareMediaSession(
    { sourceFile: '/media/lecture.mp4', sourceFileName: 'lecture.mp4', config: CONFIG, chunking: FIXED_CHUNKING },
    deps,
  );

  // Bridge choices: video goes through the transcription extractor, never the generic converter.
  assert.deepEqual(callsOf(calls, 'ffmpegExtractAudioForTranscription'), [
    ['ffmpegExtractAudioForTranscription', { inputPath: '/media/lecture.mp4' }],
  ]);
  assert.deepEqual(callsOf(calls, 'ffmpegConvertToWav'), []);
  assert.deepEqual(callsOf(calls, 'ffmpegGetDuration'), [['ffmpegGetDuration', { inputPath: '/prep/lecture.wav' }]]);
  assert.deepEqual(callsOf(calls, 'ffmpegSliceChunks'), [
    ['ffmpegSliceChunks', { inputPath: '/prep/lecture.wav', cutPoints: [120, 240] }],
  ]);
  assert.deepEqual(callsOf(calls, 'ffmpegGetSourceMediaInfo'), [
    ['ffmpegGetSourceMediaInfo', { inputPath: '/media/lecture.mp4', durationSec: 300 }],
  ]);

  // Ordered stage/progress snapshots mirror the historical procMsg/procProgress calls.
  assert.deepEqual(snapshots, expectedSnapshots('Extracting audio from video…', 3));
  assert.deepEqual(warnings, []);

  // Fixed intervals for a 300 s source at 2 min chunks: cuts at 120 s and 240 s.
  assert.deepEqual(prepared.chunks, [
    expectedChunk(0, '/prep/seg-1.wav', 0, 120),
    expectedChunk(1, '/prep/seg-2.wav', 120, 240),
    expectedChunk(2, '/prep/seg-3.wav', 240, 300),
  ]);

  assert.deepEqual(prepared, {
    sourceFile: '/media/lecture.mp4',
    sourceFileName: 'lecture.mp4',
    sourceMediaKind: 'video',
    originalVideoPath: '/media/lecture.mp4',
    wavPath: '/prep/lecture.wav',
    config: CONFIG,
    chunks: prepared.chunks,
    currentIndex: 0,
    targetLang: 'Russian',
    sourceMediaInfo: { filePath: '/media/lecture.mp4', fileName: 'fixture', kind: 'audio', durationSec: 300 },
  });
});

test('silence analysis reads the WAV, computes real cut points, and slices on them', async () => {
  const pcm = silenceNotchPcm();
  const { bridge, calls } = makeBridge({
    // Probe reports the same 150 s the PCM fixture encodes.
    ffmpegGetDuration: () => Promise.resolve({ success: true, durationSec: 150 }),
    readFileBuffer: () => Promise.resolve({
      success: true,
      data: pcm.buffer,
      byteLength: pcm.byteLength,
      byteOffset: 0,
    }),
  });
  const { deps, snapshots, warnings } = recordingDeps(bridge);

  const prepared = await prepareMediaSession(
    {
      sourceFile: '/media/talk.m4a',
      sourceFileName: 'talk.m4a',
      config: CONFIG,
      chunking: { ...FIXED_CHUNKING, sliceMode: 'silence' },
    },
    deps,
  );

  assert.deepEqual(callsOf(calls, 'readFileBuffer'), [['readFileBuffer', { filePath: '/prep/source.wav' }]]);
  assert.deepEqual(callsOf(calls, 'ffmpegSliceChunks'), [
    ['ffmpegSliceChunks', { inputPath: '/prep/source.wav', cutPoints: [121] }],
  ]);
  // The silence notch midpoint becomes the sole cut; remainder keeps 29 s.
  assert.deepEqual(prepared.chunks, [
    expectedChunk(0, '/prep/seg-1.wav', 0, 121),
    expectedChunk(1, '/prep/seg-2.wav', 121, 150),
  ]);
  assert.equal(prepared.wavPath, '/prep/source.wav');
  assert.deepEqual(snapshots, expectedSnapshots('Converting audio to WAV 16kHz…', 2));
  assert.deepEqual(warnings, []);
});
test('conversion failure warns and falls back to the original media path for the whole session', async () => {
  const { bridge, calls } = makeBridge({
    ffmpegConvertToWav: () => Promise.resolve({ success: false, outputPath: '', error: 'ffmpeg exploded' }),
    // Short source so the fixed-interval loop produces no cuts at all.
    ffmpegGetDuration: () => Promise.resolve({ success: true, durationSec: 150 }),
  });
  const { deps, snapshots, warnings } = recordingDeps(bridge);
  const prepared = await prepareMediaSession(
    {
      sourceFile: '/media/talk.m4a',
      sourceFileName: 'talk.m4a',
      config: CONFIG,
      chunking: { ...FIXED_CHUNKING, sliceMode: 'silence' },
    },
    deps,
  );

  assert.deepEqual(warnings, [['FFmpeg conversion failed, using original file:', 'ffmpeg exploded']]);
  assert.deepEqual(snapshots, [
    { progress: 5 },
    { stage: 'Converting audio format…' },
    { stage: 'Converting audio to WAV 16kHz…' },
    { stage: 'Using original audio format…' },
    { progress: 25 },
    { progress: 40 },
    { stage: 'Analyzing audio for optimal split points…' },
    { progress: 60 },
    { stage: 'Creating 1 audio segment(s)…' },
    { progress: 80 },
    { stage: 'Reading source media details…' },
    { stage: 'Uploading audio and initializing AI…' },
    { progress: 90 },
    { progress: 100 },
  ]);

  // Duration is probed on the original file; silence analysis is skipped for non-WAV paths.
  assert.deepEqual(callsOf(calls, 'ffmpegGetDuration'), [['ffmpegGetDuration', { inputPath: '/media/talk.m4a' }]]);
  assert.deepEqual(callsOf(calls, 'readFileBuffer'), []);

  // A 150 s source yields no fixed cuts, so the single chunk IS the original path.
  assert.deepEqual(callsOf(calls, 'ffmpegSliceChunks'), []);
  assert.deepEqual(prepared.chunks, [expectedChunk(0, '/media/talk.m4a', 0, 150)]);
  assert.equal(prepared.wavPath, '/media/talk.m4a');
  assert.equal(prepared.sourceMediaKind, 'audio');
  assert.equal(prepared.originalVideoPath, undefined);
  assert.equal(snapshots[snapshots.length - 1].progress, 100);
});

test('unsuccessful or non-positive duration probes retain the settings-derived fixed bounds', async () => {
  const invalidDurationCases = [
    { label: 'unsuccessful probe', result: { success: false, durationSec: 999 } },
    { label: 'zero duration', result: { success: true, durationSec: 0 } },
    { label: 'negative duration', result: { success: true, durationSec: -1 } },
  ];

  for (const { label, result } of invalidDurationCases) {
    const { bridge, calls } = makeBridge({
      ffmpegGetDuration: () => result,
    });
    const { deps, snapshots, warnings } = recordingDeps(bridge);

    const prepared = await prepareMediaSession(
      { sourceFile: '/media/talk.m4a', sourceFileName: 'talk.m4a', config: CONFIG, chunking: FIXED_CHUNKING },
      deps,
    );

    assert.deepEqual(
      callsOf(calls, 'ffmpegGetDuration'),
      [['ffmpegGetDuration', { inputPath: '/prep/source.wav' }]],
      label,
    );
    assert.deepEqual(callsOf(calls, 'ffmpegSliceChunks'), [], label);
    assert.deepEqual(
      callsOf(calls, 'ffmpegGetSourceMediaInfo'),
      [['ffmpegGetSourceMediaInfo', { inputPath: '/media/talk.m4a', durationSec: 120 }]],
      label,
    );
    assert.deepEqual(prepared.chunks, [expectedChunk(0, '/prep/source.wav', 0, 120)], label);
    assert.ok(snapshots.some((snapshot) => snapshot.stage === 'Creating 1 audio segment(s)…'), label);
    assert.deepEqual(warnings, [], label);
  }
});

test('video without the extraction bridge converts the original video path through the WAV bridge', async () => {
  const { bridge, calls } = makeBridge();
  const { deps, warnings } = recordingDeps(bridge);

  const prepared = await prepareMediaSession(
    { sourceFile: '/media/lecture.mp4', sourceFileName: 'lecture.mp4', config: CONFIG, chunking: FIXED_CHUNKING },
    deps,
  );

  assert.deepEqual(callsOf(calls, 'ffmpegExtractAudioForTranscription'), []);
  assert.deepEqual(callsOf(calls, 'ffmpegConvertToWav'), [
    ['ffmpegConvertToWav', { inputPath: '/media/lecture.mp4' }],
  ]);
  assert.deepEqual(callsOf(calls, 'ffmpegGetDuration'), [
    ['ffmpegGetDuration', { inputPath: '/prep/source.wav' }],
  ]);
  assert.equal(prepared.wavPath, '/prep/source.wav');
  assert.equal(prepared.originalVideoPath, '/media/lecture.mp4');
  assert.deepEqual(warnings, []);
});

test('thrown conversion, duration, and slice errors reject unchanged and suppress downstream bridges', async () => {
  const failureCases = [
    {
      label: 'conversion',
      method: 'ffmpegConvertToWav',
      expectedCalls: ['ffmpegConvertToWav'],
      expectedLastSnapshot: { stage: 'Converting audio to WAV 16kHz…' },
    },
    {
      label: 'duration',
      method: 'ffmpegGetDuration',
      expectedCalls: ['ffmpegConvertToWav', 'ffmpegGetDuration'],
      expectedLastSnapshot: { progress: 25 },
    },
    {
      label: 'slice',
      method: 'ffmpegSliceChunks',
      expectedCalls: ['ffmpegConvertToWav', 'ffmpegGetDuration', 'ffmpegSliceChunks'],
      expectedLastSnapshot: { stage: 'Creating 3 audio segment(s)…' },
    },
  ];

  for (const failureCase of failureCases) {
    const failure = new Error(`${failureCase.label} bridge boom`);
    const { bridge, calls } = makeBridge({
      [failureCase.method]: () => {
        throw failure;
      },
    });
    const { deps, snapshots, warnings } = recordingDeps(bridge);

    await assert.rejects(
      () => prepareMediaSession(
        { sourceFile: '/media/talk.m4a', sourceFileName: 'talk.m4a', config: CONFIG, chunking: FIXED_CHUNKING },
        deps,
      ),
      (actual) => {
        assert.strictEqual(actual, failure);
        return true;
      },
      failureCase.label,
    );

    assert.deepEqual(calls.map(([method]) => method), failureCase.expectedCalls, failureCase.label);
    assert.deepEqual(snapshots.at(-1), failureCase.expectedLastSnapshot, failureCase.label);
    assert.deepEqual(warnings, [], failureCase.label);
  }
});

test('no bridge skips every bridge stage yet still emits all milestones with default duration', async () => {
  const { deps, snapshots, warnings } = recordingDeps(null);

  const prepared = await prepareMediaSession(
    { sourceFile: '/tmp/record.m4a', sourceFileName: 'record.m4a', config: CONFIG, chunking: FIXED_CHUNKING },
    deps,
  );

  assert.deepEqual(snapshots, [
    { progress: 5 },
    { stage: 'Converting audio format…' },
    { progress: 25 },
    { progress: 40 },
    { stage: 'Analyzing audio for optimal split points…' },
    { progress: 60 },
    { stage: 'Creating 1 audio segment(s)…' },
    { progress: 80 },
    { stage: 'Reading source media details…' },
    { stage: 'Uploading audio and initializing AI…' },
    { progress: 90 },
    { progress: 100 },
  ]);
  assert.deepEqual(warnings, []);

  // Fallback duration = chunkDurationMin * 60 = 120 s; too short for fixed cuts.
  assert.deepEqual(prepared.chunks, [expectedChunk(0, '/tmp/record.m4a', 0, 120)]);
  assert.equal(prepared.wavPath, '/tmp/record.m4a');
  assert.equal(prepared.sourceMediaKind, 'audio');
  assert.equal(prepared.originalVideoPath, undefined);
  assert.equal(prepared.sourceMediaInfo, undefined);
  assert.equal(prepared.currentIndex, 0);
  assert.equal(prepared.targetLang, 'Russian');
});

test('silence read or analysis failure falls through to fixed cuts silently', async () => {
  // Variant 1: readFileBuffer rejects — the catch swallows quietly.
  const failing = makeBridge({
    readFileBuffer: () => Promise.reject(new Error('disk boom')),
  });
  const failingDeps = recordingDeps(failing.bridge);
  const failed = await prepareMediaSession(
    {
      sourceFile: '/media/talk.m4a',
      sourceFileName: 'talk.m4a',
      config: CONFIG,
      chunking: { ...FIXED_CHUNKING, sliceMode: 'silence' },
    },
    failingDeps.deps,
  );
  assert.deepEqual(failingDeps.warnings, []);
  assert.deepEqual(callsOf(failing.calls, 'ffmpegSliceChunks'), [
    ['ffmpegSliceChunks', { inputPath: '/prep/source.wav', cutPoints: [120, 240] }],
  ]);
  assert.deepEqual(failed.chunks, [
    expectedChunk(0, '/prep/seg-1.wav', 0, 120),
    expectedChunk(1, '/prep/seg-2.wav', 120, 240),
    expectedChunk(2, '/prep/seg-3.wav', 240, 300),
  ]);

  // Variant 2: read succeeds but reports failure — equally silent, fixed cuts.
  const unsuccessful = makeBridge();
  const unsuccessfulDeps = recordingDeps(unsuccessful.bridge);
  await prepareMediaSession(
    {
      sourceFile: '/media/talk.m4a',
      sourceFileName: 'talk.m4a',
      config: CONFIG,
      chunking: { ...FIXED_CHUNKING, sliceMode: 'silence' },
    },
    unsuccessfulDeps.deps,
  );
  assert.deepEqual(unsuccessfulDeps.warnings, []);
  assert.deepEqual(callsOf(unsuccessful.calls, 'ffmpegSliceChunks'), [
    ['ffmpegSliceChunks', { inputPath: '/prep/source.wav', cutPoints: [120, 240] }],
  ]);
});

test('slice failure or empty output retains the existing single-WAV-path behavior', async () => {
  // Variant 1: slicing reports failure.
  const failedSlice = makeBridge({
    ffmpegSliceChunks: () => Promise.resolve({ success: false, chunkPaths: [], error: 'slice boom' }),
  });
  const failedDeps = recordingDeps(failedSlice.bridge);
  const failed = await prepareMediaSession(
    { sourceFile: '/media/talk.m4a', sourceFileName: 'talk.m4a', config: CONFIG, chunking: FIXED_CHUNKING },
    failedDeps.deps,
  );

  // The "Creating N segment(s)" message still counts planned segments (unchanged quirk).
  assert.ok(failedDeps.snapshots.some((s) => s.stage === 'Creating 3 audio segment(s)…'));
  assert.deepEqual(failedDeps.warnings, []);
  // Retained single path keeps the UNFIXED bounds semantics: it maps onto
  // [0, firstCut] of the planned bounds, not the full duration.
  assert.deepEqual(failed.chunks, [expectedChunk(0, '/prep/source.wav', 0, 120)]);

  // Variant 2: slicing "succeeds" with an empty output list — same retention.
  const emptySlice = makeBridge({
    ffmpegSliceChunks: () => Promise.resolve({ success: true, chunkPaths: [] }),
  });
  const emptyDeps = recordingDeps(emptySlice.bridge);
  const emptied = await prepareMediaSession(
    { sourceFile: '/media/talk.m4a', sourceFileName: 'talk.m4a', config: CONFIG, chunking: FIXED_CHUNKING },
    emptyDeps.deps,
  );
  assert.deepEqual(emptied.chunks, [expectedChunk(0, '/prep/source.wav', 0, 120)]);
});

test('source media info failure is warned about and stays non-fatal', async () => {
  // Variant 1: probe rejects — warning carries the error, pipeline completes.
  const rejecting = makeBridge({
    ffmpegGetSourceMediaInfo: () => Promise.reject(new Error('probe boom')),
  });
  const rejectingDeps = recordingDeps(rejecting.bridge);
  const rejected = await prepareMediaSession(
    { sourceFile: '/media/talk.m4a', sourceFileName: 'talk.m4a', config: CONFIG, chunking: FIXED_CHUNKING },
    rejectingDeps.deps,
  );
  assert.equal(rejectingDeps.warnings.length, 1);
  assert.equal(rejectingDeps.warnings[0][0], 'Could not read source media info:');
  assert.equal(rejectingDeps.warnings[0][1].message, 'probe boom');
  assert.equal(rejected.sourceMediaInfo, undefined);
  assert.equal(rejectingDeps.snapshots[rejectingDeps.snapshots.length - 1].progress, 100);
  assert.deepEqual(rejected.chunks, [
    expectedChunk(0, '/prep/seg-1.wav', 0, 120),
    expectedChunk(1, '/prep/seg-2.wav', 120, 240),
    expectedChunk(2, '/prep/seg-3.wav', 240, 300),
  ]);

  // Variant 2: optional method absent entirely — no warning, no crash.
  const absent = makeBridge({ ffmpegGetSourceMediaInfo: undefined });
  const absentDeps = recordingDeps(absent.bridge);
  const absentResult = await prepareMediaSession(
    { sourceFile: '/media/talk.m4a', sourceFileName: 'talk.m4a', config: CONFIG, chunking: FIXED_CHUNKING },
    absentDeps.deps,
  );
  assert.deepEqual(absentDeps.warnings, []);
  assert.equal(absentResult.sourceMediaInfo, undefined);
});

test('null source media info produces no metadata and no warning', async () => {
  const { bridge, calls } = makeBridge({
    ffmpegGetSourceMediaInfo: () => null,
  });
  const { deps, snapshots, warnings } = recordingDeps(bridge);

  const prepared = await prepareMediaSession(
    { sourceFile: '/media/talk.m4a', sourceFileName: 'talk.m4a', config: CONFIG, chunking: FIXED_CHUNKING },
    deps,
  );

  assert.deepEqual(callsOf(calls, 'ffmpegGetSourceMediaInfo'), [
    ['ffmpegGetSourceMediaInfo', { inputPath: '/media/talk.m4a', durationSec: 300 }],
  ]);
  assert.equal(prepared.sourceMediaInfo, undefined);
  assert.deepEqual(warnings, []);
  assert.equal(snapshots.at(-1).progress, 100);
});
