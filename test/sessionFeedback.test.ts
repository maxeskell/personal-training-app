import { test } from "node:test";
import assert from "node:assert/strict";
import { latestByDate, latestBySession, findSessionFeedback, sessionFeedbackKey, type SessionFeedbackRecord } from "../src/coach/sessionFeedbackStore.js";
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

test("sessionsNeedingFeedback: recent + unstored only, newest-first, capped — keyed by date|sport|dur", () => {
  const keys = ["2026-06-09|Run|55", "2026-06-09|Run|55", "2026-06-07|Ride|90", "2026-05-20|Run|40" /* too old */, "2026-06-08|Swim|30"];
  const stored = new Set(["2026-06-07|Ride|90"]); // already has feedback
  const got = sessionsNeedingFeedback(keys, stored, "2026-06-09", 10, 5);
  assert.deepEqual(got, ["2026-06-09|Run|55", "2026-06-08|Swim|30"], "dedup, drop stored + out-of-window, newest first");

  // Two SAME-sport sessions in one day are distinct keys (a double-run day → two readouts).
  const doubleRun = sessionsNeedingFeedback(["2026-06-09|Run|75", "2026-06-09|Run|30"], new Set(), "2026-06-09", 10, 5);
  assert.equal(doubleRun.length, 2, "an AM + PM run on one day each need their own readout");

  // A multi-sport day yields one key per sport too.
  const triDay = sessionsNeedingFeedback(["2026-06-09|Ride|120", "2026-06-09|Run|30", "2026-06-09|Swim|25"], new Set(), "2026-06-09", 10, 5);
  assert.equal(triDay.length, 3, "every sport on a multi-sport day needs its own readout");

  // A future-dated activity (clock skew) is ignored.
  assert.deepEqual(sessionsNeedingFeedback(["2026-06-12|Run|40"], new Set(), "2026-06-09", 10, 5), []);
});

test("latestBySession: two same-sport sessions in a day are kept apart by duration; newest generatedAt wins", () => {
  const m = latestBySession([
    rec("2026-06-09", "2026-06-09T08:00:00Z", { sport: "Run", durationMin: 30 }), // AM recovery
    rec("2026-06-09", "2026-06-09T18:00:00Z", { sport: "Run", durationMin: 75 }), // PM long
    rec("2026-06-09", "2026-06-09T20:00:00Z", { sport: "Run", durationMin: 75, markdown: "newer long" }), // regenerated
  ]);
  assert.equal(m.size, 2, "the 30min and 75min runs are distinct sessions");
  assert.equal(m.get(sessionFeedbackKey("2026-06-09", "Run", 75))!.markdown, "newer long", "newest within a session wins");
  assert.ok(m.has(sessionFeedbackKey("2026-06-09", "Run", 30)));
});

test("findSessionFeedback: exact composite match, else falls back to a legacy date+sport record", () => {
  const recs = [
    rec("2026-06-09", "2026-06-09T08:00:00Z", { sport: "Run", durationMin: 75 }),
    rec("2026-06-08", "2026-06-08T08:00:00Z", { sport: "Ride", markdown: "legacy ride" }), // no durationMin (pre-change)
  ];
  assert.equal(findSessionFeedback(recs, "2026-06-09", "Run", 75)!.durationMin, 75, "exact composite hit");
  assert.equal(findSessionFeedback(recs, "2026-06-08", "Ride", 90)!.markdown, "legacy ride", "no exact → fall back to the legacy date+sport readout");
  assert.equal(findSessionFeedback(recs, "2026-06-09", "Swim", 40), undefined, "no match at all → undefined");
});

test("feedbackLimitForMode: off→0, latest→1, on→base (the COACH_AUTO_SESSION_FEEDBACK throttle)", () => {
  assert.equal(feedbackLimitForMode("off"), 0);
  assert.equal(feedbackLimitForMode("latest"), 1);
  assert.equal(feedbackLimitForMode("on"), 5);
  assert.equal(feedbackLimitForMode("on", 3), 3);
});
