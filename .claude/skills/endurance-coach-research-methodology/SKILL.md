---
name: endurance-coach-research-methodology
description: >-
  Load this when turning a hunch or observation into an accepted result in the Endurance Coach repo:
  "how do we turn a hunch into a claim", "what is the evidence bar here", "should this ship as confirmed
  or exploratory", "pre-register this", "run an adversarial review", "assign a skeptic", "is this a real
  signal or noise", "idea lifecycle", "how do we promote an experiment", "how do we retire a feature we
  cut", "should this go behind a flag", "priors vs this athlete's data", "why did we cut the change-point
  detector", or any decision about whether a finding, prior, detector, or coaching rule has earned adoption.
  This skill owns the DISCIPLINE (the evidence bar, the pre-registration rule, the idea-lifecycle state
  machine, where good ideas come from, the priors-yield-to-n=1 doctrine). It does NOT own the statistical
  derivations (see endurance-coach-proof-and-analysis-toolkit), the step-by-step campaign to validate one
  detector (see endurance-coach-n1-validation-campaign), the open research problems (see
  endurance-coach-research-frontier), the test/CI acceptance mechanics (see endurance-coach-validation-and-qa),
  or the change gate that actually merges a result (see endurance-coach-change-control). Reach for it before
  you believe a correlation, adopt a prior, add an experimental flag, or write "we found that…".
---

# Endurance Coach — research methodology (the discipline that makes a result trustworthy)

**Use this when** you are deciding whether an observation, correlation, detector, prior, or coaching rule
has *earned belief* — turning a hunch into an accepted result, deciding "confirmed vs exploratory",
pre-registering an analysis, running an adversarial review, or promoting/retiring an experiment.

**Don't use this when** you want:
- the **maths** behind a method (Fisher-z CI, Bonferroni-before-BH, permutation null) → `endurance-coach-proof-and-analysis-toolkit`
- the **executable go/no-go campaign** to validate one detector with exact commands → `endurance-coach-n1-validation-campaign`
- the **open research problems** to pursue → `endurance-coach-research-frontier`
- the **test suite / CI / acceptance-threshold mechanics** → `endurance-coach-validation-and-qa`
- the **change gate / definition-of-done / ship flow** that actually merges the result → `endurance-coach-change-control`
- the **flag-plumbing details** (which env var, where parsed) → `endurance-coach-config-and-flags`

This skill is the *epistemics*: the rules for what counts as knowing, not the code for computing it.

---

## 0. Terms defined once (zero-context reader)

| Term | Meaning here |
|---|---|
| **n=1** | one athlete. All findings are about *this* person's data, not a population. Small samples, big individual variation — the whole reason for the rigour below. |
| **Prior** | a general finding from published sports-science research (group averages). Lives in `knowledge/sports-science.md`. A *starting belief*, not a law. |
| **Confirmed vs exploratory** | the two honesty labels a finding can carry. **Confirmed** = survived the evidence bar (§1). **Exploratory** = a hypothesis to watch, not yet proven. The code literally tags them (`insights/correlations.ts`, `insights/monitoring.ts`). |
| **Pre-registration** | writing down the hypothesis, the predicted direction/size, and the analysis *before* running it — so you can't retrofit a story to whatever the data showed. |
| **Adversarial review / skeptic** | a person (or a deliberate second pass) whose job is to *break* the finding: find the confound, the multiplicity, the collinearity that explains it away. |
| **Confound** | a third thing that could produce the apparent relationship (e.g. heat inflating an efficiency drop; both series just trending together). |
| **MODEL / estimate** | house label for anything computed under assumptions rather than measured. Always stated with its assumptions. |
| **The gate** | the green-before-commit + branch-then-ship change-control process (`endurance-coach-change-control`). Nothing here routes around it. |

---

## 1. The evidence bar (the single standard)

