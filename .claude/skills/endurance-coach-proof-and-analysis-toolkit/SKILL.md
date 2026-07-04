---
name: endurance-coach-proof-and-analysis-toolkit
description: >-
  Load when you need to PROVE a statistical method in this repo's insight engine is correct, not just
  invoke it — deriving or checking any estimator in src/insights/stats.ts, correlations.ts, monitoring.ts,
  metrics.ts, efficiency.ts, or powerCurve.ts. Triggers: "prove it don't just install it", "derive the CI",
  "why effective-N / effN", "why Fisher-z", "why Bonferroni-before-BH", "how does the permutation null
  work", "why circular-shift not plain shuffle", "is this estimator right", "is corrWithCi correct", "what's
  the variance-inflation factor / VIF", "why q=0.1", "why K=400", "why seed 0x9e3779b1", "why the mulberry32
  PRNG", "derive CTL/ATL/TSB", "why τ=42/7 not 2/(τ+1)", "why EF~CTL+time not residualise-then-trend",
  "Frisch–Waugh–Lovell", "what does the power-curve collapse bug teach", "why mean-max power", reviewing a PR
  that changes a formula, or reproducing a correlation/monitoring/economy number by hand. This is the MATH
  home: it gives each estimator's derivation, exact code location, a worked example, and the failure mode it
  defends against. It does NOT own the go/no-go campaign steps for validating a finding (use sibling
  endurance-coach-n1-validation-campaign) or the plain-English meaning of the metrics (use sibling
  endurance-domain-reference).
---

# Proof & analysis toolkit — first-principles statistics of the insight engine

**Use this when** you must convince yourself (or a reviewer) that a statistical method in `src/insights/`
is *correct* — derive a confidence interval, justify a multiple-comparisons correction, re-derive the load
model, or reproduce a reported number by hand. **Don't use this when** you want the *decision procedure* for
whether a finding ships confirmed vs exploratory (that is the executable campaign in sibling
`endurance-coach-n1-validation-campaign`), or the *domain meaning* of CTL/EF/decoupling (sibling
`endurance-domain-reference`), or you are triaging a live "this correlation looks too good" symptom (sibling
`endurance-coach-debugging-playbook`).

Everything here is *deterministic and makes zero LLM calls* — these are pure functions with fixture tests.
You can reproduce every number in a Node REPL or a `node:test` file. Verify claims against the repo before
trusting them; exact line citations are given so you can `sed -n` the source.

## Why this toolkit exists (the one failure mode it fights)

The named enemy, stated in the header comment of `src/insights/stats.ts:1`: **"impressive-looking nonsense."**
Fitness (CTL), fatigue (ATL), HRV, RHR and weight are all heavily *autocorrelated* (today looks like
yesterday) and *trending*. Run a naive Pearson correlation on two such series and you get a big r with a tiny
p-value that means nothing — the effective information is a fraction of the point count. Every recipe below
is a defence against a specific way that nonsense sneaks in. Jargon is defined once, on first use.

| Term (defined once) | Meaning here |
|---|---|
| **n=1** | single-athlete statistics — one person's own history, not a population sample |
| **autocorrelation** | a series correlating with its own past (lag-1 = with yesterday). Inflates apparent significance |
| **effective N (`effN`)** | the sample size *after* discounting for autocorrelation — the honest information content |
| **Fisher-z** | the `atanh(r)` transform that makes a correlation's sampling distribution ~normal so a CI is computable |
| **CI excludes 0** | the local bar for "real": the 95% confidence interval does not contain zero |
| **FDR / Benjamini–Hochberg (BH)** | false-discovery-rate control — the guard against fishing across many metrics |
| **Bonferroni** | the blunt multiplicity correction: multiply a p-value by the number of tests searched |
| **permutation null** | shuffle the data to build the distribution of "skill by chance", then see if the real skill beats it |
| **walk-forward** | select a rule on early data, *report* only on held-out later data — no in-sample optimism |
| **CTL/ATL/TSB** | chronic (fitness) / acute (fatigue) training load and their difference (form). See domain-reference for meaning |
| **EF** | efficiency factor = average power ÷ average HR (higher = more output per heartbeat) |

