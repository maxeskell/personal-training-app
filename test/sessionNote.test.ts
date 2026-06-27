import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, type AthleteState, type PlannedSession, type ReadinessVerdict } from "../src/state/types.js";
import { nextSessionNote } from "../src/coach/sessionNote.js";
import type { InsightReport } from "../src/insights/engine.js";

/**
 * nextSessionNote is the deterministic, prospective coach note for the imminent session — an execution
 * prior inferred from the title, modulated by today's readiness/form, gating effort DOWN only. Pure.
 */

function sess(p: Partial<PlannedSession>): PlannedSession {
  return { date: "2026-06-28", sport: "Run", ...p };
}
function report(tsb: number | null, rampPerWeek = 0): InsightReport {
  return { load: tsb == null ? null : { tsb, rampPerWeek } } as unknown as InsightReport;
}
function state(verdict: ReadinessVerdict = "green", limiter?: string): AthleteState {
  const s = emptyState("2026-06-28", "2026-06-28T06:00:00Z");
  s.readinessVerdict = verdict;
  if (limiter) s.recovery = { value: { limiterToday: limiter }, source: "garmin" } as never;
  return s;
}

test("intervals title → contrast prior; fresh/green adds no modifier", () => {
  const n = nextSessionNote(sess({ title: "6x3min VO2 intervals", sport: "Run", durationMin: 60 }), report(5), state("green"));
  assert.ok(n);
  assert.match(n!.note, /contrast is the workout/);
  assert.doesNotMatch(n!.note, /fatigue|bias to the easy/);
  assert.ok(n!.basis.some((b) => /intervals/.test(b)));
  assert.ok(n!.basis[0].includes("inferred from title"));
});

test("hard session on deep fatigue (red + bad TSB + limiter) → downgrade, basis names the numbers", () => {
  const n = nextSessionNote(sess({ title: "Threshold 2x20", sport: "Ride", durationMin: 75 }), report(-26), state("red", "hr_rest"));
  assert.ok(n);
  assert.match(n!.note, /carrying fatigue/);
  assert.match(n!.note, /cut the reps|drop it to steady|move it/);
  assert.match(n!.note, /TSB -26/);
  assert.ok(n!.basis.some((b) => b.includes("limiter hr_rest")));
});

test("hard session on mildly low form (amber) → caution, not a downgrade", () => {
  const n = nextSessionNote(sess({ title: "Tempo run", sport: "Run", durationMin: 50 }), report(-14), state("amber"));
  assert.ok(n);
  assert.match(n!.note, /bias to the easy end/);
  assert.doesNotMatch(n!.note, /cut the reps/);
});

test("long endurance ride → long prior; fatigue keeps it strictly easy", () => {
  const easy = nextSessionNote(sess({ title: "Long endurance ride", sport: "Ride", durationMin: 180 }), report(2), state("green"));
  assert.match(easy!.note, /let it run long|durability/);
  const tired = nextSessionNote(sess({ title: "Long endurance ride", sport: "Ride", durationMin: 180 }), report(-24), state("red"));
  assert.match(tired!.note, /strictly easy/);
});

test("recovery prior is never modified by fatigue — easy IS the recovery", () => {
  const n = nextSessionNote(sess({ title: "Recovery spin", sport: "Ride", durationMin: 40 }), report(-30), state("red", "hr_rest"));
  assert.ok(n);
  assert.match(n!.note, /Truly easy|recovery/);
  assert.doesNotMatch(n!.note, /carrying fatigue|cut the reps/);
});

test("easy aerobic volume is kept easy but NOT framed as 'do less' recovery", () => {
  const aerobic = nextSessionNote(sess({ title: "Easy aerobic run", sport: "Run", durationMin: 60 }), report(3), state("green"));
  assert.match(aerobic!.note, /genuinely easy|aerobic base/);
  assert.doesNotMatch(aerobic!.note, /do less|this is recovery/);
  const recovery = nextSessionNote(sess({ title: "Recovery spin", sport: "Ride", durationMin: 40 }), report(3), state("green"));
  assert.match(recovery!.note, /this is recovery|do less/);
});

test("Strength / Other carry no execution note", () => {
  assert.equal(nextSessionNote(sess({ title: "Gym", sport: "Strength" }), report(0), state()), null);
  assert.equal(nextSessionNote(sess({ title: "Yoga", sport: "Other" }), report(0), state()), null);
});

test("no title → honest basis, defaults to a steady endurance prior (no guessed intervals)", () => {
  const n = nextSessionNote(sess({ title: undefined, sport: "Run", durationMin: 45 }), report(null), state("green"));
  assert.ok(n);
  assert.match(n!.note, /Aerobic steady/);
  assert.ok(n!.basis[0].includes("no title"));
});
