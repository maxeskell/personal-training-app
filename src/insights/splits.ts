/**
 * Race-split estimator (user ask: "estimated splits for my upcoming races dependent on my training").
 *
 * RUN races: turns AI Endurance's predicted finish time into a per-segment pacing plan, shaped by the
 * athlete's measured DURABILITY trend (fatigue resistance late in long efforts). Strong durability → a
 * gentle negative split is realistic; weak/unknown durability → a conservative start that protects
 * against the late fade we actually measure.
 *
 * TRIATHLONS: builds per-leg (swim/T1/bike/T2/run) estimates from the athlete's CURRENT numbers —
 * swim CSS, bike FTP (power → flat-course speed via a physics model), and the standalone run
 * prediction — at standard age-group race-effort intensities per format. Deterministic; framed as a
 * target plan (MODEL — trend over absolute), not a guarantee.
 */

import { corrWithCi, slope } from "./stats.js";

export type DurabilityState = "improving" | "slipping" | "unknown";

export interface Segment {
  label: string;
  distanceKm: number;
  targetPaceSecPerKm: number;
  cumulativeSec: number;
  /** Display override for non-run legs (e.g. "1:52/100m", "208 W · ~34 km/h" — speed is a rough aero estimate). */
  target?: string;
}

export interface RaceSplitPlan {
  race: string;
  date?: string;
  distanceKm: number;
  predictedSec: number;
  strategy: string;
  segments: Segment[];
  /** Finish-time RANGE — worst = race it today (current fitness); best = race day if the build goes well. */
  worstSec?: number;
  bestSec?: number;
  rangeBasis?: string;
}

/** Cap on the best-case improvement we'll project from the trend — no runaway extrapolation. */
export const MAX_PROJECTED_GAIN = 0.07; // 7%

/**
 * Project a finish-time RANGE for a race:
 *  - worst case = your CURRENT prediction (race it today, at today's fitness);
 *  - best case  = that prediction carried along YOUR OWN recent race-predictor trajectory to race day,
 *    capped at MAX_PROJECTED_GAIN.
 * `fracImprovePerDay` is the fractional change in predicted finish time per day (negative = getting
 * faster); null or non-improving → no projected upside (best = current level). Honest MODEL: the best
 * case assumes you complete the planned build, stay healthy, adapt well and taper.
 */
export function projectRaceDayRange(
  predictedSec: number,
  daysToRace: number,
  fracImprovePerDay: number | null,
): { worstSec: number; bestSec: number; rangeBasis: string } {
  const worstSec = Math.round(predictedSec);
  if (fracImprovePerDay == null || fracImprovePerDay >= 0 || daysToRace <= 0) {
    return {
      worstSec,
      bestSec: worstSec,
      rangeBasis:
        daysToRace <= 0
          ? "Race is here — this is your current level."
          : "No improving trend to project yet, so best case = your current level. The range opens up once your race predictions start trending faster.",
    };
  }
  // Diminishing returns: fitness gains are concave and a build ends in a taper, so a recent sec/day rate
  // can't be carried LINEARLY to race day (the textbook over-promise). Saturate toward the cap instead —
  // ≈ linear for small gains, asymptotic to (never reaching) MAX_PROJECTED_GAIN for long horizons.
  const linearFrac = Math.abs(fracImprovePerDay) * daysToRace; // ≥0, the naive "rate holds" gain
  const projectedFrac = MAX_PROJECTED_GAIN * (1 - Math.exp(-linearFrac / MAX_PROJECTED_GAIN));
  return {
    worstSec,
    bestSec: Math.round(predictedSec * (1 - projectedFrac)),
    rangeBasis: `Best case carries your recent rate of improvement toward race day with diminishing returns (gains are concave and a build ends in a taper), capped near ${Math.round(MAX_PROJECTED_GAIN * 100)}%, and only when that trend is statistically reliable. It assumes you complete the planned build, stay healthy, adapt well and taper. Worst case is racing at today's fitness.`,
  };
}

