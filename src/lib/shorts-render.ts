import type { FrameKeyframe } from './subtitle-alignment';

// ── Background system types ──────────────────────────────────────────────────

export type BackgroundSettings = {
  // CSS-pixel height of the 9:16 visual editor frame where raw background/frame effects were tuned.
  // HyperFrames uses this to preserve perceived blur/feather/glow strength across 1080p/2K/4K exports.
  effectReferenceHeight?: number;
  // Mode 1: Solid color (existing)
  solidEnabled: boolean;
  solidColor: string;
  // Mode 2: Blurred duplicate
  blurEnabled: boolean;
  blurStrength: number;   // 0–100 (maps to CSS blur px / ffmpeg boxblur)
  blurScale: number;      // 1.0–2.0 (how much to scale the duplicate)
  // Mode 3: Gradient overlay
  gradientEnabled: boolean;
  gradientType: 'linear' | 'radial';
  gradientColorA: string;
  gradientColorB: string;
  gradientAngle: number;  // 0–360 degrees (for linear)
  gradientOpacity: number; // 0–1
  // Mode 4: Edge feathering
  featherEnabled: boolean;
  featherTop: number;     // 0–100 px
  featherBottom: number;
  featherLeft: number;
  featherRight: number;
  // Frame guide styling (preview only, synced between languages)
  frameGuideColor: string;
  frameGuideOpacity: number;      // 0–1 (outer dim)
  frameGuideBorderWidth: number;  // px
  frameGuideBlur: number;         // px inward glow
  frameGuideBorderOpacity: number; // 0–1
};

export function defaultBackgroundSettings(): BackgroundSettings {
  return {
    solidEnabled: true,
    solidColor: '#000000',
    blurEnabled: false,
    blurStrength: 30,
    blurScale: 1.3,
    gradientEnabled: false,
    gradientType: 'linear',
    gradientColorA: '#000000',
    gradientColorB: '#1a1a2e',
    gradientAngle: 180,
    gradientOpacity: 0.6,
    featherEnabled: false,
    featherTop: 20,
    featherBottom: 20,
    featherLeft: 10,
    featherRight: 10,
    frameGuideColor: '#ffaa19',
    frameGuideOpacity: 0.75,
    frameGuideBorderWidth: 2,
    frameGuideBlur: 0,
    frameGuideBorderOpacity: 1,
  };
}

export type VerticalVideoFilterOptions = {
  outputWidth: number;
  outputHeight: number;
  zoom: number;
  cropX: number;
  cropY: number;
  backgroundColor?: string;
  frameKeyframes?: FrameKeyframe[];
  backgroundSettings?: BackgroundSettings;
};

export type ShortsVideoFormat = 'mp4' | 'mov';
export type ShortsResolutionPreset = 'source' | '1080p' | '2k' | '4k';
export type ShortsVideoQuality = 'high' | 'balanced' | 'compact';
export type ShortsFrameRatePreset = 'source' | '24' | '25' | '30' | '50' | '60';

export type AssCue = {
  startSec: number;
  endSec: number;
  text: string;
};

export type ShortsTextTransform = 'none' | 'uppercase' | 'title';

export type ShortsSubtitleStyle = {
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  textTransform: ShortsTextTransform;
  textColor: string;
  boxColor: string;
  boxOpacity: number;
  boxWidth: number;
  boxHeight: number;
  edgeBlur: number;
  letterSpacing: number;
  lineSpacing: number;
  edgeSoftness: number;
  outline: number;
  shadow: number;
};

export type AssSubtitleOptions = {
  cues: AssCue[];
  width: number;
  height: number;
  bottomMargin: number;
  maxLines?: number;
  maxCharsPerLine?: number;
  style: ShortsSubtitleStyle;
};

const SHORTS_STYLE_BASE_WIDTH = 1080;
const SHORTS_STYLE_BASE_HEIGHT = 1920;

function assTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const wholeSeconds = Math.floor(safe % 60);
  const centiseconds = Math.floor((safe - Math.floor(safe)) * 100);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

function assEscape(text: string): string {
  return text.replace(/[{}]/g, '').replace(/\n/g, '\\N');
}

function titleCase(text: string): string {
  return text.toLowerCase().replace(/(^|\s)\S/g, (match) => match.toUpperCase());
}

