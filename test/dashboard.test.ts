import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState } from "../src/state/types.js";
import { buildInsights } from "../src/insights/engine.js";
import { renderDashboard } from "../src/coach/dashboard.js";
import type { Finding } from "../src/insights/metrics.js";

const NASTY = `O'Brien "5x3'" \\ </script><b>x</b>`; // apostrophe, quote, backslash, tag, </script>

function render(): string {
  const s = emptyState("2026-06-08", new Date().toISOString());
  s.raw = { getRaceGoalEvent: { goals: [{ event_name: NASTY, event_date: "2026-07-11", priority: "A" }] } };
  const ins = buildInsights(s, undefined, {});
  ins.topFindings.unshift({ family: "Load & injury risk", title: NASTY, severity: "flag", detail: "ratio 1.7", evidence: "e", confidence: 0.8, recommendation: "Cut the hardest session." } as Finding);
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

test("adversarial finding/goal text can't break handlers or inject markup (Spec 3)", () => {
  const html = render();
  // The raw nasty string must NOT appear verbatim anywhere (everything is escaped).
  assert.ok(!html.includes(NASTY), "nasty string must be escaped, never literal");
  // No raw </script> that would end the script context early.
  assert.ok(!html.includes("</script><b>x</b>"), "no unescaped injected tag");
  // Feedback buttons carry data-* not quoted JS-string args.
  assert.match(html, /data-reaction="agree" onclick="feedback\(this\)"/);
  assert.match(html, /data-summary="/);
  // The page still has valid scripts (this is the test that would FAIL pre-fix on the apostrophe).
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const [i, sc] of scripts.entries()) assert.doesNotThrow(() => new Function(sc), `script ${i}`);
});
