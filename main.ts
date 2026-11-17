// gta6-twitch-ccu-forecast-01 — quantile forecaster for GTA VI launch-day Twitch viewers.
// Node 22, standard library only. No network. Deterministic: pure arithmetic, no randomness.
//
// Method (fitted from the case file's own comparables, nothing hard-coded from practice):
//   Every past big launch in `comparables` has a full release-day hourly curve. For each
//   launch c and hour h, take the log-ratio r_c(h) = ln(viewers_c(h) / viewers_c(1)).
//   A launch's rise through the day depends strongly on how big its hour-1 print already
//   is: across comparables, corr(ln v1, r(h)) reaches -0.93 by hour 21 — a launch that is
//   already huge at 00:00 UTC rises little, a small hour-1 print rises a lot (the US
//   audience only joins after 05:00-08:00 UTC). So for the target's hour-1 print p1 we
//   estimate, per hour h, a scale-local median of r(h):
//     * kernel-weighted median: weight exp(-(ln v1_c - ln p1)^2 / 2) — launches whose
//       hour-1 size matches the target's count most;
//     * weighted least-squares regression of r(h) on ln v1_c, evaluated at ln p1;
//     * the median is the 50/50 blend of the two (robust + smooth, no wild extrapolation
//       when p1 sits beyond every comparable: the kernel part saturates at the biggest
//       launches, the regression part is halved by the blend).
//   Spread is the kernel-weighted interquartile range of r(h) / 1.349 — an honest spread:
//   pinball loss punishes a band that is too narrow and one that is too wide alike.
//   Tier weights: "comparable" 1.0, "early-access-contaminated" 0.5, "weak" 0.5,
//   "target-history" 0 (the GTA VI category's own pre-release history is not a launch
//   curve). A comparable counts only with a real hour 1 and >= 20 hours of its day.
//   Hours with too little data fall back to the house baseline's persistence spread.
//
//   q_tau(h) = p1 * exp(med(h) + z_tau * spread(h)), z = [-1.645, -0.674, 0, 0.674, 1.645].
//
// Input:  every <id>.in in MAKEFUN_INPUT_DIR (else /input), schema makefun/twitch-ccu-case/v1.
// Output: <id>.out in MAKEFUN_OUTPUT_DIR (else /output):
//   {"hours":[{"hour":2,"q":[q05,q25,q50,q75,q95]}, ...]}, 23 rows, hours 2..24.
//   Each q is finite, > 0, <= 1e9, non-decreasing, rounded to 2 decimals.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Gaussian kernel bandwidth in ln(viewers) units, for scale-local weighting. */
const BANDWIDTH = 1.0;
/** House baseline's log-spread per sqrt-hour, used only as a fallback. */
const BASE_SIGMA = 0.15;

