import { test } from "node:test";
import assert from "node:assert/strict";
import { corrPValue, benjaminiHochberg, circularShift, mulberry32, trailingZ, mean, sd, finiteNums } from "../src/insights/stats.js";

test("mean/sd/finiteNums basics", () => {
  assert.equal(mean([2, 4, 6]), 4);
  assert.equal(mean([]), null);
  assert.ok(Math.abs(sd([2, 4, 6])! - Math.sqrt(8 / 3)) < 1e-9, "population SD (÷n)");
  assert.equal(sd([5]), null);
  assert.deepEqual(finiteNums(["1", 2, null, "x", 3]), [1, 2, null, null, 3]);
});

test("corrPValue: strong correlation is significant, weak is not", () => {
  assert.ok(corrPValue(0.6, 30) < 0.01, "r=0.6 n=30 should be highly significant");
  assert.ok(corrPValue(0.1, 30) > 0.3, "r=0.1 n=30 should be non-significant");
  assert.equal(corrPValue(0.9, 3), 1, "too few points → p=1");
});

test("benjaminiHochberg controls discoveries at q", () => {
  const pass = benjaminiHochberg([0.001, 0.02, 0.2, 0.6, 0.9], 0.1);
  assert.deepEqual(pass, [true, true, false, false, false]);
  // All-null hypotheses (uniform-ish high p) → none pass.
  assert.deepEqual(benjaminiHochberg([0.4, 0.5, 0.6, 0.7], 0.1), [false, false, false, false]);
});

test("circularShift preserves length & content, wraps", () => {
  assert.deepEqual(circularShift([1, 2, 3, 4], 1), [4, 1, 2, 3]);
  assert.deepEqual(circularShift([1, 2, 3, 4], 4), [1, 2, 3, 4]);
  assert.deepEqual(circularShift([1, 2, 3, 4], 0), [1, 2, 3, 4]);
});

test("mulberry32 is deterministic for a seed", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  assert.ok(seqA.every((x) => x >= 0 && x < 1));
  // Different seed → different sequence.
  assert.notDeepEqual(seqA, [mulberry32(7)(), mulberry32(7)(), mulberry32(7)()]);
});

test("trailingZ flags a last-point deviation vs trailing baseline", () => {
  const flat = Array.from({ length: 30 }, () => 50);
  const z = trailingZ([...flat.slice(0, 29), 50]);
  assert.ok(z == null || Math.abs(z.z) < 0.001, "flat series → ~0 z (or null if sd 0)");
  const spike = trailingZ([...flat.slice(0, 29).map((v, i) => 50 + (i % 2)), 60]);
  assert.ok(spike != null && spike.z > 2, "a clear spike → high z");
  assert.equal(trailingZ([1, 2, 3]), null, "too short → null");
});
