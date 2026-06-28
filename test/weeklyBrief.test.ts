import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, type AthleteState } from "../src/state/types.js";
import type { InsightReport } from "../src/insights/engine.js";
import type { DecisionRecord } from "../src/state/decisionLog.js";
import type { GatedProposalInput } from "../src/coach/planAdjust.js";
import type { WriteGate } from "../src/guardrails/writeGate.js";
import { weeklyAggregates, summarizeWeek } from "../src/coach/weekly.js";
import {
  buildWeeklySnapshot,
  diffWeeklySnapshots,
  renderWeeklyBriefDelta,
  mondayOf,
  isSunday,
  weeklyProposalSourceKey,
  parseWeeklyProposalKey,
  proposalEquivKey,
  selectWeeklyProposals,
  openProposalEquivKeys,
  type WeeklySnapshot,
} from "../src/coach/weeklyBrief.js";
import { draftWeeklyProposals, weeklyBulletRequest } from "../src/coach/weeklyProposals.js";
import { buildSetupItems } from "../src/coach/setupCard.js";

/**
 * The Sunday weekly brief is a deterministic VIEW + a gated proposer — these tests pin the pure pieces:
 * the aggregates (shared with the review prose), the snapshot/diff, the terse render (incl. escaping +
 * format), the week-boundary helpers, and the proposal lifecycle (provenance, dedup, cap, suppression).
 * No LLM, no IO — the orchestration is exercised through an injected proposer + a stub gate.
 */

const NOW = Date.parse("2026-06-28T19:00:00Z"); // a Sunday evening

function weekWindow(): AthleteState[] {
  const today = emptyState("2026-06-28", "2026-06-28T19:00:00Z");
  today.actualActivities = {
    value: [
      { date: "2026-06-24", sport: "Ride", durationMin: 90, distanceKm: 45 },
      { date: "2026-06-26", sport: "Ride", durationMin: 90, distanceKm: 44 },
      { date: "2026-06-25", sport: "Run", durationMin: 60, distanceKm: 11 },
    ],
    source: "ai-endurance",
  };
  today.adherenceByZone = {
    value: { Endurance: { actualH: 3.6, prescribedH: 5.0 }, Threshold: { actualH: 0.9, prescribedH: 1.0 } },
    source: "ai-endurance",
  };
  return [today];
}

// --- aggregates: ONE source of truth shared with the review prose -----------------------------------

test("weeklyAggregates: load by sport + zone-adherence, matching summarizeWeek's prose", () => {
  const win = weekWindow();
  const agg = weeklyAggregates(win);
  assert.deepEqual(agg.bySport.Ride, { n: 2, min: 180, km: 89 });
  assert.deepEqual(agg.bySport.Run, { n: 1, min: 60, km: 11 });
  assert.equal(agg.adherence.Endurance.pct, 72); // 3.6 / 5.0
  assert.equal(agg.adherence.Threshold.pct, 90);

  // The prose summarizeWeek emits is derived from the SAME aggregates — assert the numbers line up.
  const prose = summarizeWeek(win);
  assert.match(prose, /- Ride: 2 sessions, 180 min, 89\.0 km/);
  assert.match(prose, /- Endurance: actual 3\.60h vs prescribed 5\.00h \(72% of prescribed\)/);
});

test("buildWeeklySnapshot: freezes minutes + CTL/TSB from insights, keyed by the week's Monday", () => {
  const insights = { load: { ctl: 63, tsb: -13 } } as unknown as InsightReport;
  const snap = buildWeeklySnapshot({ window: weekWindow(), insights, now: NOW });
  assert.equal(snap.weekStart, "2026-06-22"); // Monday of the week containing Sun 28 Jun
  assert.deepEqual(snap.bySportMin, { Ride: 180, Run: 60 });
  assert.equal(snap.ctl, 63);
  assert.equal(snap.tsb, -13);
  assert.deepEqual(snap.adherencePct, { Endurance: 72, Threshold: 90 });
});

