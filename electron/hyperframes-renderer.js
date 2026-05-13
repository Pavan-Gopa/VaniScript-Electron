'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function smoothstep(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - (2 * t));
}

function hexToRgba(hex, opacity) {
  const clean = String(hex || '#000000').replace('#', '').padEnd(6, '0').slice(0, 6);
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${clamp(opacity, 0, 1)})`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function asJsonScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function toSafeFilePart(value) {
  return String(value || 'clip')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'clip';
}

function readFontsourceCss(packageName, cssFileName, relativeFilesPath) {
  try {
    const packageRoot = path.dirname(require.resolve(`${packageName}/package.json`));
    return fs.readFileSync(path.join(packageRoot, cssFileName), 'utf8')
      .replaceAll('font-display: swap;', 'font-display: block;')
      .replaceAll('url(./files/', `url(${relativeFilesPath}/`);
  } catch (_error) {
    return '';
  }
}

function copyFontsourceFiles(packageName, targetDir) {
  try {
    const packageRoot = path.dirname(require.resolve(`${packageName}/package.json`));
    const sourceDir = path.join(packageRoot, 'files');
    if (fs.existsSync(sourceDir)) {
      fs.cpSync(sourceDir, targetDir, { recursive: true });
    }
  } catch (_error) {
    // Font files are an optional fidelity improvement. Browser fallback still renders.
  }
}

function fontFaceCssForProject(project) {
  const family = String(project?.captionStyle?.fontFamily || '').toLowerCase();
  if (family !== 'cuprum') return '';
  return [400, 500, 600, 700]
    .map((weight) => readFontsourceCss('@fontsource/cuprum', `${weight}.css`, './assets/fonts/cuprum/files'))
    .filter(Boolean)
    .join('\n');
}

function normalizeProject(project) {
  const frameKeyframes = Array.isArray(project.frameKeyframes) && project.frameKeyframes.length > 0
    ? project.frameKeyframes
    : [{
        id: 'frame_default',
        time: 0,
        x: 0,
        y: 0,
        zoom: 1,
        backgroundColor: '#000000',
      }];

  const mediaSegments = (project.mediaSegments || [])
    .map((segment) => ({
      sourceStartSec: Math.max(0, Number(segment.sourceStartSec) || 0),
      sourceEndSec: Math.max(0, Number(segment.sourceEndSec) || 0),
      outputStartSec: Math.max(0, Number(segment.outputStartSec) || 0),
      outputEndSec: Math.max(0, Number(segment.outputEndSec) || 0),
    }))
    .filter((segment) => segment.sourceEndSec > segment.sourceStartSec + 0.01)
    .sort((a, b) => a.outputStartSec - b.outputStartSec);

  return {
    ...project,
    mediaSegments,
    frameKeyframes: frameKeyframes
      .map((frame) => ({
        id: frame.id,
        time: Math.max(0, Number(frame.time) || 0),
        x: clamp(Number(frame.x) || 0, -100, 100),
        y: clamp(Number(frame.y) || 0, -100, 100),
        zoom: clamp(Number(frame.zoom) || 1, 0.5, 3),
        backgroundColor: frame.backgroundColor || '#000000',
      }))
      .sort((a, b) => a.time - b.time),
    subtitles: (project.subtitles || [])
      .map((cue, index) => ({
        id: cue.id || `cue_${index}`,
        startSec: Math.max(0, Number(cue.startSec) || 0),
        endSec: Math.max(0.05, Number(cue.endSec) || 0.05),
        text: String(cue.text || ''),
      }))
      .filter((cue) => cue.text.trim() && cue.endSec > cue.startSec),
  };
}

function interpolateFrameState(keyframes, timeSec) {
  const sorted = Array.isArray(keyframes) ? keyframes : [];
  if (sorted.length === 0) {
    return {
      x: 0,
      y: 0,
      zoom: 1,
      backgroundColor: '#000000',
    };
  }
  if (sorted.length === 1 || timeSec <= sorted[0].time) return sorted[0];
  const last = sorted[sorted.length - 1];
  if (timeSec >= last.time) return last;
  const nextIndex = sorted.findIndex((point) => point.time >= timeSec);
  const from = sorted[Math.max(0, nextIndex - 1)];
  const to = sorted[nextIndex];
  const progress = smoothstep((timeSec - from.time) / Math.max(0.001, to.time - from.time));
  return {
    x: from.x + ((to.x - from.x) * progress),
    y: from.y + ((to.y - from.y) * progress),
    zoom: from.zoom + ((to.zoom - from.zoom) * progress),
    backgroundColor: from.backgroundColor || to.backgroundColor || '#000000',
  };
}

function mapQualityPreset(qualityPreset) {
  if (qualityPreset === 'compact') return 'draft';
  if (qualityPreset === 'high') return 'high';
  return 'standard';
}

function recommendedWorkers() {
  const cpuCount = Math.max(1, (os.cpus() || []).length);
  return Math.max(2, Math.min(8, cpuCount - 1));
}

function safeSymlinkOrCopy(srcPath, destPath) {
  try {
    fs.symlinkSync(srcPath, destPath);
  } catch (_error) {
    fs.copyFileSync(srcPath, destPath);
  }
}

function runFfmpeg(ffmpegPath, args, log) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      if (log) log.error('HyperFrames ffmpeg failed:', { code, args: args.join(' '), stderr });
      reject(new Error(stderr.trim() || stdout.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

async function createBrowserSafeProxy({
  sourcePath,
  project,
  ffmpegPath,
  assetsDir,
  log,
}) {
  const proxyPath = path.join(assetsDir, 'source-browser.mp4');
  const durationSec = Math.max(0.1, Number(project.durationSec) || 0.1);
  const clipStartSec = Math.max(0, Number(project.clipStartSec) || 0);
  const outputLongEdge = Math.max(Number(project.width) || 1080, Number(project.height) || 1920);
  const proxyMaxWidth = outputLongEdge >= 3840
    ? Number(project.sourceWidth) || 3840
    : outputLongEdge >= 2560
      ? Math.min(Number(project.sourceWidth) || 2560, 2560)
      : Math.min(Number(project.sourceWidth) || 1920, 1920);
  const scaleWidth = Math.max(2, Math.round(proxyMaxWidth / 2) * 2);
  const vf = `scale='min(${scaleWidth},iw)':-2:flags=lanczos`;
  const mediaSegments = Array.isArray(project.mediaSegments) ? project.mediaSegments : [];
  const singleSegment = mediaSegments.length === 1 ? mediaSegments[0] : null;
  const baseArgs = ['-y'];
  const inputArgs = singleSegment
    ? [
        '-ss', String(singleSegment.sourceStartSec),
        '-i', sourcePath,
        '-t', String(Math.max(0.1, singleSegment.sourceEndSec - singleSegment.sourceStartSec)),
        '-vf', vf,
      ]
    : mediaSegments.length > 1
      ? [
          '-i', sourcePath,
          '-filter_complex', buildMediaSegmentsFilter(mediaSegments, vf),
          '-map', '[vout]',
          '-map', '[aout]',
        ]
      : [
          '-ss', String(clipStartSec),
          '-i', sourcePath,
          '-t', String(durationSec),
          '-vf', vf,
        ];
  const outputArgs = [
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '320k',
  ];
  const hardwareArgs = process.platform === 'darwin'
    ? ['-c:v', 'h264_videotoolbox', '-allow_sw', '1', '-b:v', '8M', '-maxrate', '12M']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'];

  try {
    await runFfmpeg(ffmpegPath, [...baseArgs, ...inputArgs, ...outputArgs, ...hardwareArgs, proxyPath], log);
    return proxyPath;
  } catch (error) {
    if (process.platform !== 'darwin') throw error;
    log.warn('HyperFrames proxy hardware encode failed, retrying with libx264.', error.message || String(error));
    await runFfmpeg(ffmpegPath, [...baseArgs, ...inputArgs, ...outputArgs, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', proxyPath], log);
    return proxyPath;
  }
}

function buildMediaSegmentsFilter(mediaSegments, scaleFilter) {
  const normalized = mediaSegments
    .filter((segment) => segment.sourceEndSec > segment.sourceStartSec + 0.01)
    .sort((a, b) => a.outputStartSec - b.outputStartSec);
  const trimParts = [];
  const concatInputs = [];
  normalized.forEach((segment, index) => {
    const start = Number(segment.sourceStartSec).toFixed(3);
    const end = Number(segment.sourceEndSec).toFixed(3);
    trimParts.push(`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${index}]`);
    trimParts.push(`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${index}]`);
    concatInputs.push(`[v${index}][a${index}]`);
  });
  trimParts.push(`${concatInputs.join('')}concat=n=${normalized.length}:v=1:a=1[vcat][aout]`);
  trimParts.push(`[vcat]${scaleFilter}[vout]`);
  return trimParts.join(';');
}

function buildCompositionHtml(project, relativeVideoPath) {
  const sourceAspect = Math.max(0.1, project.sourceWidth / Math.max(1, project.sourceHeight));
  const stageWidth = Math.max(project.width, project.height * sourceAspect);
  const embeddedFonts = fontFaceCssForProject(project);
  const bg = project.backgroundSettings || {};
  const blurEnabled = !!bg.blurEnabled;
  const gradientEnabled = !!bg.gradientEnabled;

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=${project.width}, height=${project.height}, initial-scale=1" />
    <meta data-composition-id="vaniscript-short" data-width="${project.width}" data-height="${project.height}" />
    <title>${escapeHtml(project.title || 'VaniScript HyperFrames')}</title>
    <script src="./assets/gsap.min.js"><\/script>
    <style>
      ${embeddedFonts}
      :root {
        --canvas-width: ${project.width}px;
        --canvas-height: ${project.height}px;
        --stage-width: ${stageWidth}px;
      }
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        width: var(--canvas-width);
        height: var(--canvas-height);
        overflow: hidden;
        background: transparent;
        font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .clip { visibility: hidden; }
      #stage {
        position: relative;
        width: var(--canvas-width);
        height: var(--canvas-height);
        overflow: hidden;
        background: #000000;
      }
      #background { position: absolute; inset: 0; background: #000000; }
      #blur-bg {
        position: absolute; inset: 0; width: 100%; height: 100%;
        object-fit: cover; transform-origin: center; z-index: 0;
        display: ${blurEnabled ? 'block' : 'none'};
      }
      #gradient-overlay {
        position: absolute; inset: 0; z-index: 1; pointer-events: none;
        display: ${gradientEnabled ? 'block' : 'none'};
      }
      #video-stage {
        position: absolute; left: 50%; top: 50%;
        width: var(--stage-width); height: 100%;
        transform: translate(-50%, -50%);
        overflow: visible; z-index: 2;
      }
      #source-video {
        position: absolute; inset: 0; width: 100%; height: 100%;
        object-fit: contain; transform-origin: center center;
      }
      #subtitle-layer {
        position: absolute; left: 50%; transform: translateX(-50%);
        max-width: 100%; box-sizing: border-box; text-align: center;
        overflow: hidden; pointer-events: none; display: none; z-index: 3;
      }
      #subtitle-text {
        display: block; margin: 0;
        white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal;
      }
    </style>
  </head>
  <body>
    <div id="stage">
      <div id="background"></div>
      ${blurEnabled ? `<video id="blur-bg" class="clip" data-start="0" data-duration="${project.durationSec}" data-track-index="2" data-media-start="${project.clipStartSec}" muted playsinline preload="auto" src="${escapeHtml(relativeVideoPath)}"></video>` : '<div id="blur-bg"></div>'}
      <div id="gradient-overlay"></div>
      <div id="video-stage">
        <video
          id="source-video" class="clip"
          data-start="0" data-duration="${project.durationSec}"
          data-track-index="0" data-media-start="${project.clipStartSec}"
          muted playsinline preload="auto"
          src="${escapeHtml(relativeVideoPath)}"
        ></video>
        <audio
          id="source-audio"
          data-start="0" data-duration="${project.durationSec}"
          data-track-index="1" data-media-start="${project.clipStartSec}"
          data-volume="1" preload="auto"
          src="${escapeHtml(relativeVideoPath)}"
        ></audio>
      </div>
      <div id="subtitle-layer"><span id="subtitle-text"></span></div>
    </div>
    <script>
      const project = ${asJsonScript(project)};
      const stage = document.getElementById('stage');
      const background = document.getElementById('background');
      const blurBg = document.getElementById('blur-bg');
      const gradientOverlay = document.getElementById('gradient-overlay');
      const video = document.getElementById('source-video');
      const subtitleLayer = document.getElementById('subtitle-layer');
      const subtitleText = document.getElementById('subtitle-text');
      const bgS = project.backgroundSettings || {};

      const clamp = (v, mn, mx) => Math.min(Math.max(v, mn), mx);
      const smoothstep = (v) => { const t = clamp(v, 0, 1); return t * t * (3 - (2 * t)); };
      const hexToRgba = (hex, opacity) => {
        const c = String(hex || '#000000').replace('#', '').padEnd(6, '0').slice(0, 6);
        return 'rgba(' + parseInt(c.slice(0,2),16) + ',' + parseInt(c.slice(2,4),16) + ',' + parseInt(c.slice(4,6),16) + ',' + clamp(opacity,0,1) + ')';
      };
      const titleCase = (t) => t.toLowerCase().replace(/(^|\\s)\\S/g, (m) => m.toUpperCase());
      const transformText = (t, mode) => mode === 'uppercase' ? t.toUpperCase() : mode === 'title' ? titleCase(t) : t;
      const activeCue = (ts) => project.subtitles.find((c) => ts >= c.startSec && ts < c.endSec) || null;
      const interpolateFrameState = (ts) => {
        const kf = project.frameKeyframes || [];
        if (!kf.length) return { x: 0, y: 0, zoom: 1, backgroundColor: '#000000' };
        if (kf.length === 1 || ts <= kf[0].time) return kf[0];
        const last = kf[kf.length - 1];
        if (ts >= last.time) return last;
        const ni = kf.findIndex((p) => p.time >= ts);
        const from = kf[Math.max(0, ni - 1)];
        const to = kf[ni];
        const p = smoothstep((ts - from.time) / Math.max(0.001, to.time - from.time));
        return {
          x: from.x + ((to.x - from.x) * p),
          y: from.y + ((to.y - from.y) * p),
          zoom: from.zoom + ((to.zoom - from.zoom) * p),
          backgroundColor: from.backgroundColor || to.backgroundColor || '#000000',
        };
      };

      // Setup blur background
      if (bgS.blurEnabled && blurBg && blurBg.tagName === 'VIDEO') {
        blurBg.style.filter = 'blur(' + (bgS.blurStrength || 30) + 'px)';
        blurBg.style.transform = 'scale(' + (bgS.blurScale || 1.3) + ')';
      }
      // Setup gradient overlay
      if (bgS.gradientEnabled && gradientOverlay) {
        const gT = bgS.gradientType || 'linear';
        const gA = bgS.gradientColorA || '#000000';
        const gB = bgS.gradientColorB || '#1a1a2e';
        gradientOverlay.style.background = gT === 'radial'
          ? 'radial-gradient(ellipse at center,' + gA + ',' + gB + ')'
          : 'linear-gradient(' + (bgS.gradientAngle || 180) + 'deg,' + gA + ',' + gB + ')';
        gradientOverlay.style.opacity = String(bgS.gradientOpacity || 0.6);
      }
      // Setup feathering mask (top/bottom + left/right)
      if (bgS.featherEnabled) {
        const fT = bgS.featherTop || 0;
        const fB = bgS.featherBottom || 0;
        const fL = bgS.featherLeft || 0;
        const fR = bgS.featherRight || 0;
        const masks = [];
        if (fT > 0 || fB > 0) {
          masks.push('linear-gradient(to bottom, transparent 0px, black ' + fT + 'px, black calc(100% - ' + fB + 'px), transparent 100%)');
        }
        if (fL > 0 || fR > 0) {
          masks.push('linear-gradient(to right, transparent 0px, black ' + fL + 'px, black calc(100% - ' + fR + 'px), transparent 100%)');
        }
        if (masks.length > 0) {
          const combined = masks.join(', ');
          video.style.maskImage = combined;
          video.style.webkitMaskImage = combined;
          if (masks.length > 1) {
            video.style.maskComposite = 'intersect';
            video.style.webkitMaskComposite = 'source-in';
          }
        }
      }

      function renderAt(timeSec) {
        const frame = interpolateFrameState(timeSec);
        const style = project.captionStyle;
        const scale = project.height / 1920;
        const fontSize = style.fontSize * scale;
        const paddingY = fontSize * 0.12 * style.boxHeight;
        const paddingX = paddingY * 1.45;
        const blurPx = Math.max(0, style.edgeBlur) * scale;
        const radiusPx = (4 + (Math.max(0, Math.min(1, style.edgeSoftness)) * 18)) * scale;
        const bottomPx = project.subtitleBottomMargin * scale;
        const textShadowDepth = Math.max(0, style.shadow) * scale;
        const textStroke = Math.max(0, style.outline) * scale;

        const bgColor = bgS.solidEnabled ? (bgS.solidColor || '#000000') : (frame.backgroundColor || '#000000');
        background.style.background = bgColor;
        stage.style.background = bgColor;
        video.style.transform = 'translate(' + frame.x + '%,' + frame.y + '%) scale(' + frame.zoom + ')';

        // Sync blur bg time
        if (bgS.blurEnabled && blurBg && blurBg.tagName === 'VIDEO') {
          if (Math.abs((blurBg.currentTime || 0) - (video.currentTime || 0)) > 0.08) {
            blurBg.currentTime = video.currentTime || 0;
          }
        }

        const cue = activeCue(timeSec);
        if (!cue) {
          subtitleLayer.style.display = 'none';
        } else {
          subtitleLayer.style.display = 'block';
          subtitleLayer.style.bottom = bottomPx + 'px';
          subtitleLayer.style.width = Math.max(10, Math.min(100, style.boxWidth)) + '%';
          subtitleLayer.style.padding = paddingY + 'px ' + paddingX + 'px';
          subtitleLayer.style.borderRadius = radiusPx + 'px';
          subtitleLayer.style.backgroundColor = hexToRgba(style.boxColor, style.boxOpacity);
          subtitleLayer.style.boxShadow = blurPx > 0 ? ('0 0 ' + blurPx + 'px ' + hexToRgba(style.boxColor, style.boxOpacity)) : 'none';
          subtitleLayer.style.color = style.textColor;
          subtitleLayer.style.fontFamily = style.fontFamily;
          subtitleLayer.style.fontSize = fontSize + 'px';
          subtitleLayer.style.fontWeight = style.bold ? '850' : '600';
          subtitleLayer.style.letterSpacing = (style.letterSpacing * scale) + 'px';
          subtitleLayer.style.lineHeight = String(style.lineSpacing);
          subtitleLayer.style.textShadow = textShadowDepth > 0
            ? ('0 ' + (textShadowDepth * 0.5) + 'px ' + textShadowDepth + 'px rgba(0,0,0,0.82)')
            : 'none';
          subtitleLayer.style.webkitTextStroke = textStroke > 0 ? (textStroke + 'px rgba(0,0,0,0.58)') : '0 transparent';
          subtitleText.textContent = transformText(cue.text, style.textTransform);
        }
      }
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      tl.to({}, {
        duration: Math.max(0.05, project.durationSec),
        ease: 'none',
        onStart: () => renderAt(0),
        onUpdate: () => renderAt(tl.time()),
      }, 0);
      tl.call(() => renderAt(project.durationSec), [], Math.max(0.05, project.durationSec));
      window.__timelines['vaniscript-short'] = tl;
      renderAt(0);
    <\/script>
  </body>
</html>`;
}

