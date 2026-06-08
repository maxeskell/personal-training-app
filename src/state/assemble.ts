import type { AieClient, AieReadTool } from "../mcp/aieClient.js";
import type { GarminClient } from "../mcp/garminClient.js";
import { StateStore } from "./store.js";
import { applyBaselines, computeBaselines } from "./baselines.js";
import { detectSyncGaps } from "./syncGaps.js";
import {
  emptyState,
  type ActualActivity,
  type AthleteState,
  type NutritionTargets,
  type RecoveryModel,
} from "./types.js";

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
  mapAdherence(state, raw.getPlanProgress);
  state.prediction = { value: raw.getPrediction ?? null, source: "ai-endurance" };
  state.plannedSessions = { value: mapPlanned(raw.getPlannedWorkouts), source: "ai-endurance" };

  const aieActivities = collectActivities(raw);
  state.actualActivities = { value: aieActivities, source: "ai-endurance" };

  // --- Optional Garmin gap-fillers (tiebreak only; degradable) ---
  let garminStale = false;
  if (garmin?.available) {
    // Tool names vary across garmin_mcp versions — call best-effort, map what returns.
    const sleep = extractJson(await garmin.tryCall("get_sleep_data"));
    const battery = extractJson(await garmin.tryCall("get_body_battery"));
    const readiness = extractJson(await garmin.tryCall("get_training_readiness"));
    const weight = extractJson(await garmin.tryCall("get_body_composition"));
    raw.garmin = { sleep, battery, readiness, weight };

    state.tiebreak = {
      value: {
        sleepScore: asNumber(get(sleep, "score")),
        sleepHours: asNumber(get(sleep, "hours")),
        bodyBattery: asNumber(get(battery, "level")),
        trainingReadiness: asNumber(get(readiness, "score")),
      },
      source: "garmin",
      note: "tiebreak only — proprietary black box, directional not gospel",
    };
    const w = asNumber(get(weight, "weight"));
    if (w != null) state.weightKg = { value: w, source: "garmin", note: "trend only" };
    const hrv = asNumber(get(sleep, "hrv")) ?? asNumber(get(readiness, "hrv"));
    if (hrv != null) state.hrvOvernight = { value: hrv, source: "garmin" };
    const rhr = asNumber(get(sleep, "restingHeartRate"));
    if (rhr != null) state.restingHr = { value: rhr, source: "garmin" };
  } else if (garmin && !garmin.available) {
    garminStale = true;
  }

  // --- Baselines from trailing history (incl. today) ---
  const window = await store.recent(opts.date, opts.baselineWindowDays ?? 7);
  // Ensure today's freshly-read values participate in its own baseline window.
  const withToday = [...window.filter((s) => s.date !== opts.date), state];
  applyBaselines(state, computeBaselines(withToday));

  // --- Sync-gap detection ---
  state.syncGaps = detectSyncGaps({
    date: opts.date,
    aieActivities,
    garminActivities: garminStale || !garmin?.available ? undefined : [],
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
  let idx = Array.isArray(dates) ? dates.findIndex((d) => String(d).startsWith(date)) : -1;
  if (idx < 0 && Array.isArray(dates)) idx = Math.min(1, dates.length - 1); // fallback: today ≈ index 1

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
        distanceKm: asNumber(get(a, "distance_in_km")),
      });
    }
  };
  push(raw.getRunningActivity, "Run");
  push(raw.getCyclingActivity, "Ride");
  push(raw.getSwimmingActivity, "Swim");
  return out;
}
