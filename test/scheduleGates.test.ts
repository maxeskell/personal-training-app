import { test } from "node:test";
import assert from "node:assert/strict";
import { lastSunday, weeklyBriefDue, postSwimDue, WEEKLY_CATCHUP_DAYS } from "../src/coach/scheduleGates.js";
import type { ActualActivity } from "../src/state/types.js";

// Calendar anchors used throughout: Sun 2026-07-12 closed the week that Mon 2026-07-06 opened.
const SUN = "2026-07-12";
const MON = "2026-07-13";

test("lastSunday: a Sunday maps to itself, never forward to the next one", () => {
  assert.equal(lastSunday(SUN), SUN);
});

test("lastSunday: every other weekday maps back to the Sunday that closed the last week", () => {
  assert.equal(lastSunday(MON), SUN); // Monday
  assert.equal(lastSunday("2026-07-15"), SUN); // Wednesday
  assert.equal(lastSunday("2026-07-18"), SUN); // Saturday — still the PREVIOUS Sunday
  assert.equal(lastSunday("2026-07-19"), "2026-07-19"); // the next Sunday
});

test("weeklyBriefDue: fires on Sunday when the week has no review", () => {
  const d = weeklyBriefDue(SUN, []);
  assert.equal(d.due, true);
  assert.equal(d.reviewDate, SUN);
});

test("weeklyBriefDue: does not re-fire once Sunday's review exists (no double spend)", () => {
  assert.equal(weeklyBriefDue(SUN, [SUN]).due, false);
});

/**
 * The regression this whole module exists for: on 2026-07-12 the Mac was off, the 06:00 ping never
 * ran, and the old `isSunday(today)` gate meant the week was simply never reviewed. Monday must heal it.
 */
test("weeklyBriefDue: catches up a missed Sunday on the following Monday", () => {
  const d = weeklyBriefDue(MON, ["2026-07-05"]); // last week's review present, this week's missing
  assert.equal(d.due, true);
  assert.match(d.reason, /catching up/);
});

test("weeklyBriefDue: a catch-up files the report against the Sunday it reviews, NOT the day it runs", () => {
  // Dating a Monday catch-up "today" would file last week's review under the new week and corrupt the delta.
  assert.equal(weeklyBriefDue(MON, []).reviewDate, SUN);
  assert.equal(weeklyBriefDue("2026-07-15", []).reviewDate, SUN);
});

test("weeklyBriefDue: stops catching up once the week is stale, rather than reviewing a week you're through", () => {
  const lastGood = "2026-07-15"; // Wednesday — 3 days late, still inside the window
  assert.equal(weeklyBriefDue(lastGood, []).due, true);
  assert.equal(WEEKLY_CATCHUP_DAYS, 3);

  const tooLate = weeklyBriefDue("2026-07-16", []); // Thursday — 4 days late
  assert.equal(tooLate.due, false);
  assert.match(tooLate.reason, /stale/);
});

test("weeklyBriefDue: a manual mid-week `npm run weekly` satisfies the week", () => {
  // A review written Tue 14th is >= Sun 12th, so the catch-up must not spend a second time.
  assert.equal(weeklyBriefDue("2026-07-15", ["2026-07-14"]).due, false);
  // ...but it does NOT satisfy the NEXT Sunday, which is a new week.
  assert.equal(weeklyBriefDue("2026-07-19", ["2026-07-14"]).due, true);
});

const act = (date: string, sport: ActualActivity["sport"]): Pick<ActualActivity, "sport" | "date"> => ({ date, sport });

test("postSwimDue: fires when a swim landed today and no deep dive is written yet", () => {
  const d = postSwimDue(SUN, [act(SUN, "Swim")], []);
  assert.equal(d.due, true);
});

test("postSwimDue: stays quiet on a non-swim day — the six days a week it must spend nothing", () => {
  assert.equal(postSwimDue(SUN, [act(SUN, "Ride"), act(SUN, "Run"), act(SUN, "Other")], []).due, false);
  assert.equal(postSwimDue(SUN, [], []).due, false);
});

test("postSwimDue: yesterday's swim does not trigger today's dive", () => {
  assert.equal(postSwimDue(MON, [act(SUN, "Swim")], []).due, false);
});

test("postSwimDue: today's deep dive already on disk suppresses the job (idempotent, incl. a manual run)", () => {
  const d = postSwimDue(SUN, [act(SUN, "Swim")], [SUN]);
  assert.equal(d.due, false);
  assert.match(d.reason, /already written/);
});

test("postSwimDue: a stale deep dive from another day does not suppress today's", () => {
  assert.equal(postSwimDue(SUN, [act(SUN, "Swim")], ["2026-07-05"]).due, true);
});
