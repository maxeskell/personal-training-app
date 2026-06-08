/**
 * Change-point detection (data-scientist brief §5): date the genuine regime shifts in long-running
 * series — CTL/fitness, HRV, RHR — rather than smoothing noise, so inflections can be cross-referenced
 * to training changes, illness or kit changes.
 *
 * Method: binary segmentation with an L2 (mean-shift) cost and a BIC-style penalty (k·σ²·log n). It's
 * the interpretable, dependency-free cousin of PELT — well suited to an n=1 series a coach must read.
 * A minimum segment length guards against calling every wobble a regime change.
 */

import { mean, sd, type Maybe } from "./stats.js";
import type { Finding } from "./metrics.js";

export interface ChangePoint {
  index: number;
  date?: string;
  before: number;
  after: number;
  deltaPct: number | null;
  direction: "up" | "down";
}

function segCost(prefix: number[], prefixSq: number[], a: number, b: number): number {
  // SSE of segment [a, b) around its mean, via prefix sums.
  const n = b - a;
  if (n <= 0) return 0;
  const sum = prefix[b] - prefix[a];
  const sumSq = prefixSq[b] - prefixSq[a];
  return sumSq - (sum * sum) / n;
}

/**
 * Detect mean-shift change points. Returns split indices (start of each new segment, excluding 0).
 * `penalty` defaults to a variance-scaled BIC term; `minSeg` is the shortest acceptable segment.
 */
export function detectChangePoints(values: number[], minSeg = 7, penaltyMult = 1): number[] {
  const n = values.length;
  if (n < 2 * minSeg) return [];
  const variance = (sd(values) ?? 1) ** 2 || 1;
  const penalty = penaltyMult * variance * Math.log(n);

  const prefix = new Array(n + 1).fill(0);
  const prefixSq = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) {
    prefix[i + 1] = prefix[i] + values[i];
    prefixSq[i + 1] = prefixSq[i] + values[i] * values[i];
  }

  const splits: number[] = [];
  const recurse = (a: number, b: number) => {
    if (b - a < 2 * minSeg) return;
    const whole = segCost(prefix, prefixSq, a, b);
    let bestGain = penalty; // require the split to beat the penalty
    let bestK = -1;
    for (let k = a + minSeg; k <= b - minSeg; k++) {
      const gain = whole - (segCost(prefix, prefixSq, a, k) + segCost(prefix, prefixSq, k, b));
      if (gain > bestGain) {
        bestGain = gain;
        bestK = k;
      }
    }
    if (bestK >= 0) {
      recurse(a, bestK);
      splits.push(bestK);
      recurse(bestK, b);
    }
  };
  recurse(0, n);
  return splits.sort((x, y) => x - y);
}

/** Detect change points and describe each as a before/after mean shift, dated if dates are supplied. */
export function changePointsOf(values: Maybe[], dates: string[] | undefined, minSeg = 7): ChangePoint[] {
  const clean: number[] = [];
  const idxMap: number[] = [];
  values.forEach((v, i) => {
    if (v != null) {
      clean.push(v);
      idxMap.push(i);
    }
  });
  const splits = detectChangePoints(clean, minSeg);
  const out: ChangePoint[] = [];
  let prev = 0;
  for (let s = 0; s < splits.length; s++) {
    const k = splits[s];
    const before = mean(clean.slice(prev, k))!;
    const nextEnd = s + 1 < splits.length ? splits[s + 1] : clean.length;
    const after = mean(clean.slice(k, nextEnd))!;
    out.push({
      index: idxMap[k],
      date: dates?.[idxMap[k]]?.slice(0, 10),
      before: +before.toFixed(1),
      after: +after.toFixed(1),
      deltaPct: before !== 0 ? +(((after - before) / Math.abs(before)) * 100).toFixed(0) : null,
      direction: after >= before ? "up" : "down",
    });
    prev = k;
  }
  return out;
}

export interface SeriesChangePoints {
  metric: string;
  points: ChangePoint[];
}

/** Emit findings only for RECENT regime shifts (within `recentDays` of the series end). */
export function changePointFindings(series: SeriesChangePoints[], recentDays = 21): Finding[] {
  const out: Finding[] = [];
  for (const s of series) {
    const last = s.points[s.points.length - 1];
    if (!last || !last.date) continue;
    const ageDays = Math.round((Date.now() - new Date(`${last.date}T00:00:00Z`).getTime()) / 86_400_000);
    if (ageDays > recentDays || ageDays < 0) continue;
    out.push({
      family: "Regime shift",
      title: `${s.metric} stepped ${last.direction} ~${ageDays}d ago`,
      severity: last.direction === "down" && /HRV|fitness|CTL/i.test(s.metric) ? "watch" : "info",
      detail:
        `Change-point detection dates a genuine shift in ${s.metric} around ${last.date}: ` +
        `${last.before} → ${last.after}${last.deltaPct != null ? ` (${last.deltaPct >= 0 ? "+" : ""}${last.deltaPct}%)` : ""}. ` +
        `Cross-reference it to a training change, illness, or kit change rather than reading the daily wobble.`,
      evidence: `binary-segmentation change-point (L2 cost) on the daily series [derived]`,
    });
  }
  return out;
}
