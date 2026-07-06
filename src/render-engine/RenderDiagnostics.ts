export type RenderProgressSample = {
  atMs: number;
  renderedFrames: number;
  encodedFrames: number;
  progress: number;
};

export function summarizeRenderProgress(samples: RenderProgressSample[]) {
  if (samples.length < 2) {
    return { renderFps: 0, encodeFps: 0 };
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  const elapsedSec = Math.max(0.001, (last.atMs - first.atMs) / 1000);
  return {
    renderFps: (last.renderedFrames - first.renderedFrames) / elapsedSec,
    encodeFps: (last.encodedFrames - first.encodedFrames) / elapsedSec,
  };
}
