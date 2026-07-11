import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCareerHistory, type CareerHistory } from "../src/coach/careerHistory.js";
import { renderCareerPage, mergeCoincidentSeries, type PowerSeries } from "../src/coach/careerPage.js";

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
      position: "19th overall · 1st of 8 AG",
      result: { distanceKm: 83.1, time: "5:00:00", avgW: 190 },
    },
    {
      date: "2014-04-13",
      sport: "run",
      type: "Half-marathon",
      event: "Vienna City Half Marathon",
      location: "Vienna, Austria",
      confidence: "confirmed",
      result: {
        distanceKm: 21.1,
        pace: "4:19/km",
        avgHr: 168,
        via: "fit",
        splits: [
          { label: "#1", dist: "5.00 km", time: "21:30", pace: "4:18/km", hr: 165 },
          { label: "#2", dist: "5.00 km", time: "21:45", pace: "4:21/km", hr: 170 },
        ],
      },
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

test("careerPage: finishing position round-trips, renders under the event, and is hidden in share view", () => {
  const parsed = parseCareerHistory(JSON.stringify(SAMPLE));
  assert.equal(parsed?.races.find((r) => r.sport === "triathlon")?.position, "19th overall · 1st of 8 AG");
  const html = renderCareerPage(SAMPLE);
  assert.ok(html.includes("19th overall · 1st of 8 AG"), "position shown on the race row");
  const shared = renderCareerPage(SAMPLE, true);
  assert.ok(!shared.includes("19th overall"), "share view hides the placing (identifying with the event)");
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

test("parseCareerHistory: round-trips a race's avgHr, via + splits", () => {
  const parsed = parseCareerHistory(JSON.stringify(SAMPLE));
  assert.ok(parsed);
  const run = parsed.races.find((r) => r.sport === "run");
  assert.ok(run?.result);
  assert.equal(run.result.avgHr, 168);
  assert.equal(run.result.via, "fit");
  assert.equal(run.result.splits?.length, 2);
  assert.equal(run.result.splits?.[0].pace, "4:18/km");
  // a bad `via` and a label-less split row are dropped
  const cleaned = parseCareerHistory(
    JSON.stringify({ races: [{ date: "2020-01-01", type: "Marathon", result: { via: "web", splits: [{ time: "1:00" }] } }] }),
  );
  assert.equal(cleaned?.races[0].result?.via, undefined);
  assert.equal(cleaned?.races[0].result?.splits, undefined);
});

test("renderCareerPage: renders a per-race splits table + provenance tag", () => {
  const html = renderCareerPage(SAMPLE);
  assert.match(html, /<details class="splits"><summary>Splits \(2\)<\/summary>/);
  assert.match(html, /4:18\/km/); // a split pace cell
  assert.match(html, /168 bpm/); // avg HR in the summary
  assert.match(html, /\.FIT<\/span>/); // provenance tag
});

test("renderCareerPage share view: still shows non-identifying splits, hides provenance tag", () => {
  const html = renderCareerPage(SAMPLE, true);
  assert.match(html, /<details class="splits">/); // splits are performance numbers — kept
  assert.doesNotMatch(html, /\.FIT<\/span>/); // provenance tag hidden with names/locations
});

test("renderCareerPage: multisport race with no finish time sums its leg splits into a total", () => {
  // A 70.3 whose overall time wasn't hand-authored (enrichRaceResults leaves it author-owned) but whose
  // swim/bike/run legs each carry a time → Performance shows ≈ the summed total, labelled as excl. transitions.
  const data: CareerHistory = {
    races: [
      {
        date: "2023-07-01",
        sport: "triathlon",
        type: "70.3 triathlon",
        event: "Example 70.3",
        location: "Somewhere",
        result: {
          splits: [
            { label: "Swim", dist: "1.90 km", time: "32:10", hr: 150 },
            { label: "Bike", dist: "90.00 km", time: "2:35:00", watts: 200, hr: 148 },
            { label: "Run", dist: "21.10 km", time: "1:48:00", pace: "5:07/km", hr: 160 },
          ],
        },
      },
    ],
    bests: [],
  };
  const html = renderCareerPage(data);
  assert.match(html, /≈4:55:10/); // 32:10 + 2:35:00 + 1:48:00
  assert.match(html, /∑ splits/); // honest-model tag
  // Share view keeps the (non-identifying) total but drops the explanatory tag, like the .FIT provenance tag.
  const shared = renderCareerPage(data, true);
  assert.match(shared, /≈4:55:10/);
  assert.doesNotMatch(shared, /∑ splits/);
});

test("renderCareerPage: a partial set of single-sport laps is NOT summed (would undercount)", () => {
  // SAMPLE's Vienna half has two 5 km lap splits and no finish time — summing them (43:15) would be a
  // misleading 'total' for a 21.1 km race, so a single-sport race never gets a derived total.
  const html = renderCareerPage(SAMPLE);
  assert.doesNotMatch(html, /≈43:15/);
  assert.doesNotMatch(html, /∑ splits/);
});

test("renderCareerPage(null): friendly empty state names the generator", () => {
  const html = renderCareerPage(null);
  assert.match(html, /No career history yet/);
  assert.match(html, /build-career-history\.ts/);
  assert.match(html, /career:build/);
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

test("powerCurveSvg: axis is floored to the data (not zero) and every point carries its exact figure", () => {
  const html = renderCareerPage(SAMPLE); // watts 966..235, so the axis should start at 200, not 0
  // Data labels: each point prints its watts (e.g. the 966 W all-time sprint), not just a dot.
  assert.match(html, /class="dl"[^>]*>966</, "each point is labelled with its exact watts");
  assert.match(html, /class="dl"[^>]*>235</);
  // Cut scale: the baseline gridline is 200 W, and there is no 0 W tick eating the lower half of the plot.
  assert.match(html, /class="ax">200</, "y-axis is floored to a round value below the data minimum");
  assert.doesNotMatch(html, /class="ax">0</, "the axis no longer starts at zero");
});

test("mergeCoincidentSeries: identical curves collapse to one labelled line so neither hides the other", () => {
  // The real-world trigger: every season best was also set inside the last 90 days, so last90 === season.
  const recent: PowerSeries["pts"] = [{ durationSec: 5, watts: 577 }, { durationSec: 60, watts: 313 }];
  const merged = mergeCoincidentSeries([
    { name: "All-time", color: "#1f4e79", pts: [{ durationSec: 5, watts: 853 }, { durationSec: 60, watts: 454 }] },
    { name: "Last 90 days", color: "#c8642d", pts: recent },
    { name: "Season", color: "#2e7d57", pts: [...recent] }, // distinct object, identical values
  ]);
  assert.equal(merged.length, 2, "the two identical curves become a single line");
  assert.deepEqual(merged.map((s) => s.name), ["All-time", "Last 90 days / Season"]);
  assert.equal(merged[1].color, "#c8642d", "the first coincident series keeps its colour (the last-90 line stays visible)");
});

test("mergeCoincidentSeries: distinct curves are untouched — order, names and colours preserved", () => {
  const series: PowerSeries[] = [
    { name: "All-time", color: "#1f4e79", pts: [{ durationSec: 5, watts: 853 }] },
    { name: "Last 90 days", color: "#c8642d", pts: [{ durationSec: 5, watts: 577 }] },
  ];
  assert.deepEqual(mergeCoincidentSeries(series), series);
});

test("mergeCoincidentSeries: point order doesn't matter — same set of points still coincides", () => {
  const merged = mergeCoincidentSeries([
    { name: "Last 90 days", color: "#c8642d", pts: [{ durationSec: 60, watts: 313 }, { durationSec: 5, watts: 577 }] },
    { name: "Season", color: "#2e7d57", pts: [{ durationSec: 5, watts: 577 }, { durationSec: 60, watts: 313 }] },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, "Last 90 days / Season");
});

test("renderCareerPage: coincident last-90/season render as one legend entry (the missing-line bug)", () => {
  const data: CareerHistory = {
    generatedAt: "2026-07-03",
    seasonYear: 2026,
    races: [],
    bests: [],
    powerCurve: {
      allTime: [{ durationSec: 5, watts: 853 }, { durationSec: 60, watts: 454 }],
      last90: [{ durationSec: 5, watts: 577 }, { durationSec: 60, watts: 313 }],
      season: [{ durationSec: 5, watts: 577 }, { durationSec: 60, watts: 313 }], // identical to last90
    },
  };
  const html = renderCareerPage(data);
  assert.match(html, /Last 90 days \/ Season/, "the coincident curves share one honest legend label");
  // Exactly two coloured polylines are drawn (all-time + the merged line) — not three with one hidden.
  assert.equal((html.match(/<polyline /g) ?? []).length, 2);
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

test("Bests: a ride-power row carries the honest 'NP over a whole ride, not a duration record' caveat", () => {
  const withRidePower: CareerHistory = {
    races: [],
    bests: [{ sport: "Bike", rows: [{ label: "Best ride power (NP)", allTime: { value: "267 W", date: "2022-07-17" } }] }],
  };
  const html = renderCareerPage(withRidePower);
  assert.match(html, /Best ride power<\/b> is normalized power \(NP\)/);
  assert.match(html, /not a fixed-duration record/);

  // No ride-power row → no caveat (it's specific to that metric, not boilerplate on every bests card).
  const runOnly: CareerHistory = {
    races: [],
    bests: [{ sport: "Run", rows: [{ label: "10k", allTime: { value: "43:12" } }] }],
  };
  assert.doesNotMatch(renderCareerPage(runOnly), /normalized power \(NP\)/);
});
