import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, type AthleteState, type DisciplineThresholds, type Source } from "../src/state/types.js";
import { buildBriefSnapshot, diffBriefSnapshots, latestReadinessVerdict, type BriefSnapshot } from "../src/coach/dailyBrief.js";
import type { DecisionRecord } from "../src/state/decisionLog.js";
import type { InsightReport } from "../src/insights/engine.js";

/**
 * The daily brief is a deterministic VIEW over the engine — these tests pin the two pure pieces:
 * buildBriefSnapshot (what we capture each day) and diffBriefSnapshots (the since-yesterday lines). No
 * LLM, no IO; the render is exercised by the dashboard's own escaping tests.
 */

const day = (d: number) => `2026-06-${String(d).padStart(2, "0")}`;
const NOW = Date.parse("2026-06-15T12:00:00Z");

function st(date: string, thresholds?: DisciplineThresholds, src: Source = "garmin"): AthleteState {
  const s = emptyState(date, `${date}T06:00:00Z`);
  if (thresholds) s.thresholds = { value: thresholds, source: src };
  return s;
}

function readiness(date: string, verdict: string): DecisionRecord {
  return { id: `r-${date}`, ts: `${date}T06:00:00Z`, kind: "readiness", summary: `${verdict}: looks fine`, payload: {} } as unknown as DecisionRecord;
}

function insightsWith(findings: Array<{ family: string; title: string; severity: "info" | "watch" | "flag" }>): InsightReport {
  return { topFindings: findings } as unknown as InsightReport;
}

test("latestReadinessVerdict: reads the last readiness decision, ignores other kinds", () => {
  assert.equal(latestReadinessVerdict([readiness(day(10), "green"), readiness(day(11), "amber")]), "amber");
  assert.equal(latestReadinessVerdict([]), null);
  assert.equal(latestReadinessVerdict([{ kind: "sync", summary: "ok" } as unknown as DecisionRecord]), null);
});

test("buildBriefSnapshot: captures verdict, metric keys and flag/watch insight keys", () => {
  const window = [st(day(10), { bikeFtpW: 250 }), st(day(13), { bikeFtpW: 262 })];
  const insights = insightsWith([
    { family: "load", title: "Ramp steep", severity: "flag" },
    { family: "sleep", title: "Sleep slipping", severity: "watch" },
    { family: "econ", title: "FYI only", severity: "info" }, // info is not diffed
  ]);
  const snap = buildBriefSnapshot({ window, insights, decisions: [readiness(day(13), "green")], now: NOW });
  assert.equal(snap.date, day(13));
  assert.equal(snap.readiness, "green");
  assert.deepEqual(snap.metricKeys, ["change:bikeFtpW:262"]);
  assert.equal(snap.insightKeys.length, 2); // flag + watch, not info
});

test("diffBriefSnapshots: first day (no prior) yields no lines — never an everything-is-new wall", () => {
  const curr: BriefSnapshot = { date: day(13), capturedAt: "", readiness: "green", metricKeys: ["change:bikeFtpW:262"], insightKeys: ["load|x"] };
  assert.deepEqual(diffBriefSnapshots(null, curr, { metricChanges: [], insightTitle: () => "x" }), []);
});

test("diffBriefSnapshots: surfaces a readiness move, a new metric and a new insight — and nothing stale", () => {
  const prev: BriefSnapshot = { date: day(12), capturedAt: "", readiness: "amber", metricKeys: [], insightKeys: ["load|old"] };
  const curr: BriefSnapshot = { date: day(13), capturedAt: "", readiness: "green", metricKeys: ["change:bikeFtpW:262"], insightKeys: ["load|old", "sleep|new"] };
  const changes = diffBriefSnapshots(prev, curr, {
    metricChanges: [{ key: "change:bikeFtpW:262", label: "Bike FTP", from: "250 W", to: "262 W" } as never],
    insightTitle: (k) => (k === "sleep|new" ? "Sleep slipping" : "old"),
  });
  assert.equal(changes.length, 3);
  assert.deepEqual(changes[0], { text: "Readiness amber → green", tone: "up", target: "decide" });
  assert.equal(changes[1].text, "Bike FTP 250 W → 262 W");
  assert.deepEqual(changes[2], { text: "New: Sleep slipping", tone: "down", target: "decide" });
});

test("diffBriefSnapshots: an unchanged day yields no lines (short-when-nothing)", () => {
  const prev: BriefSnapshot = { date: day(12), capturedAt: "", readiness: "green", metricKeys: ["change:bikeFtpW:262"], insightKeys: ["load|x"] };
  const curr: BriefSnapshot = { date: day(13), capturedAt: "", readiness: "green", metricKeys: ["change:bikeFtpW:262"], insightKeys: ["load|x"] };
  assert.deepEqual(diffBriefSnapshots(prev, curr, { metricChanges: [], insightTitle: () => "x" }), []);
});

test("diffBriefSnapshots: a readiness drop reads as 'down' (worth a look)", () => {
  const prev: BriefSnapshot = { date: day(12), capturedAt: "", readiness: "green", metricKeys: [], insightKeys: [] };
  const curr: BriefSnapshot = { date: day(13), capturedAt: "", readiness: "red", metricKeys: [], insightKeys: [] };
  const changes = diffBriefSnapshots(prev, curr, { metricChanges: [], insightTitle: () => undefined });
  assert.deepEqual(changes, [{ text: "Readiness green → red", tone: "down", target: "decide" }]);
});
