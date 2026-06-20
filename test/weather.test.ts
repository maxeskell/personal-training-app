import { test } from "node:test";
import assert from "node:assert/strict";
import { mapOpenMeteo, type DayForecast, type Forecast, type HourForecast } from "../src/weather/forecast.js";
import { evapMmPerHour, roadWetness } from "../src/weather/roadDry.js";
import { assessWeek, upcomingPlanned, weekday, type AssessOpts } from "../src/weather/assess.js";
import { renderDashboard } from "../src/coach/dashboard.js";
import { emptyState } from "../src/state/types.js";
import type { PlannedSession } from "../src/state/types.js";

const OPTS: AssessOpts = { swimMinWaterC: 13, rideMaxGustKmh: 38, rideMaxRainProbPct: 40, now: "2026-06-08T00:00" };
const pad = (n: number) => String(n).padStart(2, "0");

function mkHour(time: string, over: Partial<HourForecast> = {}): HourForecast {
  return { time, tempC: 16, humidityPct: 70, precipMm: 0, precipProbPct: 10, windKmh: 12, gustKmh: 20, solarWm2: 300, weatherCode: 2, ...over };
}

function mkDay(date: string, hourOver: (h: number) => Partial<HourForecast> = () => ({}), over: Partial<DayForecast> = {}): DayForecast {
  const hours = Array.from({ length: 24 }, (_, h) =>
    mkHour(`${date}T${pad(h)}:00`, { solarWm2: h >= 7 && h <= 19 ? 450 : 0, ...hourOver(h) }),
  );
  return {
    date,
    sunrise: `${date}T05:00`,
    sunset: `${date}T21:00`,
    weatherCode: 2,
    tempMinC: 11,
    tempMaxC: 21,
    precipSumMm: 0,
    precipProbMaxPct: 15,
    gustMaxKmh: 24,
    hours,
    ...over,
  };
}

const mkForecast = (days: DayForecast[]): Forecast => ({ fetchedAt: "2026-06-08T05:00:00Z", latitude: 51.5, longitude: -0.13, days });

// --- drying model ---

test("evaporation: fast in sun+wind+dry air, ~nil on a calm damp night", () => {
  const sunny = evapMmPerHour({ tempC: 19, humidityPct: 55, windKmh: 18, solarWm2: 550 });
  const night = evapMmPerHour({ tempC: 9, humidityPct: 96, windKmh: 4, solarWm2: 0 });
  assert.ok(sunny > 0.4, `sunny afternoon should clear >0.4mm/h, got ${sunny}`);
  assert.ok(night < 0.02, `damp night should be near zero, got ${night}`);
});

test("roads: dry day stays dry; morning rain dries in daytime conditions; evening rain holds overnight", () => {
  const day = (date: string, rainAt: Record<number, number> = {}) =>
    Array.from({ length: 24 }, (_, h) =>
      mkHour(`${date}T${pad(h)}:00`, {
        precipMm: rainAt[h] ?? 0,
        solarWm2: h >= 7 && h <= 19 ? 500 : 0,
        tempC: h >= 10 && h <= 18 ? 19 : 11,
        humidityPct: h >= 10 && h <= 18 ? 60 : 90,
        windKmh: 14,
      }),
    );

  assert.ok(roadWetness(day("2026-06-09")).every((r) => !r.wet), "no rain → never wet");

  const morningRain = roadWetness(day("2026-06-09", { 7: 1.5, 8: 0.8 }));
  const at = (t: string) => morningRain.find((r) => r.time.endsWith(t))!;
  assert.ok(at("T08:00").wet, "wet while raining");
  assert.ok(at("T09:00").wet, "still wet right after");
  assert.ok(!at("T12:00").wet, "dried within a few daytime hours");

  const eveningRain = roadWetness([...day("2026-06-09", { 21: 2 }), ...day("2026-06-10")]);
  assert.ok(eveningRain.find((r) => r.time === "2026-06-10T06:00")!.wet, "no sun + damp night → still wet at 06:00");
  assert.ok(!eveningRain.find((r) => r.time === "2026-06-10T13:00")!.wet, "next day's sun clears it");
});

