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

## Probe results (2026-06-08) — 122 Garmin tools

The first probe mapped the full surface but had two bugs (now fixed): it recorded validation-errors as
"captured" for tools needing args, and it called mutating tools. Fixed: the probe now skips non-`get_`
tools, treats error responses as "keep trying", and fetches a real `activity_id` for per-activity tools.
**Re-run `npm run probe` and re-share** to capture the health-tool shapes (they all need `{date}` /
`{start_date,end_date}`).

Confirmed shapes already wired in:
- `get_cycling_ftp` → bike FTP (223 W). `get_lactate_threshold` → run LTHR (165), run threshold power
  (338 W, FR970 running power), weight, and a run threshold speed (reported ~10× low — normalised).
  Both now feed the zones/threshold cards (Garmin wins over the AIE `getUser` guess).

Health/injury slice — BUILT (slice 1a, from the fixed probe's real shapes):
- ✅ **Acute:chronic load / training status** (`get_training_status`): ratio, ACWR status, status label
  → overtraining/injury flag (brief Q2). Garmin computes the ratio natively. *(Live data currently shows
  OVERREACHING, ratio 1.7, ACWR HIGH → fires a flag.)*
- ✅ **HRV status vs personal baseline band** (`get_hrv_data`) → recovery finding (surfaced only when not
  balanced). Both mapped into AthleteState, surfaced on the dashboard Today card + `ask`.

Health/injury slice — BUILT (slice 1b):
- ✅ Daily backfill + `GarminDay` extended to archive the health series: `get_sleep_data` (deep/REM/light/
  awake stages, skin-temp deviation, overnight HRV, RHR, Body-Battery change, sleep respiration, score),
  `get_all_day_stress`, `get_respiration_data`, and a bulk `get_body_composition` (muscle mass / body fat).
- ✅ Trend detectors (`garminTrends.ts`), all rolling-baseline / personal-norm:
  **illness early-warning** (respiration + skin-temp [+ RHR] stacking), **all-day stress trend**,
  **Body-Battery recharge** decline, **deep-sleep decline**, and **fuelling** (weight + muscle both down,
  now fed real `get_body_composition` muscle mass).

⚠️ **Populating history:** the daily backfill is resumable and *skips dates already archived*, so the
existing ~1,289 days (fetched with the old sleep-summary path) don't yet carry the new fields. New days
accrue them automatically; to backfill history now, re-grind:
`rm data/archive/garmin-daily.jsonl && npm run backfill -- --daily-only` (throttled/resumable). The trend
detectors need ≥21 days with the new fields before they fire.
- ✅ **`get_activity_fit_data` → `npm run fit-sync`** (BUILT): pulls recent Garmin run/ride .FIT files
  programmatically and writes them to the streams dir (default `data/fit-streams`), where the engine
  analyses them automatically — no manual uploads. Decoder handles base64 in any of the likely MCP
  shapes (verified). Also fixed the probe's activity-id extraction (`id`, not `activityId`) which had
  blocked sampling all per-activity tools.
- ✅ **Temperature confounder** (BUILT, `heat.ts`): estimates the athlete's heat sensitivity (% EF change
  per °C) by regressing EF on per-activity `.FIT` temperature, and attributes how much of a recent EF dip
  is heat vs lost fitness — the #1 validity fix. Verified on synthetic data (−0.6%/°C recovered).
- Bonuses still queued: `get_power_duration_curve` (MMP) + `get_endurance_score`/`get_hill_score`
  (shapes confirmed — next); `get_activity_splits`/`_typed_splits` (transitions + per-leg pacing) and
  `get_activity_weather` still show NO DATA in the probe (blocked by the old activity-id bug, now fixed)
  → need ONE more `npm run probe` re-run to capture their shapes.

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
