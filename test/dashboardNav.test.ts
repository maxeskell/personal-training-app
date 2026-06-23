import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

// Same hermetic isolation as dashboard.test.ts: keep buildInsights() from reading the runner's real
// FIT streams (see that file's header for the full rationale).
process.env.FIT_STREAMS_DIR = mkdtempSync(joinPath(tmpdir(), "coach-navtest-"));

import { emptyState } from "../src/state/types.js";
import { buildInsights } from "../src/insights/engine.js";
import { renderDashboard } from "../src/coach/dashboard.js";
import { renderCareerPage } from "../src/coach/careerPage.js";
import { renderSeasonPage } from "../src/coach/seasonPage.js";
import type { SeasonArcReport } from "../src/coach/seasonArc.js";
import type { CareerHistory } from "../src/coach/careerHistory.js";
import type { Finding } from "../src/insights/metrics.js";
import type { Profile } from "../src/profile/schema.js";

const baseState = () => emptyState("2026-06-18", new Date().toISOString());
const watch = (o: Partial<Finding>): Finding => ({ family: "A", title: "t", severity: "watch", detail: "d", evidence: "e", confidence: 0.7, ...o });
// A minimal season report / career history — just enough for the fold to render its wrapper + heading.
const MIN_SEASON = { hasPlan: false, levers: [], flags: [], trajectory: [] } as unknown as SeasonArcReport;
const MIN_CAREER = { races: [], bests: [] } as unknown as CareerHistory;

test("nav: the four IA sections render in order, Fitness is renamed Performance, old top-nav links are gone", () => {
  const html = renderDashboard({ window: [baseState()], decisions: [] });
  for (const id of ["today", "plan", "decide", "performance"]) {
    assert.match(html, new RegExp(`class="nav-link[^"]*" href="#${id}" data-tab="${id}"`), `nav has the ${id} tab`);
  }
  assert.match(html, />Performance</);
  assert.doesNotMatch(html, />Fitness</);
  // The old standalone "Career & PBs →" / "Season arc →" header links are folded into the tabs now.
  assert.doesNotMatch(html, /Career &amp; PBs →/);
  assert.doesNotMatch(html, /Season arc →/);
});

test("tabs: four panels render, Today is the default-open one, and it degrades to a scroll without JS", () => {
  const html = renderDashboard({ window: [baseState()], decisions: [] });
  assert.match(html, /<section id="tab-today" class="tab on">/);
  assert.match(html, /<section id="tab-plan" class="tab">/);
  assert.match(html, /<section id="tab-decide" class="tab">/);
  assert.match(html, /<section id="tab-performance" class="tab">/);
  // Panels are only hidden once the tab script adds body.js — no-JS shows every panel (a long scroll).
  assert.match(html, /body\.js \.tab\{display:none\}/);
  // Print forces every panel open so a Save-as-PDF captures the whole document.
  assert.match(html, /body\.js \.tab\{display:block !important\}/);
});

test("scripts: the tab switcher is its own block (so the function bundle stays side-effect-free), all parse", () => {
  const s = baseState();
  const ins = buildInsights(s, undefined, {});
  const html = renderDashboard({ window: [s], decisions: [], insights: ins, autoSyncStaleMin: 95 });
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script(?:\s[^>]*)?>/gi)].map((m) => m[1]);
  assert.ok(scripts.length >= 3, "function bundle + sync + tab switcher + on-load trigger");
  for (const [i, sc] of scripts.entries()) assert.doesNotThrow(() => new Function(sc), `script ${i} must parse`);
  const bundle = scripts.find((sc) => sc.includes("function mdToHtml"));
  assert.ok(bundle, "the function bundle is present");
  // The DOM-touching tab IIFE must NOT be in the mdToHtml block — that block gets *executed* by another
  // test (mdToHtml eval), and document/location don't exist there.
  assert.ok(!bundle!.includes("classList.add('js')"), "tab init lives in its own block");
  assert.ok(scripts.some((sc) => sc.includes("getElementById('tab-")), "the tab switcher block exists");
});