A result is **accepted (confirmed)** in this repo only when it clears **every** rung. Missing any rung → it
ships **labelled exploratory / candidate / MODEL**, never as fact. This is a hard gate; do not weaken it to
make a nice story land.

- [ ] **One mechanism explains ALL the observations — including the negatives.** A hypothesis that only
      explains the confirming cases and quietly ignores the counter-examples has not earned belief. If three
      long runs decoupled badly but two didn't, your explanation must account for the two that didn't.
- [ ] **The number was predicted BEFORE the analysis ran** (§2). A direction/effect chosen *after* seeing the
      data is a story, not a test.
- [ ] **It survives an assigned adversarial refutation** (§3). Someone tried to kill it with a confound,
      multiplicity, autocorrelation, or collinearity and failed.
- [ ] **The honest estimator was used, not a naive one.** For a correlation that means the
      effective-N / Fisher-z CI excludes 0 AND it survived FDR; for a monitoring rule, walk-forward +
      permutation + Bonferroni-on-selection. The *derivations* live in `endurance-coach-proof-and-analysis-toolkit`;
      the *pass/fail thresholds* live in `endurance-coach-n1-validation-campaign` and `endurance-coach-validation-and-qa`.
- [ ] **This athlete's n=1 data outranks the textbook** (§5). A prior can motivate a hypothesis but cannot
      *confirm* one against contradicting n=1 evidence.
- [ ] **It is labelled honestly in code and UI.** Confirmed findings say so; everything else is tagged
      exploratory/MODEL with assumptions. The insight engine already does this — a finding that skips the
      label is a bug, not a shortcut.

> **The negatives are the test.** The fastest way to fool yourself on n=1 data is to collect the hits and
> forget the misses. If your mechanism can't explain why it *didn't* happen the other times, you don't have
> a mechanism — you have a coincidence with good PR.

**Why this bar exists (repo evidence).** The insight engine's whole design is this bar made executable:
`insights/correlations.ts:152-163` withholds the word "confirmed" and appends `[exploratory — not
FDR-confirmed]` unless the confidence interval excludes 0 *and* the finding survived FDR;
`insights/monitoring.ts:201` grants `validated=true` only when the held-out sample has enough events, positive
skill, and beats a Bonferroni-adjusted permutation null. A monitoring rule that scrapes p=0.04 as the best of
~12 candidates is called out in-code as "selection optimism, not a validated rule" (`monitoring.ts:197-199`).

---

## 2. Pre-registration (predict the number before you run)

Write this down **before** touching the estimator. Keep it in the PR description, a `docs/specs/*` note, or
`coaching-notes.md` under a dated decision — wherever the reviewer will see it. It is what separates a *test*
from a *story*.

```
PRE-REGISTRATION — <finding name> — <YYYY-MM-DD>
1. Hypothesis (one sentence, mechanistic):
   e.g. "Higher overnight HRV predicts a better-tolerated hard session ~1 day later for THIS athlete."
2. Predicted direction & rough size (commit to it):
   e.g. "Positive lag-1 correlation, r roughly +0.3 to +0.5; CI should exclude 0 at n≥~20."
3. Outcome variable & why it is INDEPENDENT of the predictor:
   e.g. "Garmin sleep score, NOT the AIE recovery score (that's derived from HRV/RHR → concordance, not
   independent prediction)."  ← this choice is load-bearing; see §3.
4. Data window & sufficiency: n available, usable-day count, source (state/ archive).
5. Analysis fixed in advance: which estimator, which lags scanned, which multiplicity correction.
6. Kill criteria: "I will call this exploratory if <CI spans 0 / doesn't survive FDR / n<10 / confound
   in §3 survives>."
```

**Rule:** if you find yourself choosing the lag, the outcome, or the direction *after* seeing the result, stop
— that is p-hacking, and the finding drops to exploratory automatically. The lag scan is already
Bonferroni-penalised in code precisely so that "the lag that happened to look best" cannot masquerade as a
clean test (`endurance-coach-proof-and-analysis-toolkit` has the derivation).

