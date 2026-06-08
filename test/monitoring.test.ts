import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMonitoringRuleSet, type MonitoringInput } from "../src/insights/monitoring.js";
import { mulberry32 } from "../src/insights/stats.js";

const rnd = mulberry32(42);
function gauss(m: number, s: number): number {
  const u = Math.max(1e-9, rnd());
  const v = rnd();
  return m + s * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const dates = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10));

test("validates a real HRV→sleep signal out-of-sample (beats permutation null)", () => {
  const n = 400;
  const hrv: number[] = [];
  const rhr: number[] = [];
  const sleep: number[] = [];
  for (let i = 0; i < n; i++) {
    const low = rnd() < 0.18;
    hrv.push(low ? gauss(40, 3) : gauss(58, 4));
    rhr.push(low ? gauss(56, 2) : gauss(48, 2));
    sleep.push(gauss(80, 6));
  }
  for (let i = 1; i < n; i++) if (hrv[i - 1] < 46) sleep[i] = gauss(60, 5); // yesterday low HRV → poor sleep today
  const input: MonitoringInput = { dates: dates(n), hrv, rhr, outcome: sleep, outcomeName: "Garmin sleep score", outcomeIndependent: true };
  const rs = buildMonitoringRuleSet(input);
  assert.equal(rs.method, "walk-forward + permutation");
  assert.equal(rs.validated, true);
  assert.ok(rs.best && rs.best.pValue != null && rs.best.pValue < 0.05);
  assert.ok(rs.best!.youdenJ > 0);
});

test("rejects pure noise (no rule validated)", () => {
  const n = 400;
  const hrv: number[] = [];
  const rhr: number[] = [];
  const sleep: number[] = [];
  for (let i = 0; i < n; i++) {
    hrv.push(gauss(55, 6));
    rhr.push(gauss(50, 3));
    sleep.push(gauss(78, 7));
  }
  const rs = buildMonitoringRuleSet({ dates: dates(n), hrv, rhr, outcome: sleep, outcomeName: "Garmin sleep score", outcomeIndependent: true });
  assert.equal(rs.validated, false);
  assert.equal(rs.best, null);
});

test("short series → in-sample/exploratory, never reported as validated", () => {
  const n = 30;
  const hrv: number[] = [];
  const rhr: number[] = [];
  const rec: number[] = [];
  for (let i = 0; i < n; i++) {
    const low = rnd() < 0.3;
    hrv.push(low ? 40 : 58);
    rhr.push(low ? 56 : 48);
    rec.push(low ? 62 : 80);
  }
  const rs = buildMonitoringRuleSet({ dates: dates(n), hrv, rhr, outcome: rec, outcomeName: "AI Endurance cardio-recovery", outcomeIndependent: false });
  assert.equal(rs.method, "in-sample (exploratory)");
  assert.equal(rs.validated, false);
  assert.match(rs.outcomeDefinition, /concordance/); // dependent outcome relabelled
});
