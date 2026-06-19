import { test } from "node:test";
import assert from "node:assert/strict";
import { adherencePct, analyseListening, buildEngagementContext, formatListening } from "../src/coach/listening.js";
import { snapshotSignature, toSurfaced, type InsightSnapshot, type SurfacedFinding } from "../src/state/insightLog.js";
import type { DecisionRecord } from "../src/state/decisionLog.js";
import { emptyState, type AthleteState, type PlannedSession } from "../src/state/types.js";

function stateWith(
  date: string,
  opts: { adherence?: Record<string, { actualH: number; prescribedH: number }>; planned?: PlannedSession[] },
): AthleteState {
  const s = emptyState(date, `${date}T06:00:00.000Z`);
  if (opts.adherence) s.adherenceByZone = { value: opts.adherence, source: "ai-endurance" };
  if (opts.planned) s.plannedSessions = { value: opts.planned, source: "ai-endurance" };
  return s;
}

function sf(key: string, family: string, title: string, detail = "d"): SurfacedFinding {
  return { key, family, title, severity: "watch", detail, evidence: "e" };
}
function snap(ts: string, findings: SurfacedFinding[]): InsightSnapshot {
  return { ts, surface: "dashboard", findings, schemaVersion: 1 };
}
function feedback(insightKey: string, status: "accepted" | "declined" | "deferred", ts: string): DecisionRecord {
  return { id: `fb-${insightKey}-${ts}`, timestamp: ts, kind: "insight-feedback", summary: insightKey, insightKey, status };
}
function proposal(id: string, status: DecisionRecord["status"], ts: string): DecisionRecord {
  return { id, timestamp: ts, kind: "plan-adjust", summary: id, status };
}

test("toSurfaced resolves the stable key (explicit key wins; else derived from family+title)", () => {
  assert.equal(toSurfaced({ family: "Load & form", title: "x", severity: "info", detail: "d", evidence: "e", key: "kx" }).key, "kx");
  assert.equal(toSurfaced({ family: "Load & form", title: "TSB 12%", severity: "info", detail: "d", evidence: "e" }).key, "load-form-tsb");
});

test("snapshotSignature: same findings/detail match; a changed detail breaks the match (so it re-logs)", () => {
  const a = [sf("k1", "F", "T", "ramp +5%")];
  const b = [sf("k1", "F", "T", "ramp +5%")];
  const c = [sf("k1", "F", "T", "ramp +9%")]; // numbers moved
  assert.equal(snapshotSignature(a), snapshotSignature(b));
  assert.notEqual(snapshotSignature(a), snapshotSignature(c));
});

test("analyseListening: engagement, family breakdown, proposals, suppression, recurrence", () => {
  const snapshots = [
    snap("2026-06-01T07:00:00.000Z", [sf("A", "Load & form", "TSB negative"), sf("B", "Durability", "Run durability slipping"), sf("C", "Goal tracking", "10K behind target")]),
    snap("2026-06-10T07:00:00.000Z", [sf("A", "Load & form", "TSB negative"), sf("B", "Durability", "Run durability slipping"), sf("D", "Anomaly", "RHR spike")]),
  ];
  const decisions: DecisionRecord[] = [
    feedback("A", "accepted", "2026-06-02T08:00:00.000Z"), // agreed
    feedback("B", "deferred", "2026-06-05T08:00:00.000Z"), // ignored — then resurfaces 06-10
    feedback("E", "declined", "2026-05-20T08:00:00.000Z"), // disagreed with something never logged as surfaced
    proposal("p1", "proposed", "2026-06-03T08:00:00.000Z"),
    proposal("p1", "executed", "2026-06-03T08:05:00.000Z"), // latest status wins → accepted
    proposal("p2", "proposed", "2026-06-04T08:00:00.000Z"), // pending
    proposal("p3", "declined", "2026-06-04T09:00:00.000Z"),
  ];

  const m = analyseListening({ snapshots, decisions, now: new Date("2026-06-12T08:00:00.000Z") });

  assert.deepEqual(m.window, { from: "2026-06-01", to: "2026-06-10" });
  assert.equal(m.snapshots, 2);
  assert.equal(m.surfacedKeys, 4); // A B C D
  assert.equal(m.reactedKeys, 2); // A agree, B ignore (C/D no reaction)
  assert.equal(m.reactionRate, 0.5);
  assert.deepEqual(m.reactions, { agree: 1, disagree: 0, ignore: 1 });
  assert.equal(m.feedbackBeforeLogging, 1); // E never surfaced

  assert.deepEqual(m.proposals, { accepted: 1, declined: 1, pending: 1, deferred: 0 });

  const dur = m.byFamily.find((f) => f.family === "Durability")!;
  assert.deepEqual(dur, { family: "Durability", surfaced: 1, agreed: 0, disagreed: 0, ignored: 1, noReaction: 0 });
  const load = m.byFamily.find((f) => f.family === "Load & form")!;
  assert.equal(load.agreed, 1);
  const goal = m.byFamily.find((f) => f.family === "Goal tracking")!;
  assert.equal(goal.noReaction, 1);

  // B was ignored 06-05 and surfaced again 06-10 → recurred after dismissal (5 days later).
  assert.equal(m.recurredAfterDismissal.length, 1);
  assert.equal(m.recurredAfterDismissal[0].key, "B");
  assert.equal(m.recurredAfterDismissal[0].daysLater, 5);

  // B's ignore (7d ago) is still inside the 2-week cool-off; E's disagree (23d) is not.
  assert.deepEqual(m.suppressedNow.map((s) => s.key), ["B"]);
  assert.equal(m.suppressedNow[0].family, "Durability");
  assert.equal(m.suppressedNow[0].daysAgo, 7);
});

