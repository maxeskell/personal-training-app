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
