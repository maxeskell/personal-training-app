import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState } from "../src/state/types.js";
import { pingStatusFor, parsePingRecord, pingHeartbeatCheck } from "../src/coach/pingHeartbeat.js";

/**
 * The morning-ping heartbeat made honest (spec 11): a ping that ran with every AI Endurance read failed
 * used to record a plain success, so `doctor` stayed green through a total outage.
 */

const REAUTH = "AI Endurance authorization is missing or expired — run `npm run auth:aie` on the host to re-authorize.";
const now = new Date("2026-09-03T10:00:00Z");

test("pingStatusFor: ok on a working spine; reauth_needed / degraded when the reads failed", () => {
  const s = emptyState("2026-09-03", "2026-09-03T05:00:00Z");
  s.raw = { getUser: {}, getPlannedWorkouts: [] };
  assert.equal(pingStatusFor(s).status, "ok");
  s.raw = { getUser: { error: REAUTH }, getPlannedWorkouts: { error: REAUTH } };
  assert.equal(pingStatusFor(s).status, "reauth_needed");
  s.raw = { getUser: { error: "AIE tool getUser failed: 503" }, getPlannedWorkouts: { error: "AIE tool getPlannedWorkouts failed: 503" } };
  const d = pingStatusFor(s);
  assert.equal(d.status, "degraded");
  assert.deepEqual(d.failedTools, ["getUser", "getPlannedWorkouts"]);
});

test("parsePingRecord: a legacy {date, ts} record reads as ok; a bad status falls back to ok; junk is null", () => {
  assert.equal(parsePingRecord({ date: "2026-09-01", ts: "2026-09-01T05:00:49Z" })?.status, "ok");
  assert.equal(parsePingRecord({ date: "2026-09-01", ts: "x", status: "weird" })?.status, "ok");
  assert.equal(parsePingRecord({ date: "2026-09-02", ts: "x", status: "failed", reason: "LLM budget" })?.reason, "LLM budget");
  assert.equal(parsePingRecord({ date: 5 }), null);
  assert.equal(parsePingRecord("nope"), null);
});

test("pingHeartbeatCheck: the doctor line says what the ping ran on, not just whether it ran", () => {
  assert.equal(pingHeartbeatCheck(null, now).status, "info");
  assert.equal(pingHeartbeatCheck({ date: "2026-09-03", ts: "2026-09-03T05:00:00Z", status: "ok" }, now).status, "ok");
  assert.equal(pingHeartbeatCheck({ date: "2026-09-01", ts: "2026-09-01T05:00:00Z", status: "ok" }, now).status, "warn", ">25h old is a warning");
  const blind = pingHeartbeatCheck({ date: "2026-09-03", ts: "2026-09-03T05:00:00Z", status: "reauth_needed" }, now);
  assert.equal(blind.status, "warn");
  assert.match(blind.detail, /re-auth/);
  const failed = pingHeartbeatCheck({ date: "2026-09-02", ts: "2026-09-02T06:30:00Z", status: "failed", reason: "CoachLLM readiness call exceeded its 120000ms wall-clock budget" }, now);
  assert.match(failed.detail, /FAILED.*120000ms/);
  const degraded = pingHeartbeatCheck({ date: "2026-09-03", ts: "2026-09-03T05:00:00Z", status: "degraded", failedTools: ["getPrediction"] }, now);
  assert.match(degraded.detail, /getPrediction/);
});
