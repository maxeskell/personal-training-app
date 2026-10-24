/**
 * Per-session EFFICIENCY & PERFORMANCE metrics from a raw .FIT, the building blocks of the /efficiency page.
 *
 * Everything here is pure and deterministic (no network, no LLM) and works on one activity at a time, so
 * the history builder can walk thousands of archived files and keep only these small rows:
 *
 *  - **Output vs heart rate** (`steady`): the session's steady minutes as (HR, output) points, summarised as
 *    a straight-line fit. Output is bike power, or for a run GRADE-ADJUSTED speed (Minetti's energy-cost
 *    curve, so hills don't read as fitness changes). The history reads "watts / pace at a reference HR"
 *    off each fit, only inside the HR range that session actually covered (never extrapolated).
 *  - **Mean-maximal power** (`mmp`): best 3 / 5 / 10 / 20-min power, fresh and after 1500 / 2500 kJ of work:
 *    the inputs to critical power and to durability.
 *  - **Aerobic threshold from beat-to-beat HR** (`dfa`): DFA-α1 over 2-min windows; the HR (and output)
 *    where α1 crosses 0.75 is a published estimate of the first ventilatory / aerobic threshold.
 *
 * All of these are MODELS with stated assumptions; the page shows how much to trust each one.
 */

import type { FitActivity, FitSample } from "./fitParser.js";
import { bestAvgPower } from "./powerCurve.js";
import { detectRunTailCut } from "./fit.js";
import { mean } from "./stats.js";

/** A least-squares line y = intercept + slope·x with its fit quality and the x-range it covers. */
export interface LineFit {
  slope: number;
  intercept: number;
  r2: number;
  n: number;
  xLo: number; // 10th percentile of x: the fit is only trusted inside [xLo, xHi]
  xHi: number; // 90th percentile
}

export function fitLine(xs: number[], ys: number[]): LineFit | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const sorted = [...xs].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  return { slope, intercept: my - slope * mx, r2: syy === 0 ? 0 : (sxy * sxy) / (sxx * syy), n, xLo: pct(0.1), xHi: pct(0.9) };
}

/** 1 Hz series over the session's timestamps (smart recording leaves gaps; a gap second has no sample). */
export function resample1Hz(samples: FitSample[]): Array<FitSample | null> {
  const timed = samples.filter((s) => typeof s.t === "number");
  if (timed.length < 2) return samples.map((s) => s); // no timestamps: assume 1 Hz as recorded
  const t0 = timed[0].t!;
  const len = Math.min(timed[timed.length - 1].t! - t0 + 1, 12 * 3600); // cap at 12 h (a corrupt timestamp)
  const out: Array<FitSample | null> = new Array(Math.max(0, len)).fill(null);
  for (const s of timed) {
    const i = s.t! - t0;
    if (i >= 0 && i < len) out[i] = s;
  }
  return out;
}

/**
 * Minetti et al. (2002) energy cost of running on a gradient, J/kg/m, for grade i (rise/run). Grade-adjusted
 * speed = speed × C(i)/C(0): the flat-ground speed that would cost the same. Clamped to ±30% (the range
 * the curve was fitted on).
 */
export function minettiCost(grade: number): number {
  const i = Math.max(-0.3, Math.min(0.3, grade));
  return 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6;
}

/** Steady (HR, output) minutes of a session. Output is W for a ride, grade-adjusted m/s for a run. */
export interface SteadyRead {
  fit: LineFit;
  points: number; // steady minutes used
}

const WARMUP_S = 600; // HR lags output early on: skip the first 10 min
const CHUNK_S = 60;

/**
 * Steady minutes → output-vs-HR line. A minute counts when it's nearly all recorded, the athlete is moving
 * (ride: pedalling ≥90% of the minute; run: grade-adjusted ≥2 m/s, i.e. not walking) and output is steady (CV < 15%), so
 * surges, stops and HR lag don't distort it. Needs ≥8 such minutes spread over ≥6 bpm, else null.
 */
