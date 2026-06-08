# Personal Endurance Coach — Build Spec (for Claude Code) — v2

> **Read §1 before building anything.** v2 exists because v1 over-engineered the answer. This document is the single source of truth; the two companion files are subordinate to it:
> - `AI_Triathlon_Coach_Project_Instructions.md` — the coach persona / system prompt.
> - `Endurance_Coach_Integration_Spec.md` — data-integration detail.

---

## 1. Do you actually need to build this? (decision gate)

**Default recommendation: don't build a custom app. Use a Claude Project.**

You already own an AI-powered adaptive training platform — AI Endurance does ML plan generation, predictions and recovery modelling — and it already ships a Claude MCP connector. So:

> **Path A (do this first):** Connect the AI Endurance MCP to a Claude Project, paste in the coach persona, optionally add a Garmin MCP for the five gap metrics. That delivers ~80% of the value, today, with **zero code to maintain.**

Only build the custom orchestrator (Path B, the rest of this doc) if Path A proves insufficient for one of **three specific needs** it genuinely can't meet:

1. **Unattended scheduling** — e.g. a 06:00 readiness ping pushed to you without opening a chat.
2. **A custom glanceable dashboard** — a Today/Week/Trends/Race view you check at a glance.
3. **A persistent decision log** — durable record of what was proposed/accepted and how calls held up, beyond chat history.

If none of those bite, **stop at Path A.** For a single athlete, a bespoke app with two MCP clients, an LLM loop, a datastore and a dashboard is a maintenance liability, and it re-implements things the platform and the Project already do. Be honest about ROI before writing code.

---

## 2. Vision

A coach in software for one athlete building to **Birmingham Triathlon (A, 11 Jul 2026)** and then, off that base, **Loch Ness Marathon (B, 27 Sep 2026)**, with **Alderford (B, 6 Sep 2026)** handled deliberately (see §6). It reads the plan (AI Endurance) and ground-truth device data (Garmin, optional), interprets rather than re-plots, and gives clear, evidence-based, *individualised* coaching: a daily readiness call, a weekly review, gated plan-adjustment proposals, and progressively race-specific prep.

It is opinionated where evidence supports it, humble where it doesn't, empathetic about a real life, and biased toward what's sustainable over months. It is **not** a generic chatbot, a calorie-restriction tool, or an autonomous plan-rewriter. It proposes; you decide. And it aims to make itself *less* necessary over time, not more.

---

## 3. Strategy

1. **Platform-first, code-last.** Exhaust Path A before Path B. Every custom component must justify itself against "the Project already does this."
2. **AI Endurance is the spine; Garmin is optional and degradable.** Never let a fragile Garmin client block the coach.
3. **The LLM is the reasoning core; the science is context, not a rules engine.** Encode the science as priors the model interprets (§7). Only hard guardrails (write-gate, fuelling/weight limits) are deterministic code.
4. **Defer to the platform's model.** AI Endurance already encodes much of the training science. Don't run a competing hard-coded ruleset that can disagree with it; use the science to interpret and sanity-check.
5. **Insights over dashboards; trust through transparency.** Differentiate on interpretation, and state the *why* + the data behind every call.

---

## 4. The four lenses

**Product.** One user, daily touch. JTBD: "tell me what to do today and why, and catch problems before they cost a block." Beware the engagement trap — a good coach reduces its own necessity (see §9 metrics). The four flows (daily / weekly / adjust / race) are the product; resist feature sprawl.

**Engineering.** If Path B: a small local-first orchestrator — two MCP clients (one remote OAuth, one optional local), one LLM client, a local store, a thin interface. Resilient to Garmin breakage and to AI Endurance API changes (its changelog already shows a removed tool — don't over-couple to a single tool's shape). Gated writes, aggressive caching, no secrets in prompts/logs.

**Data.** Core asset: a unified **daily athlete-state** with provenance per field, persisted and trended (HRV-vs-baseline, RHR, sleep, weight-trend). Handle the planned-vs-actual join and sync-gap detection. Don't recompute what the platform already trends unless Path-B needs it.

**Sports Science.** Encode current evidence as **priors, not laws** (§7). Population research has small samples, modest effects, big individual variation — for n=1 the athlete's own response data is the authority. Protect easy/hard separation, durability, strength maintenance, energy availability, and the one-peak periodisation. Don't claim clinical detection the data can't support.

