import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  athleteToIntake,
  goalsToRaces,
  estimateWeeklyHours,
  formatTargetTime,
  configToIntake,
  buildPrefilledIntake,
} from "../src/profile/bootstrap.js";
import { applyIntake } from "../src/profile/setup.js";
import { validateProfile, type Profile } from "../src/profile/schema.js";
import { emptyState, type AthleteState, type ActualActivity } from "../src/state/types.js";
import type { Goal } from "../src/coach/seasonContext.js";
import type { Config } from "../src/config.js";

/**
 * The profile-bootstrap mappers are PURE — they take an already-assembled AthleteState / goals /
 * config / today and return plain intake data, so they're tested here on fixtures with NO network.
 * (The live `buildTodayState()` and the manual-fallback degrade path live in setup.ts and aren't
 * exercised here — they need a connected account; what's locked here is the mapping contract.)
 */

const TODAY = "2026-06-18";
const exampleText = readFileSync(new URL("../profile.example.yaml", import.meta.url), "utf8");
const base = (): Profile => parseYaml(exampleText) as Profile;

function stateWith(over: Partial<AthleteState>): AthleteState {
  return { ...emptyState(TODAY, `${TODAY}T08:00:00Z`), ...over };
}

// --- athleteToIntake --------------------------------------------------------

test("athleteToIntake maps name + normalised sex from getUser", () => {
  const s = stateWith({ athleteProfile: { value: { name: "Jo Runner", sex: "female", age: 34 }, source: "ai-endurance" } });
  assert.deepEqual(athleteToIntake(s), { name: "Jo Runner", sex: "female" });
});

test("athleteToIntake omits an unmappable sex and absent name", () => {
  const s = stateWith({ athleteProfile: { value: { sex: "unspecified" }, source: "ai-endurance" } });
  assert.deepEqual(athleteToIntake(s), {});
});

test("athleteToIntake returns {} when the platform exposed no identity", () => {
  assert.deepEqual(athleteToIntake(stateWith({})), {});
});

// --- formatTargetTime -------------------------------------------------------

test("formatTargetTime renders sub H:MM:SS and sub MM:SS, empty for missing", () => {
  assert.equal(formatTargetTime(7200), "sub 2:00:00");
  assert.equal(formatTargetTime(7384), "sub 2:03:04");
  assert.equal(formatTargetTime(1800), "sub 30:00");
  assert.equal(formatTargetTime(0), "");
  assert.equal(formatTargetTime(undefined), "");
  assert.equal(formatTargetTime(-10), "");
});

// --- goalsToRaces -----------------------------------------------------------

const GOALS: Goal[] = [
  // a past goal — must be dropped
  { event_name: "Spring Sprint Tri", event_type: "triathlon sprint", event_date: "2026-03-01", priority: "B" },
  // far-future A race with a target time
  { event_name: "Autumn 70.3", event_type: "triathlon 70.3", event_date: "2026-09-20", priority: "A", target_completion_time_in_seconds: 18000 },
  // nearer B race, numeric priority, a run
  { event_name: "City Marathon", event_type: "run marathon", event_date: "2026-07-05", priority: 2, target_completion_time_in_seconds: 12600 },
];

test("goalsToRaces drops past goals, sorts soonest-first, maps priority/distance/target", () => {
  const races = goalsToRaces(GOALS, TODAY);
  assert.equal(races.length, 2); // the past Spring Sprint is dropped
  assert.equal(races[0].name, "City Marathon"); // soonest first
  assert.equal(races[0].priority, "B"); // numeric 2 → B
  assert.equal(races[0].distance, "other"); // a marathon isn't a tri-distance enum value
  assert.equal(races[0].target_time, "sub 3:30:00");
  assert.equal(races[1].name, "Autumn 70.3");
  assert.equal(races[1].priority, "A");
  assert.equal(races[1].distance, "70.3");
  assert.equal(races[1].target_time, "sub 5:00:00");
});

test("goalsToRaces output validates via validateProfile when applied to the example base", () => {
  const races = goalsToRaces(GOALS, TODAY);
  const next = applyIntake(base(), {
    name: "Test",
    sex: "male",
    date_of_birth: "1990-01-01",
    units: "metric",
    timezone: "Europe/London",
    weekly_hours: "8-9",
    race: {
      name: races[0].name ?? undefined,
      date: races[0].date ?? undefined,
      priority: races[0].priority ?? undefined,
      distance: races[0].distance ?? undefined,
      target_time: races[0].target_time ?? undefined,
    },
    extraRaces: races.slice(1).map((r) => ({
      name: r.name ?? undefined,
      date: r.date ?? undefined,
      priority: r.priority ?? undefined,
      distance: r.distance ?? undefined,
      target_time: r.target_time ?? undefined,
    })),
  });
  assert.equal(next.races?.length, 2);
  assert.doesNotThrow(() => validateProfile(next));
});

