import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bestAvgPower,
  meanMaximalCurve,
  ftpProxyFromNp,
  plausibleCeilingW,
  isImplausibleRidePower,
  keepPlausibleRides,
  MIN_RIDES_FOR_FTP,
} from "../src/insights/powerCurve.js";

/** A ride of `n` seconds at a constant `w` watts (the per-second stream the guard inspects). */
const flat = (w: number, n: number): number[] => Array.from({ length: n }, () => w);

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

// ---------- power plausibility guard ----------

test("ftpProxyFromNp: p90 of ride NP, and robust to a few corrupt spikes", () => {
  // 40 genuine hard-ride NPs clustered ~180–212, plus 3 corrupt files at ~300–404 (the real 574019 cluster).
  const genuine = Array.from({ length: 40 }, (_, i) => 180 + i); // 180..219
  const corrupt = [295, 300, 404];
  const proxy = ftpProxyFromNp([...genuine, ...corrupt])!;
  // p90 lands in the genuine hard-ride band, NOT dragged up toward the corrupt tail.
  assert.ok(proxy >= 205 && proxy <= 220, `proxy ${proxy} should sit at the genuine hard rides`);
  // Removing the corrupt files barely moves it — that is the robustness the guard depends on.
  const clean = ftpProxyFromNp(genuine)!;
  assert.ok(Math.abs(proxy - clean) < 6, `proxy shifted ${Math.abs(proxy - clean)}W from 3 corrupt rows`);
});

test("ftpProxyFromNp: too little ride history → null (leave the curve unguarded)", () => {
  assert.equal(ftpProxyFromNp(Array.from({ length: MIN_RIDES_FOR_FTP - 1 }, () => 200)), null);
  assert.equal(ftpProxyFromNp([]), null);
  assert.ok(ftpProxyFromNp(Array.from({ length: MIN_RIDES_FOR_FTP }, () => 200)) != null);
});

test("plausibleCeilingW: scales with FTP, non-increasing with duration, ~1.2×FTP at 20 min", () => {
  assert.equal(plausibleCeilingW(1200, 200), 240); // 1.2× threshold anchor
  assert.equal(plausibleCeilingW(3600, 200), 230); // 1.15× at 60 min
  // A short window's ceiling is higher than a sustained one; 20 and 30 min are held level (see anchors).
  assert.ok(plausibleCeilingW(300, 200) > plausibleCeilingW(1200, 200));
  assert.equal(plausibleCeilingW(1800, 200), plausibleCeilingW(1200, 200)); // level 20↔30 min
  assert.ok(plausibleCeilingW(1200, 200) > plausibleCeilingW(3600, 200));
  // Linear in FTP.
  assert.equal(plausibleCeilingW(1200, 400), 480);
});

test("isImplausibleRidePower: flags the 574019-style corrupt ride, keeps a genuine hard ride", () => {
  const ftp = 211; // the athlete's robust FTP proxy
  // Corrupt 2023-12-17: ~406W sustained for 20 min — 1.9×FTP, physically impossible for this athlete.
  assert.equal(isImplausibleRidePower(flat(406, 1300), ftp), true);
  // The milder cluster members are caught too (255 and 299W over 20 min both exceed the 253W ceiling).
  assert.equal(isImplausibleRidePower(flat(299, 1300), ftp), true);
  assert.equal(isImplausibleRidePower(flat(255, 1300), ftp), true);
  // A genuine hard 20-min effort (~217W ≈ threshold) is NOT flagged.
  assert.equal(isImplausibleRidePower(flat(217, 1300), ftp), false);
  // A genuine endurance ride is not flagged.
  assert.equal(isImplausibleRidePower(flat(190, 4000), ftp), false);
});

test("isImplausibleRidePower: a short sprint is never flagged (sustained windows only)", () => {
  // 45s at 900W (5.9×FTP sprint) — too short to fill even the 5-min window, so the guard leaves it alone.
  assert.equal(isImplausibleRidePower(flat(900, 45), 200), false);
});

test("keepPlausibleRides: no FTP reference → nothing dropped (degrade, don't guess)", () => {
  const rides = [{ watts: flat(406, 1300) }, { watts: flat(200, 1300) }];
  assert.equal(keepPlausibleRides(rides, null).length, 2);
  assert.equal(keepPlausibleRides(rides, 0).length, 2);
});

test("guard end-to-end: a corrupt ride no longer wins the all-time curve", () => {
  // Reproduces the bug: a corrupt ride (406W/20min) and a genuine one (210W/20min) in the same corpus.
  const corrupt = { date: "2023-12-17", watts: flat(406, 1300) };
  const genuine = { date: "2025-06-01", watts: flat(210, 1300) };
  const durations = [1200];

  // Unguarded, the corrupt ride sets the 20-min point (the reported symptom).
  const before = meanMaximalCurve([corrupt, genuine], durations);
  assert.deepEqual(before, [{ durationSec: 1200, watts: 406, date: "2023-12-17" }]);

  // Guarded, the corrupt ride is removed and the curve reflects the genuine effort.
  const after = meanMaximalCurve(keepPlausibleRides([corrupt, genuine], 211), durations);
  assert.deepEqual(after, [{ durationSec: 1200, watts: 210, date: "2025-06-01" }]);
});
