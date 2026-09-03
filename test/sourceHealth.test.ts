import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState } from "../src/state/types.js";
import { judgeAieReads, carryLastGoodAt, aieOutage } from "../src/state/sourceHealth.js";

/**
 * Source health (spec 11): the 30 Aug 2026 outage produced snapshots with every AI Endurance read failed
 * that every surface treated as fresh. These pure helpers are the single judgement all surfaces share —
 * including for legacy snapshots that pre-date the `sources` field.
 */

const TOOLS = ["getUser", "getPlannedWorkouts", "getRunningActivity", "getRecoveryModel"];
const REAUTH = "AI Endurance authorization is missing or expired — run `npm run auth:aie` on the host to re-authorize.";

test("judgeAieReads: all good → ok; one failure → degraded; all failed → down", () => {
  assert.equal(judgeAieReads({ getUser: {}, getPlannedWorkouts: [], getRunningActivity: {}, getRecoveryModel: {} }, TOOLS).status, "ok");
  const one = judgeAieReads({ getUser: {}, getPlannedWorkouts: { error: "AIE tool getPlannedWorkouts failed: 503" }, getRunningActivity: {}, getRecoveryModel: {} }, TOOLS);
  assert.equal(one.status, "degraded");
  assert.deepEqual(one.failedTools, ["getPlannedWorkouts"]);
  assert.equal(one.reauthNeeded, false);
  const all = judgeAieReads(Object.fromEntries(TOOLS.map((t) => [t, { error: "AIE tool failed: 503" }])), TOOLS);
  assert.equal(all.status, "down");
  assert.equal(all.ok, false);
});

test("judgeAieReads: a re-auth error on any read is 'down' with reauthNeeded (the token is gone for every tool)", () => {
  const j = judgeAieReads({ getUser: { error: REAUTH }, getPlannedWorkouts: {}, getRunningActivity: {}, getRecoveryModel: {} }, TOOLS);
  assert.equal(j.status, "down");
  assert.equal(j.reauthNeeded, true);
});

test("carryLastGoodAt: this assemble when it worked; else the newest good prior snapshot; else null", () => {
  assert.equal(carryLastGoodAt("ok", "2026-09-03T09:00:00Z", []), "2026-09-03T09:00:00Z");
  const good = emptyState("2026-08-29", "2026-08-29T18:00:00Z");
  good.raw = { getUser: {}, getPlannedWorkouts: [] };
  const bad = emptyState("2026-09-01", "2026-09-01T18:00:00Z");
  bad.raw = { getUser: { error: REAUTH }, getPlannedWorkouts: { error: REAUTH } };
  const withSources = emptyState("2026-09-02", "2026-09-02T18:00:00Z");
  withSources.sources = { aie: { status: "down", ok: false, failedTools: ["getUser"], reauthNeeded: true, lastGoodAt: "2026-08-29T18:00:00Z" }, garmin: { enabled: true, ok: true } };
  // Legacy good snapshot wins over a legacy bad one regardless of order; a `sources` carrier is honoured.
  assert.equal(carryLastGoodAt("down", "2026-09-03T09:00:00Z", [bad, good]), "2026-08-29T18:00:00Z");
  assert.equal(carryLastGoodAt("down", "2026-09-03T09:00:00Z", [withSources, bad]), "2026-08-29T18:00:00Z");
  assert.equal(carryLastGoodAt("down", "2026-09-03T09:00:00Z", [bad]), null);
});

test("aieOutage: reads `sources` when present, infers from raw errors on legacy snapshots, and is quiet with no raw", () => {
  const s = emptyState("2026-09-03", "2026-09-03T09:00:00Z");
  assert.equal(aieOutage(s).down, false, "no raw at all (demo/tests) is not an outage");
  s.raw = { getUser: { error: REAUTH }, getPlannedWorkouts: { error: REAUTH }, garmin: { sleep: {} } };
  const legacy = aieOutage(s);
  assert.equal(legacy.down, true);
  assert.equal(legacy.reauthNeeded, true);
  assert.equal(legacy.since, null, "a legacy snapshot can't say when the last good sync was");
  s.sources = { aie: { status: "down", ok: false, failedTools: ["getUser"], reauthNeeded: false, lastGoodAt: "2026-08-29T18:00:00Z" }, garmin: { enabled: true, ok: true } };
  const modern = aieOutage(s);
  assert.equal(modern.since, "2026-08-29T18:00:00Z");
  assert.equal(modern.reauthNeeded, false);
});
