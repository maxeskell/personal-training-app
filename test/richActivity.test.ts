import { test } from "node:test";
import assert from "node:assert/strict";
import { mapRichActivity, durabilityTrend, efTrend, thresholdTrend, type RichActivity } from "../src/insights/metrics.js";

/**
 * The AIE summary payload has three eras, all pinned here (spec 10):
 *  1. Legacy (pre-2026-08, archived rows): DFA-α1 value fields present — durability %, thresholds.
 *  2. Unflagged 2026-08 (probe 2026-08-24): value fields gone; control flags
 *     (exclude_from_durability, exclude_hr_data, power_is_from_hr) appeared.
 *  3. Flagged 2026-08-25 (probe same day; production passes `with_dfa_alpha1: true`): the threshold
 *     fields return verbatim, summaries carry an `id`, and NEW a1 stats appear
 *     (`average_of_dfa_alpha1`, `mean_of_dfa_alpha1_times_power*`) that must NOT map to durabilityPct —
 *     the probe proved they are a different metric (coverage inverted vs durability; null on sessions
 *     whose archived durability is known). Durability % itself stays archive-only until AIE's
 *     Detail-tool rollout.
 * The trend tests pin that the trends honour the control flags — most importantly EF, where
 * HR-derived power would be circular.
 */

/** A live post-2026-08 ride, field names verbatim from the 2026-08-24 probe. */
const LIVE_RIDE = {
  activity_date: "2026-08-23T13:02:30Z",
  activity_date_local: "2026-08-23T14:02:30Z",
  activity_name: "Endurance Ride - AI Endurance",
  activity_type: "Garmin_Ride",
  activity_movingtime: 5400,
  activity_avwatts: 180,
  activity_haspower: true,
  activity_avhr: 130,
  external_stress_score: 80,
  distance_in_km: 45.2,
  hrv_artifact_percentage: 3.1,
  power_is_from_hr: false,
  exclude_from_durability: false,
  exclude_from_curves: false,
  exclude_from_model: false,
  exclude_hr_data: false,
  is_erg_mode: false,
  is_indoor: false,
  is_virtual: false,
  kcal: 1200,
};

test("mapRichActivity: live 2026-08 shape maps the flags and degrades the gone value fields to undefined", () => {
  const r = mapRichActivity(LIVE_RIDE, "Ride");
  assert.equal(r.date, "2026-08-23");
  assert.equal(r.avwatts, 180);
  assert.equal(r.powerIsFromHr, false);
  assert.equal(r.excludeFromDurability, false);
  assert.equal(r.excludeHrData, false);
  assert.equal(r.durabilityPct, undefined);
  assert.equal(r.aerThrHr, undefined);
  assert.equal(r.aerThrW, undefined);
});

test("mapRichActivity: legacy archived rows still yield their DFA-α1 values; flags and id stay undefined", () => {
  const r = mapRichActivity(
    {
      activity_date_local: "2026-05-10T08:00:00Z",
      activity_movingtime: 3900,
      aerobic_durability_according_to_dfa_alpha1_running_power_in_percent: -4.2,
      aerobic_threshold_dfa_alpha1_heart_rate_cluster: 138,
    },
    "Run",
  );
  assert.equal(r.durabilityPct, -4.2);
  assert.equal(r.aerThrHr, 138);
  assert.equal(r.powerIsFromHr, undefined);
  assert.equal(r.excludeFromDurability, undefined);
  assert.equal(r.id, undefined, "pre-2026-08 rows have no id — Detail joins must handle that");
});

/** A flagged (`with_dfa_alpha1: true`) ride, field names verbatim from the 2026-08-25 probe. */
const FLAGGED_RIDE = {
  ...LIVE_RIDE,
  id: 8412345,
  aerobic_threshold_dfa_alpha1_watts_cluster: 205,
  anaerobic_threshold_dfa_alpha1_watts_cluster: 248,
  aerobic_threshold_dfa_alpha1_heart_rate_cluster: 139,
  anaerobic_threshold_dfa_alpha1_heart_rate_cluster: 162,
  average_of_dfa_alpha1: 0.62,
  mean_of_dfa_alpha1_times_power_or_pace_normalized_over_two_weeks_in_percent: 97.4,
};

test("mapRichActivity: flagged 2026-08-25 shape maps id + restored thresholds; the new a1 stats do NOT become durability", () => {
  const r = mapRichActivity(FLAGGED_RIDE, "Ride");
  assert.equal(r.id, 8412345, "id is the Detail/setActivityFlags join key — must survive mapping");
  assert.equal(r.aerThrW, 205);
  assert.equal(r.aerThrHr, 139);
  assert.equal(r.excludeFromDurability, false, "control flags still map alongside the restored values");
  assert.equal(
    r.durabilityPct,
    undefined,
    "mean_of_dfa_alpha1_times_power*_normalized… is a different metric (probe 2026-08-25) — mapping it to durabilityPct would fabricate a durability trend",
  );
});

const act = (over: Partial<RichActivity>): RichActivity => ({ date: "2026-06-01", sport: "Ride", ...over });

test("durabilityTrend: an athlete-flagged exclude_from_durability session never enters the trend", () => {
  const acts: RichActivity[] = [];
  for (let i = 0; i < 10; i++) acts.push(act({ date: `2026-06-${String(i + 1).padStart(2, "0")}`, durabilityPct: -4 }));
  // A flagged outlier that would drag the recent mean if counted:
  acts.push(act({ date: "2026-06-11", durabilityPct: -40, excludeFromDurability: true }));
  const t = durabilityTrend(acts, "Ride");
  assert.equal(t.recent, -4);
  assert.equal(t.n, 10, "the excluded session contributes no point");
});

test("efTrend: rides with power derived from HR are excluded (EF would be circular)", () => {
  const good = Array.from({ length: 10 }, (_, i) =>
    act({ date: `2026-06-${String(i + 1).padStart(2, "0")}`, movingSec: 3600, avwatts: 150, avhr: 150 }),
  );
  const derived = act({ date: "2026-06-11", movingSec: 3600, avwatts: 300, avhr: 150, powerIsFromHr: true });
  const t = efTrend([...good, derived], "Ride");
  assert.equal(t.recent, 1, "EF stays at the measured 1.0 — the HR-derived 2.0 ride is dropped");
  assert.equal(t.n, 10);
});

test("efTrend and thresholdTrend: exclude_hr_data drops the session from HR-derived metrics", () => {
  const base = Array.from({ length: 10 }, (_, i) =>
    act({ date: `2026-06-${String(i + 1).padStart(2, "0")}`, movingSec: 3600, avwatts: 150, avhr: 150, aerThrHr: 140 }),
  );
  const badHr = act({ date: "2026-06-11", movingSec: 3600, avwatts: 150, avhr: 75, aerThrHr: 90, excludeHrData: true });
  assert.equal(efTrend([...base, badHr], "Ride").n, 10, "bad-HR ride out of EF");
  assert.equal(thresholdTrend([...base, badHr], "Ride").n, 10, "bad-HR ride out of the threshold trend");
});

test("trends stay well-behaved on an all-new-shape window (no value fields at all)", () => {
  const acts = Array.from({ length: 8 }, (_, i) =>
    act({ date: `2026-08-${String(i + 1).padStart(2, "0")}`, movingSec: 3000, excludeFromDurability: false }),
  );
  const t = durabilityTrend(acts, "Ride");
  assert.equal(t.recent, null);
  assert.equal(t.n, 0);
});