test("buildWeeklySnapshot: degrades to null CTL/TSB when the load model is absent", () => {
  const snap = buildWeeklySnapshot({ window: weekWindow(), insights: undefined, now: NOW });
  assert.equal(snap.ctl, null);
  assert.equal(snap.tsb, null);
  assert.deepEqual(snap.bySportMin, { Ride: 180, Run: 60 }); // load still captured without insights
});

// --- diff + render ----------------------------------------------------------------------------------

const snap = (over: Partial<WeeklySnapshot>): WeeklySnapshot => ({
  weekStart: "2026-06-15",
  capturedAt: "2026-06-21T19:00:00Z",
  bySportMin: {},
  ctl: null,
  tsb: null,
  adherencePct: {},
  ...over,
});

test("diffWeeklySnapshots: null when there's no prior week (first snapshot) — no misleading wall", () => {
  assert.equal(diffWeeklySnapshots(null, snap({})), null);
  assert.equal(diffWeeklySnapshots(snap({}), null), null);
});

test("diffWeeklySnapshots: per-sport, CTL, TSB and per-zone deltas across two weeks", () => {
  const prev = snap({ weekStart: "2026-06-15", bySportMin: { Ride: 180, Run: 60 }, ctl: 60, tsb: -5, adherencePct: { Endurance: 72, Threshold: 90 } });
  const curr = snap({ weekStart: "2026-06-22", bySportMin: { Ride: 227, Run: 55 }, ctl: 63, tsb: -13, adherencePct: { Endurance: 81 } });
  const d = diffWeeklySnapshots(prev, curr)!;
  assert.equal(d.fromWeek, "2026-06-15");
  assert.equal(d.toWeek, "2026-06-22");
  assert.equal(d.bySport.find((s) => s.sport === "Ride")!.deltaMin, 47);
  assert.equal(d.bySport.find((s) => s.sport === "Run")!.deltaMin, -5);
  assert.deepEqual(d.ctl, { from: 60, to: 63, delta: 3 });
  assert.deepEqual(d.tsb, { from: -5, to: -13, delta: -8 });
  assert.deepEqual(d.adherence.find((a) => a.zone === "Endurance"), { zone: "Endurance", from: 72, to: 81 });
  assert.deepEqual(d.adherence.find((a) => a.zone === "Threshold"), { zone: "Threshold", from: 90, to: null }); // dropped this week
});

test("diffWeeklySnapshots: CTL/TSB omitted from the delta when either week lacks the load model", () => {
  const prev = snap({ bySportMin: { Ride: 100 }, ctl: 60, tsb: -5 });
  const curr = snap({ weekStart: "2026-06-22", bySportMin: { Ride: 100 }, ctl: null, tsb: null });
  const d = diffWeeklySnapshots(prev, curr)!;
  assert.equal(d.ctl, null);
  assert.equal(d.tsb, null);
});

test("renderWeeklyBriefDelta: terse one-liner — above-noise sports, signed CTL/TSB, Z2 from→to", () => {
  const prev = snap({ bySportMin: { Ride: 180, Run: 60 }, ctl: 60, tsb: -5, adherencePct: { Endurance: 72 } });
  const curr = snap({ weekStart: "2026-06-22", bySportMin: { Ride: 227, Run: 55 }, ctl: 63, tsb: -13, adherencePct: { Endurance: 81 } });
  const html = renderWeeklyBriefDelta(diffWeeklySnapshots(prev, curr));
  assert.match(html, /This week vs last/);
  assert.match(html, /Ride \+47m/); // |+47| ≥ 10 → shown
  assert.doesNotMatch(html, /Run/); // |−5| < 10 → dropped as noise
  assert.match(html, /CTL \+3/);
  assert.match(html, /TSB −8/); // U+2212 minus
  assert.match(html, /Z2 72→81%/);
});

