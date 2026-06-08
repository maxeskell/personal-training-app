import type { AthleteState } from "../state/types.js";
import {
  richActivities,
  loadModel,
  runLoadRamp,
  efTrend,
  durabilityTrend,
  thresholdTrend,
  monotonyStrain,
  intensityDistribution,
  type Finding,
  type LoadModel,
  type RunRamp,
  type Trend,
  type MonotonyStrain,
  type TID,
} from "./metrics.js";

export interface PredictionVsGoal {
  race: string;
  date?: string;
  daysTo?: number;
  predictedSec?: number;
  targetSec?: number;
  gapSec?: number;
}

export interface InsightReport {
  date: string;
  load: LoadModel | null;
  runRamp: RunRamp;
  ef: { run: Trend; ride: Trend };
  durability: { run: Trend; ride: Trend };
  threshold: { run: Trend };
  monotony: MonotonyStrain;
  tid: TID;
  predictions: PredictionVsGoal[];
  findings: Finding[];
}

function daysTo(fromIso: string, toIso: string): number {
  return Math.round((new Date(`${String(toIso).slice(0, 10)}T00:00:00Z`).getTime() - new Date(`${fromIso}T00:00:00Z`).getTime()) / 86_400_000);
}
function n(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}
function hhmm(sec?: number): string {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, "0")}` : `${m}m`;
}

function predictionsVsGoals(state: AthleteState): PredictionVsGoal[] {
  const goals = ((state.raw?.getRaceGoalEvent as { goals?: Record<string, unknown>[] } | undefined)?.goals) ?? [];
  return goals
    .filter((g) => g.event_date)
    .map((g) => {
      const predictedSec = n(g.discipline_prediction);
      const targetSec = n(g.target_completion_time_in_seconds);
      return {
        race: String(g.event_name ?? "—"),
        date: String(g.event_date).slice(0, 10),
        daysTo: daysTo(state.date, String(g.event_date)),
        predictedSec,
        targetSec,
        gapSec: predictedSec != null && targetSec != null ? predictedSec - targetSec : undefined,
      };
    })
    .sort((a, b) => (a.daysTo ?? 0) - (b.daysTo ?? 0));
}

/** Build the full insight report + detector findings from today's assembled state. */
export function buildInsights(state: AthleteState): InsightReport {
  const raw = state.raw ?? {};
  const acts = richActivities(raw);
  const load = loadModel((raw.getRecoveryModel as { data?: { date?: unknown[]; external_stress_score?: unknown[] } } | undefined)?.data);
  const runRamp = runLoadRamp(acts);
  const ef = { run: efTrend(acts, "Run"), ride: efTrend(acts, "Ride") };
  const durability = { run: durabilityTrend(acts, "Run"), ride: durabilityTrend(acts, "Ride") };
  const threshold = { run: thresholdTrend(acts, "Run") };
  const monotony = monotonyStrain(load?.series);
  const tid = intensityDistribution(state.adherenceByZone.value);
  const predictions = predictionsVsGoals(state);

  const findings: Finding[] = [];

  // 1. Run-load ramp guard — the marathon-off-tri injury window (priority detector).
  if (runRamp.jumpPct != null && runRamp.weeks.length >= 3) {
    if (runRamp.jumpPct > 50) {
      findings.push({
        family: "Injury risk",
        title: "Run load spiked this week",
        severity: "flag",
        detail: `Run stress is up ${runRamp.jumpPct}% on your recent baseline — the kind of jump that precedes running injuries, and you're in the marathon-off-tri window.`,
        evidence: `this week ${runRamp.thisWeekEss} ESS vs baseline ${runRamp.baselineEss} [ai-endurance]`,
        recommendation: "Cap the increase — pull back run volume/intensity toward baseline this week; ramp gradually.",
      });
    } else if (runRamp.jumpPct > 25) {
      findings.push({
        family: "Injury risk",
        title: "Run load climbing",
        severity: "watch",
        detail: `Run stress up ${runRamp.jumpPct}% on baseline — fine if deliberate, but watch it given the marathon build.`,
        evidence: `this week ${runRamp.thisWeekEss} ESS vs baseline ${runRamp.baselineEss} [ai-endurance]`,
      });
    }
  }

  // 2. Form (TSB) + ramp rate.
  if (load) {
    if (load.tsb < -25) {
      findings.push({
        family: "Load & form",
        title: "Deep fatigue (low form)",
        severity: "watch",
        detail: `Form (TSB) is ${load.tsb} — heavily fatigued. Fine inside a build block, but not where you want to be near a race.`,
        evidence: `CTL ${load.ctl} / ATL ${load.atl} / TSB ${load.tsb} from daily ESS [derived]`,
      });
    }
    if (load.rampPerWeek > 7) {
      findings.push({
        family: "Load & form",
        title: "Fitness ramping fast",
        severity: "watch",
        detail: `Fitness (CTL) is rising ${load.rampPerWeek}/week — above the ~5–7 comfort zone; sustainable briefly, risky if held.`,
        evidence: `ΔCTL/wk ${load.rampPerWeek} [derived]`,
      });
    }
  }

  // 2b. Training monotony (Foster) — too-samey load raises illness/overtraining risk.
  if (monotony.monotony != null && monotony.monotony > 2 && monotony.weeklyLoad > 0) {
    findings.push({
      family: "Load & form",
      title: "High training monotony",
      severity: "watch",
      detail: `Last week's load is very uniform (monotony ${monotony.monotony}) — too little hard/easy variation raises illness/overtraining risk. Make easy days easier and hard days harder.`,
      evidence: `monotony ${monotony.monotony}, strain ${monotony.strain} [derived from daily ESS]`,
    });
  }

  // 2c. Intensity distribution — grey-zone creep (too little genuinely-easy volume).
  if (tid.easyPct != null && tid.totalH > 2) {
    if (tid.easyPct < 75) {
      findings.push({
        family: "Intensity distribution",
        title: "Grey-zone creep",
        severity: "watch",
        detail: `Only ${tid.easyPct}% of training is easy (tempo ${tid.tempoPct}%, hard ${tid.hardPct}%). Successful endurance work is ~80% easy — protect easy-easy/hard-hard separation.`,
        evidence: `zone split easy/tempo/hard = ${tid.easyPct}/${tid.tempoPct}/${tid.hardPct}% over ${tid.totalH}h [ai-endurance]`,
        recommendation: "Slow the easy sessions down; keep intensity concentrated in fewer, genuinely-hard sessions.",
      });
    }
  }

  // 3. Efficiency / durability trends (good news is worth saying).
  const efRun = ef.run;
  if (efRun.deltaPct != null && efRun.n >= 6) {
    findings.push({
      family: "Aerobic efficiency",
      title: efRun.deltaPct >= 0 ? "Run efficiency improving" : "Run efficiency slipping",
      severity: efRun.deltaPct < -5 ? "watch" : "info",
      detail: `Run EF (power÷HR) ${efRun.deltaPct >= 0 ? "up" : "down"} ${Math.abs(efRun.deltaPct)}% recent vs prior — ${efRun.deltaPct >= 0 ? "the aerobic work is paying off" : "worth watching alongside fatigue/heat"}.`,
      evidence: `EF ${efRun.recent} vs ${efRun.prior} (steady runs ≥40min) [derived]`,
    });
  }
  // Durability is a DECAY-style index (negative = late-session decay; closer to 0 = more durable).
  // So recent > prior == LESS decay == improving. Avoid the % delta (meaningless over a negative base).
  const durRun = durability.run;
  if (durRun.recent != null && durRun.prior != null && durRun.n >= 6) {
    const change = +(durRun.recent - durRun.prior).toFixed(1);
    if (change <= -2) {
      findings.push({
        family: "Durability",
        title: "Run durability slipping",
        severity: "watch",
        detail: `DFA-α1 run durability shows more late-session decay than before (${durRun.prior} → ${durRun.recent}) — fatigue resistance holds marathon pace late, so worth watching.`,
        evidence: `durability index ${durRun.recent} vs ${durRun.prior} (closer to 0 = more durable) [ai-endurance]`,
      });
    } else if (change >= 2) {
      findings.push({
        family: "Durability",
        title: "Run durability improving",
        severity: "info",
        detail: `Less late-session decay than before (${durRun.prior} → ${durRun.recent}) — fatigue resistance trending up, encouraging for the marathon.`,
        evidence: `durability index ${durRun.recent} vs ${durRun.prior} (closer to 0 = more durable) [ai-endurance]`,
      });
    }
  }

  // 4. Prediction vs goal for the next race.
  const next = predictions[0];
  if (next && next.gapSec != null) {
    const behind = next.gapSec > 0;
    findings.push({
      family: "Goal tracking",
      title: `${next.race}: ${behind ? "behind" : "on/ahead of"} target`,
      severity: behind ? "watch" : "info",
      detail: `Predicted ${hhmm(next.predictedSec)} vs target ${hhmm(next.targetSec)} (${behind ? "+" : ""}${Math.round(next.gapSec / 60)} min) with ${next.daysTo} days to go.`,
      evidence: `getPrediction vs getRaceGoalEvent [ai-endurance]`,
    });
  }

  // Order: flags first, then watch, then info.
  const rank = { flag: 0, watch: 1, info: 2 } as const;
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return { date: state.date, load, runRamp, ef, durability, threshold, monotony, tid, predictions, findings };
}
