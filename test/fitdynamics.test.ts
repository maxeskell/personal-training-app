import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseSession } from "../src/insights/fit.js";
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
  })!;
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
  const d = analyseSession({ sport: "Run", date: "2026-06-19", samples: samples(120, { /* no power */ }) })!;
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
  const d = analyseSession({ sport: "Run", date: "2026-06-19", samples: samples(120, { power: 200 }) })!;
  assert.equal(d.swim, null);
});
