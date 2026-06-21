import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCareerHistory, type CareerHistory } from "../src/coach/careerHistory.js";
import { renderCareerPage } from "../src/coach/careerPage.js";

const SAMPLE: CareerHistory = {
  generatedAt: "2026-01-01",
  seasonYear: 2026,
  races: [
    {
      date: "2024-06-23",
      sport: "triathlon",
      type: "70.3 triathlon",
      event: "Westfriesland 70.3",
      location: "Hoorn, Netherlands",
      confidence: "confirmed",
      source: "geo+web",
      result: { distanceKm: 83.1, time: "5:00:00", avgW: 190 },
    },
    {
      date: "2014-04-13",
      sport: "run",
      type: "Half-marathon",
      event: "Vienna City Half Marathon",
      location: "Vienna, Austria",
      confidence: "confirmed",
      result: { distanceKm: 21.1, pace: "4:19/km" },
    },
  ],
  bests: [
    { sport: "Run", rows: [{ label: "10k", allTime: { value: "43:12", date: "2016-04-21" }, last90: { value: "47:50" }, season: { value: "46:30" } }] },
  ],
  powerCurve: {
    allTime: [{ durationSec: 5, watts: 966 }, { durationSec: 60, watts: 454 }, { durationSec: 1200, watts: 270 }],
    last90: [{ durationSec: 5, watts: 720 }, { durationSec: 60, watts: 360 }, { durationSec: 1200, watts: 235 }],
  },
};

test("parseCareerHistory: round-trips a valid file and sorts races by date", () => {
  const parsed = parseCareerHistory(JSON.stringify(SAMPLE));
  assert.ok(parsed);
  assert.equal(parsed.races.length, 2);
  assert.equal(parsed.races[0].date, "2014-04-13"); // sorted ascending
  assert.equal(parsed.races[1].event, "Westfriesland 70.3");
  assert.equal(parsed.bests[0].rows[0].allTime?.value, "43:12");
  assert.equal(parsed.powerCurve?.allTime.length, 3);
});

test("parseCareerHistory: garbage / empty / no-content → null (page shows empty state)", () => {
  assert.equal(parseCareerHistory("not json"), null);
  assert.equal(parseCareerHistory("{}"), null);
  assert.equal(parseCareerHistory(JSON.stringify({ races: [{ sport: "run" }] })), null); // race missing date+type
});

test("parseCareerHistory: drops malformed rows but keeps the good ones", () => {
  const parsed = parseCareerHistory(
    JSON.stringify({
      races: [{ date: "2020-01-01", type: "Marathon" }, { sport: "run" }],
      bests: [{ sport: "Run", rows: [{ label: "5k", allTime: { value: "19:30" } }, { allTime: { value: "x" } }] }],
      powerCurve: { allTime: [{ durationSec: 5, watts: 900 }, { durationSec: "x" }] },
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed.races.length, 1);
  assert.equal(parsed.bests[0].rows.length, 1);
  assert.equal(parsed.powerCurve?.allTime.length, 1);
});

test("renderCareerPage(null): friendly empty state names the generator", () => {
  const html = renderCareerPage(null);
  assert.match(html, /No career history yet/);
  assert.match(html, /build-career-history\.mjs/);
});

test("renderCareerPage: renders races, bests columns and a parseable power-curve SVG", () => {
  const html = renderCareerPage(SAMPLE);
  assert.match(html, /Vienna City Half Marathon/);
  assert.match(html, /Hoorn, Netherlands/);
  assert.match(html, /All-time/);
  assert.match(html, /Last 90d/);
  assert.match(html, /Season 2026/);
  assert.match(html, /<svg[^>]*class="pcurve"/);
  // every <svg> closes — the script/markup parses (mirrors dashboard's "script blocks still parse" rule)
  assert.equal((html.match(/<svg/g) ?? []).length, (html.match(/<\/svg>/g) ?? []).length);
});

test("renderCareerPage share view: hides event names + locations, dates → year only", () => {
  const html = renderCareerPage(SAMPLE, true);
  assert.doesNotMatch(html, /Vienna City Half Marathon/);
  assert.doesNotMatch(html, /Hoorn, Netherlands/);
  assert.doesNotMatch(html, /Vienna/);
  assert.match(html, /Race 1/);
  assert.match(html, /Race 2/);
  assert.match(html, />2014</); // year shown
  assert.doesNotMatch(html, /2014-04-13/); // exact date hidden
  // performance numbers are not identifying — still shown
  assert.match(html, /4:19\/km/);
});
