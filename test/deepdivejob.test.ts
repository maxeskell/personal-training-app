import { test } from "node:test";
import assert from "node:assert/strict";
import { nextDeepDiveAction, type DeepDiveJob } from "../src/coach/deepDive.js";

/**
 * `deep_dive` is async (background generation + report on disk) so it can't outlive the MCP client's
 * request timeout. `nextDeepDiveAction` is the pure decision at the centre of the tool — these pin the
 * ordering rules that keep it from double-spending the LLM or handing back a stale/half-written report.
 */

const TODAY = "2026-07-14";
const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);
const base = { today: TODAY, now: NOW };

test("start: no report and no job → generate", () => {
  const a = nextDeepDiveAction({ ...base, reportExists: false, job: null, refresh: false });
  assert.deepEqual(a, { kind: "start" });
});

test("return-report: today's report exists and no refresh → hand it back, no LLM", () => {
  const a = nextDeepDiveAction({ ...base, reportExists: true, job: null, refresh: false });
  assert.deepEqual(a, { kind: "return-report" });
});

test("refresh regenerates even when today's report already exists", () => {
  const a = nextDeepDiveAction({ ...base, reportExists: true, job: null, refresh: true });
  assert.deepEqual(a, { kind: "start" });
});

test("in-progress: an unfinished job wins over everything — never start a second run", () => {
  const job: DeepDiveJob = { date: TODAY, startedAt: NOW - 45_000, done: false };
  // even with refresh=true and a report on disk, the running job takes priority
  const a = nextDeepDiveAction({ ...base, reportExists: true, job, refresh: true });
  assert.deepEqual(a, { kind: "in-progress", elapsedSec: 45 });
});

test("report-error: a settled failed job surfaces its error (no report yet)", () => {
  const job: DeepDiveJob = { date: TODAY, startedAt: NOW - 90_000, done: true, error: "LLM 529 overloaded" };
  const a = nextDeepDiveAction({ ...base, reportExists: false, job, refresh: false });
  assert.deepEqual(a, { kind: "report-error", error: "LLM 529 overloaded" });
});

test("a finished successful job with its report on disk returns the report", () => {
  const job: DeepDiveJob = { date: TODAY, startedAt: NOW - 90_000, done: true };
  const a = nextDeepDiveAction({ ...base, reportExists: true, job, refresh: false });
  assert.deepEqual(a, { kind: "return-report" });
});

test("a stale job from a previous day is ignored → start today's", () => {
  const job: DeepDiveJob = { date: "2026-07-13", startedAt: NOW - 3_600_000, done: false };
  const a = nextDeepDiveAction({ ...base, reportExists: false, job, refresh: false });
  assert.deepEqual(a, { kind: "start" });
});

test("elapsedSec never goes negative if clocks skew", () => {
  const job: DeepDiveJob = { date: TODAY, startedAt: NOW + 5_000, done: false };
  const a = nextDeepDiveAction({ ...base, reportExists: false, job, refresh: false });
  assert.deepEqual(a, { kind: "in-progress", elapsedSec: 0 });
});
