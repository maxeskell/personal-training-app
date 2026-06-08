/**
 * Race-split estimator (user ask: "estimated splits for my upcoming races dependent on my training").
 *
 * Turns AI Endurance's predicted finish time into a per-segment pacing plan, shaped by the athlete's
 * measured DURABILITY trend (fatigue resistance late in long efforts). Strong durability → a gentle
 * negative split is realistic; weak/unknown durability → a conservative start that protects against the
 * late fade we actually measure. Deterministic; the predicted time is AIE's (MODEL — trend over absolute),
 * so splits are framed as a target plan, not a guarantee.
 */

export type DurabilityState = "improving" | "slipping" | "unknown";

export interface Segment {
  label: string;
  distanceKm: number;
  targetPaceSecPerKm: number;
  cumulativeSec: number;
}

export interface RaceSplitPlan {
  race: string;
  date?: string;
  distanceKm: number;
  predictedSec: number;
  strategy: string;
  segments: Segment[];
}

function paceClock(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
}

/** Per-segment pace factors (centred ~1) by strategy; later normalised so total = predictedSec. */
function factorsFor(strategy: "negative" | "conservative", n: number): number[] {
  // Linear ramp across n segments.
  const start = strategy === "negative" ? 1.015 : 1.025; // slower than avg early
  const end = strategy === "negative" ? 0.985 : 1.0; // faster (neg split) or hold (conservative)
  return Array.from({ length: n }, (_, i) => (n === 1 ? 1 : start + (end - start) * (i / (n - 1))));
}

export function estimateRunSplits(
  race: string,
  distanceKm: number,
  predictedSec: number,
  durability: DurabilityState,
  date?: string,
): RaceSplitPlan | null {
  if (!(distanceKm > 0) || !(predictedSec > 0)) return null;

  const seg = distanceKm >= 20 ? 5 : 1;
  const dists: number[] = [];
  let remaining = distanceKm;
  while (remaining > 0.001) {
    const d = Math.min(seg, remaining);
    dists.push(+d.toFixed(3));
    remaining -= d;
  }

  const strategy = durability === "improving" ? "negative" : "conservative";
  const factors = factorsFor(strategy, dists.length);
  const basePace = predictedSec / distanceKm;

  // Normalise so the plan's total equals the predicted finish exactly.
  const rawTotal = dists.reduce((acc, d, i) => acc + d * basePace * factors[i], 0);
  const k = predictedSec / rawTotal;

  let cum = 0;
  const segments: Segment[] = dists.map((d, i) => {
    const pace = basePace * factors[i] * k;
    cum += pace * d;
    return {
      label: seg === 5 ? `${Math.round(dists.slice(0, i).reduce((a, b) => a + b, 0))}–${Math.round(dists.slice(0, i + 1).reduce((a, b) => a + b, 0))} km` : `km ${i + 1}`,
      distanceKm: d,
      targetPaceSecPerKm: Math.round(pace),
      cumulativeSec: Math.round(cum),
    };
  });

  const strategyNote =
    strategy === "negative"
      ? `Durability is trending up, so a gentle negative split is realistic: open ~${paceClock(segments[0].targetPaceSecPerKm)} and squeeze the back half down to ~${paceClock(segments[segments.length - 1].targetPaceSecPerKm)}.`
      : `Durability is ${durability === "slipping" ? "slipping" : "not yet established"}, so start conservatively (~${paceClock(segments[0].targetPaceSecPerKm)}) and aim to hold — protect against the late fade rather than banking time early.`;

  return { race, date, distanceKm, predictedSec, strategy: strategyNote, segments };
}
