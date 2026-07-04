---
name: endurance-coach-research-frontier
description: Load this when the task is FORWARD-LOOKING research ideation for the Endurance Coach project — "where could this advance the state of the art", "what are the open research problems", "what could we publish / write a paper on", "what's the next big bet", "where is this genuinely novel", "can we do real causal inference on one athlete", "n=1 causal identification", "per-athlete intervention design", "close the dose-cycle loop", "prove which training change actually works for this athlete", "change-point detection tied to interventions", "separate heat/collinearity confounds from durability or economy", or any brainstorm about advancing beyond current features. This is the map of OPEN candidate frontiers (all labelled open/candidate, nothing achieved) with, per frontier, why current SOTA fails, the specific repo asset that makes it tractable here, the first three concrete steps naming exact files, and a falsifiable "you have a result when…" milestone. Do NOT load this to make public/marketing claims (use endurance-coach-external-positioning), to run the evidence bar / adversarial-review lifecycle (use endurance-coach-research-methodology), or to execute the validation campaign for the CURRENT hardest problem — an n=1 detector today (use endurance-coach-n1-validation-campaign).
---

# Endurance Coach — research frontier (open problems where this could advance SOTA)

**Use this when** you are ideating *beyond current features*: scoping an open research problem, deciding a
next big bet, judging where this project could genuinely advance the state of the art, or sketching what
might be publishable. Everything here is **open / candidate** — a direction, not a shipped result.

**Don't use this when** you want to:
- make a public/competitive claim or write a release note → `endurance-coach-external-positioning`.
- run the evidence bar, pre-registration, or the idea→adopt/retire lifecycle → `endurance-coach-research-methodology`.
- execute the go/no-go validation campaign for a detector that exists *today* → `endurance-coach-n1-validation-campaign`.
- derive the statistics (Fisher-z CI, FDR, permutation null, Banister) → `endurance-coach-proof-and-analysis-toolkit`.
- look up what a metric *means* (CTL/ATL/TSB, EF, DFA-α1, dose-cycle) → `endurance-domain-reference`.

**Jargon, defined once.** *SOTA* = state of the art. *n=1* = a study of one subject (this single athlete),
so no cross-person averaging is possible. *Causal inference* = proving X *changed* Y, not merely that X and
Y move together. *Confound* = a third variable (e.g. summer heat) that fakes or masks the X→Y link.
*Group-average model* = a model fit across many athletes; its prediction for any one person is the crowd's
mean, which can be wrong for a *non-responder* (someone whose physiology reacts unlike the average).
*Autocorrelation* = today's value being correlated with yesterday's, which inflates apparent significance on
training-load series. *DFA-α1* = a heart-rate-variability-derived aerobic-durability index (consumed from AI
Endurance — "AIE" — never recomputed here). *.FIT* = the binary activity-file format from the device.

---

## The through-line: rigorous n=1 causal inference

Every frontier below orbits ONE axis, which is also the retiring engineer's stated "beyond SOTA" bet:
**can we prove which training change actually moves THIS athlete, surviving adversarial refutation, where
AIE / TrainingPeaks / Humango only offer group-average models?** That is the standard being handed on. The
non-negotiable framing:

> **This is candidate work, not a claim.** Nothing here is validated. Anything you build ships behind an
> off-by-default flag, labelled MODEL/estimate, and only becomes "confirmed" by passing the acceptance bar
> in `endurance-coach-validation-and-qa` and the epistemics in `endurance-coach-research-methodology`.

Two hard rules from the project constitution constrain *all* of these — do not break them (see
`endurance-coach-change-control`):

1. **Never re-derive the load science.** Keep *consuming* AIE's FTP/CSS/threshold/recovery/durability via
   MCP. Individual dose-response is ~50% heritable with 20–45% non-responders → there is no solo-buildable
   a-priori load model. Our edge is **interpretation + context + execution-grounded feedback + honest n=1
   stats**, never a competing load model.
2. **Never overrule the platform's ML.** Use the science to *interpret and sanity-check* AIE, not to run a
   hard-coded ruleset against it — unless this athlete's own n=1 evidence justifies it.

**The repo's distinctive assets** (why these problems are *tractable here* and not on a SaaS):