export function steadyOutputVsHr(series: Array<FitSample | null>, kind: "ride" | "run"): SteadyRead | null {
  const hrs: number[] = [];
  const outs: number[] = [];
  for (let c = WARMUP_S; c + CHUNK_S <= series.length; c += CHUNK_S) {
    const chunk = series.slice(c, c + CHUNK_S).filter((s): s is FitSample => s != null && typeof s.hr === "number" && s.hr > 0);
    if (chunk.length < CHUNK_S * 0.85) continue;
    let vals: number[];
    if (kind === "ride") {
      const pedalling = chunk.filter((s) => (s.power ?? 0) > 0);
      if (pedalling.length < chunk.length * 0.9) continue;
      vals = chunk.map((s) => s.power ?? 0);
    } else {
      const first = chunk[0];
      const last = chunk[chunk.length - 1];
      const dist = first.distance != null && last.distance != null ? last.distance - first.distance : null;
      const rise = first.altitude != null && last.altitude != null ? last.altitude - first.altitude : null;
      const speeds = chunk.map((s) => s.speed).filter((v): v is number => typeof v === "number");
      const factor = dist != null && dist > 100 && rise != null ? minettiCost(rise / dist) / minettiCost(0) : 1;
      vals = speeds.map((v) => v * factor);
      // Walking check on the GRADE-ADJUSTED speed: a steep climb run at 1.9 m/s is still running.
      if (speeds.length < chunk.length * 0.9 || vals.some((v) => v < 2.0)) continue;
    }
    const m = mean(vals)!;
    const sdv = Math.sqrt(mean(vals.map((v) => (v - m) ** 2))!);
    if (!(m > 0) || sdv / m > 0.15) continue;
    hrs.push(mean(chunk.map((s) => s.hr!))!);
    outs.push(m);
  }
  if (hrs.length < 8 || Math.max(...hrs) - Math.min(...hrs) < 6) return null;
  const fit = fitLine(hrs, outs);
  return fit && fit.slope > 0 ? { fit, points: hrs.length } : null;
}

export const MMP_DURATIONS = [180, 300, 600, 1200] as const;
export const FATIGUE_KJ = [1500, 2500] as const;

export interface MmpRead {
  /** Best average power per duration (s → W), fresh = anywhere in the ride. */
  fresh: Record<string, number | null>;
  /** Best 5-min and 20-min power AFTER the given kJ of work had been done (null: never reached). */
  afterKj: Record<string, { p300: number | null; p1200: number | null }>;
  totalKj: number;
}

export function mmpRead(series: Array<FitSample | null>): MmpRead | null {
  const watts = series.map((s) => (s?.power != null && s.power >= 0 ? s.power : 0));
  if (watts.filter((w) => w > 0).length < 600) return null; // under 10 min of power: nothing to read
  const fresh: MmpRead["fresh"] = {};
  for (const d of MMP_DURATIONS) {
    const v = bestAvgPower(watts, d);
    fresh[d] = v != null ? Math.round(v) : null;
  }
  let kj = 0;
  const cum = watts.map((w) => (kj += w / 1000));
  const afterKj: MmpRead["afterKj"] = {};
  for (const thr of FATIGUE_KJ) {
    const at = cum.findIndex((v) => v >= thr);
    const rest = at >= 0 ? watts.slice(at) : [];
    const p300 = rest.length ? bestAvgPower(rest, 300) : null;
    const p1200 = rest.length ? bestAvgPower(rest, 1200) : null;
    afterKj[thr] = { p300: p300 != null ? Math.round(p300) : null, p1200: p1200 != null ? Math.round(p1200) : null };
  }
  return { fresh, afterKj, totalKj: Math.round(kj) };
}

