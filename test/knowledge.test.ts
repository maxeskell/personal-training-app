import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLastVerified, knowledgeFreshness, stampVerified, pendingName } from "../src/knowledge/store.js";

test("parseLastVerified + knowledgeFreshness: stale past the window; a missing marker is stale", () => {
  assert.equal(parseLastVerified("> Last verified: 2026-05-01\nbody"), "2026-05-01");
  assert.equal(parseLastVerified("no marker here"), null);

  const fresh = knowledgeFreshness("Last verified: 2026-06-10", new Date("2026-06-18T00:00:00Z"));
  assert.equal(fresh.ageDays, 8);
  assert.equal(fresh.stale, false);

  const stale = knowledgeFreshness("Last verified: 2026-04-01", new Date("2026-06-18T00:00:00Z"));
  assert.equal(stale.stale, true);
  assert.equal(knowledgeFreshness("no marker").stale, true); // never verified → due a refresh
});

test("stampVerified: replaces an existing marker, else inserts one under the H1", () => {
  const replaced = stampVerified("# Title\n\n> Last verified: 2026-01-01\n\nbody", "2026-06-18");
  assert.match(replaced, /Last verified: 2026-06-18/);
  assert.ok(!replaced.includes("2026-01-01"));

  const inserted = stampVerified("# Title\n\nbody", "2026-06-18");
  assert.match(inserted, /# Title\n\n> Last verified: 2026-06-18/);
});

test("pendingName: dated digest file name", () => {
  assert.equal(pendingName("2026-06-18"), "2026-06-18-research-digest.md");
});
