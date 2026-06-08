import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function tmpDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "coach-di-"));
  const { config } = await import("../src/config.js");
  (config as { dataDir: string }).dataDir = dir;
  return dir;
}

test("StateStore.save is atomic (temp+rename) — no lingering .tmp, file is complete JSON", async () => {
  const dir = await tmpDataDir();
  const { StateStore } = await import("../src/state/store.js");
  const { emptyState } = await import("../src/state/types.js");
  const store = new StateStore();
  const s = emptyState("2026-06-08", new Date().toISOString());
  await store.save(s);
  const files = await readdir(join(dir, "state"));
  assert.deepEqual(files, ["2026-06-08.json"], "only the final file remains (no .tmp)");
  const loaded = await store.load("2026-06-08");
  assert.equal(loaded?.date, "2026-06-08");
});

test("decisionLog.all() skips a corrupt line instead of losing the whole log", async () => {
  const dir = await tmpDataDir();
  await mkdir(join(dir, "decisions"), { recursive: true });
  // one good record, one torn/partial line (crash mid-append), one more good record
  const good1 = JSON.stringify({ id: "a", timestamp: "t1", kind: "note", summary: "first", status: "note" });
  const good2 = JSON.stringify({ id: "b", timestamp: "t2", kind: "note", summary: "second", status: "note" });
  await writeFile(join(dir, "decisions", "log.jsonl"), `${good1}\n{"id":"b","timestamp":\n${good2}\n`);
  const { DecisionLog } = await import("../src/state/decisionLog.js");
  const all = await new DecisionLog().all();
  assert.equal(all.length, 2, "both good records survive the corrupt middle line");
  assert.deepEqual(all.map((r) => r.id), ["a", "b"]);
});
