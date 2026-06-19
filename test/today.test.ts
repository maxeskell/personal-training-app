import { test } from "node:test";
import assert from "node:assert/strict";
import { todayIso } from "../src/util/today.js";

/**
 * todayIso derives the calendar date in the athlete's timezone, NOT the UTC date. This is the DATA-3
 * fix: a UK athlete on BST (UTC+1) finishing a session at 00:30 local is on the NEXT calendar day,
 * but `new Date().toISOString().slice(0,10)` would still report the previous (UTC) day. The clock is
 * injected here so the midnight boundary is deterministic regardless of when the suite runs.
 */

test("todayIso: BST late-night session lands on the LOCAL day, not the previous UTC day", () => {
  // 2025-06-15T23:30Z is 00:30 on 2025-06-16 in London (BST = UTC+1).
  const instant = new Date("2025-06-15T23:30:00Z");
  assert.equal(todayIso("Europe/London", instant), "2025-06-16", "local date, not the UTC 06-15");
  // The bug this guards against: the naive UTC slice would report the prior day.
  assert.equal(instant.toISOString().slice(0, 10), "2025-06-15");
});

test("todayIso: winter (GMT, no offset) keeps the same date as UTC", () => {
  const instant = new Date("2025-01-15T23:30:00Z"); // GMT = UTC+0 in January
  assert.equal(todayIso("Europe/London", instant), "2025-01-15");
});

test("todayIso: honours a westward timezone that is still on the previous day", () => {
  // 2025-06-16T02:00Z is 22:00 on 2025-06-15 in New York (EDT = UTC-4).
  const instant = new Date("2025-06-16T02:00:00Z");
  assert.equal(todayIso("America/New_York", instant), "2025-06-15");
});

test("todayIso: always returns a zero-padded YYYY-MM-DD string", () => {
  const instant = new Date("2025-03-05T12:00:00Z");
  assert.match(todayIso("Europe/London", instant), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(todayIso("Europe/London", instant), "2025-03-05");
});