function transformText(text: string, mode: ShortsTextTransform): string {
  if (mode === 'uppercase') return text.toUpperCase();
  if (mode === 'title') return titleCase(text);
  return text;
}

function wrapCaptionText(text: string, maxCharsPerLine?: number, maxLines = 2): string {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return '';

  const explicitLines = clean.split('\n').map((line) => line.trim()).filter(Boolean);
  if (explicitLines.length > 1) return explicitLines.slice(0, maxLines).join('\n');

  const safeMaxChars = Math.max(8, Math.round(maxCharsPerLine || 0));
  if (!maxCharsPerLine || clean.length <= safeMaxChars) return clean;

  const words = clean.match(/\S+/g) || [];
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && next.length > safeMaxChars && lines.length < maxLines - 1) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);

  return lines.slice(0, maxLines).join('\n');
}

function countCaptionLines(text: string): number {
  return Math.max(1, text.split(/\n|\\N/).filter(Boolean).length);
}

function assColor(hex: string, alpha = 0): string {
  const clean = hex.replace('#', '').padEnd(6, '0').slice(0, 6);
  const rr = clean.slice(0, 2).toUpperCase();
  const gg = clean.slice(2, 4).toUpperCase();
  const bb = clean.slice(4, 6).toUpperCase();
  const aa = Math.round(Math.min(Math.max(alpha, 0), 1) * 255).toString(16).padStart(2, '0').toUpperCase();
  return `&H${aa}${bb}${gg}${rr}`;
}

function boxAlphaFromOpacity(opacity: number): number {
  return 1 - Math.min(Math.max(opacity, 0), 1);
}

export const SHORTS_SUBTITLE_PRESETS: Record<string, ShortsSubtitleStyle> = {
  orangeImpact: {
    fontFamily: 'Cuprum',
    fontSize: 74,
    bold: true,
    textTransform: 'uppercase',
    textColor: '#FFFFFF',
    boxColor: '#FF8C00',
    boxOpacity: 0.5,
    boxWidth: 86,
    boxHeight: 1,
    edgeBlur: 0,
    letterSpacing: 0,
    lineSpacing: 1,
    edgeSoftness: 0.25,
    outline: 3,
    shadow: 4,
  },
  cleanWhite: {
    fontFamily: 'Inter',
    fontSize: 68,
    bold: true,
    textTransform: 'none',
    textColor: '#FFFFFF',
    boxColor: '#000000',
    boxOpacity: 0.42,
    boxWidth: 82,
    boxHeight: 1,
    edgeBlur: 0,
    letterSpacing: 0,
    lineSpacing: 1,
    edgeSoftness: 0.15,
    outline: 2,
    shadow: 4,
  },
};

function ffmpegColor(hex: string | undefined): string {
  const clean = (hex || '#000000').replace('#', '').padEnd(6, '0').slice(0, 6);
  return `0x${clean}`;
}

function escapeFilterExpression(expression: string): string {
  return expression.replace(/,/g, '\\,');
}

function keyframeExpression(
  keyframes: FrameKeyframe[] | undefined,
  field: 'zoom' | 'x' | 'y',
  fallback: number,
): string {
  const sorted = (keyframes || [])
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point[field]))
    .map((point) => ({ time: Math.max(0, point.time), value: point[field] }))
    .sort((a, b) => a.time - b.time);

  if (sorted.length === 0) return fallback.toFixed(4);
  if (sorted.length === 1) return sorted[0].value.toFixed(4);

  const smoothBetween = (from: typeof sorted[number], to: typeof sorted[number]) => {
    const span = Math.max(0.001, to.time - from.time);
    const progress = `((t-${from.time.toFixed(4)})/${span.toFixed(4)})`;
    const eased = `(${progress}*${progress}*(3-2*${progress}))`;
    return `(${from.value.toFixed(4)}+(${(to.value - from.value).toFixed(4)})*${eased})`;
  };

  let expression = sorted[sorted.length - 1].value.toFixed(4);
  for (let index = sorted.length - 2; index >= 0; index -= 1) {
    const from = sorted[index];
    const to = sorted[index + 1];
    expression = `if(lt(t,${to.time.toFixed(4)}),${smoothBetween(from, to)},${expression})`;
  }
  return `if(lt(t,${sorted[0].time.toFixed(4)}),${sorted[0].value.toFixed(4)},${expression})`;
}