---

## 3. Adversarial refutation (assign a skeptic, try to break it)

Before a finding is accepted, assign it a skeptic — a person or an explicit second pass whose *only* job is
to explain the result away. It must **survive**. This is the discipline REVIEW.md demonstrates: every claim
tagged **Confirmed** (read in code, file:line) or **Suspected** (inferred), beliefs formed and then *reversed*
when the evidence didn't hold (REVIEW.md:149 — an expectation that the insight engine was "noise dressed as
signal" was reversed once the multiple-comparisons and out-of-sample discipline were actually read).

**The refutation checklist** — the skeptic must clear every fenced-off wrong path:

| Attack | The trap | How to know it survived |
|---|---|---|
| **Naive Pearson on trending series** | Two series that both drift upward correlate strongly for no causal reason. | Used effective-N/Fisher-z CI (autocorrelation-discounted), not raw-n Pearson. Minimum n=10. |
| **p-hacking the lag** | Scanning many lags and reporting the best one. | The lag scan is Bonferroni-inflated by #lags *before* Benjamini-Hochberg FDR. |
| **Validating on a non-independent outcome** | "Predicting" AIE recovery from HRV/RHR — but AIE recovery is *derived* from HRV/RHR. That's concordance, not prediction. | The outcome is genuinely independent (e.g. Garmin sleep score); a dependent outcome is relabelled "concordance, not independent prediction" (`insights/monitoring.ts:148`, `:257`). |
| **Ignoring collinearity (EF~CTL+time)** | Reading a time coefficient as "economy gain" when CTL and time are collinear, or without heat-adjusting. | Claimed only when the 95% CI excludes 0, and even then labelled "apparent" with the CTL/time-collinearity + not-heat-adjusted caveat. |
| **Selection optimism** | Best-of-N candidates; the winner looks significant by luck. | The selected rule's p is Bonferroni-adjusted by candidates tried; a permutation null (circular-shift) confirms it beats chance. |
| **Cherry-picking the hits** | Explaining the confirming cases, dropping the counter-examples. | The mechanism accounts for the negatives too (§1, rung 1). |

> If the skeptic *cannot* be run by a second human, run it as a second deliberate pass with a hostile prompt.
> Adversarial code review here has a **low hit-rate by design** — expect roughly 1 of ~10 raised concerns to
> be a real defect (REVIEW.md ranks per-insight verdicts Sound / Sound-with-caveats / Unsound / Cannot-tell
> and most survive). The point is not to find many faults; it is to make sure the *one that matters* can't
> hide.

---

## 4. The idea lifecycle (never a silent abandonment)

Every non-trivial idea moves through this state machine. **The forbidden transition is "quietly dropped":**
an idea either becomes an adopted change *through the gate*, or a *documented retirement*. Nothing evaporates.

```
        ┌─────────────┐
        │  HYPOTHESIS │  pre-registered (§2), predicted numbers on record
        └──────┬──────┘
               │  build behind an OFF-BY-DEFAULT flag (see below)
               ▼
        ┌─────────────┐
        │ EXPERIMENT  │  measured against the evidence bar (§1) on real n=1 data
        └──────┬──────┘
       clears bar │ fails / underdelivers
        ┌─────────┴─────────┐
        ▼                   ▼
  ┌───────────┐      ┌──────────────┐
  │  ADOPTED  │      │   RETIRED     │
  │ through   │      │ (documented:  │
  │ the gate  │      │ why, evidence,│
  │ (§6)      │      │ where cut)    │
  └───────────┘      └──────────────┘
```

**Experiments hide behind an off-by-default flag while they prove themselves.** That is the repo's standing
pattern — the mechanism is `endurance-coach-config-and-flags`, but the *discipline* is: default OFF, degrade
cleanly, measure, then decide. Live examples of experiments still parked behind a flag:

