import { test } from "node:test";
import assert from "node:assert/strict";
import { garminFreshnessCheck, GARMIN_STALE_WARN_DAYS } from "../src/health.js";

/**
 * `garminFreshnessCheck` is the early-warning that a silent Garmin outage went unnoticed — the exact hole
 * that hid a 4-week degrade behind a green token-age line. It's pure (newest archived daily date + now →
 * Check), so it's unit-tested directly here. Fresh-setup and disabled states must NOT read as faults.
 */

const now = new Date("2026-08-13T09:00:00Z");

test("disabled Garmin yields no check (nothing to watch)", () => {
  assert.equal(garminFreshnessCheck("2026-01-01", now, false), null);
});

test("no archived daily data yet is info, not a warning (fresh setup)", () => {
  const c = garminFreshnessCheck(null, now, true);
  assert.equal(c?.status, "info");
});

test("data within the stale window is ok", () => {
  // 2 days old, under the 3-day warn threshold.
  const c = garminFreshnessCheck("2026-08-11", now, true);
  assert.equal(c?.status, "ok");
});

test("data staler than the warn window flags a warning", () => {
  // The real incident: newest daily 2026-07-17, ~27 days before now.
  const c = garminFreshnessCheck("2026-07-17", now, true);
  assert.equal(c?.status, "warn");
  assert.match(c!.detail, /stalled/);
  assert.match(c!.detail, /2026-07-17/);
});

test("the boundary is exclusive — exactly staleWarnDays old is still ok", () => {
  // Midnight `now` so the age is exactly 3.0 days (the freshness fn anchors dates at T00:00:00Z).
  const midnight = new Date("2026-08-13T00:00:00Z");
  const c = garminFreshnessCheck("2026-08-10", midnight, true, 3); // exactly 3.0 days → not > 3
  assert.equal(c?.status, "ok");
  assert.ok(GARMIN_STALE_WARN_DAYS >= 1);
});
