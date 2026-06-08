# Phase 2 plan — Health / injury-risk slice

Phase 1 (PRs #12/#14/#15) delivered the rigorous n=1 analytics layer, the interactive top-5 insights
box, zones/FTP/splits, and signal-gating — all on data we already pull. Phase 2 is the **ingestion-
dependent** backlog. This doc scopes the first slice and the data needed to build it against real shapes.

## Decisions (agreed)

1. **First slice: Health / injury-risk.** Highest day-to-day actionability for the marathon block.
2. **Streams are `.FIT`-canonical.** AI Endurance's activity *detail* appears not to be reliably joinable
   back to activity summaries (no stable `activityId`), so all within-session/stream work (biomechanics,
   temperature, pace-at-HR, MMP) will be sourced from `.FIT` files, not AIE detail. (The `probe` confirms
   the join keys empirically.)
3. **Build against real samples**, not dormant guesses — see "Data to capture" below.

## Slice 1 detectors (planned)

Each ships as a deterministic, synthetic-testable module (like Phase 1) + a thin Garmin mapper:

| Detector | Catalogue | Source | Signal |
|----------|-----------|--------|--------|
| Impact-load vs running tolerance | A14 / #42 | Garmin (per-activity / daily) | acute musculoskeletal load exceeding tolerance → injury-risk flag |
| Respiration + sleep-stage illness early-warning | #41, G7 / #37 | Garmin daily | overnight respiration rise + deep-sleep drop (± skin-temp) preceding RHR/HRV → pre-symptomatic illness |
| All-day stress trend | #40, G6 | Garmin daily | chronically elevated daytime stress alongside training = total-life load red flag |
| Body-Battery recharge/drain **rates** | #38/#39, G5 | Garmin daily/intraday | slow overnight recharge / steep drain — the *rate* is the signal, not the level |
| Recovery-time vs actual gap to next hard session | #32, F9 | Garmin + activities | stacking hard work inside the recovery window = the overreaching mechanism |

All gate on minimum coverage and self-label confidence, consistent with the existing engine.

## Data to capture — run `npm run probe`

`npm run probe` (added here) connects to your live Garmin MCP, lists the **tool surface**, captures **one
sample payload per tool** (trying common arg shapes), and also grabs AIE `getRunningActivity` vs
`getRunningActivityDetail` + `getUser` to confirm the activityId join and the zone/FTP field names. Output
goes to `reports/probe-<date>.json` (gitignored — it's your own health data).

What I need from the output to build slice 1:
- The **Garmin tool names** for respiration, all-day stress, sleep stages, Body Battery (time-series, not
  just the categorical level), training status/load, and any "training readiness / acute load / running
  tolerance" tool — plus their field shapes.
- One **`.FIT` file** (or pre-extracted per-second JSON per `FIT_STREAMS_DIR`) from a recent run, so we can
  lock the stream schema for the later biomechanics/temperature slices.

Review/redact the probe file as you like, then share it back and I'll write the mappers + detectors.

## `.FIT` decoder — built & verified

A dependency-free `.FIT` decoder (`src/insights/fitParser.ts`) is in, verified against the athlete's own
FR970/Edge files (power=7, cadence=4, temperature=13, HR=3, enhanced_speed=73, distance=5, altitude=78;
dual-sided pedal dynamics 30/43–46 present). `FIT_STREAMS_DIR` now reads raw `.FIT` directly. First live
signals from it: **aerobic decoupling** (power/speed:HR first-half vs second), **per-activity temperature**
(heat confounder input), plus the run-biomechanics decay (activates on a run `.FIT`).

Still needed to extend this: a **run `.FIT`** (ideally HRM-600) to confirm running-dynamics field numbers
(vertical_oscillation=39, stance_time=41, vertical_ratio=58, step_length=85) against real data.

## Deferred to later Phase 2 slices

Performance numbers (FTP power-curve / MMP, pace-at-HR in comparable conditions, run-vs-bike VO2
divergence), the full temperature-confounder wiring (join per-activity `.FIT` temp to the EF/threshold
comparisons), and the Garmin daily health metrics (await the probe). Sequenced after the run-`.FIT` schema
is confirmed.
