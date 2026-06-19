import { test } from "node:test";
import assert from "node:assert/strict";
import { recsToFindings, latestAdviceFindings, renderCoachRecs } from "../src/coach/adviceRecs.js";
import type { InsightSnapshot, SurfacedFinding } from "../src/state/insightLog.js";

test("recsToFindings: keys + family-tags each rec; off-list family → General; dedupes + drops blanks", () => {
  const fs = recsToFindings(
    [
      { text: "Take 60 g/h carb on rides over 90 min", family: "Fuelling & body comp" },
      { text: "Take 60 g/h carb on rides over 90 min", family: "Fuelling & body comp" }, // dup → dropped
      { text: "Buy aero socks", family: "Marketing" }, // off-list family → General
      { text: "   ", family: "Gear" }, // blank → dropped
    ],
    "readiness",
  );
  assert.equal(fs.length, 2);
  assert.deepEqual(
    fs.map((f) => ({ key: f.key, family: f.family, severity: f.severity })),
    [
      { key: "advice:readiness:take-60-g-h-carb-on-rides-over-90-min", family: "Fuelling & body comp", severity: "info" },
      { key: "advice:readiness:buy-aero-socks", family: "General", severity: "info" },
    ],
  );
  assert.match(fs[0].evidence, /readiness — coach recommendation/);
});

test("recsToFindings: source namespaces the key (deep-dive + ask), and an empty list is well-formed", () => {
  assert.equal(recsToFindings([{ text: "Ease the Wednesday long run", family: "Load & form" }], "deep-dive")[0].key, "advice:deep-dive:ease-the-wednesday-long-run");
  assert.equal(recsToFindings([{ text: "Add a second gel after 90 min", family: "Fuelling & body comp" }], "ask")[0].key, "advice:ask:add-a-second-gel-after-90-min");
  assert.deepEqual(recsToFindings(undefined, "readiness"), []);
});

function snap(ts: string, surface: string, findings: SurfacedFinding[]): InsightSnapshot {
  return { ts, surface, findings, schemaVersion: 1 };
}
const sf = (key: string, family = "Gear"): SurfacedFinding => ({ key, family, title: key, severity: "info", detail: "d", evidence: "e" });

test("latestAdviceFindings: takes the LATEST snapshot per advice surface, merges, dedupes, drops suppressed", () => {
  const snapshots = [
    snap("2026-06-01T07:00:00Z", "readiness", [sf("advice:readiness:old")]),
    snap("2026-06-10T07:00:00Z", "readiness", [sf("advice:readiness:a"), sf("advice:readiness:b")]), // latest readiness wins
    snap("2026-06-09T07:00:00Z", "deep-dive", [sf("advice:deep-dive:c")]),
    snap("2026-06-11T07:00:00Z", "ask", [sf("advice:ask:d")]), // ask is an advice surface too
    snap("2026-06-05T07:00:00Z", "dashboard", [sf("ignored-non-advice-surface")]), // not an advice surface
  ];
  const out = latestAdviceFindings(snapshots, new Set(["advice:readiness:b"]));
  assert.deepEqual(out.map((f) => f.key), ["advice:readiness:a", "advice:deep-dive:c", "advice:ask:d"]); // old readiness gone, b suppressed, dashboard ignored
});

test("renderCoachRecs: reactable cards carry key + family + the four actions; hidden when empty or shared", () => {
  const recs = [sf("advice:readiness:fuel", "Fuelling & body comp")];
  const html = renderCoachRecs(recs, new Map([["advice:readiness:fuel", "agree"]]));
  assert.match(html, /Coach's recommendations/);
  assert.match(html, /data-key="advice:readiness:fuel"/);
  assert.match(html, /data-family="Fuelling &amp; body comp"/);
  assert.match(html, /👍 Agree[\s\S]*👎 Disagree[\s\S]*💤 Snooze[\s\S]*🚫 Ignore/);
  assert.match(html, /onclick="ignoreCard\(this\)"/);
  assert.match(html, /data-reaction-state="like"/, "renders the persisted reaction state");
  assert.equal(renderCoachRecs([], undefined), "", "no card when there's nothing to show");
  assert.equal(renderCoachRecs(recs, undefined, true), "", "hidden in share/screenshot mode");
});
