import { test } from "node:test";
import assert from "node:assert/strict";
import { planGapRecovery, recoverGaps, DEFAULT_RECOVER_STALE_DAYS } from "../src/archive/recover.js";
import type { ArchiveStore } from "../src/archive/store.js";

/**
 * `planGapRecovery` is the pure core of automatic gap recovery — given how recent a source's newest archived
 * record is, decide whether there's a real gap and where to backfill from. It's what turns "the connection
 * was down for a while" into a bounded download, so its boundaries are unit-tested directly. `recoverGaps`
 * itself does live I/O; only its no-network "everything current" path is exercised here (via an injected
 * store), which must NOT open any connection.
 */

const today = "2026-08-13";

test("no baseline (fresh install) is not a gap — cold start is a full backfill, not recovery", () => {
  const p = planGapRecovery(null, today, 2);
  assert.equal(p.stale, false);
  assert.equal(p.from, null);
  assert.equal(p.gapDays, 0);
});

test("normal 1-day lag is current, not stale", () => {
  const p = planGapRecovery("2026-08-12", today, 2);
  assert.equal(p.stale, false);
  assert.equal(p.gapDays, 1);
  assert.equal(p.from, null);
});

test("exactly staleDays behind is still current (threshold is exclusive)", () => {
  const p = planGapRecovery("2026-08-11", today, 2); // 2 days
  assert.equal(p.stale, false);
  assert.equal(p.gapDays, 2);
});

test("a real multi-week gap is stale and backfills from newest − overlap", () => {
  // The actual incident: Garmin daily stuck at 2026-07-17 while today is 2026-08-13.
  const p = planGapRecovery("2026-07-17", today, 2);
  assert.equal(p.stale, true);
  assert.equal(p.gapDays, 27);
  assert.equal(p.from, "2026-07-16"); // one day of overlap so the last partial day is re-fetched
});

test("overlapDays widens the re-fetch window", () => {
  const p = planGapRecovery("2026-07-17", today, 2, 3);
  assert.equal(p.from, "2026-07-14");
});

test("staleDays tunes the trigger", () => {
  assert.equal(planGapRecovery("2026-08-08", today, 2).stale, true); // 5d > 2
  assert.equal(planGapRecovery("2026-08-08", today, 7).stale, false); // 5d <= 7
});

test("recoverGaps with an all-current archive recovers nothing and opens no connection", async () => {
  // Newest dates are all 'yesterday' → every plan is current → the orchestrator returns before it would
  // ever construct a Garmin/AIE client. A fake store proves that without touching the network.
  const recent = "2026-08-12";
  const fakeStore = {
    loadActivities: async () => [{ date: recent }],
    loadGarminDays: async () => [{ date: recent }],
    loadGarminActivities: async () => [{ date: recent }],
  } as unknown as ArchiveStore;

  const rec = await recoverGaps({ now: today, store: fakeStore, staleDays: DEFAULT_RECOVER_STALE_DAYS });
  assert.equal(rec.ran, false);
  assert.equal(rec.stillStale, false);
  // AIE is always evaluated; it must read as current here.
  const aie = rec.sources.find((s) => s.source === "AIE activities");
  assert.equal(aie?.status, "current");
  assert.match(rec.summary, /nothing to recover/i);
});
