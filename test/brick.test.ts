import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseBricks, brickFinding } from "../src/insights/brick.js";
import type { RichActivity } from "../src/insights/metrics.js";

// runEf() needs a power-equipped run of >=20 min (1200 s); rides only need a same-date stamp.
const run = (date: string, watts: number): RichActivity => ({ date, sport: "Run", avwatts: watts, avhr: 150, movingSec: 1800 });
const ride = (date: string): RichActivity => ({ date, sport: "Ride", avwatts: 200, avhr: 140, movingSec: 3600, ess: 50 });

test("brick finding is labelled same-day run/ride decoupling, not a true off-bike transition", () => {
  // 3 same-day run+ride days (runs a touch lower EF) + 3 run-only days → the proxy populates.
  const acts: RichActivity[] = [
    run("2026-06-01", 230), ride("2026-06-01"),
    run("2026-06-03", 232), ride("2026-06-03"),
    run("2026-06-05", 231), ride("2026-06-05"),
    run("2026-06-08", 250),
    run("2026-06-10", 252),
    run("2026-06-12", 251),
  ];
  const b = analyseBricks(acts);
  assert.equal(b.brickDays, 3);
  assert.equal(b.freshRuns, 3);
  assert.ok(b.decouplingPct != null && b.decouplingPct >= 5, "lower same-day-ride EF → a 'drops' finding");

  const f = brickFinding(b)!;
  assert.ok(f, "finding populates at brickDays>=3 & freshRuns>=3");
  // Relabelled away from the true-brick / "off the bike" (T2) framing that implied a real transition.
  assert.match(f.title, /same-day run\/ride/i);
  assert.doesNotMatch(f.title, /off the bike/i);
  assert.match(f.detail, /not a true off-bike/i);
  assert.match(f.evidence, /same-day proxy, not a true off-bike transition/i);
  // Stays an honest, low-confidence, uncontrolled proxy.
  assert.ok((f.confidence ?? 1) <= 0.6);
});

test("brick finding stays silent below the gate (needs >=3 same-day days and >=3 run-only days)", () => {
  const acts: RichActivity[] = [run("2026-06-01", 230), ride("2026-06-01"), run("2026-06-08", 250)];
  assert.equal(brickFinding(analyseBricks(acts)), null);
});
