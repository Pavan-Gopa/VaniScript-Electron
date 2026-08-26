'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildCompositionHtml,
  buildMediaSegmentsFilter,
  recommendedWorkers,
  proxyVideoRateForProject,
  shouldUsePrecomputedBlurProxy,
  renderShortClipWithHyperFrames,
} = require('./hyperframes-renderer');

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
  assert.match(html, /@import url\('https:\/\/fonts\.googleapis\.com\/css2\?family=Inter/);
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

test('buildCompositionHtml carries visual editor background guide and scaled logo settings', () => {
  const html = buildCompositionHtml({
    id: 'clip-visual-fidelity',
    title: 'Clip visual fidelity',
    sourceWidth: 3840,
    sourceHeight: 2160,
    width: 2160,
    height: 3840,
    fps: 24,
    clipStartSec: 0,
    durationSec: 5,
    subtitles: [{ id: 'cue-1', startSec: 0, endSec: 2, text: 'Visual match' }],
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
    backgroundSettings: {
      effectReferenceHeight: 960,
      solidEnabled: true,
      solidColor: '#CA9E3F',
      blurEnabled: true,
      blurStrength: 40,
      blurScale: 1.45,
      gradientEnabled: false,
      gradientType: 'linear',
      gradientColorA: '#000000',
      gradientColorB: '#111111',
      gradientAngle: 180,
      gradientOpacity: 0.6,
      featherEnabled: true,
      featherTop: 56,
      featherBottom: 72,
      featherLeft: 12,
      featherRight: 18,
      frameGuideColor: '#CA9E3F',
      frameGuideOpacity: 0.66,
      frameGuideBorderWidth: 3,
      frameGuideBlur: 22,
      frameGuideBorderOpacity: 0.8,
    },
    logo: {
      id: 'logo-1',
      src: './logo.png',
      name: 'Logo',
      size: 1.4,
      opacity: 0.42,
      position: 'top-left',
    },
  }, './assets/source.mp4');

  assert.match(html, /id="frame-guide-overlay"/);
  assert.match(html, /id="feather-overlay"/);
  assert.match(html, /frameGuideBlur/);
  assert.match(html, /frameGuideBorderWidth/);
  assert.match(html, /frameGuideBorderOpacity/);
  assert.match(html, /const effectScale = project\.height \/ Math\.max\(1, Number\(bgS\.effectReferenceHeight\) \|\| 960\);/);
  assert.match(html, /\(bgS\.blurStrength \|\| 30\) \* effectScale/);
  assert.match(html, /Number\(bgS\.featherTop\) \|\| 0\) \* effectScale/);
  assert.match(html, /Number\(bgS\.frameGuideBlur\) \|\| 0\) \* effectScale/);
  assert.match(html, /videoStage\.style\.maskImage = mask;/);
  assert.match(html, /videoStage\.style\.transform = 'translate\(-50%, -50%\) translate\('/);
  assert.match(html, /video\.style\.transform = 'none';/);
  assert.match(html, /featherOverlay\.style\.background = featherGradients\.join\(', '\);/);
  assert.match(html, /const renderScale = project\.height \/ 1920;/);
  assert.match(html, /logoOverlay\.style\.width = \(120 \* renderScale \* \(project\.logo\.size \|\| 1\)\) \+ 'px';/);
  assert.match(html, /const margin = 40 \* renderScale;/);
  assert.match(html, /logoOverlay\.style\.opacity = String\(project\.logo\.opacity \?\? 1\);/);
  assert.match(html, /<video id="blur-video" class="clip"[\s\S]*data-track-index="2"/);
  assert.match(html, /<img id="blur-static" style="display: none;" \/>/);
  assert.match(html, /blurVideo\.currentTime = videoTime;/);
  assert.match(html, /blurStatic\.dataset\.currentSrc !== staticSrc/);
  assert.doesNotMatch(html, /__render_frame_source-video__/);
});

