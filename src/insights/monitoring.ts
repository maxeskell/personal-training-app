/**
 * Personalised monitoring rule set (data-scientist brief Deliverable #3, Q1).
 *
 * The brief asks for "the 5–8 personalised thresholds worth watching daily, each with its historical
 * hit/false-alarm rate" — e.g. "HRV >X below baseline for ≥N nights AND RHR up Y bpm → cap intensity".
 * We BACKTEST candidate rules against this athlete's own ~60-day recovery series and report each rule's
 * confusion-matrix performance, then surface the best one as a Finding.
 *
 * Outcome (proxy, stated honestly): a "bad recovery day" = the AI Endurance cardio-recovery sub-score
 * dropping notably below the athlete's own rolling baseline (z ≤ −1). The brief's gold-standard outcome
 * is benchmark pace-at-HR, which the daily wellness series doesn't carry; recovery-score suppression is
 * the best available daily proxy and is labelled as such. Predictors lead the outcome (t−lead).
 */

import { finiteNums, mean, sd, type Maybe } from "./stats.js";
import type { Finding } from "./metrics.js";

export interface RulePerf {
  name: string;
  lead: number; // days the rule fires ahead of the outcome
  hitRate: number; // sensitivity: P(rule fired | bad day coming)
  falseAlarmRate: number; // P(rule fired | no bad day)
  precision: number; // P(bad day | rule fired)
  youdenJ: number; // hitRate − falseAlarmRate (skill above chance)
  fires: number; // how often the rule fired across history
  outcomes: number; // how many bad days were in the window
  description: string;
}

export interface MonitoringRuleSet {
  outcomeDefinition: string;
  days: number;
  rules: RulePerf[];
  best: RulePerf | null;
}

/** Rolling z-scores of a series vs a trailing window (each point scored against its own history). */
function rollingZ(series: Maybe[], window = 28): Maybe[] {
  const out: Maybe[] = series.map(() => null);
  for (let i = 0; i < series.length; i++) {
    const histVals: number[] = [];
    for (let j = Math.max(0, i - window); j < i; j++) {
      const v = series[j];
      if (v != null) histVals.push(v);
    }
    const cur = series[i];
    if (cur == null || histVals.length < 10) continue;
    const m = mean(histVals)!;
    const s = sd(histVals);
    if (s == null || s === 0) continue;
    out[i] = +((cur - m) / s).toFixed(2);
  }
  return out;
}

/** Evaluate a boolean predictor[t] against outcome[t+lead] across the series. */
function score(predictor: boolean[], outcome: boolean[], lead: number): Omit<RulePerf, "name" | "description"> {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let fires = 0;
  let outcomes = 0;
  for (let t = 0; t + lead < outcome.length; t++) {
    const fired = predictor[t] === true;
    const bad = outcome[t + lead] === true;
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
    lead,
    hitRate: +hitRate.toFixed(2),
    falseAlarmRate: +falseAlarmRate.toFixed(2),
    precision: +precision.toFixed(2),
    youdenJ: +(hitRate - falseAlarmRate).toFixed(2),
    fires,
    outcomes,
  };
}

export function buildMonitoringRuleSet(
  data: { rMSSD?: unknown[]; resting_heart_rate?: unknown[]; recovery?: unknown[] } | undefined,
): MonitoringRuleSet {
  const hrvZ = rollingZ(finiteNums(data?.rMSSD));
  const rhrZ = rollingZ(finiteNums(data?.resting_heart_rate));
  const recZ = rollingZ(finiteNums(data?.recovery));
  const days = recZ.filter((x) => x != null).length;

  const outcome = recZ.map((z) => (z == null ? false : z <= -1));
  const hasOutcome = outcome.some(Boolean);

  // Candidate predictors (rolling-baseline, so they read as personal deviations, not absolutes).
  const hrvLow = hrvZ.map((z) => z != null && z <= -1);
  const hrvLow2 = hrvZ.map((z, i) => z != null && z <= -1 && (hrvZ[i - 1] ?? 0)! <= -1); // ≥2 nights
  const rhrHigh = rhrZ.map((z) => z != null && z >= 1);
  const combined = hrvLow.map((v, i) => v && rhrHigh[i]);

  const candidates: Array<{ name: string; pred: boolean[]; description: string }> = [
    { name: "HRV ≥1 SD below baseline", pred: hrvLow, description: "Overnight HRV (rMSSD) a full SD under your rolling baseline." },
    { name: "HRV suppressed ≥2 nights", pred: hrvLow2, description: "HRV ≥1 SD below baseline two nights running — the sustained-drop pattern." },
    { name: "Resting HR ≥1 SD above baseline", pred: rhrHigh, description: "Resting HR a full SD over your rolling baseline." },
    { name: "HRV down AND RHR up", pred: combined, description: "HRV suppressed and RHR elevated on the same morning — the classic combined flag." },
  ];

  const rules: RulePerf[] = [];
  if (hasOutcome && days >= 21) {
    for (const c of candidates) {
      // Pick the lead (1–3 days) that maximises skill for this rule.
      let best: Omit<RulePerf, "name" | "description"> | null = null;
      for (let lead = 1; lead <= 3; lead++) {
        const s = score(c.pred, outcome, lead);
        if (s.fires === 0) continue;
        if (!best || s.youdenJ > best.youdenJ) best = s;
      }
      if (best) rules.push({ name: c.name, description: c.description, ...best });
    }
    rules.sort((a, b) => b.youdenJ - a.youdenJ);
  }

  return {
    outcomeDefinition: "bad recovery day = AI Endurance cardio-recovery ≥1 SD below personal rolling baseline (proxy for a performance dip)",
    days,
    rules,
    best: rules.find((r) => r.youdenJ > 0.1 && r.fires >= 3) ?? null,
  };
}

/** Turn the best backtested rule into a Finding (only when it shows real skill on enough history). */
export function monitoringFinding(rs: MonitoringRuleSet): Finding | null {
  const b = rs.best;
  if (!b) return null;
  return {
    family: "Monitoring rule (n=1, backtested)",
    title: `Watch rule: ${b.name}`,
    severity: "info",
    detail:
      `On your own history this fires ~${b.lead} day(s) before a recovery dip with a ${Math.round(b.hitRate * 100)}% hit-rate ` +
      `and ${Math.round(b.falseAlarmRate * 100)}% false-alarm rate (precision ${Math.round(b.precision * 100)}%). ` +
      `When it trips, cap intensity for ${b.lead === 1 ? "the next day" : `the next ${b.lead} days`} and re-check the morning signals.`,
    evidence: `backtested over ${rs.days} days, fired ${b.fires}×, Youden J ${b.youdenJ} [derived from AIE recovery series]`,
    recommendation: "Treat it as amber, not gospel — confirm against how you actually feel before pulling a session.",
  };
}
