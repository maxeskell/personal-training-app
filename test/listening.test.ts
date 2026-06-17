import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseListening, formatListening } from "../src/coach/listening.js";
import { snapshotSignature, toSurfaced, type InsightSnapshot, type SurfacedFinding } from "../src/state/insightLog.js";
import type { DecisionRecord } from "../src/state/decisionLog.js";

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