test("analyseListening: adherence defers to plan progress (latest snapshot) and trends vs ~1wk earlier", () => {
  const states = [
    stateWith("2026-06-01", { adherence: { Endurance: { actualH: 5, prescribedH: 8 }, Threshold: { actualH: 1, prescribedH: 2 } } }),
    stateWith("2026-06-10", { adherence: { Endurance: { actualH: 7, prescribedH: 8 }, Threshold: { actualH: 2, prescribedH: 2 } } }),
  ];
  const m = analyseListening({ snapshots: [], decisions: [], states });
  assert.ok(m.adherence);
  assert.equal(m.adherence!.asOf, "2026-06-10");
  assert.equal(m.adherence!.totalPlannedH, 10);
  assert.equal(m.adherence!.totalActualH, 9);
  assert.equal(m.adherence!.pct, 0.9);
  assert.deepEqual(m.adherence!.trend, { priorPct: 0.6, deltaPts: 30 }); // 90% now vs 60% a week ago
  const endurance = m.adherence!.byZone.find((z) => z.zone === "Endurance")!;
  assert.equal(endurance.pct, 0.875);
});

test("adherencePct: off-plan work reads 'unplanned' not '—', and noisy over-delivery clamps to 200%+", () => {
  // Normal cases pass through.
  assert.equal(adherencePct(0.88), "88%");
  assert.equal(adherencePct(1), "100%");
  assert.equal(adherencePct(1.3), "130%"); // genuine over-delivery, still exact
  // Nothing planned in the zone: distinguish "did off-plan work here" from "genuinely empty".
  assert.equal(adherencePct(null, 0.3), "unplanned");
  assert.equal(adherencePct(null, 0), "—");
  assert.equal(adherencePct(null), "—");
  // Tiny planned denominator (8 min planned / 28 min done = 350%) must not read as broken.
  assert.equal(adherencePct(3.5), "200%+");
});

test("formatListening: a zone trained off-plan shows 'unplanned', a near-zero plan shows '200%+', never a bare '—' for work done", () => {
  // VO2Max/Anaerobic: nothing planned but minutes done; Threshold: 8 min planned, 28 min done.
  const states = [
    stateWith("2026-06-18", {
      adherence: {
        Endurance: { actualH: 4.8, prescribedH: 6.0 },
        Threshold: { actualH: 0.47, prescribedH: 0.13 },
        VO2Max: { actualH: 0.18, prescribedH: 0 },
      },
    }),
  ];
  const md = formatListening(analyseListening({ snapshots: [], decisions: [], states }));
  assert.match(md, /VO2Max \| 0:00 \| 0:11 \| unplanned \|/, "off-plan VO2Max reads 'unplanned', not '—'");
  assert.match(md, /Threshold \| 0:08 \| 0:28 \| 200%\+ \|/, "noisy 350% clamps to a readable 200%+");
});

test("analyseListening: plan-change diff classifies added / moved / dropped, guarding window churn", () => {
  const states = [
    stateWith("2026-06-08", { planned: [{ workoutId: "w1", date: "2026-06-15", title: "Long run" }, { workoutId: "w2", date: "2026-06-16", title: "VO2 intervals" }] }),
    stateWith("2026-06-09", { planned: [{ workoutId: "w1", date: "2026-06-17", title: "Long run" }] }), // w1 moved; w2 (upcoming) dropped
    stateWith("2026-06-10", { planned: [{ workoutId: "w1", date: "2026-06-17", title: "Long run" }, { workoutId: "w3", date: "2026-06-20", title: "Tempo" }] }), // w3 added
  ];
  const m = analyseListening({ snapshots: [], decisions: [], states });
  assert.deepEqual({ added: m.planChanges.added, removed: m.planChanges.removed, retimed: m.planChanges.retimed }, { added: 1, removed: 1, retimed: 1 });
  assert.equal(m.planChanges.events[0].at, "2026-06-10"); // most recent first
  assert.equal(m.planChanges.events[0].kind, "added");
  const moved = m.planChanges.events.find((e) => e.kind === "retimed")!;
  assert.equal(moved.detail, "2026-06-15 → 2026-06-17");
});