async function renderShortClipWithHyperFrames({
  app,
  project,
  inputVideoPath,
  outputPath,
  format,
  qualityPreset,
  ffmpegPath,
  log,
}) {
  const sourcePath = path.resolve(inputVideoPath);
  const normalizedProject = normalizeProject(project);
  const runtimeRoot = ensureDir(path.join(app.getPath('userData'), 'HyperFramesRuntime'));
  const projectDir = ensureDir(path.join(runtimeRoot, `${Date.now()}_${toSafeFilePart(normalizedProject.id || normalizedProject.title)}`));
  const assetsDir = ensureDir(path.join(projectDir, 'assets'));
  const browserSafeSourcePath = await createBrowserSafeProxy({
    sourcePath,
    project: normalizedProject,
    ffmpegPath,
    assetsDir,
    log,
  });
  const renderProject = {
    ...normalizedProject,
    clipStartSec: 0,
    clipEndSec: normalizedProject.durationSec,
  };
  const sourceExt = path.extname(browserSafeSourcePath) || '.mp4';
  const videoAssetName = `source${sourceExt}`;
  const assetVideoPath = path.join(assetsDir, videoAssetName);
  safeSymlinkOrCopy(browserSafeSourcePath, assetVideoPath);
  copyFontsourceFiles('@fontsource/cuprum', ensureDir(path.join(assetsDir, 'fonts', 'cuprum', 'files')));
  const gsapAssetPath = path.join(assetsDir, 'gsap.min.js');
  safeSymlinkOrCopy(require.resolve('gsap/dist/gsap.min.js'), gsapAssetPath);

  const htmlPath = path.join(projectDir, 'index.html');
  fs.writeFileSync(
    htmlPath,
    buildCompositionHtml(renderProject, `./assets/${videoAssetName}`),
    'utf8',
  );

  const previousPath = process.env.PATH || '';
  process.env.PATH = `${path.dirname(ffmpegPath)}${path.delimiter}${previousPath}`;

  try {
    const { createRenderJob, executeRenderJob } = await import('@hyperframes/producer');
    const quality = mapQualityPreset(qualityPreset);
    const renderFps = Math.max(1, Math.round(renderProject.fps || 30));
    const job = createRenderJob({
      fps: renderFps,
      quality,
      format: format === 'mov' ? 'mov' : 'mp4',
      workers: recommendedWorkers(),
      useGpu: true,
      entryFile: 'index.html',
      producerConfig: {
        fps: renderFps,
        quality,
        format: 'jpeg',
        jpegQuality: quality === 'high' ? 92 : quality === 'draft' ? 80 : 86,
        concurrency: recommendedWorkers(),
        coresPerWorker: 2,
        minParallelFrames: 30,
        largeRenderThreshold: 240,
        disableGpu: false,
        browserGpuMode: 'hardware',
        enableBrowserPool: false,
        browserTimeout: 120000,
        protocolTimeout: 300000,
        forceScreenshot: process.platform !== 'linux',
        enableChunkedEncode: false,
        chunkSizeFrames: 240,
        enableStreamingEncode: true,
        streamingEncodeMaxDurationSeconds: 240,
        ffmpegEncodeTimeout: 600000,
        ffmpegProcessTimeout: 300000,
        ffmpegStreamingTimeout: 600000,
        hdr: false,
        hdrAutoDetect: false,
        audioGain: 1,
        frameDataUriCacheLimit: 256,
        frameDataUriCacheBytesLimitMb: 1024,
        playerReadyTimeout: 45000,
        renderReadyTimeout: 15000,
        verifyRuntime: true,
        debug: false,
      },
    });

    log.info('HyperFrames export settings:', {
      quality,
      format: format === 'mov' ? 'mov' : 'mp4',
      fps: renderProject.fps,
      size: `${renderProject.width}x${renderProject.height}`,
      workers: recommendedWorkers(),
      useGpu: true,
      projectDir,
      htmlPath,
    });

    await executeRenderJob(job, projectDir, outputPath, (currentJob, message) => {
      log.info('HyperFrames progress:', {
        status: currentJob.status,
        progress: Math.round((currentJob.progress || 0) * 100),
        stage: currentJob.currentStage,
        message,
      });
    });

    return { success: true, outputPath };
  } finally {
    process.env.PATH = previousPath;
  }
}

module.exports = {
  buildCompositionHtml,
  buildMediaSegmentsFilter,
  renderShortClipWithHyperFrames,
  interpolateFrameState,
};
