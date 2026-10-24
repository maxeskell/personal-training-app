import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { emptyState } from "../src/state/types.js";
import { mapHeatAcclimation, mapRecoveryTime, mapRunningTolerance } from "../src/state/assemble.js";
import { runningToleranceFinding } from "../src/insights/garminHealth.js";
import { ArchiveStore, mergeExtrasByDate } from "../src/archive/store.js";
import { backfillGarminExtras, dateChunks, toleranceRows, isToolFailure, bikeFromGear, backfillActivityGear } from "../src/archive/backfill.js";
import type { GarminClient } from "../src/mcp/garminClient.js";

/**
 * Signals the a2ca5fc garmin_mcp added (heat acclimation, recovery clock, running tolerance): mapped from the
 * curated shapes in garmin_mcp's source, surfaced as a finding, archived with a resumable backfill.
 */

test("mappers: curated payloads map into state; missing or error payloads leave the slot absent", () => {
  const s = emptyState("2026-10-24", "t");
  mapHeatAcclimation(s, { date: "2026-10-20", heat_acclimation_percent: 42, previous_heat_acclimation_percent: 50, heat_acclimation_change: -8, heat_trend: "DECLINING" });
  assert.deepEqual(s.heatAcclimation.value, { heatPct: 42, previousHeatPct: 50, heatChange: -8, heatTrend: "DECLINING", altitudeM: undefined, asOf: "2026-10-20" });
  mapRecoveryTime(s, { remaining_hours: 18, state: "RECOVERING" });
  assert.equal(s.recoveryTime.value?.remainingHours, 18);
  mapRunningTolerance(s, { tolerance_km: 30, acute_load_km: 39, distance_km: 28, load_ratio: 1.39, feedback_phrase: "ABOVE_TOLERANCE" });
  assert.equal(s.runningTolerance.value?.loadRatio, 1.39);
  const blank = emptyState("2026-10-24", "t");
  mapHeatAcclimation(blank, null);
  mapRecoveryTime(blank, "No recovery data");
  mapRunningTolerance(blank, {});
  assert.equal(blank.heatAcclimation.value ?? null, null);
  assert.equal(blank.recoveryTime.value ?? null, null);
  assert.equal(blank.runningTolerance.value ?? null, null);
});

test("runningToleranceFinding: silent under capacity, watch over, flag well over; intensity changes the advice", () => {
  assert.equal(runningToleranceFinding({ toleranceKm: 30, acuteLoadKm: 25 }), null);
  const watch = runningToleranceFinding({ toleranceKm: 30, acuteLoadKm: 33, distanceKm: 30, loadRatio: 1.1 })!;
  assert.equal(watch.severity, "watch");
  assert.match(watch.recommendation!, /Hold run volume flat/);
  const flag = runningToleranceFinding({ toleranceKm: 30, acuteLoadKm: 39, distanceKm: 28, loadRatio: 1.39 })!;
  assert.equal(flag.severity, "flag");
  assert.match(flag.detail, /130%/);
  assert.match(flag.recommendation!, /take the intensity out/);
  assert.equal(runningToleranceFinding(undefined), null, "old snapshots have no slot");
});

test("mergeExtrasByDate: two passes for the same day merge field by field", () => {
  const m = mergeExtrasByDate([
    { date: "2026-10-02", runToleranceKm: 30, tolFetched: true },
    { date: "2026-10-01", acclFetched: true },
    { date: "2026-10-02", heatAcclimationPct: 10, acclFetched: true },
  ]);
  assert.deepEqual(m, [
    { date: "2026-10-01", acclFetched: true },
    { date: "2026-10-02", runToleranceKm: 30, tolFetched: true, heatAcclimationPct: 10, acclFetched: true },
  ]);
});

