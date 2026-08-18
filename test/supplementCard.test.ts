import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSupplementViews, renderSupplementCard, isoDateInTz } from "../src/coach/supplementCard.js";
import { validateProfile, type Profile } from "../src/profile/schema.js";

/**
 * The supplements card must: classify entries deterministically against an injected "today" + the race
 * calendar (seasonal windows, race-week loading, race-day, daily); park lapsed/out-of-window entries
 * behind a disclosure; surface `proposed` entries as discuss-first; render NOTHING when the profile
 * lists no supplements (the nudge rides the profile-questions machinery); redact race names/dates in
 * share view; and ESCAPE adversarial names (dashboard invariant — the card itself emits no script).
 */

const TZ = "Europe/London";
const ms = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
const RACES = [{ name: "Alderford", priority: "B", date: "2026-09-06", distance: "olympic" }];

const prof = (supps: unknown[], races: unknown[] = RACES): Profile =>
  validateProfile({ schema_version: 1, identity: {}, supplements: supps, races });

const D3 = {
  name: "Vitamin D3",
  dose: "400 IU/day",
  when: "seasonal",
  months: ["october", "november", "december", "january", "february", "march"],
  evidence: "guideline",
};
const BEET = { name: "Nitrate shot", when: "race_week", days_before_race: 3 };

test("schema: a full supplements block validates; bad month/status/when are rejected", () => {
  const p = prof([D3, BEET, { name: "Caffeine", when: "race_day" }, { name: "Creatine", status: "proposed" }]);
  assert.equal(p.supplements?.length, 4);
  assert.throws(() => prof([{ name: "X", when: "seasonal", months: ["oct"] }]), /invalid/i);
  assert.throws(() => prof([{ name: "X", status: "maybe" }]), /invalid/i);
  assert.throws(() => prof([{ name: "X", when: "sometimes" }]), /invalid/i);
});

test("isoDateInTz: timezone decides the day boundary; a bad zone degrades to UTC", () => {
  assert.equal(isoDateInTz(Date.parse("2026-01-15T23:30:00Z"), "Pacific/Auckland"), "2026-01-16");
  assert.equal(isoDateInTz(Date.parse("2026-01-15T23:30:00Z"), TZ), "2026-01-15");
  assert.equal(isoDateInTz(Date.parse("2026-01-15T23:30:00Z"), "not/a-zone"), "2026-01-15");
});

test("seasonal: active in-window, 'starts 1 October' when approaching, parked when far out", () => {
  let [v] = buildSupplementViews(prof([D3]).supplements!, [], "2027-01-15", false);
  assert.equal(v!.bucket, "active");
  assert.match(v!.timing, /through March/);

  [v] = buildSupplementViews(prof([D3]).supplements!, [], "2026-09-01", false);
  assert.equal(v!.bucket, "upcoming");
  assert.match(v!.timing, /starts 1 October — in 30 days/);

  [v] = buildSupplementViews(prof([{ ...D3, months: ["february"] }]).supplements!, [], "2026-09-01", false);
  assert.equal(v!.bucket, "parked");
  assert.match(v!.timing, /resumes 1 February/);

  [v] = buildSupplementViews(prof([{ name: "X", when: "seasonal" }]).supplements!, [], "2026-09-01", false);
  assert.equal(v!.bucket, "parked");
  assert.match(v!.timing, /no months set/);
});

test("race_week: counts off the next race — active inside the loading window, dated start when ahead", () => {
  const supps = prof([BEET]).supplements!;
  const races = prof([BEET]).races!;

  let [v] = buildSupplementViews(supps, races, "2026-09-04", false);
  assert.equal(v!.bucket, "active");
  assert.match(v!.timing, /race week — Alderford \(Sun 6 Sep\) in 2 days/);

  [v] = buildSupplementViews(supps, races, "2026-09-06", false);
  assert.equal(v!.bucket, "active");
  assert.match(v!.timing, /race day — Alderford/);

  [v] = buildSupplementViews(supps, races, "2026-08-18", false);
  assert.equal(v!.bucket, "upcoming");
  assert.match(v!.timing, /starts Thu 3 Sep — final 3 days before Alderford/);

  [v] = buildSupplementViews(supps, [], "2026-08-18", false);
  assert.equal(v!.bucket, "parked");
  assert.match(v!.timing, /no upcoming race/);
});

test("race_day: active only on the day; named as 'race morning' when ahead", () => {
  const supps = prof([{ name: "Caffeine", when: "race_day" }]).supplements!;
  const races = prof([]).races!;

  let [v] = buildSupplementViews(supps, races, "2026-09-06", false);
  assert.equal(v!.bucket, "active");
  assert.match(v!.timing, /race day — Alderford/);

  [v] = buildSupplementViews(supps, races, "2026-08-18", false);
  assert.equal(v!.bucket, "upcoming");
  assert.match(v!.timing, /race morning before Alderford/);
});

test("defaults: a bare {name} is an active daily entry", () => {
  const [v] = buildSupplementViews(prof([{ name: "Plain" }]).supplements!, [], "2026-08-18", false);
  assert.equal(v!.bucket, "active");
  assert.equal(v!.timing, "daily");
});

test("share view: race names and dates are redacted from race-tied timing lines", () => {
  const html = renderSupplementCard({ profile: prof([BEET]), nowMs: ms("2026-08-18"), timezone: TZ, share: true });
  assert.ok(!html.includes("Alderford"), "race name must not leak in share view");
  assert.ok(!/Sep/.test(html), "race-derived dates must not leak in share view");
  assert.match(html, /the next race/);
});

test("render: sections for active/upcoming/proposed, lapsed parked behind a disclosure, honest footer", () => {
  const html = renderSupplementCard({
    profile: prof([
      { name: "Plain daily" },
      D3,
      { name: "Creatine <script>alert(1)</script>", status: "proposed", why: "lean mass & strength" },
      { name: "Beta-Alanine", status: "lapsed", notes: "lapsed Aug 2026" },
    ]),
    nowMs: ms("2026-08-18"),
    timezone: TZ,
  });
  assert.match(html, /Active now/);
  assert.match(html, /Coming up/); // D3 approaching its 1 Oct start on 18 Aug? 44 days out → upcoming
  assert.match(html, /Proposed — discuss with coach first/);
  assert.match(html, /Not in use \/ out of window \(1\)/);
  assert.match(html, /not medical advice/i);
  assert.ok(!html.includes("<script>alert"), "adversarial names must be escaped");
  assert.match(html, /&lt;script&gt;alert/);
  assert.ok(!html.includes("<script"), "the card must emit no script at all");
});

test("render: no supplements → empty string (quiet, the nudge lives in profile questions)", () => {
  assert.equal(renderSupplementCard({ profile: prof([]), nowMs: ms("2026-08-18"), timezone: TZ }), "");
  assert.equal(renderSupplementCard({ profile: undefined, nowMs: ms("2026-08-18"), timezone: TZ }), "");
});

test("no-live-numbers guard: doses as free text pass; a live-metric key planted in an entry is rejected", () => {
  assert.ok(prof([{ name: "D3", dose: "400 IU/day" }]));
  assert.throws(() => prof([{ name: "X", ftp: 250 }]), /live performance numbers/);
});
