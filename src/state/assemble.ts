import type { AieClient, AieReadTool } from "../mcp/aieClient.js";
import type { GarminClient } from "../mcp/garminClient.js";
import { StateStore } from "./store.js";
import { applyBaselines, computeBaselines } from "./baselines.js";
import { detectSyncGaps } from "./syncGaps.js";
import {
  emptyState,
  type ActualActivity,
  type AthleteState,
  type DisciplineThresholds,
  type NutritionTargets,
  type PowerCurveSignals,
  type RacePredictionSignals,
  type RecoveryModel,
} from "./types.js";
import { deriveZones } from "../insights/zones.js";
import { config } from "../config.js";

/**
 * Assemble today's AthleteState from AI Endurance (spine) + optional Garmin.
 *
 * Defensive by design: we extract what we recognise and leave the rest null,
 * keeping raw payloads for the LLM layer. We do NOT hard-code brittle full-shape
 * assumptions — a tool changing shape degrades a field to null, it doesn't crash.
 */

/** Pull JSON out of an MCP CallToolResult (prefers structuredContent). */
export function extractJson(result: unknown): unknown {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (r.structuredContent !== undefined) return r.structuredContent;
    if (Array.isArray(r.content)) {
      const text = r.content
        .filter((c): c is { type: string; text: string } =>
          Boolean(c && typeof c === "object" && (c as any).type === "text"),
        )
        .map((c) => c.text)
        .join("\n");
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
  return result;
}

function asNumber(x: unknown): number | undefined {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x))) return Number(x);
  return undefined;
}

/** Last finite element of a numeric time-series array (AIE returns 60-day series). */
function lastNum(arr: unknown): number | undefined {
  if (!Array.isArray(arr)) return undefined;
  for (let i = arr.length - 1; i >= 0; i--) {
    const n = asNumber(arr[i]);
    if (n !== undefined) return n;
  }
  return undefined;
}

/** Last non-empty element of an array (e.g. the "driving_recovery" string series). */
function lastVal(arr: unknown): unknown {
  if (!Array.isArray(arr)) return undefined;
  return arr.length ? arr[arr.length - 1] : undefined;
}

/** Last element of an array, else the value itself (Garmin returns arrays or scalars). */
function lastEl(v: unknown): unknown {
  return Array.isArray(v) ? (v.length ? v[v.length - 1] : undefined) : v;
}