export function buildVerticalVideoFilter(opts: VerticalVideoFilterOptions): string {
  const fallbackZoom = Math.min(Math.max(opts.zoom, 0.5), 2.5);
  const fallbackX = (Math.min(Math.max(opts.cropX, 0), 1) - 0.5) * 100;
  const fallbackY = (Math.min(Math.max(opts.cropY, 0), 1) - 0.5) * 100;
  const zoom = fallbackZoom.toFixed(4);
  const panX = fallbackX.toFixed(4);
  const panY = fallbackY.toFixed(4);
  const outputRatio = (opts.outputWidth / opts.outputHeight).toFixed(8);
  const bg = ffmpegColor(opts.backgroundColor);

  const cropX = `max(0\\,min(iw-ow\\,(iw-ow)/2-(${opts.outputWidth}*(${panX})/100)))`;
  const cropY = `max(0\\,min(ih-oh\\,(ih-oh)/2-(${opts.outputHeight}*(${panY})/100)))`;
  const padX = `max(0\\,min(ow-iw\\,(ow-iw)/2+(${opts.outputWidth}*(${panX})/100)))`;
  const padY = `max(0\\,min(oh-ih\\,(oh-ih)/2+(${opts.outputHeight}*(${panY})/100)))`;

  return [
    `scale=w='if(gt(a\\,${outputRatio})\\,${opts.outputWidth}*(${zoom})\\,-2)':h='if(gt(a\\,${outputRatio})\\,-2\\,${opts.outputHeight}*(${zoom}))':eval=frame`,
    `crop=w='min(iw\\,${opts.outputWidth})':h='min(ih\\,${opts.outputHeight})':x='${cropX}':y='${cropY}'`,
    `pad=${opts.outputWidth}:${opts.outputHeight}:x='${padX}':y='${padY}':color=${bg}:eval=frame`,
    'setsar=1',
    'format=yuv420p',
  ].join(',');
}

export function buildVerticalVideoFilterGraph(opts: VerticalVideoFilterOptions): string {
  const fallbackZoom = Math.min(Math.max(opts.zoom, 0.5), 2.5);
  const fallbackX = (Math.min(Math.max(opts.cropX, 0), 1) - 0.5) * 100;
  const fallbackY = (Math.min(Math.max(opts.cropY, 0), 1) - 0.5) * 100;
  const zoom = escapeFilterExpression(keyframeExpression(opts.frameKeyframes, 'zoom', fallbackZoom));
  const panX = escapeFilterExpression(keyframeExpression(opts.frameKeyframes, 'x', fallbackX));
  const panY = escapeFilterExpression(keyframeExpression(opts.frameKeyframes, 'y', fallbackY));
  const outputRatio = (opts.outputWidth / opts.outputHeight).toFixed(8);
  const bgS = opts.backgroundSettings;
  const solidColor = ffmpegColor(bgS?.solidColor || opts.frameKeyframes?.[0]?.backgroundColor || opts.backgroundColor);
  const W = opts.outputWidth;
  const H = opts.outputHeight;
  const overlayX = `(${W}-w)/2+(${W}*(${panX})/100)`;
  const overlayY = `(${H}-h)/2+(${H}*(${panY})/100)`;
  const filters: string[] = [];

  // Foreground: scale source video with zoom/pan
  filters.push(
    `[0:v]setpts=PTS-STARTPTS,scale=w='if(gt(a\\,${outputRatio})\\,-2\\,${W}*(${zoom}))':h='if(gt(a\\,${outputRatio})\\,${H}*(${zoom})\\,-2)':eval=frame[shortfg]`
  );

  // Background layer
  if (bgS?.blurEnabled) {
    const blurR = Math.max(1, Math.round((bgS.blurStrength ?? 30) * 0.8));
    const blurSc = Math.min(2.0, Math.max(1.0, bgS.blurScale ?? 1.3));
    filters.push(
      `[0:v]setpts=PTS-STARTPTS,scale=${Math.round(W * blurSc)}:${Math.round(H * blurSc)},crop=${W}:${H},boxblur=${blurR}:${blurR}[blurbg]`
    );
    if (bgS.solidEnabled) {
      filters.push(`color=c=${solidColor}:s=${W}x${H}:d=21600[solidbg]`);
      filters.push(`[solidbg][blurbg]overlay=0:0:shortest=1[bgbase]`);
    } else {
      filters.push(`[blurbg]copy[bgbase]`);
    }
  } else {
    filters.push(`color=c=${solidColor}:s=${W}x${H}:d=21600[bgbase]`);
  }

  // Gradient overlay
  if (bgS?.gradientEnabled) {
    const gA = ffmpegColor(bgS.gradientColorA || '#000000');
    const gAlpha = Math.min(1, Math.max(0, bgS.gradientOpacity ?? 0.6));
    const alphaHex = Math.round(gAlpha * 255).toString(16).padStart(2, '0');
    filters.push(
      `color=c=${gA}${alphaHex}:s=${W}x${H}:d=21600,format=yuva420p,geq=lum='lum(X\\,Y)':a='255*Y/${H}'[gradlayer]`
    );
    filters.push(`[bgbase][gradlayer]overlay=0:0:shortest=1[bgwgrad]`);
    filters.push(
      `[bgwgrad][shortfg]overlay=x='${overlayX}':y='${overlayY}':eval=frame:shortest=1,setsar=1,format=yuv420p[vbase]`
    );
  } else {
    filters.push(
      `[bgbase][shortfg]overlay=x='${overlayX}':y='${overlayY}':eval=frame:shortest=1,setsar=1,format=yuv420p[vbase]`
    );
  }

  return filters.join(';');
}

