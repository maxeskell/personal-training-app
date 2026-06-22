import { test } from "node:test";
import assert from "node:assert/strict";
import { cosineSimilarity, clusterAdvice, clustersToDisplay } from "../src/coach/adviceRecs.js";
import type { SurfacedFinding } from "../src/state/insightLog.js";

const sf = (key: string): SurfacedFinding => ({ key, family: "General", title: key, severity: "info", detail: "d", evidence: "e" });

test("cosineSimilarity: identical → 1, orthogonal → 0, opposite → -1", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-9);
});

test("cosineSimilarity: a length mismatch or a zero-magnitude vector is 0 (never NaN)", () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.equal(cosineSimilarity([], []), 0);
});

test("clusterAdvice: collapses the same idea across sources; the most-timely source is the representative", () => {
  const recs = [sf("advice:deep-dive:rest"), sf("advice:readiness:rest"), sf("advice:ask:fuel")];
  const index = new Map<string, number[]>([
    ["advice:deep-dive:rest", [1, 0]],
    ["advice:readiness:rest", [1, 0]], // identical → same idea as the deep-dive one
    ["advice:ask:fuel", [0, 1]], // orthogonal → a distinct idea
  ]);
  const clusters = clusterAdvice(recs, index, 0.86);
  assert.equal(clusters.length, 2);
  // readiness (most timely) wins as rep over the deep-dive duplicate
  assert.equal(clusters[0].rep.key, "advice:readiness:rest");
  assert.deepEqual(clusters[0].merged.map((m) => m.key), ["advice:deep-dive:rest"]);
  assert.equal(clusters[1].rep.key, "advice:ask:fuel");
  assert.equal(clusters[1].merged.length, 0);
});

test("clusterAdvice: NEVER merges within the same source (independent reactions preserved)", () => {
  const recs = [sf("advice:readiness:a"), sf("advice:readiness:b")];
  const index = new Map<string, number[]>([
    ["advice:readiness:a", [1, 0]],
    ["advice:readiness:b", [1, 0]], // identical, but same source → stay separate
  ]);
  const clusters = clusterAdvice(recs, index, 0.86);
  assert.equal(clusters.length, 2);
});

test("clusterAdvice: respects the threshold (>= merges, below doesn't)", () => {
  const recs = [sf("advice:readiness:a"), sf("advice:ask:b")];
  // cos([1,0],[3,1]) = 3/sqrt(10) ≈ 0.9487
  const index = new Map<string, number[]>([
    ["advice:readiness:a", [1, 0]],
    ["advice:ask:b", [3, 1]],
  ]);
  assert.equal(clusterAdvice(recs, index, 0.9).length, 1, "≈0.95 ≥ 0.9 → merged");
  assert.equal(clusterAdvice(recs, index, 0.97).length, 2, "≈0.95 < 0.97 → separate");
});

test("clusterAdvice: a finding with no vector is never merged (partial/empty index degrades to singletons)", () => {
  const recs = [sf("advice:readiness:a"), sf("advice:ask:b")];
  // 'b' has no vector → can't be clustered even though 'a' does
  const partial = new Map<string, number[]>([["advice:readiness:a", [1, 0]]]);
  assert.equal(clusterAdvice(recs, partial, 0.5).length, 2);
  // empty index → every rec is its own cluster
  assert.equal(clusterAdvice(recs, new Map(), 0.5).length, 2);
});

test("clustersToDisplay: representatives in order; merged map only carries reps that absorbed something", () => {
  const recs = [sf("advice:deep-dive:rest"), sf("advice:readiness:rest"), sf("advice:ask:fuel")];
  const index = new Map<string, number[]>([
    ["advice:deep-dive:rest", [1, 0]],
    ["advice:readiness:rest", [1, 0]],
    ["advice:ask:fuel", [0, 1]],
  ]);
  const { display, merged } = clustersToDisplay(clusterAdvice(recs, index, 0.86));
  assert.deepEqual(display.map((f) => f.key), ["advice:readiness:rest", "advice:ask:fuel"]);
  assert.deepEqual([...merged.keys()], ["advice:readiness:rest"]);
  assert.equal(merged.has("advice:ask:fuel"), false, "a singleton rep is not in the merged map");
});
