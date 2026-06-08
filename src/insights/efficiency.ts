/**
 * Efficiency-vs-fitness separation (data-scientist brief Q5): are the efficiency levers (run EF,
 * swim SWOLF / distance-per-stroke) improving INDEPENDENTLY of raw fitness — better output for the
 * same physiological cost — or are they just riding the fitness trend?
 *
 * Approach: regress run EF on same-day CTL (fitness) across steady runs, then look at the trend in the
 * RESIDUALS over time. A rising residual = efficiency gains the fitness trend doesn't explain (the real
 * economy win); a flat residual with rising EF = "it's just fitness". Swim efficiency is trended raw
 * from SWOLF / distance-per-stroke when the swim feed carries them.
 */

import type { RichActivity, LoadModel, Finding } from "./metrics.js";
import { mean } from "./stats.js";

export interface EfficiencyAnalysis {
  n: number;
  efImproving: boolean | null;
  residualSlopePer30d: number | null; // EF gain not explained by fitness, per 30 days
  fitnessExplains: boolean | null; // true when EF gains track CTL (no independent economy gain)
  swimSwolfDeltaPct: number | null; // SWOLF lower = better, so negative delta is an improvement
}

/** Least-squares slope of y on x. */
function slope(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  return sxx === 0 ? null : sxy / sxx;
}

function dayIndex(dateIso: string, epoch: string): number {
  return Math.round((new Date(`${dateIso}T00:00:00Z`).getTime() - new Date(`${epoch}T00:00:00Z`).getTime()) / 86_400_000);
}

export function analyseEfficiency(acts: RichActivity[], load: LoadModel | null, swimSwolf?: number[]): EfficiencyAnalysis {
  const ctlByDate = new Map((load?.series ?? []).map((p) => [p.date, p.ctl]));
  const runs = acts
    .filter((a) => a.sport === "Run" && a.avwatts && a.avhr && (a.movingSec ?? 0) >= 2400 && ctlByDate.has(a.date))
    .sort((a, b) => a.date.localeCompare(b.date));

  let residualSlopePer30d: number | null = null;
  let efImproving: boolean | null = null;
  let fitnessExplains: boolean | null = null;

  if (runs.length >= 8) {
    const ef = runs.map((a) => a.avwatts! / a.avhr!);
    const ctl = runs.map((a) => ctlByDate.get(a.date)!);
    const epoch = runs[0].date;
    const t = runs.map((a) => dayIndex(a.date, epoch));

    efImproving = (slope(t, ef) ?? 0) > 0;

    // Residualise EF on CTL, then trend the residuals over time.
    const b = slope(ctl, ef);
    if (b != null) {
      const a0 = mean(ef)! - b * mean(ctl)!;
      const resid = ef.map((e, i) => e - (a0 + b * ctl[i]));
      const rs = slope(t, resid);
      residualSlopePer30d = rs == null ? null : +(rs * 30).toFixed(4);
      // "Just fitness" = EF rises but the fitness-removed residual is flat/negative.
      fitnessExplains = efImproving === true && (residualSlopePer30d ?? 0) <= 0;
    }
  }

  let swimSwolfDeltaPct: number | null = null;
  if (swimSwolf && swimSwolf.length >= 6) {
    const half = Math.floor(swimSwolf.length / 2);
    const prior = mean(swimSwolf.slice(0, half));
    const recent = mean(swimSwolf.slice(half));
    if (prior != null && recent != null && prior !== 0) swimSwolfDeltaPct = +(((recent - prior) / prior) * 100).toFixed(1);
  }

  return { n: runs.length, efImproving, residualSlopePer30d, fitnessExplains, swimSwolfDeltaPct };
}

export function efficiencyFinding(e: EfficiencyAnalysis): Finding | null {
  if (e.residualSlopePer30d == null) return null;
  const economyUp = e.residualSlopePer30d > 0 && e.fitnessExplains === false;
  return {
    family: "Economy vs fitness",
    title: economyUp ? "Genuine economy gains (beyond fitness)" : e.fitnessExplains ? "Run gains are fitness, not economy" : "Economy holding steady",
    severity: "info",
    detail:
      economyUp
        ? `Run efficiency is improving even after removing the fitness (CTL) trend (residual +${e.residualSlopePer30d}/30d over ${e.n} steady runs) — a real economy win, the marathon-relevant lever.`
        : e.fitnessExplains
          ? `Run EF is rising, but it tracks fitness (CTL) — the fitness-removed residual is flat (${e.residualSlopePer30d}/30d). Gains are engine, not economy; technique/economy work still has headroom.`
          : `Fitness-adjusted run economy is roughly flat (${e.residualSlopePer30d}/30d over ${e.n} runs).`,
    evidence: `EF residualised on CTL, residual trend over ${e.n} steady runs [derived]`,
  };
}
