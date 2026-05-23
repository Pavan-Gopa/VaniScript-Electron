'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { fileURLToPath, pathToFileURL } = require('url');

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
    logo: project.logo?.src ? {
      id: project.logo.id || 'logo',
      src: String(project.logo.src),
      name: String(project.logo.name || 'Logo'),
      size: clamp(Number(project.logo.size) || 1, 0.5, 2),
      opacity: clamp(Number.isFinite(Number(project.logo.opacity)) ? Number(project.logo.opacity) : 1, 0, 1),
      position: ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(project.logo.position) ? project.logo.position : 'top-left',
      hidden: !!project.logo.hidden,
    } : undefined,
    textTracks: (project.textTracks || []).slice(0, 3).map((track, trackIndex) => ({
      id: track.id || `text_track_${trackIndex}`,
      name: String(track.name || `Text Track ${trackIndex + 1}`),
      hidden: !!track.hidden,
      muted: !!track.muted,
      blocks: (track.blocks || []).map((block, blockIndex) => ({
        id: block.id || `text_block_${trackIndex}_${blockIndex}`,
        startSec: Math.max(0, Number(block.startSec) || 0),
        endSec: Math.max(0.05, Number(block.endSec) || 0.05),
        text: String(block.text || ''),
        hidden: !!block.hidden,
      })).filter((block) => block.text.trim() && block.endSec > block.startSec),
      style: track.style || {},
    })),
    audioTracks: (project.audioTracks || []).slice(0, 3).map((track, trackIndex) => ({
      id: track.id || `audio_track_${trackIndex}`,
      name: String(track.name || `Audio Track ${trackIndex + 1}`),
      src: String(track.src || ''),
      startSec: Math.max(0, Number(track.startSec) || 0),
      trimStartSec: Math.max(0, Number(track.trimStartSec) || 0),
      trimEndSec: Math.max(0, Number(track.trimEndSec) || 0),
      volume: clamp(Number.isFinite(Number(track.volume)) ? Number(track.volume) : 0.5, 0, 1),
      fadeInSec: Math.max(0, Number(track.fadeInSec) || 0),
      fadeOutSec: Math.max(0, Number(track.fadeOutSec) || 0),
      muted: !!track.muted,
    })).filter((track) => track.src),
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

function localAssetPath(src) {
  if (!src) return '';
  if (String(src).startsWith('file://')) {
    try {
      return fileURLToPath(src);
    } catch (_error) {
      return '';
    }
  }
  return path.isAbsolute(String(src)) ? String(src) : '';
}

function copyProjectLayerAssets(project, assetsDir) {
  const copied = { ...project };
  const copyOne = (src, prefix) => {
    const sourcePath = localAssetPath(src);
    if (!sourcePath || !fs.existsSync(sourcePath)) return src;
    const ext = path.extname(sourcePath) || '';
    const name = `${prefix}_${toSafeFilePart(path.basename(sourcePath, ext))}${ext}`;
    const dest = path.join(assetsDir, name);
    safeSymlinkOrCopy(sourcePath, dest);
    return `./assets/${name}`;
  };

  if (copied.logo?.src) {
    copied.logo = { ...copied.logo, src: copyOne(copied.logo.src, 'logo') };
  }

  copied.audioTracks = (copied.audioTracks || []).map((track, index) => ({
    ...track,
    previewSrc: undefined,
    src: copyOne(track.src, `extra_audio_${index + 1}`),
  }));

  return copied;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.message === 'render_cancelled' || error?.message === 'Export cancelled';
}

