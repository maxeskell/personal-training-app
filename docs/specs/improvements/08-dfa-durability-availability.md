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
genuinely hard 56-min ride, not a spike or estimated-power glitch. But: (a) it is **normalized power over a
whole ride**, not a fixed-duration record; (b) it only "won" because the spike guard rejected a bogus 404 W
(2023-12-17) and a 295 W just above it; (c) avg HR **144** (max 164) is too low for that power — a likely
**power-meter calibration drift** across years.

**Fix.** Relabelled the row `Best power (≥20km)` → `Best ride power (NP)` (generator + served file), and the
`/career` "Bests vs current" card now carries a caveat: *normalized power over a whole ride ≥20 km, spike-weighted,
not a fixed-duration record — read the power-curve chart for true 5/20/60-min bests.* The value is kept, not
deleted; the honesty is in the label + caveat.

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
- `scripts/build-career-history.ts` — best-power row relabelled `Best ride power (NP)`; comment.
- `src/coach/careerPage.ts` — NP caveat under the bests card.
- `data/career-history.json` (gitignored user data) — removed the two rehearsals; synced the label.
- `README.md` — Performance-tab behaviour. Tests: `test/dashboard.test.ts`, `test/careerHistory.test.ts`.