// --- open-meteo mapping ---

test("mapOpenMeteo groups hourly into per-day forecasts with nullable rain probability", () => {
  const json = {
    latitude: 51.5,
    longitude: -0.13,
    hourly: {
      time: ["2026-06-08T00:00", "2026-06-08T01:00", "2026-06-09T00:00"],
      temperature_2m: [10, 11, 12],
      relative_humidity_2m: [80, 81, 82],
      precipitation: [0, 0.4, 0],
      precipitation_probability: [5, 60, null],
      wind_speed_10m: [10, 12, 8],
      wind_gusts_10m: [20, 25, 16],
      shortwave_radiation: [0, 0, 0],
      weather_code: [1, 61, 2],
    },
    daily: {
      time: ["2026-06-08", "2026-06-09"],
      sunrise: ["2026-06-08T04:45", "2026-06-09T04:45"],
      sunset: ["2026-06-08T21:30", "2026-06-09T21:30"],
      weather_code: [61, 2],
      temperature_2m_max: [18, 20],
      temperature_2m_min: [9, 10],
      precipitation_sum: [0.4, 0],
      precipitation_probability_max: [60, 10],
      wind_gusts_10m_max: [25, 16],
    },
  };
  const fc = mapOpenMeteo(json, "2026-06-08T06:00:00Z");
  assert.equal(fc.days.length, 2);
  assert.equal(fc.days[0].hours.length, 2);
  assert.equal(fc.days[0].hours[1].precipMm, 0.4);
  assert.equal(fc.days[1].hours[0].precipProbPct, null);
  assert.equal(fc.days[0].gustMaxKmh, 25);
  assert.equal(fc.days[0].sunrise, "2026-06-08T04:45");
});

// --- the week assessment (the athlete's rules) ---

function stormyWeek(): Forecast {
  return mkForecast([
    mkDay("2026-06-08"),
    mkDay("2026-06-09", () => ({ precipMm: 1.0, precipProbPct: 85, gustKmh: 45, weatherCode: 63 }), {
      weatherCode: 63,
      precipSumMm: 20,
      precipProbMaxPct: 85,
      gustMaxKmh: 45,
    }),
    mkDay("2026-06-10"),
    mkDay("2026-06-11", () => ({ weatherCode: 95 }), { weatherCode: 95 }),
    mkDay("2026-06-12"),
  ]);
}

const PLAN: PlannedSession[] = [
  { date: "2026-06-09", sport: "Ride", title: "Endurance ride", durationMin: 120 },
  { date: "2026-06-10", sport: "Run", title: "Easy run", durationMin: 50 },
  { date: "2026-06-10", sport: "Strength", title: "Gym", durationMin: 45 },
  { date: "2026-06-11", sport: "Swim", title: "OW swim", durationMin: 40 },
  { date: "2026-06-12", sport: "Ride", title: "Tempo ride", durationMin: 90 },
];

test("ride on a wet, gusty day is poor and suggests the better day; calm dry day is good with a window", () => {
  const w = assessWeek(PLAN, stormyWeek(), OPTS);
  const wetRide = w.sessions.find((s) => s.date === "2026-06-09")!;
  assert.equal(wetRide.verdict, "poor");
  assert.match(wetRide.suggestion ?? "", /best looks like/);

  const dryRide = w.sessions.find((s) => s.date === "2026-06-12")!;
  assert.equal(dryRide.verdict, "good");
  assert.ok(dryRide.window, "has a concrete ride window");
  assert.ok(dryRide.window!.from >= "2026-06-12T05:00", "window starts no earlier than sunrise");
});

test("runs go in any weather; open water in a thunderstorm is a no-go", () => {
  const w = assessWeek(PLAN, stormyWeek(), OPTS);
  assert.equal(w.sessions.find((s) => s.sport === "Run")!.verdict, "good");
  const swim = w.sessions.find((s) => s.sport === "Swim")!;
  assert.equal(swim.verdict, "poor");
  assert.match(swim.reason, /thunder/i);
});

