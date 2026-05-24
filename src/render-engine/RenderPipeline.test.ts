import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRenderMediaSegments,
  buildShortsRenderProject,
  interpolateFrameState,
  normalizeRenderSubtitles,
} from './RenderPipeline';

test('interpolateFrameState eases pan and zoom between keyframes', () => {
  const state = interpolateFrameState([
    { id: 'a', time: 0, x: 0, y: 0, zoom: 1, backgroundColor: '#111111' },
    { id: 'b', time: 10, x: 20, y: -10, zoom: 1.5, backgroundColor: '#222222' },
  ], 5);

  assert.equal(state.x, 10);
  assert.equal(state.y, -5);
  assert.equal(state.zoom, 1.25);
  assert.equal(state.backgroundColor, '#111111');
});

test('normalizeRenderSubtitles preserves manual line breaks and clamps cue times', () => {
  const cues = normalizeRenderSubtitles([
    { startSec: -2, endSec: 4, text: 'first\nline' },
    { startSec: 6, endSec: 18, text: 'second line' },
  ], 10);

  assert.deepEqual(cues, [
    { id: 'cue_0', startSec: 0, endSec: 4, text: 'first\nline' },
    { id: 'cue_1', startSec: 6, endSec: 10, text: 'second line' },
  ]);
});

test('buildShortsRenderProject stores editor style and timeline as render source of truth', () => {
  const project = buildShortsRenderProject({
    id: 'clip-1-target',
    title: 'Clip',
    inputVideoSrc: 'file:///tmp/video.mov',
    sourceWidth: 1920,
    sourceHeight: 1080,
    clipStartSec: 12,
    clipEndSec: 18,
    outputWidth: 1080,
    outputHeight: 1920,
    fps: 30,
    cues: [{ startSec: 0, endSec: 2, text: 'Hare Krishna' }],
    frameKeyframes: [{ id: 'frame', time: 0, x: 5, y: -2, zoom: 0.8, backgroundColor: '#CA9E3F' }],
    style: {
      fontFamily: 'Cuprum',
      fontSize: 96,
      bold: true,
      textTransform: 'uppercase',
      textColor: '#FFFFFF',
      boxColor: '#FF8C00',
      boxOpacity: 0.5,
      boxWidth: 86,
      boxHeight: 1,
      edgeBlur: 8,
      letterSpacing: 0,
      lineSpacing: 1.05,
      edgeSoftness: 0.25,
      outline: 0,
      shadow: 4,
    },
    subtitleBottomMargin: 560,
  });

  assert.equal(project.width, 1080);
  assert.equal(project.height, 1920);
  assert.equal(project.sourceWidth, 1920);
  assert.equal(project.sourceHeight, 1080);
  assert.equal(project.durationInFrames, 180);
  assert.equal(project.subtitles[0].text, 'Hare Krishna');
  assert.equal(project.captionStyle.fontFamily, 'Cuprum');
  assert.equal(project.frameKeyframes[0].backgroundColor, '#CA9E3F');
  assert.deepEqual(project.mediaSegments, [{
    sourceStartSec: 12,
    sourceEndSec: 18,
    outputStartSec: 0,
    outputEndSec: 6,
  }]);
});

test('buildRenderMediaSegments applies edge trim and razor cuts in source order', () => {
  assert.deepEqual(buildRenderMediaSegments(100, 120, [
    { startSec: 6, endSec: 8 },
  ], { trimStartSec: 2, trimEndSec: 3 }), [
    { sourceStartSec: 102, sourceEndSec: 106, outputStartSec: 0, outputEndSec: 4 },
    { sourceStartSec: 108, sourceEndSec: 117, outputStartSec: 4, outputEndSec: 13 },
  ]);
});

test('buildShortsRenderProject shifts cues and keyframes for trim while exporting cut media segments', () => {
  const project = buildShortsRenderProject({
    id: 'clip-trim-cut',
    title: 'Clip',
    inputVideoSrc: 'file:///tmp/video.mov',
    sourceWidth: 1920,
    sourceHeight: 1080,
    clipStartSec: 100,
    clipEndSec: 120,
    outputWidth: 1080,
    outputHeight: 1920,
    fps: 24,
    cues: [{ startSec: 2.5, endSec: 5, text: 'Trimmed cue' }],
    frameKeyframes: [{ id: 'frame', time: 3, x: 5, y: -2, zoom: 0.8, backgroundColor: '#CA9E3F' }],
    timelineTrim: { trimStartSec: 2, trimEndSec: 3 },
    timelineCuts: [{ startSec: 6, endSec: 8 }],
    style: {
      fontFamily: 'Cuprum',
      fontSize: 96,
      bold: true,
      textTransform: 'uppercase',
      textColor: '#FFFFFF',
      boxColor: '#FF8C00',
      boxOpacity: 0.5,
      boxWidth: 86,
      boxHeight: 1,
      edgeBlur: 8,
      letterSpacing: 0,
      lineSpacing: 1.05,
      edgeSoftness: 0.25,
      outline: 0,
      shadow: 4,
    },
    subtitleBottomMargin: 560,
  });

  assert.equal(project.durationSec, 13);
  assert.equal(project.durationInFrames, 312);
  assert.deepEqual(project.mediaSegments, [
    { sourceStartSec: 102, sourceEndSec: 106, outputStartSec: 0, outputEndSec: 4 },
    { sourceStartSec: 108, sourceEndSec: 117, outputStartSec: 4, outputEndSec: 13 },
  ]);
  assert.deepEqual(project.subtitles, [{ id: 'cue_0', startSec: 0.5, endSec: 3, text: 'Trimmed cue' }]);
  assert.equal(project.frameKeyframes[0].time, 0);
  assert.equal(project.frameKeyframes[1].time, 1);
});

