/**
 * Garmin daily-series trend detectors (Phase 2 — health/injury slice 1b).
 *
 * These run over the backfilled Garmin daily series (get_sleep_data / get_all_day_stress /
 * get_respiration_data / get_body_composition). All compare the recent window to the athlete's own
 * rolling baseline — absolute values matter far less than deviation from personal norm:
 *   - Illness early-warning: overnight respiration + skin-temp rising together = pre-symptomatic flag.
 *   - Stress trend: chronically elevated all-day stress vs baseline = total-life load red flag.
 *   - Body-Battery recharge: a falling overnight recharge = poor recovery.
 *   - Sleep architecture: a sustained deep-sleep decline.
 *   - Sleep duration: total sleep trending short (and short in absolute terms) vs baseline.
 *   - Data quality: any reading that looks like a measurement error (delegates to insights/dataQuality).
 *   - Fuelling: weight + skeletal-muscle both trending down (delegates to insights/fuelling).
 * Each self-gates on coverage and stays silent without enough history.
 */

import { trailingZ, mean, type Maybe } from "./stats.js";
import type { Finding } from "./metrics.js";
import { analyseFuelling, fuellingFinding } from "./fuelling.js";
import { detectDataQuality } from "./dataQuality.js";

export interface GarminDaily {
  date: string;
  sleepHours?: number;
  restingHr?: number;
  deepSleepSec?: number;
  skinTempDevC?: number;
  bodyBatteryChange?: number;
  avgSleepRespiration?: number;
  avgWakingRespiration?: number;
  avgStressLevel?: number;
  muscleMassKg?: number;
  weightKg?: number;
}

const series = (days: GarminDaily[], k: keyof GarminDaily): Maybe[] =>
  days.map((d) => (typeof d[k] === "number" ? (d[k] as number) : null));

/** Mean of the last `n` non-null values. */
function recentMean(xs: Maybe[], n: number): number | null {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? mean(v.slice(-n)) : null;
}

/**
 * Illness early-warning: overnight respiration elevated AND skin-temp deviation up vs personal baseline
 * (optionally corroborated by RHR). Pre-symptomatic by 1–2 days — worth catching in race build/taper.
 */
export function illnessEarlyWarning(days: GarminDaily[]): Finding | null {
  const respZ = trailingZ(series(days, "avgSleepRespiration"));
  const skinZ = trailingZ(series(days, "skinTempDevC"));
  const rhrZ = trailingZ(series(days, "restingHr"));
  if (!respZ && !skinZ) return null;
  const respHigh = respZ != null && respZ.z >= 1;
  const skinHigh = skinZ != null && skinZ.z >= 1;
  const rhrHigh = rhrZ != null && rhrZ.z >= 1;
  const hits = [respHigh, skinHigh, rhrHigh].filter(Boolean).length;
  if (hits < 2) return null; // need at least two corroborating signals
  return {
    family: "Illness early-warning",
    title: "Pre-illness signals stacking",
    severity: "watch",
    detail:
      `Two+ overnight signals are above your baseline together: ${[respHigh ? `respiration +${respZ!.z}σ` : "", skinHigh ? `skin-temp +${skinZ!.z}σ` : "", rhrHigh ? `resting HR +${rhrZ!.z}σ` : ""].filter(Boolean).join(", ")}. ` +
      `That combination often precedes illness by 1–2 days — bank easy days now and watch how you wake tomorrow.`,
    evidence: `overnight respiration + skin-temp (+ RHR) vs rolling baseline [garmin]`,
    recommendation: "Treat today/tomorrow as amber: easy aerobic only, extra sleep and fuelling; pull a hard session if it persists.",
    confidence: hits >= 3 ? 0.7 : 0.6,
  };
}

/** All-day stress chronically elevated vs baseline = total-life load exceeding capacity. */
export function stressTrend(days: GarminDaily[]): Finding | null {
  const s = series(days, "avgStressLevel");
  const z = trailingZ(s);
  const recent = recentMean(s, 7);
  if (!z || recent == null) return null;
  if (z.z < 1 || recent < 35) return null; // only flag a real, sustained elevation
  return {
    family: "Life stress load",
    title: "All-day stress running high",
    severity: "watch",
    detail:
      `Your 7-day average daytime stress (${Math.round(recent)}) is ${z.z}σ above your baseline (${z.mean}). ` +
      `Chronically elevated all-day stress alongside training is total-life load exceeding capacity — the recovery you're getting is worth less than the numbers suggest.`,
    evidence: `all-day stress 7-day mean vs ${"rolling baseline"} [garmin]`,
    recommendation: "Protect sleep and easy days; consider trimming training load until daytime stress settles.",
    confidence: 0.6,
  };
}

