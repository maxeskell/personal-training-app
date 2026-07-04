---
name: endurance-coach-n1-validation-campaign
description: >
  The executable, decision-gated campaign for the project's hardest live problem — proving that an insight-engine
  finding is REAL for THIS one athlete on noisy, single-athlete (n=1) data, not "impressive-looking nonsense". Load
  this when you are about to add, change, or trust a detector in src/insights/ — especially monitoring.ts,
  correlations.ts, efficiency.ts, or the stats.ts primitives — or when someone asks "is this signal real?", "should
  this ship as confirmed or exploratory?", "validate this detector/insight", "prove the monitoring rule", "why did
  my correlation not surface?", "this correlation looks too good", "is this FDR-confirmed?", "the CI spans zero",
  "walk-forward / holdout / permutation null", "did I p-hack the lag?", "is the outcome independent of the
  predictor?", or when reviewing a finding tagged exploratory vs confirmed. It walks Phase 0 (pre-register the
  hypothesis) → Phase 1 (data-sufficiency gates) → Phase 2 (run the honest estimator) → Phase 3 (confirm/exploratory
  decision rule) → Phase 4 (adversarial refutation of confounds/heat/autocorrelation/multiplicity) → Phase 5
  (promote through change-control with a test + honest label). It fences off the four known-wrong paths: naive
  Pearson on trending series, p-hacking the lag scan, validating on a non-independent outcome (AIE recovery vs HRV),
  and ignoring EF~CTL+time collinearity. Don't load it for the statistical DERIVATIONS themselves (why Fisher-z,
  why Bonferroni-before-BH — use endurance-coach-proof-and-analysis-toolkit) or the general evidence-bar epistemics
  (use endurance-coach-research-methodology).
---

# n=1 validation campaign — is this signal real for THIS athlete?

**Use this when** you are about to trust, ship, or change a finding from the insight engine (`src/insights/`)
and you need a repeatable go/no-go procedure that ends in "confirmed" or "exploratory" — never a hunch. The
core files are `monitoring.ts`, `correlations.ts`, `efficiency.ts`, and their shared primitives in `stats.ts`.

**Don't use this when** you want:
- the *derivations* of the estimators (why effective-N, why Fisher-z, why Bonferroni-before-BH, how the
  permutation null works) → **`endurance-coach-proof-and-analysis-toolkit`**.
- the general *epistemics* (evidence bar, pre-registration template, idea lifecycle) → **`endurance-coach-research-methodology`**.
- the *meaning* of a metric (what CTL/HRV/EF/decoupling is) → **`endurance-domain-reference`**.
- the *test conventions and CI contract* → **`endurance-coach-validation-and-qa`**.
- to *ship* the change → the gate lives in **`endurance-coach-change-control`** (this campaign routes through it at Phase 5).

