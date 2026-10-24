import { test } from "node:test";
import assert from "node:assert/strict";
import { mulberry32 } from "../src/insights/stats.js";
import {
  fitLine, minettiCost, resample1Hz, steadyOutputVsHr, mmpRead, dfaAlpha1, cleanRr, dfaThreshold, analysePerformance,
} from "../src/insights/performance.js";
import type { FitActivity, FitSample } from "../src/insights/fitParser.js";

/** Per-session efficiency maths on synthetic streams with known answers. No network, seeded randomness. */

test("fitLine: exact line, range percentiles", () => {
  const f = fitLine([1, 2, 3, 4, 5], [3, 5, 7, 9, 11])!;
  assert.equal(f.slope, 2);
  assert.equal(f.intercept, 1);
  assert.equal(f.r2, 1);
});

test("minettiCost: flat is 3.6 J/kg/m, uphill costs more, clamps beyond ±30%", () => {
  assert.equal(minettiCost(0), 3.6);
  assert.ok(minettiCost(0.1) > 5);
  assert.equal(minettiCost(0.5), minettiCost(0.3));
});

test("resample1Hz: places samples by timestamp, gaps stay empty", () => {
  const r = resample1Hz([{ t: 100, hr: 1 }, { t: 103, hr: 2 }]);
  assert.equal(r.length, 4);
  assert.equal(r[1], null);
  assert.equal(r[3]!.hr, 2);
});

function ride(minutes: number, hrAt: (s: number) => number, powerAt: (s: number) => number): FitSample[] {
  return Array.from({ length: minutes * 60 }, (_, s) => ({ t: 1_000_000 + s, hr: hrAt(s), power: powerAt(s), cadence: 90 }));
}

test("steadyOutputVsHr (ride): recovers watts = 2×HR − 50 from steady minutes, ignores the warm-up", () => {
  // HR steps up 2 bpm every 5 min from 120; power follows 2×HR − 50 within each step.
  const hr = (s: number) => 120 + 2 * Math.floor(s / 300);
  const s = ride(70, hr, (t) => (t < 600 ? 50 : 2 * hr(t) - 50));
  const r = steadyOutputVsHr(resample1Hz(s), "ride")!;
  assert.ok(r);
  assert.ok(Math.abs(r.fit.slope - 2) < 0.01, `slope ${r.fit.slope}`);
  assert.ok(Math.abs(r.fit.intercept + 50) < 1, `intercept ${r.fit.intercept}`);
});

test("steadyOutputVsHr: surgy minutes are excluded, and too little HR spread gives null", () => {
  const surgy = ride(60, () => 140, (t) => (t % 20 < 10 ? 100 : 350));
  assert.equal(steadyOutputVsHr(resample1Hz(surgy), "ride"), null);
});

test("steadyOutputVsHr (run): an uphill minute at a slower speed grade-adjusts back to the flat pace", () => {
  // 60 min; flat-equivalent speed rises with HR (2.5 m/s at 140 bpm, +0.02 per bpm). Every other minute
  // climbs 5% at the slower real speed that costs the same energy.
  const samples: FitSample[] = [];
  let dist = 0, alt = 100;
  for (let s = 0; s < 60 * 60; s++) {
    const hr = 140 + Math.floor(s / 300);
    const flat = 2.5 + 0.02 * (hr - 140);
    const climbing = Math.floor(s / 60) % 2 === 1;
    const v = climbing ? (flat * minettiCost(0)) / minettiCost(0.05) : flat;
    dist += v;
    if (climbing) alt += v * 0.05;
    samples.push({ t: s, speed: v, distance: dist, altitude: alt, hr });
  }
  const r = steadyOutputVsHr(resample1Hz(samples), "run")!;
  assert.ok(r);
  const predicted = r.fit.intercept + r.fit.slope * 145;
  assert.ok(Math.abs(predicted - 2.6) < 0.03, `GAP at 145 bpm ${predicted}`);
});

test("mmpRead: fresh bests and bests after 1500 kJ", () => {
  // 2 h at 200 W (1440 kJ) then 30 min at 300 W: the 1500 kJ mark falls 200 s into the hard block.
  const s = ride(150, () => 140, (t) => (t < 7200 ? 200 : 300));
  const m = mmpRead(resample1Hz(s))!;
  assert.equal(m.fresh[1200], 300);
  assert.equal(m.afterKj[1500].p1200, 300);
  assert.equal(m.afterKj[2500].p300, null, "never reached 2500 kJ");
  assert.equal(m.totalKj, 1980);
});

function arRr(n: number, phi: number, seed: number, meanMs = 600): number[] {
  const rnd = mulberry32(seed);
  let x = 0;
  return Array.from({ length: n }, () => {
    x = phi * x + (rnd() - 0.5) * 40;
    return meanMs + x;
  });
}

test("dfaAlpha1: white noise ≈ 0.5, strongly correlated beats ≫ 0.75", () => {
  const white = dfaAlpha1(arRr(240, 0, 1))!;
  const corr = dfaAlpha1(arRr(240, 0.95, 2))!;
  assert.ok(white < 0.7, `white ${white}`);
  assert.ok(corr > 1.0, `correlated ${corr}`);
  assert.equal(dfaAlpha1([600, 610]), null);
});

test("cleanRr: drops out-of-range and spiky beats", () => {
  const c = cleanRr([600, 605, 1200, 598, 250, 602]);
  assert.deepEqual(c.kept.map((k) => k.v), [600, 605, 598, 602]);
  assert.equal(c.artefactPct, 33.3);
});

test("dfaThreshold: finds the HR where α1 crosses 0.75 on a progressive session", () => {
  // 40 min: HR climbs 110 → 170 bpm; beat-to-beat correlation fades from strong (easy) to none (hard).
  const rnd = mulberry32(7);
  const rr: number[] = [];
  let t = 0, x = 0;
  while (t < 40 * 60 * 1000) {
    const f = t / (40 * 60 * 1000);
    const hr = 110 + 60 * f;
    const phi = 0.97 * (1 - f);
    x = phi * x + (rnd() - 0.5) * 30;
    const v = 60000 / hr + x;
    rr.push(v);
    t += v;
  }
  const series = resample1Hz(Array.from({ length: 2400 }, (_, s) => ({ t: s, power: 100 + s / 10 })));
  const d = dfaThreshold(rr, series, "ride")!;
  assert.ok(d, "a threshold should be found");
  assert.ok(d.aetHr > 115 && d.aetHr < 165, `aet ${d.aetHr}`);
  assert.ok(d.aetOutput != null && d.aetOutput > 100);
});

test("dfaThreshold: an all-easy session never crosses 0.75, so no estimate", () => {
  const rr = arRr(4000, 0.97, 3, 700);
  const series = resample1Hz(Array.from({ length: 2800 }, (_, s) => ({ t: s, power: 150 })));
  assert.equal(dfaThreshold(rr, series, "ride"), null);
});

test("analysePerformance: a ride gives steady + MMP; a swim gives nothing; indoor is tagged", () => {
  const hr = (s: number) => 120 + 2 * Math.floor(s / 300);
  const act: FitActivity = {
    sport: 2, sportName: "Ride", subSport: 6, samples: ride(70, hr, (t) => 2 * hr(t) - 50), laps: [], lengths: [], sessions: [], session: {},
  };
  const p = analysePerformance(act)!;
  assert.equal(p.kind, "ride");
  assert.equal(p.indoor, true);
  assert.ok(p.steady && p.mmp);
  assert.equal(analysePerformance({ ...act, sport: 5, sportName: "Swim" }), null);
});
