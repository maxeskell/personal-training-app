import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Fake Garmin MCP client: returns the summary shapes garminInner unwraps. */
function fakeGarmin() {
  return {
    async tryCall(name: string) {
      if (name === "get_activities")
        return {
          activities: [
            { activityId: "A1", type: "running" }, // already archived → skipped
            { activityId: "A2", type: "cycling" }, // new → added
            { activityId: "A3", type: "strength_training" }, // not run/ride/swim → ignored
          ],
        };
      if (name === "get_activity_fit_data")
        return { session: { start_time: "2026-06-08T07:00:00", sport: "cycling", avg_power: 220, temperature_stats: { avg_temp_c: 24 } } };
      if (name === "get_activity_weather") return { temperature_celsius: 63, humidity_percent: 50 }; // 63°F mislabelled
      return null;
    },
  };
}

test("syncFitSummaries: dedups against the archive, ignores non-endurance, maps + °F-corrects the summary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coach-fit-"));
  const { config } = await import("../src/config.js");
  (config as { dataDir: string }).dataDir = dir;
  const { ArchiveStore } = await import("../src/archive/store.js");
  const { syncFitSummaries } = await import("../src/archive/fitSync.js");

  const store = new ArchiveStore();
  await store.appendFitSummaries([{ activityId: "A1", date: "2026-06-01", sport: "Run" }]);

  const r = await syncFitSummaries(fakeGarmin() as never, store, 25);
  assert.equal(r.total, 3);
  assert.equal(r.skipped, 1, "A1 already archived");
  assert.equal(r.added, 1, "A2 is new; A3 (strength) ignored");
  assert.equal(r.summaries[0].activityId, "A2");
  assert.equal(r.summaries[0].sport, "Ride");
  assert.equal(r.summaries[0].avgPowerW, 220);
  assert.equal(r.summaries[0].weatherTempC, 17.2, "63°F corrected to °C");
  assert.equal((await store.fitSummaryIds()).has("A2"), true, "persisted to the archive");
});