test("dateChunks + toleranceRows: 90-day chunks; trend payload parsed defensively", () => {
  const c = dateChunks("2026-01-01", "2026-12-31", 90);
  assert.equal(c.length, 5);
  assert.equal(c[0].end, "2026-03-31");
  assert.equal(c[4].days.length, 5);
  assert.deepEqual(toleranceRows({ trend: [{ date: "2026-10-01", tolerance_km: 30, acute_load_km: 20 }] }), [
    { date: "2026-10-01", runToleranceKm: 30, runAcuteLoadKm: 20, runDistanceKm: undefined, runLoadRatio: undefined },
  ]);
  assert.deepEqual(toleranceRows("No running tolerance data"), []);
});

test("isToolFailure: protocol errors and 'Error …' text are failures; 'No … data found' is an answer", () => {
  assert.equal(isToolFailure(null), true);
  assert.equal(isToolFailure({ isError: true, content: [{ type: "text", text: "Unknown tool: get_acclimation" }] }), true);
  assert.equal(isToolFailure({ content: [{ type: "text", text: "Error retrieving acclimation data: 429" }] }), true);
  assert.equal(isToolFailure({ content: [{ type: "text", text: "No acclimation data found for 2026-10-01." }] }), false);
  assert.equal(isToolFailure({ content: [{ type: "text", text: '{"heat_acclimation_percent": 5}' }] }), false);
});

function fakeGarmin(handler: (tool: string, args: Record<string, unknown>) => unknown): GarminClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    tryCall: async (tool: string, args: Record<string, unknown> = {}) => {
      calls.push(`${tool}:${String(args.date ?? args.start_date)}`);
      return handler(tool, args);
    },
  } as unknown as GarminClient & { calls: string[] };
}
const text = (t: string) => ({ content: [{ type: "text", text: t }] });

test("backfillGarminExtras: stores both signals, is resumable, and retries days that failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "extras-"));
  const prev = config.dataDir;
  (config as { dataDir: string }).dataDir = dir;
  try {
    let acclFails = true;
    const g = fakeGarmin((tool, args) => {
      if (tool === "get_running_tolerance_trend") return text(JSON.stringify({ trend: [{ date: "2026-10-01", tolerance_km: 30, acute_load_km: 20 }] }));
      if (tool === "get_acclimation") {
        if (args.date === "2026-10-02" && acclFails) return text("Error retrieving acclimation data: timeout");
        return args.date === "2026-10-01" ? text(JSON.stringify({ heat_acclimation_percent: 12, heat_trend: "ACCLIMATIZING" })) : text("No acclimation data found.");
      }
      return null;
    });
    const store = new ArchiveStore();
    const r = await backfillGarminExtras(g, store, "2026-10-01", "2026-10-05", () => {}, { throttleMs: 0, refreshDays: 0 });
    assert.equal(r.toleranceDays, 1);
    assert.equal(r.acclimationDays, 1);
    const rows = await store.loadGarminExtras();
    assert.equal(rows.find((d) => d.date === "2026-10-01")!.heatAcclimationPct, 12);
    assert.equal(rows.find((d) => d.date === "2026-10-02")!.acclFetched, undefined, "failed day left unmarked");
    assert.equal(rows.find((d) => d.date === "2026-10-03")!.acclFetched, true, "'no data' is an answer");

    acclFails = false;
    g.calls.length = 0;
    await backfillGarminExtras(g, store, "2026-10-01", "2026-10-05", () => {}, { throttleMs: 0, refreshDays: 0 });
    assert.deepEqual(g.calls, ["get_acclimation:2026-10-02"], "second run only retries the failed day");

    g.calls.length = 0;
    await backfillGarminExtras(g, store, "2026-10-01", "2026-10-05", () => {}, { throttleMs: 0, refreshDays: 2 });
    assert.deepEqual(g.calls, ["get_running_tolerance_trend:2026-10-01", "get_acclimation:2026-10-04", "get_acclimation:2026-10-05"], "refresh re-asks the last 2 days only");
  } finally {
    (config as { dataDir: string }).dataDir = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bikeFromGear: prefers the bike item, the athlete's own name, then make/model; none → null", () => {
  assert.equal(bikeFromGear([{ gearTypeName: "Shoes", displayName: "Pegasus" }, { gearTypeName: "Bike", displayName: "Laverack" }]), "Laverack");
  assert.equal(bikeFromGear([{ gearTypeName: "Bike", customMakeModel: "Canyon Speedmax" }]), "Canyon Speedmax");
  assert.equal(bikeFromGear([{ gearTypeName: "Bike", gearMakeName: "Wattbike", gearModelName: "Atom" }]), "Wattbike Atom");
  assert.equal(bikeFromGear([]), null);
  assert.equal(bikeFromGear(null), null);
});

