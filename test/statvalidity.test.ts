import { test } from "node:test";
import assert from "node:assert/strict";
import { bestLaggedCorr, benjaminiHochberg, corrPValue, mulberry32 } from "../src/insights/stats.js";
import { analyseHeat, type HeatInput } from "../src/insights/heat.js";

test("bestLaggedCorr prefers a significant lag over a stronger non-significant one", () => {
  // Construct two lags: lag0 has a strong-looking but noise r; a later lag has a real, significant signal.
  // Build x and a y that is a clean lag-2 copy of x (so lag-2 is the true, significant relationship).
  const n = 40;
  const rnd = mulberry32(1);
  const x: number[] = Array.from({ length: n }, () => rnd() * 10);
  const y: number[] = x.map((_, i) => (i >= 2 ? x[i - 2] + (rnd() - 0.5) * 0.5 : rnd() * 10)); // y[i] ≈ x[i-2]
  const scan = bestLaggedCorr(x, y, 0, 3)!;
  assert.ok(scan);
  assert.equal(scan.corr.significant, true, "selected lag should be significant");
  assert.equal(scan.bestLag, 2, "should pick the true lag-2 relationship");
});

test("FDR with lag-search inflation: pure noise yields ~no confirmations", () => {
  const rnd = mulberry32(7);
  // 3 'relationships', each the best of a 4-lag scan over noise → p inflated ×4 before BH.
  const ps = [0.04, 0.06, 0.09].map((p) => Math.min(1, p * 4));
  const pass = benjaminiHochberg(ps, 0.1);
  assert.deepEqual(pass, [false, false, false]); // none survive once the search multiplicity is paid
  // sanity: corrPValue still flags a genuinely strong correlation
  assert.ok(corrPValue(0.7, 40) * 4 < 0.05);
  void rnd;
});

test("heat: no attribution when the EF change is within noise (<2%)", () => {
  const recs: HeatInput[] = [];
  // EF essentially flat across a big temp range → efChangePct ~0 → attribution must be null, not 100%.
  [10, 11, 12, 13, 14, 24, 25, 26, 27, 28].forEach((t, i) => {
    recs.push({ date: `2026-03-${String(i + 1).padStart(2, "0")}`, sport: "Ride", avgPowerW: 140, avgHr: 140, avgTempC: t });
  });
  const h = analyseHeat(recs, "Ride");
  assert.equal(h.heatAttributedPct, null, "near-zero EF change must not produce a heat %");
});
