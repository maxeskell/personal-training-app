import { test } from "node:test";
import assert from "node:assert/strict";
import { mapActivityDurability, durabilityContextLines, durabilityCardLine } from "../src/insights/activityDetail.js";

/**
 * Fixtures mirror the 2026-08-25 Mac probe of AIE's Detail rollout (MCP v1.1/1.2 — spec 10) STRUCTURE-
 * verbatim with adjusted values: a ride's single-family within_session_durability (kJ axis) + a
 * durability_drift with hr/a1 metrics, and a run's keyed families (gap + power over km) with NO drift
 * (the internal read needs clean R-R + trend history — absent is normal). The pre-rollout bare `{}`
 * must map to null, not an empty read.
 */

const RIDE_DETAIL = {
  activity_date_local: "2026-08-23T14:02:30Z",
  within_session_durability: {
    axis: "kj",
    fade_series: {
      "5min": { by_work: [{ kj: 250, watts: 143.3 }], fade_percent_total: 19.8, fresh: 178.7 },
      "20min": { by_work: [{ kj: 250, watts: 117.5 }], fade_percent_total: 18.3, fresh: 143.8 },
    },
  },
  durability_drift: {
    axis: "kj",
    anchors: [1000, 1500],
    metrics: {
      hr: {
        n_points: 10,
        covered_x: [0, 319.7],
        mean_residual_vs_trend: -3.31,
        band_position: { label: "mixed", above: 1, below: 5, in_band: 4 },
        trend_pct_loss_at_anchors: { "1000": 22.9, "1500": null },
        trend_ride_count: 10,
      },
      a1: {
        n_points: 10,
        covered_x: [0, 319.7],
        mean_residual_vs_trend: -0.01,
        band_position: { label: "in_band", above: 2, below: 2, in_band: 6 },
        trend_pct_loss_at_anchors: { "1000": null, "1500": null },
        trend_ride_count: 10,
      },
    },
  },
  pct_of_recent_best: { "5min": 91.7, "20min": 95.2 },
  reference_window: { days: 42, since: "2026-07-12", activity_count: 28, excludes_current_activity: true },
};

const RUN_DETAIL = {
  activity_date_local: "2026-08-23T14:02:30Z",
  within_session_durability: {
    gap: { axis: "km", fade_series: { "5min": { by_work: [{ km: 5, pace: "5:27" }], fade_percent_total: 8.7, fresh_pace: "4:59" } } },
    power: { axis: "km", fade_series: { "5min": { by_work: [{ km: 5, watts: 307.5 }], fade_percent_total: 25.8, fresh: 414.3 } } },
  },
};

test("mapActivityDurability: ride shape — single power family, drift metrics, recent-best anchors", () => {
  const d = mapActivityDurability(RIDE_DETAIL)!;
  assert.equal(d.within.length, 1);
  assert.equal(d.within[0].metric, "power");
  assert.equal(d.within[0].axis, "kj");
  assert.deepEqual(
    d.within[0].windows.map((w) => [w.window, w.fadePctTotal, w.fresh]),
    [["5min", 19.8, "179 W"], ["20min", 18.3, "144 W"]],
  );
  assert.equal(d.drift!.axis, "kj");
  const hr = d.drift!.metrics.find((m) => m.metric === "hr")!;
  assert.equal(hr.meanResidual, -3.31);
  assert.equal(hr.bandLabel, "mixed");
  assert.equal(hr.trendN, 10);
  assert.deepEqual(hr.pctLossAtAnchors, [{ anchor: "1000", pct: 22.9 }], "null anchors are dropped, not mapped as 0");
  assert.deepEqual(d.recentBest, [{ anchor: "5min", pct: 91.7 }, { anchor: "20min", pct: 95.2 }]);
  assert.equal(d.referenceDays, 42);
  assert.equal(d.referenceCount, 28);
});

test("mapActivityDurability: run shape — keyed gap/power families, no drift (normal, not a gap)", () => {
  const d = mapActivityDurability(RUN_DETAIL)!;
  assert.deepEqual(d.within.map((f) => f.metric).sort(), ["pace", "power"]);
  const pace = d.within.find((f) => f.metric === "pace")!;
  assert.equal(pace.windows[0].fresh, "4:59", "pace fresh stays a clock string");
  assert.equal(d.drift, null);
  assert.deepEqual(d.recentBest, []);
});

test("mapActivityDurability: pre-rollout {} and junk map to null, never an empty read", () => {
  assert.equal(mapActivityDurability({}), null);
  assert.equal(mapActivityDurability(null), null);
  assert.equal(mapActivityDurability("nope"), null);
  assert.equal(mapActivityDurability({ within_session_durability: { axis: "kj" } }), null, "a family without fade windows is no read");
});

test("durabilityContextLines: MODEL-labelled, keeps the two measurements distinct, honest about absent drift", () => {
  const ride = durabilityContextLines(mapActivityDurability(RIDE_DETAIL)!).join("\n");
  assert.match(ride, /MODEL/);
  assert.match(ride, /Within-session fade \(mechanical/);
  assert.match(ride, /5min faded 19\.8% from fresh 179 W/);
  assert.match(ride, /hr: residual -3\.3 vs your 10-session trend, mixed \(4 in \/ 1 above \/ 5 below band\), trend loses 22\.9% by 1000kj/);
  assert.match(ride, /vs recent best: 5min at 91\.7%, 20min at 95\.2% \(reference: last 42d, 28 activities\)/);
  assert.match(ride, /judge vs the plan, not vs zero/);

  const run = durabilityContextLines(mapActivityDurability(RUN_DETAIL)!).join("\n");
  assert.match(run, /pace: 5min faded 8\.7% from fresh 4:59/);
  assert.match(run, /Internal drift vs trend: not computed for this session .* normal, not a data gap/);
});

test("durabilityCardLine: compact one-liner from whatever is present", () => {
  assert.equal(
    durabilityCardLine(mapActivityDurability(RIDE_DETAIL)!),
    "power fade 19.8% (5min) · drift vs trend: hr mixed, a1 in band",
  );
  assert.equal(durabilityCardLine(mapActivityDurability(RUN_DETAIL)!), "pace fade 8.7% (5min) · power fade 25.8% (5min)");
});
