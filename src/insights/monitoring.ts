/**
 * Personalised monitoring rule set (data-scientist brief Deliverable #3, Q1) — validated honestly.
 *
 * We backtest candidate HRV/RHR early-warning rules against this athlete's own history. Two hard
 * lessons from the code review are baked in:
 *
 *  1. NO in-sample optimism. Selecting the best of (4 rules × 3 leads) on the same series you then
 *     report on overstates skill on short, autocorrelated n=1 data. So we SELECT the rule+lead on the
 *     earlier ~60% of days and REPORT hit/false-alarm only on the held-out later ~40% — and we run a
 *     circular-shift PERMUTATION NULL on the holdout, surfacing a rule only if its real skill beats the
 *     95th percentile of the null. If there isn't enough history for a holdout, we fall back to
 *     in-sample selection and label the finding "in-sample / exploratory".
 *
 *  2. The outcome must be INDEPENDENT of the predictors. AI Endurance's recovery score is itself
 *     modelled from HRV+RHR, so using it as the outcome makes HRV/RHR rules tautological. We prefer an
 *     independent outcome — Garmin sleep score from the backfilled multi-year history — and only fall
 *     back to the AIE recovery series (clearly relabelled as concordance, not prediction) when that
 *     longer/independent series isn't available.
 */

import { finiteNums, mean, sd, mulberry32, circularShift, type Maybe } from "./stats.js";
import type { Finding } from "./metrics.js";

/** What the rule set is run against — built by the engine from the best available series. */
export interface MonitoringInput {
  dates: string[];
  hrv: Maybe[]; // overnight HRV (rMSSD or Garmin overnight HRV)
  rhr: Maybe[];
  outcome: Maybe[]; // the signal whose drop = a "bad day"
  outcomeName: string;
  outcomeIndependent: boolean; // false when the outcome is derived from the predictors (e.g. AIE recovery)
}

export interface RulePerf {
  name: string;
  lead: number;
  description: string;
  hitRate: number; // reported on the HOLDOUT when validated, else in-sample
  falseAlarmRate: number;
  precision: number;
  youdenJ: number;
  fires: number;
  outcomes: number;
  pValue?: number; // permutation-null p on the holdout (lower = more skill)
}

export interface MonitoringRuleSet {
  outcomeDefinition: string;
  outcomeName: string;
  outcomeIndependent: boolean;
  days: number;
  method: "walk-forward + permutation" | "in-sample (exploratory)";
  validated: boolean;
  rules: RulePerf[];
  best: RulePerf | null;
  /** How many candidate rule×lead combos the "best" was selected from (multiplicity the p is adjusted for). */
  selectedFrom?: number;
}

/** Rolling z-scores vs a trailing window (each point scored against its own prior history). */
function rollingZ(series: Maybe[], window = 28): Maybe[] {
  return series.map((_, i) => {
    const hist: number[] = [];
    for (let j = Math.max(0, i - window); j < i; j++) {
      const v = series[j];
      if (v != null) hist.push(v);
    }
    const cur = series[i];
    if (cur == null || hist.length < 10) return null;
    const m = mean(hist)!;
    const s = sd(hist);
    if (s == null || s === 0) return null;
    return +((cur - m) / s).toFixed(2);
  });
}

interface Confusion {
  hitRate: number;
  falseAlarmRate: number;
  precision: number;
  youdenJ: number;
  fires: number;
  outcomes: number;
  evaluable: number;
}

/** Score predictor[t] against outcome[t+lead] over index window [a, b). Nulls are skipped. */
function score(predictor: boolean[], outcome: Array<boolean | null>, lead: number, a: number, b: number): Confusion {
  let tp = 0, fp = 0, fn = 0, tn = 0, fires = 0, outcomes = 0, evaluable = 0;
  for (let t = a; t + lead < b; t++) {
    const bad = outcome[t + lead];
    if (bad == null) continue; // no independent outcome that day
    evaluable++;
    const fired = predictor[t] === true;
    if (fired) fires++;
    if (bad) outcomes++;
    if (fired && bad) tp++;
    else if (fired && !bad) fp++;
    else if (!fired && bad) fn++;
    else tn++;
  }
  const hitRate = tp + fn > 0 ? tp / (tp + fn) : 0;
  const falseAlarmRate = fp + tn > 0 ? fp / (fp + tn) : 0;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  return {
    hitRate: +hitRate.toFixed(2),
    falseAlarmRate: +falseAlarmRate.toFixed(2),
    precision: +precision.toFixed(2),
    youdenJ: +(hitRate - falseAlarmRate).toFixed(2),
    fires,
    outcomes,
    evaluable,
  };
}