| Flag (in `.env.example`) | Default | The experiment it fences | Degrade behaviour |
|---|---|---|---|
| `COACH_ADVICE_CLUSTERING` | `false` | Embed each recommendation and collapse duplicate ideas across cards (cosine similarity). Labelled "advanced" in-file. | Falls back to per-source grouping if the model/server is absent. |
| `COACH_INTENT_ROUTER` / `COACH_LOCAL_INTENT` | `regex` / `false` | Cheaper intent routing (Haiku micro-call or a local model). | Degrades to zero-cost regex on any error; coaching output always stays on Opus. |

**Retirement is a first-class outcome, and it must be documented.** The canonical worked example is the
**change-point detector**: it was built, then judged low-rigour ("not significance-tested" on short
autocorrelated series, confidence 0.45 below the 0.5 surfacing gate → it rarely even surfaced), and **cut** —
module plus all wiring/readers removed — with the reasoning recorded in `REVIEW.md` and `REVIEW-HANDOVER.md`
(§0: "change-point detection is CUT"). That is a retirement done right: not deleted in silence, but killed
with its evidence on the record so nobody re-litigates it blind. (The settled-history home for *why it was
cut* is `endurance-coach-failure-archaeology`; check there before re-adding it.)

**Standing hypotheses not yet adopted** (labelled `open` — do not present as done): the GLP-1 **dose-cycle**
is *computed* into the profile context but **not yet wired into the live coaching prompts as a measured
intervention** — an open loop, a candidate for the lifecycle above, not a shipped feature. (Frontier framing:
`endurance-coach-research-frontier`.)

---

## 5. The doctrine: priors yield to n=1 data

This is the epistemic spine of the whole coach. State it plainly and apply it every time a general finding
meets this athlete's data.

- **Priors are starting beliefs, not laws.** `knowledge/sports-science.md` opens with it verbatim:
  *"Priors, not laws. … For n=1, this athlete's own response data and the AI Endurance model are the
  authority. Where they disagree with a prior, the prior yields."* The coach persona repeats it:
  *"My data outranks the textbook"* (`coach-instructions.md`).
- **A prior can *motivate* a hypothesis; it can never *confirm* one** against contradicting n=1 evidence. If
  the textbook says X and this athlete's validated data says not-X, the data wins and you say so.
- **Do not overrule the platform without n=1 evidence either.** AI Endurance's ML model owns load /
  predictions / recovery. Use the sports science to *interpret and sanity-check* it, never to run a competing
  hard-coded ruleset against it (`coach-instructions.md`; this is also a change-control non-negotiable —
  `endurance-coach-change-control`). "Priors yield to n=1" cuts *both* ways: it is not licence to re-derive
  the load model from first principles.
- **How priors get refreshed is itself review-gated.** `npm run research` drafts a web-grounded digest into
  `knowledge/pending/` — a *proposal you read*, never auto-applied. You fold it in with
  `cd /Users/maxeskell/dev/personal-training-app && npm run knowledge -- approve <file>`, which stamps a dated
  section and bumps the verified date. Even the priors themselves pass through a human review gate before they
  become "knowledge." (Mechanics: `endurance-coach-docs-and-writing`.)

---

## 6. Where good ideas come from (and how they exit into the codebase)

Ideas worth the lifecycle above have historically come from three places here — mine these, don't wait for
inspiration:

1. **n=1 anomalies in the athlete's own data.** A z-score spike, a decoupling that shouldn't be there, a
   correlation the engine flagged exploratory. The insight engine is an idea *generator*: an exploratory
   finding is a pre-registered hypothesis waiting for enough history to test.
2. **The athlete's lived friction, captured in `coaching-notes.md`.** The open to-dos there (sweat-rate test,
   long-run liquid-carb rehearsal, the dose-cycle fuelling gap) are real questions with no live data source
   yet — each is a candidate hypothesis. Note: `coaching-notes.md` holds *open questions and agreed
   decisions only* — it is **not** a data store; live numbers come live.
