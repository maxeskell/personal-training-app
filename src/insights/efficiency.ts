/**
 * Efficiency-vs-fitness separation (data-scientist brief Q5): are the efficiency levers (run EF,
 * swim SWOLF / distance-per-stroke) improving INDEPENDENTLY of raw fitness — better output for the
 * same physiological cost — or are they just riding the fitness trend?
 *
 * Approach: a MULTIPLE regression EF ~ CTL + time across steady runs, and read the TIME coefficient —
 * the EF↔time relationship holding fitness (CTL) constant. That's the Frisch–Waugh–Lovell-correct
 * "economy beyond fitness" (the earlier code residualised EF on CTL only, then trended on time, which
 * leaves the CTL/time collinearity in the residual and over-attributes it to economy). We only CLAIM an
 * economy gain when the time coefficient's 95% CI excludes 0 — and even then it's labelled "apparent",
 * because CTL/time are collinear and EF here is NOT heat-adjusted (a hot block can masquerade as a loss).
 * Swim efficiency is trended raw from SWOLF / distance-per-stroke when the swim feed carries them.
 */

import type { RichActivity, LoadModel, Finding } from "./metrics.js";
import { mean, slope, mlr2 } from "./stats.js";

export interface EfficiencyAnalysis {
  n: number;
  efImproving: boolean | null;
  /** Time coefficient from EF ~ CTL + time, per 30 days (EF gain not explained by fitness). 2 sig figs. */
  economyPer30d: number | null;
  ciLow: number | null; // 95% CI on economyPer30d …
  ciHigh: number | null; // … the bar for claiming it: CI excludes 0
  economyReliable: boolean | null; // economyPer30d > 0 AND its CI excludes 0
  fitnessExplains: boolean | null; // EF rising but no reliable economy gain beyond fitness
  swimSwolfDeltaPct: number | null; // SWOLF lower = better, so negative delta is an improvement
}

function dayIndex(dateIso: string, epoch: string): number {
  return Math.round((new Date(`${dateIso}T00:00:00Z`).getTime() - new Date(`${epoch}T00:00:00Z`).getTime()) / 86_400_000);
}

/** Round to `sig` significant figures (honest precision — the model can't support 4 dp on an n≈10 fit). */
function sigFig(x: number, sig = 2): number {
  return x === 0 ? 0 : +x.toPrecision(sig);
}

export function analyseEfficiency(acts: RichActivity[], load: LoadModel | null, swimSwolf?: number[]): EfficiencyAnalysis {
  const ctlByDate = new Map((load?.series ?? []).map((p) => [p.date, p.ctl]));
  const runs = acts
    .filter((a) => a.sport === "Run" && a.avwatts && a.avhr && (a.movingSec ?? 0) >= 2400 && ctlByDate.has(a.date))
    .sort((a, b) => a.date.localeCompare(b.date));

  let economyPer30d: number | null = null;
  let ciLow: number | null = null;
  let ciHigh: number | null = null;
  let economyReliable: boolean | null = null;
  let efImproving: boolean | null = null;
  let fitnessExplains: boolean | null = null;

  // ≥10 steady runs (raised from 8): a 2-predictor fit with a meaningful residual df, not a thin one.
  if (runs.length >= 10) {
    const ef = runs.map((a) => a.avwatts! / a.avhr!);
    const ctl = runs.map((a) => ctlByDate.get(a.date)!);
    const epoch = runs[0].date;
    const t = runs.map((a) => dayIndex(a.date, epoch));

    efImproving = (slope(t, ef) ?? 0) > 0;

    const m = mlr2(ef, ctl, t); // EF ~ CTL + time
    if (m) {
      const per30 = m.b2 * 30; // time coefficient, per 30 days
      const half = 1.96 * m.seB2 * 30; // 95% CI half-width
      economyPer30d = sigFig(per30);
      ciLow = sigFig(per30 - half);
      ciHigh = sigFig(per30 + half);
      economyReliable = ciLow > 0; // positive AND CI excludes 0
      fitnessExplains = efImproving === true && !economyReliable; // EF rises but not reliably beyond fitness
    }
  }

  let swimSwolfDeltaPct: number | null = null;
  if (swimSwolf && swimSwolf.length >= 6) {
    const half = Math.floor(swimSwolf.length / 2);
    const prior = mean(swimSwolf.slice(0, half));
    const recent = mean(swimSwolf.slice(half));
    if (prior != null && recent != null && prior !== 0) swimSwolfDeltaPct = +(((recent - prior) / prior) * 100).toFixed(1);
  }

  return { n: runs.length, efImproving, economyPer30d, ciLow, ciHigh, economyReliable, fitnessExplains, swimSwolfDeltaPct };
}

export function efficiencyFinding(e: EfficiencyAnalysis): Finding | null {
  if (e.economyPer30d == null) return null;
  const economyUp = e.economyReliable === true; // CI excludes 0 and positive
  const ci = e.ciLow != null && e.ciHigh != null ? ` [95% CI ${e.ciLow}..${e.ciHigh}]` : "";
  return {
    family: "Economy vs fitness",
    title: economyUp ? "Apparent economy gains (beyond fitness)" : e.fitnessExplains ? "Run gains look like fitness, not economy" : "Economy holding steady",
    severity: "info",
    detail:
      economyUp
        ? `EF ~ CTL + time over ${e.n} steady runs: the time coefficient (economy beyond fitness) is +${e.economyPer30d}/30d${ci} — an APPARENT economy gain. Read as suggestive: CTL and time are collinear, and EF here isn't heat-adjusted, so a cool spell or a fitness artefact can flatter it.`
        : e.fitnessExplains
          ? `Run EF is rising, but the time coefficient holding CTL constant isn't reliably > 0 (${e.economyPer30d}/30d${ci}) — gains look like engine, not economy. Technique/economy work still has headroom.`
          : `Fitness-adjusted run economy is roughly flat (${e.economyPer30d}/30d${ci} over ${e.n} runs).`,
    evidence: `EF regressed on CTL + time (multiple regression); time coefficient over ${e.n} steady runs [derived]`,
    confidence: economyUp ? 0.55 : 0.5,
  };
}