/**
 * DFA-α1 of one RR window (ms): detrended fluctuation analysis over box sizes 4–16 beats. ≈1.0 at easy
 * intensity, falling through 0.75 near the aerobic threshold and towards 0.5 near the anaerobic one.
 * Null with too few beats.
 */
export function dfaAlpha1(rr: number[]): number | null {
  if (rr.length < 64) return null;
  const m = mean(rr)!;
  let acc = 0;
  const y = rr.map((v) => (acc += v - m));
  const logN: number[] = [];
  const logF: number[] = [];
  for (let n = 4; n <= 16; n++) {
    const boxes = Math.floor(y.length / n);
    if (boxes < 4) break;
    let sq = 0;
    for (let b = 0; b < boxes; b++) {
      // Linear detrend within the box (x = 0..n-1), accumulate squared residuals.
      const seg = y.slice(b * n, b * n + n);
      const xm = (n - 1) / 2;
      const ym = mean(seg)!;
      let sxx = 0, sxy = 0;
      for (let k = 0; k < n; k++) {
        sxx += (k - xm) ** 2;
        sxy += (k - xm) * (seg[k] - ym);
      }
      const sl = sxy / sxx;
      for (let k = 0; k < n; k++) sq += (seg[k] - (ym + sl * (k - xm))) ** 2;
    }
    const F = Math.sqrt(sq / (boxes * n));
    if (F > 0) {
      logN.push(Math.log10(n));
      logF.push(Math.log10(F));
    }
  }
  const fit = fitLine(logN, logF);
  return fit ? +fit.slope.toFixed(3) : null;
}

/** Drop RR artefacts: outside 300–2000 ms, or >20% off the median of the 5 beats around it. Returns kept + share removed. */
export function cleanRr(rr: number[]): { kept: Array<{ i: number; v: number }>; artefactPct: number } {
  const kept: Array<{ i: number; v: number }> = [];
  for (let i = 0; i < rr.length; i++) {
    const v = rr[i];
    if (v < 300 || v > 2000) continue;
    const near = rr.slice(Math.max(0, i - 2), i + 3).filter((x) => x >= 300 && x <= 2000).sort((a, b) => a - b);
    const med = near[Math.floor(near.length / 2)];
    if (Math.abs(v - med) / med > 0.2) continue;
    kept.push({ i, v });
  }
  return { kept, artefactPct: rr.length ? +((1 - kept.length / rr.length) * 100).toFixed(1) : 100 };
}

export interface DfaRead {
  /** HR (bpm) where α1 crosses 0.75: the aerobic-threshold estimate. */
  aetHr: number;
  /** Output at that HR (W for a ride, grade-unadjusted m/s for a run). Null without an output channel. */
  aetOutput: number | null;
  windows: number;
  artefactPct: number;
  r2: number;
}

const DFA_WINDOW_S = 120;
const DFA_STEP_S = 30;
const MAX_WINDOW_ARTEFACT_PCT = 5;

/**
 * Aerobic threshold from a session's RR stream. RR intervals are laid on the session clock by cumulative
 * sum from the first record (assumes RR logging started with the recording, which is how Garmin writes it).
 * Windows with >5% artefacts are dropped. Needs ≥10 clean windows whose α1 spans 0.75; the crossing is read
 * from a straight-line α1-vs-HR fit and never extrapolated. Null otherwise (an all-easy session can't show it).
 */
