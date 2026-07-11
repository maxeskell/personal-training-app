import { test } from "node:test";
import assert from "node:assert/strict";
import { excludeFutureDated, maxPlausibleDate } from "../src/coach/raceResults.js";

/**
 * Guard against the 2106 bug: two TrainingPeaks-era files carried corrupt FIT timestamps decoding to
 * 2106-02-26, and because windowed bests only bound the past (`date >= start`), a future date sat inside
 * every "Last 90 days"/"Season" window forever (a fake longest-ride and 30s/60s power-curve entries).
 * The career build must drop implausibly future-dated activities from both inlets (TP CSV rows and
 * parsed activity files) while keeping today's and yesterday's — race day is always "today".
 */

test("excludeFutureDated drops corrupt future dates, keeps past/today/skew/undated", () => {
  const now = new Date("2026-07-11T12:00:00Z");
  const items = [
    { date: "2011-03-01", id: "past" },
    { date: "2026-07-11", id: "today-race-day" },
    { date: "2026-07-12", id: "tomorrow-clock-skew" },
    { date: "2026-08-15", id: "next-month" },
    { date: "2106-02-26", id: "corrupt-fit-epoch" },
    { date: "", id: "undated" },
  ];
  assert.deepEqual(
    excludeFutureDated(items, now).map((i) => i.id),
    ["past", "today-race-day", "tomorrow-clock-skew", "undated"],
  );
});

test("excludeFutureDated leaves an all-plausible list untouched", () => {
  const now = new Date("2026-07-11T12:00:00Z");
  const items = [{ date: "2026-07-10" }, { date: "2026-07-11" }];
  assert.deepEqual(excludeFutureDated(items, now), items);
});

test("maxPlausibleDate is tomorrow (device clock-skew allowance)", () => {
  assert.equal(maxPlausibleDate(new Date("2026-07-11T12:00:00Z")), "2026-07-12");
  assert.equal(maxPlausibleDate(new Date("2026-12-31T23:00:00Z")), "2027-01-01");
});
