# Spec 4 — Statistical validity (make the certainty labels honest)

**Status:** proposed · **Priority:** P0/P1 · **Size:** M · **Owner:** TBD

## Problem
Several "honest-uncertainty" mechanisms quietly undermine themselves, so labels like "FDR-confirmed,
80% confidence" and "a genuine shift" over-claim — the exact "impressive-looking nonsense" the project brief
warns against. Plus a permanently-dead detector and timezone bucketing that can flip an injury flag.

## Goals
- Every surfaced statistical claim is defensible: multiplicity accounted for, no ratios on signed/near-zero
  bases, regime shifts significance-checked, one consistent variance convention.
- No dead/duplicated detectors; load/ramp bucketed by the athlete's local date.

## Findings → fixes (file:line)
1. **FDR double-dip** (`correlations.ts:~150`, `stats.ts` `corrPValue`/`bestLaggedCorr`): p-values come from the
   r/lag chosen by a 5-lag × 3-relationship max-|r| search; multiplicity ignored → anti-conservative.
   **Fix:** permutation-test the whole lag-scan (shuffle outcome, recompute best-|r| across all lags, build the null),
   or at minimum widen the BH input to every (relationship × lag) tested and/or inflate p by the search size. Re-derive
   the confidence/label from the corrected p.
2. **`bestLaggedCorr` selection** (`stats.ts:128`): can keep a non-significant max-|r| lag over a weaker significant
   one. **Fix:** track best-among-significant separately; fall back to `minLag` only if none significant.
3. **Variance convention** (`stats.ts:24` vs `:92`): population SD (÷n) with sampling-theory Fisher-z CIs.
   **Fix:** use ÷(n−1) for inferential paths (or document the choice); state `effN` is a heuristic discount, not df.
4. **Ratios on signed/near-zero bases**: heat `heatAttributedPct` (`heat.ts:~87`) explodes when `efChangePct`≈0;
   change-point % (`changepoint.ts:~95`) and EF deltas on negative/durability bases. **Fix:** floor denominators
   (e.g. require |Δ| ≥ 2% before attributing); never form % on a signed base (durability already fixed in the UI — do
   it at source too).
5. **Change-points unvalidated but called "genuine"** (`changepoint.ts:~116`): **Fix:** per-segment σ², and a
   permutation/penalty-sensitivity check; soften wording + lower confidence when not validated.
6. **EF~CTL collinearity** (`efficiency.ts:62`): CTL trends with time, so the residual-trend "economy beyond fitness"
   is ill-identified. **Fix:** joint `EF ~ CTL + t`, report the `t` coefficient with a CI; else state the limitation.
7. **Dead/duplicated fuelling** (`engine.ts:~285`): `analyseFuelling([], [], …)` can never fire; real series only
   reaches `garminTrends.fuellingFromGarmin`. **Fix:** remove the dead engine call (single source = garminTrends).
8. **UTC week bucketing** (`metrics.ts:~68`, `runLoadRamp`): activities near local midnight land in the wrong ISO
   week → can flip a flag-severity run-load-spike. **Fix:** bucket by the captured local activity date everywhere.
9. **Load model** (`metrics.ts:138`): CTL/ATL cold-start = `ess[0]` (early-window bias) and 0-padding ignores date
   gaps. **Fix:** short burn-in / trailing-mean seed; build on a dense date axis.
10. **Monitoring small-n power** (`monitoring.ts`): `canHoldout` at 50 days → ~3–5 holdout events; permutation
    near-powerless. **Fix:** raise the holdout-event floor; when below it, label "insufficient power" rather than a clean p.
11. **De-dup primitives**: 4+ copies of `mean`/`slope`/`zscore` with inconsistent null handling → consolidate in `stats.ts`.

## Acceptance criteria
- An exploratory correlation no longer earns "[FDR-confirmed]" unless it survives multiplicity-aware testing.
- No finding can display a % attribution when the underlying change is below the floor.
- `analyseHeat` returns no attribution when `|efChangePct|` < floor (unit-tested).
- The dead fuelling call is gone; one fuelling code path remains.
- Load-ramp week assignment matches the athlete's local calendar (unit-tested across a midnight boundary).

## Test plan (also closes the worst coverage gaps)
- `corrWithCi` against a reference dataset (known r + CI); `bestLaggedCorr` prefers significant-but-weaker.
- FDR: a pure-noise multi-lag scan yields ~no confirmations at q=0.1.
- `analyseHeat`: tiny-Δ input → no attribution; real signal → bounded attribution.
- `changePointsOf`: flat series → none; a true step → one, with the significance gate.
- `loadModel`/`runLoadRamp`: gappy + local-midnight fixtures.
- Small-n (n≈60) monitoring test beside the existing n=400.

## Risks
- Tightening FDR/labels will surface **fewer** "confirmed" patterns — that's correct; communicate it as honesty, not regression.
