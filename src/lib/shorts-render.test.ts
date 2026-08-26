import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildShortsAssSubtitle,
  buildVerticalVideoFilter,
  buildVerticalVideoFilterGraph,
  crfForShortsQuality,
  defaultShortsSubtitleStyle,
  extensionForShortsFormat,
  fpsForShortsQuality,
  resolveShortsSubtitleStyle,
  SHORTS_SUBTITLE_PRESETS,
  verticalResolutionForPreset,
} from './shorts-render';

test('buildVerticalVideoFilter creates 9:16 contain frame with background and pan offsets', () => {
  const filter = buildVerticalVideoFilter({
    outputWidth: 1080,
    outputHeight: 1920,
    zoom: 1.18,
    cropX: 0.5,
    cropY: 0.42,
    backgroundColor: '#CA9E3F',
  });

  assert.match(filter, /scale=/);
  assert.match(filter, /crop=w='min\(iw\\,1080\)'/);
  assert.match(filter, /pad=1080:1920/);
  assert.match(filter, /color=0xCA9E3F/);
  assert.match(filter, /setsar=1/);
});

test('buildVerticalVideoFilterGraph exports frame animation keyframes', () => {
  const filter = buildVerticalVideoFilterGraph({
    outputWidth: 1080,
    outputHeight: 1920,
    zoom: 1,
    cropX: 0.5,
    cropY: 0.5,
    frameKeyframes: [
      { id: 'a', time: 0, zoom: 0.75, x: -10, y: 0, backgroundColor: '#CA9E3F' },
      { id: 'b', time: 5, zoom: 1.2, x: 18, y: 4, backgroundColor: '#CA9E3F' },
    ],
  });

  assert.match(filter, /if\(lt\(t\\?,/);
  assert.match(filter, /0\.7500/);
  assert.match(filter, /1\.2000/);
  assert.match(filter, /color=c=0xCA9E3F/);
});

test('buildVerticalVideoFilterGraph builds a colored canvas with animated overlay', () => {
  const graph = buildVerticalVideoFilterGraph({
    outputWidth: 1080,
    outputHeight: 1920,
    zoom: 1,
    cropX: 0.5,
    cropY: 0.5,
    frameKeyframes: [
      { id: 'a', time: 0, zoom: 0.75, x: -10, y: 0, backgroundColor: '#CA9E3F' },
      { id: 'b', time: 5, zoom: 1.2, x: 18, y: 4, backgroundColor: '#CA9E3F' },
    ],
  });

  assert.match(graph, /color=c=0xCA9E3F:s=1080x1920/);
  assert.match(graph, /h='if\(gt\(a\\,0\.56250000\)\\,1920\*/);
  assert.match(graph, /overlay=x=/);
  assert.match(graph, /eval=frame/);
  assert.match(graph, /\[vbase\]/);
});

test('buildShortsAssSubtitle uses bold white text, orange box, and lower placement', () => {
  const ass = buildShortsAssSubtitle({
    cues: [{ startSec: 0, endSec: 2.5, text: 'TAKE SHELTER OF' }],
    width: 1080,
    height: 1920,
    bottomMargin: 560,
    style: SHORTS_SUBTITLE_PRESETS.orangeImpact,
  });

  assert.match(ass, /Style: Shorts/);
  assert.match(ass, /TAKE SHELTER OF/);
  assert.match(ass, /Style: Shorts,Cuprum,74/);
  assert.match(ass, /,1,3,0,5,0,0,0,1/);
  assert.match(ass, /Shorts,,0,0,0,,\{\\an5\\pos\(540,1314\)\\xshad0\.0\\yshad4\.0\}TAKE SHELTER OF/);
  assert.match(ass, /&H00FFFFFF/);
  assert.match(ass, /&H80008CFF/);
  assert.match(ass, / b 929 0 929 0 929 20 /);
});

test('buildShortsAssSubtitle supports configurable font, text color, box color, opacity, casing, outline, and shadow', () => {
  const ass = buildShortsAssSubtitle({
    cues: [{ startSec: 0, endSec: 2.5, text: 'take shelter of' }],
    width: 1080,
    height: 1920,
    bottomMargin: 420,
    style: {
      fontFamily: 'Cuprum',
      fontSize: 82,
      bold: true,
      textTransform: 'title',
      textColor: '#FFF7E6',
      boxColor: '#F59E0B',
      boxOpacity: 0.66,
      boxWidth: 80,
      boxHeight: 1.15,
      edgeBlur: 3,
      letterSpacing: 1.5,
      lineSpacing: 1,
      edgeSoftness: 0.55,
      outline: 2.5,
      outlineColor: '#FF0000',
      outlineOpacity: 0.8,
      shadow: 5,
      shadowColor: '#00FF00',
      shadowOpacity: 0.5,
      shadowAngle: 45,
      shadowDistance: 8,
      shadowBlur: 4,
    },
  });

  assert.match(ass, /Style: Shorts,Cuprum,82/);
  // Outline width = 3 (rounded 2.5), Shadow = 0 (since it is written inside cue line overrides)
  assert.match(ass, /,100,100,1\.50,0,1,3,0,5,/);
  // Outline colour: Red (#FF0000) with 0.8 opacity -> &H330000FF (alpha = (1 - 0.8) * 255 = 51 = 0x33, BB=00, GG=00, RR=FF)
  // Shadow colour: Green (#00FF00) with 0.5 opacity -> &H8000FF00 (alpha = (1 - 0.5) * 255 = 128 = 0x80, BB=00, GG=FF, RR=00)
  assert.match(ass, /&H330000FF,&H8000FF00/);
  assert.match(ass, /\\xshad5\.7\\yshad5\.7/);
  assert.match(ass, /Style: ShortsBox/);
  assert.match(ass, /Take Shelter Of/);
});

test('buildShortsAssSubtitle wraps export text with the same line limits used by the visual preview', () => {
  const ass = buildShortsAssSubtitle({
    cues: [{ startSec: 0, endSec: 2.5, text: 'WE CAME ACROSS THE WORK OF A PERSON' }],
    width: 1080,
    height: 1920,
    bottomMargin: 560,
    maxCharsPerLine: 24,
    maxLines: 2,
    style: SHORTS_SUBTITLE_PRESETS.orangeImpact,
  });

  assert.match(ass, /WE CAME ACROSS THE WORK\\NOF A PERSON/);
});

test('buildShortsAssSubtitle preserves manual visual editor line breaks', () => {
  const ass = buildShortsAssSubtitle({
    cues: [{ startSec: 0, endSec: 2.5, text: 'WE CAME ACROSS\nTHE WORK OF A PERSON' }],
    width: 1080,
    height: 1920,
    bottomMargin: 560,
    maxCharsPerLine: 12,
    maxLines: 2,
    style: SHORTS_SUBTITLE_PRESETS.orangeImpact,
  });

  assert.match(ass, /WE CAME ACROSS\\NTHE WORK OF A PERSON/);
});

test('verticalResolutionForPreset chooses real shorts export sizes', () => {
  assert.deepEqual(verticalResolutionForPreset('1080p', { width: 1920, height: 1080 }), { width: 1080, height: 1920 });
  assert.deepEqual(verticalResolutionForPreset('2k', { width: 2560, height: 1440 }), { width: 1440, height: 2560 });
  assert.deepEqual(verticalResolutionForPreset('4k', { width: 3840, height: 2160 }), { width: 2160, height: 3840 });
});

test('source-based resolution keeps the source quality class for vertical exports', () => {
  assert.deepEqual(verticalResolutionForPreset('source', { width: 3840, height: 2160 }), { width: 2160, height: 3840 });
  assert.deepEqual(verticalResolutionForPreset('source', { width: 2560, height: 1440 }), { width: 1440, height: 2560 });
  assert.deepEqual(verticalResolutionForPreset('source', { width: 1920, height: 1080 }), { width: 1080, height: 1920 });
  assert.deepEqual(verticalResolutionForPreset('source', { width: 1280, height: 720 }), { width: 1080, height: 1920 });
});

test('export format and quality helpers map to predictable output options', () => {
  assert.equal(extensionForShortsFormat('mp4'), '.mp4');
  assert.equal(extensionForShortsFormat('mov'), '.mov');
  assert.equal(crfForShortsQuality('high'), 18);
  assert.equal(crfForShortsQuality('balanced'), 20);
  assert.equal(crfForShortsQuality('compact'), 24);
  assert.equal(fpsForShortsQuality('compact'), 24);
  assert.equal(fpsForShortsQuality('balanced'), 30);
  assert.equal(fpsForShortsQuality('high'), 30);
});
test('O2-SHT-06 render style is plan-owned and missing styles use a deterministic built-in', () => {
  const cues = [{ startSec: 0, endSec: 2, text: 'Plan caption' }];
  const styleA = resolveShortsSubtitleStyle({
    fontFamily: 'Cuprum',
    fontSize: 72,
    boxColor: '#FF8C00',
    subtitleBottomMargin: 560,
  });
  const styleB = resolveShortsSubtitleStyle({
    fontFamily: 'Inter',
    fontSize: 52,
    boxColor: '#0000FF',
    subtitleBottomMargin: 420,
  });
  const renderedA = buildShortsAssSubtitle({
    cues,
    width: 1080,
    height: 1920,
    bottomMargin: styleA.subtitleBottomMargin ?? 0,
    style: styleA,
  });
  const renderedB = buildShortsAssSubtitle({
    cues,
    width: 1080,
    height: 1920,
    bottomMargin: styleB.subtitleBottomMargin ?? 0,
    style: styleB,
  });
  assert.notEqual(renderedA, renderedB);
  assert.equal(
    buildShortsAssSubtitle({
      cues,
      width: 1080,
      height: 1920,
      bottomMargin: styleA.subtitleBottomMargin ?? 0,
      style: styleA,
    }),
    renderedA,
  );

  const missingA = defaultShortsSubtitleStyle();
  const missingB = defaultShortsSubtitleStyle();
  assert.deepEqual(missingA, missingB);
  assert.equal(missingA.fontFamily, 'Cuprum');
  assert.equal(missingA.subtitleBottomMargin, 560);
});