interface Candidate {
  name: string;
  pred: boolean[];
  description: string;
}

function candidates(hrvZ: Maybe[], rhrZ: Maybe[]): Candidate[] {
  const hrvLow = hrvZ.map((z) => z != null && z <= -1);
  const hrvLow2 = hrvZ.map((z, i) => z != null && z <= -1 && (i > 0 && hrvZ[i - 1] != null && hrvZ[i - 1]! <= -1));
  const rhrHigh = rhrZ.map((z) => z != null && z >= 1);
  const combined = hrvLow.map((v, i) => v && rhrHigh[i]);
  return [
    { name: "HRV ≥1 SD below baseline", pred: hrvLow, description: "Overnight HRV a full SD under your rolling baseline." },
    { name: "HRV suppressed ≥2 nights", pred: hrvLow2, description: "HRV ≥1 SD below baseline two nights running." },
    { name: "Resting HR ≥1 SD above baseline", pred: rhrHigh, description: "Resting HR a full SD over your rolling baseline." },
    { name: "HRV down AND RHR up", pred: combined, description: "HRV suppressed and RHR elevated the same morning." },
  ];
}

export function buildMonitoringRuleSet(input: MonitoringInput): MonitoringRuleSet {
  const hrvZ = rollingZ(finiteNums(input.hrv));
  const rhrZ = rollingZ(finiteNums(input.rhr));
  const outcomeZ = rollingZ(finiteNums(input.outcome));
  const outcomeBad: Array<boolean | null> = outcomeZ.map((z) => (z == null ? null : z <= -1));
  const n = outcomeBad.length;
  const usableDays = outcomeBad.filter((b) => b != null).length;
  const cands = candidates(hrvZ, rhrZ);

  const base = {
    outcomeName: input.outcomeName,
    outcomeIndependent: input.outcomeIndependent,
    days: usableDays,
    outcomeDefinition: `bad day = ${input.outcomeName} ≥1 SD below personal rolling baseline${input.outcomeIndependent ? "" : " (NB: derived from HRV/RHR — concordance, not independent prediction)"}`,
  };

  // Enough history to hold out? Need a meaningful train and test span with events on both sides.
  const canHoldout = usableDays >= 50;

  if (!canHoldout) {
    // In-sample selection only — explicitly exploratory, never reported as validated skill.
    const rules = pickInSample(cands, outcomeBad, n);
    return {
      ...base,
      method: "in-sample (exploratory)",
      validated: false,
      rules,
      best: rules.find((r) => r.youdenJ > 0.2 && r.fires >= 4) ?? null,
    };
  }

  // Walk-forward: select on the earlier 60%, evaluate on the held-out later 40%.
  const trainEnd = Math.floor(n * 0.6);
  let bestSel: { cand: Candidate; lead: number; trainJ: number } | null = null;
  let combosTried = 0; // how many candidate rule×lead combos we choose the best from (selection multiplicity)
  for (const c of cands) {
    for (let lead = 1; lead <= 3; lead++) {
      const tr = score(c.pred, outcomeBad, lead, 0, trainEnd);
      if (tr.fires < 3 || tr.outcomes < 3) continue;
      combosTried++;
      if (!bestSel || tr.youdenJ > bestSel.trainJ) bestSel = { cand: c, lead, trainJ: tr.youdenJ };
    }
  }

  const rules: RulePerf[] = [];
  let best: RulePerf | null = null;
  if (bestSel) {
    const te = score(bestSel.cand.pred, outcomeBad, bestSel.lead, trainEnd, n);
    const pValue = permutationP(bestSel.cand.pred, outcomeBad, bestSel.lead, trainEnd, n, te.youdenJ);
    const perf: RulePerf = {
      name: bestSel.cand.name,
      description: bestSel.cand.description,
      lead: bestSel.lead,
      hitRate: te.hitRate,
      falseAlarmRate: te.falseAlarmRate,
      precision: te.precision,
      youdenJ: te.youdenJ,
      fires: te.fires,
      outcomes: te.outcomes,
      pValue,
    };
    rules.push(perf);
    // Validated only if the holdout has ENOUGH events (≥8 outcomes / ≥4 fires — not a handful), positive
    // skill, and beats the permutation null AFTER a Bonferroni correction for the best-of-N selection
    // (a best-of-~12 candidate that scrapes p=0.04 is selection optimism, not a validated rule).
    const pAdj = Math.min(1, pValue * Math.max(1, combosTried));
    if (te.outcomes >= 8 && te.fires >= 4 && te.youdenJ > 0 && pAdj < 0.05) best = perf;
  }

  return { ...base, method: "walk-forward + permutation", validated: best != null, rules, best, selectedFrom: combosTried };
}

