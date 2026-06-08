/**
 * Fuelling / under-recovery red flag (data-scientist brief Q7): does any weight loss coincide with
 * FALLING skeletal muscle mass? Weight drifting down can raise W/kg — but only if it's fat, not muscle.
 * Muscle loss during a deficit means the athlete is under-fuelling and cannibalising the engine: a stop
 * signal, not a win. Body composition is the one place the catalogue says a "loss" can be a health flag.
 *
 * Inputs are TRENDS (kg/week), never daily targets, per the catalogue's H1/H3 honesty rules. The flag
 * only fires when BOTH weight and muscle are trending down together; weight alone is treated as neutral.
 */

import type { Finding } from "./metrics.js";
import { mean } from "./stats.js";

export interface FuellingAnalysis {
  weightTrendKgPerWk: number | null;
  muscleTrendKgPerWk: number | null;
  flag: boolean;
}

/** Linear kg/week trend from a dated series (sparse weigh-ins are fine). */
function perWeekTrend(points: Array<{ date: string; kg: number }>): number | null {
  if (points.length < 4) return null;
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const epoch = new Date(`${sorted[0].date}T00:00:00Z`).getTime();
  const xs = sorted.map((p) => (new Date(`${p.date}T00:00:00Z`).getTime() - epoch) / 86_400_000);
  const ys = sorted.map((p) => p.kg);
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  if (sxx === 0) return null;
  return +((sxy / sxx) * 7).toFixed(3); // per-day slope → per-week
}

export function analyseFuelling(
  weightSeries: Array<{ date: string; kg: number }>,
  muscleSeries: Array<{ date: string; kg: number }>,
  weightTrendFallbackKgPerWk?: number | null,
): FuellingAnalysis {
  const weightTrendKgPerWk = perWeekTrend(weightSeries) ?? weightTrendFallbackKgPerWk ?? null;
  const muscleTrendKgPerWk = perWeekTrend(muscleSeries);
  // Red flag: weight clearly dropping AND muscle dropping with it.
  const flag = weightTrendKgPerWk != null && muscleTrendKgPerWk != null && weightTrendKgPerWk < -0.1 && muscleTrendKgPerWk < -0.05;
  return { weightTrendKgPerWk, muscleTrendKgPerWk, flag };
}

export function fuellingFinding(f: FuellingAnalysis): Finding | null {
  if (!f.flag) return null;
  return {
    family: "Fuelling & body comp",
    title: "Weight loss is taking muscle with it",
    severity: "flag",
    detail:
      `Weight is trending down ${Math.abs(f.weightTrendKgPerWk!)} kg/wk AND skeletal muscle ${Math.abs(f.muscleTrendKgPerWk!)} kg/wk — ` +
      `that's under-fuelling cannibalising the engine, not a W/kg gain. Eat more, especially protein and around sessions; this is a stop signal.`,
    evidence: `weight ${f.weightTrendKgPerWk} kg/wk, skeletal muscle ${f.muscleTrendKgPerWk} kg/wk (BIA trends) [garmin Index S2]`,
    recommendation: "Raise daily intake toward the adequate-fuelling range and re-check muscle mass in 2–3 weeks.",
    confidence: 0.85,
  };
}
