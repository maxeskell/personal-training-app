import type { AthleteState, Provenanced } from "./types.js";

/**
 * Rolling baselines for the interpretable readiness signals (Build Spec §8).
 * Trend beats single point — these power "vs personal baseline" comparisons so
 * one bad night never flips the verdict (acceptance criterion §9.2).
 *
 * Simple trailing mean over available history; ignores nulls. Swap for an EWMA
 * later if we want recency weighting.
 */

function mean(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x));
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function values(history: AthleteState[], pick: (s: AthleteState) => Provenanced<number>): number[] {
  return history
    .map((s) => pick(s).value)
    .filter((x): x is number => x !== null && Number.isFinite(x));
}

export interface Baselines {
  hrv7d: number | null;
  restingHr7d: number | null;
  weight7dTrend: number | null;
}

/**
 * Compute 7-day baselines from prior history (caller passes the trailing window,
 * typically the last ~7 days INCLUDING today if today's reading exists).
 */
export function computeBaselines(window: AthleteState[]): Baselines {
  return {
    hrv7d: mean(values(window, (s) => s.hrvOvernight)),
    restingHr7d: mean(values(window, (s) => s.restingHr)),
    weight7dTrend: mean(values(window, (s) => s.weightKg)),
  };
}

/** Write computed baselines back onto today's state with `derived` provenance. */
export function applyBaselines(today: AthleteState, b: Baselines): void {
  today.hrv7dBaseline = { value: b.hrv7d, source: "derived", note: "7d trailing mean" };
  today.restingHr7dBaseline = { value: b.restingHr7d, source: "derived", note: "7d trailing mean" };
  today.weight7dTrend = {
    value: b.weight7dTrend,
    source: "derived",
    note: "7d trailing mean (trend only, never a daily target)",
  };
}
