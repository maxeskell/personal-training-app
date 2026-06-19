import { test } from "node:test";
import assert from "node:assert/strict";
import { latestByDate, type SessionFeedbackRecord } from "../src/coach/sessionFeedbackStore.js";
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

test("sessionsNeedingFeedback: recent + unstored only, newest-first, capped", () => {
  const dates = ["2026-06-09", "2026-06-09", "2026-06-07", "2026-05-20" /* too old */, "2026-06-08"];
  const stored = new Set(["2026-06-07"]); // already has feedback
  const got = sessionsNeedingFeedback(dates, stored, "2026-06-09", 10, 5);
  assert.deepEqual(got, ["2026-06-09", "2026-06-08"], "dedup, drop stored + out-of-window, newest first");

  // The cap bounds a first-sync burst over a long history.
  const many = Array.from({ length: 8 }, (_, i) => `2026-06-${String(2 + i).padStart(2, "0")}`);
  assert.equal(sessionsNeedingFeedback(many, new Set(), "2026-06-09", 30, 3).length, 3);

  // A future-dated activity (clock skew) is ignored.
  assert.deepEqual(sessionsNeedingFeedback(["2026-06-12"], new Set(), "2026-06-09", 10, 5), []);
});

test("feedbackLimitForMode: off→0, latest→1, on→base (the COACH_AUTO_SESSION_FEEDBACK throttle)", () => {
  assert.equal(feedbackLimitForMode("off"), 0);
  assert.equal(feedbackLimitForMode("latest"), 1);
  assert.equal(feedbackLimitForMode("on"), 5);
  assert.equal(feedbackLimitForMode("on", 3), 3);
});
