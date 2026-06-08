import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState } from "../src/state/types.js";
import { buildInsights } from "../src/insights/engine.js";
import { renderDashboard } from "../src/coach/dashboard.js";
import type { Finding } from "../src/insights/metrics.js";

function render(): string {
  const s = emptyState("2026-06-08", new Date().toISOString());
  s.raw = {};
  const ins = buildInsights(s, undefined, {});
  ins.topFindings.unshift({ family: "Load & injury risk", title: "Overreaching", severity: "flag", detail: "ratio 1.7", evidence: "e", confidence: 0.8, recommendation: "Cut the hardest session." } as Finding);
  ins.load = { ctl: 32, atl: 45, tsb: -13, rampPerWeek: 3, series: [{ date: "a", ctl: 30 }] } as never;
  return renderDashboard({ window: [s], decisions: [], insights: ins });
}

test("every inline <script> in the dashboard is syntactically valid JS", () => {
  const html = render();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 2, "has script blocks");
  for (const [i, sc] of scripts.entries()) {
    // new Function throws on a syntax error — the failure mode that silently killed Ask/feedback/act.
    assert.doesNotThrow(() => new Function(sc), `script block ${i} must parse`);
  }
});

test("dashboard renders the action button + its handlers, no undefined/NaN", () => {
  const html = render();
  assert.match(html, /Turn this into a plan change/);
  assert.match(html, /async function actPlan\(\)/);
  assert.match(html, /confirmProposal\(this\)/); // no quote-escaped id arg
  assert.ok(!html.includes("undefined") && !html.includes("NaN"));
});
