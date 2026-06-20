import { test } from "node:test";
import assert from "node:assert/strict";
import { renderFuelCard } from "../src/coach/fuelCard.js";
import { buildWeekFuelPlans } from "../src/coach/fuelPlan.js";
import { loadInventory } from "../src/coach/fuelInventory.js";
import type { Profile } from "../src/profile/schema.js";
import type { PlannedSession } from "../src/state/types.js";

/**
 * The fuelling card must: render nothing when there's no inventory AND no plan (stay quiet); show a setup
 * nudge when there's no inventory but sessions exist; render needed sessions with one-tap feedback buttons
 * carrying data-* (not quoted JS args); collapse quiet sessions to one line; ESCAPE adversarial product
 * names; and emit a <script> that parses (the dashboard's script-safety invariant).
 */

const NASTY = `O'Brien "</script><b>x</b>"`;

const inv = loadInventory({
  schema_version: 1,
  identity: {},
  fuelling: {
    products: [
      { name: NASTY, brand: "X", carbs_g: 65, category: "bar" },
      { name: "Gel", carbs_g: 22, category: "gel" },
      { name: "REGO Whey", brand: "SIS", category: "recovery", protein_g: 21 },
      { name: "Beta-Alanine", brand: "XXL", category: "supplement" },
    ],
  },
} as unknown as Profile);

const longRide: PlannedSession[] = [
  { date: "2026-06-22", sport: "Ride", durationMin: 180, title: "Long endurance ride" },
  { date: "2026-06-23", sport: "Run", durationMin: 40, title: "Easy run" },
];

function scriptsParse(html: string) {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script(?:\s[^>]*)?>/gi)].map((m) => m[1]);
  for (const [i, sc] of scripts.entries()) assert.doesNotThrow(() => new Function(sc), `fuel card script ${i} must parse`);
  return scripts;
}

test("renders nothing when there's no inventory and no plans", () => {
  assert.equal(renderFuelCard({ plans: [], inventory: [] }), "");
});

test("shows a setup nudge when sessions exist but no inventory is logged", () => {
  const plans = buildWeekFuelPlans(longRide, { inventory: [] });
  const html = renderFuelCard({ plans, inventory: [] });
  assert.match(html, /Add the nutrition you use/);
  assert.match(html, /fuelling\.products/);
});

test("renders needed sessions with escaped names, feedback buttons, and quiet collapse", () => {
  const plans = buildWeekFuelPlans(longRide, { inventory: inv, weightKg: 72 });
  const html = renderFuelCard({ plans, inventory: inv, hasApiKey: true });
  // Adversarial product name never appears literally.
  assert.ok(!html.includes(NASTY), "nasty product name must be escaped");
  assert.ok(!html.includes("</script><b>x</b>"), "no injected closing tag");
  // The long ride is rendered with one-tap feedback using data-* (no quoted JS arg).
  assert.match(html, /data-outcome="good" onclick="fuelFeedback\(this,'good'\)"/);
  assert.match(html, /data-date="2026-06-22"/);
  // The easy run collapses into the quiet line.
  assert.match(html, /Nothing needed \(water's fine\)/);
  // Daily stack reference present (the supplement), and the review button (key present).
  assert.match(html, /Daily stack/);
  assert.match(html, /Review my fuelling/);
  scriptsParse(html);
});

test("share view drops interactive controls but keeps the analysis", () => {
  const plans = buildWeekFuelPlans(longRide, { inventory: inv, weightKg: 72 });
  const html = renderFuelCard({ plans, inventory: inv, hasApiKey: true, share: true });
  assert.doesNotMatch(html, /fuelFeedback/, "no feedback handler in share view");
  assert.doesNotMatch(html, /Review my fuelling/, "no review button in share view");
  assert.match(html, /g carb\/hr/, "guidance still shown");
});

test("renders the logged state when feedback already exists", () => {
  const plans = buildWeekFuelPlans(longRide, { inventory: inv, weightKg: 72 });
  const html = renderFuelCard({
    plans,
    inventory: inv,
    fuelLog: [{ schemaVersion: 1, date: "2026-06-22", sport: "Ride", outcome: "good", loggedAt: "2026-06-22T18:00:00Z" }],
  });
  assert.match(html, /👍 logged — went well/);
});
