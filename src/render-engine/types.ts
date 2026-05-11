import type { FrameKeyframe } from '../lib/subtitle-alignment';
import type { ShortsSubtitleStyle } from '../lib/shorts-render';

export type RenderSubtitleCue = {
  id: string;
  startSec: number;
  endSec: number;
  text: string;
};

export type ShortsRenderProject = {
  id: string;
  title: string;
  inputVideoSrc: string;
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
  fps: number;
  clipStartSec: number;
  clipEndSec: number;
  durationSec: number;
  durationInFrames: number;
  subtitles: RenderSubtitleCue[];
  captionStyle: ShortsSubtitleStyle;
  subtitleBottomMargin: number;
  frameKeyframes: FrameKeyframe[];
};

export type ShortsRenderProjectInput = {
  id: string;
  title: string;
  inputVideoSrc: string;
  sourceWidth?: number;
  sourceHeight?: number;
  clipStartSec: number;
  clipEndSec: number;
  outputWidth: number;
  outputHeight: number;
  fps: number;
  cues: Array<{ startSec: number; endSec: number; text: string }>;
  style: ShortsSubtitleStyle;
  subtitleBottomMargin: number;
  frameKeyframes?: FrameKeyframe[];
};
