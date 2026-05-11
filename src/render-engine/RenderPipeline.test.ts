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
