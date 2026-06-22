import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson, garminInner, mapGarminThresholds, mapGarminIdentity, mapRecovery, normalizeDob, normalizeHeightCm } from "../src/state/assemble.js";
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
  // Garmin's OWN reading is still recorded for the side-by-side, even though AIE's value wins.
  assert.equal(s.thresholdsBySource?.garmin?.bikeFtpW, 250);
});

test("mapGarminThresholds records Garmin's per-source reading and max HR from the user profile", () => {
  const s = emptyState("2026-06-14", "2026-06-14T06:00:00Z");
  mapGarminThresholds(
    s,
    { functional_threshold_power_watts: 250, sport: "CYCLING" },
    { lactate_threshold_heart_rate_bpm: 165, weight_kg: 70 },
    { userData: { maxHr: 190 } }, // python-garminconnect nests it under userData
  );
  assert.equal(s.thresholds.value!.maxHr, 190, "max HR flows into the active thresholds");
  assert.deepEqual(s.thresholdsBySource?.garmin, { bikeFtpW: 250, runThresholdHr: 165, maxHr: 190 }, "the un-merged Garmin reading (no derived w/kg, no UI note)");
});

test("mapRecovery populates the load slot (CTL/ATL/TSB) so the season-arc trend has data to read", () => {
  const s = emptyState("2026-06-14", "2026-06-14T06:00:00Z");
  // 14+ days of ESS is the loadModel() floor; date.length must equal external_stress_score.length.
  const date = Array.from({ length: 16 }, (_, i) => `2026-05-${String(i + 20).padStart(2, "0")}`);
  const external_stress_score = date.map((_, i) => 40 + (i % 5) * 8); // varied daily load
  mapRecovery(s, { data: { date, external_stress_score, rMSSD: [42], resting_heart_rate: [50], recovery: [70] } });
  assert.equal(s.load.source, "ai-endurance");
  assert.equal(typeof s.load.value?.ctl, "number", "CTL is populated (was always null before the wire-up)");
  assert.equal(typeof s.load.value?.atl, "number");
  assert.equal(typeof s.load.value?.tsb, "number");
  assert.equal(s.load.value!.tsb, +(s.load.value!.ctl! - s.load.value!.atl!).toFixed(1), "TSB = CTL − ATL");

  // Too-short ESS series → loadModel returns null → the slot is left absent (no fabricated load).
  const s2 = emptyState("2026-06-14", "2026-06-14T06:00:00Z");
  mapRecovery(s2, { data: { date: ["2026-06-01", "2026-06-02"], external_stress_score: [50, 55] } });
  assert.equal(s2.load.value, null, "below the 14-day floor, load stays absent");
});

// --- Garmin stable identity (get_user_profile → DOB + height) ----------------

test("normalizeDob accepts YYYY-MM-DD (and datetime variants), rejects junk / out-of-range years", () => {
  assert.equal(normalizeDob("1985-07-02"), "1985-07-02");
  assert.equal(normalizeDob("1985-07-02T00:00:00.0"), "1985-07-02"); // strips the time component
  assert.equal(normalizeDob(""), undefined);
  assert.equal(normalizeDob("02/07/1985"), undefined); // not ISO
  assert.equal(normalizeDob("1850-01-01"), undefined); // implausible year
  assert.equal(normalizeDob("1985-13-40"), undefined); // out-of-range month/day
  assert.equal(normalizeDob(19850702 as unknown), undefined); // non-string
});

test("normalizeHeightCm passes cm through, lifts metres, and bounds to a plausible human range", () => {
  assert.equal(normalizeHeightCm(178), 178); // cm as Garmin reports it
  assert.equal(normalizeHeightCm("184.4"), 184); // numeric string, rounded
  assert.equal(normalizeHeightCm(1.78), 178); // metres → cm
  assert.equal(normalizeHeightCm(0), undefined);
  assert.equal(normalizeHeightCm(40), undefined); // below the human floor
  assert.equal(normalizeHeightCm(500), undefined); // above the ceiling
  assert.equal(normalizeHeightCm(undefined), undefined);
});

test("mapGarminIdentity reads DOB + height from userData and keeps the AIE-sourced name/age/sex", () => {
  const s = emptyState("2026-06-14", "2026-06-14T06:00:00Z");
  s.athleteProfile = { value: { name: "Sam Tri", age: 41, sex: "male" }, source: "ai-endurance" };
  mapGarminIdentity(s, { userData: { birthDate: "1985-03-09", height: 182, weight: 74000 } });
  const v = s.athleteProfile.value!;
  assert.equal(v.name, "Sam Tri"); // AIE identity preserved
  assert.equal(v.age, 41);
  assert.equal(v.sex, "male");
  assert.equal(v.dateOfBirth, "1985-03-09"); // from Garmin
  assert.equal(v.heightCm, 182); // from Garmin
  assert.equal((v as Record<string, unknown>).weight, undefined, "weight is NEVER taken (it's a live number)");
  assert.equal((v as Record<string, unknown>).weightKg, undefined);
  assert.equal(s.athleteProfile.source, "garmin");
});

test("mapGarminIdentity reads top-level keys too and degrades when Garmin exposes neither", () => {
  const s = emptyState("2026-06-14", "2026-06-14T06:00:00Z");
  // No userData wrapper — probe the flat shape.
  mapGarminIdentity(s, { birthDate: "1990-12-01" });
  assert.equal(s.athleteProfile.value?.dateOfBirth, "1990-12-01");
  assert.equal(s.athleteProfile.value?.heightCm, undefined);

  // Nothing usable → the slot is left exactly as it was (absent here).
  const s2 = emptyState("2026-06-14", "2026-06-14T06:00:00Z");
  mapGarminIdentity(s2, { userData: { gender: "MALE" } });
  assert.equal(s2.athleteProfile.value, null);
  mapGarminIdentity(s2, null);
  assert.equal(s2.athleteProfile.value, null);
});
