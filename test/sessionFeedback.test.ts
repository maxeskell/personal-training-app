import { test } from "node:test";
import assert from "node:assert/strict";
import { latestByDate, latestByDateSport, sessionFeedbackKey, type SessionFeedbackRecord } from "../src/coach/sessionFeedbackStore.js";
import { sessionsNeedingFeedback, feedbackLimitForMode } from "../src/coach/autoSessionFeedback.js";

/**
 * Pure-logic tests for the auto session-feedback feature: collapsing the append-only store to the latest
 * per session, and selecting which recent sessions still need a deep dive. The LLM generation path itself
 * is exercised end-to-end by the live `make`/manual runs, not here (no network in unit tests).
 */

const rec = (date: string, generatedAt: string, extra: Partial<SessionFeedbackRecord> = {}): SessionFeedbackRecord => ({
  schemaVersion: 1,
  date,
  sport: "Run",
  deep: true,
  generatedAt,
  costUsd: 0.1,
  markdown: `fb ${date} ${generatedAt}`,
  ...extra,
});

test("latestByDate: collapses the append-only log to the most recent record per session date", () => {
  const m = latestByDate([
    rec("2026-06-08", "2026-06-08T07:00:00Z"),
    rec("2026-06-09", "2026-06-09T07:00:00Z"),
    rec("2026-06-09", "2026-06-09T19:00:00Z", { markdown: "newer" }), // regenerated later same day
  ]);
  assert.equal(m.size, 2);
  assert.equal(m.get("2026-06-09")!.markdown, "newer", "the most recent generatedAt wins");
  assert.equal(m.get("2026-06-08")!.date, "2026-06-08");
});

test("sessionsNeedingFeedback: recent + unstored only, newest-first, capped — keyed by date|sport", () => {
  const keys = ["2026-06-09|Run", "2026-06-09|Run", "2026-06-07|Ride", "2026-05-20|Run" /* too old */, "2026-06-08|Swim"];
  const stored = new Set(["2026-06-07|Ride"]); // already has feedback
  const got = sessionsNeedingFeedback(keys, stored, "2026-06-09", 10, 5);
  assert.deepEqual(got, ["2026-06-09|Run", "2026-06-08|Swim"], "dedup, drop stored + out-of-window, newest first");

  // A multi-sport day yields one key per sport (the swim + ride below are NOT collapsed to the date).
  const triDay = sessionsNeedingFeedback(["2026-06-09|Ride", "2026-06-09|Run", "2026-06-09|Swim"], new Set(), "2026-06-09", 10, 5);
  assert.equal(triDay.length, 3, "every sport on a multi-sport day needs its own readout");

  // The cap bounds a first-sync burst over a long history.
  const many = Array.from({ length: 8 }, (_, i) => `2026-06-${String(2 + i).padStart(2, "0")}|Run`);
  assert.equal(sessionsNeedingFeedback(many, new Set(), "2026-06-09", 30, 3).length, 3);

  // A future-dated activity (clock skew) is ignored.
  assert.deepEqual(sessionsNeedingFeedback(["2026-06-12|Run"], new Set(), "2026-06-09", 10, 5), []);
});

test("latestByDateSport: a multi-sport day keeps one readout per sport (no date-only collision)", () => {
  const m = latestByDateSport([
    rec("2026-06-09", "2026-06-09T07:00:00Z", { sport: "Swim" }),
    rec("2026-06-09", "2026-06-09T09:00:00Z", { sport: "Ride" }),
    rec("2026-06-09", "2026-06-09T18:00:00Z", { sport: "Ride", markdown: "newer ride" }), // regenerated
    rec("2026-06-09", "2026-06-09T19:00:00Z", { sport: "Run" }),
  ]);
  assert.equal(m.size, 3, "swim + ride + run on one day are distinct sessions");
  assert.equal(m.get(sessionFeedbackKey("2026-06-09", "Ride"))!.markdown, "newer ride", "most recent generatedAt wins within a sport");
  assert.ok(m.has(sessionFeedbackKey("2026-06-09", "Swim")));
});

test("feedbackLimitForMode: off→0, latest→1, on→base (the COACH_AUTO_SESSION_FEEDBACK throttle)", () => {
  assert.equal(feedbackLimitForMode("off"), 0);
  assert.equal(feedbackLimitForMode("latest"), 1);
  assert.equal(feedbackLimitForMode("on"), 5);
  assert.equal(feedbackLimitForMode("on", 3), 3);
});
