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

/**
 * Linear kg/week trend from a dated series. Conservative by design (review #4): needs a real multi-week
 * window — ≥6 readings spanning ≥21 days — before it will report a trend, so day-to-day BIA noise can't
 * trip it.
 */
function perWeekTrend(points: Array<{ date: string; kg: number }>): number | null {
  if (points.length < 6) return null;
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const spanDays = (new Date(`${sorted[sorted.length - 1].date}T00:00:00Z`).getTime() - new Date(`${sorted[0].date}T00:00:00Z`).getTime()) / 86_400_000;
  if (spanDays < 21) return null;
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
  // Gentle flag only when there's a populated muscle TREND AND both weight and muscle are clearly
  // falling together over weeks. Thresholds are deliberately large — BIA muscle mass is noisy, so this
  // is a "worth a look" nudge, not a measurement claim.
  const flag =
    weightTrendKgPerWk != null && muscleTrendKgPerWk != null && weightTrendKgPerWk < -0.2 && muscleTrendKgPerWk < -0.1;
  return { weightTrendKgPerWk, muscleTrendKgPerWk, flag };
}

export function fuellingFinding(f: FuellingAnalysis): Finding | null {
  if (!f.flag) return null;
  return {
    family: "Fuelling & body comp",
    title: "Weight and muscle both trending down",
    severity: "watch",
    detail:
      `Over recent weeks both weight (~${Math.abs(f.weightTrendKgPerWk!)} kg/wk) and bioimpedance skeletal-muscle mass (~${Math.abs(f.muscleTrendKgPerWk!)} kg/wk) are drifting down together. ` +
      `BIA muscle mass is noisy, so this isn't a diagnosis — but losing muscle alongside weight can mean under-fuelling rather than a useful W/kg gain. Worth a look: prioritise fuelling around sessions and protein.`,
    evidence: `weight ${f.weightTrendKgPerWk} kg/wk, BIA skeletal muscle ${f.muscleTrendKgPerWk} kg/wk over ≥3 weeks [garmin Index S2 — noisy]`,
    recommendation: "If this persists, consider checking in with a sports dietitian / professional rather than acting on the scale alone.",
    confidence: 0.55,
  };
}
