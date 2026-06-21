import { test } from "node:test";
import assert from "node:assert/strict";
import { latestInsightReactions, suppressedInsightKeys, reactionFromLabel, executedSourceKeys, type DecisionRecord, type DecisionStatus } from "../src/state/decisionLog.js";

function fb(key: string, status: DecisionStatus, ts: string): DecisionRecord {
  return { id: `${key}-${ts}`, timestamp: ts, kind: "insight-feedback", summary: key, insightKey: key, status };
}

function pa(id: string, status: DecisionStatus, ts: string, sourceKey?: string): DecisionRecord {
  return { id, timestamp: ts, kind: "plan-adjust", summary: id, status, ...(sourceKey ? { sourceKey } : {}) };
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

test("suppressedInsightKeys: done (completed) + dismiss hide PERMANENTLY — never lapse", () => {
  // Both reactions are months old; a snooze that age would have lapsed, but done/dismiss stay hidden.
  const reactions = latestInsightReactions([
    fb("done", "completed", "2026-01-01T00:00:00Z"),
    fb("ignored-forever", "dismissed", "2026-01-01T00:00:00Z"),
    fb("snoozed-long-ago", "deferred", "2026-01-01T00:00:00Z"),
  ]);
  const sup = suppressedInsightKeys(reactions, 14, new Date("2026-06-12T00:00:00Z"));
  assert.deepEqual([...sup].sort(), ["done", "ignored-forever"]); // the stale snooze lapsed; these don't
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
  assert.equal(reactionFromLabel("done"), "done"); // ✓ Done on a setup task
  assert.equal(reactionFromLabel("dismiss"), "dismiss"); // 🚫 Ignore on a setup task
  assert.equal(reactionFromLabel("clear"), "clear");
  assert.equal(reactionFromLabel("agree"), "agree"); // canonical names still accepted
  assert.equal(reactionFromLabel("bogus"), undefined);
});

test("latestInsightReactions: round-trips done + dismiss through their stored statuses", () => {
  const recs = [fb("a", "completed", "2026-06-01T00:00:00Z"), fb("b", "dismissed", "2026-06-01T00:00:00Z")];
  const map = latestInsightReactions(recs);
  assert.equal(map.get("a")?.reaction, "done");
  assert.equal(map.get("b")?.reaction, "dismiss");
});

test("executedSourceKeys: only executed plan-adjusts that carry a card key count; latest status wins", () => {
  const recs = [
    pa("a", "proposed", "2026-06-20T00:00:00Z", "setup:weekly:k1"),
    pa("a", "executing", "2026-06-20T00:01:00Z", "setup:weekly:k1"),
    pa("a", "executed", "2026-06-20T00:02:00Z", "setup:weekly:k1"), // ✓ landed
    pa("b", "proposed", "2026-06-20T00:00:00Z", "setup:weekly:k2"), // never executed
    pa("c", "executed", "2026-06-20T00:00:00Z"), // executed but no source card
    pa("d", "proposed", "2026-06-20T00:00:00Z", "setup:weekly:k4"),
    pa("d", "executed", "2026-06-20T00:01:00Z", "setup:weekly:k4"),
    pa("d", "declined", "2026-06-20T00:02:00Z", "setup:weekly:k4"), // later reverted → un-marked
  ];
  assert.deepEqual([...executedSourceKeys(recs)], ["setup:weekly:k1"]);
});

test("applied: an applied card round-trips (executed → applied) and stays VISIBLE (not suppressed)", () => {
  // Applying a gated change from a "This week" card marks it applied — shown with a "✓ applied" tag, not
  // hidden like done/dismiss/snooze, so it doesn't re-offer the change but is still visible as actioned.
  assert.equal(reactionFromLabel("applied"), "applied");
  const reactions = latestInsightReactions([fb("setup:weekly:cut-ride", "executed", "2026-01-01T00:00:00Z")]);
  assert.equal(reactions.get("setup:weekly:cut-ride")?.reaction, "applied");
  const sup = suppressedInsightKeys(reactions, 14, new Date("2026-06-12T00:00:00Z"));
  assert.equal(sup.size, 0, "applied never suppresses — even months later the card stays visible");
});
