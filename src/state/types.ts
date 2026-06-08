/**
 * Unified daily athlete state — the core data asset (Build Spec §8).
 * Every field carries PROVENANCE so the coach can cite its source and so we can
 * tell a real signal from a black-box tiebreak or a degraded/absent source.
 */

export type Source = "ai-endurance" | "garmin" | "derived" | "manual";

/** A value plus where it came from. `null` value = known-absent (e.g. Garmin down). */
export interface Provenanced<T> {
  value: T | null;
  source: Source;
  /** Optional note, e.g. "garmin stale" or "tiebreak only". */
  note?: string;
}

export interface PlannedSession {
  workoutId?: string;
  date: string;
  title?: string;
  type?: string;
  sport?: "Ride" | "Run" | "Swim" | "Strength" | "Other";
  durationMin?: number;
}

export interface ActualActivity {
  activityId?: string;
  date: string;
  sport: "Ride" | "Run" | "Swim" | "Other";
  durationMin?: number;
  distanceKm?: number;
}

/** Load model from AI Endurance (it owns these — we never recompute). */
export interface LoadModel {
  ctl?: number;
  atl?: number;
  tsb?: number;
}

/**
 * Recovery model — AI Endurance owns this; orthopedic is per-sport (key for run-load watch).
 * NOTE (verified 2026-06-08): the `*Recovery` fields are 0–100 recovery sub-scores
 * (higher = more recovered), NOT raw physiological values. Raw rMSSD/RHR are separate.
 * Raw DFA α1 is not currently exposed by the API (returns null).
 */
export interface RecoveryModel {
  cardioRecovery?: number; // overall cardio recovery, 0–100
  alpha1Recovery?: number; // recovery score derived from DFA α1, 0–100
  rmssdRecovery?: number; // recovery score derived from rMSSD, 0–100
  rhrRecovery?: number; // recovery score derived from resting HR, 0–100
  rmssdMs?: number; // raw rMSSD (ms) — the interpretable HRV signal
  restingHrBpm?: number; // raw resting heart rate (bpm)
  orthopedic?: { run?: number; bike?: number; swim?: number }; // per-sport recovery, 0–100
  limiterToday?: string; // `driving_recovery`, e.g. "hr_rest"
}

/**
 * Garmin TIEBREAK-ONLY signals — proprietary black boxes, directional not gospel.
 * Used only when the interpretable signals are ambiguous (Integration Spec §3).
 */
export interface TiebreakSignals {
  bodyBatteryLevel?: string; // categorical: "LOW" | "MODERATE" | "HIGH" (Garmin doesn't expose a 0–100 here)
  trainingReadiness?: number; // 0–100
  trainingReadinessLevel?: string; // e.g. "POOR" | "MODERATE" | "READY"
}

/** Sleep — an INTERPRETABLE readiness signal (not a tiebreak). Garmin-sourced. */
export interface SleepSignals {
  score?: number; // Garmin sleep score 0–100
  hours?: number;
  overnightHrvMs?: number; // Garmin avg overnight HRV (ms) — supplementary to AIE rMSSD
}

/** Adequate-fuelling ranges from getNutritionModel — never deficits. */
export interface NutritionTargets {
  calories?: { lower: number; upper: number };
  proteinG?: { lower: number; upper: number };
  fatG?: { lower: number; upper: number };
  carbG?: { lower: number; upper: number };
}

export interface SyncGap {
  kind: "missing-in-garmin" | "missing-in-aie" | "duration-mismatch" | "garmin-stale";
  date: string;
  detail: string;
}

export type ReadinessVerdict = "green" | "amber" | "red" | "unknown";

export interface Decision {
  timestamp: string;
  proposal: string;
  tradeoff?: string;
  status: "proposed" | "accepted" | "declined" | "deferred";
}

export interface AthleteState {
  /** ISO date (YYYY-MM-DD) this state describes. */
  date: string;
  assembledAt: string;

  plannedSessions: Provenanced<PlannedSession[]>;
  actualActivities: Provenanced<ActualActivity[]>;
  load: Provenanced<LoadModel>;
  adherenceByZone: Provenanced<Record<string, { actualH: number; prescribedH: number }>>;
  prediction: Provenanced<unknown>;
  recovery: Provenanced<RecoveryModel>;

  // Interpretable readiness signals + their rolling baselines (derived).
  hrvOvernight: Provenanced<number>;
  hrv7dBaseline: Provenanced<number>;
  restingHr: Provenanced<number>;
  restingHr7dBaseline: Provenanced<number>;

  // Sleep — interpretable readiness signal (Garmin).
  sleep: Provenanced<SleepSignals>;

  // Garmin tiebreak-only — clearly flagged as such.
  tiebreak: Provenanced<TiebreakSignals>;

  // Weight: TREND only, secondary, never a daily target.
  weightKg: Provenanced<number>;
  weight7dTrend: Provenanced<number>;

  vo2max: Provenanced<number>;
  nutritionTargets: Provenanced<NutritionTargets>;

  syncGaps: SyncGap[];
  readinessVerdict: ReadinessVerdict;
  readinessWhy: string;
  decisions: Decision[];

  /**
   * Unmapped raw tool payloads, keyed by tool name. Kept so the LLM layer (M3)
   * can reason over fields we didn't (yet) map into typed slots — and so we stay
   * resilient to AIE tool-shape changes (Integration Spec §2.1) rather than
   * hard-coding every field.
   */
  raw?: Record<string, unknown>;
}

export function emptyState(date: string, assembledAt: string): AthleteState {
  const absent = <T>(source: Source = "ai-endurance"): Provenanced<T> => ({
    value: null,
    source,
  });
  return {
    date,
    assembledAt,
    plannedSessions: absent<PlannedSession[]>(),
    actualActivities: absent<ActualActivity[]>(),
    load: absent<LoadModel>(),
    adherenceByZone: absent(),
    prediction: absent(),
    recovery: absent<RecoveryModel>(),
    hrvOvernight: absent<number>("garmin"),
    hrv7dBaseline: absent<number>("derived"),
    restingHr: absent<number>(),
    restingHr7dBaseline: absent<number>("derived"),
    sleep: absent<SleepSignals>("garmin"),
    tiebreak: absent<TiebreakSignals>("garmin"),
    weightKg: absent<number>("garmin"),
    weight7dTrend: absent<number>("derived"),
    vo2max: absent<number>("garmin"),
    nutritionTargets: absent<NutritionTargets>(),
    syncGaps: [],
    readinessVerdict: "unknown",
    readinessWhy: "Not yet assessed.",
    decisions: [],
  };
}