3. **Adversarial code review** — the REVIEW.md staged pass. Low hit-rate (~1 of 10 raised concerns is a real
   defect), high value on the one that is: it reversed a wrong belief about the engine, cut the change-point
   detector, and relabelled the brick proxy honestly.

**Every accepted idea exits through the gate — this skill does not merge anything.** Once a finding clears the
evidence bar (§1), adoption is the ordinary change-control path: branch (in a worktree — the autoupdate
HEAD-hijack hazard is real; see `endurance-coach-debugging-playbook`), label it honestly, **add a test that
pins the invariant** (`endurance-coach-validation-and-qa`), keep `npm run typecheck` + `npm test` green, then
`npm run ship`. **Nothing is adopted without the gate, and nothing is "confirmed" without the acceptance bar.**

---

## 7. Fast reference — the three gates a result must pass

| Gate | Owner skill | One-line question |
|---|---|---|
| **Evidence bar** (§1) | *this skill* | Does one mechanism explain everything incl. negatives, survive a skeptic, use the honest estimator, and beat this athlete's n=1 data? |
| **Acceptance / test bar** | `endurance-coach-validation-and-qa` + `endurance-coach-n1-validation-campaign` | Is it FDR-confirmed & CI-excludes-0 (or walk-forward+permutation+Bonferroni for a rule), pinned by a test, suite green? |
| **Change gate** | `endurance-coach-change-control` | Branch not main, code+docs together, honest report, shipped via `npm run ship` — nothing routing around the write gate or wellbeing gate? |

If a result fails any gate: **it ships exploratory/MODEL, or it doesn't ship.** There is no "confirmed" fast path.

---

## Provenance and maintenance

_Verified against the repo on **2026-07-04** (branch `main`). Re-run these to check any drifting fact:_

- Confirmed/exploratory labelling in code:
  `cd /Users/maxeskell/dev/personal-training-app && grep -n "exploratory\|FDR-confirmed\|validated" src/insights/correlations.ts src/insights/monitoring.ts`
- Monitoring acceptance bar (≥8 outcomes, ≥4 fires, Youden J>0, Bonferroni-adjusted p<0.05):
  `cd /Users/maxeskell/dev/personal-training-app && grep -n "outcomes >= 8\|fires >= 4\|pAdj < 0.05\|selection optimism" src/insights/monitoring.ts`
- "Priors, not laws" doctrine text:
  `cd /Users/maxeskell/dev/personal-training-app && grep -n "Priors, not laws\|the prior yields" knowledge/sports-science.md`
  and `grep -n "outranks the textbook\|competing hard-coded" coach-instructions.md`
- Change-point detector retirement (documented cut):
  `cd /Users/maxeskell/dev/personal-training-app && grep -n "change-point detection is CUT\|change-point" REVIEW-HANDOVER.md REVIEW.md`
- Off-by-default experiment flags still parked:
  `cd /Users/maxeskell/dev/personal-training-app && grep -n "COACH_ADVICE_CLUSTERING\|COACH_INTENT_ROUTER\|COACH_LOCAL_INTENT" .env.example`
- Knowledge-refresh review gate (`research` drafts → `knowledge -- approve`):
  `cd /Users/maxeskell/dev/personal-training-app && grep -n '"research"\|"knowledge"' package.json`
- Test suite still green & count (blueprint & this file cite **730** tests, ~6s, hermetic, as of 2026-07-04):
  `cd /Users/maxeskell/dev/personal-training-app && npm test 2>&1 | tail -6`
- All 15 sibling skills referenced above exist:
  `ls /Users/maxeskell/dev/personal-training-app/.claude/skills/`

Volatile facts to re-check if stale: the 730 test count; the exact monitoring thresholds (line ~201); the set
of off-by-default flags; the change-point retirement citation. Everything else here is discipline, not a
number, and should age slowly — but if `knowledge/sports-science.md` or `coach-instructions.md` is edited,
re-confirm the doctrine quotes in §5.
