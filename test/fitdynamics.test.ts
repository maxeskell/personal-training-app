import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseSession, trimRunTail, detectRunTailCut, analysePedalling } from "../src/insights/fit.js";
import { pedallingLines } from "../src/coach/session.js";
import { decodeLrBalanceLeftPct } from "../src/insights/fitParser.js";

/**
 * The .FIT parser decodes run dynamics (vertical ratio, step length, GCT balance) and bike L/R power
 * balance, but until now analyseSession dropped them. These pin that they're surfaced — plus the new
 * Normalized Power — and that they degrade to null (never a fake 0) when the device didn't record them.
 */

function samples(n: number, fields: Record<string, number>): Array<Record<string, number>> {
  return Array.from({ length: n }, (_, i) => ({ t: 1000 + i, hr: 150, ...fields }));
}

test("analyseSession: surfaces run dynamics averages + normalized power", () => {
  const d = analyseSession({
    sport: "Run",
    date: "2026-06-19",
    samples: samples(120, { power: 200, verticalRatio: 8, stepLength: 1100, gctBalance: 49.5 }),
  }, 0)!; // 2-min fixture: tail trim off (covered by its own tests below)
  assert.ok(d);
  assert.equal(d.avgVerticalRatioPct, 8);
  assert.equal(d.avgStepLengthMm, 1100);
  assert.equal(d.avgGctBalancePct, 49.5);
  assert.equal(d.normalizedPowerW, 200); // constant 200 W → NP = 200
  assert.equal(d.avgPowerW, 200);
  assert.equal(d.avgLrBalancePct, null, "no bike L/R balance on this run → null, not 0");
  assert.equal(d.startTimeS, 1000, "session start = first sample timestamp (t starts at 1000)");
});

test("analyseSession: surfaces bike L/R power balance", () => {
  const d = analyseSession({
    sport: "Ride",
    date: "2026-06-19",
    samples: samples(120, { power: 220, lrBalance: 52 }),
  })!;
  assert.equal(d.avgLrBalancePct, 52);
  assert.equal(d.normalizedPowerW, 220);
  assert.equal(d.avgVerticalRatioPct, null, "no run dynamics on a ride → null");
});

test("decodeLrBalanceLeftPct: masks Garmin's right-flag bit so the value is the left share (50% = even)", () => {
  assert.equal(decodeLrBalanceLeftPct(52), 52, "≤127, flag clear → already a percentage, unchanged");
  assert.equal(decodeLrBalanceLeftPct(50), 50, "even passes through");
  // 174 = 0x80 | 46 → right share 46% → left share 54% (NOT the impossible 174% read raw).
  assert.equal(decodeLrBalanceLeftPct(174), 54);
  assert.equal(decodeLrBalanceLeftPct(0x80 | 40), 60, "right 40% → left 60%");
  assert.equal(decodeLrBalanceLeftPct(54), 54, "an already-decoded value is left unchanged (idempotent)");
});

test("analyseSession: decodes a flag-encoded L/R balance instead of reporting an impossible >100%", () => {
  // Raw 174 per sample (0x80 right-flag + 46) must surface as ~54% left, never 174%.
  const d = analyseSession({
    sport: "Ride",
    date: "2026-06-19",
    samples: samples(120, { power: 220, lrBalance: 174 }),
  })!;
  assert.equal(d.avgLrBalancePct, 54, "the sensor/encoding artifact is decoded, not passed through raw");
});

test("analyseSession: normalized power needs enough power data, else null", () => {
  const d = analyseSession({ sport: "Run", date: "2026-06-19", samples: samples(120, { /* no power */ }) }, 0)!;
  assert.equal(d.normalizedPowerW, null);
  assert.equal(d.avgPowerW, null);
});

/**
 * Open-water swims: the cadence/HR/decoupling drifts must be computed over ACTIVE swimming only — a long
 * float/rest between reps used to land in the late quartile and read as a giant "cadence drop". Plus pace
 * + distance-per-stroke (the efficiency measure) are derived from the GPS stream so the analysis can say
 * whether the athlete sped up/slowed and whether efficiency held — not just cadence.
 */
