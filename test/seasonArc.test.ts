import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSeasonArc, pickActivePhase, parseTarget, ctlTrend, seasonReportText, type SeasonArcInput } from "../src/coach/seasonArc.js";
import { renderSeasonPage } from "../src/coach/seasonPage.js";
import type { Profile, SeasonPlan } from "../src/profile/schema.js";
import type { CareerHistory } from "../src/coach/careerHistory.js";
import { seasonNudgeDue } from "../src/coach/seasonNudge.js";

const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

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

test("renderSeasonPage: sections read anchor-first (horizon → phase → CTL → long arc) and focus shows once", () => {
  const full = renderSeasonPage(buildSeasonArc(baseInput()));
  const iHorizon = full.indexOf("<h2>Horizon</h2>");
  const iPhase = full.indexOf("<h2>This phase</h2>");
  const iCtl = full.indexOf("Chronic load");
  const iArc = full.indexOf("The long arc");
  assert.ok(iHorizon > -1 && iHorizon < iPhase, "the horizon (the goal) leads, before the active phase");
  assert.ok(iPhase < iCtl, "this phase before chronic load");
  assert.ok(iCtl < iArc, "chronic load before the long arc");
  // Focus is folded into the phase card — no separate "Focus now" card, and the focus text isn't doubled.
  assert.ok(!full.includes("Focus now"), "no standalone Focus now card when there's an active phase");
  assert.equal(full.split("raise the aerobic floor").length - 1, 1, "the phase focus appears exactly once");
});

test("renderSeasonPage: with no active phase, the derived focus still surfaces as a standalone Focus now card", () => {
  // A horizon goal but no phases → no active phase → r.focus is the derived CTL nudge, with nowhere to fold.
  const noActive = renderSeasonPage(buildSeasonArc(baseInput({ plan: { horizon_goal: "Ironman by 2028", phases: [] } })));
  assert.match(noActive, /Focus now/);
  assert.ok(!noActive.includes("<h2>This phase</h2>"), "no This phase card when nothing is active");
});