---

## Recipe A — Autocorrelation-discounted correlation CI (`corrWithCi`)

**Where:** `src/insights/stats.ts:115` (`corrWithCi`), lag-1 helper `lag1Autocorr` at `:88`.
**Defends against:** raw n lying on trending, serially-dependent series (the #1 failure mode).

### The math, derivable by hand
1. Standard Pearson r, clamped to `[-0.999, 0.999]` so `atanh` stays finite (`stats.ts:139`).
2. Compute lag-1 autocorrelation `ρx`, `ρy` of each series (each clamped to `[-0.99, 0.99]`).
3. **Variance-inflation factor (VIF):** `vif = (1 + ρx·ρy) / (1 − ρx·ρy)` (`stats.ts:144`). Two positively
   autocorrelated series inflate the correlation's variance by this factor. Intuition: if both series drift
   slowly, consecutive point-pairs carry *redundant* information, so you have fewer independent observations
   than points.
4. **Effective N:** `effN = max(4, n / max(1, vif))` (`stats.ts:145`). This is the honest information count.
5. **Fisher-z CI on `effN`:** `z = atanh(r)`; `SE = 1/√(effN − 3)`; `CI = tanh(z ± 1.96·SE)` (`stats.ts:148-151`).
6. **"significant" ⇔ CI excludes 0** — `lo > 0 || hi < 0` (`stats.ts:158`). Minimum `n = 10` or it returns
   `null` (`stats.ts:127`).

> The comment at `stats.ts:24-26` is honest that population SD (÷n) is used elsewhere for personal-baseline
> z-scores, and that **`effN` is a heuristic autocorrelation discount, not a true degrees-of-freedom.** Do
> not represent `effN` as an exact df in any claim. This is a deliberate, documented choice (spec 04 item 3).

### Worked example (reproduce it)
Two independent series, each strongly autocorrelated → VIF is large → `effN` collapses far below n → the CI
is wide → not significant, correctly. Contrast a genuine relationship on weakly-autocorrelated series, where
`effN ≈ n` and a real r survives. The `test/stats.test.ts` `corrPValue` cases anchor the sign of the effect
(r=0.6, n=30 → p<0.01; r=0.1, n=30 → p>0.3). To see the CI machinery end-to-end, `test/efficiency.test.ts`
builds a deterministic fixture whose economy CI excludes 0 only when a real time-trend is present.

**The failure mode if you skip step 3-4:** you'd back-transform on raw n, the SE would be `1/√(n−3)`, and two
random walks would routinely report a "significant" correlation. That is exactly the artefact this file names.

---

## Recipe B — Multiplicity: Bonferroni-on-lag-scan, THEN Benjamini–Hochberg (`bestLaggedCorr` + `benjaminiHochberg`)

**Where:** `bestLaggedCorr` `src/insights/stats.ts:178`; `benjaminiHochberg` `stats.ts:210`; the two-step
correction applied in `src/insights/correlations.ts:156-165`.
**Defends against:** the "double-dip" — picking the best lag out of a search, then reporting *that* lag's
p-value as if you hadn't searched. This *was investigated as a suspected bug and found ALREADY CORRECT* (spec
`docs/specs/improvements/04-statistical-validity.md`, reconciled 2026-06-22 — the "Problem" section describes
the pre-fix state, resolved). Do not "re-fix" it; see sibling `endurance-coach-failure-archaeology`.

### The two-step, derivable
For each relationship the engine scans lags (e.g. predictor at t−k vs outcome at t, k in a small range). Two
multiplicity problems stack, so two corrections apply **in order**:
1. **Bonferroni over the lag search (per relationship):** inflate that relationship's p by the number of lags
   scanned — `corrPValue(c.r, c.effN) * (c.lagsScanned ?? 1)`, clamped to 1 (`correlations.ts:157-159`). This
   pays for having *picked the best lag*.
