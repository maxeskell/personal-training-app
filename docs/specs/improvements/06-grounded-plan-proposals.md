# Spec 6 — Grounded plan proposals (use the full picture + goals + research)

**Status:** ✅ landed on `main` (reconciled 2026-06-22; §3 read-back gap closed 2026-06-24) · **Priority:** P1 (feature; do after Spec 2) · **Size:** M–L · **Owner:** TBD

## Problem
"Turn this into a plan change" reads as *"design my plan from all my data, my goals, and the research."* Today it's a
single structured LLM call grounded in: the **surfaced findings** + a small load/recovery context + the athlete's
**planned sessions** + the **static persona/science** system prompt. That's solid but **partial**:
- It does **not** pass the full analytical picture — durability trend, heat confounder, EF, **race countdown / taper
  target**, predictions-vs-goal — so it can't reason "you're 33 days from your A-race and overreached."
- **Race goals/dates are hard-coded** into prompts (and going stale) instead of pulled live from AI Endurance goals.
- There's **no research grounding at proposal time** beyond the static `knowledge/sports-science.md` priors + what the
  engine's detectors already encode (the "research is code" model). No citation/lookup, so the athlete can't see *why*.

## Goals
- Proposals reason over the **whole** athlete picture (load/form + the relevant detector outputs + recovery + the
  dynamic race calendar + taper target), not just the triggering finding.
- Race facts (events, dates, priorities, predictions) come **dynamically** from AIE goal data.
- Each proposal cites the **specific signals** (and, optionally, the science prior) it's based on, so the trade-off is legible.

## Non-goals
- Live web research / external citations in v1 (optional v2 behind a flag; the LLM has no web tool today and adding one
  expands the prompt-injection surface — gate it).
- Removing the human confirm (Spec 2 stays in force; this only enriches the *input* to the proposer).

## Current behaviour (file:line)
- `server.ts` `/act` builds the request from `alertFindings(topFindings)` + a 3-line load/ACWR/limiter context.
- `coach/planAdjust.ts:62–87` `proposeAdjustments(llm, request, today, context)` adds planned sessions + a hard-coded
  "Alderford capped-tempo / marathon run-load" caution; system prompt = persona + science (`coach/persona.ts`).
- Race goals exist in `state.raw.getRaceGoalEvent` and as `insights.predictions` / `insights.taper`, but aren't passed to the proposer.

## Proposed design
1. **Rich proposer context object** (build once, pass into `proposeAdjustments`): TSB/CTL/ATL + ramp **with bands**,
   acute:chronic + training status, recovery limiter, HRV status, the **relevant detector findings** (durability,
   heat, EF, fuelling), the **next races** (name/date/priority/days-to from AIE goals), **predictions-vs-goal**, and the
   **taper target** for the imminent race. Reuse `coachHeadline` as the one-line frame.
2. **Dynamic race calendar**: replace the hard-coded race lines in `planAdjust`/`readiness`/`weekly`/`racePrep` with a
   shared `raceContext(state)` derived from `getRaceGoalEvent` (+ a guard for stale/empty).
3. **Cited rationale**: extend the proposal schema with `basis: string[]` (the signals/prior ids the change rests on);
   surface them in the confirmation ("because: acute:chronic 1.7 HIGH; 33 d to A-race; taper target TSB −5…+5").
   *(2026-06-24) Closed the read-back half: `basis` was shown at propose time but dropped at the gate, so it
   was gone by confirm time. It now persists on `Proposal`/`DecisionRecord` and renders on the read-back
   confirm surfaces — `decisions pending` + the decision log (CLI) and the `decisions` MCP tool — so the
   "because:" line survives across processes (the cross-process confirm path), satisfying criterion 3 below.*
4. **(v2, flagged) research lookup**: a curated retrieval over `knowledge/` (and optionally web, behind `COACH_RESEARCH=1`)
   that attaches 1–2 citations; treated as untrusted data per Spec 2's injection hygiene.