---

## 5. Functional requirements

- **5.1 Daily readiness.** Drive on interpretable signals (HRV vs baseline, sleep, RHR) + recent load + AIE recovery model; Garmin Body Battery / Training Readiness are **tiebreak only**. Output green/amber/red + one–two line why. One metric out of line ≠ red; a pattern is.
- **5.2 Weekly review.** Planned vs actual, load by sport, adherence by zone, standouts, recovery + weight trend, next-week focus. Lead with the takeaway.
- **5.3 Plan-adjustment proposals.** Propose + trade-off; **no write tool fires without explicit per-action confirmation.** Never restructure a week unprompted.
- **5.4 Race prep.** Birmingham: bricks/transitions/pacing/taper/fuelling. Alderford: see §6. Loch Ness: Aug–Sep run block (long runs, marathon-pace, durability) with **run-load progression caution** + short taper; maintain swim/bike.
- **5.5 Insight engine.** Decoupling/durability, CTL-ATL-TSB vs race date, prediction confidence vs goal, early injury/illness/overreaching flags.

---

## 6. Coaching considerations v1 glossed (now explicit)

- **Alderford is 3 weeks before the goal marathon.** That proximity is a real conflict, not a casual "train through." If Alderford is a triathlon, racing it hard compromises marathon prep/taper — default to a hard-capped tempo effort or skip the intensity. If it's an open-water swim, it's low-cost. The system must surface this as a decision with the trade-off, not bury it.
- **Marathon off a triathlon base = injury window.** Swim/bike volume spares the legs, so running-specific orthopedic load has been comparatively low. Ramping marathon long runs in ~11 weeks concentrates that load quickly. Cap weekly run-volume increases, watch niggles early, and treat run durability as a built target — don't just "shift volume to running."
- **Heat (Birmingham, July): probably irrelevant.** UK July is usually mild. Only consider heat-prep/pacing if the forecast shows a genuine heatwave near race day. Don't prescribe acclimation by default.

---

## 7. Sports-science priors (evidence-based; apply as hypotheses to test on *this* athlete)

Each is a starting prior. Where the athlete's own data or the AI Endurance model disagrees, **the prior yields.**