function swimSamples(specs: Array<{ n: number; speed?: number; cadence: number; hr: number }>): Array<Record<string, number>> {
  const out: Array<Record<string, number>> = [];
  let t = 1000;
  for (const sp of specs) for (let i = 0; i < sp.n; i++) out.push({ t: t++, cadence: sp.cadence, hr: sp.hr, ...(sp.speed != null ? { speed: sp.speed } : {}) });
  return out;
}

test("analyseSession (swim): a long final float is excluded — no fake cadence/HR collapse", () => {
  // 60 s active swimming, then a 60 s float (cadence 0, drifting slow). Whole-stream, the last quartile is
  // all float → cadence "drops" ~100%; gated to active swimming it's ~0. That gate is the artifact fix.
  const d = analyseSession({
    sport: "Swim",
    subSport: 18,
    date: "2026-06-28",
    samples: swimSamples([{ n: 60, speed: 0.7, cadence: 30, hr: 150 }, { n: 60, speed: 0.05, cadence: 0, hr: 120 }]),
  })!;
  assert.ok(d.swim);
  assert.equal(d.swim!.openWater, true, "sub_sport 18 → open water");
  assert.equal(d.swim!.paceSecPer100m, 143, "100 / 0.7 m/s ≈ 143 s/100m, from active swimming only");
  assert.equal(d.swim!.distPerStrokeM, 1.4, "0.7 m/s × 60 / 30 spm = 1.4 m/stroke");
  assert.equal(d.cadenceDropPct, 0, "the final float is excluded, so cadence does not 'collapse'");
  assert.equal(d.hrDriftPct, 0, "HR drift is over active swimming, not the cooldown float");
});

test("analyseSession (swim): pace + efficiency drift answer 'sped up/slowed' and 'efficiency held'", () => {
  // First half faster but choppier (1.4 m/stroke); second half slower but longer-stroked (1.5 m/stroke).
  const d = analyseSession({
    sport: "Swim",
    subSport: 18,
    date: "2026-06-28",
    samples: swimSamples([{ n: 60, speed: 0.7, cadence: 30, hr: 140 }, { n: 60, speed: 0.6, cadence: 24, hr: 145 }]),
  })!;
  assert.equal(d.swim!.paceSecPer100m, 154, "avg 0.65 m/s → 154 s/100m");
  assert.equal(d.swim!.paceDriftPct, 14.3, "slowed first→second half → positive");
  assert.equal(d.swim!.distPerStrokeM, 1.45, "mean of 1.4 and 1.5");
  assert.equal(d.swim!.dpsDriftPct, 7.1, "more distance per stroke late → efficiency improved → positive");
});

test("analyseSession (swim): a pool swim with no GPS speed → pace/efficiency null, never fabricated", () => {
  const d = analyseSession({
    sport: "Swim",
    subSport: 17,
    date: "2026-06-28",
    samples: swimSamples([{ n: 120, cadence: 30, hr: 150 }]), // stroking, but no GPS speed channel
  })!;
  assert.equal(d.swim!.openWater, false, "sub_sport 17 → pool");
  assert.equal(d.swim!.paceSecPer100m, null, "no GPS speed → pace can't be derived (use per-length splits)");
  assert.equal(d.swim!.distPerStrokeM, null, "distance-per-stroke needs speed → null, not faked");
});

test("analyseSession: a run carries no swim block", () => {
  const d = analyseSession({ sport: "Run", date: "2026-06-19", samples: samples(120, { power: 200 }) }, 0)!;
  assert.equal(d.swim, null);
});

// Runs often end walking (dog sniffing, getting to the door): the closing walk must not feed the metrics.
function run(runS: number, tail: Array<Record<string, number>> = []): Array<Record<string, number>> {
  // 1 Hz from t=1000: `runS` seconds of running (3.3 m/s, 90 strides/min), then the given tail samples.
  const r = Array.from({ length: runS }, (_, i) => ({ t: 1000 + i, hr: 150, speed: 3.3, cadence: 90 }));
  return [...r, ...tail.map((x, i) => ({ t: 1000 + runS + i, hr: 150, ...x }))];
}
const walking = (n: number) => Array.from({ length: n }, () => ({ speed: 1.4, cadence: 58 }));
const running = (n: number) => Array.from({ length: n }, () => ({ speed: 3.3, cadence: 90 }));