5. Depends on **Spec 2** (validated args + readable confirmation) so richer/longer proposals can't widen the unsafe surface.

## Acceptance criteria
- A proposal generated during the marathon block references the **race countdown and taper target** in its trade-off.
- Changing the athlete's races in AIE changes the proposer's context with **no code edit** (no stale hard-coded dates).
- Each proposal lists the concrete signals it's based on; the confirmation shows them.
- Token budget stays within one cached-system-prompt call; latency unchanged within tolerance.

## Test plan
- `raceContext`: from a fixture `getRaceGoalEvent`, yields sorted upcoming races + days-to; empty/stale → safe default.
- Proposer context builder: snapshot test that durability/heat/taper/predictions appear when present and are omitted when absent.
- The `basis` array is populated and references real finding keys.

## Risks
- Longer prompt = more cost/injection surface — mitigated by Spec 2 delimiting + the cached system prompt.
- Don't over-restructure: keep the "smallest change that helps" instruction; richer context must inform, not encourage sweeping rewrites.

## Addendum (2026-06-24) — review → plan bridge: a third proposer entry point

The proposer now has three entry points, all routing through the same `draftGatedProposals` → `proposeAdjustments`
→ `validateProposals` → `WriteGate.propose` path (so Spec 2's validated-args + readable-confirmation guarantees and
this spec's grounded context apply unchanged):
1. `/act` — turn the surfaced **alerts** into a plan change.
2. `/act-item` — turn **one "This week" recommendation** into a plan change.
3. **`/session-adjust` (new)** — turn **how the last session executed** into a plan change.

This closes the review→plan loop (Insight Engine spec's "you only suggest; plan writes happen elsewhere"): the
session deep-feedback already *suggests* in prose, but nothing drafted a gated edit from it.

**Deterministic trigger, LLM only drafts.** `coach/reviewBridge.ts` `sessionPlanSignal(detail)` is a **pure**
function over the assembled `SessionDetail` (no LLM, fully unit-tested) that fires only on clearly directional,
conservative signals so a false flag — which becomes a declined proposal, nudging the proposer conservative —
stays rare:
- **aerobic-fade** — `decay.decouplingPct > 10` on a `durationMin ≥ 60` effort (decoupling is invalid on short /
  interval efforts; >10 % is the textbook "base lacking" band);
- **deep-fatigue** — `tsbOnDay ≤ −25` (a productive build sits ~−10..−20; below that, protect the recovery that follows).
Deep-fatigue outranks aerobic-fade so the card never shows two competing asks. Only the resulting **minimal edit**
is drafted by the LLM, against a real upcoming `workoutId`; the deterministic facts ride along as `basis`.

**Spoof-safe.** The dashboard flag is rendered from `sessionPlanSignal` server-side; the `/session-adjust` route
**re-computes the signal from the assembled session** and ignores any client-supplied trigger text (the browser
sends only `{date, sport, durationMin}`). No signal → `notes`, never a write.

**Surface.** The Last-session card shows the deterministic flag inline (free) with a **➡️ Adjust the days ahead**
button; the drafted proposals render with the existing `proposalHtml` Apply / Dismiss UI. Hidden in share view and
when there's no API key (a flag with no actionable draft would just nag).

**Why this is the differentiator.** AI Endurance / Humango adapt off readiness *scores*; neither is documented to
draft a plan change from how a session *actually executed*. This is the cheapest high-confidence win on top of the
already-built review engine, and needs no plan-authoring or Garmin-write surface.

### Addendum test plan
- `test/reviewBridge.test.ts`: aerobic-fade fires only above threshold **and** over the steady-minimum duration;
  deep-fatigue fires at/below the TSB threshold; deep-fatigue outranks aerobic-fade; null TSB / no decay / unremarkable
  session → no signal; `buildSessionAdjustRequest` carries the suggestion, the deterministic basis, and the targeting rule.
