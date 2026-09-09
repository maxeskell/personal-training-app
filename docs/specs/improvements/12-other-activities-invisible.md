# 12 — Hikes, strength and other activities were invisible to the app (9 Sep 2026)

**Status:** ✓ phase 1 landed 2026-09-09 (ingest + honest surfaces); ✓ phase 2 same evening (a hike gets the
deep session readout) · **Opened:** 2026-09-09 · **Owner:** Max

## Symptom

After three days of hill walking in Gwynedd (7–9 Sep, ~3.8 h and 800–1050 m of climb each) the dashboard
still read "Last session — 09-06 Ride" under a fresh "Data last updated Wed 9 Sep 2026, 16:58 · just now",
the header said "Latest ingested workout Sun 6 Sep", and the planned "Hill Walking · 120 min" on Today
carried an "indoor — no weather rules for this session type" tag and never went ✓ done. Meanwhile the
readiness card showed form (TSB) −50 "deep fatigue" and "Fitness ramping fast" — the fatigue the walks
caused, with the walks themselves nowhere on the page. `npm run doctor` was 0 fail / 0 warn and
`npm run state:today` reported `planned sessions: set`, `actual activities: set`.

## Root cause

`assembleState` read exactly three activity lists from AI Endurance — running, cycling, swimming.
AI Endurance's MCP v1.2.0 (2026-08-25) added `getOtherActivity` for everything else (hiking, rucking,
strength, climbing, plus the seconds-long T1/T2 transitions of a multisport race). The tool was registered
in `AIE_READ_TOOLS` the day it appeared (doctor drift) but nothing called it, so any non-run/ride/swim
session was simply absent from `actualActivities`, from the raw payload the freshness line scans, and
from the done-matching on Today. A live read on 9 Sep returned 13 such activities back to June, including
two shoulder-rehab strength sessions and a bouldering session, none of which the app had ever seen.

Two smaller gaps compounded it:

- Planned sessions were typed from `act_type` alone, so a "Hill Walking" or "Shoulder Rehab" filed under a
  generic type landed as `Other` — unmatchable against any actual, given no weather verdict, and (the rehab)
  handed a race-day gel plan because only `Strength` is skipped by the fuelling builder.
- The "Last session" line and card had no notion of "something newer was logged but has no readout": the
  deep dive needs a raw `.FIT` and covers run/ride/swim only, so the days-old ride stayed "last".

## Fix (this repo)

1. **Read it.** `["getOtherActivity", {}]` joins `AIE_STATE_READS`; `collectActivities` maps the rows with
   `otherActivitySport(activity_type)`: `hiking`/`walking`/`rucking`/`trek` → `Hike`,
   `strength_training`/`training`/`gym` → `Strength`, `transition` → dropped, else `Other`. Every actual
   now also carries `type`, `name`, `elevationGainM` and `ess` (all optional; a null distance stays unknown).
2. **Type it.** `ActualActivity.sport` and `PlannedSession.sport` gain `Hike` (actuals also `Strength`).
   `plannedSport(act_type, title)` classifies a generic act_type from the title words.
3. **Show it honestly.** `latestWorkout` scans `getOtherActivity` too (transitions excluded). The Today
   last-session line and the Last-session card append *"Since then: 09-09 Hike · Gwynedd Rucking · 3h 49m ·
   11.7 km · +1047 m; …"* (newest first, up to three) whenever activities post-date the readout, with the
   reason (no `.FIT` dive for that sport). The 7-day load table gains a `Hike` row automatically.
4. **Judge it outdoors.** `assessWeek` gives a `Hike` the on-foot rules (thunder, ice, heat; "walkable in any
   weather"), and a logged hike marks the planned walk done. The coach execution note stays null for hikes
   (no run/ride intent to coach); fuelling keeps its plan for a hike (hours on foot) and now skips a rehab
   correctly classified as `Strength`.

Tests: `test/assemble.test.ts` (fixture = the live 9 Sep payload; transitions dropped, fields mapped,
classifiers), `test/weather.test.ts` (hike verdict + done), `test/dashboard.test.ts` (done state, freshness
line ignores a stray transition, load row, "Since then" on both surfaces and its absence when nothing is
newer).

## Phase 2 — the hike readout (same day, on request: "deep analyse all three hikes")

Phase 1 named a hike but couldn't analyse it. Phase 2 puts a hike through the same deep-dive pipeline as a
run or ride, without pretending it *is* one:

1. **`richActivities` reads the hike rows** of `getOtherActivity` (`HIKE_TYPE_RE`: hiking/walking/rucking/
   trekking) as sport `Hike`, carrying `name`, `distanceKm`, `elevationGainM`. Strength, climbing and
   transitions stay out of the readout pipeline (nothing a session dive can read). Every consumer of the
   rich list is sport-filtered (run ramp, EF/durability/threshold trends, FTP diagnosis) except the daily
   ESS sum for the sleep→load correlation — where a hike's stress *should* count.
2. **`fit-sync` pulls hike `.FIT` streams** (`isStreamCandidate` + `sportOf` know hiking/walking/rucking),
   so the auto-feedback at sync — which only generates once the raw stream is local — picks hikes up, and
   the `.FIT` decay joins a hike whether the watch tagged it hiking (17) or walking (11).
3. **The model reads a hike on its own terms.** `buildSessionContext` emits a HIKE block instead of the
   power-efficiency / DFA-α1 lines: judge it by HR vs zones, HR drift late-vs-early (the durability signal
   on feet), ESS against the athlete's *hike* norm (`comparable` is same-sport, so the three Gwynedd days
   norm against each other), distance + elevation gain, and consecutive-day accumulation. Speed÷HR
   decoupling is reported but explicitly labelled terrain-driven; run dynamics (GCT etc.) are not read; the
   absent DFA/power fields are declared absent so the model doesn't flag them as a data gap. No Detail
   durability fetch is attempted (no AIE Detail tool for a hike).
4. **Surfaces:** the Last-session card and switcher now include hikes; the dashboard `/session-feedback`
   route accepts `sport=Hike`; the "Since then" note treats a hike as readout-pending rather than
   un-analysable.

Tests: `test/richActivity.test.ts` (hike rows in, strength/climb/transition out), `test/fitsync.test.ts`
(hiking/walking are stream candidates), `test/session.test.ts` (latest hike picked, prior hikes form the
norm, hiking- and walking-tagged decays join, the HIKE context block and the absent power/GCT lines).

**Reading the three Gwynedd days honestly.** Three consecutive ~3.8 h hikes at ESS 152/178/178 on a CTL
of ~31 is roughly double the athlete's normal daily stress three days running; the readouts should say so
in the light of the TSB on each day, and the coach should treat the block as a load event, not three easy
walks. That is what the HIKE block asks the model to do.

## Deliberately NOT done

- **Strength / climbing readouts.** Nothing in a strength or bouldering `.FIT` maps onto this pipeline's
  signals; they stay named-not-analysed.
- **AIE's load model was never wrong.** `getRecoveryModel` already included the walks' stress; nothing about
  CTL/ATL/TSB changes here (rule 7.2: never re-derive the load science).

## Open

- Confirm on the Mac what `act_type` AI Endurance assigns to a planned "Hill Walking" / "Shoulder Rehab";
  if it is a stable value, add it to `SPORT_FROM_ACT` so the title regex is a fallback, not the path.
