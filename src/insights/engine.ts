import type { AthleteState } from "../state/types.js";
import {
  richActivities,
  type RichActivity,
  loadModel,
  runLoadRamp,
  efTrend,
  durabilityTrend,
  thresholdTrend,
  monotonyStrain,
  intensityDistribution,
  surfaceFindings,
  type Finding,
  type LoadModel,
  type RunRamp,
  type Trend,
  type MonotonyStrain,
  type TID,
} from "./metrics.js";
import { estimateRunSplits, estimateTriSplits, projectRaceDayRange, type RaceSplitPlan, type DurabilityState, type TriRaceType, type TriPerformance } from "./splits.js";
import { analyseRecoverySeries, sleepVsNextDayLoad, type Correlation, type Anomaly } from "./correlations.js";
import { buildMonitoringRuleSet, monitoringFinding, type MonitoringRuleSet, type MonitoringInput } from "./monitoring.js";
import { changePointsOf, changePointFindings, type SeriesChangePoints } from "./changepoint.js";
import { analyseBricks, brickFinding, type BrickAnalysis } from "./brick.js";
import { analyseTaper, taperFinding, type TaperAnalysis } from "./taper.js";
import { analyseEfficiency, efficiencyFinding, type EfficiencyAnalysis } from "./efficiency.js";
import { analyseFuelling, fuellingFinding, type FuellingAnalysis } from "./fuelling.js";
import { loadSessionDecays, fitFindings, type SessionDecay } from "./fit.js";
import { trainingStatusFinding, hrvStatusFinding, enduranceScoreFinding, powerCurveFinding } from "./garminHealth.js";
import { garminTrendFindings } from "./garminTrends.js";
import { analyseHeat, heatFinding } from "./heat.js";
import { finiteNums, slope } from "./stats.js";
import { engagementFindings, type EngagementContext } from "./engagement.js";
import type { FitSummary } from "../archive/store.js";

/** Optional historical archive to widen the metrics beyond the live 40-activity / 60-day window. */
export interface ArchiveInput {
  activities?: RichActivity[];
  /** Backfilled Garmin daily series (years). hrv/rhr/sleepScore power the validated monitoring rule;
   *  the slice-1b fields drive the illness/stress/sleep/fuelling trend detectors. */
  garminDays?: Array<{
    date: string;
    sleepHours?: number;
    hrvMs?: number;
    restingHr?: number;
    sleepScore?: number;
    deepSleepSec?: number;
    remSleepSec?: number;
    skinTempDevC?: number;
    bodyBatteryChange?: number;
    avgSleepRespiration?: number;
    avgWakingRespiration?: number;
    avgStressLevel?: number;
    muscleMassKg?: number;
    bodyFatPct?: number;
    weightKg?: number;
  }>;
  /** Per-activity .FIT summaries (from fit-sync) — per-activity EF + temperature for the heat confounder;
   *  the dashboard also reads activityId for the raw-stream auto-download. */
  fitSummaries?: FitSummary[];
}

export interface PredictionVsGoal {
  race: string;
  date?: string;
  eventType?: string;
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
  correlations: Correlation[];
  anomalies: Anomaly[];
  predictions: PredictionVsGoal[];
  monitoring: MonitoringRuleSet;
  changePoints: SeriesChangePoints[];
  brick: BrickAnalysis;
  taper: TaperAnalysis;
  efficiency: EfficiencyAnalysis;
  fuelling: FuellingAnalysis;
  sessionDecays: SessionDecay[];
  splits: RaceSplitPlan[];
  findings: Finding[];
  /** Gated + ranked findings for surfacing (good-signal only, suppressed keys removed). */
  topFindings: Finding[];
}

/** Default per-family confidence when a detector didn't set one explicitly. */
const FAMILY_CONFIDENCE: Record<string, number> = {
  "Injury risk": 0.8,
  "Load & form": 0.7,
  "Intensity distribution": 0.65,
  "Aerobic efficiency": 0.6,
  Durability: 0.6,
  Anomaly: 0.55,
  "Goal tracking": 0.7,
  "Regime shift": 0.6,
};

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
        eventType: typeof g.event_type === "string" ? g.event_type : undefined,
        daysTo: daysTo(state.date, String(g.event_date)),
        predictedSec,
        targetSec,
        gapSec: predictedSec != null && targetSec != null ? predictedSec - targetSec : undefined,
      };
    })
    .sort((a, b) => (a.daysTo ?? 0) - (b.daysTo ?? 0));
}

