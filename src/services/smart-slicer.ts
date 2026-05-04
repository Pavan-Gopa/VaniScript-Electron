/**
 * Smart audio slicer — TypeScript port of Chunker/smart_slice.py
 * Finds optimal cut points in silence regions. No Python required.
 */

const ENERGY_WINDOW_MS = 20;
const SEARCH_RADIUS_FRACTION = 0.5;
const SILENCE_CORE_DB_MARGIN = 6;
const DIGITAL_SILENCE_DBFS = -119.0;

interface EnergyWindow { posMs: number; dbfs: number; }
interface SilenceRegion { startMs: number; endMs: number; }

function rmsToDbfs(rms: number): number {
  if (rms <= 0) return DIGITAL_SILENCE_DBFS;
  return 20 * Math.log10(rms / 32768); // for 16-bit PCM
}

export function computeEnergyProfile(pcm: Int16Array, sampleRate: number): EnergyWindow[] {
  const windowSamples = Math.floor((ENERGY_WINDOW_MS / 1000) * sampleRate);
  const profile: EnergyWindow[] = [];
  for (let i = 0; i < pcm.length - windowSamples; i += windowSamples) {
    let sumSq = 0;
    for (let j = i; j < i + windowSamples; j++) sumSq += pcm[j] * pcm[j];
    const rms = Math.sqrt(sumSq / windowSamples);
    const posMs = Math.floor((i / sampleRate) * 1000);
    profile.push({ posMs, dbfs: rmsToDbfs(rms) });
  }
  return profile;
}

function findSilenceRegions(profile: EnergyWindow[], threshDb: number, minSilenceMs: number): SilenceRegion[] {
  const minWindows = Math.max(1, Math.ceil(minSilenceMs / ENERGY_WINDOW_MS));
  const regions: SilenceRegion[] = [];
  let runStart: number | null = null;

  for (let i = 0; i < profile.length; i++) {
    const silent = profile[i].dbfs <= threshDb;
    if (silent && runStart === null) { runStart = i; continue; }
    if (!silent && runStart !== null) {
      const runLen = i - runStart;
      if (runLen >= minWindows) {
        regions.push({ startMs: profile[runStart].posMs, endMs: profile[i - 1].posMs + ENERGY_WINDOW_MS });
      }
      runStart = null;
    }
  }
  if (runStart !== null) {
    const runLen = profile.length - runStart;
    if (runLen >= minWindows) {
      regions.push({ startMs: profile[runStart].posMs, endMs: profile[profile.length - 1].posMs + ENERGY_WINDOW_MS });
    }
  }
  return regions;
}

function distanceToRegion(r: SilenceRegion, targetMs: number): number {
  if (targetMs >= r.startMs && targetMs <= r.endMs) return 0;
  return targetMs < r.startMs ? r.startMs - targetMs : targetMs - r.endMs;
}

function findSafeCut(
  profile: EnergyWindow[],
  targetMs: number,
  loMs: number,
  hiMs: number,
  regions: SilenceRegion[],
  cursorMs: number
): number | null {
  const upcoming = regions.filter(r => r.startMs > cursorMs);
  const nearby = upcoming.filter(r => r.startMs <= hiMs && r.endMs >= loMs);
  const pool = nearby.length > 0 ? nearby : upcoming;
  if (pool.length === 0) return null;
  const best = pool.reduce((a, b) => distanceToRegion(a, targetMs) <= distanceToRegion(b, targetMs) ? a : b);
  return Math.floor((best.startMs + best.endMs) / 2);
}

export function computeCutPoints(
  pcm: Int16Array,
  sampleRate: number,
  targetMs: number,
  threshDb: number,
  minSilenceMs: number
): number[] {
  const totalMs = Math.floor((pcm.length / sampleRate) * 1000);
  if (totalMs <= targetMs) return [];

  const profile = computeEnergyProfile(pcm, sampleRate);
  const regions = findSilenceRegions(profile, threshDb, minSilenceMs);
  const radius = Math.floor(targetMs * SEARCH_RADIUS_FRACTION);
  const cuts: number[] = [];
  let cursor = 0;

  while (cursor + targetMs < totalMs) {
    const ideal = cursor + targetMs;
    const lo = Math.max(cursor + 1, ideal - radius);
    const hi = Math.min(totalMs - 1, ideal + radius);
    const remaining = regions.filter(r => r.startMs > cursor);
    if (!remaining.length) break;

    const cut = findSafeCut(profile, ideal, lo, hi, remaining, cursor);
    if (!cut || cut <= cursor) break;
    cuts.push(cut);
    cursor = cut;
    if (totalMs - cursor < targetMs * 0.25) break;
  }
  return cuts;
}

/** Convert cut points in ms → seconds for FFmpeg */
export function cutPointsToSeconds(cutPointsMs: number[]): number[] {
  return cutPointsMs.map(ms => ms / 1000);
}
