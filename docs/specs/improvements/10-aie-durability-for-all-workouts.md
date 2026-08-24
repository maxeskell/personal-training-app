# 10 — AIE "durability for all run & ride workouts": probe-gated uptake plan

**Status:** ◐ probe run 2026-08-24 — flag uptake landed (see "Probe result" below); per-workout durability
VALUES are not exposed over the connector, so the value side waits on AIE · **Opened:** 2026-08-24 · **Owner:** Max

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

**Still open (owner: AIE):** the emailed ask (Gmail draft to markus@aiendurance.com) — expose per-workout
durability values over the connector, and an activity id on summaries so the Detail tools become callable.
When values reappear: extend the mapper with the observed names, revert the dashboard row text, and record
the measured coverage here.

## Definition of done for the follow-up (whichever case fires)

Green gate; fixture-driven unit test on any new mapping; dashboard text stays honest (estimates labelled,
missing data "—"); README + this spec updated with the measured post-update coverage; no write-path or
gate changes anywhere in this work.