export function verticalResolutionForPreset(
  preset: ShortsResolutionPreset,
  source: { width: number; height: number }
): { width: number; height: number } {
  if (preset === '1080p') return { width: 1080, height: 1920 };
  if (preset === '2k') return { width: 1440, height: 2560 };
  if (preset === '4k') return { width: 2160, height: 3840 };
  const sourceLongEdge = Math.max(source.width, source.height);
  if (sourceLongEdge >= 3840) return { width: 2160, height: 3840 };
  if (sourceLongEdge >= 2560) return { width: 1440, height: 2560 };
  return { width: 1080, height: 1920 };
}

export function crfForShortsQuality(quality: ShortsVideoQuality): number {
  if (quality === 'high') return 18;
  if (quality === 'compact') return 24;
  return 20;
}

export function fpsForShortsQuality(quality: ShortsVideoQuality, sourceFps?: number): number {
  if (sourceFps && Number.isFinite(sourceFps) && sourceFps > 0) {
    return Math.min(60, Math.max(1, Math.round(sourceFps)));
  }
  if (quality === 'compact') return 24;
  return 30;
}

export function fpsForShortsFrameRate(preset: ShortsFrameRatePreset, sourceFps?: number): number {
  if (preset === 'source') {
    return sourceFps && Number.isFinite(sourceFps) && sourceFps > 0
      ? Math.min(60, Math.max(1, Math.round(sourceFps)))
      : 30;
  }
  return Number(preset);
}

export function extensionForShortsFormat(format: ShortsVideoFormat): '.mp4' | '.mov' {
  return format === 'mov' ? '.mov' : '.mp4';
}

