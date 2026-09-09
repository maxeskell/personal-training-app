import { test } from "node:test";
import assert from "node:assert/strict";
import { loadArchiveVolume } from "../src/coach/archiveVolume.js";
import type { ArchiveStore } from "../src/archive/store.js";

/** A stub store: no disk, no network — the loader's shape mapping is what's under test. */
const store = (garmin: unknown[], aie: unknown[]) =>
  ({ loadGarminActivities: async () => garmin, loadActivities: async () => aie }) as unknown as ArchiveStore;

test("loadArchiveVolume: Garmin elapsed seconds (moving as fallback) + metres → hours/km; AIE moving time + km; junk rows dropped", async () => {
  const v = await loadArchiveVolume(
    store(
      [
        { id: "1", date: "2026-06-07", raw: { duration_seconds: 3600, moving_duration_seconds: 3000, distance_meters: 22638 } },
        { id: "2", date: "2026-06-08", raw: { moving_duration_seconds: 1800 } }, // no elapsed → moving; no distance → km undefined
        { id: "3", date: "2026-06-09", raw: { duration_seconds: 0 } }, // zero-length → dropped
        { id: "4", date: "not-a-date", raw: { duration_seconds: 600 } }, // undated → dropped
        { id: "5", date: "2026-06-10", raw: {} }, // no duration → dropped
      ],
      [
        { sport: "Run", date: "2026-04-28", key: "k", raw: { activity_movingtime: 2860, distance_in_km: 7.97 } },
        { sport: "Ride", date: "2026-04-29", key: "k2", raw: { activity_movingtime: null } }, // dropped
      ],
    ),
  );
  assert.deepEqual(v.garmin, [
    { date: "2026-06-07", hours: 1, km: 22.638 },
    { date: "2026-06-08", hours: 0.5, km: undefined },
  ]);
  assert.deepEqual(v.aie, [{ date: "2026-04-28", hours: 2860 / 3600, km: 7.97 }]);
});

test("loadArchiveVolume: a failing store degrades to empty lists (the long arc keeps its file-built years)", async () => {
  const bad = { loadGarminActivities: async () => { throw new Error("disk"); }, loadActivities: async () => [] } as unknown as ArchiveStore;
  assert.deepEqual(await loadArchiveVolume(bad), { garmin: [], aie: [] });
});
