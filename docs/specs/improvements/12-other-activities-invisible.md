# 12 — Hikes, strength and other activities were invisible to the app (9 Sep 2026)

**Status:** ✓ landed 2026-09-09 · **Opened:** 2026-09-09 · **Owner:** Max

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

## Deliberately NOT done

- **No deep readout for hikes/strength.** `fit-sync` still pulls `.FIT` files for run/ride/swim/multisport
  only, and the biomechanics/power-curve parsers are built for those. Extending the dive to hiking would
  mean a new parser path and a new prompt; the honest "named, not analysed" note is the right end state
  until that is wanted.
- **AIE's load model was never wrong.** `getRecoveryModel` already included the walks' stress; nothing about
  CTL/ATL/TSB changes here (rule 7.2: never re-derive the load science).

## Open

- Confirm on the Mac what `act_type` AI Endurance assigns to a planned "Hill Walking" / "Shoulder Rehab";
  if it is a stable value, add it to `SPORT_FROM_ACT` so the title regex is a fallback, not the path.