test("renderSeasonPage: long-arc bars render a filled width (regression — inline fill span had no width)", () => {
  const full = renderSeasonPage(buildSeasonArc(baseInput()));
  // The fill MUST be a block: width:%/height are ignored on an inline <span>, so every bar reads empty
  // ("No data on graph") even though the hours are present.
  assert.match(full, /\.bar \.fill\{display:block;/);
  // Peak year (2013, 390h = max) fills the whole track; current year and a mid year stay proportional.
  assert.match(full, /class="fill peak" style="width:100%"/); // 2013, the 390h peak
  assert.match(full, /class="fill" style="width:54%"/); // 2025, 210h of 390h
  assert.match(full, /class="fill cur" style="width:31%"/); // 2026, 120h of 390h (this year)
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

test("seasonNudgeDue: quarterly cadence — fires when due, held by a recent review or nudge", () => {
  const today = isoDaysAgo(0);
  // no plan → never nudge
  assert.equal(seasonNudgeDue({ today, hasPlan: false }), false);
  // plan but never reviewed/nudged → prompt the first one
  assert.equal(seasonNudgeDue({ today, hasPlan: true }), true);
  // reviewed 100d ago → due
  assert.equal(seasonNudgeDue({ today, hasPlan: true, lastReviewDate: isoDaysAgo(100) }), true);
  // reviewed 30d ago → not due
  assert.equal(seasonNudgeDue({ today, hasPlan: true, lastReviewDate: isoDaysAgo(30) }), false);
  // reviewed 100d ago but nudged 10d ago → the recent nudge holds it
  assert.equal(seasonNudgeDue({ today, hasPlan: true, lastReviewDate: isoDaysAgo(100), lastNudgeDate: isoDaysAgo(10) }), false);
  // custom cadence
  assert.equal(seasonNudgeDue({ today, hasPlan: true, lastReviewDate: isoDaysAgo(40), everyDays: 30 }), true);
});

test("renderSeasonPage escapes injected plan text (no raw markup)", () => {
  const nasty: SeasonPlan = { horizon_goal: "<script>alert(1)</script>", phases: [] };
  const html = renderSeasonPage(buildSeasonArc(baseInput({ plan: nasty })));
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

// ---- Long arc: live years from the archive + the current-year projection (MODEL) ----------------------

import { fillTrajectory, projectYear, type ArchiveVolume } from "../src/coach/seasonArc.js";

/** N activities of `hours` each on evenly spaced days of `year` (days 1..N × step). */
const acts = (year: number, n: number, hours: number, step = 1) =>
  Array.from({ length: n }, (_, i) => ({ date: new Date(Date.UTC(year, 0, 1 + i * step)).toISOString().slice(0, 10), hours, km: 10 }));

const TP_ONLY: CareerHistory = { races: [], bests: [], trajectory: [{ year: 2013, hours: 390 }, { year: 2024, hours: 203 }] };

test("fillTrajectory: years the career file lacks are summed from the Garmin archive; the current year is partial; existing years are untouched", () => {
  const archive: ArchiveVolume = {
    garmin: [...acts(2024, 100, 3), ...acts(2025, 100, 2.2), ...acts(2026, 50, 3)], // 2024 = 300h would OVERRIDE the file's 203h if we let it
    aie: [...acts(2025, 100, 1)],
  };
  const t = fillTrajectory(TP_ONLY.trajectory!, archive, "2026-09-09");
  assert.deepEqual(
    t.map((y) => [y.year, y.hours, y.source, y.partial ?? false]),
    [
      [2013, 390, undefined, false],
      [2024, 203, undefined, false], // the record of record stays
      [2025, 220, "garmin", false], // Garmin wins over AIE (all sports, elapsed)
      [2026, 150, "garmin", true], // year to date
    ],
  );
});

test("fillTrajectory: AI Endurance fills a year Garmin doesn't cover; corrupt multi-day files and future years are dropped", () => {
  const archive: ArchiveVolume = {
    garmin: [...acts(2026, 10, 1)],
    aie: [...acts(2025, 10, 5), { date: "2025-06-01", hours: 30 }, ...acts(2027, 10, 5)],
  };
  const t = fillTrajectory([], archive, "2026-03-01");
  assert.deepEqual(
    t.map((y) => [y.year, y.hours, y.source]),
    [
      [2025, 50, "ai-endurance"], // the 30h "activity" is a corrupt file, not a session
      [2026, 10, "garmin"],
    ],
  );
  assert.deepEqual(fillTrajectory([], undefined, "2026-03-01"), [], "no archive → nothing invented");
});

test("projectYear: a MODEL on two bases — this year's average pace and the last 8 weeks' pace — only for a partial year", () => {
  // 2026-09-09 is day 252 of 365. 150h to date → 150/252×365 ≈ 217h at year pace.
  const garmin = [...acts(2026, 50, 3, 5)]; // days 1,6,…,246 → all 50 sessions inside the year to date
  const cur = { year: 2026, hours: 150, source: "garmin" as const, partial: true };
  const p = projectYear(cur, { garmin, aie: [] }, "2026-09-09")!;
  assert.equal(p.daysElapsed, 252);
  assert.equal(p.daysInYear, 365);
  assert.equal(p.atYearPace, 217);
  // Last 56 days (15 Jul → 9 Sep) hold sessions on days 201,206,…,246 = 10 × 3h = 30h → 30/56 × 113 remaining ≈ 60.5 → 211
  assert.equal(p.atRecentPace, 211);
  assert.equal(p.recentWindowDays, 56);
  // Complete years and the first fortnight of a year get no projection; a TrainingPeaks-sourced year has no recent-pace basis.
  assert.equal(projectYear({ year: 2025, hours: 220 }, { garmin, aie: [] }, "2026-09-09"), undefined);
  assert.equal(projectYear({ year: 2026, hours: 5, partial: true }, { garmin, aie: [] }, "2026-01-10"), undefined);
  assert.equal(projectYear({ year: 2026, hours: 120, partial: true }, undefined, "2026-06-22")?.atRecentPace, undefined);
  assert.equal(projectYear(undefined, undefined, "2026-06-22"), undefined);
});

test("buildSeasonArc + page: the long arc shows the live years, an orange year-to-date bar with a faint projected tail, and names its sources", () => {
  const archive: ArchiveVolume = { garmin: [...acts(2025, 100, 2.2), ...acts(2026, 50, 3, 5)], aie: [] };
  const r = buildSeasonArc(baseInput({ today: "2026-09-09", career: TP_ONLY, archive }));
  assert.equal(r.trajectory?.length, 4);
  assert.equal(r.currentYear?.hours, 150);
  assert.equal(r.currentYearProjection?.atYearPace, 217);
  // Consistency benchmarks the last COMPLETE year — now 2025 (live), not the file's 2024.
  assert.match(r.consistencyNote!, /^2025: 220h vs peak 390h \(2013\)/);

  const html = renderSeasonPage(r);
  assert.match(html, /class="fill cur" style="width:38%"/); // 150 of 390
  assert.match(html, /class="fill proj" style="width:17%"/); // (217−150) of 390
  assert.match(html, /150h → ~217h/);
  assert.match(html, /<span class="yr">26\*<\/span>/);
  // Apostrophes come out as &#39; — the note goes through escapeHtml like every other interpolated string.
  assert.match(html, /MODEL: ~217h if the rest of the year matches this year&#39;s average pace \(~211h at the last 8 weeks&#39; pace\)/);
  assert.match(html, /2025 onward is summed live from your Garmin archive \(all sports, elapsed time\); earlier years from the TrainingPeaks export/);
  // The fill spans sit side by side inside the track (the tail must not wrap onto a hidden second line).
  assert.match(html, /\.bar \.track\{flex:1;display:flex;/);

  const txt = seasonReportText(r);
  assert.match(txt, /2026:150h \(to date\)/);
  assert.match(txt, /This year \(MODEL\): 150h to 2026-09-09 \(day 252 of 365\) → ~217h at this year's average pace, ~211h at the last 8 weeks' pace/);
  assert.match(txt, /Years from 2025 are summed live from the local archive \(garmin\)/);
});

test("long arc: a projection past the all-time peak rescales the track so the tail isn't clipped", () => {
  const archive: ArchiveVolume = { garmin: [...acts(2026, 50, 6, 5)], aie: [] }; // 300h by day 246 → ~434h projected > 390 peak
  const r = buildSeasonArc(baseInput({ today: "2026-09-09", career: TP_ONLY, archive }));
  assert.ok(r.currentYearProjection!.atYearPace > 390);
  const html = renderSeasonPage(r);
  assert.match(html, /class="fill peak" style="width:90%"/); // 390 of 434
  assert.doesNotMatch(html, /class="fill[^"]*" style="width:1\d\d%"/, "no bar overflows its track");
});
