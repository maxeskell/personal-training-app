import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateProfile, computeDoseCycle, assertNoLiveNumbers, type Profile } from "../src/profile/schema.js";
import { applyIntake, requiredFieldsMissing } from "../src/profile/setup.js";
import { renderProfileContext, formatProfileForTool } from "../src/profile/context.js";
import { loadProfile, loadProfileSafe } from "../src/profile/load.js";
import { config } from "../src/config.js";

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

test("the live-number guard catches synonyms and numeric strings, but not substring look-alikes", () => {
  // Synonyms the old narrow regex missed are now caught when numeric.
  for (const planted of [
    { health: { lthr: 162 } },
    { health: { max_hr: 188 } },
    { equipment: { threshold_w: 240 } },
    { health: { functional_threshold: 250 } },
    { health: { w_per_kg: 4.2 } },
    { health: { vo2max: 58 } },
  ]) {
    assert.throws(() => assertNoLiveNumbers(planted), /live performance number/i, JSON.stringify(planted));
  }
  // A live number snuck in as a numeric STRING is caught too; a genuine status string is not.
  assert.throws(() => assertNoLiveNumbers({ ai_endurance_todo: { ftp_w: "223" } }), /live performance number/i);
  assert.doesNotThrow(() => assertNoLiveNumbers({ ai_endurance_todo: { ftp_w: "set in AIE" } }));
  // Whole-segment matching: equipment/fit keys that merely CONTAIN a metric substring must pass.
  assert.doesNotThrow(() => assertNoLiveNumbers({ equipment: { lightweight_wheels: 1, wheel_weight_g: 1400 } }));
  assert.doesNotThrow(() => assertNoLiveNumbers({ availability: { space_minutes: 5 } }));
  assert.doesNotThrow(() => assertNoLiveNumbers({ biomechanics: { paceline_position: 2 } }));
});

test("identity.height_cm (stable anthropometry) validates as a number — but a planted weight still throws", () => {
  // Height is stable body data the profile is allowed to hold: a numeric identity.height_cm passes both
  // the schema and the no-live-numbers guard.
  const withHeight = { schema_version: 1, identity: { name: "Tall Test", height_cm: 184 } };
  assert.doesNotThrow(() => validateProfile(withHeight));
  assert.equal(validateProfile(withHeight).identity?.height_cm, 184);
  assert.doesNotThrow(() => assertNoLiveNumbers(withHeight));
  // Weight, by contrast, IS a live number — a numeric weight in identity must still trip the guard.
  assert.throws(() => validateProfile({ schema_version: 1, identity: { height_cm: 184, weight_kg: 72 } }), /live performance number/i);
  assert.throws(() => assertNoLiveNumbers({ identity: { weight: 72 } }), /live performance number/i);
  // A non-positive height is rejected by the schema (positive constraint).
  assert.throws(() => validateProfile({ schema_version: 1, identity: { height_cm: 0 } }));
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

test("the loader degrades (safe→null) and fails loud (clear message, no stack trace) on bad profiles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coach-profile-"));
  const saved = config.profilePath;
  try {
    // Malformed YAML: ambient load degrades to null; the loud loader explains the parse failure.
    const badYaml = join(dir, "bad.yaml");
    await writeFile(badYaml, 'identity: {name: "x"\n  bad: : :\n\t- broken');
    (config as { profilePath?: string }).profilePath = badYaml;
    assert.equal(await loadProfileSafe(), null, "malformed YAML → loadProfileSafe is null");
    await assert.rejects(loadProfile(), /could not parse .* as yaml/i, "malformed YAML → loud parse error");

    // Schema-invalid (bad enum): same split — null for ambient, loud for the explicit tool surface.
    const invalid = join(dir, "invalid.yaml");
    await writeFile(invalid, "schema_version: 1\nidentity:\n  sex: helicopter\n");
    (config as { profilePath?: string }).profilePath = invalid;
    assert.equal(await loadProfileSafe(), null, "schema-invalid → loadProfileSafe is null");
    await assert.rejects(loadProfile(), /failed validation/i, "schema-invalid → loud validation error");

    // The loud error is a clean message, not a raw stack trace leaking to the user.
    const err = await loadProfile().catch((e) => e as Error);
    assert.ok(err instanceof Error, "throws an Error");
    assert.doesNotMatch(err.message, /\n\s+at\s/, "no stack frames in the message");
  } finally {
    (config as { profilePath?: string }).profilePath = saved;
    await rm(dir, { recursive: true, force: true });
  }
});