1. **Intensity distribution.** A large fraction of easy volume (~60–90%) with smaller threshold/high-intensity portions characterises successful endurance athletes; "polarized" has been *proposed* as superior but recent meta-analysis does **not** establish clear superiority over pyramidal — both work. *Apply:* protect easy-easy/hard-hard separation; don't dogmatise the exact split.
2. **HRV-guided intensity gating.** Modest, mainly protective — clearest benefit is fewer non-responders by avoiding hard work when unrecovered, not chasing a daily score. *Apply:* gate intensity by trend.
3. **Durability / physiological resilience.** Performance depends on how little your fresh numbers decay over hours; trainable by both low- and high-intensity work and by accumulated volume. *Apply:* quality late in long sessions / off the bike; value long-term volume — central to both A and B goals.
4. **Carbohydrate fuelling.** ~90 g/h baseline for long sessions; up to ~120 g/h for trained athletes with gut training (glucose:fructose ~1:0.8), with higher availability possibly aiding durability/economy. *Apply:* progressive gut-training into race fuelling; rehearse in long sessions; never under-fuel.
5. **Strength training.** Improves running economy and cycling efficiency with little VO₂max change, and supports durability/fatigued-state performance; manage concurrent-training interference. *Apply:* protect 1–2 sessions through the build; don't cut first when volume rises.
6. **Tapering.** ~2 weeks pre-A-race, cut volume substantially (~40–60%), hold intensity and frequency. Alderford: no full taper. Loch Ness: short marathon taper.
7. **Periodisation guardrail.** One tri build → one run block; never two stacked peaks; maintain (don't build) swim/bike Aug–Sep.

> Keep as living `knowledge/sports-science.md`. Re-verify periodically. References in §12.

---

## 8. Data model & NFRs (Path B)

**`AthleteState`** (one/day, provenance per field): planned_sessions, actual_activities, ctl/atl/tsb, adherence_by_zone, prediction, recovery_model (DFA α1/rMSSD/RHR/orthopedic), sleep/body_battery/readiness *(tiebreak)*, hrv_overnight + 7d_baseline, resting_hr + baseline, vo2max/training_status, **weight + 7d_trend (no daily body-comp)**, nutrition_targets (ranges), sync_gaps, readiness_verdict + why, decisions[].

**Wellbeing (hard, enforced in code).** Fuel to train; use AIE ranges. Never recommend deficits/restriction/"race weight." Weight is a trend, secondary, never a daily target. **No clinical-syndrome detection** — if multiple risk signals co-occur (rapid/unexplained weight loss, suppressed HRV + poor sleep, rising RHR, low energy), raise gently and refer to a professional; don't label it RED-S or treat loss as a win.

**Safety.** Write-gate every AIE write tool behind explicit confirmation; log proposals/decisions. No autonomous rewrites.

**Reliability.** Garmin optional/degradable; on failure say so, fall back to AIE, ask for pasted numbers, never guess. Tolerate AIE tool changes.

**Privacy/cost.** Local-first; creds encrypted, out of prompts/logs/repo; OAuth revocable. Cache daily; default low-resolution data.

---

## 9. Definition of success

**Acceptance criteria.** (1) AIE connects and a daily state assembles with correct provenance; sync gaps surfaced. (2) Readiness returns green/amber/red on a trend-based rationale that doesn't flip on one bad night, with black-box scores used only as tiebreak. (3) Weekly review leads with the takeaway. (4) An auto-write attempt is **blocked** without confirmation. (5) Race prep adapts by event and time-to-race, and explicitly surfaces the Alderford decision and run-load caution. (6) Garmin-down degrades cleanly. (7) A restriction-implying nutrition prompt is redirected to adequate fuelling. (8) Every output cites its data.

**Outcome metrics (the point).** Arrives at Birmingham and Loch Ness **uninjured** and on/above predicted time; run-volume ramp stays within safe bounds with no injury flare; health-risk signals never missed; subjective "this coached me well." **Explicitly not** "% days the athlete engages / acts on the verdict" — that rewards dependence, which is a failure mode, not success.

**Non-goals.** Medical diagnosis; autonomous plan rewriting; multi-user/social; replacing human medical/physio care.

---

## 10. Milestone plan

**Path A (do first, no code):** connect AIE MCP to a Project, load persona, optionally add Garmin MCP. Validate the four flows conversationally. **If this suffices, you're done.**

**Path B (only if §1's three needs bite):**
- **M1** scaffold + MCP clients (AIE required, Garmin optional) — reads verified.
- **M2** athlete-state + store + baselines + sync-gap detection.
- **M3** LLM core + knowledge layer + deterministic guardrails (write-gate, fuelling/weight limits).
- **M4** the four flows + dated markdown reports — meets acceptance criteria. *(This is the product.)*
- **M5** scheduling and/or local dashboard — only the subset of §1's three needs that actually apply.
- **M6** harden: Garmin-breakage handling, AIE-change tolerance, secret hygiene, decision-log review.

---

## 11. Open inputs
Birmingham distance; Alderford format; athlete baselines (mostly from `getUser`/`getAvailability`).

---

## 12. References (priors, not laws; verify periodically)
- Stöggl & Sperlich 2015, Front Physiol (TID). Sperlich et al. 2023 (TID review). Silva Oliveira, Boppre, Fonseca 2024, Sports Med, 10.1007/s40279-024-02034-z (POL not clearly superior).
- HRV-guided training meta-analyses, 2021 (incl. Manresa-Rocamora et al.; ScienceDirect S1440244021001080).
- Maunder et al. 2021, Sports Med (durability). Jones 2024, J Physiol 602(17):4113–4128 (physiological resilience). Matomäki et al. 2023, Front Physiol, 10.3389/fphys.2023.1128111.
- Thomas/Erdman/Burke 2016 (ACSM ≤90 g/h). Jeukendrup 2014. Viribay et al. 2020, Nutrients 12(5):1367. Hearris et al. 2022. "From Metabolism to Medals" review 2026 (CHO ↔ durability/economy).
- Llanos-Lagos et al. 2024, Sports Med 54(4):895–932, 10.1007/s40279-023-01978-y (RE). Eihara et al. 2022, 10.1186/s40798-022-00511-1. Llanos-Lagos et al. 2025, Eur J Appl Physiol, 10.1007/s00421-025-05883-2 (cycling). Van Hooren et al. 2024, Sports Med 54(12) (concurrent training).
- Bosquet et al. 2007, MSSE (tapering meta-analysis); Mujika & Padilla.
