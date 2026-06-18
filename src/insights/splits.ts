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
  /** Time for THIS segment alone (the split). Derived from rounded cumulatives so splits sum exactly. */
  splitSec: number;
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

/** Cap on the best-case improvement we'll project — no runaway extrapolation. */
export const MAX_PROJECTED_GAIN = 0.07; // 7%

// --- Planned-training (CTL) forward-projection constants (the PRIMARY race-day basis) ---
/** Cap on the projected fractional CTL (fitness) gain over the whole horizon — ramps plateau, so the
 * naive "this week's ramp holds to race day" saturates toward this instead of growing without bound. */
export const CTL_GAIN_SATURATION = 0.3; // 30%
/** Coarse performance elasticity: fractional finish-time improvement per unit fractional CTL gain. A
 * deliberately conservative MODEL constant (a ~10% fitness gain → ~2.5% faster), hard-capped below by
 * MAX_PROJECTED_GAIN. Tune here if your own prediction-vs-fitness history says otherwise. */
export const FITNESS_TIME_ELASTICITY = 0.25;
/** Below this the projected upside is within prediction noise (and vanishes once rounded to the minute),
 * so we treat it as "no usable upside" and let the fallback / current-level basis take over. */
const MIN_MEANINGFUL_GAIN = 0.003; // 0.3%

/**
 * FALLBACK race-day basis (used when there's no usable PLAN reaching the race — see projectFromFitnessGain
 * for the primary). Projects the athlete's CURRENT build ramp forward to race day and maps the fitness
 * gain to a finish-time gain. Returns null (→ caller falls back further) when there's no usable build: no
 * CTL, a flat/non-positive ramp (maintaining or tapering), the race is here, or the upside is negligible.
 *
 * `rampPerWeek` should be a ROBUST current ΔCTL/week (e.g. an OLS slope over ~21d, floored at 0) — steady
 * against a single recovery week. Honest MODEL: assumes you hold the build, stay healthy, adapt and taper.
 */
export function projectFromTrainingLoad(
  ctlNow: number | null | undefined,
  rampPerWeek: number | null | undefined,
  daysToRace: number,
): { projectedFrac: number; basis: string } | null {
  if (ctlNow == null || !(ctlNow > 0) || rampPerWeek == null || rampPerWeek <= 0 || daysToRace <= 0) return null;
  const weeks = daysToRace / 7;
  const weeklyCtlFrac = rampPerWeek / ctlNow; // current fractional fitness gain per week
  const linearCtlGain = weeklyCtlFrac * weeks; // naive "ramp holds to race day"
  // Builds plateau and end in a taper, so the ramp can't hold linearly — saturate the CTL gain toward
  // CTL_GAIN_SATURATION (≈ linear for short horizons, asymptotic for long ones).
  const ctlGainFrac = CTL_GAIN_SATURATION * (1 - Math.exp(-linearCtlGain / CTL_GAIN_SATURATION));
  const projectedFrac = Math.min(MAX_PROJECTED_GAIN, FITNESS_TIME_ELASTICITY * ctlGainFrac);
  if (projectedFrac < MIN_MEANINGFUL_GAIN) return null;
  const pct = +(projectedFrac * 100).toFixed(1);
  return {
    projectedFrac,
    basis: `Best case projects the training still ahead of you: your fitness (CTL) is climbing ~${rampPerWeek.toFixed(1)}/week, carried to race day with diminishing returns (builds plateau and end in a taper) and mapped to ~${pct}% faster, capped near ${Math.round(MAX_PROJECTED_GAIN * 100)}%. It assumes you hold the build, stay healthy, adapt well and taper. Worst case is racing at today's fitness.`,
  };
}

/** Banister chronic-load decay (τ = 42d) — the same constant the load model uses. */
const CTL_K = 1 - Math.exp(-1 / 42);

/**
 * Roll fitness (CTL) forward over a future daily-load (ESS) series, day by day, with the Banister 42-day
 * impulse-response. Rest days (load 0) let CTL decay; training days lift it toward the applied load. Pure.
 */
export function projectCtl(ctlNow: number, futureDailyLoad: number[]): number {
  let ctl = ctlNow;
  for (const load of futureDailyLoad) ctl = load * CTL_K + ctl * (1 - CTL_K);
  return ctl;
}

/**
 * PRIMARY race-day basis — "predicted from doing the PLANNED training well." Maps a projected fitness
 * (CTL) gain — `projectedCtl` rolled forward from the athlete's plan to race day — into a finish-time
 * improvement fraction via the performance elasticity, hard-capped at MAX_PROJECTED_GAIN. Returns null
 * (→ caller falls back) when there's no usable gain: no CTL, the race is here, the plan only maintains or
 * detrains (projectedCtl ≤ ctlNow), or the upside is negligible.
 */