export function dfaThreshold(rrMs: number[] | undefined, series: Array<FitSample | null>, kind: "ride" | "run"): DfaRead | null {
  if (!rrMs || rrMs.length < 600) return null;
  const { kept, artefactPct } = cleanRr(rrMs);
  const tAt: number[] = [];
  let t = 0;
  for (const v of rrMs) tAt.push((t += v) / 1000); // seconds since start, by RAW order (artefacts still take time)
  const total = t / 1000;
  const hrs: number[] = [];
  const alphas: number[] = [];
  const outs: number[] = [];
  for (let w0 = WARMUP_S; w0 + DFA_WINDOW_S <= total; w0 += DFA_STEP_S) {
    const rawCount = tAt.filter((x) => x >= w0 && x < w0 + DFA_WINDOW_S).length;
    const win = kept.filter((k) => tAt[k.i] >= w0 && tAt[k.i] < w0 + DFA_WINDOW_S).map((k) => k.v);
    if (!rawCount || (1 - win.length / rawCount) * 100 > MAX_WINDOW_ARTEFACT_PCT) continue;
    const a = dfaAlpha1(win);
    if (a == null) continue;
    hrs.push(60000 / mean(win)!);
    alphas.push(a);
    const slice = series.slice(Math.floor(w0), Math.floor(w0 + DFA_WINDOW_S)).filter((s): s is FitSample => s != null);
    const o = slice.map((s) => (kind === "ride" ? s.power : s.speed)).filter((v): v is number => typeof v === "number" && v > 0);
    outs.push(o.length > DFA_WINDOW_S / 2 ? mean(o)! : NaN);
  }
  if (hrs.length < 10 || Math.min(...alphas) > 0.75 || Math.max(...alphas) < 0.75) return null;
  const fit = fitLine(hrs, alphas);
  if (!fit || fit.slope >= 0) return null; // α1 must fall as HR rises
  const aetHr = (0.75 - fit.intercept) / fit.slope;
  if (aetHr < fit.xLo || aetHr > fit.xHi) return null; // crossing outside the well-covered HR range
  const okOut = hrs.map((h, i) => [h, outs[i]] as const).filter(([, o]) => Number.isFinite(o));
  const oFit = okOut.length >= 6 ? fitLine(okOut.map(([h]) => h), okOut.map(([, o]) => o)) : null;
  return {
    aetHr: Math.round(aetHr),
    aetOutput: oFit ? +(oFit.intercept + oFit.slope * aetHr).toFixed(kind === "ride" ? 0 : 2) : null,
    windows: hrs.length,
    artefactPct,
    r2: +fit.r2.toFixed(2),
  };
}

/** Everything one session contributes to the efficiency history. */
export interface SessionPerformance {
  date: string;
  startTimeS: number | null;
  kind: "ride" | "run";
  indoor: boolean;
  durationMin: number;
  avgTempC: number | null;
  steady: SteadyRead | null;
  mmp: MmpRead | null; // rides only
  dfa: DfaRead | null;
}

/** Analyse one single-sport activity (a multisport file should be split into legs first). Pure. */
export function analysePerformance(act: FitActivity): SessionPerformance | null {
  const kind = /ride/i.test(act.sportName) ? "ride" : /run/i.test(act.sportName) ? "run" : null;
  if (!kind) return null;
  // A run's closing walk (dog, getting to the door) isn't running: cut it like the session readout does.
  const samples = kind === "run" ? (detectRunTailCut(act.samples, 10).samples as FitSample[]) : act.samples;
  const series = resample1Hz(samples);
  if (series.length < 900) return null; // under 15 min: too short to say anything
  const startTimeS = samples.find((s) => s.t != null)?.t ?? null;
  const temps = samples.map((s) => s.temperature).filter((v): v is number => typeof v === "number");
  const steady = steadyOutputVsHr(series, kind);
  const mmp = kind === "ride" ? mmpRead(series) : null;
  const dfa = dfaThreshold(act.rrMs, series, kind);
  if (!steady && !mmp && !dfa) return null;
  return {
    date: startTimeS != null ? new Date(startTimeS * 1000).toISOString().slice(0, 10) : "",
    startTimeS,
    kind,
    indoor: act.subSport === 6 || act.subSport === 58 || act.subSport === 1, // indoor cycling, virtual, treadmill
    durationMin: Math.round(series.length / 60),
    avgTempC: temps.length ? +mean(temps)!.toFixed(1) : null,
    steady,
    mmp,
    dfa,
  };
}