test('buildShortsRenderProject preserves intro and outro overlay settings including speed', () => {
  const project = buildShortsRenderProject({
    id: 'clip-overlays',
    title: 'Clip',
    inputVideoSrc: 'file:///tmp/video.mov',
    clipStartSec: 0,
    clipEndSec: 10,
    outputWidth: 1080,
    outputHeight: 1920,
    fps: 30,
    cues: [],
    style: { fontFamily: 'Cuprum', fontSize: 96, bold: true, textTransform: 'uppercase', textColor: '#FFFFFF', boxColor: '#FF8C00', boxOpacity: 0.5, boxWidth: 86, boxHeight: 1, edgeBlur: 8, letterSpacing: 0, lineSpacing: 1.05, edgeSoftness: 0.25, outline: 0, shadow: 4 },
    subtitleBottomMargin: 560,
    intro: {
      id: 'intro-1',
      src: 'data:image/png;base64,intro',
      duration: 3,
      x: 50,
      y: 50,
      scale: 1.2,
      animation: 'pulse',
      speed: 1.5,
    },
    outro: {
      id: 'outro-1',
      src: 'data:image/png;base64,outro',
      duration: 2.5,
      x: 50,
      y: 40,
      scale: 0.8,
      animation: 'bounce',
      speed: 0.5,
    },
  });

  assert.ok(project.intro);
  assert.equal(project.intro?.id, 'intro-1');
  assert.equal(project.intro?.speed, 1.5);
  assert.equal(project.intro?.scale, 1.2);

  assert.ok(project.outro);
  assert.equal(project.outro?.id, 'outro-1');
  assert.equal(project.outro?.speed, 0.5);
  assert.equal(project.outro?.y, 40);
});

test('buildShortsRenderProject shifts media, cues, keyframes, and track events by intro duration and extends total duration', () => {
  const project = buildShortsRenderProject({
    id: 'clip-shifting',
    title: 'Clip',
    inputVideoSrc: 'file:///tmp/video.mov',
    clipStartSec: 10,
    clipEndSec: 20,
    outputWidth: 1080,
    outputHeight: 1920,
    fps: 30,
    cues: [{ startSec: 2, endSec: 4, text: 'Hello' }],
    style: { fontFamily: 'Cuprum', fontSize: 96, bold: true, textTransform: 'uppercase', textColor: '#FFFFFF', boxColor: '#FF8C00', boxOpacity: 0.5, boxWidth: 86, boxHeight: 1, edgeBlur: 8, letterSpacing: 0, lineSpacing: 1.05, edgeSoftness: 0.25, outline: 0, shadow: 4 },
    subtitleBottomMargin: 560,
    timelineTrim: { trimStartSec: 1, trimEndSec: 2 },
    intro: {
      id: 'intro-1',
      src: 'data:image/png;base64,intro',
      duration: 3,
      x: 50,
      y: 50,
      scale: 1.2,
      animation: 'pulse',
      speed: 1.0,
    },
    outro: {
      id: 'outro-1',
      src: 'data:image/png;base64,outro',
      duration: 4,
      x: 50,
      y: 50,
      scale: 1.2,
      animation: 'pulse',
      speed: 1.0,
    },
    audioTracks: [
      { id: 'audio-1', name: 'audio', src: 'audio.mp3', startSec: 5, trimStartSec: 0, trimEndSec: 0, volume: 1, fadeInSec: 0, fadeOutSec: 0 }
    ],
    textTracks: [
      {
        id: 'text-track-1',
        name: 'text',
        blocks: [{ id: 'block-1', startSec: 4, endSec: 6, text: 'Text block' }]
      }
    ]
  });

  // Trim start = 1, Trim end = 2. Original duration = 10. Trimmed duration = 10 - 1 - 2 = 7.
  // Intro duration = 3, Outro duration = 4.
  // Total duration = 3 (intro) + 7 (trimmed) + 4 (outro) = 14.
  assert.equal(project.durationSec, 14);

  // Media segments should be shifted by introDuration (3)
  assert.deepEqual(project.mediaSegments, [{
    sourceStartSec: 11, // clipStartSec (10) + trimStartSec (1)
    sourceEndSec: 18,   // clipStartSec (10) + (clipDurationSec (10) - trimEndSec (2))
    outputStartSec: 3,  // starts after intro (3)
    outputEndSec: 10,   // lasts for trimmed duration (7)
  }]);

  // Cues should be shifted by: startSec - trimStartSec (1) + introDuration (3) = startSec + 2
  // Hello original: [2, 4] -> shifted: [4, 6]
  assert.equal(project.subtitles[0].startSec, 4);
  assert.equal(project.subtitles[0].endSec, 6);

  // Audio tracks should be shifted by: startSec - trimStartSec (1) + introDuration (3) = startSec + 2
  // Original startSec: 5 -> shifted: 7
  assert.ok(project.audioTracks);
  assert.equal(project.audioTracks?.[0]?.startSec, 7);

  // Text tracks blocks should be shifted by: startSec - trimStartSec (1) + introDuration (3) = startSec + 2
  // Original startSec: 4 -> shifted: 6
  assert.ok(project.textTracks);
  assert.equal(project.textTracks?.[0]?.blocks?.[0]?.startSec, 6);
  assert.equal(project.textTracks?.[0]?.blocks?.[0]?.endSec, 8);

  // Frame keyframes should include introFrame at time 0, baseFrame at time introDuration (3)
  assert.equal(project.frameKeyframes[0].time, 0);
  assert.equal(project.frameKeyframes[0].id, 'frame_intro_start');
  assert.equal(project.frameKeyframes[1].time, 3);
  assert.equal(project.frameKeyframes[1].id, 'frame_trim_start');
});
