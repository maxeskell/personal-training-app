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
    assert.equal(r.streamsFailed, 0, "all downloads landed their .fit");
    assert.deepEqual(r.streamFailures, []);
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
  assert.equal((await downloadFitStream(fakeGarmin({ downloadTool: true }) as never, "A9", dir)).ok, true);
  assert.ok(existsSync(join(dir, "A9.fit")));
  // A client that fails the call → file absent → not ok, with the reason naming a failed call (not silence).
  const dead = { async listToolNames() { return []; }, async tryCall() { return null; } };
  const failed = await downloadFitStream(dead as never, "A10", dir);
  assert.equal(failed.ok, false);
  assert.match(failed.reason ?? "", /call failed/i);
});

test("downloadFitStream: a 'successful' call that writes no {id}.fit is reported as failed, with the reason (root cause #3)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coach-fit-noland-"));
  const { downloadFitStream } = await import("../src/archive/fitSync.js");
  // Tool returns ok but never writes the expected <id>.fit (e.g. a different filename / a .zip).
  const quietlyBroken = {
    async listToolNames() { return ["download_activity_file"]; },
    async tryCall() { return { status: "ok" }; },
  };
  const res = await downloadFitStream(quietlyBroken as never, "A11", dir);
  assert.equal(res.ok, false, "no <id>.fit landed → not a silent success");
  assert.match(res.reason ?? "", /no A11\.fit landed|unexpected filename/i);
  assert.ok(!existsSync(join(dir, "A11.fit")));
});

test("syncFitSummaries: stream-download failures are aggregated, not swallowed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coach-fit-fail-"));
  const { config } = await import("../src/config.js");
  (config as { dataDir: string }).dataDir = dir;
  process.env.FIT_STREAMS_DIR = join(dir, "fit-streams");
  try {
    const { ArchiveStore } = await import("../src/archive/store.js");
    const { syncFitSummaries } = await import("../src/archive/fitSync.js");
    // download_activity_file is advertised but never writes the file → every endurance activity fails.
    const broken = {
      async listToolNames() { return ["get_activities", "download_activity_file"]; },
      async tryCall(name: string) {
        if (name === "get_activities") return { activities: [{ activityId: "B1", type: "lap_swimming" }] };
        if (name === "get_activity_fit_data") return { session: { start_time: "2026-06-19T07:00:00", sport: "swimming" } };
        if (name === "get_activity_weather") return null;
        if (name === "download_activity_file") return { status: "ok" }; // ok, but writes nothing
        return null;
      },
    };
    const r = await syncFitSummaries(broken as never, new ArchiveStore(), 25);
    assert.equal(r.streamsSupported, true);
    assert.equal(r.streamsDownloaded, 0);
    assert.equal(r.streamsFailed, 1, "the failed download is counted, not hidden");
    assert.equal(r.streamFailures.length, 1);
    assert.match(r.streamFailures[0], /^B1: /);
  } finally {
    delete process.env.FIT_STREAMS_DIR;
  }
});
