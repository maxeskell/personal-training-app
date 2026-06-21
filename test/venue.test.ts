import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The venue store backs the dashboard's open-water-temp confirm loop: values with no public feed, entered
 * by hand and updated often, so they live in the data dir (read live → no restart) NOT an env var. It must
 * validate/clamp readings, keep a history (each stamped with the air-temp anchor), surface the latest,
 * migrate the original single-reading file, clear cleanly, and degrade to null when absent. Temp data dir
 * per the fuelLogStore.test.ts convention (config.dataDir read lazily).
 */

async function withTmpDataDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "coach-venue-"));
  const { config } = await import("../src/config.js");
  (config as { dataDir: string }).dataDir = dir;
  await mkdir(dir, { recursive: true });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("parseWaterTemp accepts numbers/strings, clamps the range, rounds to 0.1, rejects junk", async () => {
  const { parseWaterTemp } = await import("../src/state/venue.js");
  assert.equal(parseWaterTemp(21), 21);
  assert.equal(parseWaterTemp("18.5"), 18.5);
  assert.equal(parseWaterTemp("13"), 13);
  assert.equal(parseWaterTemp(16.04), 16); // rounded to 0.1
  assert.equal(parseWaterTemp(0), 0); // a cold-but-plausible reading is valid
  assert.equal(parseWaterTemp(-3), undefined, "below the plausible floor → rejected");
  assert.equal(parseWaterTemp(45), undefined, "above the plausible ceiling → rejected");
  assert.equal(parseWaterTemp("warm"), undefined);
  assert.equal(parseWaterTemp(""), undefined);
  assert.equal(parseWaterTemp(null), undefined);
  assert.equal(parseWaterTemp(undefined), undefined);
  assert.equal(parseWaterTemp(NaN), undefined);
});

test("setWaterTemp appends a stamped reading; latestReading + loadVenue surface it; clear forgets it", async () => {
  const { dir, cleanup } = await withTmpDataDir();
  const { loadVenue, setWaterTemp, clearWaterTemp, latestReading } = await import("../src/state/venue.js");

  assert.equal(await loadVenue(), null, "absent → null");
  assert.equal(latestReading(null), undefined);

  const first = await setWaterTemp(18, 17.5);
  assert.equal(first.tempC, 18);
  assert.equal(first.airTempC, 17.5, "air-temp anchor stored for the drift model");
  assert.ok(first.takenAt && !Number.isNaN(new Date(first.takenAt).getTime()), "takenAt is a valid ISO stamp");

  const second = await setWaterTemp(21); // no air anchor this time
  const state = await loadVenue();
  assert.equal(state?.readings.length, 2, "history is kept, not overwritten");
  assert.equal(latestReading(state)?.tempC, 21, "latestReading returns the newest");
  assert.equal(latestReading(state)?.takenAt, second.takenAt);

  await clearWaterTemp();
  assert.equal(await loadVenue(), null, "cleared → null again");
  await clearWaterTemp(); // idempotent — clearing an absent file must not throw

  await cleanup();
  void dir;
});

test("loadVenue migrates the original single-reading {waterTempC,takenAt} file", async () => {
  const { dir, cleanup } = await withTmpDataDir();
  const { loadVenue, latestReading } = await import("../src/state/venue.js");
  await writeFile(join(dir, "venue.json"), JSON.stringify({ waterTempC: 19, takenAt: "2026-06-10T08:00:00.000Z" }));
  const state = await loadVenue();
  assert.equal(state?.readings.length, 1);
  assert.equal(latestReading(state)?.tempC, 19);
  assert.equal(latestReading(state)?.takenAt, "2026-06-10T08:00:00.000Z");
  await cleanup();
});

test("loadVenue degrades to null on malformed JSON", async () => {
  const { dir, cleanup } = await withTmpDataDir();
  const { loadVenue } = await import("../src/state/venue.js");
  await writeFile(join(dir, "venue.json"), "{ not json");
  assert.equal(await loadVenue(), null);
  await cleanup();
});
