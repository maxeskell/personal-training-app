import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReview,
  newReviews,
  parseResultSeconds,
  predictionFromPlan,
  raceKey,
  upsertPredictions,
  type CareerRaceLike,
  type RacePredictionRecord,
} from "../src/insights/raceReview.js";
import type { RaceSplitPlan } from "../src/insights/splits.js";

const plan = (over: Partial<RaceSplitPlan> = {}): RaceSplitPlan => ({
  race: "Alderford Standard",
  date: "2026-09-06",
  distanceKm: 51.5,
  predictedSec: 9200,
  strategy: "",
  segments: [
    { label: "Swim", splitSec: 1800, cumulativeSec: 1800 } as RaceSplitPlan["segments"][number],
    { label: "Bike", splitSec: 4500, cumulativeSec: 6300 } as RaceSplitPlan["segments"][number],
    { label: "Run", splitSec: 2700, cumulativeSec: 9000 } as RaceSplitPlan["segments"][number],
  ],
  bestSec: 9000,
  worstSec: 9500,
  ...over,
});

const pred = (over: Partial<RacePredictionRecord> = {}): RacePredictionRecord => ({
  key: raceKey("2026-09-06", "Alderford Standard"),
  race: "Alderford Standard",
  date: "2026-09-06",
  stateDate: "2026-09-05",
  savedAt: "2026-09-05T07:00:00Z",
  predictedSec: 9200,
  bestSec: 9000,
  worstSec: 9500,
  legs: [
    { label: "Swim", splitSec: 1800 },
    { label: "Bike", splitSec: 4500 },
    { label: "Run", splitSec: 2700 },
  ],
  ...over,
});

test("parseResultSeconds: H:MM:SS unambiguous; two-token clocks resolved against the prediction", () => {
  assert.equal(parseResultSeconds("2:39:12"), 9552);
  // "46:32" near a ~45-minute prediction is MM:SS, not H:MM.
  assert.equal(parseResultSeconds("46:32", 2700), 46 * 60 + 32);
  assert.equal(parseResultSeconds(undefined), null);
  assert.equal(parseResultSeconds("DNF"), null);
});

test("predictionFromPlan: freezes a complete pre-race plan; refuses partial or post-race ones", () => {
  const rec = predictionFromPlan(plan({ targetCheck: { targetLabel: "sub 2:35", targetSec: 9300, verdict: "in-range", gapPct: 3, note: "" } }), "2026-09-05", "2026-09-05T07:00:00Z");
  assert.ok(rec);
  assert.equal(rec.key, raceKey("2026-09-06", "Alderford Standard"));
  assert.equal(rec.legs.length, 3);
  assert.equal(rec.targetVerdict, "in-range");
  // A plan with un-modelled legs is NOT a full-race time — never freeze it as one (Birmingham lesson).
  assert.equal(predictionFromPlan(plan({ missingLegs: ["swim (no CSS set)"] }), "2026-09-05", "x"), null);
  // Inputs dated AFTER the race would leak post-race numbers into the "prediction".
  assert.equal(predictionFromPlan(plan(), "2026-09-07", "x"), null);
  assert.equal(predictionFromPlan(plan({ date: undefined }), "2026-09-05", "x"), null);
});

test("upsertPredictions: the latest pre-race snapshot per race wins; older ones never clobber it", () => {
  const early = pred({ stateDate: "2026-08-01", predictedSec: 9400 });
  const raceMorning = pred({ stateDate: "2026-09-06", predictedSec: 9150 });
  const merged = upsertPredictions([early], [raceMorning]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].predictedSec, 9150);
  // Replaying the older snapshot must not roll the stored one back.
  const rolled = upsertPredictions(merged, [early]);
  assert.equal(rolled[0].predictedSec, 9150);
});

test("buildReview: joins official total + per-leg splits, signs the error, checks the band", () => {
  const race: CareerRaceLike = {
    date: "2026-09-06",
    event: "Alderford Standard",
    result: {
      time: "2:32:30", // 9150s — model said 9200 → model 50s slow (+0.5%)
      splits: [
        { label: "Swim", time: "31:00" },
        { label: "T1", time: "1:40" },
        { label: "Bike", time: "1:13:20" }, // 4400s
        { label: "Run", time: "44:00" },
      ],
    },
  };
  const r = buildReview(pred(), race, "2026-09-07T08:00:00Z");
  assert.ok(r);
  assert.equal(r.officialSec, 9150);
  assert.equal(r.errorSec, 50); // predicted − official: positive = model predicted slower
  assert.equal(r.errorPct, 0.5);
  assert.equal(r.withinBand, true); // 9150 within [9000, 9500]
  const bike = r.legs.find((l) => l.label === "Bike");
  assert.ok(bike && bike.officialSec === 4400 && bike.deltaSec === 100);
  // A leg with no matching official split degrades to nulls, never a crash.
  const t2 = r.legs.find((l) => l.label === "Swim");
  assert.ok(t2 && t2.officialSec === 31 * 60);
  // No parseable official time → no review.
  assert.equal(buildReview(pred(), { date: "2026-09-06", result: { time: "DNS" } }, "x"), null);
});

test("newReviews: reviews exactly the races that finished, once — matched by exact date", () => {
  const races: CareerRaceLike[] = [
    { date: "2026-09-06", event: "Alderford (results-base spelling)", result: { time: "2:32:30" } },
    { date: "2026-10-04", event: "Warwick", result: {} }, // no time yet → not reviewable
  ];
  const preds = [pred(), pred({ key: raceKey("2026-10-04", "Warwick Tri"), race: "Warwick Tri", date: "2026-10-04" })];
  const fresh = newReviews(preds, races, new Set(), "2026-09-07T08:00:00Z");
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].key, raceKey("2026-09-06", "Alderford Standard"));
  // Idempotent: an existing review key is never re-emitted.
  assert.equal(newReviews(preds, races, new Set([fresh[0].key]), "x").length, 0);
});
