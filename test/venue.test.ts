import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The venue store backs the dashboard's live open-water-temp box: a value with no public feed, entered
 * by hand and updated often, so it lives in the data dir (read live → no restart) NOT an env var. It must
 * validate/clamp the reading, round-trip with a takenAt stamp, clear cleanly, and degrade to null when
 * absent. Temp data dir per the fuelLogStore.test.ts convention (config.dataDir read lazily).
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

test("setWaterTemp → loadWaterTemp round-trips and stamps takenAt; clear forgets it", async () => {
  const { dir, cleanup } = await withTmpDataDir();
  const { loadVenue, setWaterTemp, clearWaterTemp } = await import("../src/state/venue.js");

  assert.equal(await loadVenue(), null, "absent → null");

  const saved = await setWaterTemp(21);
  assert.equal(saved.waterTempC, 21);
  assert.ok(saved.takenAt && !Number.isNaN(new Date(saved.takenAt).getTime()), "takenAt is a valid ISO stamp");

  const loaded = await loadVenue();
  assert.equal(loaded?.waterTempC, 21);
  assert.equal(loaded?.takenAt, saved.takenAt);

  await clearWaterTemp();
  assert.equal(await loadVenue(), null, "cleared → null again");
  await clearWaterTemp(); // idempotent — clearing an absent file must not throw

  await cleanup();
  void dir;
});

test("loadVenue degrades to null on malformed JSON", async () => {
  const { dir, cleanup } = await withTmpDataDir();
  const { loadVenue } = await import("../src/state/venue.js");
  await writeFile(join(dir, "venue.json"), "{ not json");
  assert.equal(await loadVenue(), null);
  await cleanup();
});
