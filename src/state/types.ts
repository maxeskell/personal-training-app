/**
 * Unified daily athlete state — the core data asset (Build Spec §8).
 * Every field carries PROVENANCE so the coach can cite its source and so we can
 * tell a real signal from a black-box tiebreak or a degraded/absent source.
 */

export type Source = "ai-endurance" | "intervals" | "garmin" | "derived" | "manual";

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

/**
 * Garmin training-status / acute:chronic load (get_training_status). Garmin computes the acute:chronic
 * workload ratio natively — the most evidence-backed overtraining/injury flag in the dataset (brief Q2).
 */
export interface TrainingStatusSignals {
  label?: string; // e.g. "OVERREACHING_5", "PRODUCTIVE_2", "UNPRODUCTIVE_3"
  acuteLoad?: number;
  chronicLoad?: number;
  loadRatio?: number; // acute:chronic
  acwrStatus?: string; // "HIGH" | "OPTIMAL" | "LOW"
  vo2max?: number;
  optimalChronicLoadMin?: number;
  optimalChronicLoadMax?: number;
}

/** Garmin HRV status with the device's own personal baseline band (get_hrv_data). */
export interface HrvStatusSignals {
  status?: string; // "BALANCED" | "UNBALANCED" | "LOW" | "POOR"
  lastNightMs?: number;
  weeklyMs?: number;
  baselineLowMs?: number;
  baselineUpperMs?: number;
}

/** Garmin power-duration curve / season bests (get_power_duration_curve) — the bike/run MMP. */
export interface PowerCurveSignals {
  ftpEstimateW?: number;
  activitiesAnalyzed?: number;
  bests: Array<{ duration: string; watts: number; date?: string }>;
}

/** Garmin endurance score (get_endurance_score) — sustained-effort capacity vs VO2max (catalogue E5). */
export interface EnduranceScoreSignals {
  current?: number;
  classification?: string;
  periodAvg?: number;
  periodMax?: number;
  nextThresholdLabel?: string;
  nextThresholdGap?: number;
}

/** Garmin hill score (get_hill_score) — climbing strength + endurance (catalogue E6, low priority). */
export interface HillScoreSignals {
  overall?: number;
  strength?: number;
  endurance?: number;
}

/** Garmin race-time predictions (get_race_predictions) — estimated finish per standard distance. */
export interface RacePredictionSignals {
  date?: string;
  predictions: Array<{ label: string; timeSeconds: number }>;
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

/** A set of training-zone boundaries for one metric (e.g. 5 HR zones = 6 bounds, or n labels). */
export interface ZoneSet {
  metric: "hr" | "power" | "pace" | "speed";
  unit: string; // "bpm" | "W" | "sec/km" | "sec/100m"
  bounds: number[]; // ascending zone edges; bounds[i]..bounds[i+1] is zone i+1
  labels?: string[]; // optional zone names, length = bounds.length - 1
  source: "ai-endurance" | "derived"; // derived = computed from a threshold via a standard model
}

/** Per-discipline zone sets (HR for all; power for bike; pace for run/swim). */
export interface DisciplineZones {
  run?: { hr?: ZoneSet; pace?: ZoneSet; power?: ZoneSet };
  bike?: { hr?: ZoneSet; power?: ZoneSet };
  swim?: { pace?: ZoneSet };
}

/** Current threshold/FTP markers per discipline (the headline training numbers). */
export interface DisciplineThresholds {
  bikeFtpW?: number;
  bikeFtpWkg?: number;
  bikeThresholdHr?: number; // bike LTHR when exposed; bike HR zones fall back to run LTHR when absent
  runThresholdPaceSecPerKm?: number;
  runThresholdHr?: number;
  runThresholdPowerW?: number; // running power threshold (FR970 native running power)
  swimCssSecPer100?: number;
  bikeFtpNote?: string; // set when Garmin's auto-detected FTP conflicts with a higher test-based value
}

/** Athlete identity from getUser — every field optional; only what the platform actually exposes. */
export interface AthleteProfile {
  name?: string;
  age?: number;
  sex?: string;
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

/** Bump when the persisted AthleteState shape changes in a way future migrations need to detect. */
export const STATE_SCHEMA_VERSION = 1;

export interface AthleteState {
  /** Schema version of this persisted record (see STATE_SCHEMA_VERSION). */
  schemaVersion?: number;
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

  // Garmin training-status (acute:chronic load) + HRV status — interpretable health signals.
  trainingStatus: Provenanced<TrainingStatusSignals>;
  hrvStatus: Provenanced<HrvStatusSignals>;

  // Garmin model scores: power-duration curve (MMP), endurance score, hill score.
  powerCurve: Provenanced<PowerCurveSignals>;
  enduranceScore: Provenanced<EnduranceScoreSignals>;
  hillScore: Provenanced<HillScoreSignals>;
  racePredictions: Provenanced<RacePredictionSignals>;

  // Weight: TREND only, secondary, never a daily target.
  weightKg: Provenanced<number>;
  weight7dTrend: Provenanced<number>;

  vo2max: Provenanced<number>;
  nutritionTargets: Provenanced<NutritionTargets>;

  // Athlete identity from getUser (name/age/sex) — whatever the platform exposes; degrades to absent.
  athleteProfile: Provenanced<AthleteProfile>;

  // Training zones + threshold markers per discipline (from getUser, or derived from thresholds).
  zones: Provenanced<DisciplineZones>;
  thresholds: Provenanced<DisciplineThresholds>;

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
    schemaVersion: STATE_SCHEMA_VERSION,
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
    trainingStatus: absent<TrainingStatusSignals>("garmin"),
    hrvStatus: absent<HrvStatusSignals>("garmin"),
    powerCurve: absent<PowerCurveSignals>("garmin"),
    enduranceScore: absent<EnduranceScoreSignals>("garmin"),
    hillScore: absent<HillScoreSignals>("garmin"),
    racePredictions: absent<RacePredictionSignals>("garmin"),
    weightKg: absent<number>("garmin"),
    weight7dTrend: absent<number>("derived"),
    vo2max: absent<number>("garmin"),
    nutritionTargets: absent<NutritionTargets>(),
    athleteProfile: absent<AthleteProfile>(),
    zones: absent<DisciplineZones>(),
    thresholds: absent<DisciplineThresholds>(),
    syncGaps: [],
    readinessVerdict: "unknown",
    readinessWhy: "Not yet assessed.",
    decisions: [],
  };
}
