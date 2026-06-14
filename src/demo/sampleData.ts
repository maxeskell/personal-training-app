import { emptyState, type AthleteState, type PlannedSession, type ActualActivity, type DisciplineThresholds, type Source } from "../state/types.js";
import { deriveZones } from "../insights/zones.js";

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
};

const WEEK_SPORTS: Array<NonNullable<PlannedSession["sport"]>> = ["Run", "Ride", "Swim", "Run", "Ride", "Run", "Strength"];

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

    window.push(s);
  }

  // Enrich "today" with current markers, the week ahead, recent actuals and the race calendar.
  const t = window[window.length - 1];
  t.thresholds = p(DEMO_THRESHOLDS, "ai-endurance", "demo sample data");
  t.zones = p(deriveZones(DEMO_THRESHOLDS), "derived", "standard zone models from the demo thresholds");
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
  t.raw = { getRaceGoalEvent: races, getPrediction: prediction };
  t.prediction = p(prediction, "ai-endurance", "demo sample data");

  return window;
}
