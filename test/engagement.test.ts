import { test } from "node:test";
import assert from "node:assert/strict";
import { surfaceFindings, type Finding } from "../src/insights/metrics.js";
import { engagementFindings } from "../src/insights/engagement.js";
import { buildInsights } from "../src/insights/engine.js";
import { emptyState } from "../src/state/types.js";

test("surfaceFindings: engagement weights reorder WITHIN a tier but never bury a flag", () => {
  const fs: Finding[] = [
    { family: "Dismissed", title: "watch A", severity: "watch", detail: "d", evidence: "e", confidence: 0.8 },
    { family: "Engaged", title: "watch B", severity: "watch", detail: "d", evidence: "e", confidence: 0.7 },
    { family: "Dismissed", title: "flag C", severity: "flag", detail: "d", evidence: "e", confidence: 0.5 },
  ];
  // No weights → plain score sort (watch A 0.56 > flag C 0.5 > watch B 0.49).
  assert.deepEqual(surfaceFindings(fs).map((f) => f.title), ["watch A", "flag C", "watch B"]);

  // With weights: the flag leads (severity tier always wins, and flags are never down-weighted) even
  // though it's in the dismissed family; among the watches, the engaged one now outranks the dismissed.
  const weights = new Map([["Dismissed", 0.7], ["Engaged", 1.2]]);
  assert.deepEqual(surfaceFindings(fs, new Set(), 0.5, weights).map((f) => f.title), ["flag C", "watch B", "watch A"]);
});

test("engagementFindings: recurring (≥2) + adherence slipping generate dismissable watch findings", () => {
  const out = engagementFindings({
    recurringDismissed: [
      { key: "durability-slipping", family: "Durability", title: "Run durability slipping", times: 3, reaction: "ignore" },
      { key: "x", family: "X", title: "X", times: 1, reaction: "disagree" }, // below the ≥2 bar
    ],
    adherence: { pct: 0.6, priorPct: 0.8, deltaPts: -20, plannedH: 10 },
  });
  assert.equal(out.length, 2);
  assert.ok(out.every((f) => f.family === "Follow-through" && f.severity === "watch" && f.key));
  assert.ok(out.some((f) => f.title === "Recurring signal you've set aside: Run durability slipping"));
  assert.ok(out.some((f) => f.title === "Plan adherence is slipping" && f.detail.includes("60%")));
});

test("engagementFindings: empty / healthy / trivial-plan contexts produce nothing", () => {
  assert.deepEqual(engagementFindings(undefined), []);
  assert.deepEqual(engagementFindings({}), []);
  assert.deepEqual(engagementFindings({ adherence: { pct: 0.95, priorPct: 0.95, deltaPts: 0, plannedH: 10 } }), []);
  // low adherence but a trivially small plan block → no nag
  assert.deepEqual(engagementFindings({ adherence: { pct: 0.2, priorPct: null, deltaPts: null, plannedH: 1 } }), []);
});

test("buildInsights: an engagement context injects Follow-through findings and surfaces them (loop closed)", () => {
  const state = emptyState("2026-06-11", "2026-06-11T06:00:00.000Z");
  const report = buildInsights(state, undefined, {
    engagement: {
      familyWeights: new Map(),
      recurringDismissed: [{ key: "k", family: "Durability", title: "Run durability slipping", times: 3, reaction: "ignore" }],
      adherence: { pct: 0.5, priorPct: 0.8, deltaPts: -30, plannedH: 10 },
    },
  });
  assert.equal(report.topFindings.filter((f) => f.family === "Follow-through").length, 2);
  assert.ok(report.topFindings.some((f) => f.title === "Plan adherence is slipping"));
});

test("buildInsights: with no engagement context, behaviour is unchanged (no Follow-through findings)", () => {
  const report = buildInsights(emptyState("2026-06-11", "2026-06-11T06:00:00.000Z"));
  assert.equal(report.topFindings.filter((f) => f.family === "Follow-through").length, 0);
});
