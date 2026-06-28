import { test } from "node:test";
import assert from "node:assert/strict";
import { isDecideItemNew, newBadge, discussedLineHtml } from "../src/coach/dashboardHelpers.js";

test("discussedLineHtml: renders outcome + date + escaped note; empty for no discussion", () => {
  assert.equal(discussedLineHtml(undefined), "", "no discussion → nothing");
  const html = discussedLineHtml({ reaction: "agree", timestamp: "2026-06-27T09:00:00Z", note: "bank the easy hours <ok>" });
  assert.match(html, /discussed with coach/);
  assert.match(html, /· 27 Jun ·/, "shows the short date");
  assert.match(html, /agreed/, "maps the reaction to an outcome word");
  assert.match(html, /bank the easy hours &lt;ok&gt;/, "the note is HTML-escaped");
  assert.doesNotMatch(html, /<ok>/, "no raw angle brackets from the note");
  // A note-less discussion still shows the outcome line.
  assert.match(discussedLineHtml({ reaction: "disagree", timestamp: "2026-06-27T09:00:00Z" }), /discussed with coach · 27 Jun · disagreed/);
});

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
