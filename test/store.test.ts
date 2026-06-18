import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("StateStore.load normalises an old-schema state (missing new slots → absent, not undefined)", async () => {
  // Point the store's data dir at a temp dir via the config module.
  const dir = await mkdtemp(join(tmpdir(), "coach-store-"));
  const { config } = await import("../src/config.js");
  (config as { dataDir: string }).dataDir = dir;
  await mkdir(join(dir, "state"), { recursive: true });

  // A minimal pre-Phase-2 state: only a couple of slots, none of the new ones.
  const old = { date: "2026-06-01", assembledAt: "2026-06-01T06:00:00Z", hrvOvernight: { value: 40, source: "garmin" } };
  await writeFile(join(dir, "state", "2026-06-01.json"), JSON.stringify(old));

  const { StateStore } = await import("../src/state/store.js");
  const s = await new StateStore().load("2026-06-01");
  assert.ok(s, "loads");
  // Preserved original field…
  assert.equal(s!.hrvOvernight.value, 40);
  // …and every new slot is present as a readable provenance object (no `.value` crash).
  for (const slot of ["zones", "thresholds", "trainingStatus", "hrvStatus", "powerCurve", "enduranceScore", "hillScore", "racePredictions"] as const) {
    assert.ok(slot in s!, `${slot} present`);
    assert.doesNotThrow(() => (s as Record<string, { value: unknown }>)[slot].value);
  }

  await rm(dir, { recursive: true, force: true });
});

test("StateStore.load shape-guards a corrupt/hand-edited slot back to absent (no crash for consumers)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coach-store-"));
  const { config } = await import("../src/config.js");
  (config as { dataDir: string }).dataDir = dir;
  await mkdir(join(dir, "state"), { recursive: true });

  // hrvOvernight hand-edited to a bare number (not a {value,source} wrapper); restingHr is a valid slot.
  const corrupt = {
    date: "2026-06-02",
    assembledAt: "2026-06-02T06:00:00Z",
    hrvOvernight: 42, // malformed — must be dropped to absent, not passed through
    restingHr: { value: 48, source: "garmin" },
  };
  await writeFile(join(dir, "state", "2026-06-02.json"), JSON.stringify(corrupt));

  const { StateStore } = await import("../src/state/store.js");
  const s = await new StateStore().load("2026-06-02");
  assert.ok(s, "loads");
  assert.doesNotThrow(() => s!.hrvOvernight.value, "malformed slot reads as a provenance object");
  assert.equal(s!.hrvOvernight.value, null, "corrupt slot dropped to absent()");
  assert.equal(s!.restingHr.value, 48, "a valid slot is preserved");

  await rm(dir, { recursive: true, force: true });
});