interface HourPoint { from: string; viewers: number }
interface Comparable {
  name: string;
  day_start: string;
  unlock?: string;
  hourly: HourPoint[];
}
interface Case {
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  comparables: Comparable[];
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Tier weight parsed from a comparable's unlock note ("Tier: <tier>."). */
function tierWeight(c: Comparable): number {
  const m = /Tier:\s*([a-z-]+)/.exec(c.unlock ?? '');
  if (!m) return 1;
  switch (m[1]) {
    case 'comparable': return 1;
    case 'early-access-contaminated': return 0.5;
    case 'weak': return 0.5;
    case 'target-history': return 0;
    default: return 1;
  }
}

/** A comparable's release-day hourly viewers, keyed by hour 1..24, or null if unusable. */
function dayCurve(c: Comparable): Map<number, number> | null {
  const day = c.day_start.slice(0, 10);
  const hrs = new Map<number, number>();
  for (const p of c.hourly ?? []) {
    if (typeof p.from !== 'string' || !p.from.startsWith(day)) continue;
    const v = p.viewers;
    if (typeof v !== 'number' || !(v > 0)) continue;
    hrs.set(Number(p.from.slice(11, 13)) + 1, v);
  }
  if (!hrs.has(1) || hrs.size < 20) return null;
  return hrs;
}

/** Weighted median of (value, weight) pairs. Weights must sum > 0. */
function weightedMedian(pairs: Array<[number, number]>): number {
  const sorted = pairs.slice().sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (const [v, w] of sorted) {
    acc += w;
    if (acc >= total / 2) return v;
  }
  return sorted[sorted.length - 1][0];
}

/** Weighted p-quantile of (value, weight) pairs. */
function weightedQuantile(pairs: Array<[number, number]>, p: number): number {
  const sorted = pairs.slice().sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (const [v, w] of sorted) {
    acc += w;
    if (acc >= total * p) return v;
  }
  return sorted[sorted.length - 1][0];
}

/**
 * Median log-ratio and spread for one hour, from the training curves.
 * Returns null when there is too little data (caller falls back to baseline).
 */
function hourForecast(
  curves: Array<{ v1: number; hours: Map<number, number>; tierW: number }>,
  p1: number,
  h: number,
): { med: number; spread: number } | null {
  const L = Math.log(p1);
  const pts: Array<{ r: number; w: number; lx: number }> = [];
  for (const c of curves) {
    const vh = c.hours.get(h);
    if (vh === undefined || c.tierW === 0) continue;
    const lx = Math.log(c.v1);
    const w = Math.exp(-((lx - L) ** 2) / (2 * BANDWIDTH * BANDWIDTH)) * c.tierW;
    if (w <= 0) continue;
    pts.push({ r: Math.log(vh / c.v1), w, lx });
  }
  if (pts.length < 5) return null;
  const totalW = pts.reduce((s, p) => s + p.w, 0);
  if (!(totalW > 0)) return null;

  const kmed = weightedMedian(pts.map((p) => [p.r, p.w] as [number, number]));
  // Weighted least squares of r on ln(v1), evaluated at ln(p1).
  const mx = pts.reduce((s, p) => s + p.w * p.lx, 0) / totalW;
  const my = pts.reduce((s, p) => s + p.w * p.r, 0) / totalW;
  const sxx = pts.reduce((s, p) => s + p.w * (p.lx - mx) ** 2, 0);
  const sxy = pts.reduce((s, p) => s + p.w * (p.lx - mx) * (p.r - my), 0);
  const b = sxx > 0 ? sxy / sxx : 0;
  const rmed = my - b * mx + b * L;
  const med = 0.5 * kmed + 0.5 * rmed;

  const pairs = pts.map((p) => [p.r, p.w] as [number, number]);
  const spread = Math.max(
    0.05,
    (weightedQuantile(pairs, 0.75) - weightedQuantile(pairs, 0.25)) / 1.349,
  );
  return { med, spread };
}

/** The five quantiles for one hour, or the house baseline when data is missing. */
function hourQuantiles(
  curves: Array<{ v1: number; hours: Map<number, number>; tierW: number }>,
  p1: number,
  h: number,
): number[] {
  const f = hourForecast(curves, p1, h);
  const qs = Z.map((z) => {
    if (f === null) return p1 * Math.exp(z * BASE_SIGMA * Math.sqrt(h - 1));
    return p1 * Math.exp(f.med + z * f.spread);
  });
  // Round, clamp to (0, 1e9], enforce non-decreasing.
  let prev = 0;
  return qs.map((q) => {
    let v = round2(q);
    if (!Number.isFinite(v) || v <= 0) v = 0.01;
    if (v > 1e9) v = 1e9;
    if (v < prev) v = prev;
    prev = v;
    return v;
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error(`${file} has no hour-1 print`);
  const p1 = Math.max(1, first.viewers);

  const curves: Array<{ v1: number; hours: Map<number, number>; tierW: number }> = [];
  for (const comp of c.comparables ?? []) {
    const hours = dayCurve(comp);
    if (hours === null) continue;
    curves.push({ v1: hours.get(1)!, hours, tierW: tierWeight(comp) });
  }

  const hours = c.forecast.map(({ hour }) => ({ hour, q: hourQuantiles(curves, p1, hour) }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
