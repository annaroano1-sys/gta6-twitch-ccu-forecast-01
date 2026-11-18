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
//     * weighted least-squares regression of r(h) on ln v1_c, evaluated at ln p1,
//       slope inflated x1.1 (regression-dilution correction);
//     * the centre is the regression prediction PLUS the kernel-weighted median
//       of the residuals around the slope-inflated fit at each curve's own ln(v1)
//       (round 4). The regression estimates a conditional MEAN; r(h) is strongly
//       right-skewed (late hours: median +0.85, q95 +7.0 pooled), so the residual
//       median — not a kernel median blended with the mean — is the correct centre
//       for q50, and it extrapolates better to beyond-range giants.
//   Spread is ONE pooled value for all hours: the mean of the 23 hourly
//   kernel-weighted IQRs / 1.349, scaled by 0.8 (round 5). The per-hour IQR
//   estimates are noisy (effective n ~5-10 after kernel weighting) while the true
//   conditional dispersion varies slowly with h, so pooling removes noise.
//   An honest spread: pinball loss punishes a band that is too narrow and one that is
//   too wide alike.
//
//   Round-2 tuning (grid over bandwidth / blend / spread multiplier, accepted only if
//   it improves BOTH practice mean and leave-one-out over 37 curves):
//     bandwidth 1.0 -> 1.3, blend kernel/regression 50/50 -> 25/75, spread x0.9.
//     Practice mean 0.1949 -> 0.1814, LOO 0.4006 -> 0.3906 (baseline 0.3871 / 0.9297).
//     Rejected by the same grid: asymmetric spread, empirical-quantile spread, a
//     rise-boost for small launches (helps one practice case, wrecks LOO), hour-1
//     channels-per-viewer and the pre-release launch multiplier (both double-count
//     the ln(v1) regression); minute-shape / top-stream signals exist only in the
//     final case, so no validated adjustment could be built from them — the entry
//     reads only known/forecast/comparables and ignores the rest.
//
//   Round-3 tuning (target: LOO generalisation — the final is one unseen case):
//     the size→rise link strengthens through the day (corr(ln v1, r(h)) grows
//     with h), so both the kernel bandwidth and the kernel/regression blend
//     now ramp with h: bandwidth 1.6 -> 1.0 (wide early, when size barely
//     matters, narrow late, when it matters most) and kernel weight 0.5 -> 0.1
//     (median early, regression late); the regression slope is inflated x1.1
//     (regression-dilution correction — big launches were systematically
//     over-predicted late in the day); neighbouring hours share information
//     (median smoothed 25% across h-1/h+1, curves are smooth in h).
//     Practice mean 0.1814 -> 0.1787, LOO 0.3906 -> 0.3854, LOO-big 0.2107 ->
//     0.2086, 2x-anchor stress 0.4257 -> 0.4154 (baseline 0.3871 / 0.9297).
//     Rejected in round 3 (each failed the BOTH rule or added nothing):
//     winsorised r, Huber IRLS regression, quadratic regression, adaptive
//     blend by effective sample size, per-hour spread bands, tier reweighting
//     (incl. early-access 0.75: LOO 0.3806 but practice 0.1866), smult 0.85
//     (practice 0.1762 but weaker 2x-anchor extrapolation).
//
//   Round-4 (target: a NEW estimator, not constant tuning):
//     (1) residual-median centre (see above) replaces the kernel/regression blend;
//     (2) one pooled spread (mean of the 23 hourly IQRs) replaces per-hour spreads;
//     (3) spread multiplier 0.9 -> 0.85.
//     Practice mean 0.1787 -> 0.1745, LOO 0.3853 -> 0.3737, 2x-anchor stress
//     0.3413 -> 0.3221, 1.5x-anchor 0.2005 -> 0.1761 (mirror-verified, real entry).
//     Rejected in round 4 (each failed the BOTH rule — improve BOTH practice and
//     LOO, anchor 2x not worse):
//     launch-type conditioning (SIM/MIX/ROLL tags from unlock text: practice
//     worsened in every grid point, e.g. 0.1802-0.1901; LOO ~flat; anchor worse),
//     excluding/downweighting "pre-launch hour-1" curves (v1 < 2% of peak:
//     practice 0.1989, LOO 0.6796 — the tiny launches are load-bearing signal
//     for small targets, not artifacts), empirical/asymmetric/type-conditional
//     spreads, k-NN restriction (k=8: 0.2375/0.4124), tricube-style local
//     windows, launch-multiplier / channels-per-viewer / pre-launch-momentum
//     second features (partial corr with residual rise -0.17..+0.19: dead),
//     per-hour spread smoothing alone (helps, but pooling is strictly better),
//     linear-in-h spread (LOO 0.3859), smult 0.95 with the new centre
//     (practice 0.1791), smult 0.8 (anchor 0.3435 > v3).
//
//   Round-5 (target: push further on the round-4 centre — wider kernel + tighter
//     spread + stronger median smoothing):
//     bandwidth 1.6/1.0 -> 2.2/1.3, spread multiplier 0.85 -> 0.8, median
//     smoothing 0.25 -> 0.5. A wider kernel leans more on the global
//     size->rise relation and less on local neighbours; the LOO gain is
//     concentrated in the worst curves (Silksong -0.076, Marathon -0.062,
//     RE Requiem -0.056; worst regression +0.022) and ALL FIVE anchor giants
//     improve (Elden Ring 0.310 -> 0.249, Cyberpunk 0.307 -> 0.242, Diablo
//     0.179 -> 0.161, Hogwarts 0.441 -> 0.378, TLOU 0.373 -> 0.335).
//     Practice mean 0.1745 -> 0.1738, LOO 0.3737 -> 0.3707, 2x-anchor stress
//     0.3221 -> 0.2729, 1.5x-anchor 0.1761 -> 0.1646 (mirror-verified, real entry).
//     Rejected in round 5 (each failed the BOTH rule):
//     launch-type conditioning on the new centre (still hurts practice in
//     every grid point, 0.1772-0.1864; LOO ~flat), residual trimmed-mean
//     centre (practice 0.1707 + anchor 0.3051 but LOO 0.3828), quadratic
//     regression fit (practice 0.1474 but LOO 0.4698 — overfits the 4 practice
//     cases), residual-based pooled spread (practice 0.1692 but LOO 0.3839,
//     anchor 0.3518), extrapolation damping (anchor 0.3641-0.4191 — the anchor
//     wants MORE extrapolation, not less), slope 1.2-1.3 (anchor 0.2995-0.3108
//     but LOO 0.3751-0.3769), even wider bandwidth 2.3/1.35 (practice 0.1752).
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
/** Gaussian kernel bandwidth in ln(viewers) units; ramps 2.2 -> 1.3 over hours 2..24 (round 5). */
const BANDWIDTH_EARLY = 2.2;
const BANDWIDTH_LATE = 1.3;
/** Regression-slope inflation (regression-dilution correction). */
const SLOPE_MULT = 1.1;
/** Median smoothing across neighbouring hours (round 5: 0.5). */
const SMOOTH = 0.5;
/** Spread multiplier (round-5 tuning with the pooled spread). */
const SPREAD_MULT = 0.8;
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
  const t = (h - 2) / 22; // 0 at h=2, 1 at h=24
  const bw = BANDWIDTH_EARLY + (BANDWIDTH_LATE - BANDWIDTH_EARLY) * t;
  const pts: Array<{ r: number; w: number; lx: number }> = [];
  for (const c of curves) {
    const vh = c.hours.get(h);
    if (vh === undefined || c.tierW === 0) continue;
    const lx = Math.log(c.v1);
    const w = Math.exp(-((lx - L) ** 2) / (2 * bw * bw)) * c.tierW;
    if (w <= 0) continue;
    pts.push({ r: Math.log(vh / c.v1), w, lx });
  }
  if (pts.length < 5) return null;
  const totalW = pts.reduce((s, p) => s + p.w, 0);
  if (!(totalW > 0)) return null;

  // Weighted least squares of r on ln(v1), evaluated at ln(p1), slope inflated.
  const mx = pts.reduce((s, p) => s + p.w * p.lx, 0) / totalW;
  const my = pts.reduce((s, p) => s + p.w * p.r, 0) / totalW;
  const sxx = pts.reduce((s, p) => s + p.w * (p.lx - mx) ** 2, 0);
  const sxy = pts.reduce((s, p) => s + p.w * (p.lx - mx) * (p.r - my), 0);
  const b = sxx > 0 ? sxy / sxx : 0;
  const rmed = my + SLOPE_MULT * b * (L - mx);
  // Round-4 centre: regression prediction + kernel-weighted median of the
  // residuals around the slope-inflated fit at each curve's own ln(v1).
  const res = pts.map((p) => [p.r - (my + SLOPE_MULT * b * (p.lx - mx)), p.w] as [number, number]);
  const med = rmed + weightedMedian(res);

  const pairs = pts.map((p) => [p.r, p.w] as [number, number]);
  const spread = Math.max(
    0.05,
    (weightedQuantile(pairs, 0.75) - weightedQuantile(pairs, 0.25)) / 1.349,
  );
  return { med, spread };
}