export function projectFromFitnessGain(
  ctlNow: number | null | undefined,
  projectedCtl: number | null | undefined,
  daysToRace: number,
): { projectedFrac: number; basis: string } | null {
  if (ctlNow == null || !(ctlNow > 0) || projectedCtl == null || daysToRace <= 0) return null;
  const ctlGainFrac = Math.max(0, (projectedCtl - ctlNow) / ctlNow);
  const projectedFrac = Math.min(MAX_PROJECTED_GAIN, FITNESS_TIME_ELASTICITY * ctlGainFrac);
  if (projectedFrac < MIN_MEANINGFUL_GAIN) return null;
  const pct = +(projectedFrac * 100).toFixed(1);
  return {
    projectedFrac,
    basis: `Best case assumes you do the planned training well: it carries your plan forward to race day, lifting your fitness (CTL) from ${Math.round(ctlNow)} to ~${Math.round(projectedCtl)} (+${Math.round(ctlGainFrac * 100)}%), mapped to ~${pct}% faster (capped near ${Math.round(MAX_PROJECTED_GAIN * 100)}%). It assumes you stay healthy, adapt well and taper. Worst case is racing at today's fitness.`,
  };
}

/**
 * Project a finish-time RANGE for a race (worst = race it today, at today's fitness):
 *  - best case PRIMARY = `planned`, a forward projection from the training still ahead — preferring the
 *    actual plan (projectFromFitnessGain), else the current build ramp (projectFromTrainingLoad);
 *  - best case FALLBACK (when there's no usable build ahead) = today's prediction carried along YOUR OWN
 *    recent race-predictor trajectory to race day, capped at MAX_PROJECTED_GAIN, and only when that trend
 *    is statistically reliable (`fracImprovePerDay` < 0).
 * With neither, the range collapses to your current level — never an empty promise. Honest MODEL.
 */
export function projectRaceDayRange(
  predictedSec: number,
  daysToRace: number,
  fracImprovePerDay: number | null,
  planned?: { projectedFrac: number; basis: string } | null,
): { worstSec: number; bestSec: number; rangeBasis: string } {
  const worstSec = Math.round(predictedSec);
  if (daysToRace <= 0) {
    return { worstSec, bestSec: worstSec, rangeBasis: "Race is here — this is your current level." };
  }
  // PRIMARY: forward projection from the planned training between now and race day.
  if (planned && planned.projectedFrac > 0) {
    return { worstSec, bestSec: Math.round(predictedSec * (1 - planned.projectedFrac)), rangeBasis: planned.basis };
  }
  // FALLBACK: extrapolate the athlete's own observed rate of improvement. Diminishing returns — fitness
  // gains are concave and a build ends in a taper, so a recent sec/day rate can't be carried LINEARLY to
  // race day (the textbook over-promise). Saturate toward the cap instead.
  if (fracImprovePerDay != null && fracImprovePerDay < 0) {
    const linearFrac = Math.abs(fracImprovePerDay) * daysToRace; // ≥0, the naive "rate holds" gain
    const projectedFrac = MAX_PROJECTED_GAIN * (1 - Math.exp(-linearFrac / MAX_PROJECTED_GAIN));
    return {
      worstSec,
      bestSec: Math.round(predictedSec * (1 - projectedFrac)),
      rangeBasis: `Best case carries your recent rate of improvement toward race day with diminishing returns (gains are concave and a build ends in a taper), capped near ${Math.round(MAX_PROJECTED_GAIN * 100)}%, and only when that trend is statistically reliable. It assumes you complete the planned build, stay healthy, adapt well and taper. Worst case is racing at today's fitness.`,
    };
  }
  // NEITHER a build nor a reliable trend → collapse to current level.
  return {
    worstSec,
    bestSec: worstSec,
    rangeBasis:
      "No build or improving trend to project yet, so best case = your current level. The range opens up once your fitness (CTL) is climbing or your race predictions start trending faster.",
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
  let prevCum = 0;
  const segments: Segment[] = dists.map((d, i) => {
    const pace = basePace * factors[i] * k;
    cum += pace * d;
    const cumulativeSec = Math.round(cum);
    const splitSec = cumulativeSec - prevCum; // diff of rounded cumulatives → splits sum to the total
    prevCum = cumulativeSec;
    return {
      label: seg === 5 ? `${Math.round(dists.slice(0, i).reduce((a, b) => a + b, 0))}–${Math.round(dists.slice(0, i + 1).reduce((a, b) => a + b, 0))} km` : `km ${i + 1}`,
      distanceKm: d,
      targetPaceSecPerKm: Math.round(pace),
      splitSec,
      cumulativeSec,
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
  let prevCum = 0;
  let raced = 0;
  const push = (label: string, distanceKm: number, sec: number, target: string) => {
    cum += sec;
    raced += distanceKm;
    const cumulativeSec = Math.round(cum);
    const splitSec = cumulativeSec - prevCum; // diff of rounded cumulatives → splits sum to the total
    prevCum = cumulativeSec;
    segments.push({ label, distanceKm, targetPaceSecPerKm: distanceKm > 0 ? Math.round(sec / distanceKm) : 0, splitSec, cumulativeSec, target });
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
