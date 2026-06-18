import { test } from "node:test";
import assert from "node:assert/strict";
import { firstSeenFrom, type InsightSnapshot, type SurfacedFinding } from "../src/state/insightLog.js";

function sf(key: string, detail = "d"): SurfacedFinding {
  return { key, family: "F", title: key.toUpperCase(), severity: "watch", detail, evidence: "e" };
}

test("firstSeenFrom: earliest surfacing timestamp per key, regardless of snapshot order", () => {
  const snaps: InsightSnapshot[] = [
    { ts: "2026-06-05T07:00:00Z", surface: "dashboard", findings: [sf("a", "newer")], schemaVersion: 1 },
    { ts: "2026-06-01T07:00:00Z", surface: "dashboard", findings: [sf("a", "older"), sf("b")], schemaVersion: 1 },
  ];
  const fs = firstSeenFrom(snaps);
  assert.equal(fs.get("a"), "2026-06-01T07:00:00Z"); // earliest wins even though it appears second
  assert.equal(fs.get("b"), "2026-06-01T07:00:00Z");
  assert.equal(fs.has("c"), false);
});