/** The five quantiles for one hour from a precomputed median/spread, or the house baseline when data is missing. */
function hourQuantiles(
  p1: number,
  h: number,
  f: { med: number; spread: number } | null,
): number[] {
  const qs = Z.map((z) => {
    if (f === null) return p1 * Math.exp(z * BASE_SIGMA * Math.sqrt(h - 1));
    return p1 * Math.exp(f.med + z * f.spread * SPREAD_MULT);
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

/** Median/spread for every hour 2..24, with medians smoothed across neighbours. */
function allHours(
  curves: Array<{ v1: number; hours: Map<number, number>; tierW: number }>,
  p1: number,
): Map<number, { med: number; spread: number } | null> {
  const raw = new Map<number, { med: number; spread: number } | null>();
  for (let h = 2; h <= 24; h++) raw.set(h, hourForecast(curves, p1, h));
  // Round-4: one pooled spread — the mean of the 23 hourly IQR spreads.
  // Per-hour IQRs are noisy (effective n ~5-10 after kernel weighting) while
  // the true conditional dispersion varies slowly with h.
  const spreads: number[] = [];
  for (let h = 2; h <= 24; h++) {
    const f = raw.get(h);
    if (f !== undefined && f !== null) spreads.push(f.spread);
  }
  if (spreads.length > 0) {
    const pooled = spreads.reduce((s, v) => s + v, 0) / spreads.length;
    for (let h = 2; h <= 24; h++) {
      const f = raw.get(h);
      if (f !== undefined && f !== null) raw.set(h, { med: f.med, spread: pooled });
    }
  }
  for (let h = 2; h <= 24; h++) {
    const f = raw.get(h);
    if (f === undefined || f === null) continue;
    const neigh: number[] = [];
    for (const hh of [h - 1, h + 1]) {
      const g = raw.get(hh);
      if (g !== undefined && g !== null) neigh.push(g.med);
    }
    if (neigh.length > 0) {
      const avg = neigh.reduce((s, v) => s + v, 0) / neigh.length;
      raw.set(h, { med: (1 - SMOOTH) * f.med + SMOOTH * avg, spread: f.spread });
    }
  }
  return raw;
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

  const fmap = allHours(curves, p1);
  const hours = c.forecast.map(({ hour }) => ({ hour, q: hourQuantiles(p1, hour, fmap.get(hour) ?? null) }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
