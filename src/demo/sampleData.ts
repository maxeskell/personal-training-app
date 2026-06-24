import { emptyState, type AthleteState, type PlannedSession, type ActualActivity, type DisciplineThresholds, type Source } from "../state/types.js";
import { deriveZones } from "../insights/zones.js";
import type { Profile } from "../profile/schema.js";
import type { GarminDay } from "../archive/store.js";

/** A fictional profile for the demo — just enough to show the "Set up & improve" card (actionable AIE
 *  gaps + a free-text open item + unfilled profile questions) so the feature is discoverable in
 *  `npm run demo`. Not a real athlete; no live numbers (none belong here). */
export const demoProfile: Profile = {
  schema_version: 1,
  identity: { name: "Sample Athlete", units: "metric" },
  ai_endurance_todo: {
    swim_css: "not_set",
    ftp_w: "unresolved",
  },
  open_items: ["Shim the bike cleat after the next race"],
  // A small sample fuel inventory so `npm run demo` showcases the "Fuelling — week ahead" card with real
  // picks (a real user lists their own under fuelling.products in profile.local.yaml).
  fuelling: {
    products: [
      { name: "Energy Gel", brand: "Demo", category: "gel", serving: "1 gel", carbs_g: 22, caffeine_mg: 0 },
      { name: "Oat Flapjack", brand: "Demo", category: "bar", serving: "1 bar", carbs_g: 40 },
      { name: "Electrolyte Tab", brand: "Demo", category: "electrolyte", serving: "1 tab in 500 ml", sodium_mg: 250 },
      { name: "Recovery Shake", brand: "Demo", category: "recovery", serving: "1 scoop", protein_g: 20, carbs_g: 25 },
    ],
    preferences: { carb_ceiling_g_per_hour: 90, caffeine_cutoff_hour: 16 },
  },
};

/**
 * Deterministic SAMPLE data for the demo mode (`npm run demo`) — lets anyone see the coach working with
 * no AI Endurance account, no Garmin, and no API key. It is clearly fictional and never touches the
 * network or the real data store. Values are a fixed, healthy-looking athlete (flat weight + normal
 * HRV/RHR/sleep, so the wellbeing guardrail stays quiet) generated from a seeded wobble (no RNG → the
 * demo is reproducible and testable).
 */

/** Reproducible wobble in [-1, 1] from an integer seed (no Math.random). */
function wob(i: number, phase = 0): number {
  return Math.sin(i * 1.3 + phase);
}

function isoShift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const DEMO_THRESHOLDS: DisciplineThresholds = {
  bikeFtpW: 250,
  bikeFtpWkg: 3.6,
  bikeThresholdHr: 160,
  runThresholdPaceSecPerKm: 255, // ~4:15 /km
  runThresholdHr: 168,
  swimCssSecPer100: 95,
  maxHr: 188,
};

const WEEK_SPORTS: Array<NonNullable<PlannedSession["sport"]>> = ["Run", "Ride", "Swim", "Run", "Ride", "Run", "Strength"];

/**
 * Rich per-activity payloads (the `getRunningActivity` / `getCyclingActivity` shape `richActivities`
 * parses) so the demo populates the data-rich cards that an empty activity feed leaves blank: the **Last
 * session** card, run economy (EF), the run-load ramp, and the **brick decoupling** proxy (which needs
 * power-equipped runs). Runs carry running power, so some land on ride days (brick) and some don't
 * (fresh) — brick runs sit a touch lower in EF, a realistic "holds up off the bike" read. Deterministic.
 */
function demoActivities(today: string): { runs: Record<string, unknown>[]; rides: Record<string, unknown>[] } {
  const rides = [2, 5, 9, 12, 16, 19, 23, 26].map((d, k) => ({
    activity_date_local: isoShift(today, -d),
    activity_movingtime: 3600 + (k % 3) * 900,
    activity_avwatts: Math.round(196 + 12 * wob(k, 11)),
    activity_avhr: Math.round(142 + 5 * wob(k, 12)),
    external_stress_score: Math.round(72 + 15 * wob(k, 13)),
  }));
  const mkRun = (d: number, k: number, brick: boolean) => ({
    activity_date_local: isoShift(today, -d),
    activity_movingtime: 2700 + (k % 3) * 600, // ≥45 min → counts for EF (needs ≥20 min)
    activity_avhr: Math.round((brick ? 153 : 150) + 3 * wob(k, 14)),
    activity_avwatts: Math.round((brick ? 281 : 287) + 6 * wob(k, 15)), // brick EF a touch lower
    external_stress_score: Math.round(55 + 12 * wob(k, 16)),
    aerobic_durability_according_to_dfa_alpha1_running_power_in_percent: Math.round(90 + 4 * wob(k, 17)),
    aerobic_threshold_dfa_alpha1_heart_rate_cluster: Math.round(150 + 3 * wob(k, 18)),
    aerobic_threshold_dfa_alpha1_watts_cluster: Math.round(256 + 8 * wob(k, 19)),
  });
  const brickRuns = [2, 9, 16, 23].map((d, k) => mkRun(d, k, true)); // same day as a ride
  const freshRuns = [1, 4, 7, 11, 14, 18, 21].map((d, k) => mkRun(d, k, false));
  return { runs: [...freshRuns, ...brickRuns], rides };
}