test("Plan tab folds in the season arc when a report is supplied; absent → no fold", () => {
  const html = renderDashboard({ window: [baseState()], decisions: [], seasonReport: MIN_SEASON });
  assert.match(html, /<div class="section-rule-label">Season arc<\/div>/);
  assert.match(html, /class="season-inner"/);
  assert.ok(!renderDashboard({ window: [baseState()], decisions: [] }).includes('class="season-inner"'));
});

test("Performance tab folds in career history when supplied; absent → no fold", () => {
  const html = renderDashboard({ window: [baseState()], decisions: [], career: MIN_CAREER });
  assert.match(html, /<div class="section-rule-label">Career &amp; PBs<\/div>/);
  assert.match(html, /class="career-inner"/);
  assert.ok(!renderDashboard({ window: [baseState()], decisions: [] }).includes('class="career-inner"'));
});

test("Decide is one unified inbox: insights + the setup hub live under #tab-decide with one agree/disagree/ignore UX", () => {
  const s = baseState();
  const ins = buildInsights(s, undefined, {});
  ins.topFindings = [watch({ family: "Durability", title: "Run durability slipping" })];
  const profile = { schema_version: 1, identity: {}, ai_endurance_todo: { swim_css: "not_set" } } as Profile;
  const html = renderDashboard({ window: [s], decisions: [], insights: ins, profile });
  // Isolate the Decide section and assert both surfaces + the shared reaction vocabulary live inside it.
  const decide = html.slice(html.indexOf('id="tab-decide"'), html.indexOf('id="tab-performance"'));
  assert.match(decide, /one inbox/);
  assert.match(decide, /Top insights — your call/);
  assert.match(decide, /Set up &amp; improve/);
  assert.match(decide, /data-reaction="like"/);
  assert.match(decide, /data-reaction="dislike"/);
});

test("Today: a 'needs your call' teaser deep-links to Decide with an honest count; the nav badges the same number", () => {
  const s = baseState();
  const ins = buildInsights(s, undefined, {});
  ins.topFindings = [watch({ family: "A", title: "t1" }), watch({ family: "B", title: "t2" })];
  const html = renderDashboard({ window: [s], decisions: [], insights: ins });
  assert.match(html, /data-tab="decide" href="#decide"[^>]*>📥 2 items waiting on your call/);
  assert.match(html, /data-tab="decide">Decide<span class="count">2<\/span>/);
  // Singular reads "1 item".
  const one = renderDashboard({ window: [s], decisions: [], insights: { ...ins, topFindings: [watch({ title: "solo" })] } });
  assert.match(one, /📥 1 item waiting on your call/);
});

test("share view: no inbox badge or teaser, and the interactive Sync + Ask controls are dropped", () => {
  const s = baseState();
  const ins = buildInsights(s, undefined, {});
  ins.topFindings = [watch({ title: "t1" })];
  const html = renderDashboard({ window: [s], decisions: [], insights: ins, share: true });
  assert.ok(!html.includes("📥"), "no teaser in share view (the 📥 marker is the teaser's alone)");
  assert.ok(!html.includes('class="count"'), "no nav badge in share view");
  assert.ok(!/Sync latest data/.test(html), "no Sync control (nor its handler string) in share view");
  assert.ok(!html.includes('class="askbar"'), "no Ask bar in share view");
  // The nav itself still rides every link with the share flag so the redacted view survives navigation.
  assert.match(html, /href="\?share=1#plan"/);
});

test("standalone /career + /season pages now carry the shared nav, highlighting their home tab", () => {
  const career = renderCareerPage(null); // empty-state still wears the full shell
  assert.match(career, /<nav class="nav">/);
  assert.match(career, /class="nav-link on" href="\/#performance" data-tab="performance"/);
  const season = renderSeasonPage(MIN_SEASON);
  assert.match(season, /<nav class="nav">/);
  assert.match(season, /class="nav-link on" href="\/#plan" data-tab="plan"/);
});
