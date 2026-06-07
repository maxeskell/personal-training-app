# Path B — Custom orchestrator plan

> **Status:** queued. Build *after* validating Path A. All three §1 needs apply
> (unattended scheduling, glanceable dashboard, persistent decision log), so a custom
> orchestrator is justified — but only these pieces, no feature sprawl.

## Why Path B is justified here
The Build Spec §1 says build only if one of three needs bites. You confirmed **all three**:
1. **Unattended scheduling** — pushed daily readiness ping (~06:00) without opening a chat.
2. **Glanceable dashboard** — Today / Week / Trends / Race at a glance.
3. **Persistent decision log** — durable record of proposals/decisions and how calls held up.

## Architecture (local-first)
```
AI Endurance MCP (remote, OAuth)  ──►  Orchestrator  ──►  Interface
   plan of record + ML model            · assemble daily AthleteState     (Today/Week/Trends/Race)
Garmin MCP (optional, local)     ┄┄►    · readiness logic (LLM + priors)  + scheduler (push)
   5 gap metrics, degradable             · confirm-before-write           + decision log (store)
```
Solid = required (AIE). Dotted = optional (Garmin). Must be fully useful on AIE alone.

## Milestones (Build Spec §10)
- **M1 — Scaffold + MCP clients.** Repo structure, AIE client (required, OAuth), Garmin client
  (optional, degradable). Verify reads. Secrets encrypted, out of prompts/logs/repo.
- **M2 — AthleteState + store + baselines.** One record/day, **provenance per field**. Planned-vs-actual
  join, HRV-vs-baseline / RHR / sleep / weight-trend, sync-gap detection. Don't recompute what AIE trends.
- **M3 — LLM core + knowledge + guardrails.** Science as *priors* in `knowledge/sports-science.md`
  (§7), interpreted by the model. **Deterministic code only** for hard guardrails: write-gate +
  fuelling/weight limits.
- **M4 — The four flows + dated markdown reports.** Daily readiness, weekly review, gated plan-adjust,
  race prep. **This is the product** — meets the §9 acceptance criteria.
- **M5 — Scheduling + dashboard.** Both apply: a pushed 06:00 readiness ping, and a glanceable
  Today/Week/Trends/Race view. Decision log (need #3) lands as part of M2/M4's store + M4 reports.
- **M6 — Harden.** Garmin-breakage handling, AIE tool-change tolerance, secret hygiene, decision-log review.

## Hard guardrails (enforced in code, non-negotiable)
- **Write-gate:** no AIE write tool (`changeWorkoutDate`, `skipWorkout`, `create*Workout`, `setZones`…)
  fires without explicit per-action confirmation. No autonomous plan rewrites.
- **Wellbeing:** fuel to train; use AIE ranges. **Never** recommend deficits / restriction / "race weight."
  Weight = trend, secondary, never a daily target. **No clinical-syndrome detection** — co-occurring
  risk signals → raise gently + refer to a professional; don't label RED-S, don't treat loss as a win.
- **Reliability:** Garmin optional/degradable — on failure, say so, fall back to AIE, ask for pasted
  numbers, never guess. Tolerate AIE tools changing/disappearing.

## Acceptance criteria (Build Spec §9)
1. AIE connects; daily state assembles with correct provenance; sync gaps surfaced.
2. Readiness = green/amber/red on a **trend** that doesn't flip on one bad night; black-box scores tiebreak only.
3. Weekly review leads with the takeaway.
4. An auto-write attempt is **blocked** without confirmation.
5. Race prep adapts by event + time-to-race; explicitly surfaces Alderford decision + run-load caution.
6. Garmin-down degrades cleanly.
7. A restriction-implying nutrition prompt is redirected to adequate fuelling.
8. Every output cites its data.

## Outcome metrics (the actual point)
Arrive at Birmingham and Loch Ness **uninjured** and on/above predicted time; run-volume ramp stays in
safe bounds with no flare; health-risk signals never missed; "this coached me well."
**Explicitly NOT** engagement/% days acted on — that rewards dependence, which is a failure mode.

## Stack decision (TBD before M1)
To be chosen when we start M1 — candidates: TypeScript/Node (good MCP SDK support) or Python (matches
the Garmin client ecosystem). Local-first, simple store (SQLite or flat files + git), thin interface.
