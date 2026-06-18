import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
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

test("StateStore.save never persists the in-memory athlete profile (privacy: medical data stays off disk)", async () => {
  const dir = await tmpDataDir();
  const { StateStore } = await import("../src/state/store.js");
  const { emptyState } = await import("../src/state/types.js");
  const store = new StateStore();
  const s = emptyState("2026-06-09", new Date().toISOString());
  // Attach a profile carrying personal/medical data BEFORE saving — the store must drop it regardless.
  (s as { profile?: unknown }).profile = {
    schema_version: 1,
    identity: { name: "Real Person", date_of_birth: "1989-04-02", location: "Realtown" },
    health: { medication: { name: "secret-drug", dose_day: "sunday" } },
  };
  await store.save(s);
  const raw = await readFile(join(dir, "state", "2026-06-09.json"), "utf8");
  assert.doesNotMatch(raw, /profile|secret-drug|Real Person|1989-04-02|medication/, "no profile field reaches disk");
  // The slot is gone on reload too (it's attached fresh in-memory, never read back from the store).
  const loaded = await store.load("2026-06-09");
  assert.equal((loaded as { profile?: unknown }).profile, undefined, "loaded state has no profile");
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
