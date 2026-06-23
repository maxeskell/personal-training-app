import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionRecord } from "../src/state/decisionLog.js";
import type { CostRecord } from "../src/llm/costLog.js";

/**
 * The MCP server is a thin adapter over the same engine the CLI uses; its pure formatters carry the
 * presentation logic. These assert the deterministic bits (no network, no LLM): the state digest,
 * the decision/cost renderers, and the report list/read helpers' path-traversal guard.
 */

test("formatDecisions: pending shows only still-proposed plan-adjusts with confirm/decline hints", async () => {
  const { formatDecisions } = await import("../src/mcpServer.js");
  const recs: DecisionRecord[] = [
    { id: "a", timestamp: "2026-06-14T10:00:00Z", kind: "plan-adjust", summary: "Shift long run", tradeoff: "less Z2", status: "proposed" },
    { id: "a", timestamp: "2026-06-14T12:00:00Z", kind: "plan-adjust", summary: "Shift long run", status: "executed" }, // later status wins → not pending
    { id: "b", timestamp: "2026-06-14T11:00:00Z", kind: "plan-adjust", summary: "Cap Alderford", tradeoff: "no race sharpening", status: "proposed" },
    { id: "c", timestamp: "2026-06-14T09:00:00Z", kind: "readiness", summary: "green", status: "note" },
  ];
  const pending = formatDecisions(recs, "pending");
  assert.match(pending, /Pending proposals \(1\)/); // only b
  assert.match(pending, /\[b\] Cap Alderford/);
  assert.match(pending, /confirm id=b/);
  assert.doesNotMatch(pending, /\[a\]/); // a was executed
  assert.doesNotMatch(pending, /\[c\]/); // c is a readiness note, not a proposal

  assert.match(formatDecisions([], "pending"), /No decisions logged yet/);
  assert.match(formatDecisions(recs, "all"), /Decision log \(4 entries/);
});

test("formatCost: empty log, and a windowed report with a per-operation line", async () => {
  const { formatCost } = await import("../src/mcpServer.js");
  assert.match(formatCost([]), /No LLM calls logged yet/);
  // Timestamp must be RELATIVE to now: formatCost(recs, 7) filters to the last 7 days, so a hardcoded
  // date silently expires once today passes date+7d and the per-operation line drops out of the window.
  const recentTs = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 1 day ago — always in-window
  const recs: CostRecord[] = [
    { ts: recentTs, operation: "ask", model: "claude-opus-4-8", input: 100, output: 50, cacheWrite: 0, cacheRead: 0, costUsd: 0.001 },
  ];
  const out = formatCost(recs, 7);
  assert.match(out, /last 7d/);
  assert.match(out, /ask/);
  assert.match(out, /claude-opus-4-8/);
});

test("summarizeState renders provenance + a sync-gaps section for an empty state", async () => {
  const { summarizeState } = await import("../src/mcpServer.js");
  const { emptyState } = await import("../src/state/types.js");
  // today === the assembled day → a FRESH snapshot, so no stale cue.
  const out = summarizeState(emptyState("2026-06-14", "2026-06-14T06:00:00Z"), "2026-06-14");
  assert.match(out, /AthleteState for 2026-06-14/);
  assert.match(out, /planned sessions\s+—/); // unset slots render an em-dash, never a fake zero
  assert.match(out, /sync gaps: 0/);
  assert.doesNotMatch(out, /STALE SNAPSHOT/, "a same-day snapshot is not flagged stale");
});

test("summarizeState flags a snapshot assembled before today (no silent stale read)", async () => {
  const { summarizeState } = await import("../src/mcpServer.js");
  const { emptyState } = await import("../src/state/types.js");
  const out = summarizeState(emptyState("2026-06-14", "2026-06-14T06:00:00Z"), "2026-06-17");
  assert.match(out, /⚠ STALE SNAPSHOT/);
  assert.match(out, /3 days before today \(2026-06-17\)/);
  assert.match(out, /Run `sync`/);
  // The cue leads the output, before the AthleteState body.
  assert.ok(out.indexOf("STALE SNAPSHOT") < out.indexOf("AthleteState for"), "stale cue comes first");
});

test("summarizeState surfaces the actual live numbers (not a bare 'set'), incl. formatted thresholds", async () => {
  const { summarizeState } = await import("../src/mcpServer.js");
  const { emptyState } = await import("../src/state/types.js");
  const s = emptyState("2026-06-14", "2026-06-14T06:00:00Z");
  s.weightKg = { value: 71, source: "garmin" };
  s.hrvOvernight = { value: 88, source: "garmin" };
  s.restingHr = { value: 44, source: "garmin" };
  s.vo2max = { value: 58, source: "garmin" };
  s.thresholds = {
    value: { bikeFtpW: 199, bikeFtpWkg: 2.8, runThresholdPaceSecPerKm: 255, swimCssSecPer100: 95, maxHr: 188 },
    source: "ai-endurance",
  };
  const out = summarizeState(s, "2026-06-14");
  // Scalars show the value, not "set".
  assert.match(out, /weight \(kg\)\s+71 /);
  assert.match(out, /hrv overnight\s+88 /);
  assert.match(out, /resting hr\s+44 /);
  assert.match(out, /vo2max\s+58 /);
  // Thresholds spelled out: FTP (W + W/kg), run pace mm:ss/km, swim CSS mm:ss/100m, max HR.
  assert.match(out, /bike FTP 199 W \(2\.8 W\/kg\)/);
  assert.match(out, /run thr 4:15\/km/); // 255 s = 4:15
  assert.match(out, /swim CSS 1:35\/100m/); // 95 s = 1:35
  assert.match(out, /max HR 188/);
});

test("formatReadiness: tolerates a wellbeing risk with no message and renders drivers", async () => {
  const { formatReadiness } = await import("../src/mcpServer.js");
  const out = formatReadiness(
    { verdict: "amber", why: "one short night", drivers: [{ signal: "HRV", reading: "−1.2 SD", source: "garmin" }], cautions: ["watch sleep"] },
    { level: "moderate" }, // message intentionally absent
  );
  assert.match(out, /Readiness: AMBER/);
  assert.match(out, /HRV: −1.2 SD \[garmin\]/);
  assert.match(out, /Wellbeing \(moderate\)/);
  assert.match(out, /watch sleep/);
});

test("listReports/readReport: newest-first listing and a path-traversal guard", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coach-reports-"));
  const cwd = process.cwd();
  try {
    await mkdir(join(dir, "reports"), { recursive: true });
    await writeFile(join(dir, "reports", "2026-06-10-weekly-review.md"), "# old\n");
    await writeFile(join(dir, "reports", "2026-06-14-deep-dive.md"), "# new deep dive\n");
    await writeFile(join(dir, "reports", "ignore.txt"), "not markdown\n");
    process.chdir(dir);

    const { listReports, readReport } = await import("../src/coach/reports.js");
    const list = await listReports();
    assert.equal(list.length, 2); // .txt excluded
    assert.ok(list.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date)));

    const md = await readReport("2026-06-14-deep-dive.md");
    assert.match(md, /# new deep dive/);

    await assert.rejects(() => readReport("../package.json"), /Invalid report name/);
    await assert.rejects(() => readReport("reports/2026-06-14-deep-dive.md"), /Invalid report name/);
    await assert.rejects(() => readReport("notes.txt"), /Invalid report name/);
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
});
