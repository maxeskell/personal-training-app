# 10 — AIE "durability for all run & ride workouts": probe-gated uptake plan

**Status:** ◐ AIE replied + second Mac probe 2026-08-25 — `with_dfa_alpha1` uptake shipped (thresholds
restored on list reads, summaries carry a live `id`); per-workout durability arrives via the Detail tools
as two opt-in measurements — Detail returns `{}` until AIE's rollout (the probe self-detects it; phase 2
below is the agreed design) · **Opened:** 2026-08-24 · **Owner:** Max

## Context

AI Endurance emailed (2026-08) that **durability is now available for all run and cycle workouts**. Until
now durability was DFA-α1-only, so it needed a long, steady effort with clean R-R — spec 08 measured the
resulting sparsity on this athlete's archive: **run 34/166 (20%), ride 9/255 (4%), swim 0/111**. The app
already consumes AIE's durability (`insights/metrics.ts:durabilityTrend`, fields
`aerobic_durability_according_to_dfa_alpha1_running_power_in_percent` /
`aerobic_durability_according_to_dfa_alpha1_in_percent`), trends it in the insight engine, and the
dashboard renders an honest `— no DFA-α1 yet` empty state. The update most plausibly means those slots
start filling for (nearly) every run/ride — a data change, not a tool change.