test("renderWeeklyBriefDelta: hours format over 60 min, and '' for a first/absent week", () => {
  const prev = snap({ bySportMin: { Ride: 100 } });
  const curr = snap({ weekStart: "2026-06-22", bySportMin: { Ride: 165 } }); // +65 min → +1h05
  assert.match(renderWeeklyBriefDelta(diffWeeklySnapshots(prev, curr)), /Ride \+1h05/);
  assert.equal(renderWeeklyBriefDelta(null), "");
});

test("renderWeeklyBriefDelta: a quiet week stays honest, not empty", () => {
  const prev = snap({ bySportMin: { Ride: 180 }, ctl: 60, tsb: -5 });
  const curr = snap({ weekStart: "2026-06-22", bySportMin: { Ride: 183 }, ctl: 60, tsb: -5 }); // +3min, no CTL/TSB move
  assert.match(renderWeeklyBriefDelta(diffWeeklySnapshots(prev, curr)), /broadly in line with last week/);
});

test("renderWeeklyBriefDelta: escapes sport names from imported data (no HTML injection)", () => {
  const prev = snap({ bySportMin: {} });
  const curr = snap({ weekStart: "2026-06-22", bySportMin: { "<img src=x onerror=alert(1)>": 50 } });
  const html = renderWeeklyBriefDelta(diffWeeklySnapshots(prev, curr));
  assert.match(html, /&lt;img src=x/);
  assert.doesNotMatch(html, /<img src=x/);
});

// --- week-boundary helpers (athlete-TZ calendar dates; DST-proof) ------------------------------------

test("isSunday / mondayOf: correct on plain dates", () => {
  assert.equal(isSunday("2026-06-28"), true); // Sunday
  assert.equal(isSunday("2026-06-22"), false); // Monday
  assert.equal(mondayOf("2026-06-28"), "2026-06-22"); // Sunday → back 6 days
  assert.equal(mondayOf("2026-06-22"), "2026-06-22"); // Monday → itself
  assert.equal(mondayOf("2026-06-27"), "2026-06-22"); // Saturday → back to Monday
});

test("mondayOf: stable across a DST-transition Sunday (UTC date math, no clock shift)", () => {
  // 29 Mar 2026 is the UK spring-forward Sunday; the Monday label must not slip.
  assert.equal(isSunday("2026-03-29"), true);
  assert.equal(mondayOf("2026-03-29"), "2026-03-23");
  assert.equal(mondayOf("2026-10-25"), "2026-10-19"); // autumn fall-back Sunday
});

// --- proposal provenance + dedup identity ------------------------------------------------------------

test("weeklyProposalSourceKey / parseWeeklyProposalKey: round-trip and reject non-weekly keys", () => {
  assert.equal(weeklyProposalSourceKey("2026-06-28", 2), "weekly:2026-06-28#2");
  assert.deepEqual(parseWeeklyProposalKey("weekly:2026-06-28#2"), { reviewDate: "2026-06-28", index: 2 });
  assert.equal(parseWeeklyProposalKey("setup:weekly:foo"), null);
  assert.equal(parseWeeklyProposalKey("weekly:2026-06-28"), null); // no #index
  assert.equal(parseWeeklyProposalKey(undefined), null);
});

test("proposalEquivKey: same effect collapses; advice text is not part of the key", () => {
  assert.equal(proposalEquivKey("changeWorkoutDate", { workoutId: "w1", newDate: "2026-07-01" }), "changeWorkoutDate:w1:2026-07-01");
  assert.equal(proposalEquivKey("skipWorkout", { workoutId: "w2" }), "skipWorkout:w2");
  assert.equal(
    proposalEquivKey("changeWorkoutAdvice", { workoutId: "w3", advice: "fuel earlier" }),
    proposalEquivKey("changeWorkoutAdvice", { workoutId: "w3", advice: "different note" }),
  );
});

// --- selectWeeklyProposals: open (render+count) vs suppress (hide the This-week card) -----------------

const rec = (over: Partial<DecisionRecord>): DecisionRecord => ({
  id: "x",
  timestamp: "2026-06-28T18:00:00Z",
  kind: "plan-adjust",
  summary: "Move X → 1 Jul",
  status: "proposed",
  write: { tool: "changeWorkoutDate", args: { workoutId: "w", newDate: "2026-07-01" } },
  ...over,
});

