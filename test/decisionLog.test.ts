import { test } from "node:test";
import assert from "node:assert/strict";
import { latestInsightReactions, suppressedInsightKeys, reactionFromLabel, type DecisionRecord, type DecisionStatus } from "../src/state/decisionLog.js";

function fb(key: string, status: DecisionStatus, ts: string): DecisionRecord {
  return { id: `${key}-${ts}`, timestamp: ts, kind: "insight-feedback", summary: key, insightKey: key, status };
}

test("suppressedInsightKeys: only snooze (deferred) hides — like/dislike stay visible", () => {
  const reactions = latestInsightReactions([
    fb("liked", "accepted", "2026-06-10T00:00:00Z"),
    fb("disliked", "declined", "2026-06-10T00:00:00Z"),
    fb("snoozed", "deferred", "2026-06-10T00:00:00Z"),
  ]);
  const sup = suppressedInsightKeys(reactions, 14, new Date("2026-06-12T00:00:00Z"));
  assert.deepEqual([...sup], ["snoozed"]); // dislike no longer hides
});

test("suppressedInsightKeys: a snooze older than the window lapses (can resurface)", () => {
  const reactions = latestInsightReactions([fb("snoozed", "deferred", "2026-05-01T00:00:00Z")]);
  assert.equal(suppressedInsightKeys(reactions, 14, new Date("2026-06-12T00:00:00Z")).size, 0);
});

test("latestInsightReactions: latest wins, and a later 'clear' drops the opinion (back to neutral)", () => {
  const recs = [fb("k", "accepted", "2026-06-01T00:00:00Z"), fb("k", "declined", "2026-06-05T00:00:00Z")];
  assert.equal(latestInsightReactions(recs).get("k")?.reaction, "disagree"); // most recent wins
  const cleared = latestInsightReactions([...recs, fb("k", "cleared", "2026-06-06T00:00:00Z")]);
  assert.equal(cleared.has("k"), false); // clear removes it
});

test("reactionFromLabel: shared vocabulary for the website + MCP react_to_insight; unknown → undefined", () => {
  assert.equal(reactionFromLabel("like"), "agree");
  assert.equal(reactionFromLabel("dislike"), "disagree");
  assert.equal(reactionFromLabel("snooze"), "ignore");
  assert.equal(reactionFromLabel("clear"), "clear");
  assert.equal(reactionFromLabel("agree"), "agree"); // canonical names still accepted
  assert.equal(reactionFromLabel("bogus"), undefined);
});
