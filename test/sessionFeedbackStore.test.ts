import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The session-feedback JSONL store backs the dashboard's "Last session" card (no LLM on render). It must
 * round-trip records, stamp the schema version, tolerate a malformed line rather than throw (a half-written
 * append must not blank the whole history), and degrade to [] when the log is absent. latestByDate collapses
 * the append-only history to the newest record per session date. Data dir is a temp dir per the store.test.ts
 * convention (config.dataDir is read lazily, so mutating it before the call is enough).
 */

async function withTmpDataDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "coach-sessfb-"));
  const { config } = await import("../src/config.js");
  (config as { dataDir: string }).dataDir = dir;
  await mkdir(dir, { recursive: true });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("saveSessionFeedback → loadSessionFeedbacks round-trips and stamps the schema version", async () => {
  const { dir, cleanup } = await withTmpDataDir();
  const { saveSessionFeedback, loadSessionFeedbacks, SESSION_FEEDBACK_SCHEMA_VERSION } = await import(
    "../src/coach/sessionFeedbackStore.js"
  );

  await saveSessionFeedback({ date: "2026-06-18", sport: "Ride", deep: true, generatedAt: "2026-06-18T18:00:00Z", costUsd: 0.012, markdown: "Solid endurance ride." });
  await saveSessionFeedback({ date: "2026-06-19", sport: "Run", deep: false, generatedAt: "2026-06-19T07:00:00Z", costUsd: 0.004, markdown: "Easy shakeout." });

  const recs = await loadSessionFeedbacks();
  assert.equal(recs.length, 2);
  assert.equal(recs[0].date, "2026-06-18");
  assert.equal(recs[0].markdown, "Solid endurance ride.");
  assert.equal(recs[0].schemaVersion, SESSION_FEEDBACK_SCHEMA_VERSION, "schema version stamped on write");
  assert.equal(recs[1].sport, "Run");

  await cleanup();
  void dir;
});

test("loadSessionFeedbacks skips a malformed JSONL line instead of failing the whole read", async () => {
  const { dir, cleanup } = await withTmpDataDir();
  const { loadSessionFeedbacks } = await import("../src/coach/sessionFeedbackStore.js");

  const good = JSON.stringify({ schemaVersion: 1, date: "2026-06-18", sport: "Ride", deep: true, generatedAt: "2026-06-18T18:00:00Z", costUsd: 0.01, markdown: "ok" });
  // good line, a torn/half-written line, a blank line, then another good line
  await writeFile(join(dir, "session-feedback.jsonl"), good + "\n{ not valid json\n\n" + good.replace("06-18", "06-19") + "\n");

  const recs = await loadSessionFeedbacks();
  assert.equal(recs.length, 2, "two valid records survive; the malformed and blank lines are dropped");
  assert.deepEqual(
    recs.map((r) => r.date),
    ["2026-06-18", "2026-06-19"],
  );

  await cleanup();
});

test("loadSessionFeedbacks returns [] when the log file is absent", async () => {
  const { cleanup } = await withTmpDataDir();
  const { loadSessionFeedbacks } = await import("../src/coach/sessionFeedbackStore.js");
  assert.deepEqual(await loadSessionFeedbacks(), []);
  await cleanup();
});

test("latestByDate keeps the most recent generatedAt per session date", async () => {
  const { latestByDate } = await import("../src/coach/sessionFeedbackStore.js");
  const recs = [
    { schemaVersion: 1, date: "2026-06-18", sport: "Ride", deep: false, generatedAt: "2026-06-18T18:00:00Z", costUsd: 0.01, markdown: "first pass (summary only)" },
    { schemaVersion: 1, date: "2026-06-18", sport: "Ride", deep: true, generatedAt: "2026-06-18T20:00:00Z", costUsd: 0.02, markdown: "regenerated with .FIT" },
    { schemaVersion: 1, date: "2026-06-17", sport: "Swim", deep: true, generatedAt: "2026-06-17T19:00:00Z", costUsd: 0.02, markdown: "swim" },
  ];
  const m = latestByDate(recs);
  assert.equal(m.size, 2);
  assert.equal(m.get("2026-06-18")?.markdown, "regenerated with .FIT", "newer generatedAt wins");
  assert.equal(m.get("2026-06-18")?.deep, true);
  assert.equal(m.get("2026-06-17")?.sport, "Swim");
});