test("analyseSession: a closing walk is detected and excluded from every metric", () => {
  const d = analyseSession({ sport: "Run", date: "2026-10-24", samples: run(2700, walking(300)) }, 10)!;
  assert.equal(d.tailTrimBasis, "walk-detected");
  assert.equal(d.tailTrimmedMin, 5, "cut where the 5-min walk began, not a blanket 10");
  assert.equal(d.cadenceDropPct, 0, "walk cut → no fake cadence drop");
  assert.equal(d.decouplingPct, 0, "walk cut → no fake decoupling");
  assert.equal(d.durationMin, 50, "duration still counts the whole run");
});

test("analyseSession: a run run to the finish keeps all its data", () => {
  const d = analyseSession({ sport: "Run", date: "2026-10-24", samples: run(3000) }, 10)!;
  assert.equal(d.tailTrimmedMin, 0);
  assert.equal(d.tailTrimBasis, "none");
});

test("detectRunTailCut: a stop-start dog walk is cut from its first stop", () => {
  const s = run(2400, [...walking(90), ...running(120), ...walking(70), ...running(40), ...walking(80)]);
  const c = detectRunTailCut(s, 10);
  assert.equal(c.basis, "walk-detected");
  assert.equal(c.samples.length, 2400);
});

test("detectRunTailCut: a stop shorter than a minute (a junction) is not a walk", () => {
  const s = run(2400, [...walking(40), ...running(300)]);
  assert.equal(detectRunTailCut(s, 10).trimmedMin, 0);
});

test("detectRunTailCut: never cuts more than the cap, even after a long walk", () => {
  const c = detectRunTailCut(run(2400, walking(1200)), 10);
  assert.equal(c.basis, "walk-detected");
  assert.equal(c.trimmedMin, 10);
});

test("detectRunTailCut: cadence-only runs (no speed) detect the walk, in strides or steps per min", () => {
  const strides = [...Array.from({ length: 2400 }, (_, i) => ({ t: i, cadence: 88 })), ...Array.from({ length: 300 }, (_, i) => ({ t: 2400 + i, cadence: 57 }))];
  assert.equal(detectRunTailCut(strides, 10).samples.length, 2400);
  const steps = strides.map((x) => ({ ...x, cadence: x.cadence * 2 }));
  assert.equal(detectRunTailCut(steps, 10).samples.length, 2400);
});

test("detectRunTailCut: with no speed or cadence it can't tell, so it cuts the whole cap", () => {
  const s = Array.from({ length: 3000 }, (_, i) => ({ t: i, hr: 150 }));
  const c = detectRunTailCut(s, 10);
  assert.equal(c.basis, "fixed");
  assert.equal(c.trimmedMin, 10);
});

test("analyseSession: with the cap at 0, the walk reads as fake fade (why the cut exists)", () => {
  const d = analyseSession({ sport: "Run", date: "2026-10-24", samples: run(2400, walking(600)) }, 0)!;
  assert.equal(d.tailTrimmedMin, 0);
  assert.ok(d.cadenceDropPct! < -20);
});

test("analyseSession: rides and multisport race legs are never tail-trimmed", () => {
  const ride = analyseSession({ sport: "Ride", date: "2026-10-24", samples: run(2400, walking(600)) }, 10)!;
  assert.equal(ride.tailTrimmedMin, 0);
  const leg = analyseSession({ sport: "Run", date: "2026-10-24", multisportLeg: true, samples: run(2400, walking(600)) }, 10)!;
  assert.equal(leg.tailTrimmedMin, 0);
});

test("analyseSession: a run that's almost all walk gives no readout, not one built from scraps", () => {
  assert.equal(analyseSession({ sport: "Run", date: "2026-10-24", samples: run(30, walking(600)) }, 10), null);
});

