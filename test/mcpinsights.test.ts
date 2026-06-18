import { test } from "node:test";
import assert from "node:assert/strict";
import { insightFindings } from "../src/coach/deepDive.js";
import type { InsightReport } from "../src/insights/engine.js";
import type { Finding } from "../src/insights/metrics.js";
import type { InsightReaction } from "../src/state/decisionLog.js";

function report(f: Finding): InsightReport {
  return { topFindings: [f], findings: [f] } as unknown as InsightReport;
}

test("insightFindings: MCP ctx annotates each top finding with key, age and saved reaction", () => {
  const f: Finding = { family: "Durability", title: "Run durability slipping", severity: "watch", detail: "d", evidence: "e", confidence: 0.7, key: "dur" };
  const out = insightFindings(report(f), {
    firstSeen: new Map([["dur", new Date(Date.now() - 5 * 86_400_000).toISOString()]]),
    reactions: new Map<string, InsightReaction>([["dur", "disagree"]]),
  });
  assert.match(out, /key=dur/); // an agent can target it
  assert.match(out, /5d old/);
  assert.match(out, /your call: 👎 disliked/);
});

test("insightFindings: a finding with no first-seen reads as NEW; no ctx = no annotation (deep-dive prompt)", () => {
  const f: Finding = { family: "X", title: "Y", severity: "info", detail: "d", evidence: "e", key: "y" };
  assert.match(insightFindings(report(f), { firstSeen: new Map() }), /key=y · NEW/);
  assert.ok(!insightFindings(report(f)).includes("key="));
});