**What a web session could and couldn't verify (2026-08-24):** AIE's [Partner API wiki]
(https://github.com/ai-endurance/Partner-API-documentation/wiki) documents endpoints mirroring our 14 MCP
read tools 1:1 and a `power_is_from_hr` flag on cycling detail, but **no durability/decoupling/drift
fields anywhere** (searched verbatim); full ReDoc schemas and the whole aiendurance.com tree — site,
forum.aiendurance.com (announcements live at `/c/announcements/6`), and aiendurance.xyz — are egress-blocked
from web containers (search indexes of the forum showed nothing newer than "Edit Day", 2026-05-07; the
durability post isn't indexed yet), and there's no AIE OAuth off the Mac. So field names/shapes are unknown
→ the probe-first rule applies: **no mapper may be written until `npm run probe` shows the real keys.**
(To read the forum from future web sessions: add `aiendurance.com` to the environment's network allowlist.)

## What landed now (2026-08-24)

`npm run probe` grew the confirmation step: it samples AIE **run + ride** summary+detail (per-tool
best-effort), then prints a **field hunt** — every key matching durability / decoupling / drift / DFA /
`power_is_from_hr` / `activity_id`, its path + type (never values), and durability **coverage over the
sampled activity list** (the live re-run of spec 08's sparsity table). Scanner: `src/util/keyScan.ts`
(pure; `test/keyscan.test.ts`).

## The gate — run on the Mac, then branch on what it prints

```bash
cd /Users/maxeskell/dev/personal-training-app && git pull
cd /Users/maxeskell/dev/personal-training-app && npm run doctor   # AIE tool drift: any NEW tools named
cd /Users/maxeskell/dev/personal-training-app && npm run probe    # field hunt: keys + coverage
```

| Probe outcome | Follow-up change |
|---|---|
| **A. Same DFA fields, now densely populated** (coverage jumps toward n/n) | No mapper change — trends improve on their own. Reword the dashboard durability empty state + methods note (the "needs a long, steady effort with clean R-R" caveat from spec 08 becomes stale); re-check `durabilityTrend` minimum-N assumptions against the denser series. |
| **B. NEW durability/decoupling/drift keys appear** | Extend the `RichActivity` mapping in `metrics.ts` with the observed names (fallback-chained after the DFA fields), provenance-labelled `[ai-endurance]`; keep the in-house stream-level decoupling (`fit.ts`) as the independent cross-check per the "don't overrule the platform" doctrine. Unit test with a fixture copied from the probe report (redacted). |
| **C. Nothing new over MCP** | The feature is app-UI-only (or partner-API-only) for now: send the prepared Gmail draft to markus@aiendurance.com asking whether per-workout durability is exposed via the MCP activity tools; no code change. |

**`power_is_from_hr`** (partner-documented, cycling detail): if the hunt shows it on the MCP surface,
add a display-only honesty flag on ride analysis (estimated-power rides labelled a MODEL — same ethos as
the spec 08 NP plausibility guard). Historically blocked by the summary→detail `activity_id` join gap
(Insight_Engine_Spec §6) — the hunt reports whether `activity_id` now exists on summaries, which would
also unblock per-session detail reads generally.

## Probe result (2026-08-24) — cases B + C fired together

The Mac probe (`reports/probe-2026-08-24T11-10-14.json`) settled it:

- **The DFA-α1 VALUE fields are GONE from live summaries** — `aerobic_durability_…_in_percent` (both
  variants) *and* the `aerobic_threshold_dfa_alpha1_*` HR/W fields no longer appear on any of 20 recent
  runs or 20 recent rides. The update replaced per-workout values with **control flags**:
  `exclude_from_durability` / `exclude_from_curves` / `exclude_from_model` / `exclude_hr_data` on 20/20
  items (booleans, all currently `false`), plus **`power_is_from_hr`** on cycling summaries (matching the
  partner docs). So AIE computes durability for all workouts **in-app**, but the connector does not carry
  the number — case C for the value, case B for the flags.
- **The `activity_id` join gap persists**: summary items carry NO id key of any kind, and both
  `*ActivityDetail` tools fail on empty args (`int() argument must be … not 'NoneType'`).
- **New write tool `setActivityFlags`** appeared (doctor's drift check) — evidently the writer for those
  per-activity flags.

**Landed in response (same day):**
- `mapRichActivity` maps `powerIsFromHr` / `excludeFromDurability` / `excludeHrData`; the DFA value
  mappings STAY (archived rows still carry them — historical trends keep working).
- Honesty filters: `efTrend` drops rides with HR-derived power (EF = watts/HR on watts-from-HR measures
  the model, not fitness) and bad-HR sessions; `durabilityTrend` and `thresholdTrend` respect the
  athlete's exclude flags. Tests: `test/richActivity.test.ts` (fixtures verbatim from the probe).
- Dashboard durability row's empty state now states the real reason (connector stopped sending values,
  2026-08) instead of the stale "needs a long, steady effort" advice.
- `setActivityFlags` registered in `AIE_WRITE_TOOLS` — gated as a write, **not** proposable — so doctor's
  drift check is clean again and no code path can call it outside the write gate.

## AIE's reply + second Mac probe (2026-08-25) — both asks confirmed; flag uptake shipped

Markus (AIE) answered the emailed ask, confirming both gaps and correcting the mental model:

- **Durability is TWO measurements, not one scalar.** (a) *Internal* `durability_drift` — this session's
  internal drift (HR, DFA-α1, respiration frequency) vs the athlete's own fitted ~6-week trend at matched
  work (mean residual, position vs the confidence band, trend %-loss at the anchors, and the n of sessions
  behind the fit). Needs clean R-R → stays sparse (spec 08's coverage numbers apply to it). (b) *External*
  `within_session_durability` — sustained power / GAP pace fade along the session's own accumulated-kJ /
  GAP-km axis, plus the peak power/pace curve, % of recent best, and an effort-structure summary.
  Mechanical, no HRV → lands on **nearly every ride and run**. Both arrive as opt-in inputs on
  `get*ActivityDetail` (`with_dfa_alpha1`, `with_power_curve`) — deliberately heavy per-activity reads,
  kept OFF the list tools by design (that payload weight is what drove the summary slimming).
- **Summaries get an id** (the Detail / `setActivityFlags` join key) — and the 2026-08-25 probe shows it
  is **already live**: numeric `id` on 20/20 runs and rides, flag or no flag.
- **Usable immediately:** `with_dfa_alpha1: true` on the LIST tools restores the removed a1 fields.
  Probe-verified the same day; composes with backfill's `startDate`/`endDate` windowing.
- **Heads-up (breaking-ish, upstream):** the Detail tools will gain `with_time_series_metrics` (default
  **false**) — today they always return per-sample arrays — and the a1 scalars on Detail likewise move
  behind `with_dfa_alpha1`. Audited: nothing in this repo parses Detail payloads (splits and the power
  curve are .FIT-based; only the probe samples Detail, best-effort) — zero exposure, but any future
  Detail consumer must pass its flags explicitly (phase 2 rule 4).

**Probe measurements (2026-08-25, Mac):**

- Flagged list payloads restore the `aerobic/anaerobic_threshold_dfa_alpha1_{watts,heart_rate}_{ramp,cluster}`
  family **verbatim** — the existing mapper needed no change; `thresholdTrend` resumes for new sessions.
- `aerobic_durability_…_in_percent` (both variants) did **NOT** return — durability % remains
  archive-only until the Detail rollout.
- NEW unmapped fields under the flag: `average_of_dfa_alpha1` (18–19/20 populated) and
  `mean_of_dfa_alpha1_times_power[_or_pace][_normalized_over_two_weeks_in_percent]` (15/20 rides, 0/20
  runs). **Identity check says this is NOT durability renamed:** its coverage is inverted vs durability's
  (4% of rides / 20% of runs), and on 8 overlapping runs whose archived durability % is known, the new
  field is null. Left unmapped until AIE documents the semantics — mapping it to `durabilityPct` would
  fabricate a durability trend.
- Detail tools: callable with `{ activity_id: <id> }` (the empty-args `int()`/NoneType error is gone) but
  return a bare `{}` for every arg shape tried, flags included — the durability payload isn't rolled out
  yet, matching Markus's "I'll follow up when it's live".

**Landed in response (2026-08-25):**

- `assembleState` + `backfillActivities` pass `with_dfa_alpha1: true` on run + ride list reads (swims
  never carry a1, so the swim read stays lean); `test/aieReadArgs.test.ts` pins the arg contract so a
  refactor can't silently drop the flag — the archive is append-once, so a missed flag is a permanent
  hole in the trend history.
- `mapRichActivity` maps the summary `id`; `test/richActivity.test.ts` pins the third (flagged) payload
  era, including that the new `mean_*` fields do NOT become `durabilityPct`.
- `npm run probe` also samples the flagged list variants AND a Detail call joined on a live id with both
  flags — when the Detail sample stops being `{}`, phase 2 is buildable.
- Dashboard durability row + methods note, README session-card line, `docs/data-sources.md` parity note
  and the HANDOVER known-issue entry updated to the migration reality.

## Phase 2 — the two-measurement durability read (blocked on AIE's Detail rollout; design agreed)

Do **not** build early — the probe's Detail sample turning non-empty is the trigger. Then:

1. **On-demand Detail reads only.** Session readout + deep-dive flows fetch ONE activity's Detail
   (`with_power_curve`, plus `with_dfa_alpha1` where R-R was clean); never in the daily assemble loop —
   ~40 activities × a heavy payload is exactly what AIE's summary slimming exists to prevent.
2. **Two labelled MODEL reads, not one durability number:** external `within_session_durability`
   (near-universal) and internal `durability_drift` weighted by its sessions-behind-the-trend count; keep
   the in-house .FIT stream decoupling as the independent cross-check ("don't overrule the platform").
3. Dashboard durability row switches from the migration empty-state to the two-read rendering; revisit
   `durabilityTrend`'s minimum-N assumptions against whichever read AIE serves per sport.
4. Any Detail consumer passes `with_time_series_metrics` explicitly (false unless the flow needs samples).
5. Optional, only if wanted: `power_is_from_hr` per-session honesty labelling via the id join;
   `setActivityFlags` stays gated + not proposable until a write-path use case clears change-control.

## Definition of done for the follow-up (whichever case fires)

Green gate; fixture-driven unit test on any new mapping; dashboard text stays honest (estimates labelled,
missing data "—"); README + this spec updated with the measured post-update coverage; no write-path or
gate changes anywhere in this work.
