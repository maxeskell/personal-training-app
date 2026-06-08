import { test } from "node:test";
import assert from "node:assert/strict";
import { validateWrite, PROPOSABLE_WRITE_TOOLS } from "../src/guardrails/writeValidators.js";
import { validateProposals } from "../src/coach/planAdjust.js";
import type { PlannedSession } from "../src/state/types.js";

const planned: PlannedSession[] = [
  { workoutId: "8034343", date: "2026-06-10", title: "Threshold Run", sport: "Run", durationMin: 50 },
  { workoutId: "8034344", date: "2026-06-11", title: "Endurance Ride", sport: "Ride" },
];

test("validateWrite: accepts a real workout + well-formed args, with a human summary", () => {
  const v = validateWrite("changeWorkoutDate", { workoutId: "8034343", newDate: "2026-06-12" }, planned);
  assert.equal(v.ok, true);
  assert.match(v.human!, /Threshold Run/);
  assert.match(v.human!, /2026-06-12/);
  assert.equal(validateWrite("skipWorkout", { workoutId: "8034344" }, planned).ok, true);
  assert.equal(validateWrite("changeWorkoutAdvice", { workoutId: "8034343", advice: "easy" }, planned).ok, true);
});

test("validateWrite: rejects hallucinated id, bad date, empty advice, and non-proposable tools", () => {
  assert.equal(validateWrite("changeWorkoutDate", { workoutId: "999", newDate: "2026-06-12" }, planned).ok, false);
  assert.equal(validateWrite("changeWorkoutDate", { workoutId: "8034343", newDate: "next tuesday" }, planned).ok, false);
  assert.equal(validateWrite("changeWorkoutAdvice", { workoutId: "8034343", advice: "  " }, planned).ok, false);
  // createRideRunWorkoutAdvanced (and any create*/setZones) is NOT proposable.
  assert.equal(validateWrite("createRideRunWorkoutAdvanced", { dateStr: "2026-06-12" }, planned).ok, false);
  assert.ok(!(PROPOSABLE_WRITE_TOOLS as readonly string[]).includes("createRideRunWorkoutAdvanced"));
});

test("validateProposals: only valid proposals pass; the rest are reported", () => {
  const raw = [
    { summary: "Move threshold run", tradeoff: "two easy days first", tool: "changeWorkoutDate", argsJson: '{"workoutId":"8034343","newDate":"2026-06-12"}' },
    { summary: "Skip a phantom session", tradeoff: "—", tool: "skipWorkout", argsJson: '{"workoutId":"00000"}' },
    { summary: "Do something dangerous", tradeoff: "—", tool: "setZones", argsJson: '{"actType":"Run"}' },
  ];
  const { valid, rejected } = validateProposals(raw, planned);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].tool, "changeWorkoutDate");
  assert.match(valid[0].human, /Threshold Run/);
  assert.equal(rejected.length, 2); // phantom id + non-proposable tool
});