export function buildShortsAssSubtitle(opts: AssSubtitleOptions): string {
  const style = opts.style;
  const scaleX = opts.width / SHORTS_STYLE_BASE_WIDTH;
  const scaleYOutput = opts.height / SHORTS_STYLE_BASE_HEIGHT;
  const styleScale = Math.min(scaleX, scaleYOutput);
  const fontSize = Math.round(style.fontSize * styleScale);
  const bottomMargin = Math.round(opts.bottomMargin * scaleYOutput);
  const primaryColor = assColor(style.textColor, 0);
  const backColor = assColor(style.boxColor, boxAlphaFromOpacity(style.boxOpacity));
  const outline = Math.max(0, Math.round((style.outline || 0) * styleScale));
  const shadow = Math.max(0, Math.round((style.shadow || 0) * styleScale));
  const scaleY = 100;
  const spacing = (Math.min(Math.max(style.letterSpacing || 0, -3), 12) * styleScale).toFixed(2);
  const lineSpacing = Math.min(Math.max(style.lineSpacing || 1, 0.75), 1.7);
  const boxWidthPercent = Math.min(Math.max(style.boxWidth || 86, 40), 100) / 100;
  const sideMargin = Math.round((opts.width * (1 - boxWidthPercent)) / 2);
  const boxWidth = Math.round(opts.width * boxWidthPercent);
  const boxBlur = Math.max(0, Math.round((style.edgeBlur || 0) * styleScale));
  const cornerRadius = (style.edgeSoftness || 0) >= 0.95
    ? 9999
    : Math.max(0, Math.round(((style.edgeSoftness || 0) * 80) * styleScale));
  const maxLines = Math.min(Math.max(Math.round(opts.maxLines || 2), 1), 4);
  const maxCharsPerLine = opts.maxCharsPerLine ? Math.max(8, Math.round(opts.maxCharsPerLine)) : undefined;
  const boxHeightScale = Math.min(Math.max(style.boxHeight || 1, 0.5), 5.0);
  const paddingY = Math.max(2, Math.round(fontSize * 0.12 * boxHeightScale));
  const paddingX = Math.max(4, Math.round(paddingY * 1.45));
  const textBoxWidth = Math.max(1, boxWidth - (paddingX * 2));
  const fallbackMaxChars = Math.max(8, Math.floor(textBoxWidth / Math.max(1, fontSize * 0.52)));
  const effectiveMaxCharsPerLine = Math.min(maxCharsPerLine || fallbackMaxChars, fallbackMaxChars);

  const captionLayout = (text: string) => {
    const lineCount = countCaptionLines(text);
    const lineHeightPx = fontSize * lineSpacing;
    const boxHeight = Math.round((lineHeightPx * lineCount) + (paddingY * 2));
    const x = Math.round(opts.width / 2 - boxWidth / 2);
    const y = Math.round(opts.height - bottomMargin - boxHeight);
    const textX = Math.round(opts.width / 2);
    const textY = Math.round(y + (boxHeight / 2));
    return { boxHeight, x, y, textX, textY };
  };

  const boxDrawing = (text: string): string => {
    const { boxHeight, x, y } = captionLayout(text);
    const radius = Math.min(cornerRadius, Math.floor(Math.min(boxWidth, boxHeight) / 2));
    const path = radius > 0
      ? `m ${radius} 0 l ${boxWidth - radius} 0 b ${boxWidth} 0 ${boxWidth} 0 ${boxWidth} ${radius} l ${boxWidth} ${boxHeight - radius} b ${boxWidth} ${boxHeight} ${boxWidth} ${boxHeight} ${boxWidth - radius} ${boxHeight} l ${radius} ${boxHeight} b 0 ${boxHeight} 0 ${boxHeight} 0 ${boxHeight - radius} l 0 ${radius} b 0 0 0 0 ${radius} 0`
      : `m 0 0 l ${boxWidth} 0 l ${boxWidth} ${boxHeight} l 0 ${boxHeight} l 0 0`;
    return `{\\an7\\pos(${x},${y})\\bord0\\shad0${boxBlur ? `\\blur${boxBlur}` : ''}\\p1}${path}{\\p0}`;
  };

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${opts.width}`,
    `PlayResY: ${opts.height}`,
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Shorts,${style.fontFamily},${fontSize},${primaryColor},${primaryColor},&HAA000000,&HFF000000,${style.bold ? -1 : 0},0,0,0,100,${scaleY},${spacing},0,1,${outline},${shadow},5,0,0,0,1`,
    `Style: ShortsBox,Arial,1,${backColor},${backColor},${backColor},${backColor},0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = opts.cues.flatMap((cue) => {
    const text = wrapCaptionText(transformText(cue.text, style.textTransform), effectiveMaxCharsPerLine, maxLines);
    const { textX, textY } = captionLayout(text);
    const start = assTime(cue.startSec);
    const end = assTime(cue.endSec);
    return [
      `Dialogue: 0,${start},${end},ShortsBox,,0,0,0,,${boxDrawing(text)}`,
      `Dialogue: 1,${start},${end},Shorts,,0,0,0,,{\\an5\\pos(${textX},${textY})}${assEscape(text)}`,
    ];
  });
  return [...header, ...events].join('\n');
}
