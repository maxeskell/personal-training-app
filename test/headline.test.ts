import { test } from "node:test";
import assert from "node:assert/strict";
import { coachHeadline } from "../src/insights/headline.js";
import { emptyState } from "../src/state/types.js";
import type { AthleteState } from "../src/state/types.js";
import type { InsightReport } from "../src/insights/engine.js";

/**
 * COACH-2: a RED headline requires a PATTERN. A lone deep-fatigue TSB band alongside one flag is amber;
 * it only goes red when corroborated (a chronic-window ACWR HIGH, a recovery limiter, or a second flag).
 */
const flag = (title: string) => ({ family: "Injury risk", title, severity: "flag" as const, detail: "d", evidence: "e" });
const report = (findings: unknown[], tsb: number): InsightReport =>
  ({ topFindings: findings, load: { tsb } } as unknown as InsightReport);

function state(opts: { limiter?: string; acwr?: string } = {}): AthleteState {
  const s = emptyState("2026-06-14", "2026-06-14T06:00:00Z");
  if (opts.limiter) s.recovery = { value: { limiterToday: opts.limiter, orthopedic: {} }, source: "ai-endurance" } as AthleteState["recovery"];
  if (opts.acwr) s.trainingStatus = { value: { acwrStatus: opts.acwr, loadRatio: 1.6 }, source: "garmin" } as AthleteState["trainingStatus"];
  return s;
}

test("a lone flag + deep-fatigue TSB (no corroboration) is amber, not red", () => {
  const h = coachHeadline(report([flag("Run load spiked")], -25), state());
  assert.equal(h.severity, "amber");
});

test("a flag + deep fatigue + ACWR HIGH is red", () => {
  const h = coachHeadline(report([flag("Run load spiked")], -25), state({ acwr: "HIGH" }));
  assert.equal(h.severity, "red");
});

test("a flag + deep fatigue + a recovery limiter is red", () => {
  const h = coachHeadline(report([flag("Run load spiked")], -25), state({ limiter: "orthopedic_run" }));
  assert.equal(h.severity, "red");
});

test("two flags + deep fatigue is red (a pattern of flags)", () => {
  const h = coachHeadline(report([flag("Run load spiked"), flag("Monotony high")], -25), state());
  assert.equal(h.severity, "red");
});

test("a flag without deep fatigue or ACWR is amber", () => {
  const h = coachHeadline(report([flag("Run load spiked")], 0), state());
  assert.equal(h.severity, "amber");
});
