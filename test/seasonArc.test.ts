import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSeasonArc, pickActivePhase, parseTarget, ctlTrend, seasonReportText, type SeasonArcInput } from "../src/coach/seasonArc.js";
import { renderSeasonPage } from "../src/coach/seasonPage.js";
import type { Profile, SeasonPlan } from "../src/profile/schema.js";
import type { CareerHistory } from "../src/coach/careerHistory.js";

const PLAN: SeasonPlan = {
  horizon_goal: "Ironman by 2028",
  target_date: "2028-07-01",
  phases: [
    { name: "Rebuild base", focus: "raise the aerobic floor", until: "2026-12-31", ctl_target: "55" },
    { name: "Threshold shift", focus: "20–60 min power", until: "2027-12-31", ctl_target: "70" },
    { name: "IM build", focus: "durability + volume", until: "2028-06-30", ctl_target: "85" },
  ],
};

const CAREER: CareerHistory = {
  races: [],
  bests: [],
  trajectory: [
    { year: 2013, hours: 390 },
    { year: 2019, hours: 42 },
    { year: 2025, hours: 210 },
    { year: 2026, hours: 120 },
  ],
};

const PROFILE = {
  schema_version: 1,
  health: { strength_sessions_per_week: 0, medication: { name: "GLP-1 agonist" } },
  ai_endurance_todo: { swim_css: "not_set" },
} as unknown as Profile;

const baseInput = (over: Partial<SeasonArcInput> = {}): SeasonArcInput => ({
  today: "2026-06-22",
  plan: PLAN,
  ctlNow: 42,
  ctlSeries: [
    { date: "2026-05-01", v: 38 },
    { date: "2026-06-22", v: 42 },
  ],
  career: CAREER,
  profile: PROFILE,
  ...over,
});

test("parseTarget pulls the first number from a target expression", () => {
  assert.equal(parseTarget("55"), 55);
  assert.equal(parseTarget("55-60"), 55);
  assert.equal(parseTarget("~55 by spring"), 55);
  assert.equal(parseTarget(undefined), undefined);
  assert.equal(parseTarget("none"), undefined);
});

test("pickActivePhase picks the first phase whose until-date is still ahead", () => {
  const p = pickActivePhase(PLAN, "2026-06-22");
  assert.equal(p?.name, "Rebuild base");
  assert.equal(p?.ctlTarget, 55);
  assert.ok((p?.daysLeft ?? 0) > 0);
  // a date inside the second phase window
  assert.equal(pickActivePhase(PLAN, "2027-03-01")?.name, "Threshold shift");
  // past all phases → falls back to the last
  assert.equal(pickActivePhase(PLAN, "2029-01-01")?.name, "IM build");
});

test("ctlTrend reads rising / falling / flat off the series", () => {
  assert.equal(ctlTrend([{ date: "2026-05-01", v: 38 }, { date: "2026-06-22", v: 45 }]), "rising");
  assert.equal(ctlTrend([{ date: "2026-05-01", v: 50 }, { date: "2026-06-22", v: 42 }]), "falling");
  assert.equal(ctlTrend([{ date: "2026-05-01", v: 42 }, { date: "2026-06-22", v: 43 }]), "flat");
  assert.equal(ctlTrend([{ date: "2026-06-22", v: 42 }]), undefined); // too few points
});

test("buildSeasonArc: full report — phase, CTL gap, peak benchmark, consistency cliff, levers, flags", () => {
  const r = buildSeasonArc(baseInput());
  assert.equal(r.hasPlan, true);
  assert.equal(r.horizonGoal, "Ironman by 2028");
  assert.equal(r.activePhase?.name, "Rebuild base");
  assert.equal(r.ctlTarget, 55);
  assert.equal(r.ctlGap, -13); // 42 − 55
  assert.equal(r.ctlTrend, "rising");
  assert.equal(r.peakYear?.year, 2013);
  // last COMPLETE year (2025, 210h) is 54% of the 390h peak → a consistency cliff
  assert.ok(r.consistencyNote?.includes("2025"));
  assert.ok(r.flags.some((f) => /consistency/i.test(f)));
  // levers: strength gap (0/wk, on a GLP-1), swim gap (CSS not set), bloods gap (no panel)
  const byName = Object.fromEntries(r.levers.map((l) => [l.name, l]));
  assert.equal(byName["Strength"].status, "gap");
  assert.match(byName["Strength"].note, /GLP-1/);
  assert.equal(byName["Swim"].status, "gap");
  assert.equal(byName["Bloods"].status, "gap");
  assert.ok(r.flags.some((f) => /strength/i.test(f)) && r.flags.some((f) => /Swim CSS/i.test(f)));
  assert.equal(r.focus, "raise the aerobic floor"); // phase focus wins
});

test("buildSeasonArc: no plan → hasPlan false, but levers + trajectory still computed (degrade, not crash)", () => {
  const r = buildSeasonArc(baseInput({ plan: undefined }));
  assert.equal(r.hasPlan, false);
  assert.equal(r.activePhase, undefined);
  assert.ok(r.levers.length > 0);
  assert.equal(r.peakYear?.year, 2013);
});

test("buildSeasonArc: strength on target + CSS set + recent panel → no gaps, no nag flags", () => {
  const profile = {
    schema_version: 1,
    health: { strength_sessions_per_week: 3, medication: { name: "GLP-1 agonist" } },
    ai_endurance_todo: { swim_css: "1:52" },
    bloods: { panels: [{ date: "2026-05-01" }] },
  } as unknown as Profile;
  const r = buildSeasonArc(baseInput({ profile }));
  const byName = Object.fromEntries(r.levers.map((l) => [l.name, l.status]));
  assert.equal(byName["Strength"], "ok");
  assert.equal(byName["Swim"], "ok");
  assert.equal(byName["Bloods"], "ok");
  assert.ok(!r.flags.some((f) => /strength|CSS|Bloods/i.test(f)));
});

test("renderSeasonPage: empty state names season_plan; full page renders sections and escapes", () => {
  const empty = renderSeasonPage(buildSeasonArc(baseInput({ plan: undefined })));
  assert.match(empty, /season_plan/);
  assert.match(empty, /Structural levers/);

  const full = renderSeasonPage(buildSeasonArc(baseInput()));
  assert.match(full, /Ironman by 2028/);
  assert.match(full, /Rebuild base/);
  assert.match(full, /Chronic load/);
  assert.match(full, /The long arc/);
  assert.match(full, /Structural levers/);
});

test("seasonReportText: a deterministic digest citing the key numbers (grounding + no-LLM fallback)", () => {
  const txt = seasonReportText(buildSeasonArc(baseInput()));
  assert.match(txt, /SEASON ARC/);
  assert.match(txt, /Ironman by 2028/);
  assert.match(txt, /Active phase: Rebuild base/);
  assert.match(txt, /CTL now 42.*target 55.*gap -13/s);
  assert.match(txt, /Peak year: 2013 \(390h\)/);
  assert.match(txt, /Strength \[gap\]/);
  assert.match(txt, /Risk flags:/);
});

test("renderSeasonPage escapes injected plan text (no raw markup)", () => {
  const nasty: SeasonPlan = { horizon_goal: "<script>alert(1)</script>", phases: [] };
  const html = renderSeasonPage(buildSeasonArc(baseInput({ plan: nasty })));
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});