/**
 * Reliability-gated improvement rate (fraction of finish-time per day; negative = getting faster) from the
 * athlete's own dated race-prediction history. Returns null UNLESS the downward trend is statistically
 * distinguishable from noise — an autocorrelation-aware Fisher-z CI (corrWithCi) that excludes 0 — so we
 * never project a best-case upside off a handful of noisy points. `nearestPredicted` scales the OLS slope
 * (sec/day) into the fraction projectRaceDayRange consumes.
 */
export function reliableImprovementPerDay(
  trajectory: Array<{ date: string; v: number }>,
  nearestPredicted: number | undefined,
): number | null {
  if (!nearestPredicted || trajectory.length < 6) return null;
  const epoch = new Date(`${trajectory[0].date}T00:00:00Z`).getTime();
  const xs = trajectory.map((p) => (new Date(`${p.date}T00:00:00Z`).getTime() - epoch) / 86_400_000);
  const ys = trajectory.map((p) => p.v);
  const c = corrWithCi(xs, ys);
  if (!c || !c.significant || c.r >= 0) return null; // need a RELIABLE, decreasing (faster) trend
  const b = slope(xs, ys); // sec/day
  return b == null ? null : b / nearestPredicted;
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

// ---------- Triathlon legs ----------

export type TriRaceType = "sprint" | "olympic" | "half-iron" | "ironman";

/** The athlete's current numbers a tri plan is built from (all optional — legs degrade individually). */
export interface TriPerformance {
  cssSecPer100?: number;
  ftpW?: number;
  runThresholdPaceSecPerKm?: number;
  /** Standalone run race predictions (Garmin race predictor) — preferred run-leg basis. */
  runPredictions?: Partial<Record<"5K" | "10K" | "Half" | "Marathon", number>>;
  riderWeightKg?: number;
}

/** Per-format leg distances + standard age-group race-effort factors. */
const TRI: Record<
  TriRaceType,
  {
    label: string;
    swimM: number;
    bikeKm: number;
    runKm: number;
    runPred: "5K" | "10K" | "Half" | "Marathon";
    swimCssFactor: number; // race swim pace as ×CSS
    bikeIF: number; // bike intensity factor (×FTP)
    runOffBikeFactor: number; // off-the-bike penalty on the standalone run prediction
    runThresholdFactor: number; // fallback: race run pace as ×threshold pace
    t1Sec: number;
    t2Sec: number;
  }
> = {
  sprint: { label: "Sprint", swimM: 750, bikeKm: 20, runKm: 5, runPred: "5K", swimCssFactor: 1.0, bikeIF: 0.88, runOffBikeFactor: 1.03, runThresholdFactor: 1.0, t1Sec: 150, t2Sec: 90 },
  olympic: { label: "Olympic", swimM: 1500, bikeKm: 40, runKm: 10, runPred: "10K", swimCssFactor: 1.02, bikeIF: 0.83, runOffBikeFactor: 1.05, runThresholdFactor: 1.05, t1Sec: 180, t2Sec: 120 },
  "half-iron": { label: "Half-iron (70.3)", swimM: 1900, bikeKm: 90, runKm: 21.1, runPred: "Half", swimCssFactor: 1.06, bikeIF: 0.75, runOffBikeFactor: 1.07, runThresholdFactor: 1.13, t1Sec: 240, t2Sec: 150 },
  ironman: { label: "Ironman", swimM: 3800, bikeKm: 180, runKm: 42.2, runPred: "Marathon", swimCssFactor: 1.1, bikeIF: 0.68, runOffBikeFactor: 1.1, runThresholdFactor: 1.25, t1Sec: 300, t2Sec: 180 },
};

function clock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function hmsClock(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, "0")}` : `${m}min`;
}

function pctOver(factor: number): string {
  const pct = Math.round((factor - 1) * 100);
  return pct === 0 ? "" : `+${pct}%`;
}

/**
 * Flat-course speed (m/s) from power, Newton-solved from P = v·(Crr·m·g + ½ρ·CdA·v²).
 * Road-bike-on-clip-ons assumptions: Crr 0.005, CdA 0.32, ρ 1.225, bike+kit +9 kg.
 */
function speedMsFromPower(watts: number, riderKg: number): number {
  const mass = riderKg + 9;
  const roll = 0.005 * mass * 9.81;
  const aero = 0.5 * 1.225 * 0.32;
  let v = 9;
  for (let i = 0; i < 25; i++) {
    v -= (v * (roll + aero * v * v) - watts) / (roll + 3 * aero * v * v);
  }
  return v;
}

/**
 * Per-leg triathlon plan from the athlete's current CSS / FTP / run prediction. Legs whose input is
 * missing are skipped and named in the strategy note (never fabricated); null only when NO leg can be
 * estimated. Transitions are fixed per-format estimates.
 */
export function estimateTriSplits(
  race: string,
  type: TriRaceType,
  perf: TriPerformance,
  durability: DurabilityState,
  date?: string,
): RaceSplitPlan | null {
  const c = TRI[type];
  const hasSwim = perf.cssSecPer100 != null && perf.cssSecPer100 > 0;
  const hasBike = perf.ftpW != null && perf.ftpW > 0;
  const runPredSec = perf.runPredictions?.[c.runPred];
  const hasRun = (runPredSec != null && runPredSec > 0) || (perf.runThresholdPaceSecPerKm != null && perf.runThresholdPaceSecPerKm > 0);
  if (!hasSwim && !hasBike && !hasRun) return null;

  const segments: Segment[] = [];
  const basis: string[] = [];
  const missing: string[] = [];
  let cum = 0;
  let raced = 0;
  const push = (label: string, distanceKm: number, sec: number, target: string) => {
    cum += sec;
    raced += distanceKm;
    segments.push({ label, distanceKm, targetPaceSecPerKm: distanceKm > 0 ? Math.round(sec / distanceKm) : 0, cumulativeSec: Math.round(cum), target });
  };

  if (hasSwim) {
    const pace100 = perf.cssSecPer100! * c.swimCssFactor;
    push(`Swim ${c.swimM} m`, c.swimM / 1000, (c.swimM / 100) * pace100, `${clock(pace100)}/100m`);
    basis.push(`swim ~CSS${pctOver(c.swimCssFactor)} (CSS ${clock(perf.cssSecPer100!)}/100m)`);
  } else {
    missing.push("swim (no CSS set)");
  }
  push("T1", 0, c.t1Sec, "transition");

  if (hasBike) {
    const watts = Math.round(perf.ftpW! * c.bikeIF);
    const v = speedMsFromPower(watts, perf.riderWeightKg ?? 75);
    push(`Bike ${c.bikeKm} km`, c.bikeKm, (c.bikeKm * 1000) / v, `${watts} W · ~${Math.round(v * 3.6)} km/h`);
    basis.push(`bike ~${Math.round(c.bikeIF * 100)}% FTP (${watts} W of ${perf.ftpW} W, flat-course aero model)`);
  } else {
    missing.push("bike (no FTP)");
  }
  push("T2", 0, c.t2Sec, "transition");

  if (hasRun) {
    let pace: number;
    if (runPredSec != null && runPredSec > 0) {
      pace = (runPredSec * c.runOffBikeFactor) / c.runKm;
      basis.push(`run off the bike ${pctOver(c.runOffBikeFactor)} over your standalone ${c.runPred} prediction (${hmsClock(runPredSec)})`);
    } else {
      pace = perf.runThresholdPaceSecPerKm! * c.runThresholdFactor;
      basis.push(`run at threshold pace ${pctOver(c.runThresholdFactor) || "±0%"}`);
    }
    push(`Run ${c.runKm} km`, c.runKm, pace * c.runKm, `${clock(pace)}/km`);
  } else {
    missing.push("run (no prediction or threshold pace)");
  }

  const runAdvice =
    durability === "improving"
      ? "Durability is trending up — hold back the first km of the run and wind it up; a negative-split run is realistic."
      : durability === "slipping"
        ? "Durability is slipping — open the run conservatively and protect against the late fade."
        : "Open the run conservatively until your durability trend firms up.";
  const strategy = `${c.label}-distance plan from your current numbers: ${basis.join("; ")}. Transitions are fixed estimates. ${runAdvice}${
    missing.length ? ` No estimate for ${missing.join(", ")}.` : ""
  }`;

  return { race, date, distanceKm: +raced.toFixed(1), predictedSec: Math.round(cum), strategy, segments };
}
