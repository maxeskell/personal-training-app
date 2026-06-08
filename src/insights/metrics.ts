/**
 * N1 insight metrics — DETERMINISTIC, pure functions (Insight Engine spec §9 N1 shortlist).
 * Computed from data verified in the live spike: per-activity rich fields (ESS, power/HR, AI
 * Endurance's own DFA-α1 durability + thresholds) and the daily ESS series in getRecoveryModel.
 *
 * Principle: compute locally; only the small Findings reach the LLM. Defer to AI Endurance where it
 * already computes (durability, thresholds) — we trend its values rather than re-deriving them.
 */

export type Severity = "info" | "watch" | "flag";
export interface Finding {
  family: string;
  title: string;
  severity: Severity;
  detail: string;
  evidence: string;
  recommendation?: string;
  /** 0–1 strength of signal behind this finding. Low-confidence findings are gated out of surfacing. */
  confidence?: number;
  /** Stable id for feedback/suppression (derived from family+title if not set). */
  key?: string;
}

/** Stable, digit/date-insensitive key so feedback survives a finding whose numbers change day to day. */
export function findingKey(f: Pick<Finding, "family" | "title" | "key">): string {
  if (f.key) return f.key;
  const norm = `${f.family} ${f.title}`
    .toLowerCase()
    .replace(/[0-9]+(\.[0-9]+)?%?/g, "") // drop numbers/percentages
    .replace(/[^a-z]+/g, "-")
    .replace(/^-|-$/g, "");
  return norm || "finding";
}

const SEVERITY_WEIGHT: Record<Severity, number> = { flag: 1, watch: 0.7, info: 0.45 };

/** Rank score = severity weight × confidence (defaulting confidence to a mid value when unset). */
export function findingScore(f: Finding): number {
  return SEVERITY_WEIGHT[f.severity] * (f.confidence ?? 0.6);
}

/**
 * Gate + rank findings for surfacing: drop suppressed keys and anything below the confidence bar,
 * then sort by score. `minConfidence` is the "only show me a good signal" threshold.
 */
export function surfaceFindings(findings: Finding[], suppressed: Set<string> = new Set(), minConfidence = 0.5): Finding[] {
  return findings
    .filter((f) => (f.confidence ?? 0.6) >= minConfidence && !suppressed.has(findingKey(f)))
    .sort((a, b) => findingScore(b) - findingScore(a));
}

