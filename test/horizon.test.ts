import { test } from "node:test";
import assert from "node:assert/strict";
import { withinPhysioHorizon, daysBetweenUTC, PHYSIO_HORIZON_DAYS } from "../src/insights/horizon.js";

/**
 * The physio horizon floors the insight feed to the last six months (relative to the most recent reading,
 * not the wall clock), so no warning/trend leans on stale data — while a stale-but-backfilled series still
 * yields its active cluster rather than going empty.
 */

test("PHYSIO_HORIZON_DAYS is six months", () => {
  assert.equal(PHYSIO_HORIZON_DAYS, 180);
});

test("daysBetweenUTC is date-only and order-signed", () => {
  assert.equal(daysBetweenUTC("2026-01-01", "2026-01-08"), 7);
  assert.equal(daysBetweenUTC("2026-01-08", "2026-01-01"), -7);
  assert.equal(daysBetweenUTC("2016-03-31T07:38:00Z", "2026-03-31"), 3652); // ~10 years (2 leap days), time-of-day ignored
});

test("withinPhysioHorizon keeps the last 6 months relative to the latest reading", () => {
  const days = [
    { date: "2016-03-31", weightKg: 8.3 }, // decade-old glitch → dropped
    { date: "2026-01-01", weightKg: 72 },
    { date: "2026-03-31", weightKg: 72.4 }, // latest
  ];
  const kept = withinPhysioHorizon(days);
  assert.deepEqual(kept.map((d) => d.date), ["2026-01-01", "2026-03-31"]);
});

test("withinPhysioHorizon drops a reading just over the horizon, keeps one just inside", () => {
  const latest = "2026-06-30";
  const days = [
    { date: "2025-12-31" }, // 181 days before → dropped (>180)
    { date: "2026-01-01" }, // 180 days before → kept (== horizon)
    { date: latest },
  ];
  assert.deepEqual(withinPhysioHorizon(days).map((d) => d.date), ["2026-01-01", latest]);
});

test("withinPhysioHorizon is a no-op for 0/1 readings and never empties a series", () => {
  assert.deepEqual(withinPhysioHorizon([]), []);
  assert.deepEqual(withinPhysioHorizon([{ date: "2016-03-31" }]).map((d) => d.date), ["2016-03-31"]);
});
