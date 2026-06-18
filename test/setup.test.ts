import { test } from "node:test";
import assert from "node:assert/strict";
import { upsertEnv, answersToEnv } from "../src/setup.js";
import { helpText } from "../src/help.js";

test("upsertEnv: replaces an active line, replaces a commented template line, appends a new key", () => {
  const base = ["ANTHROPIC_API_KEY=", "# COACH_UNITS=metric, UK", "GARMIN_ENABLED=false"].join("\n");
  const out = upsertEnv(base, { ANTHROPIC_API_KEY: "sk-ant-xyz", COACH_UNITS: "imperial, US", COACH_WEATHER_LAT: "40.7" });
  assert.match(out, /^ANTHROPIC_API_KEY=sk-ant-xyz$/m);
  assert.match(out, /^COACH_UNITS=imperial, US$/m); // the commented template line was upgraded in place
  assert.ok(!out.includes("# COACH_UNITS="));
  assert.match(out, /^COACH_WEATHER_LAT=40\.7$/m); // appended
  assert.match(out, /^GARMIN_ENABLED=false$/m); // untouched
});

test("upsertEnv: an undefined value leaves that key alone", () => {
  const out = upsertEnv("ANTHROPIC_API_KEY=keep", { ANTHROPIC_API_KEY: undefined, COACH_UNITS: "metric, UK" });
  assert.match(out, /ANTHROPIC_API_KEY=keep/);
  assert.match(out, /COACH_UNITS=metric, UK/);
});

test("answersToEnv: maps answers and skips blanks", () => {
  const env = answersToEnv({ anthropicKey: "", units: "metric, UK", weatherEnabled: "false", garminEnabled: "true" });
  assert.equal(env.ANTHROPIC_API_KEY, undefined); // blank → skipped
  assert.equal(env.COACH_UNITS, "metric, UK");
  assert.equal(env.COACH_WEATHER_ENABLED, "false");
  assert.equal(env.GARMIN_ENABLED, "true");
});

test("helpText: surfaces the everyday commands + points at the full reference", () => {
  const t = helpText();
  for (const cmd of ["npm run setup", "npm start", "npm run demo", "npm run readiness", "npm run ask"]) {
    assert.ok(t.includes(cmd), `help should mention ${cmd}`);
  }
  assert.match(t, /docs\/commands\.md/);
});