/**
 * A 42-day daily-ESS series for `getRecoveryModel.data` — the parallel `date[]` + `external_stress_score[]`
 * arrays that `loadModel` reads (it needs ≥14) to derive CTL/ATL/TSB + the weekly ramp. A gentle upward
 * build with a weekly easy/rest-day dip → a realistic Load & trends card (not a wall of "—"). Deterministic.
 */
function demoRecoveryData(today: string, days = 42): {
  date: string[];
  external_stress_score: number[];
  rMSSD: number[];
  resting_heart_rate: number[];
  recovery: number[];
} {
  const date: string[] = [];
  const external_stress_score: number[] = [];
  const rMSSD: number[] = [];
  const resting_heart_rate: number[] = [];
  const recovery: number[] = [];
  for (let k = days - 1; k >= 0; k--) {
    const i = days - 1 - k; // 0..days-1 ascending (oldest → today)
    date.push(isoShift(today, -k));
    const restDay = i % 7 === 6; // one easy/rest day a week
    const base = restDay ? 12 : 66 + i * 0.3; // gentle block build
    external_stress_score.push(Math.max(0, Math.round(base + 16 * wob(i, 7))));
    // HRV/RHR series + a recovery score that genuinely LAGS yesterday's HRV (low HRV → lower recovery
    // the next day). That real lead-1 relationship lets the monitoring backtest surface an *exploratory*
    // (clearly-labelled, not validated) watch rule instead of an empty "0d history". Honest sample data.
    rMSSD.push(Math.round(45 + 6 * wob(i)));
    resting_heart_rate.push(Math.round(48 + 3 * wob(i, 1)));
    recovery.push(Math.round(64 + 10 * wob(i - 1) + 4 * wob(i, 21))); // mostly tracks prior-day HRV, with noise
  }
  return { date, external_stress_score, rMSSD, resting_heart_rate, recovery };
}

