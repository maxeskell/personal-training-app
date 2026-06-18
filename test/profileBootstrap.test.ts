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
  fieldsStillNeeded,
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

test("athleteToIntake carries Garmin-supplied DOB + height (height stringified), ignoring an invalid DOB", () => {
  const s = stateWith({
    athleteProfile: { value: { name: "Sam Tri", sex: "male", age: 41, dateOfBirth: "1985-03-09", heightCm: 182 }, source: "garmin" },
  });
  assert.deepEqual(athleteToIntake(s), { name: "Sam Tri", sex: "male", date_of_birth: "1985-03-09", height: "182" });
  // A malformed DOB from the integration is dropped (stays asked); height still carries.
  const s2 = stateWith({ athleteProfile: { value: { dateOfBirth: "09/03/1985", heightCm: 179 }, source: "garmin" } });
  assert.deepEqual(athleteToIntake(s2), { height: "179" });
});

// --- fieldsStillNeeded -------------------------------------------------------

test("fieldsStillNeeded drops DOB once Garmin supplied it, and never lists optional height", () => {
  // A fully pre-filled intake (Garmin gave DOB) — nothing required is still missing.
  const full = {
    name: "Sam", sex: "male", date_of_birth: "1985-03-09", height: "182",
    units: "metric", timezone: "Europe/London", weekly_hours: "10-11",
    race: { name: "Autumn 70.3", date: "2026-09-20" },
  };
  assert.deepEqual(fieldsStillNeeded(full), []);
  // No Garmin DOB and no race → exactly those two are still needed (height never appears).
  const gappy = { name: "Sam", sex: "male", units: "metric", timezone: "Europe/London", weekly_hours: "10-11" };
  assert.deepEqual(fieldsStillNeeded(gappy), ["date_of_birth", "race"]);
  // A race with only a date counts as present (matches applyIntake's name-or-date filter).
  assert.ok(!fieldsStillNeeded({ ...gappy, date_of_birth: "1985-03-09", race: { date: "2026-09-20" } }).includes("race"));
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
  assert.equal(out.intake.date_of_birth, undefined); // no Garmin DOB → still asked
  assert.equal(out.intake.units, "metric");
  assert.equal(out.intake.timezone, "Europe/London");
  assert.ok(out.intake.weekly_hours, "weekly hours estimated");
  assert.equal(out.intake.race?.name, "City Marathon"); // soonest future race
  assert.equal(out.races.length, 2);
  assert.deepEqual(out.summary.fromAie, ["name", "sex"]);
  assert.equal(out.summary.raceCount, 2);
  assert.deepEqual(out.summary.fromConfig, ["units", "timezone"]);
  assert.deepEqual(out.summary.fromGarmin, []); // Garmin not present in this fixture
  assert.equal(out.summary.dobAutofilled, false);
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
  assert.deepEqual(out.summary.fromGarmin, []);
  assert.equal(out.summary.dobAutofilled, false);
  assert.equal(out.summary.weeklyEstimate, null); // no data → ask
  assert.equal(out.summary.ageHint, null);
  assert.equal(out.intake.weekly_hours, undefined);
  assert.equal(out.intake.race, undefined);
});

test("buildPrefilledIntake auto-fills DOB + height when Garmin supplied them, and writes height_cm as a number", () => {
  const s = stateWith({
    athleteProfile: { value: { name: "Sam Tri", sex: "male", age: 41, dateOfBirth: "1985-03-09", heightCm: 182 }, source: "garmin" },
  });
  const cfg = { athlete: { units: "metric, UK", timezone: "Europe/London" } } as unknown as Config;
  const out = buildPrefilledIntake(s, GOALS, cfg, TODAY);

  assert.equal(out.intake.date_of_birth, "1985-03-09"); // auto-filled, not asked
  assert.equal(out.intake.height, "182");
  assert.deepEqual(out.summary.fromGarmin, ["date of birth", "height"]);
  assert.equal(out.summary.dobAutofilled, true);

  // The applied intake validates and stores height as a NUMBER under identity.height_cm.
  const next = applyIntake(base(), out.intake);
  assert.equal(next.identity?.height_cm, 182);
  assert.equal(typeof next.identity?.height_cm, "number");
  assert.equal(next.identity?.date_of_birth, "1985-03-09");
  assert.doesNotThrow(() => validateProfile(next));
});

test("applyIntake parses a free-text height to a bounded integer and skips an implausible one", () => {
  const a = applyIntake(base(), { name: "T", sex: "male", date_of_birth: "1990-01-01", units: "metric", timezone: "Europe/London", weekly_hours: "8-9", race: { name: "R", date: "2026-09-01" }, height: "179.6 cm" });
  assert.equal(a.identity?.height_cm, 180); // stripped + rounded
  const b = applyIntake(base(), { height: "9000" });
  assert.equal(b.identity?.height_cm, null); // out of range → skipped (the example base's null is preserved, not junk)
});

test("applyIntake onto an EXISTING rich profile merges — preserves hand-entered blocks and race notes", () => {
  // Simulates `profile:init` re-run on an already-filled profile: the base is the user's real profile,
  // and the intake is a refresh from the integrations (identity + the same race, but without the note).
  const rich = {
    schema_version: 1,
    identity: { name: "Old Name", sex: "male", date_of_birth: "1981-10-28", units: "metric", timezone: "Europe/London" },
    biomechanics: { leg_length_difference: { present: true, shorter_side: "right" } },
    health: { medication: { name: "tirzepatide", dose_day: "sunday", gi_trough_days: ["tuesday", "wednesday", "thursday"] } },
    fuelling: { caffeine: "race-day only" },
    races: [{ name: "Birmingham Triathlon", priority: "A", date: "2026-07-11", distance: "olympic", target_time: "sub 2:00", note: "the one peak" }],
  } as unknown as Profile;

  const next = applyIntake(rich, {
    name: "New Name",
    weekly_hours: "11-12",
    race: { name: "Birmingham Triathlon", date: "2026-07-11", priority: "A", distance: "olympic", target_time: "sub 2:00" },
  });

  // Hand-entered blocks survive untouched (the bug: these used to be blanked by rebuilding from template).
  assert.equal((next.biomechanics as Record<string, any>)?.leg_length_difference?.present, true);
  assert.equal(next.health?.medication?.name, "tirzepatide");
  assert.equal((next.fuelling as Record<string, any>)?.caffeine, "race-day only");
  // Integration-sourced identity is refreshed.
  assert.equal(next.identity?.name, "New Name");
  // The hand-written race note is preserved across the refresh (matched by name/date).
  assert.equal(next.races?.[0].note, "the one peak");
  assert.doesNotThrow(() => validateProfile(next));
});