2. **Benjamini–Hochberg over the relationship set (q=0.1):** feed those already-inflated p-values into
   `benjaminiHochberg` (`stats.ts:210`). BH sorts p ascending and finds the largest k with
   `p(k) ≤ (k/m)·q`, passing all ranks ≤ k. This pays for testing *several relationships*.
3. **`fdrPass = BH-survived AND CI-excludes-0`** (`correlations.ts:162`). Both must hold. Anything else is
   relabelled `[exploratory — not FDR-confirmed]` in the interpretation string (`correlations.ts:163`).

`bestLaggedCorr` itself has a subtle correctness point (spec 04 item 2, fixed): it tracks *best-among-
significant* separately and only falls back to the strongest-|r| lag if none are significant — "a significant
lag always beats a stronger-|r| non-significant one" (`stats.ts:186-188`). Selecting a bigger-but-insignificant
lag would be a different flavour of the same double-dip.

### Worked example
`test/statvalidity.test.ts` `"FDR with lag-search inflation: pure noise yields ~no confirmations"` (line ~19)
runs a multi-lag scan on noise and asserts near-zero confirmations at q=0.1. `test/stats.test.ts` pins BH
exactly: `benjaminiHochberg([0.001,0.02,0.2,0.6,0.9], 0.1) === [true,true,false,false,false]`, and all-high p
→ all false. Reproduce BH by hand on those five to convince yourself of the `(k/m)·q` threshold.

> **Note on the archive sleep→load correlation** (`correlations.ts:49-81`, `sleepVsNextDayLoad`): it is
> computed OUTSIDE the BH set, so it hard-codes `fdrPass: false` and may only assert CI-excludes-0, never FDR
> confirmation (`correlations.ts:75-80`). A single uncorrected test cannot claim multiplicity control. This is
> the correct guard, not a gap.

---

## Recipe C — Walk-forward + circular-shift permutation null + Bonferroni-on-selection (`buildMonitoringRuleSet`)

**Where:** `src/insights/monitoring.ts:135` (`buildMonitoringRuleSet`), `permutationP` `monitoring.ts:235`,
using `mulberry32` (`stats.ts:223`) and `circularShift` (`stats.ts:239`).
**Defends against:** in-sample optimism (reporting on the same data you tuned on) AND a non-independent
outcome making an HRV rule tautological.

### The protocol, step by step
1. **Candidates:** 4 rules × 3 leads = up to 12 combos (`monitoring.ts:122-133`, `171`). Rules are z-score
   thresholds on rolling HRV/RHR baselines.
2. **Walk-forward split:** select the best combo (highest Youden J = hitRate − falseAlarmRate) on the earlier
   **~60%** of days; *report* hit/false-alarm only on the held-out later **~40%** (`monitoring.ts:167-177`).
   Selection touches only train; the reported number never saw its own tuning.
3. **Circular-shift permutation null** (`permutationP`, K=400, `monitoring.ts:235`): to build "skill by
   chance", **circular-shift the holdout OUTCOME** by a random offset and re-score. Why circular-shift and not
   a plain shuffle? A plain shuffle destroys the outcome's own autocorrelation, making the null artificially
   *easy* to beat; circular-shift **preserves the outcome's serial structure** while breaking its alignment to
   the predictor — the honest null (`stats.ts:234-244`). Seed is fixed `mulberry32(0x9e3779b1)`
   (`monitoring.ts:236`) so the p-value is reproducible run-to-run. `p = (ge + 1)/(K + 1)` (`monitoring.ts:250`),
   the +1 in both places being the standard unbiased Monte-Carlo estimator (never reports p=0).
4. **Bonferroni-on-selection:** `pAdj = min(1, pValue · max(1, combosTried))` (`monitoring.ts:200`) — pay for
   having picked the best of ~12. A best-of-12 that scrapes p=0.04 is selection optimism, not skill.