test('buildCompositionHtml can use a precomputed blur background proxy', () => {
  const html = buildCompositionHtml({
    id: 'clip-preblur',
    title: 'Clip preblur',
    sourceWidth: 3840,
    sourceHeight: 2160,
    width: 2160,
    height: 3840,
    fps: 24,
    clipStartSec: 120,
    durationSec: 5,
    subtitles: [{ id: 'cue-1', startSec: 0, endSec: 2, text: 'Visual match' }],
    captionStyle: { fontFamily: 'Cuprum', fontSize: 84 },
    subtitleBottomMargin: 420,
    frameKeyframes: [{ id: 'frame-0', time: 0, x: 0, y: 0, zoom: 1, backgroundColor: '#CA9E3F' }],
    backgroundSettings: {
      blurEnabled: true,
      blurStrength: 40,
      blurScale: 1.45,
      effectReferenceHeight: 960,
    },
  }, './assets/source.mp4', './assets/blur-background.mp4');

  assert.match(html, /id="blur-video"[\s\S]*data-media-start="0"[\s\S]*src="\.\/assets\/blur-background\.mp4"/);
  assert.match(html, /const blurPrecomputed = true;/);
  assert.match(html, /el\.style\.filter = 'none';/);
  assert.match(html, /el\.style\.transform = 'none';/);
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

test('recommendedWorkers keeps enough 4K frame capture concurrency', () => {
  assert.equal(recommendedWorkers({ width: 2160, height: 3840 }, 'high'), 4);
  assert.ok(recommendedWorkers({ width: 1080, height: 1920 }, 'standard') >= 2);
});

test('proxyVideoRateForProject keeps 4K browser-safe proxies visually usable', () => {
  assert.deepEqual(
    proxyVideoRateForProject({ width: 2160, height: 3840, sourceWidth: 3840, sourceHeight: 2160 }),
    { bitrate: '32M', maxrate: '48M', bufsize: '96M' },
  );
  assert.deepEqual(
    proxyVideoRateForProject({ width: 1080, height: 1920, sourceWidth: 1920, sourceHeight: 1080 }),
    { bitrate: '12M', maxrate: '18M', bufsize: '36M' },
  );
});

test('precomputed blur proxy is disabled for standard and high fidelity exports', () => {

  assert.equal(shouldUsePrecomputedBlurProxy('standard'), false);
  assert.equal(shouldUsePrecomputedBlurProxy('high'), false);
  assert.equal(shouldUsePrecomputedBlurProxy('compact'), true);
});
test('required static-frame extraction surfaces STATIC_FRAME_FAILED for Main cleanup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaniscript-renderer-s4-'));
  const userData = path.join(root, 'user-data');
  const runtimeChildDir = path.join(root, 'runtime-child');
  const sourcePath = path.join(root, 'source.mp4');
  const ffmpegPath = path.join(root, 'fake-ffmpeg.js');
  const progress = [];
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(sourcePath, 'source placeholder');
  fs.writeFileSync(ffmpegPath, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const output = process.argv.at(-1);
if (output.endsWith('intro-bg.jpg') || output.endsWith('outro-bg.jpg')) {
  process.stderr.write('intentional static frame failure');
  process.exit(7);
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, Buffer.alloc(2048, 7));
`);
  fs.chmodSync(ffmpegPath, 0o755);

  try {
    await assert.rejects(
      renderShortClipWithHyperFrames({
        app: { getPath: () => userData },
        project: {
          id: 'static-frame-required',
          title: 'Static frame required',
          inputVideoSrc: 'file:///fixture-assets/source.mp4',
          sourceWidth: 1920,
          sourceHeight: 1080,
          width: 1080,
          height: 1920,
          fps: 30,
          clipStartSec: 0,
          clipEndSec: 4,
          durationSec: 4,
          durationInFrames: 120,
          subtitles: [],
          captionStyle: {},
          subtitleBottomMargin: 96,
          frameKeyframes: [],
          mediaSegments: [],
          backgroundSettings: {
            blurEnabled: true,
            effectReferenceHeight: 960,
          },
          intro: {
            id: 'intro',
            duration: 1,
            hidden: false,
          },
          outro: {
            id: 'outro',
            duration: 1,
            hidden: true,
          },
        },
        inputVideoPath: sourcePath,
        outputPath: path.join(root, 'output.partial.mp4'),
        format: 'mp4',
        qualityPreset: 'balanced',
        ffmpegPath,
        log: { info() {}, warn() {}, error() {} },
        abortSignal: new AbortController().signal,
        onProgress: (event) => progress.push(event),
        runtimeChildDir,
      }),
      (error) => {
        assert.equal(error.code, 'STATIC_FRAME_FAILED');
        assert.equal(error.errorCode, 'STATIC_FRAME_FAILED');
        return true;
      },
    );

    assert.equal(progress.some((event) => event.stage === 'proxy'), true);
    assert.equal(fs.existsSync(runtimeChildDir), true);
    assert.equal(fs.readdirSync(runtimeChildDir).length > 0, true);
    assert.equal(fs.existsSync(path.join(userData, 'HyperFramesRuntime')), false);

    // Main owns the settle boundary: the renderer leaves the child available
    // for the coordinator's injected cleanup seam.
    fs.rmSync(runtimeChildDir, { recursive: true, force: true });
    assert.equal(fs.existsSync(runtimeChildDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('empty required static-frame output surfaces STATIC_FRAME_FAILED', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaniscript-renderer-s4-empty-'));
  const userData = path.join(root, 'user-data');
  const runtimeChildDir = path.join(root, 'runtime-child');
  const sourcePath = path.join(root, 'source.mp4');
  const ffmpegPath = path.join(root, 'fake-ffmpeg-empty.js');
  const progress = [];
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(sourcePath, 'source placeholder');
  fs.writeFileSync(ffmpegPath, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const output = process.argv.at(-1);
fs.mkdirSync(path.dirname(output), { recursive: true });
if (output.endsWith('intro-bg.jpg') || output.endsWith('outro-bg.jpg')) {
  fs.writeFileSync(output, Buffer.alloc(0));
} else {
  fs.writeFileSync(output, Buffer.alloc(2048, 7));
}
`);
  fs.chmodSync(ffmpegPath, 0o755);

  try {
    await assert.rejects(
      renderShortClipWithHyperFrames({
        app: { getPath: () => userData },
        project: {
          id: 'empty-static-frame',
          title: 'Empty static frame',
          inputVideoSrc: 'file:///fixture-assets/source.mp4',
          sourceWidth: 1920,
          sourceHeight: 1080,
          width: 1080,
          height: 1920,
          fps: 30,
          clipStartSec: 0,
          clipEndSec: 4,
          durationSec: 4,
          durationInFrames: 120,
          subtitles: [],
          captionStyle: {},
          subtitleBottomMargin: 96,
          frameKeyframes: [],
          mediaSegments: [],
          backgroundSettings: {
            blurEnabled: true,
            effectReferenceHeight: 960,
          },
          intro: {
            id: 'intro',
            duration: 1,
            hidden: false,
          },
        },
        inputVideoPath: sourcePath,
        outputPath: path.join(root, 'output.partial.mp4'),
        format: 'mp4',
        qualityPreset: 'balanced',
        ffmpegPath,
        log: { info() {}, warn() {}, error() {} },
        abortSignal: new AbortController().signal,
        onProgress: (event) => progress.push(event),
        runtimeChildDir,
      }),
      (error) => {
        assert.equal(error.code, 'STATIC_FRAME_FAILED');
        assert.equal(error.errorCode, 'STATIC_FRAME_FAILED');
        assert.match(error.message, /not created/);
        return true;
      },
    );

    assert.equal(fs.existsSync(runtimeChildDir), true);
    assert.equal(fs.readdirSync(runtimeChildDir).length > 0, true);
    assert.equal(progress.some((event) => event.stage === 'proxy'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