/** ISO date `n` days before `date` (YYYY-MM-DD), via UTC to avoid TZ drift. */
function daysAgoIso(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Garmin (Taxuspt) wraps tool output as `{result: "<json string>"}` inside the
 * MCP content. extractJson() unwraps the MCP envelope; this unwraps the inner
 * `result` JSON string. Returns null on any miss so callers degrade cleanly.
 */
export function garminInner(toolResult: unknown): unknown {
  if (toolResult === null || toolResult === undefined) return null;
  const obj = extractJson(toolResult);
  const inner = obj && typeof obj === "object" && "result" in (obj as Record<string, unknown>)
    ? (obj as Record<string, unknown>).result
    : obj;
  if (typeof inner === "string") {
    try {
      return JSON.parse(inner);
    } catch {
      return inner; // e.g. "No weight measurements found for …"
    }
  }
  return inner;
}

const SPORT_FROM_ACT: Record<string, "Ride" | "Run" | "Swim" | "Strength" | "Other"> = {
  Ride: "Ride",
  Run: "Run",
  Swim: "Swim",
  Bike: "Ride",
  Strength: "Strength",
};

function get(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return cur;
}

export interface AssembleOptions {
  date: string;
  assembledAt: string;
  /** How many trailing days (incl. today) to use for baselines. */
  baselineWindowDays?: number;
}

export async function assembleState(
  aie: AieClient,
  garmin: GarminClient | undefined,
  store: StateStore,
  opts: AssembleOptions,
): Promise<AthleteState> {
  const state = emptyState(opts.date, opts.assembledAt);
  const raw: Record<string, unknown> = {};

  // --- AI Endurance reads (cost-aware defaults: summaryMode + low resolution) ---
  const reads: Array<[AieReadTool, Record<string, unknown>]> = [
    ["getUser", {}],
    ["getPlannedWorkouts", { summaryMode: true }],
    ["getRunningActivity", {}],
    ["getCyclingActivity", {}],
    ["getSwimmingActivity", {}],
    ["getRecoveryModel", {}],
    ["getPlanProgress", {}],
    ["getPrediction", {}],
    ["getNutritionModel", {}],
    ["getRaceGoalEvent", {}],
  ];

  for (const [tool, args] of reads) {
    try {
      raw[tool] = extractJson(await aie.read(tool, args));
    } catch (err) {
      raw[tool] = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- Best-effort mapping into typed slots (null where unrecognised) ---
  mapRecovery(state, raw.getRecoveryModel);
  mapNutrition(state, raw.getNutritionModel, opts.date);
  mapUser(state, raw.getUser);
  mapZonesThresholds(state, raw.getUser);
  mapAdherence(state, raw.getPlanProgress);
  state.prediction = { value: raw.getPrediction ?? null, source: "ai-endurance" };
  state.plannedSessions = { value: mapPlanned(raw.getPlannedWorkouts), source: "ai-endurance" };

  const aieActivities = collectActivities(raw);
  state.actualActivities = { value: aieActivities, source: "ai-endurance" };

  // --- Optional Garmin gap-fillers (degradable). Tool names/shapes verified
  //     against Taxuspt/garmin_mcp 2026-06-08. Garmin wraps payloads in {result:"<json>"}. ---
  let garminStale = false;
  if (garmin?.available) {
    const weekAgo = daysAgoIso(opts.date, 7);
    const monthAgo = daysAgoIso(opts.date, 30);
    // The Taxuspt MCP processes one CallToolRequest at a time, so firing these in parallel just races
    // them against a single 15s timeout (the queued ones expire before they run). Call SEQUENTIALLY —
    // no slower against a serial server, and each call's timeout starts when it's actually dispatched.
    // Sequential, with an overall wall-clock budget: once exceeded, remaining reads are skipped (null)
    // so a slow tool can't make the whole assemble (and /refresh) hang for minutes.
    const deadline = Date.now() + config.garmin.refreshBudgetMs;
    const callG = (tool: string, args: Record<string, unknown>): Promise<unknown> =>
      Date.now() > deadline ? Promise.resolve(null) : garmin.tryCall(tool, args).then(garminInner);
    const sleep = await callG("get_sleep_summary", { date: opts.date });
    const battery = await callG("get_body_battery", { start_date: weekAgo, end_date: opts.date });
    const readiness = await callG("get_training_readiness", { date: opts.date });
    const vo2 = await callG("get_vo2max_trend", { start_date: weekAgo, end_date: opts.date });
    const weight = await callG("get_daily_weigh_ins", { date: opts.date });
    const ftp = await callG("get_cycling_ftp", {});
    const lactate = await callG("get_lactate_threshold", {});
    const trainingStatus = await callG("get_training_status", { date: opts.date });
    const hrv = await callG("get_hrv_data", { date: opts.date });
    const pdc = await callG("get_power_duration_curve", {});
    const endurance = await callG("get_endurance_score", { start_date: monthAgo, end_date: opts.date });
    const hill = await callG("get_hill_score", { start_date: monthAgo, end_date: opts.date });
    const racePred = await callG("get_race_predictions", {});
    raw.garmin = { sleep, battery, readiness, vo2, weight, ftp, lactate, trainingStatus, hrv, pdc, endurance, hill, racePred };

    // Thresholds + zones from Garmin's own FTP/LT tools (verified shapes) — these win over the
    // AIE getUser-derived values mapped earlier, since they're the device's current numbers.
    mapGarminThresholds(state, ftp, lactate);
    mapTrainingStatus(state, trainingStatus);
    mapHrvStatus(state, hrv);
    mapPowerCurve(state, pdc);
    mapEnduranceScore(state, endurance);
    mapHillScore(state, hill);
    mapRacePredictions(state, racePred);

    // Sleep — interpretable signal (own slot).
    const sleepScore = asNumber(get(sleep, "sleep_score"));
    const sleepHours = asNumber(get(sleep, "sleep_hours"));
    const overnightHrv = asNumber(get(sleep, "avg_overnight_hrv"));
    if (sleepScore != null || sleepHours != null || overnightHrv != null) {
      state.sleep = {
        value: { score: sleepScore, hours: sleepHours, overnightHrvMs: overnightHrv },
        source: "garmin",
      };
    }

    // Tiebreak-only black boxes: latest Body Battery (categorical) + Training Readiness.
    const latestBattery = lastEl(battery);
    const latestReadiness = lastEl(readiness);
    const bbLevel = get(latestBattery, "body_battery_level");
    const trLevel = get(latestReadiness, "level");
    state.tiebreak = {
      value: {
        bodyBatteryLevel: typeof bbLevel === "string" ? bbLevel : undefined,
        trainingReadiness: asNumber(get(latestReadiness, "score")),
        trainingReadinessLevel: typeof trLevel === "string" ? trLevel : undefined,
      },
      source: "garmin",
      note: "tiebreak only — proprietary black box, directional not gospel",
    };

    // VO2max (latest from trend).
    const v = asNumber(get(vo2, "latest_vo2_max"));
    if (v != null) state.vo2max = { value: v, source: "garmin", note: "Garmin device estimate" };

    // Weight: Garmin trend reading wins over AIE profile fallback, when present.
    // python-garminconnect reports weight in grams — normalise to kg.
    const wRaw = asNumber(get(weight, "weight")) ?? asNumber(get(lastEl(weight), "weight"));
    if (wRaw != null) {
      const kg = wRaw > 1000 ? wRaw / 1000 : wRaw;
      state.weightKg = { value: kg, source: "garmin", note: "Index trend (trend only, never a daily target)" };
    }
  } else if (garmin && !garmin.available) {
    garminStale = true;
  }

  // --- Baselines from trailing history (incl. today) ---
  const window = await store.recent(opts.date, opts.baselineWindowDays ?? 7);
  // Ensure today's freshly-read values participate in its own baseline window.
  const withToday = [...window.filter((s) => s.date !== opts.date), state];
  applyBaselines(state, computeBaselines(withToday));

  // --- Sync-gap detection ---
  // We do NOT fetch Garmin's activity list: AIE is the activity source of truth and
  // already ingests Garmin (Integration Spec §3). Activity cross-check is reserved for
  // resolving a specific discrepancy, so we pass `undefined` (no cross-check) here —
  // never an empty list, which would false-flag every AIE activity as a gap.
  state.syncGaps = detectSyncGaps({
    date: opts.date,
    aieActivities,
    garminActivities: undefined,
    garminStale,
  });

  state.raw = raw;
  return state;
}

/**
 * AIE `getRecoveryModel` returns 60-day time-series under `data` (and per-sport
 * `data_joint_muscle_{ride,run,swim}`). We take the LATEST element of each series.
 * Shapes verified against live data 2026-06-08. `recovery_alpha1` may be all-null
 * (DFA α1 not populated) — that degrades to undefined, which is correct.
 */
function mapRecovery(state: AthleteState, payload: unknown): void {
  const data = get(payload, "data");
  if (!data || typeof data !== "object") return;

  const rmssdMs = lastNum(get(data, "rMSSD")); // raw HRV (ms)
  const rhrBpm = lastNum(get(data, "resting_heart_rate")); // raw RHR (bpm)
  const limiter = lastVal(get(data, "driving_recovery"));

  const rec: RecoveryModel = {
    cardioRecovery: lastNum(get(data, "recovery")),
    alpha1Recovery: lastNum(get(data, "recovery_alpha1")),
    rmssdRecovery: lastNum(get(data, "recovery_rmssd")),
    rhrRecovery: lastNum(get(data, "recovery_resting_heart_rate")),
    rmssdMs,
    restingHrBpm: rhrBpm,
    orthopedic: {
      run: lastNum(get(payload, "data_joint_muscle_run", "recovery")),
      bike: lastNum(get(payload, "data_joint_muscle_ride", "recovery")),
      swim: lastNum(get(payload, "data_joint_muscle_swim", "recovery")),
    },
    limiterToday: typeof limiter === "string" ? limiter : undefined,
  };
  state.recovery = { value: rec, source: "ai-endurance" };

  // Interpretable readiness signals from the AIE model (used when Garmin absent).
  if (rmssdMs != null && state.hrvOvernight.value == null) {
    state.hrvOvernight = { value: rmssdMs, source: "ai-endurance", note: "raw rMSSD (ms, latest) from recovery model" };
  }
  if (rhrBpm != null && state.restingHr.value == null) {
    state.restingHr = { value: rhrBpm, source: "ai-endurance", note: "raw resting HR (bpm, latest) from recovery model" };
  }
}

/**
 * AIE `getNutritionModel.data` holds 6-day arrays (1 past + today + 5 future) with
 * `daily_*_lower_bound` / `_upper_bound`. We select today's index via the `date` array.
 */
function mapNutrition(state: AthleteState, payload: unknown, date: string): void {
  const data = get(payload, "data");
  if (!data || typeof data !== "object") return;

  const dates = get(data, "date");
  // Match today's date exactly; if it isn't present, leave targets ABSENT rather than guessing a
  // position (a positional fallback applied yesterday's/tomorrow's ranges as today's, esp. across a TZ edge).
  const idx = Array.isArray(dates) ? dates.findIndex((d) => String(d).startsWith(date)) : -1;

  const at = (arr: unknown): number | undefined =>
    Array.isArray(arr) && idx >= 0 ? asNumber(arr[idx]) : undefined;
  const range = (lo: string, hi: string) => {
    const lower = at(get(data, lo));
    const upper = at(get(data, hi));
    return lower != null && upper != null ? { lower, upper } : undefined;
  };

  const targets: NutritionTargets = {
    calories: range("daily_calories_lower_bound", "daily_calories_upper_bound"),
    proteinG: range("daily_protein_grams_lower_bound", "daily_protein_grams_upper_bound"),
    fatG: range("daily_fat_grams_lower_bound", "daily_fat_grams_upper_bound"),
    carbG: range("daily_carbohydrates_grams_lower_bound", "daily_carbohydrates_grams_upper_bound"),
  };
  state.nutritionTargets = {
    value: targets,
    source: "ai-endurance",
    note: "adequate-fuelling ranges — never a deficit target",
  };
}

/** `getUser` exposes a profile `weight_kg` — use it as an AIE-sourced fallback when Garmin is absent. */
function mapUser(state: AthleteState, payload: unknown): void {
  if (state.weightKg.value != null) return; // Garmin already provided a trend reading.
  const w = asNumber(get(payload, "weight_kg"));
  if (w != null) {
    state.weightKg = { value: w, source: "ai-endurance", note: "profile weight (trend only, not a daily target)" };
  }
}

/** First defined numeric value across a list of candidate keys on an object. */
function firstNum(obj: unknown, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = asNumber(get(obj, k));
    if (v != null) return v;
  }
  return undefined;
}

/**
 * Threshold/FTP markers + zones from getUser (user ask). Field shapes vary across AIE profile
 * versions, so we probe several plausible keys and gate to null when absent — then derive standard
 * zone bands from the thresholds (see insights/zones). Degrades cleanly if getUser exposes none.
 */
function mapZonesThresholds(state: AthleteState, payload: unknown): void {
  const thresholds: DisciplineThresholds = {};
  const ftp = firstNum(payload, ["ftp", "ftp_watts", "cycling_ftp", "bike_ftp", "functional_threshold_power"]);
  if (ftp != null && ftp > 0) {
    thresholds.bikeFtpW = Math.round(ftp);
    const kg = state.weightKg.value;
    if (kg && kg > 0) thresholds.bikeFtpWkg = +(ftp / kg).toFixed(2);
  }
  const runHr = firstNum(payload, ["run_threshold_hr", "lactate_threshold_hr", "threshold_heart_rate", "lthr", "threshold_hr"]);
  if (runHr != null && runHr > 0) thresholds.runThresholdHr = Math.round(runHr);
  const bikeHr = firstNum(payload, ["bike_threshold_hr", "cycling_threshold_hr", "bike_lactate_threshold_hr", "cycling_lactate_threshold_hr"]);
  if (bikeHr != null && bikeHr > 0) thresholds.bikeThresholdHr = Math.round(bikeHr);
  // Pace fields may be sec/km already, or m/s (convert). Accept a sane sec/km range.
  const paceRaw = firstNum(payload, ["run_threshold_pace_sec_per_km", "threshold_pace", "run_threshold_pace", "running_threshold_pace"]);
  if (paceRaw != null && paceRaw > 0) {
    const secPerKm = paceRaw < 12 ? Math.round(1000 / paceRaw) : Math.round(paceRaw); // m/s → sec/km if tiny
    if (secPerKm >= 150 && secPerKm <= 600) thresholds.runThresholdPaceSecPerKm = secPerKm;
  }
  const cssRaw = firstNum(payload, ["css_sec_per_100m", "swim_css", "css", "critical_swim_speed"]);
  if (cssRaw != null && cssRaw > 0) {
    const secPer100 = cssRaw < 5 ? Math.round(100 / cssRaw) : Math.round(cssRaw); // m/s → sec/100m if tiny
    if (secPer100 >= 60 && secPer100 <= 240) thresholds.swimCssSecPer100 = secPer100;
  }

  if (Object.keys(thresholds).length === 0) return; // nothing exposed → leave absent
  state.thresholds = { value: thresholds, source: "ai-endurance" };
  state.zones = { value: deriveZones(thresholds), source: "derived", note: "standard zone models from thresholds (Coggan power / %-LTHR / %-threshold pace)" };
}

/**
 * Garmin FTP/lactate-threshold → thresholds + zones (verified shapes from `get_cycling_ftp` /
 * `get_lactate_threshold`). Garmin's lactate-threshold markers win over AIE, but its cycling FTP does
 * NOT win blindly: Garmin only auto-detects cycling FTP from rides WITH power data and only revises it
 * upward on a hard, sustained power effort, so with sparse/power-meter-less riding it can sit
 * implausibly low. We therefore keep the HIGHER of Garmin's device FTP and any AIE/test-based value,
 * and flag the gap rather than silently corrupting the power zones. Note: Garmin's
 * `lactate_threshold_speed_mps` has been observed reported ~10× too small, so we normalise a value in
 * the 0.2–0.8 range up by 10 before deriving pace, and only accept a plausible running speed.
 */
export function mapGarminThresholds(state: AthleteState, ftp: unknown, lactate: unknown): void {
  const t: DisciplineThresholds = { ...(state.thresholds.value ?? {}) };
  const weightKg = asNumber(get(lactate, "weight_kg")) ?? state.weightKg.value ?? undefined;

  const priorBikeFtp = t.bikeFtpW; // AIE/test-derived value mapped earlier, if any
  const bikeFtp = asNumber(get(ftp, "functional_threshold_power_watts"));
  if (bikeFtp != null && bikeFtp > 0 && String(get(ftp, "sport") ?? "CYCLING").toUpperCase().includes("CYCL")) {
    const garminFtp = Math.round(bikeFtp);
    if (priorBikeFtp != null && garminFtp < priorBikeFtp) {
      // Keep the higher (test-based) value driving the zones, but surface the conflict.
      t.bikeFtpNote = `Garmin auto-detects ${garminFtp} W from sparse power-meter rides — keeping the higher test-based ${priorBikeFtp} W. Do a power-meter FTP effort to let Garmin re-detect.`;
      if (weightKg && weightKg > 0) t.bikeFtpWkg = +(priorBikeFtp / weightKg).toFixed(2);
    } else {
      t.bikeFtpW = garminFtp;
      if (weightKg && weightKg > 0) t.bikeFtpWkg = +(garminFtp / weightKg).toFixed(2);
    }
  }

  const ltHr = asNumber(get(lactate, "lactate_threshold_heart_rate_bpm"));
  if (ltHr != null && ltHr > 0) t.runThresholdHr = Math.round(ltHr);
  // get_lactate_threshold reports the RUNNING functional threshold power (FR970 native running power).
  const runPow = asNumber(get(lactate, "functional_threshold_power_watts"));
  if (runPow != null && runPow > 0 && String(get(lactate, "sport") ?? "").toUpperCase().includes("RUN")) {
    t.runThresholdPowerW = Math.round(runPow);
  }
  let v = asNumber(get(lactate, "lactate_threshold_speed_mps"));
  if (v != null && v >= 0.2 && v < 0.8) v *= 10; // known ~10× under-report
  if (v != null && v >= 2 && v <= 7) t.runThresholdPaceSecPerKm = Math.round(1000 / v);

  if (Object.keys(t).length === 0) return;
  state.thresholds = { value: t, source: "garmin", note: "Garmin get_cycling_ftp + get_lactate_threshold" };
  state.zones = { value: deriveZones(t), source: "derived", note: "standard zone models from Garmin thresholds (Coggan power / %-LTHR / %-threshold pace)" };
}

/** get_training_status → acute:chronic load + status label (verified snake_case shape). */
function mapTrainingStatus(state: AthleteState, payload: unknown): void {
  const ratio = asNumber(get(payload, "load_ratio"));
  const acute = asNumber(get(payload, "acute_load"));
  const label = get(payload, "training_status_feedback");
  if (ratio == null && acute == null && typeof label !== "string") return;
  state.trainingStatus = {
    value: {
      label: typeof label === "string" ? label : undefined,
      acuteLoad: acute,
      chronicLoad: asNumber(get(payload, "chronic_load")),
      loadRatio: ratio,
      acwrStatus: typeof get(payload, "acwr_status") === "string" ? (get(payload, "acwr_status") as string) : undefined,
      vo2max: asNumber(get(payload, "vo2_max")),
      optimalChronicLoadMin: asNumber(get(payload, "optimal_chronic_load_min")),
      optimalChronicLoadMax: asNumber(get(payload, "optimal_chronic_load_max")),
    },
    source: "garmin",
    note: "Garmin get_training_status (acute:chronic load) — MODEL, directional",
  };
}

/** get_power_duration_curve → MMP season bests + FTP estimate (verified shape). */
function mapPowerCurve(state: AthleteState, payload: unknown): void {
  const sb = get(payload, "season_bests");
  if (!sb || typeof sb !== "object") return;
  const bests: PowerCurveSignals["bests"] = [];
  for (const [duration, v] of Object.entries(sb as Record<string, unknown>)) {
    const watts = asNumber(get(v, "watts"));
    if (watts == null) continue;
    // When each best was set (user ask) — probe the likely keys; epoch-ms also accepted.
    const dRaw = get(v, "date") ?? get(v, "start_time") ?? get(v, "start_time_local") ?? get(v, "activity_date") ?? get(v, "begin_timestamp");
    const date =
      typeof dRaw === "string" && dRaw
        ? dRaw.slice(0, 10)
        : typeof dRaw === "number" && dRaw > 1e12
          ? new Date(dRaw).toISOString().slice(0, 10)
          : undefined;
    bests.push({ duration, watts, date });
  }
  if (!bests.length) return;
  state.powerCurve = {
    value: { ftpEstimateW: asNumber(get(payload, "ftp_estimate_w")), activitiesAnalyzed: asNumber(get(payload, "activities_analyzed")), bests },
    source: "garmin",
    note: "Garmin get_power_duration_curve (season bests / MMP)",
  };
}

/** get_endurance_score → current score + classification + distance to the next threshold (E5). */
function mapEnduranceScore(state: AthleteState, payload: unknown): void {
  const current = asNumber(get(payload, "current_score"));
  if (current == null) return;
  const thresholds = get(payload, "thresholds");
  let nextLabel: string | undefined;
  let nextGap: number | undefined;
  if (thresholds && typeof thresholds === "object") {
    const sorted = Object.entries(thresholds as Record<string, number>)
      .map(([k, v]) => [k, asNumber(v) ?? 0] as [string, number])
      .sort((a, b) => a[1] - b[1]);
    const next = sorted.find(([, v]) => v > current);
    if (next) {
      nextLabel = next[0];
      nextGap = Math.round(next[1] - current);
    }
  }
  state.enduranceScore = {
    value: {
      current: Math.round(current),
      classification: typeof get(payload, "classification") === "string" ? (get(payload, "classification") as string) : undefined,
      periodAvg: asNumber(get(payload, "period_avg_score")),
      periodMax: asNumber(get(payload, "period_max_score")),
      nextThresholdLabel: nextLabel,
      nextThresholdGap: nextGap,
    },
    source: "garmin",
    note: "Garmin get_endurance_score (sustained-effort capacity) — MODEL",
  };
}

/** get_hill_score → latest climbing strength/endurance scores (low priority). */
function mapHillScore(state: AthleteState, payload: unknown): void {
  const overall = asNumber(get(payload, "latest_overall_score"));
  if (overall == null) return;
  state.hillScore = {
    value: {
      overall: Math.round(overall),
      strength: asNumber(get(payload, "latest_strength_score")),
      endurance: asNumber(get(payload, "latest_endurance_score")),
    },
    source: "garmin",
    note: "Garmin get_hill_score — MODEL",
  };
}

/** get_race_predictions → estimated finish per standard distance (verified shape: {predictions:{5K:{time_seconds}}}). */
function mapRacePredictions(state: AthleteState, payload: unknown): void {
  const preds = get(payload, "predictions");
  if (!preds || typeof preds !== "object") return;
  const LABELS: Record<string, string> = { "5K": "5K", "10K": "10K", half_marathon: "Half", marathon: "Marathon" };
  const out: RacePredictionSignals["predictions"] = [];
  for (const [key, v] of Object.entries(preds as Record<string, unknown>)) {
    const secs = asNumber(get(v, "time_seconds"));
    if (secs != null && secs > 0) out.push({ label: LABELS[key] ?? key, timeSeconds: secs });
  }
  if (!out.length) return;
  state.racePredictions = {
    value: { date: typeof get(payload, "prediction_date") === "string" ? (get(payload, "prediction_date") as string) : undefined, predictions: out },
    source: "garmin",
    note: "Garmin get_race_predictions — MODEL estimate (trend over absolute)",
  };
}

/** get_hrv_data → HRV status vs Garmin's own personal baseline band (verified snake_case shape). */
function mapHrvStatus(state: AthleteState, payload: unknown): void {
  const status = get(payload, "status");
  const last = asNumber(get(payload, "last_night_avg_hrv_ms"));
  if (typeof status !== "string" && last == null) return;
  state.hrvStatus = {
    value: {
      status: typeof status === "string" ? status : undefined,
      lastNightMs: last,
      weeklyMs: asNumber(get(payload, "weekly_avg_hrv_ms")),
      baselineLowMs: asNumber(get(payload, "baseline_balanced_low_ms")),
      baselineUpperMs: asNumber(get(payload, "baseline_balanced_upper_ms")),
    },
    source: "garmin",
    note: "Garmin get_hrv_data (overnight HRV status vs personal baseline)",
  };
}

/** `getPlanProgress` overall `done_sec`/`plan_sec` per zone → adherence hours. */
function mapAdherence(state: AthleteState, payload: unknown): void {
  if (!payload || typeof payload !== "object") {
    state.adherenceByZone = { value: null, source: "ai-endurance" };
    return;
  }
  const done = get(payload, "done_sec");
  const plan = get(payload, "plan_sec");
  const zones = ["Endurance", "Tempo", "Threshold", "VO2Max", "Anaerobic"];
  const out: Record<string, { actualH: number; prescribedH: number }> = {};
  for (const z of zones) {
    const a = asNumber(get(done, z));
    const p = asNumber(get(plan, z));
    if (a != null || p != null) out[z] = { actualH: (a ?? 0) / 3600, prescribedH: (p ?? 0) / 3600 };
  }
  state.adherenceByZone = {
    value: Object.keys(out).length ? out : null,
    source: "ai-endurance",
    note: "from getPlanProgress done_sec/plan_sec",
  };
}

/** `getPlannedWorkouts.workouts[]` → typed planned sessions. */
function mapPlanned(payload: unknown): AthleteState["plannedSessions"]["value"] {
  const arr = get(payload, "workouts");
  if (!Array.isArray(arr)) return null;
  return arr.map((w) => ({
    workoutId: String(get(w, "workout_id") ?? ""),
    date: String(get(w, "date") ?? ""),
    title: typeof get(w, "title") === "string" ? (get(w, "title") as string) : undefined,
    type: typeof get(w, "act_type") === "string" ? (get(w, "act_type") as string) : undefined,
    sport: SPORT_FROM_ACT[String(get(w, "act_type"))] ?? "Other",
    durationMin: asNumber(get(w, "duration_seconds")) != null
      ? Math.round(asNumber(get(w, "duration_seconds"))! / 60)
      : undefined,
  }));
}

/**
 * Activity distance in km. `distance_in_km` is the verified run/ride key, but swims can sync with it
 * absent or zero (pool swims carry metres), so probe metre-named keys and treat 0 as unknown —
 * a missing distance renders as "—", never a misleading 0.0 km.
 */
function activityDistanceKm(a: unknown, sport: ActualActivity["sport"]): number | undefined {
  const km = asNumber(get(a, "distance_in_km")) ?? asNumber(get(a, "distance_km"));
  if (km != null && km > 0) return km;
  const m =
    asNumber(get(a, "distance_in_m")) ??
    asNumber(get(a, "distance_in_meters")) ??
    asNumber(get(a, "distance_m")) ??
    asNumber(get(a, "total_distance_m")) ??
    // Generic keys are metre-valued for swims; rides/runs already resolve via the km keys above.
    (sport === "Swim" ? asNumber(get(a, "activity_distance")) ?? asNumber(get(a, "distance")) : undefined);
  if (m != null && m > 0) return +(m / 1000).toFixed(2);
  return undefined;
}

function collectActivities(raw: Record<string, unknown>): ActualActivity[] {
  const out: ActualActivity[] = [];
  const push = (payload: unknown, sport: ActualActivity["sport"]) => {
    const arr = Array.isArray(get(payload, "activities")) ? (get(payload, "activities") as unknown[]) : [];
    for (const a of arr) {
      const movingSec = asNumber(get(a, "activity_movingtime"));
      out.push({
        activityId: String(get(a, "activity_id") ?? get(a, "id") ?? ""),
        date: String(get(a, "activity_date_local") ?? get(a, "activity_date") ?? "").slice(0, 10),
        sport,
        durationMin: movingSec != null ? Math.round(movingSec / 60) : undefined,
        distanceKm: activityDistanceKm(a, sport),
      });
    }
  };
  push(raw.getRunningActivity, "Run");
  push(raw.getCyclingActivity, "Ride");
  push(raw.getSwimmingActivity, "Swim");
  return out;
}
