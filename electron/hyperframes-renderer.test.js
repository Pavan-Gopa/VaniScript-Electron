'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCompositionHtml, buildMediaSegmentsFilter } = require('./hyperframes-renderer');

test('buildCompositionHtml emits the HyperFrames producer contract', () => {
  const html = buildCompositionHtml({
    id: 'clip-1',
    title: 'Clip 1',
    sourceWidth: 1920,
    sourceHeight: 1080,
    width: 1080,
    height: 1920,
    fps: 30,
    clipStartSec: 12,
    durationSec: 5,
    subtitles: [{ id: 'cue-1', startSec: 0, endSec: 2, text: 'Hello world' }],
    captionStyle: {
      fontFamily: 'Cuprum',
      fontSize: 84,
      bold: true,
      textTransform: 'uppercase',
      textColor: '#FFFFFF',
      boxColor: '#FF8C00',
      boxOpacity: 0.5,
      boxWidth: 92,
      boxHeight: 1.1,
      edgeBlur: 8,
      letterSpacing: 0,
      lineSpacing: 1.05,
      edgeSoftness: 0.3,
      outline: 0,
      shadow: 4,
    },
    subtitleBottomMargin: 420,
    frameKeyframes: [{ id: 'frame-0', time: 0, x: 0, y: 0, zoom: 1, backgroundColor: '#CA9E3F' }],
  }, './assets/source.mp4');

  assert.match(html, /<meta data-composition-id="vaniscript-short" data-width="1080" data-height="1920" \/>/);
  assert.match(html, /<script src="\.\/assets\/gsap\.min\.js"><\/script>/);
  assert.match(html, /@font-face[\s\S]*font-family: 'Cuprum'/);
  assert.match(html, /url\(\.\/assets\/fonts\/cuprum\/files\//);
  assert.match(html, /<video[\s\S]*id="source-video"[\s\S]*data-media-start="12"/);
  assert.match(html, /<audio[\s\S]*id="source-audio"[\s\S]*data-media-start="12"/);
  assert.match(html, /const paddingY = fontSize \* 0\.12 \* style\.boxHeight;/);
  assert.match(html, /const paddingX = paddingY \* 1\.45;/);
  assert.match(html, /<div id="subtitle-layer"><span id="subtitle-text"><\/span><\/div>/);
  const subtitleLayerCss = html.match(/#subtitle-layer \{([\s\S]*?)\n      \}/)?.[1] || '';
  const subtitleTextCss = html.match(/#subtitle-text \{([\s\S]*?)\n      \}/)?.[1] || '';
  assert.doesNotMatch(subtitleLayerCss, /white-space: pre-wrap;/);
  assert.match(subtitleTextCss, /white-space: pre-wrap;/);
  assert.match(html, /window\.__timelines = window\.__timelines \|\| \{\};/);
  assert.match(html, /window\.__timelines\['vaniscript-short'\] = tl;/);
  assert.doesNotMatch(html, /window\.__hf\s*=/);
});

test('buildMediaSegmentsFilter concats trim and razor-safe media segments', () => {
  const filter = buildMediaSegmentsFilter([
    { sourceStartSec: 102, sourceEndSec: 106, outputStartSec: 0, outputEndSec: 4 },
    { sourceStartSec: 108, sourceEndSec: 117, outputStartSec: 4, outputEndSec: 13 },
  ], "scale='min(1080,iw)':-2:flags=lanczos");

  assert.match(filter, /\[0:v\]trim=start=102\.000:end=106\.000,setpts=PTS-STARTPTS\[v0\]/);
  assert.match(filter, /\[0:a\]atrim=start=108\.000:end=117\.000,asetpts=PTS-STARTPTS\[a1\]/);
  assert.match(filter, /\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1\[vcat\]\[aout\]/);
  assert.match(filter, /\[vcat\]scale='min\(1080,iw\)':-2:flags=lanczos\[vout\]/);
});
