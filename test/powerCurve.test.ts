import { test } from "node:test";
import assert from "node:assert/strict";
import { bestAvgPower, meanMaximalCurve } from "../src/insights/powerCurve.js";

test("bestAvgPower: best contiguous window, gaps as zero, too-short stream → null", () => {
  assert.equal(bestAvgPower([100, 200, 300, 400], 2), 350); // (300+400)/2
  assert.equal(bestAvgPower([100, 200, 300, 400], 4), 250); // whole-stream avg
  assert.equal(bestAvgPower([100, 200, 300, 400], 5), null); // shorter than the window
  assert.equal(bestAvgPower([undefined, 100, 100], 1), 100); // a gap doesn't beat real power
  assert.equal(bestAvgPower([200, undefined, 200], 2), 100); // gap counted as 0: (200+0)/2
});

test("meanMaximalCurve: per-duration max across activities, with the winning date", () => {
  const acts = [
    { date: "2024-01-01", watts: [400, 400, 100, 100] }, // short & punchy
    { date: "2024-02-01", watts: [200, 200, 200, 200, 200, 200] }, // longer & steady
  ];
  const curve = meanMaximalCurve(acts, [1, 2, 4, 6]);
  assert.deepEqual(curve, [
    { durationSec: 1, watts: 400, date: "2024-01-01" },
    { durationSec: 2, watts: 400, date: "2024-01-01" },
    { durationSec: 4, watts: 250, date: "2024-01-01" }, // (400+400+100+100)/4
    { durationSec: 6, watts: 200, date: "2024-02-01" }, // only the 6-sample activity reaches 6s
  ]);
});

test("meanMaximalCurve: no power anywhere → empty curve (no fabricated points)", () => {
  assert.deepEqual(meanMaximalCurve([{ date: "2024-01-01", watts: [undefined, undefined] }], [1, 2]), []);
  assert.deepEqual(meanMaximalCurve([], [5, 60]), []);
});
