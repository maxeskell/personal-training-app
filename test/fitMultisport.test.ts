import { test } from "node:test";
import assert from "node:assert/strict";
import { expandMultisportFit } from "../src/insights/fit.js";
import type { FitActivity } from "../src/insights/fitParser.js";

/**
 * A synthetic triathlon .FIT: swim → T1 → ride → T2 → run, one `session` per leg (transitions are
 * sport 3, unmapped → "sport-3"), samples every 10 s. Windows: swim [1000,1900), T1 [1900,2000),
 * ride [2000,6700), T2 [6700,6800), run [6800,∞).
 */
function multisportFit(): FitActivity {
  const samples: FitActivity["samples"] = [];
  for (let t = 1000; t < 1800; t += 10) samples.push({ t, hr: 140, speed: 1.2 }); // swim (80)
  for (let t = 1900; t < 1960; t += 10) samples.push({ t, hr: 120 }); // T1 (6)
  for (let t = 2000; t < 6500; t += 10) samples.push({ t, hr: 150, power: 180, speed: 8.6 }); // ride (450)
  for (let t = 6700; t < 6760; t += 10) samples.push({ t, hr: 145 }); // T2 (6)
  for (let t = 6800; t < 9600; t += 10) samples.push({ t, hr: 160, speed: 3.6 }); // run (280)
  return {
    sport: 2,
    sportName: "Ride", // file-level sport of a multisport file is whichever message came last — untrustworthy
    subSport: null,
    samples,
    laps: [
      { index: 1, startTimeS: 1000, timerS: 800 },
      { index: 2, startTimeS: 2000, timerS: 2250 },
      { index: 3, startTimeS: 4250, timerS: 2250 },
      { index: 4, startTimeS: 6800, timerS: 1400 },
    ],
    lengths: [],
    sessions: [
      { sport: 5, sportName: "Swim", subSport: 18, startTimeS: 1000, durationSec: 800, distanceKm: 1.5, avgHr: 141 },
      { sport: 3, sportName: "sport-3", startTimeS: 1900, durationSec: 60 }, // T1
      { sport: 2, sportName: "Ride", startTimeS: 2000, durationSec: 4500, distanceKm: 40, avgHr: 152, avgPower: 178 },
      { sport: 3, sportName: "sport-3", startTimeS: 6700, durationSec: 60 }, // T2
      { sport: 1, sportName: "Run", startTimeS: 6800, durationSec: 2800, distanceKm: 10, avgHr: 161 },
    ],
    session: { durationSec: 8600, distanceKm: 51.5 },
  };
}

test("expandMultisportFit: a triathlon file becomes three per-leg activities with windowed samples/laps", () => {
  const legs = expandMultisportFit(multisportFit());
  assert.equal(legs.length, 3, "transitions are not legs");
  assert.deepEqual(
    legs.map((l) => l.sportName),
    ["Swim", "Ride", "Run"],
  );
  const [swim, ride, run] = legs;
  // Samples land inside their leg's window; transition samples belong to no leg.
  assert.equal(swim.samples.length, 80);
  assert.ok(swim.samples.every((s) => s.t! >= 1000 && s.t! < 1900));
  assert.equal(ride.samples.length, 450);
  assert.ok(ride.samples.every((s) => s.t! >= 2000 && s.t! < 6700));
  assert.equal(run.samples.length, 280);
  assert.ok(run.samples.every((s) => s.t! >= 6800));
  // Laps land with their leg.
  assert.deepEqual(swim.laps.map((l) => l.index), [1]);
  assert.deepEqual(ride.laps.map((l) => l.index), [2, 3]);
  assert.deepEqual(run.laps.map((l) => l.index), [4]);
  // Each leg's summary comes from ITS session message; the swim keeps its open-water tag.
  assert.equal(swim.subSport, 18);
  assert.equal(ride.session.avgPower, 178);
  assert.equal(ride.session.durationSec, 4500);
  assert.equal(run.session.distanceKm, 10);
  assert.equal(swim.lengths.length, 0, "multisport swim legs carry no pool lengths");
  assert.equal(ride.sessions.length, 1, "per-leg activity looks single-session downstream");
});

test("expandMultisportFit: single-session and windowless files pass through untouched", () => {
  const single: FitActivity = { ...multisportFit(), sessions: [{ sport: 2, sportName: "Ride", startTimeS: 1000 }] };
  const out1 = expandMultisportFit(single);
  assert.equal(out1.length, 1);
  assert.equal(out1[0], single, "single-session: same object back");

  const noStarts: FitActivity = {
    ...multisportFit(),
    sessions: [
      { sport: 5, sportName: "Swim" },
      { sport: 2, sportName: "Ride" },
    ],
  };
  const out2 = expandMultisportFit(noStarts);
  assert.equal(out2.length, 1, "no session carries a startTimeS → can't window → unexpanded");
  assert.equal(out2[0], noStarts);
});
