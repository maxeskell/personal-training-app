import { test } from "node:test";
import assert from "node:assert/strict";
import { selectDataSource } from "../src/sources/index.js";
import { AieDataSource } from "../src/sources/aieSource.js";

test("selectDataSource: AI Endurance is the default and resolves its aliases (case/space-insensitive)", () => {
  assert.equal(selectDataSource().id, "ai-endurance"); // no arg → config default
  for (const id of ["ai-endurance", "aie", "AIEndurance", " AIE "]) {
    const s = selectDataSource(id);
    assert.equal(s.id, "ai-endurance");
    assert.equal(s.label, "AI Endurance");
  }
});

test("selectDataSource: an unknown source falls back to AI Endurance (degrade, don't crash)", () => {
  assert.equal(selectDataSource("some-unbuilt-source").id, "ai-endurance");
});

test("AieDataSource: satisfies the DataSource shape", () => {
  const s = new AieDataSource();
  assert.equal(s.id, "ai-endurance");
  assert.equal(s.label, "AI Endurance");
  assert.equal(typeof s.assemble, "function");
});
