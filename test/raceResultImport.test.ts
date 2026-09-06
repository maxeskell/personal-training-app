import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clockFromSeconds,
  formatImport,
  inferSport,
  mergeRaceIntoHistory,
  mergeSplits,
  officialClockToSeconds,
  parseOfficialResult,
  positionLabel,
  raceFromOfficial,
} from "../src/coach/raceResultImport.js";
import { parseCareerHistory, type CareerHistory } from "../src/coach/careerHistory.js";

// The block exactly as a UK timing-company results page pastes it (placeholder athlete).
const PASTE = `38\tJane Doe\t02:42:11.9\tFIN
Race No: 71
Category: Open
Finish Status: Finished
A/G Category: I
A/G Pos: 4/18
Age Group: Ages 45 - 49
Age: 45
Team: Example CC

Swim: 00:35:58.4
T1: 00:02:50.8
Cycle: 01:15:50.0
T2: 00:01:06.5
Run: 00:46:26.3
`;

test("officialClockToSeconds / clockFromSeconds: tenths round to the second, bad clocks are null", () => {
  assert.equal(officialClockToSeconds("02:42:11.9"), 2 * 3600 + 42 * 60 + 12);
  assert.equal(officialClockToSeconds("00:35:58.4"), 35 * 60 + 58);
  assert.equal(officialClockToSeconds("46:26.3"), 46 * 60 + 26);
  assert.equal(officialClockToSeconds("1:06"), 66);
  assert.equal(officialClockToSeconds("12:75"), null);
  assert.equal(officialClockToSeconds("DNF"), null);
  assert.equal(clockFromSeconds(2 * 3600 + 42 * 60 + 12), "2:42:12");
  assert.equal(clockFromSeconds(35 * 60 + 58), "35:58");
  assert.equal(clockFromSeconds(66), "1:06");
});

test("parseOfficialResult: reads the finish row, placings, age group and the five legs in race order", () => {
  const r = parseOfficialResult(PASTE);
  assert.ok(r);
  assert.equal(r.time, "2:42:12");
  assert.equal(r.timeRaw, "02:42:11.9");
  assert.equal(r.overallPos, 38);
  assert.equal(r.agPos, 4);
  assert.equal(r.agTotal, 18);
  assert.equal(r.ageGroup, "45–49");
  assert.equal(r.category, "Open");
  assert.equal(r.raceNo, "71");
  assert.equal(r.team, "Example CC");
  assert.equal(r.finishStatus, "Finished");
  assert.deepEqual(
    r.legs.map((l) => [l.label, l.time]),
    [["Swim", "35:58"], ["T1", "2:51"], ["Bike", "1:15:50"], ["T2", "1:07"], ["Run", "46:26"]],
  );
  assert.equal(positionLabel(r), "38th overall · 4th of 18 AG (45–49)");
});

test("parseOfficialResult: a run result with only a Time: field and no legs still parses; junk is null", () => {
  const r = parseOfficialResult("Position: 112\nTime: 1:45:30\nCategory: MV45");
  assert.ok(r);
  assert.equal(r.time, "1:45:30");
  assert.equal(r.overallPos, 112);
  assert.equal(r.legs.length, 0);
  assert.equal(positionLabel(r), "112th overall");
  assert.equal(parseOfficialResult("no clocks here\nCategory: Open"), null);
  // A bare leg line without a finish must not be mistaken for the finish clock.
  assert.equal(parseOfficialResult("Swim: 00:35:58.4"), null);
});

test("ordinal suffixes are English, including the teens", () => {
  const r = (pos: number) => positionLabel({ time: "1:00:00", timeSec: 3600, timeRaw: "1:00:00", overallPos: pos, legs: [] });
  assert.equal(r(1), "1st overall");
  assert.equal(r(2), "2nd overall");
  assert.equal(r(3), "3rd overall");
  assert.equal(r(11), "11th overall");
  assert.equal(r(12), "12th overall");
  assert.equal(r(13), "13th overall");
  assert.equal(r(22), "22nd overall");
  assert.equal(r(101), "101st overall");
  assert.equal(r(111), "111th overall");
});

test("inferSport / raceFromOfficial: a triathlon entry the career page + spec-07 review can read", () => {
  assert.equal(inferSport("Olympic triathlon"), "triathlon");
  assert.equal(inferSport("Half-marathon"), "run");
  assert.equal(inferSport("Sportive 169 km"), "ride");
  assert.equal(inferSport("Duathlon"), "duathlon");
  const parsed = parseOfficialResult(PASTE)!;
  const race = raceFromOfficial({ date: "2026-09-06", type: "Olympic triathlon", event: "Example Lake Triathlon" }, parsed);
  assert.equal(race.sport, "triathlon");
  assert.equal(race.source, "official");
  assert.equal(race.confidence, undefined); // no location given → not "confirmed"
  assert.equal(race.position, "38th overall · 4th of 18 AG (45–49)");
  assert.equal(race.result?.time, "2:42:12");
  assert.equal(race.result?.splits?.length, 5);
  // Round-trips through the career-history validator unchanged (what the page and the review load).
  const hist = parseCareerHistory(JSON.stringify({ races: [race] }));
  assert.ok(hist);
  assert.equal(hist.races[0].position, race.position);
  assert.deepEqual(
    hist.races[0].result?.splits?.map((s) => [s.label, s.time]),
    race.result?.splits?.map((s) => [s.label, s.time]),
  );
});