5. **`validated = true` gate** (`monitoring.ts:201`): holdout has **≥8 outcomes AND ≥4 fires** (enough events,
   spec 04 item 10), **Youden J > 0**, AND **pAdj < 0.05**. Fewer than **50 usable days** → no holdout is
   possible → in-sample only, hard-labelled `"in-sample (exploratory)"` and `validated: false`
   (`monitoring.ts:152-164`).
6. **Independent outcome preferred:** the engine prefers an *independent* outcome (Garmin sleep score) over
   AIE's recovery score, which is itself modelled from HRV/RHR — using it as the outcome for an HRV rule is
   tautological. When only the dependent series is available the finding is relabelled
   *"concordance, not independent prediction"* (`monitoring.ts:16-19`, `148`, `257`).

### Worked example
`test/monitoring.test.ts`: `"validates a real HRV→sleep signal out-of-sample"` (n=400) asserts
`method === "walk-forward + permutation"`, `validated === true`, `best.youdenJ > 0`; the companion
`"rejects pure noise"` asserts `validated === false`; and `"short series → in-sample/exploratory"` asserts a
sub-50-day series never reports validated. These three pin the gate from all sides.

---

## Recipe D — Banister/Coggan load model: CTL/ATL/TSB (`loadModel`)

**Where:** `src/insights/metrics.ts:156` (`loadModel`).
**Defends against:** using the technical-analysis EMA factor `2/(τ+1)` instead of the impulse-response decay,
which halves the effective time constant and inflates TSB swings.

### The math
An **impulse-response (Banister) exponentially-weighted moving average** with decay constant per day:
`k = 1 − e^(−1/τ)`. Two time constants:
- **CTL (chronic / "fitness"):** τ = 42 days → `ctlK = 1 − e^(−1/42) ≈ 0.0227` (`metrics.ts:161`).
- **ATL (acute / "fatigue"):** τ = 7 days → `atlK = 1 − e^(−1/7) ≈ 0.1308` (`metrics.ts:162`).
- **TSB (form):** `CTL − ATL` per day (`metrics.ts:171`).

Update each day: `ctl = ess[i]·k + ctl·(1−k)`. Input is AIE per-activity **ESS** (External Stress Score, a
TSS-equivalent daily load). **Seeding:** the EWMAs are seeded with the mean of the first ≤7 days, not `ess[0]`
alone (a single atypical first session would bias early CTL/ATL — spec 04 item 9, `metrics.ts:165`). Requires
**≥14 days** or returns `null` (`metrics.ts:159`). Weekly ramp = ΔCTL over the last 7 days (`metrics.ts:174-175`).

### Why NOT `2/(τ+1)` — derivable
The docstring at `metrics.ts:148-155` states it: the TA-EMA smoothing factor `2/(τ+1)` gives a "42-day" CTL an
effective time constant of ~21 days (reacts twice as fast), inflating TSB swings and the weekly ramp and
**diverging from the numbers an athlete cross-checks** against TrainingPeaks/AIE, which use the impulse-response
form. Two conventions, and only one matches the platform the coach defers to. (See `endurance-domain-reference`
for what these numbers *mean* physiologically; this recipe is only about the formula being right.)

---

## Recipe E — Economy beyond fitness: EF ~ CTL + time multiple regression (`mlr2`, `analyseEfficiency`)

**Where:** `mlr2` (2-predictor OLS with per-coefficient SE) `src/insights/stats.ts:64`; `analyseEfficiency`
`src/insights/efficiency.ts:39`.
**Defends against:** the collinearity trap — residualising EF on CTL then trending the residual on time leaves
CTL/time collinearity in the residual and *over-attributes* it to economy.

### The math
Is efficiency (EF = power/HR) improving *independently* of fitness, or just riding the CTL trend? Fit the
**joint** regression `EF ~ b1·CTL + b2·time + a` in one step (`mlr2`, closed-form on the centred normal
equations, `stats.ts:64-85`). The **time coefficient `b2`** is the EF↔time relationship *holding CTL
constant* — the Frisch–Waugh–Lovell-correct "economy beyond fitness". Its standard error `seB2 = √(s²·s11/det)`
is *correctly inflated by CTL/time collinearity* (small `det` = collinear predictors = wide SE), so the CI
honestly widens rather than over-claiming (`stats.ts:73-84`; comment `stats.ts:57-63`).

