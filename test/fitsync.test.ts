import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Fake Garmin MCP client: returns the summary shapes garminInner unwraps. */
function fakeGarmin(opts: { downloadTool?: boolean } = {}) {
  return {
    async listToolNames() {
      return opts.downloadTool ? ["get_activities", "download_activity_file"] : ["get_activities"];
    },
    async tryCall(name: string, args: Record<string, unknown> = {}) {
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
      if (name === "download_activity_file") {
        await writeFile(join(String(args.output_dir), `${args.activity_id}.fit`), "fake-fit");
        return { status: "ok" };
      }
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
  assert.equal(r.streamsSupported, false, "old garmin_mcp build → no stream layer");
  assert.equal(r.streamsDownloaded, 0);
});

test("syncFitSummaries: downloads raw .FIT streams for endurance activities when the tool exists (even already-archived ones)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coach-fit-"));
  const { config } = await import("../src/config.js");
  (config as { dataDir: string }).dataDir = dir;
  process.env.FIT_STREAMS_DIR = join(dir, "fit-streams");
  try {
    const { ArchiveStore } = await import("../src/archive/store.js");
    const { syncFitSummaries } = await import("../src/archive/fitSync.js");

    const store = new ArchiveStore();
    await store.appendFitSummaries([{ activityId: "A1", date: "2026-06-01", sport: "Run" }]);

    const r = await syncFitSummaries(fakeGarmin({ downloadTool: true }) as never, store, 25);
    assert.equal(r.streamsSupported, true);
    assert.equal(r.streamsDownloaded, 2, "A1 (archived summary, no local stream) + A2; A3 ignored");
    assert.ok(existsSync(join(dir, "fit-streams", "A1.fit")));
    assert.ok(existsSync(join(dir, "fit-streams", "A2.fit")));
    assert.ok(!existsSync(join(dir, "fit-streams", "A3.fit")), "strength activity gets no stream");

    // Second run: files exist → nothing re-downloaded.
    const r2 = await syncFitSummaries(fakeGarmin({ downloadTool: true }) as never, store, 25);
    assert.equal(r2.streamsDownloaded, 0, "stream downloads dedup on the existing files");
  } finally {
    delete process.env.FIT_STREAMS_DIR;
  }
});

test("downloadFitStream: writes {id}.fit into the dir and is a no-op when present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coach-fit-dl-"));
  const { downloadFitStream } = await import("../src/archive/fitSync.js");
  assert.equal(await downloadFitStream(fakeGarmin({ downloadTool: true }) as never, "A9", dir), true);
  assert.ok(existsSync(join(dir, "A9.fit")));
  // A client that fails the call → file absent → false.
  const dead = { async listToolNames() { return []; }, async tryCall() { return null; } };
  assert.equal(await downloadFitStream(dead as never, "A10", dir), false);
});
