import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("ArchiveStore caches by mtime+size and re-reads after an append", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coach-arch-"));
  const { config } = await import("../src/config.js");
  (config as { dataDir: string }).dataDir = dir;
  const archDir = join(dir, "archive");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(archDir, { recursive: true });
  const path = join(archDir, "garmin-daily.jsonl");
  await writeFile(path, JSON.stringify({ date: "2026-06-01", restingHr: 50 }) + "\n");

  const { ArchiveStore } = await import("../src/archive/store.js");
  const store = new ArchiveStore();
  const first = await store.loadGarminDays();
  assert.equal(first.length, 1);
  const second = await store.loadGarminDays(); // served from cache (same mtime)
  assert.equal(second.length, 1);

  // Append a new day → mtime/size change → cache invalidates → new record visible.
  await new Promise((r) => setTimeout(r, 12)); // ensure mtime tick
  await appendFile(path, JSON.stringify({ date: "2026-06-02", restingHr: 52 }) + "\n");
  const third = await store.loadGarminDays();
  assert.equal(third.length, 2, "append is picked up (cache invalidated by mtime+size)");
});

test("emptyState carries the current schema version", async () => {
  const { emptyState, STATE_SCHEMA_VERSION } = await import("../src/state/types.js");
  assert.equal(emptyState("2026-06-08", "x").schemaVersion, STATE_SCHEMA_VERSION);
});
