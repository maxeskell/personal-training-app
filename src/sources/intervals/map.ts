import { emptyState, type AthleteState, type ActualActivity, type PlannedSession } from "../../state/types.js";

/**
 * intervals.icu → AthleteState mapping (Phase 3b). PURE + fixture-tested. The adapter emits the same
 * AIE-shaped `raw` payload keys the insight engine already reads (getRunningActivity/…/getRecoveryModel/
 * getRaceGoalEvent/getPlannedWorkouts) PLUS the typed fields the dashboard/readiness read — so the rest of
 * the app runs unchanged. Fields intervals.icu doesn't expose (DFA-α1 durability, AIE race predictions,
 * plan-progress adherence) are left `absent()` and degrade, per "honest models / degrade, don't crash".
 *
 * Field reads are DEFENSIVE (multiple candidate keys) because the live API shapes vary by activity type
 * and platform version — confirm against real data on first run.
 */

const SRC = "intervals";
type Rec = Record<string, unknown>;

function num(x: unknown): number | undefined {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x))) return Number(x);
  return undefined;
}
function str(x: unknown): string | undefined {
  return typeof x === "string" && x.trim() !== "" ? x : undefined;
}
/** First defined value among candidate keys. */
function pick(o: Rec, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] != null) return o[k];
  return undefined;
}
function dateOf(o: Rec, ...keys: string[]): string {
  return String(pick(o, ...keys) ?? "").slice(0, 10);
}

type Sport = "Run" | "Ride" | "Swim";
/** intervals `type` → our sport bucket (null = ignore for the rich-activity analytics). */
export function sportOf(type: string | undefined): Sport | null {
  const t = (type ?? "").toLowerCase();
  if (t.includes("run")) return "Run";
  if (t.includes("ride") || t.includes("bike") || t.includes("cycl") || t.includes("velomobile")) return "Ride";
  if (t.includes("swim")) return "Swim";
  return null;
}

/** One intervals activity → the AIE-shaped activity object the insight engine's richActivities() reads. */
function toAieActivity(a: Rec): Rec {
  const distM = num(pick(a, "distance", "icu_distance"));
  return {
    activity_id: String(pick(a, "id", "activity_id") ?? ""),
    activity_date_local: dateOf(a, "start_date_local", "start_date", "date"),
    external_stress_score: num(pick(a, "icu_training_load", "training_load", "trainingLoad")),
    activity_avwatts: num(pick(a, "average_watts", "icu_average_watts", "avg_watts")),
    activity_avhr: num(pick(a, "average_heartrate", "icu_average_hr", "avg_hr")),
    activity_movingtime: num(pick(a, "moving_time", "movingTime", "elapsed_time")),
    distance_in_km: distM != null ? +(distM / 1000).toFixed(2) : undefined,
  };
}

export interface IntervalsRaw {
  activities?: Rec[];
  wellness?: Rec[];
  events?: Rec[];
}