| Asset | Where | Why it matters for causal n=1 |
|---|---|---|
| Years-deep raw `.FIT` archive (per-year folders, e.g. `data/activity-archive/by-year/2015/…`; README cites a 2013 career peak) | `src/archive/*`, `scripts/build-career-history.ts` | A long personal record = enough within-athlete history to look for *natural experiments* no group model can. |
| Gated propose→confirm write loop | `src/guardrails/writeGate.ts` | A logged, human-confirmed change to the plan is a *pre-registered intervention with an audit trail* — the raw material of a designed n=1 experiment. |
| Honest n=1 stats machinery | `src/insights/stats.ts`, `correlations.ts`, `monitoring.ts` | Effective-N / Fisher-z CI, Bonferroni-before-BH FDR, walk-forward + circular-shift permutation null — the defences against autocorrelated-nonsense are *already built*. |
| Execution-grounded feedback | `src/coach/reviewBridge.ts` (wired into `server.ts`, `dashboard.ts`, `sessionNote.ts`) | A deterministic signal from how a session *actually executed* — the outcome channel a causal loop needs. |
| Heat + collinearity confound handling | `src/insights/heat.ts`, `efficiency.ts` | Confound controls (heat regression; Frisch–Waugh–Lovell EF~CTL+time) already exist to build on. |

---

## Frontier 1 — per-athlete causal identification of which stimulus moves fitness  *(open, the headline)*

**The question.** Not "does more training correlate with more fitness" (it trivially does, and both trend),
but: *for this athlete, does a specific stimulus — e.g. a weekly VO₂/threshold block, or a long-ride volume
step — causally raise a downstream capacity marker (FTP/CSS/threshold from AIE, or an EF/durability index),
above what the ongoing trend would predict?*

**Why current SOTA fails.** AIE/TrainingPeaks/Humango fit dose-response on populations; their per-person
output is a group posterior. With 20–45% non-responders, the crowd's answer can be exactly wrong for one
person, and none of them attempts a *causal* per-athlete claim. Naive correlation on this data is worse than
useless — training load and fitness are both autocorrelated and trending, so a Pearson r looks impressive
and means nothing (this repo already fences that: `corrWithCi` in `stats.ts:115` discounts to effective-N,
requires n≥10 at `stats.ts:127`, and lag scans are Bonferroni-then-BH-corrected).

**Repo asset.** The years-deep archive gives *natural experiments* — blocks the athlete already did and
stopped — and the gated write loop (`writeGate.ts`) can turn future plan changes into *designed*
interventions with a logged pre-registration (`data/decisions/log.jsonl`).

**First three concrete steps (in this repo):**
1. **Find the natural experiments.** New module `src/insights/interventions.ts`: scan the archive
   (`src/archive/store.ts`, ESS/`metrics.ts` load series) for step-changes in *stimulus* (e.g. weekly
   time-in-zone from `zones.ts`, or run-load ramps already flagged by `runLoadRamp`) that persisted ≥N weeks
   and were preceded/followed by a stable block — the candidate "treatment on/off" windows.
2. **Build an interrupted-time-series estimator.** Reuse `mlr2` (`stats.ts:64`) for a segmented regression:
   outcome (an AIE capacity marker or EF trend) on time + a treatment indicator + time-since-treatment,
   reporting the level/slope change with a CI, using the *effective-N* discount from `corrWithCi` so
   autocorrelation can't fake significance.
3. **Pre-register forward.** Extend the WriteGate proposal record (`Proposal` in `writeGate.ts`) to optionally
   carry a *predicted* direction/magnitude for a plan change, so a confirmed change becomes a logged,
   date-stamped n=1 intervention you can later score — routed through `endurance-coach-research-methodology`'s
   pre-registration template, never bypassing the gate.

**Falsifiable milestone — "you have a result when…":** on ≥2 independent natural-experiment windows for the
*same* stimulus, the segmented-regression treatment effect has a 95% CI that **excludes 0 in the same
direction**, survives a placebo test (shuffle the treatment date → effect vanishes), and survives the
adversarial refutation in `endurance-coach-n1-validation-campaign` Phase 4. Until then: `exploratory`.

**Fenced wrong paths.** Naive Pearson on the raw series; ignoring that the intervention was self-selected
(the athlete may have added the block *because* they felt good — reverse causation); claiming a single window
as proof.

---

## Frontier 2 — change-point detection tied to interventions  *(open; the detector was CUT — re-add only rigorously)*

**Read the history first.** A change-point detector (`changepoint.ts`: binary segmentation, BIC-style
penalty, confidence 0.45) **already existed and was deliberately deleted** — Decision #2 in
`REVIEW-HANDOVER.md:108`. It was cut because it was *not significance-tested*, computed on short
autocorrelated series, and its 0.45 confidence sat below the 0.5 surface gate so it never reached top
findings anyway (`REVIEW.md:70`, `MED-6` at `REVIEW.md:202`). **Do not re-add the old detector.** See
`endurance-coach-failure-archaeology` for the full settled record before touching this.

**The frontier.** A *rigorous* change-point method whose detected breaks are **explained by a logged
intervention**, not just flagged as "a break happened". A break with no candidate cause is a curiosity; a
break aligned to a confirmed plan change (from `data/decisions/log.jsonl`) is the beginning of a causal story.

