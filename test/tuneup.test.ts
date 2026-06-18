import { test } from "node:test";
import assert from "node:assert/strict";
import { selectMarginalGains } from "../src/coach/tuneUp.js";
import type { InsightReport } from "../src/insights/engine.js";
import type { Finding } from "../src/insights/metrics.js";

const F = (o: Partial<Finding>): Finding => ({ family: "Aerobic efficiency", title: "t", severity: "watch", detail: "d", evidence: "e", confidence: 0.6, ...o });
const report = (findings: Finding[]) => ({ findings, topFindings: [] } as unknown as InsightReport);

test("selectMarginalGains: only small, actionable, non-macro findings — ranked, capped", () => {
  const got = selectMarginalGains(
    report([
      F({ family: "Injury risk", title: "Big ramp", recommendation: "cut" }), // macro → excluded
      F({ family: "Load & form", title: "TSB", recommendation: "ease" }), // macro → excluded
      F({ family: "Aerobic efficiency", title: "EF tweak", severity: "info", recommendation: "steady runs", confidence: 0.6 }),
      F({ family: "Durability", title: "Brick pacing", severity: "watch", recommendation: "5W easier", confidence: 0.8 }),
      F({ family: "Fuelling", title: "No rec", severity: "watch" }), // no recommendation → excluded
      F({ family: "Aerobic efficiency", title: "A flag", severity: "flag", recommendation: "x" }), // flag → excluded
    ]),
  );
  assert.deepEqual(got.map((f) => f.title), ["Brick pacing", "EF tweak"]); // watch×0.8 before info×0.6; rest dropped
});

test("selectMarginalGains: caps the list", () => {
  const findings = Array.from({ length: 10 }, (_, i) => F({ title: `t${i}`, recommendation: "r" }));
  assert.equal(selectMarginalGains(report(findings), 3).length, 3);
});
