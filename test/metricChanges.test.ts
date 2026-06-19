import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, type AthleteState, type DisciplineThresholds, type Source } from "../src/state/types.js";
import { detectMetricChanges } from "../src/coach/metricChanges.js";

/**
 * detectMetricChanges synthesises a "what changed" feed by diffing the daily snapshot window — neither AI
 * Endurance nor Garmin exposes a change/notification stream, so this is how the dashboard surfaces an
 * auto-detected FTP / threshold / VO₂max update for the athlete to agree or disagree with.
 */

const day = (d: number) => `2026-06-${String(d).padStart(2, "0")}`;
const NOW = Date.parse("2026-06-15T12:00:00Z");

function st(date: string, thresholds: DisciplineThresholds | null, src: Source = "garmin", vo2?: number): AthleteState {
  const s = emptyState(date, `${date}T06:00:00Z`);
  if (thresholds) s.thresholds = { value: thresholds, source: src };
  if (vo2 != null) s.vo2max = { value: vo2, source: src };
  return s;
}

test("detectMetricChanges: surfaces the latest FTP change with from→to, source and date", () => {
  const window = [
    st(day(10), { bikeFtpW: 250 }),
    st(day(11), { bikeFtpW: 250 }),
    st(day(13), { bikeFtpW: 262 }), // changed here
    st(day(14), { bikeFtpW: 262 }),
  ];
  const got = detectMetricChanges(window, { now: NOW });
  assert.equal(got.length, 1);
  assert.deepEqual(
    { key: got[0].key, from: got[0].from, to: got[0].to, source: got[0].source, date: got[0].date },
    { key: "change:bikeFtpW:262", from: "250 W", to: "262 W", source: "garmin", date: day(13) },
  );
});

test("detectMetricChanges: formats pace / CSS / VO₂max and tracks multiple metrics", () => {
  const window = [
    st(day(12), { runThresholdPaceSecPerKm: 255, swimCssSecPer100: 95 }, "ai-endurance", 53),
    st(day(14), { runThresholdPaceSecPerKm: 248, swimCssSecPer100: 92 }, "ai-endurance", 55),
  ];
  const got = detectMetricChanges(window, { now: NOW });
  const by = new Map(got.map((c) => [c.metric, c]));
  assert.equal(by.get("runThresholdPaceSecPerKm")!.to, "4:08/km");
  assert.equal(by.get("swimCssSecPer100")!.to, "1:32/100m");
  assert.equal(by.get("vo2max")!.from, "53");
  assert.equal(by.get("vo2max")!.to, "55");
  assert.ok(got.every((c) => c.source === "ai-endurance"));
});

test("detectMetricChanges: no change, single reading, and stale changes are all silent", () => {
  assert.deepEqual(detectMetricChanges([st(day(12), { bikeFtpW: 250 }), st(day(14), { bikeFtpW: 250 })], { now: NOW }), []);
  assert.deepEqual(detectMetricChanges([st(day(14), { bikeFtpW: 250 })], { now: NOW }), []); // only one reading
  // A change older than the window cap doesn't nag forever.
  const old = [st("2026-04-01", { bikeFtpW: 250 }), st("2026-04-03", { bikeFtpW: 262 })];
  assert.deepEqual(detectMetricChanges(old, { now: NOW, maxAgeDays: 30 }), []);
});

test("detectMetricChanges: a null gap between readings doesn't read as a change", () => {
  const window = [
    st(day(11), { bikeFtpW: 250 }),
    st(day(12), null), // Garmin down that day → null
    st(day(14), { bikeFtpW: 250 }),
  ];
  assert.deepEqual(detectMetricChanges(window, { now: NOW }), []);
});
