import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recsToFindings,
  latestAdviceFindings,
  renderCoachRecs,
  adviceSourceOfKey,
  groupAdviceBySource,
  ADVICE_RECS_SCHEMA,
  MAX_ADVICE_RECS,
} from "../src/coach/adviceRecs.js";
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

test("renderCoachRecs: a clustered rep shows a 'shown once' note naming the other sources; titles are escaped", () => {
  const rep = sf("advice:readiness:rest", "Recovery (HRV status)");
  const merged = new Map<string, SurfacedFinding[]>([
    ["advice:readiness:rest", [sf("advice:ask:<script>", "General")]],
  ]);
  const html = renderCoachRecs([rep], undefined, false, merged);
  assert.match(html, /Same point also raised in/);
  assert.match(html, /your recent question/); // the ask source phrase
  assert.match(html, /shown once/);
  // The merged title (which contains a script tag) must be HTML-escaped in the tooltip: assert the
  // escaped form is present (a positive check — not a regex that tries to spot a raw tag).
  assert.match(html, /&lt;script&gt;/, "merged titles in the tooltip are HTML-escaped");
  // Without the merged map, the note is absent (back-compat: existing callers pass 3 args).
  assert.doesNotMatch(renderCoachRecs([rep], undefined, false), /shown once/);
});

test("ADVICE_RECS_SCHEMA: no array length constraints (structured-output 400s on them); cap lives in code", () => {
  const schema = ADVICE_RECS_SCHEMA as { maxItems?: number; minItems?: number; description: string };
  // Anthropic structured-output rejects maxItems/minItems on arrays — neither may appear in the schema.
  assert.equal(schema.maxItems, undefined, "no maxItems — it 400s the structured-output call");
  assert.equal(schema.minItems, undefined, "must not mandate a floor — padding is what we're fixing");
  assert.doesNotMatch(schema.description, /2[–-]4/, "the old 2–4 floor wording is gone");
  assert.match(schema.description, /fewest/i);
});

test("recsToFindings: caps surfaced recommendations at MAX_ADVICE_RECS (the cap the schema can't carry)", () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ text: `Distinct rec ${i}`, family: "Load & form" }));
  assert.equal(recsToFindings(many, "readiness").length, MAX_ADVICE_RECS);
});

test("adviceSourceOfKey: parses the source from the key; null for non-advice/garbled keys", () => {
  assert.equal(adviceSourceOfKey("advice:readiness:keep-it-easy"), "readiness");
  assert.equal(adviceSourceOfKey("advice:deep-dive:ease-the-long-run"), "deep-dive");
  assert.equal(adviceSourceOfKey("advice:ask:add-a-gel"), "ask");
  assert.equal(adviceSourceOfKey("advice:weekly:something"), null, "unknown source → null");
  assert.equal(adviceSourceOfKey("load:ramp:high"), null, "non-advice key → null");
});

test("groupAdviceBySource: fixed readiness→deep-dive→ask order; unknown keys trail header-less", () => {
  const groups = groupAdviceBySource([
    sf("advice:ask:d"),
    sf("advice:readiness:a"),
    sf("advice:deep-dive:c"),
    sf("advice:readiness:b"),
    sf("orphan-key"),
  ]);
  assert.deepEqual(
    groups.map((g) => ({ source: g.source, keys: g.items.map((f) => f.key) })),
    [
      { source: "readiness", keys: ["advice:readiness:a", "advice:readiness:b"] },
      { source: "deep-dive", keys: ["advice:deep-dive:c"] },
      { source: "ask", keys: ["advice:ask:d"] },
      { source: null, keys: ["orphan-key"] }, // garbled key kept, just header-less
    ],
  );
});

test("renderCoachRecs: shows provenance group headings, most-timely source first", () => {
  const html = renderCoachRecs([sf("advice:deep-dive:c"), sf("advice:readiness:a")]);
  assert.match(html, /readiness check/); // heading text (apostrophe is escaped to &#39; by escapeHtml)
  assert.match(html, /latest deep dive/);
  // readiness heading appears before the deep-dive heading regardless of input order
  assert.ok(html.indexOf("readiness check") < html.indexOf("latest deep dive"), "readiness group is rendered first");
  assert.match(html, /class="setup-group"/, "reuses the existing group-header style");
});
