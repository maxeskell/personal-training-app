import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The write gate is the ONLY barrier between an LLM-proposed plan change and a live mutation of AI
 * Endurance (CLAUDE.md: "every write is gated"). These tests pin its load-bearing invariants — they were
 * previously untested, so a refactor could silently break the propose→confirm two-step.
 */

async function freshLog() {
  const dir = await mkdtemp(join(tmpdir(), "coach-wg-"));
  const { config } = await import("../src/config.js");
  (config as { dataDir: string }).dataDir = dir;
  const { DecisionLog } = await import("../src/state/decisionLog.js");
  return new DecisionLog();
}

function fakeAie() {
  const calls: Array<{ tool: string; args: unknown }> = [];
  return { calls, callRaw: async (tool: string, args: unknown) => { calls.push({ tool, args }); return { ok: true }; } };
}

test("WriteGate.propose() logs a proposal but fires NO write", async () => {
  const log = await freshLog();
  const { WriteGate } = await import("../src/guardrails/writeGate.js");
  const aie = fakeAie();
  const gate = new WriteGate(aie as never, log);
  await gate.propose({ tool: "skipWorkout", args: { workoutId: "1" }, rationale: "r", tradeoff: "t", human: "Skip X" });
  assert.equal(aie.calls.length, 0, "propose must never call the API");
  assert.equal((await log.all()).at(-1)?.status, "proposed");
});

test("WriteGate: propose → confirm fires the write exactly once and marks it executed", async () => {
  const log = await freshLog();
  const { WriteGate } = await import("../src/guardrails/writeGate.js");
  const aie = fakeAie();
  const gate = new WriteGate(aie as never, log);
  const p = await gate.propose({ tool: "skipWorkout", args: { workoutId: "9" }, rationale: "r", tradeoff: "t" });
  await gate.confirm(p.id);
  assert.equal(aie.calls.length, 1);
  assert.deepEqual(aie.calls[0], { tool: "skipWorkout", args: { workoutId: "9" } });
  assert.equal((await log.all()).filter((r) => r.id === p.id).at(-1)?.status, "executed");
});

test("WriteGate.confirm() without a matching proposal throws and writes nothing", async () => {
  const log = await freshLog();
  const { WriteGate } = await import("../src/guardrails/writeGate.js");
  const aie = fakeAie();
  const gate = new WriteGate(aie as never, log);
  await assert.rejects(() => gate.confirm("dec_doesnotexist"), /confirmable/i);
  assert.equal(aie.calls.length, 0);
});

test("WriteGate: confirmation is single-use — a second confirm is refused, no double write", async () => {
  const log = await freshLog();
  const { WriteGate } = await import("../src/guardrails/writeGate.js");
  const aie = fakeAie();
  const gate = new WriteGate(aie as never, log);
  const p = await gate.propose({ tool: "skipWorkout", args: {}, rationale: "r", tradeoff: "t" });
  await gate.confirm(p.id);
  await assert.rejects(() => gate.confirm(p.id), /confirmable/i);
  assert.equal(aie.calls.length, 1, "still exactly one write");
});

test("WriteGate: a declined proposal cannot be confirmed", async () => {
  const log = await freshLog();
  const { WriteGate } = await import("../src/guardrails/writeGate.js");
  const aie = fakeAie();
  const gate = new WriteGate(aie as never, log);
  const p = await gate.propose({ tool: "skipWorkout", args: {}, rationale: "r", tradeoff: "t" });
  await gate.decline(p.id);
  await assert.rejects(() => gate.confirm(p.id), /confirmable/i);
  assert.equal(aie.calls.length, 0);
});

test("WriteGate: cross-process — a fresh gate reconstructs the proposal from the append-only log and writes once", async () => {
  const log = await freshLog();
  const { WriteGate } = await import("../src/guardrails/writeGate.js");
  const aieA = fakeAie(), aieB = fakeAie();
  const gateA = new WriteGate(aieA as never, log);
  const p = await gateA.propose({ tool: "changeWorkoutDate", args: { workoutId: "5", newDate: "2026-07-01" }, rationale: "r", tradeoff: "t" });
  // Simulate a second CLI process: a new gate with empty in-memory state must resolve from the log.
  const gateB = new WriteGate(aieB as never, log);
  await gateB.confirm(p.id);
  assert.equal(aieB.calls.length, 1);
  assert.deepEqual(aieB.calls[0], { tool: "changeWorkoutDate", args: { workoutId: "5", newDate: "2026-07-01" } });
  assert.equal(aieA.calls.length, 0, "the proposing process never wrote");
});

test("WriteGate: a proposal older than the TTL is refused (stale-plan protection), no write fires", async () => {
  const log = await freshLog();
  const { WriteGate } = await import("../src/guardrails/writeGate.js");
  const aie = fakeAie();
  const gate = new WriteGate(aie as never, log);
  const id = "stale-1";
  const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString();
  await log.append({ id, timestamp: eightDaysAgo, kind: "plan-adjust", summary: "old", tradeoff: "t", write: { tool: "skipWorkout", args: { workoutId: "1" } }, status: "proposed" });
  await assert.rejects(() => gate.confirm(id), /expired/i);
  assert.equal(aie.calls.length, 0, "a stale proposal fires no write");
});

test("WriteGate.assertNoDirectWrite blocks a write tool from any non-gated path", async () => {
  const { WriteGate } = await import("../src/guardrails/writeGate.js");
  assert.throws(() => WriteGate.assertNoDirectWrite("skipWorkout"), /must go through WriteGate/);
  assert.doesNotThrow(() => WriteGate.assertNoDirectWrite("getPlannedWorkouts")); // a read tool is fine
});
