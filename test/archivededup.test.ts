import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The append-only archive can accrue duplicate records (the backfill's dedup-on-read isn't atomic, so
 * overlapping runs each append the same date). The loaders must collapse to one record per date/id —
 * the insight engine reads the raw series, so a duplicate day would otherwise be double-weighted in
 * rolling baselines / z-scores. `compact()` then physically de-duplicates the on-disk file.
 */
test("ArchiveStore dedups garmin-daily by date (last write wins) and compact() rewrites the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coach-archive-"));
  const { config } = await import("../src/config.js");
  (config as { dataDir: string }).dataDir = dir;
  await mkdir(join(dir, "archive"), { recursive: true });

  // Two lines for the same date (a duplicate from an overlapping backfill) plus one unique date.
  const path = join(dir, "archive", "garmin-daily.jsonl");
  const lines =
    [
      JSON.stringify({ date: "2025-01-01", restingHr: 50 }),
      JSON.stringify({ date: "2025-01-02", restingHr: 51 }),
      JSON.stringify({ date: "2025-01-01", restingHr: 99 }), // later write for 01-01 must win
    ].join("\n") + "\n";
  await writeFile(path, lines);

  const { ArchiveStore } = await import("../src/archive/store.js");
  const store = new ArchiveStore();

  const days = await store.loadGarminDays();
  assert.equal(days.length, 2, "collapses to one record per date");
  assert.equal(days.find((d) => d.date === "2025-01-01")?.restingHr, 99, "keeps the last-written dup");
  assert.equal((await store.garminDates()).size, 2, "garminDates is distinct");

  // summary() now reports the distinct count, not the raw 3 lines.
  assert.equal((await store.summary()).garminDays, 2);

  // compact() reports the shrink and physically rewrites the file.
  const report = await store.compact();
  const daily = report.find((r) => r.file === "garmin-daily.jsonl");
  assert.deepEqual({ before: daily?.before, after: daily?.after, removed: daily?.removed }, { before: 3, after: 2, removed: 1 });
  const onDisk = (await readFile(path, "utf8")).trim().split("\n");
  assert.equal(onDisk.length, 2, "file physically de-duplicated");

  // Re-running compact is a no-op now that the file is clean.
  const second = await store.compact();
  assert.equal(second.reduce((n, r) => n + r.removed, 0), 0, "idempotent — nothing left to remove");

  await rm(dir, { recursive: true, force: true });
});

test("ArchiveStore dedups activities by key and garmin-activities by id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coach-archive-"));
  const { config } = await import("../src/config.js");
  (config as { dataDir: string }).dataDir = dir;
  await mkdir(join(dir, "archive"), { recursive: true });

  await writeFile(
    join(dir, "archive", "activities.jsonl"),
    [
      JSON.stringify({ sport: "Run", date: "2025-02-01", key: "k1", raw: {} }),
      JSON.stringify({ sport: "Run", date: "2025-02-01", key: "k1", raw: {} }), // dup key
      JSON.stringify({ sport: "Ride", date: "2025-02-02", key: "k2", raw: {} }),
    ].join("\n") + "\n",
  );
  await writeFile(
    join(dir, "archive", "garmin-activities.jsonl"),
    [
      JSON.stringify({ id: "a1", date: "2025-02-01", raw: {} }),
      JSON.stringify({ id: "a1", date: "2025-02-01", raw: {} }), // dup id
    ].join("\n") + "\n",
  );

  const { ArchiveStore } = await import("../src/archive/store.js");
  const store = new ArchiveStore();
  assert.equal((await store.loadActivities()).length, 2, "activities deduped by key");
  assert.equal((await store.loadGarminActivities()).length, 1, "garmin activities deduped by id");

  await rm(dir, { recursive: true, force: true });
});