**Why SOTA fails / repo asset.** Off-the-shelf change-point tools report breaks with no causal attribution
and no correction for the fact that you *searched* for them (multiple-comparison optimism). This repo already
has the two missing pieces: a permutation-null + Bonferroni-on-selection discipline (`monitoring.ts` —
`permutationP` at ~:235, `pAdj` at ~:200) and the decision log as a source of intervention timestamps.

**First three concrete steps:**
1. New `src/insights/changepointRigorous.ts`: detect candidate breaks in an AIE capacity/EF series, but score
   each with a **circular-shift permutation null** (reuse `circularShift`/`mulberry32` from `stats.ts:223,239`)
   and Bonferroni-adjust by the number of positions searched — mirroring `monitoring.ts`.
2. Join detected break dates to confirmed interventions from `data/decisions/log.jsonl` (read via the decision
   log reader) within a physiological lag window (`horizon.ts` `PHYSIO_HORIZON_DAYS = 180`).
3. Surface a finding **only** when a significant break aligns to a logged change; otherwise keep it in
   `deep_dive`-only, labelled `exploratory` — the same "don't over-surface a weak detector" lesson that got
   the old one cut.

**Falsifiable milestone:** on held-out later history, break dates predicted from logged interventions land
within the lag window at a rate beating the permutation null after Bonferroni (adjusted p<0.05) — i.e. the
detector fires *because of* the intervention, not by chance.

---

## Frontier 3 — durability / economy causal separation from heat & collinearity confounds  *(open)*

**The question.** Is an apparent economy or durability gain a *real* adaptation, or an artifact of ambient
temperature and the CTL/time collinearity? Efficiency factor (EF), pace-at-HR and durability all move with
heat, and fitness (CTL) and calendar time are collinear — so a "durability slipping" or "economy improving"
claim is only trustworthy once both confounds are removed.

**Why SOTA fails / repo asset.** Consumer tools trend EF or DFA-α1 raw and call the slope "adaptation" —
`heat.ts:2` explicitly calls temperature "the #1 validity fix". This repo already has the honest partial
versions: `efficiency.ts` runs the Frisch–Waugh–Lovell-correct EF~CTL+time via `mlr2` and only claims a gain
when the *time coefficient's* 95% CI excludes 0, and even then labels it "apparent" because EF there is **not
heat-adjusted**; `heat.ts` separately estimates EF-change-per-°C. **They are not yet combined.**

**First three concrete steps:**
1. Add temperature as a third regressor: extend the economy model to EF ~ CTL + time + tempC (generalise
   `mlr2` in `stats.ts` to k=3, or residualise EF on temp via `heat.ts` first, then run the existing
   2-regressor `mlr2`). Only claim economy when the *time* coefficient's CI excludes 0 *after* temp is in.
2. Do the same for durability: currently `durabilityTrend` (`engine.ts:8,351`) reports raw DFA-α1 prior→recent
   deltas from AIE. Regress the durability index on temp (and CTL) before trending, so a hot block can't read
   as "durability slipping".
3. Add a `test/heat.test.ts` / `test/efficiency.test.ts` fixture where a *pure heat wave* produces an EF dip
   and assert the combined model attributes ~0 economy change — the failure mode made explicit.

**Falsifiable milestone:** on a synthetic fixture where the only change is temperature, the combined model
reports a temp-adjusted economy/durability effect whose CI **includes 0** (correctly finds nothing); and on
the real archive, any surviving effect is heat- and fitness-adjusted with a CI excluding 0.

**Fenced wrong path.** Trending raw EF or DFA-α1 and calling the slope adaptation; residualising on CTL only
(leaves the collinearity in the residual — the exact bug `efficiency.ts:8` was written to fix).

---

## Frontier 4 — close the dose-cycle → live-prompt loop as a *measurable* coaching intervention  *(open)*

**The current state (verified).** The GLP-1 medication dose-cycle is *computed* — `computeDoseCycle` in
`profile/schema.ts:246` (`computeDoseCycle`) yields `days_since_dose` and `in_gi_trough` — and it is *surfaced as text* into
coaching prompts (`profile/context.ts:56` renders the medication line; `renderProfileContext` is consumed by
`coach/ask.ts` and `coach/seasonContext.ts`; `formatProfileForTool` at `context.ts:286` for the MCP
`get_profile` tool). **But nothing deterministically branches on `in_gi_trough` / `days_since_dose`** — grep
confirms no fuelling or scheduling code reads those fields to change behaviour. So the loop is *open*: the
signal reaches the LLM as prose, but there is no measured, closed-loop coaching action, and no way to tell if
acting on it helps. (Jargon: *GLP-1* = an appetite-suppressing metabolic medication; a *GI trough* = the days
after a dose when the gut is slowest, so fuelling-heavy sessions are riskiest. The prescriber owns the drug;
the coach only works around it — see `endurance-domain-reference` and `medicalExposure.ts`.)

