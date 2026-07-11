import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseHeat, heatFinding, type HeatInput } from "../src/insights/heat.js";

/** n dated ride records with a linear EF-vs-temp relationship (EF = 2.0 − 0.01·temp at HR 150). */
function rides(n: number, temp: (i: number) => number, extra: (i: number) => Partial<HeatInput> = () => ({})): HeatInput[] {
  return Array.from({ length: n }, (_, i) => {
    const t = temp(i);
    return {
      date: `2026-06-${String(i + 1).padStart(2, "0")}`,
      sport: "Ride",
      avgHr: 150,
      avgPowerW: (2.0 - 0.01 * t) * 150,
      avgTempC: t,
      ...extra(i),
    };
  });
}

test("analyseHeat: ambient (met) temp is preferred over the device sensor when both exist", () => {
  // Device reads the sun on the wrist: a VARYING bias over the true air temp. The regression must run
  // on the ambient values — with EF built from ambient temp, the slope only recovers −0.01 EF/°C
  // (−0.68%/°C of mean EF ~1.85) if weatherTempC was used; the biased device temps would flatten it.
  const recs = rides(
    12,
    (i) => 10 + i, // ambient 10..21
    (i) => ({ weatherTempC: 10 + i, avgTempC: 10 + i + (i % 3) * 4 }), // device: +0/+4/+8 sun bias
  );
  const h = analyseHeat(recs, "Ride");
  assert.equal(h.n, 12);
  assert.equal(h.metN, 12);
  assert.ok(h.pctPerC != null && Math.abs(h.pctPerC - -0.55) < 0.15, `slope ${h.pctPerC} should be ~−0.55%/°C`);
  // Recent temps must be the ambient ones (17..21 → 19), not the sun-biased device values.
  assert.ok(h.recentTempC != null && Math.abs(h.recentTempC - 19) < 0.01, `recentTempC ${h.recentTempC}`);
});

test("analyseHeat: same-date duplicate keeps the record that carries ambient temp", () => {
  // A raw .FIT decay (device temp only, listed FIRST) and its synced summary (ambient) for each date:
  // the ambient one must win the de-dup even though it comes second.
  const decays = rides(10, (i) => 30); // device says 30°C every day (sun)
  const summaries = rides(10, (i) => 12 + i, (i) => ({ weatherTempC: 12 + i }));
  const h = analyseHeat([...decays, ...summaries], "Ride");
  assert.equal(h.n, 10);
  assert.equal(h.metN, 10);
  // Temps span 12..21 (range ≥4 → analysable); the device-only 30°C copies were all displaced.
  assert.ok(h.recentTempC != null && h.recentTempC <= 21, `recentTempC ${h.recentTempC} should be ambient, not 30`);
});

test("analyseHeat: no ambient anywhere → device temps used as before (metN 0)", () => {
  const h = analyseHeat(rides(12, (i) => 10 + i), "Ride");
  assert.equal(h.metN, 0);
  assert.ok(h.pctPerC != null && h.pctPerC < -0.4, `device-only slope ${h.pctPerC}`);
});

test("heatFinding: evidence line discloses the temperature source mix honestly", () => {
  const all = heatFinding(analyseHeat(rides(12, (i) => 10 + i, (i) => ({ weatherTempC: 10 + i })), "Ride"));
  assert.ok(all && /ambient \(met\) air temperature/.test(all.evidence ?? ""), all?.evidence);
  const none = heatFinding(analyseHeat(rides(12, (i) => 10 + i), "Ride"));
  assert.ok(none && /\.FIT device temperature/.test(none.evidence ?? ""), none?.evidence);
  const mixed = heatFinding(
    analyseHeat(rides(12, (i) => 10 + i, (i) => (i < 6 ? { weatherTempC: 10 + i } : {})), "Ride"),
  );
  assert.ok(mixed && /ambient met air for 6\/12/.test(mixed.evidence ?? ""), mixed?.evidence);
});
