import { test } from "node:test";
import assert from "node:assert/strict";
import { isDecideItemNew, newBadge } from "../src/coach/dashboardHelpers.js";

// A Decide-inbox item is "new until you do something with it": new exactly when its key has no reaction.
test("isDecideItemNew: un-reacted keys are new; any reaction clears it", () => {
  const reactions = new Map<string, string>([
    ["liked", "agree"],
    ["disliked", "disagree"],
    ["applied", "applied"],
  ]);
  // No reaction recorded → still waiting on you → new.
  assert.equal(isDecideItemNew("fresh", reactions), true);
  // Any recorded reaction (agree / disagree / applied) means you dealt with it → not new.
  assert.equal(isDecideItemNew("liked", reactions), false);
  assert.equal(isDecideItemNew("disliked", reactions), false);
  assert.equal(isDecideItemNew("applied", reactions), false);
  // Undefined map (no reactions loaded) → everything is new.
  assert.equal(isDecideItemNew("anything", undefined), true);
});

test("newBadge: renders the NEW pill only for an un-actioned key", () => {
  const reactions = new Map<string, string>([["done", "agree"]]);
  assert.equal(newBadge("fresh", reactions), `<span class="newbadge">NEW</span>`);
  assert.equal(newBadge("done", reactions), "");
});