**Vocabulary (defined once).** *n=1* = a single athlete's own data, so group statistics don't apply and everything is
autocorrelated. *Autocorrelation* = today looks like yesterday (fitness, HRV, weight all drift), which fakes strong
correlations. *effective N (effN)* = the sample size after discounting for that drift — the honest count. *CI* =
confidence interval; "CI excludes 0" = the effect is distinguishable from nothing. *FDR* = false-discovery rate
control (Benjamini–Hochberg), the guard against fishing across many metrics. *Walk-forward* = pick the rule on
early data, score it on later held-out data. *Permutation null* = shuffle the outcome many times to see how often
noise beats your rule by luck. *Youden J* = hit-rate − false-alarm-rate (a rule's skill; 0 = coin-flip). *Lead* =
how many days ahead a monitoring rule fires. All numbers below are MODEL thresholds baked into the code — cite them,
don't re-invent them.

> **The one rule that governs this whole skill:** a finding surfaces as *confirmed* ONLY if it passes the code's
> honest estimator AND its CI excludes 0. Everything else is *exploratory* — a hypothesis to watch, never a claim.
> Fewer confirmed findings is the correct outcome, not a regression (spec 04, "Risks"). Do not weaken a gate to
> make a finding surface.

---

## The two detector kinds this campaign covers

The engine builds ~30 detectors, but the n=1 acceptance machinery lives in two shapes. Identify which you have first.

| Kind | What it claims | Built by | Estimator | "Confirmed" gate |
|---|---|---|---|---|
| **Correlation / lagged link** | "X tends to predict Y k days later for you" | `analyseRecoverySeries` (`correlations.ts`) via `bestLaggedCorr`/`corrWithCi` (`stats.ts`) | Fisher-z CI on effective-N + Bonferroni-on-lags → Benjamini–Hochberg FDR | `fdrPass === true` (BH-survived **AND** CI excludes 0) |
| **Monitoring rule** | "when HRV/RHR does X, a bad day follows in `lead` days" | `buildMonitoringRuleSet` (`monitoring.ts`) | walk-forward (60/40) + circular-shift permutation null + Bonferroni-on-selection | `validated === true` (holdout skill beats the multiplicity-adjusted null) |

`efficiency.ts` (economy = the time-coefficient of `EF ~ CTL + time`) is a third, simpler shape — a single multiple
regression whose gate is "the 95% CI on the coefficient excludes 0", labelled *apparent* even then. It follows the
same Phase 3/4 logic (CI-excludes-0 + confound check) without walk-forward.

---

## Phase 0 — Frame & pre-register (before you run anything)

Write the hypothesis down first, with a **predicted direction** and rough effect, so you cannot rationalise whatever
the data hands back. Full template + why-it-matters lives in **`endurance-coach-research-methodology`**; the minimum here:

- **Predictor → outcome, with an arrow of time.** e.g. "morning HRV suppression (predictor at t) predicts a lower
  Garmin sleep score 1–3 days later (outcome at t+lead)". Never "HRV correlates with recovery" (same-day, no arrow).
- **Predicted sign.** e.g. "negative: lower HRV → worse sleep". A finding that surfaces with the *opposite* sign to
  your prediction is a red flag, not a discovery.
- **Is the outcome independent of the predictor?** Write it down now (this is Phase-4 trap #3 pre-empted). AIE's
  recovery/cardio-recovery score is *modelled from HRV+RHR*, so an HRV rule "predicting" it is tautological.

If you can't state a direction and an independent outcome, stop — you have a fishing expedition, not a hypothesis.

---

## Phase 1 — Data-sufficiency gates (does the athlete have enough history?)

Every estimator here refuses to over-claim on thin data. Check the depth BEFORE running, so an "exploratory" label
is a choice, not a surprise.

```bash
cd /Users/maxeskell/dev/personal-training-app
npm run backfill:status          # archived counts + date ranges per series (distinct records)
npm run state:today              # today's assembled AthleteState — confirms the live ~60-day recovery series exists
```

| Detector | Hard minimum (code) | Where enforced | Below it → |
|---|---|---|---|
| Correlation (`corrWithCi`) | **n ≥ 10** paired points | `stats.ts` `corrWithCi` returns `null` if `n < 10` | no finding at all |
| Correlation surfaces as a *pattern* | `|r| ≥ 0.5` for the "Your patterns" card; `|r| ≥ 0.3` to enter the FDR set | `engine.ts` `anomalyCorrelationFindings`; `correlations.ts` `add` | weaker links don't surface |
| Archive sleep→load corr | **n ≥ 20** and `|r| ≥ 0.3` | `correlations.ts` `sleepVsNextDayLoad` | returns `null` |
| Monitoring rule — walk-forward | **≥ 50 usable outcome-days** (`canHoldout`) | `monitoring.ts` `buildMonitoringRuleSet` | drops to `in-sample (exploratory)`, `validated:false` |
| Monitoring — independent outcome | **≥ 60 Garmin days, ≥ 40 with HRV, ≥ 40 with sleepScore** | `monitoring.ts` `monitoringInputFrom` | falls back to AIE recovery, `outcomeIndependent:false` |
| Efficiency regression (`mlr2`) | **n ≥ 6** for a usable SE; **≥ 10 steady runs** to claim | `stats.ts` `mlr2` (returns null <6); `efficiency.ts` | no economy claim |
| Anomaly / trailing-z | **≥ 14** non-null points | `stats.ts` `trailingZ`; `correlations.ts` z-helper | no anomaly fired |

**Expected observation:** if `backfill:status` shows the Garmin HRV/sleep series is short or absent, your monitoring
rule *will* fall back to the AIE recovery outcome and can only ever be *concordance* (Phase-4 trap #3). That is not
a bug — it is the honest ceiling. To lift it, backfill Garmin (see `endurance-coach-build-and-env`) and rebuild the
long history: `npm run career:build -- --tp <trainingpeaks.csv> --fit-dir <archive-dir>` (a bare `career:build`
drops bests/trajectory — always pass `--tp` and `--fit-dir`).

> **If you see fewer usable days than expected → branch to** `endurance-coach-debugging-playbook`: the archive may
> be degraded (a Provenanced slot fell to `null`, a backfill overlapped and needs `npm run backfill:compact`).
> Don't force a validation on data you can't trust.

---

## Phase 2 — Run the honest estimator (never eyeball the r)

You do not compute statistics by hand here — the estimator IS the code. Invoke the detector through the engine and
read what it produced. The engine is deterministic and makes **zero LLM calls**, so this is cheap and repeatable.

```bash
cd /Users/maxeskell/dev/personal-training-app
npm run deep-dive        # runs buildInsights over today's state + full archive; the richest surface for insight findings
# or, no API key / just the gated alert view:
npm run check            # deterministic, fire-only; surfaces only alert-bar findings, no LLM
```

`deep-dive` needs an API key for the *narrative*, but the underlying `buildInsights` (the numbers you're validating)
is deterministic. To see the raw finding objects with their evidence strings, the fastest path is a fixture-driven
unit test that calls the detector directly (the functions are exported precisely so they can be unit-tested — see
`test/monitoring.test.ts`, `test/statvalidity.test.ts`, `test/efficiency.test.ts`). Recipe in
**`endurance-coach-validation-and-qa`**.

**What each estimator emits (read these fields, not the headline):**

- **Correlation** (`Correlation` in `correlations.ts`): `r`, `n`, `effN`, `ciLow`, `ciHigh`, `lagDays`,
  `significant` (CI excludes 0), `fdrPass` (BH-survived AND significant). The interpretation string self-labels
  `[exploratory — not FDR-confirmed]` or `CI spans 0 — tentative` when it hasn't cleared the bar.
- **Monitoring rule** (`RulePerf`/`MonitoringRuleSet` in `monitoring.ts`): `method` (`walk-forward + permutation`
  vs `in-sample (exploratory)`), `validated`, `best` (hitRate, falseAlarmRate, youdenJ, `pValue`), `selectedFrom`
  (how many rule×lead combos it chose from — the multiplicity the p is Bonferroni-adjusted for),
  `outcomeIndependent`.
- **Efficiency** (`EfficiencyAnalysis` in `efficiency.ts`): `economyPer30d`, `ciLow`, `ciHigh`, `economyReliable`
  (positive AND CI excludes 0).

**Expected numbers at this gate** (the pipeline, from `monitoring.ts`): walk-forward splits **60% train / 40%
holdout**; the rule+lead is picked on the train J, scored on the holdout; the holdout J is tested against a
**circular-shift permutation null, K=400** iterations, deterministic seed `mulberry32(0x9e3779b1)`, giving
`p = (ge+1)/(K+1)`; that p is then **Bonferroni-multiplied by `combosTried`** (`selectedFrom`). Correlations:
each per-relationship p is **Bonferroni-inflated by the number of lags scanned** *before* Benjamini–Hochberg at
**q = 0.1**. If your run's numbers differ from these constants, the code changed — re-verify against the files
below before trusting anything downstream.

---

## Phase 3 — The confirm / exploratory decision rule (exact thresholds)

This is the go/no-go. Apply the gate for your detector kind. **Do not add your own threshold.**

### Correlation → confirmed?
`fdrPass === true`, which the code computes as: **Benjamini–Hochberg survives at q=0.1** (over the whole
relationship set, with each p pre-inflated by its lags scanned) **AND** `significant === true` (CI excludes 0).
Confidence then keys off it: **`fdrPass` → 0.8 confidence; not → 0.35** (`engine.ts` `anomalyCorrelationFindings`).

> **Consequence you must know:** the finding surface has a `minConfidence = 0.5` gate (`stats.ts`→`metrics.ts`
> `surfaceFindings`). So an *exploratory* correlation at 0.35 is **gated out of the surfaced list entirely** — it
> exists in the report object but does not reach the athlete. "Confirmed" is not cosmetic; it's the line between
> shown and hidden. Never bump the confidence to force a surface.

The archive `sleepVsNextDayLoad` correlation is a deliberate exception: it is computed *outside* the BH set, so it
hard-codes `fdrPass:false` and can only ever assert CI-excludes-0 — never claim it as FDR-confirmed
(`correlations.ts` comment). Respect that.

### Monitoring rule → validated?
ALL of (`monitoring.ts` `buildMonitoringRuleSet`):
- `usableDays >= 50` (walk-forward was possible at all), and on the **holdout**:
- `te.outcomes >= 8` (enough bad days to score — not a handful), and
- `te.fires >= 4` (the rule actually fired), and
- `te.youdenJ > 0` (positive skill on held-out data), and
- `pAdj < 0.05` where `pAdj = min(1, pValue * max(1, combosTried))` (beats the null *after* the best-of-N penalty).

Miss any one → `validated:false`, surfaced as **"Possible watch rule … NOT yet validated out-of-sample"** at
confidence 0.4. A validated rule surfaces at `min(0.85, 0.55 + youdenJ/2)`.

### Efficiency → claimable?
`economyReliable === true`, i.e. `economyPer30d > 0` **AND** its 95% CI excludes 0 (`efficiency.ts`). Even then the
wording is **"apparent"** — CTL and time are collinear and EF is not heat-adjusted. Never drop "apparent".

---

## Phase 4 — Adversarial refutation (assign a skeptic; the finding must survive)

A finding that passed Phase 3 is a *candidate*, not a *result*. Before promotion, actively try to kill it with the
four confounds this domain is known to hide. If any explains the finding, it does NOT ship as confirmed. (The
evidence-bar epistemics — "one mechanism must explain ALL observations, including negatives" — live in
**`endurance-coach-research-methodology`**; the derivations of each defence live in
**`endurance-coach-proof-and-analysis-toolkit`**. Here: the checklist and the fenced-off wrong paths.)

| Confound to attack with | The wrong path it produces | How the code defends | Your check |
|---|---|---|---|
| **Autocorrelation** (trending series) | naive Pearson r read as causal — the project's **#1 named failure mode** | effective-N discount + Fisher-z CI in `corrWithCi` | Is `effN` far below `n`? Then most of the "sample" was drift. A tight CI on a big raw n but small effN is a lie. |
| **Multiplicity** (searched the lag / best-of-N rule) | **p-hacking the lag** — reporting the p of the *chosen* lag as if it were the only test | Bonferroni-on-lags before BH (correlations); Bonferroni-on-`combosTried` (monitoring) | Confirm `selectedFrom`/`lagsScanned` is >1 and the p was inflated. A p=0.04 best-of-12 is selection optimism. |
| **Non-independent outcome** | validating an HRV rule against **AIE recovery** (which is *built from* HRV/RHR) — tautology | `outcomeIndependent` flag; prefers Garmin sleep score; relabels AIE outcomes "concordance, not prediction" | Is `outcomeIndependent === true`? If false, the finding is at most *concordance*. Do not upgrade its language. |
| **Collinearity / heat** (EF~CTL+time) | attributing a fitness gain or a cool spell to "economy" | `mlr2` joint regression widens the SE honestly; EF not heat-adjusted → labelled "apparent"; heat detector floors attribution at |Δ|≥2% | Does the EF window overlap a hot block? Without per-`.FIT` temperature you *cannot* rule heat out — say so. |

**Also refute with the negatives.** Does the mechanism explain the days the rule *didn't* fire, and the athlete's
lived experience (`coaching-notes.md`)? A rule that "predicts" bad days but contradicts how the athlete felt on the
holdout has not survived. When in doubt, it stays exploratory. That is the safe, honest default.

> Two hard domain rules bound every refutation (from `coach-instructions.md`, treated as constitution — see
> **`endurance-coach-change-control`**): **don't overrule the platform** — use n=1 evidence to interpret/sanity-check
> AIE, never to run a competing hard-coded ruleset against its ML model; and **never re-derive the load science** —
> keep consuming AIE's FTP/CSS/threshold/recovery, don't rebuild the calibrated dose-response model. A "confirmed"
> n=1 finding *contextualises* AIE; it doesn't replace it.

---

## Phase 5 — Promote (through the gate) or retire (honestly)

Success is measurable, never eyeballed. Route the outcome through change-control — **do not** ship on `main`, and
**do not** route around the green-before-commit gate.

**If confirmed (survived Phases 3 AND 4):**
1. Make the label match the evidence exactly: *confirmed* only where the code's gate says so; keep
   "apparent"/"concordance"/"exploratory" wording wherever the gate is not met. No oversell.
2. **Add a test** that pins the invariant, fixture-driven, hermetic, no network — the pattern in
   `test/monitoring.test.ts` (validates a real signal out-of-sample; rejects pure noise; short series →
   exploratory) or `test/statvalidity.test.ts` (FDR yields ~no confirmations on noise). Recipe:
   **`endurance-coach-validation-and-qa`**. Coverage of the stats edge cases and the walk-forward path is a
   standing priority (test inversion) — thicken here.
3. Green before commit: `npm run typecheck && npm test` (expect **730 passing, ~6s, no network** as of
   2026-07-04). Code + docs move together — if you changed a threshold or a label, update `docs/insight-engine.md`
   and `docs/specs/improvements/04-statistical-validity.md` in the SAME commit.
4. Branch, then ship via change-control's flow. The write gate and wellbeing gate are untouched by insight work —
   surfacing a finding is display-only; it never mutates AIE.

**If NOT confirmed:**
- Surface it *exploratory* (the code already does this — 0.35 correlation confidence / 0.4 monitoring / "apparent"),
  or don't surface it. Never silently delete the hypothesis — record it as a watch item in `coaching-notes.md` so it
  can be re-tested as history accrues. An idea behind an off-by-default path is retired *on the record*, not
  abandoned (lifecycle → **`endurance-coach-research-methodology`**).

---

## Fenced-off wrong paths (memorise; each cost real time)

1. **Naive Pearson on trending series** → the #1 failure mode. Always go through `corrWithCi`; always read `effN`.
2. **P-hacking the lag / best-of-N** → the "FDR double-dip" that was investigated and found *already correct* in
   this code (Bonferroni-before-BH). Do not re-open it as a bug; the fix is in. Do preserve `selectedFrom`/
   `lagsScanned` inflation on any change.
3. **Validating against a non-independent outcome** (AIE recovery vs HRV) → tautology; at best *concordance*.
4. **Ignoring EF~CTL+time collinearity** → a fitness gain or a hot spell laundered into "economy". Keep the joint
   regression and the "apparent" label.
5. **Weakening a gate to make a finding surface** → the cardinal sin. Fewer confirmed findings is honesty, not a bug.

---

## Provenance and maintenance

Date-stamped **2026-07-04**. This skill cites thresholds and file layout that can drift; re-verify with:

```bash
cd /Users/maxeskell/dev/personal-training-app
# Correlation gate: n≥10 minimum, effN discount, FDR q=0.1, Bonferroni-on-lags:
grep -n "n < 10\|effN\|benjaminiHochberg\|q = 0.1\|lagsScanned" src/insights/stats.ts src/insights/correlations.ts
# Monitoring gate: ≥50 usable days, holdout ≥8 outcomes / ≥4 fires, J>0, pAdj<0.05, K=400, seed, 60/40 split:
grep -n "usableDays >= 50\|te.outcomes >= 8\|te.fires >= 4\|pAdj < 0.05\|K = 400\|0x9e3779b1\|n \* 0.6" src/insights/monitoring.ts
# Independence gate (Garmin sleep score vs AIE recovery):
grep -n "outcomeIndependent\|Garmin sleep score\|AI Endurance cardio-recovery" src/insights/monitoring.ts
# Efficiency gate: CI-excludes-0, "apparent", n≥6/≥10:
grep -n "economyReliable\|apparent\|n < 6" src/insights/efficiency.ts src/insights/stats.ts
# Surfacing confidences (0.8 vs 0.35 / 0.4) and the minConfidence=0.5 gate:
grep -n "fdrPass ? 0.8\|0.35\|minConfidence" src/insights/engine.ts src/insights/metrics.ts
# Commands still valid?
grep -n "backfill:status\|state:today\|deep-dive\|check\|career:build" package.json
# Test count (expect 730 pass, no network, as of 2026-07-04):
npm test 2>&1 | tail -5
# Source-of-truth docs for the statistical machinery:
sed -n '1,40p' docs/specs/improvements/04-statistical-validity.md
```

Known drift risks as of 2026-07-04: the change-point detector was **cut** (no `src/insights/changepoint.ts`) — do
not cite it; the dead `analyseFuelling([],[])` engine call was **removed** (single path via garminTrends). If a
future reader finds either back, spec 04 is the reconciliation record.