test("trimRunTail: cuts by timestamp, so gaps from smart recording don't shift the cut", () => {
  const s = [{ t: 0 }, { t: 100 }, { t: 1000 }, { t: 1500 }, { t: 1600 }];
  assert.deepEqual(trimRunTail(s, 10).map((x) => x.t), [0, 100, 1000]);
  assert.deepEqual(trimRunTail(s, 0), s);
});

// Pedalling mechanics from dual-sided pedals: the shims / cleat question needs per-leg channels, not just balance.
test("analysePedalling: per-leg averages over pedalling only, balance by power band and by quarter", () => {
  const s = Array.from({ length: 1200 }, (_, i) => {
    const coasting = i % 10 === 0; // freewheeling every 10th second: must not count
    const power = coasting ? 0 : 150 + (i % 3) * 50; // 150 / 200 / 250 W
    // Left share rises with power (51 / 52 / 53): a load-dependent imbalance, not a fixed offset.
    const left = 51 + (i % 3);
    return {
      t: i, power, cadence: coasting ? 0 : 88, hr: 140,
      lrBalance: coasting ? 0x80 | 10 : 0x80 | (100 - left), // coasting junk would drag the mean to 90%
      leftTe: 78, rightTe: 72, leftPs: 24, rightPs: 21, leftPco: -6, rightPco: 1,
      leftPhase: [350, 230] as [number, number], rightPhase: [10, 250] as [number, number],
    };
  });
  const p = analysePedalling(s)!;
  assert.equal(p.balanceLeftPct, 52);
  assert.deepEqual(p.balanceByPower.map((b) => b.leftPct), [51, 52, 53]);
  assert.equal(p.balanceByQuarter.length, 4);
  assert.deepEqual(p.torqueEffectivenessPct, { left: 78, right: 72 });
  assert.deepEqual(p.platformCentreOffsetMm, { left: -6, right: 1 });
  assert.equal(p.powerPhase.left!.startDeg, 350);
  assert.equal(p.powerPhase.left!.arcDeg, 240, "arc wraps through top dead centre: 350° → 230° = 240°");
  assert.equal(p.pedallingMin, 18, "coasting seconds excluded");
});

test("analysePedalling: circular mean, so phase starts either side of top dead centre don't average to 180°", () => {
  const s = Array.from({ length: 200 }, (_, i) => ({ t: i, power: 200, cadence: 90, leftPhase: [i % 2 ? 350 : 10, 230] as [number, number] }));
  assert.equal(analysePedalling(s)!.powerPhase.left!.startDeg, 0);
});

test("analysePedalling: null when the pedals recorded no dynamics (single-sided meter, trainer)", () => {
  const s = Array.from({ length: 600 }, (_, i) => ({ t: i, power: 200, cadence: 90 }));
  assert.equal(analysePedalling(s), null);
});

test("analyseSession: a ride carries the pedalling block, a run doesn't", () => {
  const ride = analyseSession({ sport: "Ride", date: "2026-10-24", samples: samples(600, { power: 200, cadence: 90, leftTe: 75, rightTe: 74 }) })!;
  assert.deepEqual(ride.pedalling!.torqueEffectivenessPct, { left: 75, right: 74 });
  const runS = analyseSession({ sport: "Run", date: "2026-10-24", samples: samples(600, { power: 200, cadence: 90, leftTe: 75 }) }, 0)!;
  assert.equal(runS.pedalling, null);
});

test("pedallingLines: names each channel and skips the ones the pedals didn't record", () => {
  const p = analysePedalling(Array.from({ length: 600 }, (_, i) => ({ t: i, power: 200, cadence: 90, lrBalance: 0x80 | 47, leftPco: -6, rightPco: 1 })))!;
  const text = pedallingLines(p).join("\n");
  assert.match(text, /L\/R balance 53\.0% left/);
  assert.match(text, /Platform centre offset L -6\.0mm \/ R 1\.0mm/);
  assert.doesNotMatch(text, /Torque effectiveness/, "not recorded → no line, not a row of dashes");
});