function num(x: unknown): number | undefined {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x))) return Number(x);
  return undefined;
}
function isoWeek(dateIso: string): string {
  // Year-Www key from a UTC date (good enough for weekly bucketing).
  const d = new Date(`${dateIso.slice(0, 10)}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10); // Monday of that week
}
function mean(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export interface RichActivity {
  date: string;
  sport: "Run" | "Ride" | "Swim";
  ess?: number;
  avwatts?: number;
  avhr?: number;
  movingSec?: number;
  durabilityPct?: number;
  aerThrHr?: number;
  aerThrW?: number;
  hrvArtifactPct?: number;
}

/** Map one raw AIE activity object (+ sport) into a RichActivity. Shared by live + archived paths. */
export function mapRichActivity(a: Record<string, unknown>, sport: RichActivity["sport"]): RichActivity {
  return {
    date: String(a.activity_date_local ?? a.activity_date ?? "").slice(0, 10),
    sport,
    ess: num(a.external_stress_score),
    avwatts: num(a.activity_avwatts),
    avhr: num(a.activity_avhr),
    movingSec: num(a.activity_movingtime),
    durabilityPct:
      num(a.aerobic_durability_according_to_dfa_alpha1_running_power_in_percent) ??
      num(a.aerobic_durability_according_to_dfa_alpha1_in_percent),
    aerThrHr: num(a.aerobic_threshold_dfa_alpha1_heart_rate_cluster) ?? num(a.aerobic_threshold_dfa_alpha1_heart_rate_ramp),
    aerThrW: num(a.aerobic_threshold_dfa_alpha1_watts_cluster) ?? num(a.aerobic_threshold_dfa_alpha1_watts_ramp),
    hrvArtifactPct: num(a.hrv_artifact_percentage),
  };
}

/** Pull the rich activity fields out of a raw getXxxActivity payload (the live, 40-deep window). */
export function richActivities(raw: Record<string, unknown> | undefined): RichActivity[] {
  const out: RichActivity[] = [];
  const grab = (key: string, sport: RichActivity["sport"]) => {
    const arr = (raw?.[key] as { activities?: unknown[] } | undefined)?.activities ?? [];
    for (const a of arr as Record<string, unknown>[]) out.push(mapRichActivity(a, sport));
  };
  grab("getRunningActivity", "Run");
  grab("getCyclingActivity", "Ride");
  grab("getSwimmingActivity", "Swim");
  return out.filter((a) => a.date);
}

// ---------- Load model: CTL / ATL / TSB from the daily ESS series ----------

export interface LoadModel {
  series: Array<{ date: string; load: number; ctl: number; atl: number; tsb: number }>;
  ctl: number;
  atl: number;
  tsb: number;
  rampPerWeek: number; // ΔCTL over the last 7 days
}

/** EWMA load model. `getRecoveryModel.data` has parallel `date` + `external_stress_score` arrays. */
export function loadModel(recoveryData: { date?: unknown[]; external_stress_score?: unknown[] } | undefined): LoadModel | null {
  const dates = (recoveryData?.date ?? []).map((d) => String(d).slice(0, 10));
  const ess = (recoveryData?.external_stress_score ?? []).map((e) => num(e) ?? 0);
  if (dates.length < 14 || dates.length !== ess.length) return null;

  const ctlK = 2 / (42 + 1);
  const atlK = 2 / (7 + 1);
  let ctl = ess[0];
  let atl = ess[0];
  const series = dates.map((date, i) => {
    ctl = ess[i] * ctlK + ctl * (1 - ctlK);
    atl = ess[i] * atlK + atl * (1 - atlK);
    return { date, load: ess[i], ctl: +ctl.toFixed(1), atl: +atl.toFixed(1), tsb: +(ctl - atl).toFixed(1) };
  });
  const last = series[series.length - 1];
  const weekAgo = series[Math.max(0, series.length - 8)];
  return { series, ctl: last.ctl, atl: last.atl, tsb: last.tsb, rampPerWeek: +(last.ctl - weekAgo.ctl).toFixed(1) };
}

// ---------- Run-load ramp guard (the injury-window safety net; ACWR demoted) ----------

export interface RunRamp {
  weeks: Array<{ week: string; ess: number; minutes: number }>;
  thisWeekEss: number;
  baselineEss: number; // mean of prior up-to-4 weeks
  jumpPct: number | null;
}

/** Weekly run ESS + minutes; flags an absolute week-on-week jump vs the trailing baseline. */
export function runLoadRamp(acts: RichActivity[]): RunRamp {
  const runs = acts.filter((a) => a.sport === "Run");
  const byWeek = new Map<string, { ess: number; minutes: number }>();
  for (const r of runs) {
    const w = isoWeek(r.date);
    const e = byWeek.get(w) ?? { ess: 0, minutes: 0 };
    e.ess += r.ess ?? 0;
    e.minutes += (r.movingSec ?? 0) / 60;
    byWeek.set(w, e);
  }
  const weeks = [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => ({ week, ess: +v.ess.toFixed(0), minutes: +v.minutes.toFixed(0) }));
  const thisWeekEss = weeks.length ? weeks[weeks.length - 1].ess : 0;
  const prior = weeks.slice(Math.max(0, weeks.length - 5), weeks.length - 1).map((w) => w.ess);
  const baselineEss = mean(prior) ?? 0;
  const jumpPct = baselineEss > 0 ? +(((thisWeekEss - baselineEss) / baselineEss) * 100).toFixed(0) : null;
  return { weeks, thisWeekEss, baselineEss: +baselineEss.toFixed(0), jumpPct };
}

// ---------- Trend helper for list-level metrics (EF, durability, threshold) ----------

export interface Trend {
  recent: number | null;
  prior: number | null;
  deltaPct: number | null;
  n: number;
}

/** Compare the mean of the most recent `half` valid points to the prior `half`. */
function splitTrend(values: Array<number | undefined>, half = 5): Trend {
  const v = values.filter((x): x is number => x != null);
  const recent = mean(v.slice(-half));
  const prior = mean(v.slice(-2 * half, -half));
  const deltaPct = recent != null && prior != null && prior !== 0 ? +(((recent - prior) / prior) * 100).toFixed(1) : null;
  return { recent: recent == null ? null : +recent.toFixed(2), prior: prior == null ? null : +prior.toFixed(2), deltaPct, n: v.length };
}

/** Efficiency Factor = avg power ÷ avg HR. Steady-aerobic proxy: sessions ≥ 40 min. */
export function efTrend(acts: RichActivity[], sport: RichActivity["sport"]): Trend {
  const ef = acts
    .filter((a) => a.sport === sport && (a.movingSec ?? 0) >= 2400 && a.avwatts && a.avhr)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((a) => a.avwatts! / a.avhr!);
  return splitTrend(ef);
}

/** Durability trend — consume AI Endurance's DFA-α1 durability %. */
export function durabilityTrend(acts: RichActivity[], sport: RichActivity["sport"]): Trend {
  const vals = acts
    .filter((a) => a.sport === sport)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((a) => a.durabilityPct);
  return splitTrend(vals);
}

// ---------- Monotony & strain (Foster) — from the daily load series ----------

export interface MonotonyStrain {
  monotony: number | null; // weekly mean load ÷ SD; >~2 = too samey, elevated illness/overtraining risk
  strain: number | null; // weekly load × monotony
  weeklyLoad: number;
}
export function monotonyStrain(series: Array<{ load: number }> | undefined): MonotonyStrain {
  if (!series || series.length < 7) return { monotony: null, strain: null, weeklyLoad: 0 };
  const last7 = series.slice(-7).map((p) => p.load);
  const m = mean(last7)!;
  const sd = Math.sqrt(mean(last7.map((x) => (x - m) ** 2)) ?? 0);
  const weeklyLoad = last7.reduce((a, b) => a + b, 0);
  const monotony = sd > 0 ? +(m / sd).toFixed(2) : null;
  const strain = monotony != null ? +(weeklyLoad * monotony).toFixed(0) : null;
  return { monotony, strain, weeklyLoad: +weeklyLoad.toFixed(0) };
}

// ---------- Intensity distribution (TID) — from plan-progress zone adherence ----------

export interface TID {
  easyPct: number | null;
  tempoPct: number | null;
  hardPct: number | null;
  totalH: number;
}
export function intensityDistribution(
  adh: Record<string, { actualH: number; prescribedH: number }> | null | undefined,
): TID {
  if (!adh) return { easyPct: null, tempoPct: null, hardPct: null, totalH: 0 };
  const z = (k: string) => adh[k]?.actualH ?? 0;
  const easy = z("Endurance");
  const tempo = z("Tempo");
  const hard = z("Threshold") + z("VO2Max") + z("Anaerobic");
  const total = easy + tempo + hard;
  if (total <= 0) return { easyPct: null, tempoPct: null, hardPct: null, totalH: 0 };
  return {
    easyPct: Math.round((easy / total) * 100),
    tempoPct: Math.round((tempo / total) * 100),
    hardPct: Math.round((hard / total) * 100),
    totalH: +total.toFixed(1),
  };
}

/** Aerobic-threshold (HR) trend from DFA-α1, dropping noisy readings (high HRV artifact). */
export function thresholdTrend(acts: RichActivity[], sport: RichActivity["sport"], maxArtifactPct = 5): Trend {
  const vals = acts
    .filter((a) => a.sport === sport && (a.hrvArtifactPct == null || a.hrvArtifactPct <= maxArtifactPct))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((a) => a.aerThrHr);
  return splitTrend(vals);
}