test("goalsToRaces returns [] when there are no future goals", () => {
  assert.deepEqual(goalsToRaces([{ event_name: "Old", event_date: "2020-01-01" }], TODAY), []);
  assert.deepEqual(goalsToRaces([], TODAY), []);
});

// --- estimateWeeklyHours ----------------------------------------------------

const act = (date: string, durationMin: number): ActualActivity => ({ date, sport: "Run", durationMin });

test("estimateWeeklyHours returns null on empty / sub-one-week data", () => {
  assert.equal(estimateWeeklyHours([], TODAY), null);
  assert.equal(estimateWeeklyHours(null, TODAY), null);
  // Only the current (partial) week → dropped → no full week → null.
  assert.equal(estimateWeeklyHours([act("2026-06-17", 60), act("2026-06-18", 60)], TODAY), null);
});

test("estimateWeeklyHours estimates a sane band from multiple full weeks (MODEL), dropping this week", () => {
  // Three full prior weeks at ~10h each (600min), plus a partial current week that must be ignored.
  const activities: ActualActivity[] = [
    // week of 2026-05-25..31: 600 min
    act("2026-05-25", 300), act("2026-05-27", 300),
    // week of 2026-06-01..07: 660 min
    act("2026-06-02", 360), act("2026-06-05", 300),
    // week of 2026-06-08..14: 600 min
    act("2026-06-09", 300), act("2026-06-12", 300),
    // current partial week (2026-06-15..) — ignored
    act("2026-06-17", 200),
  ];
  const est = estimateWeeklyHours(activities, TODAY);
  assert.ok(est, "expected an estimate");
  assert.equal(est!.weeks, 3); // three full weeks counted, partial week dropped
  // Median full week ≈ 10h → band "10-11".
  assert.equal(est!.band, "10-11");
});

test("estimateWeeklyHours ignores activity weeks older than ~8 weeks back", () => {
  const activities: ActualActivity[] = [act("2026-01-05", 600), act("2026-01-12", 600)];
  assert.equal(estimateWeeklyHours(activities, TODAY), null);
});

// --- configToIntake ---------------------------------------------------------

test("configToIntake maps free-text COACH_UNITS to the enum + carries timezone", () => {
  const cfg = { athlete: { units: "imperial, US", timezone: "America/Denver" } } as unknown as Config;
  assert.deepEqual(configToIntake(cfg), { units: "imperial", timezone: "America/Denver" });
  const cfg2 = { athlete: { units: "metric, UK", timezone: "Europe/London" } } as unknown as Config;
  assert.deepEqual(configToIntake(cfg2), { units: "metric", timezone: "Europe/London" });
});

// --- buildPrefilledIntake ---------------------------------------------------

test("buildPrefilledIntake assembles intake + summary, always leaving DOB to ask", () => {
  const s = stateWith({
    athleteProfile: { value: { name: "Sam Tri", sex: "male", age: 41 }, source: "ai-endurance" },
    actualActivities: {
      value: [
        act("2026-05-25", 300), act("2026-05-27", 300),
        act("2026-06-01", 360), act("2026-06-04", 300),
        act("2026-06-08", 300), act("2026-06-11", 300),
      ],
      source: "ai-endurance",
    },
  });
  const cfg = { athlete: { units: "metric, UK", timezone: "Europe/London" } } as unknown as Config;
  const out = buildPrefilledIntake(s, GOALS, cfg, TODAY);

  assert.equal(out.intake.name, "Sam Tri");
  assert.equal(out.intake.sex, "male");
  assert.equal(out.intake.date_of_birth, undefined); // always asked
  assert.equal(out.intake.units, "metric");
  assert.equal(out.intake.timezone, "Europe/London");
  assert.ok(out.intake.weekly_hours, "weekly hours estimated");
  assert.equal(out.intake.race?.name, "City Marathon"); // soonest future race
  assert.equal(out.races.length, 2);
  assert.deepEqual(out.summary.fromAie, ["name", "sex"]);
  assert.equal(out.summary.raceCount, 2);
  assert.deepEqual(out.summary.fromConfig, ["units", "timezone"]);
  assert.equal(out.summary.ageHint, 41);
  assert.ok(out.summary.weeklyEstimate);

  // The assembled, applied intake must validate.
  const next = applyIntake(base(), out.intake);
  assert.doesNotThrow(() => validateProfile(next));
  assert.equal(next.races?.length, 2);
});

test("buildPrefilledIntake degrades fields cleanly when integrations expose little", () => {
  const cfg = { athlete: { units: "", timezone: "" } } as unknown as Config;
  const out = buildPrefilledIntake(stateWith({}), [], cfg, TODAY);
  assert.deepEqual(out.summary.fromAie, []);
  assert.equal(out.summary.raceCount, 0);
  assert.deepEqual(out.summary.fromConfig, []);
  assert.equal(out.summary.weeklyEstimate, null); // no data → ask
  assert.equal(out.summary.ageHint, null);
  assert.equal(out.intake.weekly_hours, undefined);
  assert.equal(out.intake.race, undefined);
});