**Why this is a frontier, not a chore.** Turning "the athlete is in the GI trough" into a *measured*
intervention — steer big fuelling-dependent sessions off trough days, then check whether execution/fuelling
outcomes actually improve — is a clean, ethical n=1 experiment no group model can run, because the
medication cycle is this athlete's alone.

**First three concrete steps:**
1. Make the signal *actionable, gated*: in `reviewBridge.ts` / the plan-adjust path, add a deterministic rule
   that a fuelling-heavy long session scheduled inside `in_gi_trough` is a candidate for a **proposed**
   (never auto-applied) date move — routed through `writeGate.ts propose()`, honouring the wellbeing gate
   (`guardrails/wellbeing.ts`).
2. Log the outcome channel: tie the confirmed move to the execution-grounded feedback from `reviewBridge.ts`
   (decoupling / fuelling adherence) so each trough-avoidance has a measured result.
3. Score it as an n=1 experiment using Frontier 1's interrupted-time-series estimator: sessions moved off
   trough vs left on trough, outcome = fuelling adherence / decoupling, effective-N discounted.

**Falsifiable milestone:** across enough confirmed trough-avoidance interventions, sessions moved off the
trough show better fuelling adherence / lower decoupling with a CI excluding 0, surviving the placebo test
(shuffle which sessions were "in trough"). Until then, keep the dose-cycle as *context only* — the current,
honest state.

**Hard boundary.** This must never diagnose, restrict, or route around the wellbeing gate. Any dose-cycle
logic that touched intake/restriction would be blocked at `screenNutritionPrompt()` and is out of scope by
design — the coach works *around* the drug, the prescriber owns it.

---

## How to pick up any of these

1. Read the settled record first (`endurance-coach-failure-archaeology`) — Frontier 2's detector was already
   cut once; don't re-fight it.
2. Frame the hypothesis and pre-register the predicted direction *before* running
   (`endurance-coach-research-methodology`).
3. Build behind an off-by-default flag (`endurance-coach-config-and-flags`), label output MODEL/exploratory.
4. Validate with the campaign gates and the acceptance bar (`endurance-coach-n1-validation-campaign`,
   `endurance-coach-validation-and-qa`); derive any new stat from first principles
   (`endurance-coach-proof-and-analysis-toolkit`).
5. Adopt or retire only through the change gate (`endurance-coach-change-control`) — never silently abandon.
6. Only after all that may a public claim be made (`endurance-coach-external-positioning`).

---

## Provenance and maintenance

*Verified against the repo on 2026-07-04. All frontiers are `open`/`candidate` — nothing here is a validated
result. Re-verify the load-bearing facts before relying on them:*

| Fact | Re-verify command (run from `/Users/maxeskell/dev/personal-training-app`) |
|---|---|
| Change-point detector was cut (Frontier 2) | `grep -rn "change-point CUT\|changepoint.ts deleted\|Decision #2" REVIEW-HANDOVER.md; ls src/insights/changepoint.ts 2>&1` (file should be absent) |
| Dose-cycle computed but NOT behaviorally wired (Frontier 4) | `grep -rn "in_gi_trough\|days_since_dose" src/ \| grep -v "schema.ts\|description\|why:"` — expect only `context.ts` / `mcpServer.ts` (text), no branching logic |
| `computeDoseCycle` location | `grep -n "computeDoseCycle\|in_gi_trough" src/profile/schema.ts` |
| Honest-stats machinery still present | `grep -n "corrWithCi\|benjaminiHochberg\|circularShift\|mlr2" src/insights/stats.ts` |
| Monitoring walk-forward + permutation gate | `grep -n "walk-forward\|permutation\|combosTried\|validated" src/insights/monitoring.ts` |
| Heat + FWL economy confound modules exist (Frontier 3) | `grep -n "heat\|temperature" src/insights/heat.ts; grep -n "CTL + time\|Frisch\|apparent" src/insights/efficiency.ts` |
| WriteGate propose→confirm loop (intervention asset) | `grep -n "propose\|confirm\|plan-adjust\|PROPOSAL_TTL" src/guardrails/writeGate.ts` |
| reviewBridge wired into live flows | `grep -rln "reviewBridge\|sessionPlanSignal" src/` — expect `server.ts`, `coach/dashboard.ts`, `coach/sessionNote.ts` |
| Archive is years-deep / by-year | `ls src/archive/; grep -n "by-year\|trajectory\|byYear" scripts/build-career-history.ts src/archive/activityArchive.ts` |
| Test suite still green (nothing here breaks it) | `npm test 2>&1 \| tail -5` (expect ~730 tests, hermetic, no network as of 2026-07-04) |
| Sibling skills cited still exist | `ls .claude/skills/ \| grep endurance-coach-` |