test("analyseListening: a planned workout that simply passed is NOT counted as dropped", () => {
  const states = [
    stateWith("2026-06-08", { planned: [{ workoutId: "w1", date: "2026-06-08", title: "Easy run" }] }), // due that day
    stateWith("2026-06-09", { planned: [] }), // gone — but it had already passed, so not a deletion
  ];
  const m = analyseListening({ snapshots: [], decisions: [], states });
  assert.equal(m.planChanges.removed, 0);
});

test("buildEngagementContext: weights families by act-vs-dismiss, maps recurring + adherence for the loop", () => {
  const snapshots = [
    snap("2026-06-01T07:00:00.000Z", [sf("d1", "Durability", "Run durability slipping"), sf("d2", "Durability", "Cadence drift"), sf("e1", "Load & form", "TSB negative")]),
    snap("2026-06-05T07:00:00.000Z", [sf("d1", "Durability", "Run durability slipping"), sf("e2", "Load & form", "Monotony high")]),
    snap("2026-06-09T07:00:00.000Z", [sf("d1", "Durability", "Run durability slipping"), sf("e3", "Load & form", "Ramp steep")]),
  ];
  const decisions: DecisionRecord[] = [
    feedback("d1", "deferred", "2026-06-02T08:00:00.000Z"), // ignored — then recurs 06-05 & 06-09
    feedback("d2", "deferred", "2026-06-02T08:00:00.000Z"),
    feedback("e1", "accepted", "2026-06-02T08:00:00.000Z"),
    feedback("e2", "accepted", "2026-06-06T08:00:00.000Z"),
    feedback("e3", "accepted", "2026-06-10T08:00:00.000Z"),
  ];
  const states = [
    stateWith("2026-06-01", { adherence: { Endurance: { actualH: 4, prescribedH: 8 } } }),
    stateWith("2026-06-09", { adherence: { Endurance: { actualH: 7, prescribedH: 8 } } }),
  ];
  const ctx = buildEngagementContext(analyseListening({ snapshots, decisions, states, now: new Date("2026-06-11T08:00:00.000Z") }));

  // Durability is dismissed (2/2 surfaced ignored) → down-weighted to the 0.7 floor; Load & form all agreed → 1.2 cap.
  assert.equal(ctx.familyWeights!.get("Durability"), 0.7);
  assert.equal(ctx.familyWeights!.get("Load & form"), 1.2);

  // d1 was ignored then resurfaced twice → a recurring signal; d2 (no recurrence) is not.
  assert.deepEqual(ctx.recurringDismissed!.map((r) => `${r.key}:${r.times}`), ["d1:2"]);
  assert.equal(ctx.recurringDismissed![0].reaction, "ignore");

  assert.equal(ctx.adherence!.pct, 0.875);
  assert.equal(ctx.adherence!.priorPct, 0.5);
  assert.equal(ctx.adherence!.plannedH, 8);
});

test("analyseListening: empty input is well-formed, and the formatter degrades gracefully", () => {
  const m = analyseListening({ snapshots: [], decisions: [] });
  assert.equal(m.window, null);
  assert.equal(m.surfacedKeys, 0);
  assert.equal(m.reactionRate, null);
  const md = formatListening(m, "2026-06-17");
  assert.match(md, /No surfaced insights have been logged yet/);
});

test("formatListening: renders the family table and the dismissed-but-recurred section", () => {
  const snapshots = [
    snap("2026-06-01T07:00:00.000Z", [sf("B", "Durability", "Run durability slipping")]),
    snap("2026-06-10T07:00:00.000Z", [sf("B", "Durability", "Run durability slipping")]),
  ];
  const decisions = [feedback("B", "deferred", "2026-06-05T08:00:00.000Z")];
  const m = analyseListening({ snapshots, decisions, load: { series: [], ctl: 50, atl: 46, tsb: 4, rampPerWeek: 2.1 }, now: new Date("2026-06-12T08:00:00.000Z") });
  const md = formatListening(m, "2026-06-17");
  assert.match(md, /By family/);
  assert.match(md, /\| Durability \| 1 \|/);
  assert.match(md, /Dismissed, but came back/);
  assert.match(md, /CTL 50 · ATL 46 · TSB \+4 · ramp \+2\.1\/wk/);
});
