import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson, garminInner, mapGarminThresholds } from "../src/state/assemble.js";
import { emptyState } from "../src/state/types.js";

/**
 * assemble.ts unwraps AI Endurance / Garmin payloads into AthleteState — the real parsing-risk surface,
 * where a renamed upstream key or shape change degrades silently to null and passes typecheck + the rest
 * of the suite. These pin the MCP/Garmin envelope unwrapping and the Garmin-thresholds mapper (scales,
 * the ×10 speed under-report fix, and the keep-higher-FTP conflict path).
 */

test("extractJson unwraps structuredContent and JSON text content; passes plain values through", () => {
  assert.deepEqual(extractJson({ structuredContent: { a: 1 } }), { a: 1 });
  assert.deepEqual(extractJson({ content: [{ type: "text", text: '{"x":5}' }] }), { x: 5 });
  assert.equal(extractJson({ content: [{ type: "text", text: "not json" }] }), "not json"); // unparseable → raw text
  assert.equal(extractJson(42), 42);
});

test("garminInner unwraps the {result:'<json string>'} double-encoding, and degrades on misses", () => {
  // Garmin (Taxuspt) wraps as MCP content text = a JSON string of { result: "<inner json string>" }.
  const env = { content: [{ type: "text", text: JSON.stringify({ result: JSON.stringify({ weight: 70.5 }) }) }] };
  assert.deepEqual(garminInner(env), { weight: 70.5 });
  // A non-JSON inner (e.g. "No weight measurements found …") comes back as the raw string.
  const noData = { content: [{ type: "text", text: JSON.stringify({ result: "No weight measurements found" }) }] };
  assert.equal(garminInner(noData), "No weight measurements found");
  assert.equal(garminInner(null), null);
});

test("mapGarminThresholds maps FTP / LTHR / run-power + the ×10 speed under-report into thresholds + zones", () => {
  const s = emptyState("2026-06-14", "2026-06-14T06:00:00Z");
  mapGarminThresholds(
    s,
    { functional_threshold_power_watts: 250, sport: "CYCLING" },
    { lactate_threshold_heart_rate_bpm: 165, functional_threshold_power_watts: 300, sport: "RUNNING", lactate_threshold_speed_mps: 0.35, weight_kg: 70 },
  );
  const t = s.thresholds.value!;
  assert.equal(t.bikeFtpW, 250);
  assert.equal(t.bikeFtpWkg, 3.57); // 250 / 70
  assert.equal(t.runThresholdHr, 165);
  assert.equal(t.runThresholdPowerW, 300);
  assert.equal(t.runThresholdPaceSecPerKm, Math.round(1000 / 3.5)); // 0.35 m/s ×10 under-report fix → 3.5 m/s
  assert.equal(s.thresholds.source, "garmin");
  assert.ok(s.zones.value, "zones are derived from the mapped thresholds");
});

test("mapGarminThresholds keeps the higher test-based FTP and surfaces the conflict note", () => {
  const s = emptyState("2026-06-14", "2026-06-14T06:00:00Z");
  s.thresholds = { value: { bikeFtpW: 280 }, source: "ai-endurance" as never, note: "test-based" };
  mapGarminThresholds(s, { functional_threshold_power_watts: 250, sport: "CYCLING" }, { weight_kg: 70 });
  const t = s.thresholds.value!;
  assert.equal(t.bikeFtpW, 280, "the higher test-based value keeps driving zones");
  assert.match(t.bikeFtpNote ?? "", /keeping the higher test-based 280/);
});
