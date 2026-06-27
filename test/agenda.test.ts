import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgenda, formatAgendaText } from "../src/coach/agenda.js";
import type { SetupItem } from "../src/coach/setupCard.js";
import type { SurfacedFinding } from "../src/state/insightLog.js";
import type { InsightReaction } from "../src/state/decisionLog.js";

/** The agenda is the READ half of the coach↔dashboard loop: it flattens the same items the dashboard
 *  surfaces, annotated with each key's current decision-log reaction, in a stable walk-through order. */

function setupItem(p: Partial<SetupItem> & Pick<SetupItem, "key" | "label" | "group">): SetupItem {
  return {
    why: "",
    action: "",
    source: "open_item",
    route: "discuss with coach",
    priority: 1,
    ...p,
  } as SetupItem;
}

const rec: SurfacedFinding = {
  key: "advice:readiness:bank-easy-volume",
  family: "Recovery",
  title: "Bank easy endurance volume now",
  severity: "watch",
  detail: "You logged 0.45h of 1.80h prescribed; capacity is there.",
  evidence: "[derived]",
  recommendation: "Add an easy aerobic hour before Thursday.",
};

const items: SetupItem[] = [
  setupItem({ key: "setup:open:book-bloods", label: "Book Medichecks blood test", group: "finish_setup", route: "discuss with coach", why: "First panel since 2020." }),
  setupItem({ key: "setup:tune:cadence-drift", label: "Tighten cadence on long rides", group: "this_week", source: "tune", reactable: true, family: "Efficiency", why: "EF drifts late.", action: "Hold 85+ rpm." }),
  setupItem({ key: "setup:weekly:add-strides", label: "Add strides Friday", group: "this_week", source: "weekly", applyable: true, rec: "Add 6x20s strides", why: "Run economy." }),
  setupItem({ key: "setup:research:wider-tyres", label: "Consider 30mm tyres", group: "worth_considering", source: "research" }),
];

test("buildAgenda flattens setup items + coach recs, annotates reaction + applied, counts open", () => {
  const reactions = new Map<string, InsightReaction>([["setup:tune:cadence-drift", "agree"]]);
  const applied = new Set<string>(["setup:weekly:add-strides"]);
  const agenda = buildAgenda(items, [rec], reactions, applied);

  assert.equal(agenda.items.length, 5, "4 setup items + 1 coach rec");
  const byKey = new Map(agenda.items.map((i) => [i.key, i]));
  assert.equal(byKey.get("setup:tune:cadence-drift")!.reaction, "agree", "reaction annotated");
  assert.equal(byKey.get("setup:weekly:add-strides")!.applied, true, "applied annotated");
  assert.equal(byKey.get("advice:readiness:bank-easy-volume")!.group, "coach_rec", "coach rec grouped");
  // Open = no reaction and not applied: bloods, research, and the coach rec = 3.
  assert.equal(agenda.openCount, 3);
});

test("buildAgenda orders groups coach_rec → this_week → finish_setup → worth_considering", () => {
  const agenda = buildAgenda(items, [rec], new Map(), new Set());
  const groups = agenda.items.map((i) => i.group);
  assert.equal(groups[0], "coach_rec", "coach recs first");
  // groups appear in canonical order (no this_week after finish_setup, etc.)
  const order = ["coach_rec", "this_week", "finish_setup", "worth_considering"];
  const idx = groups.map((g) => order.indexOf(g));
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, "groups are in canonical order");
});

test("formatAgendaText shows keys, state labels and headings for a walk-through", () => {
  const reactions = new Map<string, InsightReaction>([["setup:open:book-bloods", "ignore"]]);
  const text = formatAgendaText(buildAgenda(items, [rec], reactions, new Set()));
  assert.match(text, /Coaching agenda — 5 item\(s\)/);
  assert.match(text, /## Coach recommendations/);
  assert.match(text, /key=advice:readiness:bank-easy-volume/, "each item shows its key for recording an outcome");
  assert.match(text, /💤 snoozed.*Book Medichecks/s, "the snoozed item shows its state");
  assert.match(text, /— open \(not yet discussed\)/, "open items are flagged");
  assert.match(text, /gated plan-change available/, "an applyable cue is flagged");
});

test("formatAgendaText handles an empty agenda", () => {
  assert.match(formatAgendaText(buildAgenda([], [], new Map(), new Set())), /Nothing on the agenda/);
});