test("selectWeeklyProposals: classifies open vs suppress, scoped to the review date, latest-status wins", () => {
  const records: DecisionRecord[] = [
    rec({ id: "p1", sourceKey: "weekly:2026-06-28#0", status: "proposed" }), // fresh proposed → open + suppress
    rec({ id: "p2", sourceKey: "weekly:2026-06-28#1", status: "proposed" }),
    rec({ id: "p2", sourceKey: "weekly:2026-06-28#1", status: "declined", timestamp: "2026-06-28T18:30:00Z" }), // later decline → neither
    rec({ id: "p3", sourceKey: "weekly:2026-06-28#2", status: "executed" }), // applied → suppress, not open
    rec({ id: "p4", sourceKey: "weekly:2026-06-21#0", status: "proposed" }), // a different review → excluded
    rec({ id: "p5", sourceKey: "weekly:2026-06-28#3", status: "proposed", timestamp: "2026-06-10T00:00:00Z" }), // expired
  ];
  const { open, suppress } = selectWeeklyProposals(records, "2026-06-28", { now: NOW });
  assert.deepEqual(open.map((p) => p.sourceKey), ["weekly:2026-06-28#0"]); // only p1
  assert.deepEqual([...suppress].sort(), ["weekly:2026-06-28#0", "weekly:2026-06-28#2"]); // p1 (proposed) + p3 (executed)
});

test("openProposalEquivKeys: only LIVE proposals' effects block a re-draft", () => {
  const records: DecisionRecord[] = [
    rec({ id: "a", status: "proposed", write: { tool: "skipWorkout", args: { workoutId: "wA" } } }),
    rec({ id: "b", status: "declined", timestamp: "2026-06-28T18:30:00Z", write: { tool: "skipWorkout", args: { workoutId: "wB" } } }),
  ];
  const keys = openProposalEquivKeys(records, { now: NOW });
  assert.ok(keys.has("skipWorkout:wA"));
  assert.ok(!keys.has("skipWorkout:wB")); // declined → frees its slot
});

// --- suppression integration: a pre-drafted bullet leaves the "This week" cards ----------------------

test("buildSetupItems: suppresses a This-week card once its bullet has a live gated proposal", () => {
  const profile = {} as Parameters<typeof buildSetupItems>[0]; // buildSetupItems returns [] without a profile
  const weeklyReview = { date: "2026-06-28", actions: ["Cut one grey-zone ride", "Take 60g/h carb on long rides", "Add a recovery spin"] };
  const base = { weeklyReview, questions: [], now: Date.parse("2026-06-28T12:00:00Z") }; // questions:[] → no profile-gap noise

  const without = buildSetupItems(profile, base).filter((i) => i.source === "weekly").map((i) => i.label);
  assert.deepEqual(without.sort(), [...weeklyReview.actions].sort()); // all three show by default

  const withSuppression = buildSetupItems(profile, { ...base, proposalSourceKeys: new Set(["weekly:2026-06-28#0"]) })
    .filter((i) => i.source === "weekly")
    .map((i) => i.label);
  assert.ok(!withSuppression.includes("Cut one grey-zone ride")); // bullet 0 → now an Apply/Dismiss card on Decide
  assert.ok(withSuppression.includes("Take 60g/h carb on long rides")); // bullet 1 → still a cue
  assert.ok(withSuppression.includes("Add a recovery spin")); // bullet 2 → still a cue
});

// --- orchestration: idempotency, dedup, cap (injected proposer + stub gate) ---------------------------

const REVIEW_MD = `# Weekly review — 2026-06-28

Some prose.

## Next week
- Cut one grey-zone ride
- Move the long run off Friday
- Take 60g/h carb on long rides
- Add a recovery spin
`;