test("mergeSplits: official times override per label, FIT-only fields on that leg survive", () => {
  const fit = [
    { label: "Swim", dist: "1.50 km", time: "35:40", pace: "2:23/100m", hr: 152 },
    { label: "Bike", dist: "40.1 km", time: "1:15:30", watts: 201, hr: 158 },
    { label: "Run", dist: "10.0 km", time: "46:10", pace: "4:37/km", hr: 171 },
  ];
  const official = [
    { label: "Swim", time: "35:58" },
    { label: "T1", time: "2:51" },
    { label: "Bike", time: "1:15:50" },
    { label: "T2", time: "1:07" },
    { label: "Run", time: "46:26" },
  ];
  const merged = mergeSplits(fit, official)!;
  assert.deepEqual(
    merged.map((s) => [s.label, s.time, s.hr ?? null, s.watts ?? null]),
    [["Swim", "35:58", 152, null], ["T1", "2:51", null, null], ["Bike", "1:15:50", 158, 201], ["T2", "1:07", null, null], ["Run", "46:26", 171, null]],
  );
  assert.equal(merged[0].dist, "1.50 km");
  // No official legs → existing splits untouched; no existing → official copied.
  assert.equal(mergeSplits(fit, []), fit);
  assert.deepEqual(mergeSplits(undefined, official), official);
});

test("mergeRaceIntoHistory: adds to an empty history, updates the race on that date, keeps everything else", () => {
  const parsed = parseOfficialResult(PASTE)!;
  const race = raceFromOfficial({ date: "2026-09-06", type: "Olympic triathlon", event: "Example Lake Triathlon", location: "Example Lake" }, parsed);
  const added = mergeRaceIntoHistory(null, race);
  assert.equal(added.action, "added");
  assert.equal(added.history.races.length, 1);
  assert.equal(added.history.races[0].confidence, "confirmed");

  const existing: CareerHistory = {
    generatedAt: "2026-09-01",
    seasonYear: 2026,
    races: [
      { date: "2026-07-13", sport: "triathlon", type: "Sprint triathlon", event: "Example City Sprint", result: { time: "2:39:12" } },
      {
        date: "2026-09-06",
        sport: "triathlon",
        type: "Standard triathlon",
        event: "Example Lake Standard",
        location: "Example Lake (nearest-town approx)",
        confidence: "strong",
        source: "geo",
        result: { via: "fit", avgHr: 160, splits: [{ label: "Swim", time: "35:40", hr: 152 }, { label: "Bike", time: "1:15:30", watts: 201 }, { label: "Run", time: "46:10", hr: 171 }] },
      },
    ],
    bests: [{ sport: "Run", rows: [{ label: "10k", allTime: { value: "43:12" } }] }],
    powerCurve: { allTime: [{ durationSec: 300, watts: 330 }] },
  };
  const upd = mergeRaceIntoHistory(existing, raceFromOfficial({ date: "2026-09-06", type: "Olympic triathlon" }, parsed));
  assert.equal(upd.action, "updated");
  assert.equal(upd.history.races.length, 2);
  const r = upd.history.races[1];
  assert.equal(r.event, "Example Lake Standard"); // no --event given → the curated name stays
  assert.equal(r.location, "Example Lake (nearest-town approx)");
  assert.equal(r.confidence, "strong"); // no --location → confidence untouched
  assert.equal(r.type, "Olympic triathlon");
  assert.equal(r.source, "geo+official");
  assert.equal(r.position, "38th overall · 4th of 18 AG (45–49)");
  assert.equal(r.result?.time, "2:42:12");
  assert.equal(r.result?.avgHr, 160); // FIT summary fields survive
  assert.equal(r.result?.via, "fit");
  assert.deepEqual(
    r.result?.splits?.map((s) => [s.label, s.time, s.hr ?? s.watts ?? null]),
    [["Swim", "35:58", 152], ["T1", "2:51", null], ["Bike", "1:15:50", 201], ["T2", "1:07", null], ["Run", "46:26", 171]],
  );
  // Untouched sections and the other race are carried through, and the input wasn't mutated.
  assert.deepEqual(upd.history.bests, existing.bests);
  assert.deepEqual(upd.history.powerCurve, existing.powerCurve);
  assert.equal(upd.history.races[0].result?.time, "2:39:12");
  assert.equal(existing.races[1].position, undefined);
  assert.equal(existing.races[1].result?.time, undefined);
});

test("formatImport: names what was written, shows the rounding, and never claims a dry run wrote", () => {
  const parsed = parseOfficialResult(PASTE)!;
  const race = raceFromOfficial({ date: "2026-09-06", type: "Olympic triathlon", event: "Example Lake Triathlon" }, parsed);
  const dry = formatImport(parsed, mergeRaceIntoHistory(null, race), "/x/career-history.json", true).join("\n");
  assert.match(dry, /^Would write Example Lake Triathlon \(2026-09-06\) to \/x\/career-history\.json/);
  assert.match(dry, /2:42:12 \(page: 02:42:11\.9, rounded to the second\)/);
  assert.match(dry, /38th overall · 4th of 18 AG/);
  assert.match(dry, /category Open · race no 71 · team Example CC · Finished \(not stored\)/);
  assert.match(dry, /Bike\s+1:15:50/);
  assert.doesNotMatch(dry, /track record/);
  const wet = formatImport(parsed, mergeRaceIntoHistory(null, race), "/x/career-history.json", false).join("\n");
  assert.match(wet, /^Added Example Lake Triathlon/);
  assert.match(wet, /Model track record/);
});