test("backfillActivityGear: rides only, newest first, resumable, failures retried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gear-"));
  const prev = config.dataDir;
  (config as { dataDir: string }).dataDir = dir;
  try {
    const store = new ArchiveStore();
    await store.appendGarminActivities([
      { id: "1", date: "2026-10-01", type: "road_biking", raw: {} },
      { id: "2", date: "2026-10-02", type: "running", raw: {} },
      { id: "3", date: "2026-10-03", type: "virtual_ride", raw: {} },
      { id: "4", date: "2026-10-04", type: "cycling", raw: {} },
    ]);
    let fail4 = true;
    const g = fakeGarmin((_tool, args) => {
      if (args.activity_id === "4" && fail4) return text("Error retrieving activity gear data: 500");
      if (args.activity_id === "1") return text(JSON.stringify([{ gearTypeName: "Bike", displayName: "Laverack" }]));
      return text("No gear data found for activity with ID 3");
    });
    const r = await backfillActivityGear(g, store, () => {}, { throttleMs: 0 });
    assert.equal(g.calls.length, 3, "three rides asked, the run skipped");
    assert.equal(r.asked, 2);
    assert.equal(r.withGear, 1);
    const gear = await store.loadActivityGear();
    assert.equal(gear.get("1"), "Laverack");
    assert.equal(gear.get("3"), null, "'no gear' is an answer");
    assert.equal(gear.has("4"), false, "failure left unasked");
    assert.equal(gear.has("2"), false, "runs are skipped");
    fail4 = false;
    const r2 = await backfillActivityGear(g, store, () => {}, { throttleMs: 0 });
    assert.equal(r2.asked, 1, "second run only asks the failed ride");
  } finally {
    (config as { dataDir: string }).dataDir = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backfillActivityGear --recheck: re-asks rides stored as 'no bike' (tagged later in Garmin Connect), within a date range", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gear2-"));
  const prev = config.dataDir;
  (config as { dataDir: string }).dataDir = dir;
  try {
    const store = new ArchiveStore();
    await store.appendGarminActivities([
      { id: "10", date: "2026-03-01", type: "road_biking", raw: {} },
      { id: "11", date: "2025-03-01", type: "road_biking", raw: {} },
      { id: "12", date: "2026-07-01", type: "road_biking", raw: {} },
    ]);
    await store.appendActivityGear([{ activityId: "10", gear: null }, { activityId: "11", gear: null }, { activityId: "12", gear: "Laverack Disc Road" }]);
    const g = fakeGarmin(() => text(JSON.stringify([{ gearTypeName: "Bike", displayName: "Laverack Disc Road" }])));
    const plain = await backfillActivityGear(g, store, () => {}, { throttleMs: 0 });
    assert.equal(plain.asked, 0, "without --recheck, known rides are not re-asked");
    const r = await backfillActivityGear(g, store, () => {}, { throttleMs: 0, recheckUntagged: true, from: "2026-01-01" });
    assert.equal(r.asked, 1, "only the untagged ride inside the range");
    const gear = await store.loadActivityGear();
    assert.equal(gear.get("10"), "Laverack Disc Road");
    assert.equal(gear.get("11"), null, "outside --from, untouched");
  } finally {
    (config as { dataDir: string }).dataDir = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
