[![make.fun](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/annaroano1-sys/gta6-twitch-ccu-forecast-01/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/annaroano1-sys/gta6-twitch-ccu-forecast-01/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)

# GTA VI Launch-Day Twitch Viewers — Hour-by-Hour Quantile Forecaster

Forecasts how many people watch Grand Theft Auto VI live on Twitch in each
hour of its release day (2026-11-19 UTC), as five quantiles (5%, 25%, 50%,
75%, 95%) per hour, from everything recorded up to the end of the day's
first hour. Built for the [make.fun bounty](https://make.fun/bounty/gta6-twitch-ccu-forecast-01).

## How it works

`main.ts` (Node 22, standard library only, no network, deterministic) reads
the case file (`/input/<id>.in`) and writes `/output/<id>.out`.

The method is fitted from the case file's own comparables — 38–42 past big
game launches with full release-day hourly curves:

1. For each past launch and hour `h`, take the log-ratio
   `r(h) = ln(viewers(h) / viewers(1))`.
2. A launch's rise through the day depends strongly on how big its hour-1
   print already is (correlation between `ln(hour-1)` and `r(h)` reaches
   −0.93 by hour 21: a launch already huge at 00:00 UTC rises little, a
   small hour-1 print rises a lot as the US audience joins after
   05:00–08:00 UTC). So per hour we estimate a **scale-local median** of
   `r(h)`: a weighted least-squares regression of `r(h)` on `ln(hour-1)`
   (Gaussian kernel weights, bandwidth ramping 2.2 → 1.3 with the hour,
   since the size→rise link strengthens through the day; regression slope
   inflated ×1.1 as a regression-dilution correction), centred by adding
   the kernel-weighted median of the residuals around the slope-inflated
   fit at each curve's own `ln(hour-1)`. Neighbouring hours share
   information (median smoothed 50% across h−1/h+1).
3. The spread is ONE pooled value for all hours: the mean of the 23 hourly
   kernel-weighted interquartile ranges of `r(h)` / 1.349, scaled by 0.8.
   Per-hour IQRs are noisy (effective n ~5–10 after kernel weighting)
   while the true conditional dispersion varies slowly with h, so pooling
   removes noise. An honest spread, since pinball loss punishes a band
   that is too narrow and one that is too wide alike.
4. Tier weights from each comparable's unlock note: `comparable` 1.0,
   `early-access-contaminated` 0.5, `weak` 0.5, `target-history` 0 (the GTA
   VI category's own pre-release history is not a launch curve).

Quantiles: `q = p1 * exp(median(h) + z * spread(h))`, with
`z = [-1.645, -0.674, 0, 0.674, 1.645]`, `p1` the hour-1 print.

## Practice results (local scoring, mean pinball loss on log scale)

| Case | This forecaster | House baseline |
|---|---|---|
| Marvel's Wolverine (p00) | 0.172 | 0.744 |
| Red Dead Redemption 2 (p01) | 0.219 | 0.287 |
| God of War Ragnarök (p02) | 0.128 | 0.215 |
| Marvel's Spider-Man 2 (p03) | 0.177 | 0.303 |
| **Mean** | **0.174** | **0.387** |

Typical miss 21–47% (baseline 42–189%), 90% coverage 0.91–1.00.
Leave-one-out over the 37 usable comparables: **0.371** vs baseline 0.93
(0.374 in round 4); 2×-anchor stress (hour-1 inflated 2× on the five
largest launches): 0.273 vs 0.322 in round 4; 1.5×-anchor: 0.165 vs 0.176.
Round-5 changes: bandwidth 1.6/1.0 → 2.2/1.3, spread multiplier 0.85 → 0.8,
median smoothing 0.25 → 0.5 — see `main.ts` header and
`validation/r5-notes.md` for the full experiment log (launch-type
conditioning on the new centre, residual trimmed-mean centre, quadratic
fit, residual-based pooled spread, extrapolation damping — all rejected by
the both-practice-and-LOO rule).

Run locally:

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License

MIT — see [LICENSE](LICENSE).
