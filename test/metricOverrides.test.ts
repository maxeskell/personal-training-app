import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, type AthleteState } from "../src/state/types.js";
import { applyMetricOverrides, type MetricOverrides } from "../src/state/metricOverrides.js";

/**
 * applyMetricOverrides is the "👎 disagree" effect: a conditional pin — while the platform still reports
 * the value you rejected (`when`), the coach uses yours (`use`) instead; once the platform moves off it,
 * the override lapses so the new value resurfaces. Pure (mutates the passed state).
 */

function state(ftp?: number, vo2?: number): AthleteState {
  const s = emptyState("2026-06-15", "2026-06-15T06:00:00Z");
  if (ftp != null) s.thresholds = { value: { bikeFtpW: ftp }, source: "garmin" };
  if (vo2 != null) s.vo2max = { value: vo2, source: "garmin" };
  return s;
}

test("applyMetricOverrides: substitutes your value while the platform still reports the rejected one", () => {
  const s = state(262);
  applyMetricOverrides(s, { bikeFtpW: { when: 262, use: 250, ts: "t" } });
  assert.equal(s.thresholds.value?.bikeFtpW, 250);
  assert.equal(s.thresholds.source, "manual");
  assert.ok(s.zones.value, "zones re-derived from the pinned threshold");
});

test("applyMetricOverrides: lapses when the platform has detected a NEW value (≠ the rejected one)", () => {
  const s = state(270); // platform moved on from the rejected 262
  applyMetricOverrides(s, { bikeFtpW: { when: 262, use: 250, ts: "t" } });
  assert.equal(s.thresholds.value?.bikeFtpW, 270, "the new auto value stands — not silently masked");
  assert.equal(s.thresholds.source, "garmin");
});

test("applyMetricOverrides: handles vo2max and is a no-op with no overrides", () => {
  const s = state(undefined, 55);
  applyMetricOverrides(s, { vo2max: { when: 55, use: 53, ts: "t" } });
  assert.equal(s.vo2max.value, 53);
  assert.equal(s.vo2max.source, "manual");

  const untouched = state(250, 55);
  const before = JSON.stringify(untouched);
  applyMetricOverrides(untouched, {} as MetricOverrides);
  assert.equal(JSON.stringify(untouched), before, "no overrides → state unchanged");
});