/** Overnight Body-Battery recharge falling vs baseline = recovery not keeping up. */
export function bodyBatteryRecharge(days: GarminDaily[]): Finding | null {
  const s = series(days, "bodyBatteryChange");
  const z = trailingZ(s);
  const recent = recentMean(s, 5);
  if (!z || recent == null) return null;
  if (z.z > -1) return null; // only when recharge is notably below personal norm
  return {
    family: "Recovery (Body Battery)",
    title: "Overnight recharge is low",
    severity: "watch",
    detail:
      `Recent overnight Body-Battery recharge (${Math.round(recent)}) is ${z.z}σ below your baseline (${z.mean}) — your nights aren't refilling the tank as well as usual. The recharge RATE is the signal here, not the morning number.`,
    evidence: `overnight Body-Battery change vs rolling baseline [garmin]`,
    recommendation: "Prioritise sleep duration/quality and ease training until overnight recharge recovers.",
    confidence: 0.55,
  };
}

/** Sustained deep-sleep decline (recovery debt accumulating through a hard block). */
export function sleepArchitecture(days: GarminDaily[]): Finding | null {
  const deepMin = days.map((d) => (typeof d.deepSleepSec === "number" ? d.deepSleepSec / 60 : null));
  const z = trailingZ(deepMin);
  const recent = recentMean(deepMin, 7);
  if (!z || recent == null) return null;
  if (z.z > -1) return null;
  return {
    family: "Sleep architecture",
    title: "Deep sleep trending down",
    severity: "watch",
    detail:
      `Your 7-day deep-sleep average (${Math.round(recent)} min/night) is ${z.z}σ below baseline (${Math.round(z.mean)} min). A sustained deep-sleep decline through a hard block is recovery debt — often the earliest sleep signal before HRV/RHR move.`,
    evidence: `deep-sleep minutes 7-day mean vs rolling baseline [garmin]`,
    confidence: 0.55,
  };
}

/** Sustained SHORT sleep: total sleep both below personal baseline AND short in absolute terms. */
export function sleepDurationLow(days: GarminDaily[]): Finding | null {
  const s = series(days, "sleepHours");
  const z = trailingZ(s);
  const recent = recentMean(s, 7);
  if (!z || recent == null) return null;
  // Needs BOTH: a real dip below your own norm (z ≤ -1) and a short absolute average (< 7h) — so a
  // long sleeper dropping from 9h to 8h doesn't trip it, but a genuine short-sleep block does.
  if (z.z > -1 || recent >= 7) return null;
  return {
    family: "Sleep duration",
    title: "Sleep duration trending short",
    severity: "watch",
    detail:
      `Your 7-day average sleep (${recent.toFixed(1)} h/night) is ${z.z}σ below your baseline (${z.mean} h) and short in absolute terms. ` +
      `Sustained short sleep through a training block blunts recovery and adaptation — often before HRV/RHR move.`,
    evidence: `total sleep hours 7-day mean vs rolling baseline [garmin]`,
    recommendation: "Protect the sleep opportunity (earlier lights-out, limit late alcohol/screens) and ease intensity until it recovers.",
    confidence: 0.55,
  };
}

/** Fuelling: feed the existing weight+muscle detector with the real Garmin body-composition series. */
export function fuellingFromGarmin(days: GarminDaily[]): Finding | null {
  const weight = days.filter((d) => d.weightKg != null).map((d) => ({ date: d.date, kg: d.weightKg! }));
  const muscle = days.filter((d) => d.muscleMassKg != null).map((d) => ({ date: d.date, kg: d.muscleMassKg! }));
  return fuellingFinding(analyseFuelling(weight, muscle));
}

/** All slice-1b trend findings from the backfilled daily series.
 *  (Fuelling is owned by the engine's analyseFuelling on the same body-comp series — not duplicated here.) */
export function garminTrendFindings(days: GarminDaily[] | undefined): Finding[] {
  if (!days || days.length < 21) return [];
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const trends = [
    illnessEarlyWarning(sorted),
    stressTrend(sorted),
    bodyBatteryRecharge(sorted),
    sleepArchitecture(sorted),
    sleepDurationLow(sorted),
  ].filter((f): f is Finding => f != null);
  // Data-quality checks run across every stream — surfaced alongside the trend findings.
  return trends.concat(detectDataQuality(sorted));
}