function runFfmpeg(ffmpegPath, args, log, abortSignal) {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error('render_cancelled'));
      return;
    }
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    const onAbort = () => {
      try { proc.kill('SIGTERM'); } catch {}
      reject(new Error('render_cancelled'));
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (error) => {
      abortSignal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    proc.on('close', (code) => {
      abortSignal?.removeEventListener('abort', onAbort);
      if (abortSignal?.aborted) {
        reject(new Error('render_cancelled'));
        return;
      }
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
  abortSignal,
}) {
  if (abortSignal?.aborted) throw new Error('render_cancelled');
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
    await runFfmpeg(ffmpegPath, [...baseArgs, ...inputArgs, ...outputArgs, ...hardwareArgs, proxyPath], log, abortSignal);
    return proxyPath;
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (process.platform !== 'darwin') throw error;
    log.warn('HyperFrames proxy hardware encode failed, retrying with libx264.', error.message || String(error));
    await runFfmpeg(ffmpegPath, [...baseArgs, ...inputArgs, ...outputArgs, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', proxyPath], log, abortSignal);
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
        overflow: hidden; z-index: 2;
      }
      #source-video {
        position: absolute; inset: 0; width: 100%; height: 100%;
        object-fit: contain; transform-origin: center center;
      }
      #frame-guide-overlay {
        position: absolute; inset: 0; z-index: 4; pointer-events: none;
        border: 0 solid transparent;
      }
      #feather-overlay {
        position: absolute; inset: 0; z-index: 3; pointer-events: none;
        display: none;
      }
      #subtitle-layer {
        position: absolute; left: 50%; transform: translateX(-50%);
        max-width: 100%; box-sizing: border-box; text-align: center;
        overflow: hidden; pointer-events: none; display: none; z-index: 5;
      }
      #subtitle-text {
        display: block; margin: 0;
        white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal;
      }
      #logo-overlay {
        position: absolute; z-index: 6;
        transform-origin: top left; pointer-events: none;
        max-width: 28%; max-height: 18%; object-fit: contain;
        background: transparent;
      }
      #text-overlays {
        position: absolute; inset: 0; z-index: 6; pointer-events: none;
      }
      .text-overlay-layer {
        position: absolute; left: 50%; transform: translateX(-50%);
        max-width: 100%; box-sizing: border-box; text-align: center;
        overflow: hidden; display: none;
      }
      .text-overlay-layer span {
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
      <div id="feather-overlay"></div>
      <div id="frame-guide-overlay"></div>
      <div id="subtitle-layer"><span id="subtitle-text"></span></div>
      ${project.logo?.src && !project.logo.hidden ? `<img id="logo-overlay" src="${escapeHtml(project.logo.src)}" alt="${escapeHtml(project.logo.name || 'Logo')}" />` : ''}
      <div id="text-overlays"></div>
      ${(project.audioTracks || []).filter((track) => !track.muted).map((track, index) => `<audio
          class="extra-audio"
          data-start="${track.startSec}"
          data-duration="${Math.max(0.05, project.durationSec - track.startSec - (track.trimEndSec || 0))}"
          data-track-index="${10 + index}"
          data-media-start="${track.trimStartSec || 0}"
          data-volume="${track.volume}"
          data-fade-in="${track.fadeInSec || 0}"
          data-fade-out="${track.fadeOutSec || 0}"
          preload="auto"
          src="${escapeHtml(track.src)}"
        ></audio>`).join('\n')}
    </div>
    <script>
      const project = ${asJsonScript(project)};
      const stage = document.getElementById('stage');
      const background = document.getElementById('background');
      const blurBg = document.getElementById('blur-bg');
      const gradientOverlay = document.getElementById('gradient-overlay');
      const videoStage = document.getElementById('video-stage');
      const video = document.getElementById('source-video');
      const featherOverlay = document.getElementById('feather-overlay');
      const frameGuideOverlay = document.getElementById('frame-guide-overlay');
      const subtitleLayer = document.getElementById('subtitle-layer');
      const subtitleText = document.getElementById('subtitle-text');
      const logoOverlay = document.getElementById('logo-overlay');
      const textOverlays = document.getElementById('text-overlays');
      const extraAudio = Array.from(document.querySelectorAll('.extra-audio'));
      const bgS = project.backgroundSettings || {};
      const renderScale = project.height / 1920;
      const effectScale = project.height / Math.max(1, Number(bgS.effectReferenceHeight) || 960);

      const clamp = (v, mn, mx) => Math.min(Math.max(v, mn), mx);
      const smoothstep = (v) => { const t = clamp(v, 0, 1); return t * t * (3 - (2 * t)); };
      const hexToRgba = (hex, opacity) => {
        const c = String(hex || '#000000').replace('#', '').padEnd(6, '0').slice(0, 6);
        return 'rgba(' + parseInt(c.slice(0,2),16) + ',' + parseInt(c.slice(2,4),16) + ',' + parseInt(c.slice(4,6),16) + ',' + clamp(opacity,0,1) + ')';
      };
      const titleCase = (t) => t.toLowerCase().replace(/(^|\\s)\\S/g, (m) => m.toUpperCase());
      const transformText = (t, mode) => mode === 'uppercase' ? t.toUpperCase() : mode === 'title' ? titleCase(t) : t;
      const activeCue = (ts) => project.subtitles.find((c) => ts >= c.startSec && ts < c.endSec) || null;
      const activeTextBlocks = (ts) => (project.textTracks || [])
        .filter((track) => !track.hidden && !track.muted)
        .flatMap((track, trackIndex) => (track.blocks || [])
          .filter((block) => !block.hidden && block.text && ts >= block.startSec && ts < block.endSec)
          .map((block) => ({ ...block, trackIndex, style: track.style || {} })));
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
        blurBg.style.filter = 'blur(' + ((bgS.blurStrength || 30) * effectScale) + 'px)';
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
      // Setup feathering mask (top/bottom only)
      if (bgS.featherEnabled) {
        const fT = bgS.featherTop || 0;
        const fB = bgS.featherBottom || 0;
        if (fT > 0 || fB > 0) {
          const mask = 'linear-gradient(to bottom, transparent 0px, black ' + (fT * effectScale) + 'px, black calc(100% - ' + (fB * effectScale) + 'px), transparent 100%)';
          video.style.maskImage = mask;
          video.style.webkitMaskImage = mask;
          videoStage.style.maskImage = mask;
          videoStage.style.webkitMaskImage = mask;
        } else {
          clearFeatherMasks();
        }
      } else {
        clearFeatherMasks();
      }

      function clearFeatherMasks() {
        video.style.maskImage = '';
        video.style.webkitMaskImage = '';
        video.style.maskComposite = '';
        video.style.webkitMaskComposite = '';
        videoStage.style.maskImage = '';
        videoStage.style.webkitMaskImage = '';
        videoStage.style.maskComposite = '';
        videoStage.style.webkitMaskComposite = '';
      }

      if (frameGuideOverlay) {
        const guideColor = bgS.frameGuideColor || '#ffaa19';
        const guideBorderOpacity = Number.isFinite(Number(bgS.frameGuideBorderOpacity)) ? bgS.frameGuideBorderOpacity : 1;
        const guideBorderColor = hexToRgba(guideColor, guideBorderOpacity);
        const guideBorderWidth = Math.max(0, Number(bgS.frameGuideBorderWidth) || 0) * effectScale;
        const guideBlur = Math.max(0, Number(bgS.frameGuideBlur) || 0) * effectScale;
        const guideDim = Number.isFinite(Number(bgS.frameGuideOpacity)) ? clamp(bgS.frameGuideOpacity, 0, 1) : 0;
        frameGuideOverlay.style.border = guideBorderWidth + 'px solid ' + guideBorderColor;
        frameGuideOverlay.style.background = guideDim > 0
          ? 'linear-gradient(to bottom, rgba(0,0,0,' + (guideDim * 0.16) + ') 0%, rgba(0,0,0,0) 18%, rgba(0,0,0,0) 82%, rgba(0,0,0,' + (guideDim * 0.16) + ') 100%)'
          : 'transparent';
        frameGuideOverlay.style.boxShadow =
          'inset 0 0 ' + guideBlur + 'px ' + (guideBlur * 0.5) + 'px ' + guideBorderColor +
          ', inset 0 0 ' + (guideBlur * 2.8) + 'px rgba(0,0,0,' + (guideDim * 0.28) + ')';
      }

      function updateFeatherOverlay(bgColor) {
        if (!featherOverlay) return;
        if (!bgS.featherEnabled) {
          featherOverlay.style.display = 'none';
          return;
        }
        const featherGradients = [];
        const topPx = Math.max(0, Number(bgS.featherTop) || 0) * effectScale;
        const bottomPx = Math.max(0, Number(bgS.featherBottom) || 0) * effectScale;
        const edgeColor = hexToRgba(bgColor, 0.62);
        const clearColor = hexToRgba(bgColor, 0);
        if (topPx > 0) featherGradients.push('linear-gradient(to bottom, ' + edgeColor + ' 0px, ' + clearColor + ' ' + topPx + 'px)');
        if (bottomPx > 0) featherGradients.push('linear-gradient(to top, ' + edgeColor + ' 0px, ' + clearColor + ' ' + bottomPx + 'px)');
        featherOverlay.style.display = featherGradients.length ? 'block' : 'none';
        featherOverlay.style.background = featherGradients.join(', ');
      }

      if (logoOverlay && project.logo) {
        const margin = 40 * renderScale;
        const position = project.logo.position || 'top-left';
        logoOverlay.style.width = (120 * renderScale * (project.logo.size || 1)) + 'px';
        logoOverlay.style.opacity = String(project.logo.opacity ?? 1);
        logoOverlay.style.top = position.startsWith('top') ? margin + 'px' : 'auto';
        logoOverlay.style.bottom = position.startsWith('bottom') ? margin + 'px' : 'auto';
        logoOverlay.style.left = position.endsWith('left') ? margin + 'px' : 'auto';
        logoOverlay.style.right = position.endsWith('right') ? margin + 'px' : 'auto';
      }

      function styleOverlayBox(layer, textEl, style, text, bottomPx, scale, fontSizeFactor) {
        const fontSize = (style.fontSize || 74) * scale * fontSizeFactor;
        const paddingY = fontSize * 0.12 * (style.boxHeight || 1);
        const paddingX = paddingY * 1.45;
        const blurPx = Math.max(0, style.edgeBlur || 0) * scale;
        const softness = style.edgeSoftness ?? 0.25;
        const radiusPx = softness >= 0.95 ? 9999 : (softness * 80) * scale;
        const textShadowDepth = Math.max(0, style.shadow || 0) * scale;
        const textStroke = Math.max(0, style.outline || 0) * scale;

        layer.style.display = 'block';
        layer.style.bottom = bottomPx + 'px';
        layer.style.width = Math.max(10, Math.min(100, style.boxWidth || 86)) + '%';
        layer.style.padding = paddingY + 'px ' + paddingX + 'px';
        layer.style.color = style.textColor || '#FFFFFF';
        layer.style.fontFamily = style.fontFamily || 'Cuprum';
        layer.style.fontSize = fontSize + 'px';
        layer.style.fontWeight = style.bold ? '850' : '600';
        layer.style.letterSpacing = ((style.letterSpacing || 0) * scale) + 'px';
        layer.style.lineHeight = String(style.lineSpacing || 1);
        layer.style.textShadow = textShadowDepth > 0
          ? ('0 ' + (textShadowDepth * 0.5) + 'px ' + textShadowDepth + 'px rgba(0,0,0,0.82)')
          : 'none';
        layer.style.webkitTextStroke = textStroke > 0 ? (textStroke + 'px rgba(0,0,0,0.58)') : '0 transparent';

        // Override background & shadow styles to be handled by a separate background layer
        layer.style.backgroundColor = 'transparent';
        layer.style.borderRadius = '0px';
        layer.style.boxShadow = 'none';
        layer.style.position = 'relative';
        layer.style.overflow = 'visible';

        // Ensure text element has relative positioning and z-index to sit on top of background
        textEl.style.position = 'relative';
        textEl.style.zIndex = '1';
        textEl.textContent = transformText(text, style.textTransform || 'none');

        // Manage background div
        let bgEl = layer.querySelector('.vaniscript-box-bg');
        if (!bgEl) {
          bgEl = document.createElement('div');
          bgEl.className = 'vaniscript-box-bg';
          layer.insertBefore(bgEl, layer.firstChild);
        }
        bgEl.style.position = 'absolute';
        bgEl.style.top = '0';
        bgEl.style.left = '0';
        bgEl.style.right = '0';
        bgEl.style.bottom = '0';
        bgEl.style.zIndex = '-1';
        bgEl.style.borderRadius = radiusPx + 'px';
        bgEl.style.backgroundColor = hexToRgba(style.boxColor || '#FF8C00', style.boxOpacity ?? 0.5);
        bgEl.style.filter = blurPx > 0 ? ('blur(' + blurPx + 'px)') : 'none';
        bgEl.style.pointerEvents = 'none';
      }

      function renderTextOverlays(timeSec, baseBottomPx, scale) {
        if (!textOverlays) return;
        const blocks = activeTextBlocks(timeSec);
        textOverlays.innerHTML = '';
        blocks.forEach((block) => {
          const layer = document.createElement('div');
          layer.className = 'text-overlay-layer';
          const span = document.createElement('span');
          layer.appendChild(span);
          textOverlays.appendChild(layer);
          styleOverlayBox(
            layer,
            span,
            { ...project.captionStyle, ...(block.style || {}) },
            block.text,
            baseBottomPx + ((block.trackIndex + 1) * (project.captionStyle.fontSize || 74) * scale * 1.65),
            scale,
            0.82,
          );
        });
      }

      function renderAt(timeSec) {
        const frame = interpolateFrameState(timeSec);
        const style = project.captionStyle;
        const scale = project.height / 1920;
        const fontSize = style.fontSize * scale;
        const paddingY = fontSize * 0.12 * style.boxHeight;
        const paddingX = paddingY * 1.45;
        const blurPx = Math.max(0, style.edgeBlur) * scale;
        const softness = style.edgeSoftness ?? 0.25;
        const radiusPx = softness >= 0.95 ? 9999 : (softness * 80) * scale;
        const bottomPx = project.subtitleBottomMargin * scale;
        const textShadowDepth = Math.max(0, style.shadow) * scale;
        const textStroke = Math.max(0, style.outline) * scale;

        const bgColor = bgS.solidEnabled ? (bgS.solidColor || '#000000') : (frame.backgroundColor || '#000000');
        background.style.background = bgColor;
        stage.style.background = bgColor;
        updateFeatherOverlay(bgColor);
        videoStage.style.transform = 'translate(-50%, -50%) translate(' + frame.x + '%,' + frame.y + '%) scale(' + frame.zoom + ')';
        video.style.transform = 'none';
        extraAudio.forEach((audio) => {
          const start = Number(audio.dataset.start || 0);
          const duration = Number(audio.dataset.duration || 0);
          const baseVolume = Number(audio.dataset.volume || 1);
          const fadeIn = Number(audio.dataset.fadeIn || 0);
          const fadeOut = Number(audio.dataset.fadeOut || 0);
          const local = timeSec - start;
          let gain = local >= 0 && local <= duration ? 1 : 0;
          if (gain > 0 && fadeIn > 0) gain = Math.min(gain, clamp(local / fadeIn, 0, 1));
          if (gain > 0 && fadeOut > 0) gain = Math.min(gain, clamp((duration - local) / fadeOut, 0, 1));
          audio.volume = clamp(baseVolume * gain, 0, 1);
        });

        // Sync blur bg time frame-accurately
        if (bgS.blurEnabled && blurBg && blurBg.tagName === 'VIDEO') {
          const vTime = video.currentTime || 0;
          if (Math.abs((blurBg.currentTime || 0) - vTime) > 0.001) {
            blurBg.currentTime = vTime;
          }
        }

        const cue = activeCue(timeSec);
        if (!cue) {
          subtitleLayer.style.display = 'none';
        } else {
          styleOverlayBox(subtitleLayer, subtitleText, style, cue.text, bottomPx, scale, 1);
        }
        renderTextOverlays(timeSec, bottomPx, scale);
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
  abortSignal,
  onProgress,
}) {
  if (abortSignal?.aborted) throw new Error('render_cancelled');
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
    abortSignal,
  });
  onProgress?.({ status: 'processing', progress: 0.08, stage: 'proxy', message: 'Prepared browser-safe video proxy' });
  const renderProject = {
    ...copyProjectLayerAssets(normalizedProject, assetsDir),
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
      onProgress?.({
        status: currentJob.status,
        progress: currentJob.progress || 0,
        stage: currentJob.currentStage || 'render',
        message,
      });
      log.info('HyperFrames progress:', {
        status: currentJob.status,
        progress: Math.round((currentJob.progress || 0) * 100),
        stage: currentJob.currentStage,
        message,
      });
    }, abortSignal);

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