/** Build a `days`-long AthleteState window (ascending) ending on `today`, populated with sample data. */
export function buildDemoWindow(today: string, days = 21): AthleteState[] {
  const p = <T>(value: T, source: Source, note?: string) => ({ value, source, note });
  const window: AthleteState[] = [];

  for (let k = days - 1; k >= 0; k--) {
    const date = isoShift(today, -k);
    const i = days - 1 - k; // 0..days-1 ascending
    const s = emptyState(date, `${date}T06:30:00Z`);

    // Interpretable readiness time-series (mild, healthy wobble — stays clear of every risk threshold).
    s.hrvOvernight = p(Math.round(45 + 5 * wob(i)), "garmin");
    s.hrv7dBaseline = p(45, "derived");
    s.restingHr = p(Math.round(48 + 2 * wob(i, 1)), "garmin");
    s.restingHr7dBaseline = p(48, "derived");
    s.weightKg = p(+(70.2 + 0.2 * wob(i, 2)).toFixed(1), "garmin"); // flat trend → no health flag
    s.weight7dTrend = p(0, "derived");
    s.sleep = p({ score: Math.round(82 + 6 * wob(i, 3)), hours: +(7.4 + 0.4 * wob(i, 4)).toFixed(1), overnightHrvMs: 45 }, "garmin");
    s.recovery = p(
      {
        cardioRecovery: Math.round(72 + 10 * wob(i, 5)),
        rmssdMs: Math.round(45 + 5 * wob(i)),
        restingHrBpm: Math.round(48 + 2 * wob(i, 1)),
        orthopedic: { run: 74, bike: 82, swim: 86 },
        limiterToday: "hr_rest",
      },
      "ai-endurance",
    );
    const ctl = +(60 + i * 0.5).toFixed(1);
    const atl = +(ctl + 6 * wob(i, 6)).toFixed(1);
    s.load = p({ ctl, atl, tsb: +(ctl - atl).toFixed(1) }, "ai-endurance");
    // A recent VO₂max bump (53 → 55 two days ago) so the demo showcases the "Data changes" card.
    s.vo2max = p(i >= days - 2 ? 55 : 53, "garmin", "demo sample data");

    window.push(s);
  }

  // Enrich "today" with current markers, the week ahead, recent actuals and the race calendar.
  const t = window[window.length - 1];
  t.thresholds = p(DEMO_THRESHOLDS, "ai-endurance", "demo sample data");
  t.zones = p(deriveZones(DEMO_THRESHOLDS), "derived", "standard zone models from the demo thresholds");
  // Per-source readings so the "Data changes" card shows a live AIE-vs-Garmin disagreement: Garmin's
  // device auto-detects a LOWER cycling FTP (235 W) from sparse power data than the test-based 250 W in
  // use — the realistic "keep the higher value, but show the gap" case (matches the 235 W power-curve FTP).
  t.thresholdsBySource = {
    "ai-endurance": DEMO_THRESHOLDS,
    garmin: { ...DEMO_THRESHOLDS, bikeFtpW: 235 },
  };
  t.nutritionTargets = p(
    { calories: { lower: 2600, upper: 3200 }, carbG: { lower: 350, upper: 500 }, proteinG: { lower: 110, upper: 150 }, fatG: { lower: 60, upper: 90 } },
    "ai-endurance",
  );

  const planned: PlannedSession[] = WEEK_SPORTS.map((sport, d) => ({
    workoutId: `demo-${d}`,
    date: isoShift(today, d + 1), // the next 7 days
    title: `${sport} — demo session`,
    sport,
    type: "endurance",
    durationMin: sport === "Strength" ? 45 : 55 + d * 5,
  }));
  t.plannedSessions = p(planned, "ai-endurance", "demo sample data");

  const actuals: ActualActivity[] = ([["Run", 12], ["Ride", 40], ["Swim", 2], ["Run", 10]] as const).map(([sport, km], d) => ({
    activityId: `demo-act-${d}`,
    date: isoShift(today, -(d + 1)),
    sport,
    durationMin: 55 + d * 5,
    distanceKm: km,
  }));
  t.actualActivities = p(actuals, "ai-endurance", "demo sample data");

  // Race calendar drives the race-splits + prediction insights. ~5 weeks to a tri, ~14 to a marathon.
  const races = {
    goals: [
      { name: "Demo City Triathlon", event_date: isoShift(today, 35), type: "Olympic Triathlon" },
      { name: "Demo Marathon", event_date: isoShift(today, 98), type: "Marathon" },
    ],
  };
  const prediction = { marathon_seconds: 3 * 3600 + 25 * 60, "10k_seconds": 42 * 60 };
  // Daily ESS series drives the Load & trends card (CTL/ATL/TSB + ramp) via loadModel; the rich activity
  // payloads drive the Last-session card, run economy, run-load ramp and the brick decoupling proxy.
  const { runs, rides } = demoActivities(today);
  t.raw = {
    getRaceGoalEvent: races,
    getPrediction: prediction,
    getRecoveryModel: { data: demoRecoveryData(today) },
    getRunningActivity: { activities: runs },
    getCyclingActivity: { activities: rides },
  };
  t.prediction = p(prediction, "ai-endurance", "demo sample data");

  // Garmin model scores → the "Garmin scores" + "Estimated race times" cards. The power-curve FTP
  // estimate sits BELOW the configured 250 W FTP so the gap note shows; endurance/hill are mid-range.
  t.powerCurve = p(
    {
      ftpEstimateW: 235,
      activitiesAnalyzed: 24,
      bests: [
        { duration: "5 s", watts: 920, date: isoShift(today, -9) },
        { duration: "1 min", watts: 545, date: isoShift(today, -16) },
        { duration: "5 min", watts: 332, date: isoShift(today, -5) },
        { duration: "20 min", watts: 268, date: isoShift(today, -12) },
        { duration: "60 min", watts: 235, date: isoShift(today, -12) },
      ],
    },
    "garmin",
    "demo sample data",
  );
  t.enduranceScore = p({ current: 7420, classification: "Trained", periodAvg: 7180, periodMax: 7600, nextThresholdLabel: "Expert", nextThresholdGap: 580 }, "garmin", "demo sample data");
  t.hillScore = p({ overall: 57, strength: 53, endurance: 61 }, "garmin", "demo sample data");
  t.racePredictions = p(
    {
      date: today,
      predictions: [
        { label: "5K", timeSeconds: 19 * 60 + 30 },
        { label: "10K", timeSeconds: 40 * 60 + 45 },
        { label: "Half", timeSeconds: 90 * 60 + 20 },
        { label: "Marathon", timeSeconds: 3 * 3600 + 12 * 60 },
      ],
    },
    "garmin",
    "demo sample data",
  );

  return window;
}

/**
 * 42-day Garmin daily series (HRV / resting-HR / sleep / stress) → the multi-week **Trends** card. Mirrors
 * the healthy per-state wobble so the sparklines read as one coherent (fictional) athlete. Deterministic.
 */
export function buildDemoGarminDays(today: string, days = 42): GarminDay[] {
  const out: GarminDay[] = [];
  for (let k = days - 1; k >= 0; k--) {
    const i = days - 1 - k;
    out.push({
      date: isoShift(today, -k),
      hrvMs: Math.round(45 + 5 * wob(i)),
      restingHr: Math.round(48 + 2 * wob(i, 1)),
      sleepScore: Math.round(82 + 6 * wob(i, 3)),
      sleepHours: +(7.4 + 0.4 * wob(i, 4)).toFixed(1),
      avgStressLevel: Math.round(32 + 8 * wob(i, 8)),
      bodyBatteryChange: Math.round(45 + 10 * wob(i, 9)),
      deepSleepSec: Math.round((75 + 10 * wob(i, 10)) * 60),
    });
  }
  return out;
}
