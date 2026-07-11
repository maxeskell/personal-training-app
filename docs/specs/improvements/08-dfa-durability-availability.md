# 08 — DFA-α1 durability availability, best-power honesty, race-list audit

Three related data-honesty fixes, all diagnosed from the athlete's own data on 2026-07-11.

## 1. "DFA-α1 durability keeps coming up blank"

**Diagnosis — it is a source-availability limit, not an app bug.** DFA-α1 durability is AI Endurance's
number (the app consumes it in `insights/metrics.ts:durabilityTrend`, it never recomputes it — Garmin does
**not** compute DFA-α1 at all). AIE only emits a durability % for **long, steady efforts with clean R-R**,
so it is blank far more often than not. Measured coverage across the archive:

| Sport | Sessions with DFA-α1 durability | Driver |
|---|---|---|
| Run | 34 / 166 (**20%**) | ≥60 min → 56%; <45 min → 6% |
| Ride | 9 / 255 (**4%**) | present rides averaged **134 min**; absent averaged 68 min |
| Swim | 0 / 111 (**0%**) | no R-R recorded in water |

Retrieval was proven working (field names in the archive are byte-identical to what the code maps; the live
insight engine returns non-null run + ride durability; the dashboard recomputes live). So a blank is the
*expected* empty slot for a swim, most rides, a short run, or a session without a qualifying long steady effort.

**Fix (display honesty).** The "Load & trends" durability row used to **vanish** when a sport had no value —
which reads as "broken". It now renders an explicit `— no DFA-α1 yet — needs a long, steady effort with clean
R-R` row, and the methods note states the sparsity. No recompute, no new dependency. Building a local DFA-α1
estimator from the FIT R-R stream was considered and **declined** (fights the "defer to AIE" doctrine, unproven
that the FITs even carry R-R, hard to validate n=1; the real lever is longer strapped sessions).

## 2. "Best power (≥20 km) 267 W — I don't trust it"

**Diagnosis — the number is arithmetically real but a poor benchmark.** Parsing the raw 2022-07-17 `.FIT`:
true avg **229 W**, NP **266 W**, median 264 W, 20-min best 255 W, 30% of the ride >300 W. So it is the NP of a
genuinely hard 56-min ride, not a spike — but the **power is corrupt**. Decoding the FIT left/right balance
settled it: 2022-07-17 rides at **32/68** and EF (W/bpm) **1.85**, 2022-07-31 at **31/69 / 1.97**, 2023-12-17 at
**26/74 / 2.91** — while every other ~40 rides in that era sit at a normal ~50/50 and 1.0–1.5. A right-side
sensor over-read inflates total power ~1.5–2×, which is exactly why the HR (144) looked "too low": the HR was
right, the watts were wrong. These are the **574019 "GarminPing" export corruption** (see the sibling
`power-curve.ts` guard, commit `f94c0f8`) — the same three rides that had poisoned the all-time power curve.

**Fix (two steps).** First relabelled the row `Best power (≥20km)` → `Best ride power (NP)` with a caveat.
Then, once confirmed corrupt, added a **plausibility guard** to `bestPower()`: rides whose whole-ride NP/HR
exceeds **1.7 W/bpm** are dropped (genuine tops out ≈1.55; the corrupt rides are ≥1.85). This screens the
meter-inflated rides the p90×1.25 spike guard couldn't — they aren't lone spikes, the whole stream reads high.
The row now shows the athlete's **genuine best: 230 W NP (2016-09-18)**. Regenerated `data/career-history.json`
(28 races preserved, power curve re-guarded).

## 3. Race-list audit — garage rehearsals miscounted as races

The race list is **hand-curated** (the generator never auto-adds races), so mislabels persist. Cross-checking
every race date against Garmin's GPS-derived activity name + indoor/outdoor type + disciplines (home base =
Lea Marston 52.538,-1.701; Tamworth/Water Orton/North Warwickshire = home; Sutton Park/Dorney = claimed venues):

| Date | Was listed as | Garmin actually recorded | Action |
|---|---|---|---|
| 2025-07-20 | Olympic tri · Sutton Park | `indoor_cycling` "Indoor Cycling" 40 km + home run 6.3 km + Tamworth swim | **removed** (garage rehearsal) |
| 2025-09-21 | Standard tri · Dorney Lake | home cycling 45.3 km + Tamworth swim, no run, no travel to Dorney | **removed** (home brick) |
| 2016-07-03 | Standard tri · Bosworth | single "Water Orton" cycling 45.8 km, no swim/run | **kept, flagged** — ambiguous (possible real race with partial sync) |

Race count 31 → **29**. The other Garmin-era races each have a real multi-sport activity at the claimed venue.
This corrects the earlier "31 races audited complete vs Garmin" note, which caught *missing* races but not
these *mislabelled non-races*.

## Files touched

- `src/coach/dashboard.ts` — durability row renders an honest note when null; methods note updated.
- `scripts/build-career-history.ts` — best-power row relabelled `Best ride power (NP)`; **plausibility guard** (drop rides with NP/HR > 1.7 W/bpm, i.e. the 574019-corrupt rides) so it shows the genuine 230 W.
- `src/coach/careerPage.ts` — NP caveat under the bests card.
- `data/career-history.json` (gitignored user data) — removed the two rehearsals; synced the label.
- `README.md` — Performance-tab behaviour. Tests: `test/dashboard.test.ts`, `test/careerHistory.test.ts`.