type RecoverySeries = { date?: unknown[]; rMSSD?: unknown[]; resting_heart_rate?: unknown[]; recovery?: unknown[] } | undefined;

/**
 * Choose the series the monitoring rule runs on. Prefers the backfilled Garmin history because (a) it's
 * years deep (enough for a real holdout) and (b) Garmin sleep score is an outcome INDEPENDENT of the
 * HRV/RHR predictors. Falls back to the 60-day AIE recovery series (dependent → relabelled) otherwise.
 */
function monitoringInputFrom(recData: RecoverySeries, archive?: ArchiveInput): MonitoringInput {
  const gar = (archive?.garminDays ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const hrvCount = gar.filter((d) => d.hrvMs != null).length;
  const sleepCount = gar.filter((d) => d.sleepScore != null).length;
  if (gar.length >= 60 && hrvCount >= 40 && sleepCount >= 40) {
    return {
      dates: gar.map((d) => d.date),
      hrv: gar.map((d) => d.hrvMs ?? null),
      rhr: gar.map((d) => d.restingHr ?? null),
      outcome: gar.map((d) => d.sleepScore ?? null),
      outcomeName: "Garmin sleep score",
      outcomeIndependent: true,
    };
  }
  return {
    dates: (recData?.date ?? []).map((d) => String(d).slice(0, 10)),
    hrv: finiteNums(recData?.rMSSD),
    rhr: finiteNums(recData?.resting_heart_rate),
    outcome: finiteNums(recData?.recovery),
    outcomeName: "AI Endurance cardio-recovery",
    outcomeIndependent: false,
  };
}

/** Infer a run race's distance (km) from its name. Returns null for non-run / unknown events. */
function runDistanceKm(name: string): number | null {
  const s = name.toLowerCase();
  if (/half[\s-]*marathon|half\b/.test(s)) return 21.0975;
  if (/marathon/.test(s)) return 42.195;
  if (/10\s*k\b|10\s*km/.test(s)) return 10;
  if (/5\s*k\b|5\s*km/.test(s)) return 5;
  return null;
}

/** Detect a triathlon goal (name/event_type) + its format; defaults to Olympic when only "tri" is named. */
function triTypeOf(name: string, eventType?: string): TriRaceType | null {
  const s = `${name} ${eventType ?? ""}`.toLowerCase();
  if (!/\btri(athlon)?\b|70\.3|iron\s?man/.test(s)) return null;
  if (/sprint/.test(s)) return "sprint";
  if (/70\.3|half|middle/.test(s)) return "half-iron";
  if (/iron\s?man|\bfull\b|140\.6/.test(s)) return "ironman";
  return "olympic";
}

/** Least-squares slope (per day) of dated values, or null if too few points. */
function slopePerDay(points: Array<{ date: string; v: number }>): number | null {
  if (points.length < 4) return null;
  const epoch = new Date(`${points[0].date}T00:00:00Z`).getTime();
  const xs = points.map((p) => (new Date(`${p.date}T00:00:00Z`).getTime() - epoch) / 86_400_000);
  return slope(xs, points.map((p) => p.v));
}

/** Cross-day trend findings (VO2max engine growth; race-predictor trajectory) from the history window. */
function historyTrendFindings(history: AthleteState[] | undefined): Finding[] {
  const out: Finding[] = [];
  if (!history || history.length < 6) return out;

  // VO2max trend (run engine). Slow upward drift = engine growing; flag a sustained drop.
  const vo2 = history
    .map((s) => ({ date: s.date, v: s.vo2max.value }))
    .filter((p): p is { date: string; v: number } => p.v != null);
  const vo2Slope = slopePerDay(vo2);
  if (vo2Slope != null && Math.abs(vo2Slope * 30) >= 0.5) {
    const per30 = +(vo2Slope * 30).toFixed(1);
    out.push({
      family: "Engine trend",
      title: per30 >= 0 ? "VO2max trending up" : "VO2max trending down",
      severity: per30 < 0 ? "watch" : "info",
      detail: `VO2max is ${per30 >= 0 ? "rising" : "falling"} ~${Math.abs(per30)}/30d across ${vo2.length} readings — ${per30 >= 0 ? "the aerobic engine is growing." : "watch it (summer heat suppresses VO2max — a benign explanation; confirm against pace-at-HR)."}`,
      evidence: `VO2max slope over ${vo2.length} days [garmin, MODEL — trend only]`,
      confidence: 0.6,
    });
  }

  // Race-predictor trajectory for the nearest race (predicted time falling = getting faster).
  const predPoints = history
    .map((s) => ({ date: s.date, p: predictionsVsGoals(s)[0] }))
    .filter((x): x is { date: string; p: PredictionVsGoal } => x.p != null && x.p.predictedSec != null)
    .map((x) => ({ date: x.date, v: x.p.predictedSec! }));
  const predSlope = slopePerDay(predPoints);
  if (predSlope != null && Math.abs(predSlope * 7) >= 5) {
    const perWk = Math.round(predSlope * 7);
    out.push({
      family: "Goal tracking",
      title: perWk <= 0 ? "Race prediction improving" : "Race prediction slipping",
      severity: perWk > 0 ? "watch" : "info",
      detail: `The predicted finish for your next race is ${perWk <= 0 ? "dropping" : "rising"} ~${Math.abs(perWk)}s/week across the block — ${perWk <= 0 ? "prep is translating into projected speed." : "the trajectory is going the wrong way; check load/recovery and session quality."}`,
      evidence: `getPrediction trajectory over ${predPoints.length} days [ai-endurance, MODEL — watch the slope, not the absolute]`,
      confidence: 0.6,
    });
  }
  return out;
}

export interface BuildOptions {
  /** Finding keys the athlete dismissed (disagree/ignore) — removed from topFindings. */
  suppressed?: Set<string>;
  /** Trailing daily states (oldest→newest, incl. today) for cross-day trends (VO2max, prediction). */
  history?: AthleteState[];
  /** Engagement loop: derived feedback/adherence that GENERATES follow-through findings and reweights
   *  surfacing toward the families the athlete acts on (coach/listening → buildEngagementContext). */
  engagement?: EngagementContext;
}

/** Build the full insight report + detector findings from today's state (+ optional history archive). */
// ---- finding detectors, extracted from buildInsights so each reads/tests on its own (no behaviour
// change — buildInsights just spreads their results into `findings`). ----

function runLoadRampFindings(runRamp: ReturnType<typeof runLoadRamp>): Finding[] {
  const out: Finding[] = [];
  // 1. Run-load ramp guard — the marathon-off-tri injury window (priority detector).
  if (runRamp.jumpPct != null && runRamp.weeks.length >= 3) {
    if (runRamp.jumpPct > 50) {
      out.push({
        family: "Injury risk",
        title: "Run load spiked this week",
        severity: "flag",
        detail: `Run stress is up ${runRamp.jumpPct}% on your recent baseline — the kind of jump that precedes running injuries, and you're in the marathon-off-tri window.`,
        evidence: `this week ${runRamp.thisWeekEss} ESS vs baseline ${runRamp.baselineEss} [ai-endurance]`,
        recommendation: "Cap the increase — pull back run volume/intensity toward baseline this week; ramp gradually.",
      });
    } else if (runRamp.jumpPct > 25) {
      out.push({
        family: "Injury risk",
        title: "Run load climbing",
        severity: "watch",
        detail: `Run stress up ${runRamp.jumpPct}% on baseline — fine if deliberate, but watch it given the marathon build.`,
        evidence: `this week ${runRamp.thisWeekEss} ESS vs baseline ${runRamp.baselineEss} [ai-endurance]`,
      });
    }
  }
  return out;
}

function formAndIntensityFindings(
  load: ReturnType<typeof loadModel>,
  monotony: ReturnType<typeof monotonyStrain>,
  tid: ReturnType<typeof intensityDistribution>,
): Finding[] {
  const out: Finding[] = [];
  // 2. Form (TSB) + ramp rate.
  if (load) {
    if (load.tsb < -25) {
      out.push({
        family: "Load & form",
        title: "Deep fatigue (low form)",
        severity: "watch",
        detail: `Form (TSB) is ${load.tsb} — heavily fatigued. Fine inside a build block, but not where you want to be near a race.`,
        evidence: `CTL ${load.ctl} / ATL ${load.atl} / TSB ${load.tsb} from daily ESS [derived]`,
      });
    }
    if (load.rampPerWeek > 7) {
      out.push({
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
    out.push({
      family: "Load & form",
      title: "High training monotony",
      severity: "watch",
      detail: `Last week's load is very uniform (monotony ${monotony.monotony}) — too little hard/easy variation raises illness/overtraining risk. Make easy days easier and hard days harder.`,
      evidence: `monotony ${monotony.monotony}, strain ${monotony.strain} [derived from daily ESS]`,
    });
  }
  // 2c. Intensity distribution — grey-zone creep (too little genuinely-easy volume).
  if (tid.easyPct != null && tid.totalH > 2 && tid.easyPct < 75) {
    out.push({
      family: "Intensity distribution",
      title: "Grey-zone creep",
      severity: "watch",
      detail: `Only ${tid.easyPct}% of training is easy (tempo ${tid.tempoPct}%, hard ${tid.hardPct}%). Successful endurance work is ~80% easy — protect easy-easy/hard-hard separation.`,
      evidence: `zone split easy/tempo/hard = ${tid.easyPct}/${tid.tempoPct}/${tid.hardPct}% over ${tid.totalH}h [ai-endurance]`,
      recommendation: "Slow the easy sessions down; keep intensity concentrated in fewer, genuinely-hard sessions.",
    });
  }
  return out;
}

function efficiencyDurabilityFindings(
  efRun: ReturnType<typeof efTrend>,
  durRun: ReturnType<typeof durabilityTrend>,
  hasThermal: boolean,
): Finding[] {
  const out: Finding[] = [];
  // 3. Efficiency / durability trends (good news is worth saying). Heat confounds EF, so an EF-slipping
  // call without per-activity .FIT temperature must say a hot spell can't be ruled out.
  if (efRun.deltaPct != null && efRun.n >= 6) {
    const slipping = efRun.deltaPct < 0;
    const heatCaveat = slipping && !hasThermal ? " No per-activity temperature on these runs, so a hot spell can't be ruled out as the cause — confirm against pace-at-HR before reading it as lost fitness." : "";
    out.push({
      family: "Aerobic efficiency",
      title: slipping ? "Run efficiency slipping" : "Run efficiency improving",
      severity: efRun.deltaPct < -5 ? "watch" : "info",
      detail: `Run EF (power÷HR) ${slipping ? "down" : "up"} ${Math.abs(efRun.deltaPct)}% recent vs prior — ${slipping ? "worth watching alongside fatigue/heat" : "the aerobic work is paying off"}.${heatCaveat}`,
      evidence: `EF ${efRun.recent} vs ${efRun.prior} (steady runs ≥40min) [derived]`,
    });
  }
  // Durability is a DECAY-style index (negative = late decay; closer to 0 = more durable): recent > prior == improving.
  if (durRun.recent != null && durRun.prior != null && durRun.n >= 6) {
    const change = +(durRun.recent - durRun.prior).toFixed(1);
    if (change <= -2) {
      out.push({
        family: "Durability",
        title: "Run durability slipping",
        severity: "watch",
        detail: `DFA-α1 run durability shows more late-session decay than before (${durRun.prior} → ${durRun.recent}) — fatigue resistance holds marathon pace late, so worth watching.`,
        evidence: `durability index ${durRun.recent} vs ${durRun.prior} (closer to 0 = more durable) [ai-endurance]`,
      });
    } else if (change >= 2) {
      out.push({
        family: "Durability",
        title: "Run durability improving",
        severity: "info",
        detail: `Less late-session decay than before (${durRun.prior} → ${durRun.recent}) — fatigue resistance trending up, encouraging for the marathon.`,
        evidence: `durability index ${durRun.recent} vs ${durRun.prior} (closer to 0 = more durable) [ai-endurance]`,
      });
    }
  }
  return out;
}

function anomalyCorrelationFindings(
  anomalies: ReturnType<typeof analyseRecoverySeries>["anomalies"],
  correlations: ReturnType<typeof analyseRecoverySeries>["correlations"],
): Finding[] {
  const out: Finding[] = [];
  // 3b. Anomalies (today is a statistical outlier vs the athlete's own 60-day baseline).
  for (const a of anomalies) {
    out.push({
      family: "Anomaly",
      title: `${a.metric} outlier today`,
      severity: "watch",
      detail: a.detail + " One day isn't a trend, but worth noting alongside how you feel.",
      evidence: `z=${a.z} vs 60-day baseline [ai-endurance]`,
    });
  }
  // 3c. A strong n=1 pattern worth knowing (info, not an alarm). Confidence keys off FDR survival.
  const topCorr = correlations.find((c) => Math.abs(c.r) >= 0.5);
  if (topCorr) {
    out.push({
      family: "Your patterns (n=1)",
      title: topCorr.label,
      severity: "info",
      detail: topCorr.interpretation,
      evidence: `r=${topCorr.r}, n=${topCorr.n} days, FDR ${topCorr.fdrPass ? "confirmed" : "not confirmed"} [ai-endurance]`,
      confidence: topCorr.fdrPass ? 0.8 : 0.35,
    });
  }
  return out;
}

function predictionFindings(predictions: ReturnType<typeof predictionsVsGoals>): Finding[] {
  const out: Finding[] = [];
  // 4. Prediction vs goal for the next race.
  const next = predictions[0];
  if (next && next.gapSec != null) {
    const behind = next.gapSec > 0;
    out.push({
      family: "Goal tracking",
      title: `${next.race}: ${behind ? "behind" : "on/ahead of"} target`,
      severity: behind ? "watch" : "info",
      detail: `Predicted ${hhmm(next.predictedSec)} vs target ${hhmm(next.targetSec)} (${behind ? "+" : ""}${Math.round(next.gapSec / 60)} min) with ${next.daysTo} days to go.`,
      evidence: `getPrediction vs getRaceGoalEvent [ai-endurance]`,
    });
  }
  return out;
}

// Exported so the detectors can be unit-tested directly (they were inline + untestable before).
export { runLoadRampFindings, formAndIntensityFindings, efficiencyDurabilityFindings, anomalyCorrelationFindings, predictionFindings };

export function buildInsights(state: AthleteState, archive?: ArchiveInput, opts?: BuildOptions): InsightReport {
  const raw = state.raw ?? {};
  const live = richActivities(raw);
  // Prefer the archived history when it's deeper than the live 40-deep window.
  const acts = archive?.activities && archive.activities.length > live.length ? archive.activities : live;
  const load = loadModel((raw.getRecoveryModel as { data?: { date?: unknown[]; external_stress_score?: unknown[] } } | undefined)?.data);
  const runRamp = runLoadRamp(acts);
  const ef = { run: efTrend(acts, "Run"), ride: efTrend(acts, "Ride") };
  const durability = { run: durabilityTrend(acts, "Run"), ride: durabilityTrend(acts, "Ride") };
  const threshold = { run: thresholdTrend(acts, "Run") };
  const monotony = monotonyStrain(load?.series);
  const tid = intensityDistribution(state.adherenceByZone.value);
  const recData = (raw.getRecoveryModel as { data?: Parameters<typeof analyseRecoverySeries>[0] } | undefined)?.data;
  const { correlations, anomalies } = analyseRecoverySeries(recData);
  // Archive-powered: last night's sleep → next-day load (needs backfilled Garmin sleep history).
  if (archive?.garminDays && archive.garminDays.length >= 20) {
    const essByDate = new Map<string, number>();
    for (const a of acts) if (a.ess != null) essByDate.set(a.date, (essByDate.get(a.date) ?? 0) + a.ess);
    const sleepCorr = sleepVsNextDayLoad(archive.garminDays, essByDate);
    if (sleepCorr) correlations.unshift(sleepCorr);
  }
  const predictions = predictionsVsGoals(state);

  // New rigorous/n=1 layers (data-scientist brief Q1–Q7 + stream-level §1).
  const monitoring = buildMonitoringRuleSet(monitoringInputFrom(recData, archive));

  const recDates = (recData?.date ?? []).map((d) => String(d).slice(0, 10));
  const changePoints: SeriesChangePoints[] = [];
  if (load && load.series.length >= 21) {
    changePoints.push({ metric: "Fitness (CTL)", points: changePointsOf(load.series.map((p) => p.ctl), load.series.map((p) => p.date)) });
  }
  if (recDates.length >= 21) {
    changePoints.push({ metric: "Overnight HRV", points: changePointsOf(finiteNums(recData?.rMSSD), recDates) });
    changePoints.push({ metric: "Resting HR", points: changePointsOf(finiteNums(recData?.resting_heart_rate), recDates) });
  }

  const brick = analyseBricks(acts);
  const taper = analyseTaper(load, raw.getRaceGoalEvent, state.date);
  const efficiency = analyseEfficiency(acts, load);
  // Fuelling from the real backfilled body-composition series (single source — was a dead [],[] call).
  const fuelDays = archive?.garminDays ?? [];
  const fuelling = analyseFuelling(
    fuelDays.filter((d) => d.weightKg != null).map((d) => ({ date: d.date, kg: d.weightKg! })),
    fuelDays.filter((d) => d.muscleMassKg != null).map((d) => ({ date: d.date, kg: d.muscleMassKg! })),
    state.weight7dTrend.value,
  );
  const sessionDecays = loadSessionDecays();

  // Race splits, shaped by the run-durability trend (improving → negative split; else conservative).
  // Triathlon goals get per-leg (swim/bike/run) plans from the current CSS / FTP / run-prediction numbers.
  const durChange = durability.run.recent != null && durability.run.prior != null ? durability.run.recent - durability.run.prior : null;
  const durState: DurabilityState = durChange == null ? "unknown" : durChange >= 2 ? "improving" : durChange <= -2 ? "slipping" : "unknown";
  const thresholds = state.thresholds.value;
  const runPredictions: TriPerformance["runPredictions"] = {};
  for (const rp of state.racePredictions.value?.predictions ?? []) {
    if (rp.label === "5K" || rp.label === "10K" || rp.label === "Half" || rp.label === "Marathon") runPredictions[rp.label] = rp.timeSeconds;
  }
  const splits = predictions
    .filter((p) => (p.daysTo ?? -1) >= 0)
    .map((p) => {
      const tri = triTypeOf(p.race, p.eventType);
      if (tri) {
        return estimateTriSplits(
          p.race,
          tri,
          {
            cssSecPer100: thresholds?.swimCssSecPer100,
            ftpW: thresholds?.bikeFtpW,
            runThresholdPaceSecPerKm: thresholds?.runThresholdPaceSecPerKm,
            runPredictions,
            riderWeightKg: state.weightKg.value ?? undefined,
          },
          durState,
          p.date,
        );
      }
      const km = runDistanceKm(p.race);
      return km && p.predictedSec != null ? estimateRunSplits(p.race, km, p.predictedSec, durState, p.date) : null;
    })
    .filter((s): s is RaceSplitPlan => s != null);

  // Finish-time RANGE per split: worst = race today, best = today's prediction carried along the athlete's
  // OWN race-predictor trajectory (sec/day) to race day, capped. Honest MODEL — labelled as such in the UI.
  const predTrajectory = (opts?.history ?? [])
    .map((s) => ({ date: s.date, p: predictionsVsGoals(s)[0] }))
    .filter((x): x is { date: string; p: PredictionVsGoal } => x.p?.predictedSec != null)
    .map((x) => ({ date: x.date, v: x.p.predictedSec! }));
  const predSlope = slopePerDay(predTrajectory); // sec/day for the nearest race (negative = getting faster)
  const nearestPredicted = predictions.find((p) => p.predictedSec != null)?.predictedSec;
  const fracImprovePerDay = predSlope != null && nearestPredicted ? predSlope / nearestPredicted : null;
  for (const plan of splits) {
    const dTo = plan.date ? daysTo(state.date, plan.date) : 0;
    const r = projectRaceDayRange(plan.predictedSec, dTo, fracImprovePerDay);
    plan.worstSec = r.worstSec;
    plan.bestSec = r.bestSec;
    plan.rangeBasis = r.rangeBasis;
  }

  const findings: Finding[] = [];

  // 1. Run-load ramp guard. 2/2b/2c. Form (TSB) + ramp + monotony + intensity distribution.
  findings.push(...runLoadRampFindings(runRamp));
  findings.push(...formAndIntensityFindings(load, monotony, tid));

  // 3. Efficiency / durability trends. Heat confounds EF and is only known when per-activity .FIT
  // temperature exists, so an EF-slipping call without it must say a hot spell can't be ruled out.
  const hasThermal = [...sessionDecays, ...(archive?.fitSummaries ?? [])].some(
    (r) => typeof (r as { avgTempC?: unknown }).avgTempC === "number",
  );
  findings.push(...efficiencyDurabilityFindings(ef.run, durability.run, hasThermal));

  // 3b/3c. Anomalies + a strong n=1 correlation. 4. Prediction vs goal for the next race.
  findings.push(...anomalyCorrelationFindings(anomalies, correlations));
  findings.push(...predictionFindings(predictions));

  // 5. New detectors (Q1–Q7 + stream-level). Each self-gates and stays silent without enough data.
  const mf = monitoringFinding(monitoring);
  if (mf) findings.push(mf);
  findings.push(...changePointFindings(changePoints));
  const bf = brickFinding(brick);
  if (bf) findings.push(bf);
  const tf = taperFinding(taper);
  if (tf) findings.push(tf);
  const ef2 = efficiencyFinding(efficiency);
  if (ef2) findings.push(ef2);
  const ff = fuellingFinding(fuelling);
  if (ff) findings.push(ff);
  findings.push(...fitFindings(sessionDecays));

  // 5b. Garmin native health models: acute:chronic load / training status, HRV status.
  const tsF = trainingStatusFinding(state.trainingStatus.value);
  if (tsF) findings.push(tsF);
  const hrvF = hrvStatusFinding(state.hrvStatus.value);
  if (hrvF) findings.push(hrvF);
  const esF = enduranceScoreFinding(state.enduranceScore.value);
  if (esF) findings.push(esF);
  const pcF = powerCurveFinding(state.powerCurve.value);
  if (pcF) findings.push(pcF);

  // 5c. Garmin daily-series trends (illness early-warning, stress, Body-Battery, sleep, fuelling).
  findings.push(...garminTrendFindings(archive?.garminDays));

  // 5d. Heat confounder — EF vs per-activity temperature (raw .FIT sessions + synced fit-summaries).
  const heatRecords = [...sessionDecays, ...(archive?.fitSummaries ?? [])];
  for (const sport of ["Run", "Ride"] as const) {
    const hf = heatFinding(analyseHeat(heatRecords, sport));
    if (hf) findings.push(hf);
  }

  // 6. Cross-day trends from the history window (VO2max engine; race-predictor trajectory).
  findings.push(...historyTrendFindings(opts?.history));

  // 7. Engagement loop — findings GENERATED from the athlete's own feedback + adherence (closes the loop:
  // a signal you keep dismissing that recurs, or plan adherence slipping). Empty unless engagement is fed in.
  findings.push(...engagementFindings(opts?.engagement));

  // Fill any unset confidence from the per-family defaults (mid value if still unknown).
  for (const f of findings) if (f.confidence == null) f.confidence = FAMILY_CONFIDENCE[f.family] ?? 0.6;

  // Order: flags first, then watch, then info.
  const rank = { flag: 0, watch: 1, info: 2 } as const;
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);

  // Gated + ranked set for surfacing: good-signal only, athlete-dismissed keys removed, and (when an
  // engagement context is supplied) reweighted toward the families the athlete actually acts on.
  const topFindings = surfaceFindings(findings, opts?.suppressed ?? new Set(), 0.5, opts?.engagement?.familyWeights);

  return {
    date: state.date,
    load,
    runRamp,
    ef,
    durability,
    threshold,
    monotony,
    tid,
    correlations,
    anomalies,
    predictions,
    monitoring,
    changePoints,
    brick,
    taper,
    efficiency,
    fuelling,
    sessionDecays,
    splits,
    findings,
    topFindings,
  };
}