### The acceptance rule (and the honesty labels)
- Reports `economyPer30d = b2·30` with a 95% CI `b2·30 ± 1.96·seB2·30` (`efficiency.ts:65-67`).
- **Claim an economy gain only when the CI excludes 0** (`economyReliable = ciLow > 0`, `efficiency.ts:68`),
  needs **≥10 steady runs** (spec 04 item 6, `efficiency.ts:53`), sessions ≥40 min with power+HR.
- Even then it is labelled **"apparent"** (MODEL/estimate), because CTL and time are collinear and EF here is
  **not heat-adjusted** — a cool spell can flatter it (`efficiency.ts:94`). Values rounded to 2 sig figs
  because an n≈10 fit cannot support 4 dp (`efficiency.ts:34-37`).

### Worked example
`test/efficiency.test.ts` `"a time trend beyond CTL → an APPARENT economy gain (CI excludes 0)"`: a fixture
with a real time-trend independent of CTL yields `economyPer30d > 0`, `ciLow > 0`, `economyReliable === true`,
title `/Apparent economy/`, and the detail still carries the `heat-adjusted` caveat. The companion test shows
EF that only tracks CTL → no reliable economy gain. **The failure mode if you residualise-then-trend:** you'd
report a confident economy gain that is really the shared CTL/time trend leaking through.

---

## Recipe F — Mean-maximal power curve, and the collapse bug as a cautionary tale (`powerCurve.ts`)

**Where:** `bestAvgPower` `src/insights/powerCurve.ts:24`, `meanMaximalCurve` `:42`. The archive fix lives in
`src/insights/fit.ts` (`shouldDropSamples` `:309`, `keepSamplesFor`).
**Defends against:** a data-plumbing bug producing a *statistically-fine but wrong* curve.

### The computation
**Mean-maximal power (MMP), aka Coggan power curve:** for each standard duration `d`, the best average power
over any *contiguous* d-second window across an activity, taken as the max over all activities. `bestAvgPower`
is an O(n) sliding window: prime the first `d`-second sum, then slide `sum += p[i] − p[i−d]`
(`powerCurve.ts:24-36`). Samples are treated as ~1 Hz (a MODEL approximation); gaps count as **zero** power
(`powerCurve.ts:28`, `:9`). Pure and deterministic. `meanMaximalCurve` takes the per-duration max across
activities and records which activity set it (`powerCurve.ts:42-53`).

### The cautionary tale (verified — commits `870c814`, `d085c1d`, both dated 2026-07-03)
The estimator was *correct*; the **input data was truncated**. The all-time curve was only as deep as
`data/fit-streams/` (recent streams). The durable `data/activity-archive/` was scanned with per-second samples
*dropped for memory*, so its ride power never reached the curve. After the intervals.icu removal (which had
supplied the deep all-time curve), all-time **collapsed to the last ~3 weeks** and coincided with the last-90
line — one flat line where there should be three. Fix (`870c814`): keep per-second samples for **rides** across
the whole archive via `keepSamplesFor` / the pure `shouldDropSamples` (`fit.ts:309`), runs/swims still drop
theirs so memory stays bounded; the career build passes `sportFamily === 'ride'`. On this athlete's data the
all-time 5-second best went 577 W → 966 W (2024), a distinct line again. A companion render fix (`d085c1d`,
`mergeCoincidentSeries`) collapses point-for-point-identical curves into ONE honestly-labelled line so the
chart never silently hides a curve under an identical one.

**The lesson for this toolkit:** a green estimator on truncated input is still wrong. When a curve looks
"collapsed" or too shallow, first ask *what data actually reached the function*, not whether the formula is
right. Rebuild the curve with `cd /Users/maxeskell/dev/personal-training-app && npm run career:build --
--tp <trainingpeaks.csv> --fit-dir <dir>` (a bare run drops bests/trajectory). See sibling
`endurance-coach-failure-archaeology` for the settled history and `endurance-coach-debugging-playbook` for
live triage.