test("indoor sessions are listed as weather-n/a, never dropped or given a ride verdict", () => {
  const w = assessWeek(PLAN, stormyWeek(), { ...OPTS, planAsOf: "2026-06-08T06:00:00Z" });
  const gym = w.sessions.find((s) => s.sport === "Strength")!;
  assert.equal(gym.verdict, "indoor");
  assert.match(gym.reason, /weather doesn't apply/);
  assert.equal(w.sessions.length, PLAN.length, "every planned session appears");
  assert.equal(w.planAsOf, "2026-06-08T06:00:00Z");
});

test("swim water-temp rule: unknown → check the venue; below the floor → marginal with wetsuit advice", () => {
  const calm = mkForecast([mkDay("2026-06-08"), mkDay("2026-06-09")]);
  const swimPlan: PlannedSession[] = [{ date: "2026-06-09", sport: "Swim", title: "OW swim" }];
  const unknown = assessWeek(swimPlan, calm, OPTS).sessions[0];
  assert.equal(unknown.verdict, "good");
  assert.match(unknown.reason, /check the venue/);
  const cold = assessWeek(swimPlan, calm, { ...OPTS, waterTempC: 11.5 }).sessions[0];
  assert.equal(cold.verdict, "marginal");
  assert.match(cold.reason, /below your 13°C floor/);
  const fine = assessWeek(swimPlan, calm, { ...OPTS, waterTempC: 15 }).sessions[0];
  assert.equal(fine.verdict, "good");
});

test("day outlook reports road state and only shows days from today on", () => {
  const w = assessWeek([], stormyWeek(), OPTS);
  assert.equal(w.days.length, 5);
  assert.equal(w.days[0].roads, "dry all day");
  assert.match(w.days.find((d) => d.date === "2026-06-09")!.roads, /wet/);
});

test("upcomingPlanned takes the freshest plan and clips to the 7-day horizon", () => {
  const old = emptyState("2026-06-07", new Date().toISOString());
  old.plannedSessions = { value: [{ date: "2026-06-09", sport: "Run", title: "stale plan" }], source: "ai-endurance" };
  const fresh = emptyState("2026-06-08", new Date().toISOString());
  fresh.plannedSessions = {
    value: [
      { date: "2026-06-07", sport: "Run" }, // yesterday — out
      { date: "2026-06-09", sport: "Ride", title: "current plan" },
      { date: "2026-06-20", sport: "Run" }, // beyond horizon — out
    ],
    source: "ai-endurance",
  };
  const got = upcomingPlanned([old, fresh], "2026-06-08");
  assert.equal(got.sessions.length, 1);
  assert.equal(got.sessions[0].title, "current plan");
  assert.equal(got.asOf, fresh.assembledAt, "reports which snapshot the plan came from");
});

// --- dashboard card ---

test("dashboard renders the week-ahead card escaped, scripts stay valid", () => {
  const s = emptyState("2026-06-08", new Date().toISOString());
  const nastyPlan: PlannedSession[] = [
    { date: "2026-06-09", sport: "Ride", title: `O'Brien </script><b>x</b> ride` },
    { date: "2026-06-09", sport: "Strength", title: "Gym" },
  ];
  const w = assessWeek(nastyPlan, mkForecast([mkDay("2026-06-08"), mkDay("2026-06-09")]), { ...OPTS, planAsOf: "2026-06-08T06:00:00Z" });
  const html = renderDashboard({ window: [s], decisions: [], weather: w });
  assert.match(html, /Week ahead — plan vs weather/);
  assert.match(html, new RegExp(weekday("2026-06-09")));
  assert.match(html, /Plan as of/);
  assert.match(html, />indoor</, "gym session renders with the muted indoor badge");
  assert.ok(!html.includes("</script><b>x</b>"), "session title is escaped");
  assert.ok(!html.includes("NaN") && !html.includes("undefined"));
  for (const [i, sc] of [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].entries()) {
    assert.doesNotThrow(() => new Function(sc[1]), `script block ${i} must parse`);
  }
});

test("dashboard omits the card cleanly when no forecast is available", () => {
  const s = emptyState("2026-06-08", new Date().toISOString());
  const html = renderDashboard({ window: [s], decisions: [] });
  assert.ok(!html.includes("Week ahead — plan vs weather"));
});
