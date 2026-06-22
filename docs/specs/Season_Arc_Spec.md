# Season Arc — multi-season strategic review (spec)

## Problem (PM framing)

The coach is excellent at the **tactical** layer — today's readiness, this week's sessions, fuelling, gated
plan changes. It has **no strategic layer**. The athlete is rebuilding toward **70.3 → Ironman over multiple
seasons**, and that outcome is decided by things the daily loop can't see:

- **Chronic load raised patiently, year over year** (CTL trend), not within one block.
- **Consistency** — avoiding the detraining cliffs (the athlete's own history: 390 h in 2013 → 42 h in 2019).
- **Structural levers** that only pay off over seasons: swim technique, a threshold-band shift, strength
  (lean mass/bone — acute on a GLP-1), biomechanics, recovery.

A one-off AI analysis is brilliant once and then decays as the data moves. The daily readiness call is too
myopic to hold a 3-year arc. **The missing primitive is a written multi-year plan + a recurring review that
grades the athlete against it and against their own history.**

## Goal

A read-only **`/season`** page (and the data behind it) that answers, every time it's opened:
*where am I in the multi-year build, am I building or stalling, what is this phase's one focus, and what is
the multi-season risk* — grounded in the athlete's **own** numbers, not generic periodisation.

## Non-goals (this MVP)

- Not a workout generator or a plan writer (AI Endurance owns the day-to-day plan; writes stay gated).
- Not an LLM flow yet — the MVP is **deterministic** (honest models; deterministic views make no LLM call).
  An optional LLM narrative on top is a documented next increment.
- No new live-number storage — CTL/weight/FTP stay live; the plan holds only *intent*.

## Inputs (all already in the app)

| Input | Source |
|---|---|
| Multi-year plan (horizon goal, dated phases + CTL targets, per-phase focus) | `profile.season_plan` (gitignored, user-authored) |
| Current chronic load + trend | `AthleteState.load.ctl` now + `StateStore.series()` over a window |
| Historical benchmark (year-by-year hours/km — the 2013 peak, the 2019 trough) | `career-history.json` → new `trajectory` block (built by `build-career-history.mjs`) |
| Lifetime PBs vs current, race log | `career-history.json` (already built) |
| Structural-lever context (strength/wk, medication, biomechanics, bloods age) | `profile` |

## The model (deterministic engine — `buildSeasonArc`)

Pure function → `SeasonArcReport`, every section degrading independently to "—" when its input is absent:

1. **Phase position** — pick the active phase by date; days to the next phase boundary and to the next A-race.
2. **Chronic-load trajectory** — current CTL; trend (rising/flat/falling) from the CTL series; gap to the
   active phase's `ctl_target`; and, if `trajectory` is present, where today's CTL/volume sits vs the
   athlete's **all-time peak year** and recent years. The headline number to hold over years.
3. **Consistency** — from `trajectory`: a simple ratio of recent annual volume to the rolling baseline, with
   a **cliff flag** when it drops hard (the 2017→20 pattern). The single biggest multi-season risk.
4. **Lever checklist** — one honest line each, derived from real fields:
   - *Swim* — is there any recent swim / a swim PB? (the named blind spot)
   - *Strength* — `health.strength_sessions_per_week` vs a 2–3×/wk target (lean mass/bone on a GLP-1)
   - *Bloods* — age of the latest panel (flag if > 12 months / stale)
   - *Threshold band* — a note to shift power toward 20–60 min (read-only prompt; no live FTP stored)
5. **Focus + flags** — a deterministic "this phase, do X" line and any red flags (CTL falling toward a race,
   consistency cliff, stale bloods, no swim).

## Surfacing (MVP)

- **`/season` page** — mirrors `/career`: own route, pure renderer, best-effort load, share-aware
  (no identifying data on this page, so share view is a near-noop), linked top-left of the dashboard next to
  Career & PBs.
- **Empty state** — when no `season_plan` is set, the page explains how to add one (profile block + question).

## Honesty rules (CLAUDE.md)

- Everything shown is the athlete's own recorded number or their own stated plan; CTL/load are labelled the
  platform's MODEL. No targets are invented — they come from `season_plan`.
- Degrade, don't crash: any missing input → that row reads "—" with a one-line "how to fill it".
- Deterministic: the page makes **no LLM call** (cost model). The optional narrative (future) would be a
  `season` CLI/MCP deep-flow at `effort: high`, grounded in this same report.

## Definition of done

Code + docs together; `npm run typecheck` + `npm test` green (engine + page unit-tested, the new profile
field exists in the example, the questions doc regenerated); committed, pushed, draft PR, merged.

## Increments

1. ✅ **Shipped** — `npm run season`: an LLM strategic narrative grounded in the deterministic report
   (`seasonNarrative.ts` + `seasonReportText`), one high-effort cost-logged call, saved to `reports/`;
   degrades to the deterministic digest with no API key.
2. _Next_ — a `season_arc` MCP tool exposing the same narrative to Claude.
3. _Next_ — a quarterly **nudge** (the review cadence) via the existing notify/ping path.
4. _Next_ — auto-suggested phase CTL targets from the trajectory (propose→confirm), instead of hand-set.
