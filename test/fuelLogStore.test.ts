import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The fuel-log JSONL store backs the one-tap feedback loop. It must round-trip records, stamp the schema
 * version, tolerate a torn line (a half-written append must not blank the history), degrade to [] when
 * absent, collapse to the latest outcome per (date,sport), and roll up empirical carb-tolerance stats for
 * the learning review. Temp data dir per the store.test.ts convention (config.dataDir read lazily).
 */

async function withTmpDataDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "coach-fuel-"));
  const { config } = await import("../src/config.js");
  (config as { dataDir: string }).dataDir = dir;
  await mkdir(dir, { recursive: true });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("saveFuelLog → loadFuelLog round-trips and stamps the schema version", async () => {
  const { dir, cleanup } = await withTmpDataDir();
  const { saveFuelLog, loadFuelLog, FUEL_LOG_SCHEMA_VERSION } = await import("../src/coach/fuelLogStore.js");
  await saveFuelLog({ date: "2026-06-20", sport: "Ride", planned: "~75 g/h", carbTargetGPerHour: 75, outcome: "good", loggedAt: "2026-06-20T16:00:00Z" });
  await saveFuelLog({ date: "2026-06-21", sport: "Run", outcome: "rough", carbTargetGPerHour: 60, note: "gels sat badly", loggedAt: "2026-06-21T09:00:00Z" });
  const recs = await loadFuelLog();
  assert.equal(recs.length, 2);
  assert.equal(recs[0].schemaVersion, FUEL_LOG_SCHEMA_VERSION);
  assert.equal(recs[0].outcome, "good");
  assert.equal(recs[1].note, "gels sat badly");
  await cleanup();
  void dir;
});

test("loadFuelLog skips a malformed line and returns [] when absent", async () => {
  const { dir, cleanup } = await withTmpDataDir();
  const { loadFuelLog } = await import("../src/coach/fuelLogStore.js");
  assert.deepEqual(await loadFuelLog(), [], "absent → []");
  const good = JSON.stringify({ schemaVersion: 1, date: "2026-06-20", sport: "Ride", outcome: "good", loggedAt: "2026-06-20T16:00:00Z" });
  await writeFile(join(dir, "fuel-log.jsonl"), good + "\n{ torn json\n\n" + good.replace("06-20", "06-21") + "\n");
  const recs = await loadFuelLog();
  assert.equal(recs.length, 2, "two valid records survive");
  await cleanup();
});

test("latestFuelByDateSport keeps the most recent outcome per session", async () => {
  const { latestFuelByDateSport } = await import("../src/coach/fuelLogStore.js");
  const recs = [
    { schemaVersion: 1, date: "2026-06-20", sport: "Ride", outcome: "rough" as const, loggedAt: "2026-06-20T16:00:00Z" },
    { schemaVersion: 1, date: "2026-06-20", sport: "Ride", outcome: "good" as const, loggedAt: "2026-06-20T20:00:00Z" },
  ];
  const m = latestFuelByDateSport(recs);
  assert.equal(m.size, 1);
  assert.equal(m.get("2026-06-20|Ride")?.outcome, "good", "newer loggedAt wins");
});

test("summariseFuelLog rolls up empirical carb tolerance", async () => {
  const { summariseFuelLog } = await import("../src/coach/fuelLogStore.js");
  const stats = summariseFuelLog([
    { schemaVersion: 1, date: "2026-06-18", sport: "Ride", outcome: "good", carbTargetGPerHour: 75, loggedAt: "a" },
    { schemaVersion: 1, date: "2026-06-19", sport: "Ride", outcome: "good", carbTargetGPerHour: 60, loggedAt: "b" },
    { schemaVersion: 1, date: "2026-06-20", sport: "Run", outcome: "rough", carbTargetGPerHour: 90, loggedAt: "c" },
  ]);
  assert.equal(stats.total, 3);
  assert.equal(stats.good, 2);
  assert.equal(stats.bestToleratedCarbGPerHour, 75, "highest well-tolerated rate");
  assert.equal(stats.worstCarbGPerHour, 90, "rate that went badly");
});

test("isFuelOutcome guards the one-tap values", async () => {
  const { isFuelOutcome } = await import("../src/coach/fuelLogStore.js");
  assert.equal(isFuelOutcome("good"), true);
  assert.equal(isFuelOutcome("bonked"), true);
  assert.equal(isFuelOutcome("amazing"), false);
});
