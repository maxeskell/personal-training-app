import { test } from "node:test";
import assert from "node:assert/strict";
import { weeklyBriefDue, weekInReviewSlot } from "../src/coach/scheduleGates.js";
import { renderWeekInReviewCard } from "../src/coach/seasonPage.js";
import { localHour } from "../src/util/today.js";

// Sun 2026-07-12 closed the week; Mon 13, Tue 14, Wed 15.
const SUN = "2026-07-12";
const REL = { releaseHour: 16 };

test("weeklyBriefDue: the Sunday-morning ping does NOT review a week whose Sunday sessions haven't happened", () => {
  const d = weeklyBriefDue(SUN, [], { hourNow: 6, ...REL });
  assert.equal(d.due, false);
  assert.match(d.reason, /16:00/);
});

test("weeklyBriefDue: due from the release hour on Sunday", () => {
  assert.equal(weeklyBriefDue(SUN, [], { hourNow: 16, ...REL }).due, true);
  assert.equal(weeklyBriefDue(SUN, [], { hourNow: 21, ...REL }).due, true);
});

test("weeklyBriefDue: Monday catch-up is not held back by the release hour", () => {
  const d = weeklyBriefDue("2026-07-13", [], { hourNow: 6, ...REL });
  assert.equal(d.due, true);
  assert.equal(d.reviewDate, SUN);
});

test("weeklyBriefDue: no hour passed → legacy behaviour (manual/on-demand callers)", () => {
  assert.equal(weeklyBriefDue(SUN, []).due, true);
});

test("weekInReviewSlot: Sunday before release with no review → pending", () => {
  assert.deepEqual(weekInReviewSlot(SUN, 9, 16, "2026-07-05"), { kind: "pending", weekEnding: SUN, releaseHour: 16 });
});

test("weekInReviewSlot: Sunday after release, not written → overdue (honest, not silent)", () => {
  assert.equal(weekInReviewSlot(SUN, 17, 16, "2026-07-05").kind, "overdue");
  assert.equal(weekInReviewSlot("2026-07-14", 9, 16, undefined).kind, "overdue");
});

test("weekInReviewSlot: written → ready Sun–Tue, with next Sunday's release", () => {
  for (const day of [SUN, "2026-07-13", "2026-07-14"]) {
    const s = weekInReviewSlot(day, 18, 16, SUN);
    assert.equal(s.kind, "ready", day);
    if (s.kind === "ready") assert.equal(s.nextRelease, "2026-07-19");
  }
});

test("weekInReviewSlot: off the front page Wed–Sat", () => {
  for (const day of ["2026-07-15", "2026-07-18"]) assert.deepEqual(weekInReviewSlot(day, 12, 16, SUN), { kind: "none" });
});

test("renderWeekInReviewCard: pending names the release time; none renders nothing", () => {
  assert.match(renderWeekInReviewCard({ kind: "pending", weekEnding: SUN, releaseHour: 16 }, undefined, "Europe/London"), /today at 16:00/);
  assert.equal(renderWeekInReviewCard({ kind: "none" }, undefined, "Europe/London"), "");
});

test("renderWeekInReviewCard: ready shows written time, next release, keeps Next week, escapes", () => {
  const html = renderWeekInReviewCard(
    { kind: "ready", weekEnding: SUN, releaseHour: 16, nextRelease: "2026-07-19" },
    { markdown: "# Weekly review\n\nGood week <script>x</script>.\n\n## Next week\n\n- Long ride", date: SUN, writtenAt: "2026-07-12T15:02:00Z" },
    "Europe/London",
  );
  assert.match(html, /written Sun 16:02/); // BST
  assert.match(html, /next one Sun 19 Jul, 16:00/);
  assert.match(html, /Long ride/);
  assert.doesNotMatch(html, /<script>/);
});

test("localHour: respects the athlete timezone across BST", () => {
  assert.equal(localHour("Europe/London", new Date("2026-07-12T15:30:00Z")), 16);
  assert.equal(localHour("Europe/London", new Date("2026-12-13T15:30:00Z")), 15);
});