/** In-sample scan (no holdout possible) — for short series; results are exploratory only. */
function pickInSample(cands: Candidate[], outcomeBad: Array<boolean | null>, n: number): RulePerf[] {
  const out: RulePerf[] = [];
  for (const c of cands) {
    let best: { lead: number; s: Confusion } | null = null;
    for (let lead = 1; lead <= 3; lead++) {
      const s = score(c.pred, outcomeBad, lead, 0, n);
      if (s.fires === 0) continue;
      if (!best || s.youdenJ > best.s.youdenJ) best = { lead, s };
    }
    if (best) {
      out.push({
        name: c.name,
        description: c.description,
        lead: best.lead,
        hitRate: best.s.hitRate,
        falseAlarmRate: best.s.falseAlarmRate,
        precision: best.s.precision,
        youdenJ: best.s.youdenJ,
        fires: best.s.fires,
        outcomes: best.s.outcomes,
      });
    }
  }
  return out.sort((a, b) => b.youdenJ - a.youdenJ);
}

/** Circular-shift permutation p-value for the selected rule on the holdout window. */
function permutationP(pred: boolean[], outcomeBad: Array<boolean | null>, lead: number, a: number, b: number, realJ: number, K = 400): number {
  const rnd = mulberry32(0x9e3779b1);
  const span = b - a;
  if (span < 5) return 1;
  const seg = outcomeBad.slice(a, b);
  let ge = 0;
  for (let k = 0; k < K; k++) {
    const offset = 1 + Math.floor(rnd() * (span - 1));
    const shifted = circularShift(seg, offset);
    // Re-embed the shifted holdout outcome and score the same predictor/lead.
    const nullOutcome = outcomeBad.slice();
    for (let i = 0; i < span; i++) nullOutcome[a + i] = shifted[i];
    const j = score(pred, nullOutcome, lead, a, b).youdenJ;
    if (j >= realJ) ge++;
  }
  return +((ge + 1) / (K + 1)).toFixed(3);
}

/** Turn the best rule into a Finding — wording and confidence track validation status honestly. */
export function monitoringFinding(rs: MonitoringRuleSet): Finding | null {
  const b = rs.best;
  if (!b) return null;
  const depNote = rs.outcomeIndependent ? "" : ` Note: the outcome (${rs.outcomeName}) is derived from HRV/RHR, so read this as concordance, not independent prediction.`;

  if (rs.validated) {
    return {
      family: "Monitoring rule (n=1, out-of-sample)",
      title: `Watch rule: ${b.name}`,
      severity: "info",
      detail:
        `Selected on the earlier part of your history and tested on held-out later days, this fires ~${b.lead} day(s) before a ${rs.outcomeName} dip with a ${Math.round(b.hitRate * 100)}% hit-rate and ${Math.round(b.falseAlarmRate * 100)}% false-alarm rate (held-out; permutation p=${b.pValue}).${depNote} When it trips, cap intensity and re-check the morning signals.`,
      evidence: `walk-forward holdout + circular-shift permutation over ${rs.days} usable days${rs.selectedFrom ? `, best of ${rs.selectedFrom} candidates (p Bonferroni-adjusted)` : ""} [${rs.outcomeIndependent ? "independent outcome" : "dependent outcome"}]`,
      recommendation: "Treat it as amber, not gospel — confirm against how you actually feel before pulling a session.",
      confidence: Math.min(0.85, 0.55 + b.youdenJ / 2),
    };
  }

  // Not validated out-of-sample (short history or didn't beat the null) — surface as exploratory.
  return {
    family: "Monitoring rule (n=1, exploratory)",
    title: `Possible watch rule: ${b.name}`,
    severity: "info",
    detail:
      `In your history so far, ${b.name.toLowerCase()} has coincided with a later ${rs.outcomeName} dip (~${b.lead} day(s), in-sample hit ${Math.round(b.hitRate * 100)}% / false-alarm ${Math.round(b.falseAlarmRate * 100)}%). This is NOT yet validated out-of-sample — treat it as a hypothesis to watch as more history accrues.${depNote}`,
    evidence: `${rs.method} over ${rs.days} days — exploratory, not held-out [${rs.outcomeIndependent ? "independent outcome" : "dependent outcome"}]`,
    confidence: 0.4,
  };
}
