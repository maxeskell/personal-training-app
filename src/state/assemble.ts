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
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

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
  mapNutrition(state, raw.getNutritionModel);
  state.prediction = { value: raw.getPrediction ?? null, source: "ai-endurance" };
  state.adherenceByZone = { value: (raw.getPlanProgress as any) ?? null, source: "ai-endurance" };
  state.plannedSessions = {
    value: Array.isArray(get(raw.getPlannedWorkouts, "workouts"))
      ? (get(raw.getPlannedWorkouts, "workouts") as any)
      : null,
    source: "ai-endurance",
  };

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

function mapRecovery(state: AthleteState, payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const rec: RecoveryModel = {
    cardioRecovery: asNumber(get(payload, "cardioRecovery")),
    dfaAlpha1: asNumber(get(payload, "dfaAlpha1")),
    rmssd: asNumber(get(payload, "rmssd")),
    restingHrTrend: asNumber(get(payload, "restingHrTrend")),
    orthopedic: {
      run: asNumber(get(payload, "orthopedic", "run")),
      bike: asNumber(get(payload, "orthopedic", "bike")),
      swim: asNumber(get(payload, "orthopedic", "swim")),
    },
    limiterToday: typeof get(payload, "limiterToday") === "string"
      ? (get(payload, "limiterToday") as string)
      : undefined,
  };
  state.recovery = { value: rec, source: "ai-endurance" };

  // If AIE exposes rMSSD/RHR we can use them as interpretable signals too.
  if (rec.rmssd != null && state.hrvOvernight.value == null) {
    state.hrvOvernight = { value: rec.rmssd, source: "ai-endurance", note: "rMSSD from recovery model" };
  }
}

function mapNutrition(state: AthleteState, payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const range = (k: string) => {
    const lower = asNumber(get(payload, k, "lower"));
    const upper = asNumber(get(payload, k, "upper"));
    return lower != null && upper != null ? { lower, upper } : undefined;
  };
  const targets: NutritionTargets = {
    calories: range("calories"),
    proteinG: range("protein"),
    fatG: range("fat"),
    carbG: range("carb"),
  };
  state.nutritionTargets = {
    value: targets,
    source: "ai-endurance",
    note: "adequate-fuelling ranges — never a deficit target",
  };
}

function collectActivities(raw: Record<string, unknown>): ActualActivity[] {
  const out: ActualActivity[] = [];
  const push = (payload: unknown, sport: ActualActivity["sport"]) => {
    const arr = Array.isArray(payload)
      ? payload
      : Array.isArray(get(payload, "activities"))
        ? (get(payload, "activities") as unknown[])
        : [];
    for (const a of arr) {
      out.push({
        activityId: String(get(a, "id") ?? get(a, "activityId") ?? ""),
        date: String(get(a, "date") ?? ""),
        sport,
        durationMin: asNumber(get(a, "durationMin")) ?? asNumber(get(a, "duration")),
        distanceKm: asNumber(get(a, "distanceKm")) ?? asNumber(get(a, "distance")),
      });
    }
  };
  push(raw.getRunningActivity, "Run");
  push(raw.getCyclingActivity, "Ride");
  push(raw.getSwimmingActivity, "Swim");
  return out;
}