---

## How to run / reproduce any of these

These are pure functions. Two ways to check a number:

| Goal | Command (copy-paste) |
|---|---|
| Run the stats test suite only | `cd /Users/maxeskell/dev/personal-training-app && npx tsx --test test/stats.test.ts test/monitoring.test.ts test/efficiency.test.ts test/statvalidity.test.ts` |
| Full green gate before any change | `cd /Users/maxeskell/dev/personal-training-app && npm run typecheck && npm test` |
| Compute the whole insight engine on real state (deterministic) | `cd /Users/maxeskell/dev/personal-training-app && npm run deep-dive` |
| Read a function's source with line context | `cd /Users/maxeskell/dev/personal-training-app && sed -n '115,160p' src/insights/stats.ts` |

Any change to these formulas must land with a test and pass the green gate (`npm run typecheck && npm test`)
in the same commit — that gate is owned by sibling `endurance-coach-change-control`; the acceptance thresholds
("ships confirmed only if FDR-confirmed AND CI-excludes-0") are owned by sibling
`endurance-coach-validation-and-qa`. This skill only proves the math is right; it does not authorise shipping.

## Cross-references (one home per fact)

- **Go/no-go steps to validate a finding** → `endurance-coach-n1-validation-campaign` (this skill = the math it references).
- **Plain-English meaning of CTL/EF/decoupling/DFA-α1** → `endurance-domain-reference`.
- **"This correlation looks too good" live triage** → `endurance-coach-debugging-playbook`.
- **Why change-point detection was cut; the FDR-double-dip resolved-as-false history; the power-curve collapse** → `endurance-coach-failure-archaeology`.
- **What counts as evidence / the acceptance bar** → `endurance-coach-validation-and-qa`.
- **The green-before-commit gate** → `endurance-coach-change-control`.

---

## Provenance and maintenance

Verified against the repo on **2026-07-04** (branch `main`). Re-verify drift-prone facts:

| Fact | Re-verify command |
|---|---|
| Test count (730) & suite green | `cd /Users/maxeskell/dev/personal-training-app && npm test 2>&1 \| tail -6` |
| `corrWithCi` VIF / effN / Fisher-z math | `sed -n '115,160p' src/insights/stats.ts` |
| `benjaminiHochberg` (q=0.1) | `sed -n '206,220p' src/insights/stats.ts` |
| Bonferroni-before-BH two-step | `sed -n '152,166p' src/insights/correlations.ts` |
| Monitoring gate (≥8 outcomes/≥4 fires, pAdj<0.05, ≥50 days) | `sed -n '150,205p' src/insights/monitoring.ts` |
| Permutation null (K=400, seed 0x9e3779b1, circular-shift) | `sed -n '234,251p' src/insights/monitoring.ts` |
| Load-model decay k=1−e^(−1/τ), τ=42/7, seed=mean first ≤7d | `sed -n '148,176p' src/insights/metrics.ts` |
| `mlr2` closed form + per-coef SE | `sed -n '64,85p' src/insights/stats.ts` |
| Economy CI-excludes-0 rule, ≥10 runs, "apparent" label | `sed -n '39,101p' src/insights/efficiency.ts` |
| Power-curve MMP sliding window + collapse-bug commits | `git show 870c814 --stat; git show d085c1d --stat; sed -n '24,53p' src/insights/powerCurve.ts` |
| `shouldDropSamples`/`keepSamplesFor` archive fix | `grep -n 'shouldDropSamples\|keepSamplesFor' src/insights/fit.ts` |
| Spec 04 "FDR double-dip resolved" reconciliation | `sed -n '1,10p' docs/specs/improvements/04-statistical-validity.md` |
| `career:build` / `deep-dive` scripts exist | `grep -nE '"(career:build\|deep-dive)"' package.json` |
