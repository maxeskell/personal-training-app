import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { validateProfile, computeDoseCycle, assertNoLiveNumbers, type Profile } from "../src/profile/schema.js";
import { applyIntake, requiredFieldsMissing } from "../src/profile/setup.js";
import { renderProfileContext, formatProfileForTool } from "../src/profile/context.js";

/**
 * The athlete profile is a privacy-split, validated config: profile.example.yaml is committed and must
 * always validate; profile.local.yaml is gitignored (NOT read here — it's absent in CI). These tests
 * use the committed example plus inline fixtures (no personal data) to lock the contract: the schema
 * accepts rich real-world structures, the no-live-numbers guard catches misuse, and dose_cycle math
 * is correct.
 */

const exampleText = readFileSync(new URL("../profile.example.yaml", import.meta.url), "utf8");

test("the committed profile.example.yaml validates against the schema", () => {
  const parsed = parseYaml(exampleText);
  assert.doesNotThrow(() => validateProfile(parsed));
});

// A richly-filled profile (generic, no PII) — nested equipment/fit numbers that must NOT trip the
// live-number guard, a medication cycle, and a races list.
const RICH: unknown = {
  schema_version: 1,
  identity: { name: "Test Athlete", sex: "female", date_of_birth: "1990-01-15", units: "metric", timezone: "Europe/London" },
  biomechanics: {
    leg_length_difference: { present: true, shorter_side: "right", run_correction_mm: 6, run_correction_status: "in_use" },
    mobility: { hip_flexion_deg: { right: 85, left: 80 }, internal_rotation_deg: { right: 7, left: 15 } },
    cleat: { cue: "pull left ankle in" },
  },
  health: {
    strength_sessions_per_week: "2-3",
    medication: { name: "example-drug", dose_day: "sunday", gi_trough_days: ["tuesday", "wednesday", "thursday"], implications: ["fuel to train"] },
  },
  availability: { weekly_hours: "11-12", weekday_minutes_per_day: 90, rest_day: "monday", fixed_sessions: { sunday: "long ride" } },
  equipment: { bikes: { road: { crank_length_mm: 172.5 }, tt: { crank_length_mm: 165, bar_width_cm: 38 } } },
  bike_fit: { fits: [{ saddle_height_mm: 765, crank_mm: 172.5, body: { height_cm: 179, foot_length_mm: { left: 269, right: 267 } } }] },
  fuelling: { carb_target_g_per_hour: { long: 80, sprint: 0 }, caffeine: "race-day lever" },
  races: [{ name: "Test Olympic", priority: "A", date: "2026-07-11", distance: "olympic", target_time: "sub 2:00" }],
  ai_endurance_todo: { swim_css: "not_set", ftp_w: "unresolved" },
};

test("a richly-filled profile validates; the guard ignores equipment/fit numbers and string TODOs", () => {
  assert.doesNotThrow(() => validateProfile(RICH));
});

test("computeDoseCycle derives days_since_dose and in_gi_trough from the weekday", () => {
  const p = validateProfile(RICH);
  // dose_day = sunday (idx 0); gi_trough = tue/wed/thu.
  assert.deepEqual(computeDoseCycle(p, "2026-06-14"), { dose_day: "sunday", days_since_dose: 0, in_gi_trough: false, gi_trough_days: ["tuesday", "wednesday", "thursday"] }); // Sunday
  assert.equal(computeDoseCycle(p, "2026-06-16")?.days_since_dose, 2); // Tuesday
  assert.equal(computeDoseCycle(p, "2026-06-16")?.in_gi_trough, true); // Tuesday is in the trough
  assert.equal(computeDoseCycle(p, "2026-06-17")?.days_since_dose, 3); // Wednesday
  assert.equal(computeDoseCycle(p, "2026-06-17")?.in_gi_trough, true); // Wednesday is in the trough
});

test("computeDoseCycle is null when no medication.dose_day is set", () => {
  const p = validateProfile({ schema_version: 1, identity: {} });
  assert.equal(computeDoseCycle(p, "2026-06-17"), null);
});

test("assertNoLiveNumbers throws when a live performance number is planted anywhere", () => {
  assert.throws(() => assertNoLiveNumbers({ equipment: { bikes: { road: { ftp_w: 250 } } } }), /live performance number/i);
  assert.throws(() => assertNoLiveNumbers({ identity: { swim_css: 95 } }), /live performance number/i);
  assert.throws(() => validateProfile({ schema_version: 1, identity: {}, health: { resting_hr: 48 } }), /live performance number/i);
  // String status values for the same keys are fine (that's what ai_endurance_todo holds).
  assert.doesNotThrow(() => assertNoLiveNumbers({ ai_endurance_todo: { ftp_w: "unresolved", swim_css: "not_set" } }));
});

test("requiredFieldsMissing flags the blank example and clears on a filled profile", () => {
  const blank = validateProfile(parseYaml(exampleText));
  const missing = requiredFieldsMissing(blank);
  assert.ok(missing.includes("identity.name"));
  assert.ok(missing.includes("availability.weekly_hours"));
  assert.ok(missing.some((m) => m.startsWith("races")));
  assert.deepEqual(requiredFieldsMissing(validateProfile(RICH)), []);
});

test("applyIntake fills identity, weekly_hours and the first race onto the example base", () => {
  const base = parseYaml(exampleText) as Profile;
  const next = applyIntake(base, {
    name: "Jo Runner",
    sex: "other",
    date_of_birth: "1988-03-03",
    units: "metric",
    timezone: "Europe/London",
    weekly_hours: "8-10",
    race: { name: "Autumn 10k", date: "2026-10-01", priority: "B", distance: "other", target_time: "sub 40" },
  });
  assert.equal(next.identity?.name, "Jo Runner");
  assert.equal((next.availability as Record<string, unknown>).weekly_hours, "8-10");
  assert.equal(next.races?.[0]?.name, "Autumn 10k");
  assert.deepEqual(requiredFieldsMissing(next), []); // a complete intake leaves nothing required missing
  assert.doesNotThrow(() => validateProfile(next));
});

test("renderProfileContext surfaces the dose-cycle and never leaks a live number; empty when blank", () => {
  const block = renderProfileContext(validateProfile(RICH), "2026-06-17");
  assert.match(block, /ATHLETE PROFILE/);
  assert.match(block, /GI trough/i);
  assert.match(block, /Race targets/);
  assert.doesNotMatch(block, /\bftp\b/i); // no live numbers leak into the prompt block
  // A profile with nothing meaningful renders to an empty string (clean omission).
  assert.equal(renderProfileContext(validateProfile({ schema_version: 1, identity: {} }), "2026-06-17"), "");
});

test("formatProfileForTool reports the dose_cycle and the source path", () => {
  const out = formatProfileForTool({ profile: validateProfile(RICH), path: "/tmp/profile.local.yaml", source: "local" }, "2026-06-17");
  assert.match(out, /dose_cycle/);
  assert.match(out, /in_gi_trough=true/);
  assert.match(out, /source: local/);
});