/** A stub gate that records propose() calls without touching disk or the API. */
function stubGate() {
  const captured: Array<{ sourceKey?: string; tool: string }> = [];
  const gate = {
    propose: async (p: { sourceKey?: string; tool: string }) => {
      captured.push({ sourceKey: p.sourceKey, tool: p.tool });
      return { id: `id${captured.length}`, ...p };
    },
  } as unknown as WriteGate;
  return { gate, captured };
}

/** A proposer that returns a distinct, valid proposal per call (one per bullet). */
function uniqueProposer() {
  let n = 0;
  return async () => {
    n += 1;
    const valid: GatedProposalInput[] = [
      { tool: "changeWorkoutDate", args: { workoutId: `w${n}`, newDate: "2026-07-01" }, summary: `s${n}`, tradeoff: "t", human: `h${n}`, basis: [] },
    ];
    return { valid };
  };
}

test("draftWeeklyProposals: caps at 3 even when every bullet yields a proposal", async () => {
  const { gate, captured } = stubGate();
  const res = await draftWeeklyProposals({ reviewMarkdown: REVIEW_MD, reviewDate: "2026-06-28", existing: [], propose: uniqueProposer(), gate, now: NOW });
  assert.equal(res.drafted, 3);
  assert.deepEqual(captured.map((c) => c.sourceKey), ["weekly:2026-06-28#0", "weekly:2026-06-28#1", "weekly:2026-06-28#2"]);
});

test("draftWeeklyProposals: per-bullet idempotency — skips a bullet that already has a live proposal", async () => {
  const existing: DecisionRecord[] = [rec({ id: "p0", sourceKey: "weekly:2026-06-28#0", status: "proposed" })];
  const { gate, captured } = stubGate();
  const res = await draftWeeklyProposals({ reviewMarkdown: REVIEW_MD, reviewDate: "2026-06-28", existing, propose: uniqueProposer(), gate, now: NOW });
  assert.equal(res.skipped, 1); // bullet 0 already drafted
  assert.equal(res.drafted, 2); // bullets 1 + 2 fill the cap (1 existing + 2 new = 3)
  assert.deepEqual(captured.map((c) => c.sourceKey), ["weekly:2026-06-28#1", "weekly:2026-06-28#2"]);
});

test("draftWeeklyProposals: dedups a bullet whose effect equals one already picked, and the freed slot fills", async () => {
  const { gate, captured } = stubGate();
  // bullet 1 duplicates bullet 0's effect (wDup) → dropped; dedup frees the cap slot, so bullet 3 fills it.
  const queue: GatedProposalInput[][] = [
    [{ tool: "skipWorkout", args: { workoutId: "wDup" }, summary: "a", tradeoff: "t", human: "ha", basis: [] }],
    [{ tool: "skipWorkout", args: { workoutId: "wDup" }, summary: "b", tradeoff: "t", human: "hb", basis: [] }],
    [{ tool: "skipWorkout", args: { workoutId: "wOther" }, summary: "c", tradeoff: "t", human: "hc", basis: [] }],
    [{ tool: "skipWorkout", args: { workoutId: "wLast" }, summary: "d", tradeoff: "t", human: "hd", basis: [] }],
  ];
  let i = 0;
  const propose = async () => ({ valid: queue[i++] });
  const res = await draftWeeklyProposals({ reviewMarkdown: REVIEW_MD, reviewDate: "2026-06-28", existing: [], propose, gate, now: NOW });
  assert.equal(res.drafted, 3); // bullets 0 (wDup) + 2 (wOther) + 3 (wLast); bullet 1 deduped out
  assert.deepEqual(captured.map((c) => c.sourceKey), ["weekly:2026-06-28#0", "weekly:2026-06-28#2", "weekly:2026-06-28#3"]);
});

test("weeklyBulletRequest: carries the bullet verbatim and invites the smallest binding edit", () => {
  const req = weeklyBulletRequest("Cut one grey-zone ride");
  assert.match(req, /Cut one grey-zone ride/);
  assert.match(req, /changeWorkoutAdvice/); // invites a coaching-note edit for non-structural cues
  assert.match(req, /propose nothing/i); // degrade path for un-bindable bullets
});