/** Build today's AthleteState from fetched intervals.icu arrays. Pure. */
export function mapIntervals(data: IntervalsRaw, opts: { date: string; assembledAt: string }): AthleteState {
  const state = emptyState(opts.date, opts.assembledAt);
  const raw: Record<string, unknown> = {};
  const activities = data.activities ?? [];
  const wellness = [...(data.wellness ?? [])].sort((a, b) => dateOf(a, "id", "date").localeCompare(dateOf(b, "id", "date")));
  const events = data.events ?? [];

  // ---- Activities → AIE-shaped raw (per sport) + typed actualActivities + a daily load map ----
  const bySport: Record<Sport, Rec[]> = { Run: [], Ride: [], Swim: [] };
  const actual: ActualActivity[] = [];
  const loadByDate = new Map<string, number>();
  for (const a of activities) {
    const sport = sportOf(str(pick(a, "type", "sport")));
    const date = dateOf(a, "start_date_local", "start_date", "date");
    const load = num(pick(a, "icu_training_load", "training_load", "trainingLoad")) ?? 0;
    if (date) loadByDate.set(date, (loadByDate.get(date) ?? 0) + load);
    if (!sport || !date) continue;
    bySport[sport].push(toAieActivity(a));
    const movingSec = num(pick(a, "moving_time", "movingTime", "elapsed_time"));
    const distM = num(pick(a, "distance", "icu_distance"));
    actual.push({
      activityId: String(pick(a, "id", "activity_id") ?? ""),
      date,
      sport,
      durationMin: movingSec != null ? Math.round(movingSec / 60) : undefined,
      distanceKm: distM != null && distM > 0 ? +(distM / 1000).toFixed(2) : undefined,
    });
  }
  raw.getRunningActivity = { activities: bySport.Run };
  raw.getCyclingActivity = { activities: bySport.Ride };
  raw.getSwimmingActivity = { activities: bySport.Swim };
  state.actualActivities = { value: actual.sort((a, b) => b.date.localeCompare(a.date)), source: SRC };

  // ---- Wellness → getRecoveryModel.data series (date/ESS/rMSSD/RHR) + typed recovery/hrv/rhr/weight/sleep/vo2max ----
  if (wellness.length) {
    const dates = wellness.map((w) => dateOf(w, "id", "date"));
    raw.getRecoveryModel = {
      data: {
        date: dates,
        external_stress_score: dates.map((d) => +(loadByDate.get(d) ?? 0)),
        rMSSD: wellness.map((w) => num(pick(w, "hrv", "rMSSD", "hrvRMSSD")) ?? null),
        resting_heart_rate: wellness.map((w) => num(pick(w, "restingHR", "resting_hr", "restingHeartRate")) ?? null),
      },
    };
    const last = wellness[wellness.length - 1];
    const rmssd = num(pick(last, "hrv", "rMSSD", "hrvRMSSD"));
    const rhr = num(pick(last, "restingHR", "resting_hr", "restingHeartRate"));
    const weight = num(pick(last, "weight", "weightKg"));
    const sleepSecs = num(pick(last, "sleepSecs", "sleep_secs", "sleepSeconds"));
    const sleepScore = num(pick(last, "sleepScore", "sleep_score"));
    const vo2 = num(pick(last, "vo2max", "icu_vo2max"));
    state.recovery = { value: { rmssdMs: rmssd, restingHrBpm: rhr }, source: SRC, note: "from intervals.icu wellness (latest)" };
    if (rmssd != null) state.hrvOvernight = { value: rmssd, source: SRC, note: "rMSSD (ms, latest) from wellness" };
    if (rhr != null) state.restingHr = { value: rhr, source: SRC, note: "resting HR (bpm, latest) from wellness" };
    if (weight != null) state.weightKg = { value: weight, source: SRC, note: "wellness weight (trend only, not a daily target)" };
    if (sleepSecs != null || sleepScore != null) state.sleep = { value: { hours: sleepSecs != null ? +(sleepSecs / 3600).toFixed(1) : undefined, score: sleepScore }, source: SRC };
    if (vo2 != null) state.vo2max = { value: vo2, source: SRC, note: "intervals.icu estimate" };

    // FTP, if intervals carried it on the latest activity (athlete-settings endpoint not pulled here).
    const ftp = num(pick(activities[0] ?? {}, "icu_ftp", "ftp"));
    if (ftp != null) state.thresholds = { value: { bikeFtpW: ftp }, source: SRC, note: "FTP from intervals.icu" };
  }

  // ---- Events → planned workouts (getPlannedWorkouts + typed) and races (getRaceGoalEvent) ----
  const planned: PlannedSession[] = [];
  const goals: Rec[] = [];
  for (const e of events) {
    const date = dateOf(e, "start_date_local", "start_date", "date");
    const category = String(pick(e, "category", "type") ?? "").toUpperCase();
    const name = str(pick(e, "name", "title")) ?? "";
    if (!date) continue;
    if (category.includes("RACE")) {
      goals.push({ event_name: name, event_date: date, priority: str(pick(e, "icu_priority", "priority")) ?? "" });
      continue;
    }
    if (category.includes("NOTE")) continue;
    const durSec = num(pick(e, "moving_time", "icu_training_load_target", "duration"));
    planned.push({
      workoutId: String(pick(e, "id") ?? ""),
      date,
      title: name || undefined,
      sport: sportOf(str(pick(e, "type"))) ?? "Other",
      durationMin: durSec != null ? Math.round(durSec / 60) : undefined,
    });
  }
  raw.getPlannedWorkouts = { workouts: planned.map((p) => ({ workout_id: p.workoutId, date: p.date, title: p.title, act_type: p.sport, duration_seconds: p.durationMin != null ? p.durationMin * 60 : undefined })) };
  raw.getRaceGoalEvent = { goals };
  state.plannedSessions = { value: planned, source: SRC };

  state.raw = raw;
  return state;
}
