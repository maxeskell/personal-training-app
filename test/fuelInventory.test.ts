import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadInventory,
  parseProduct,
  normalizeCategory,
  carbCandidates,
  chooseCarbCombo,
  electrolyteProducts,
  recoveryProducts,
  dailySupplements,
} from "../src/coach/fuelInventory.js";
import type { Profile } from "../src/profile/schema.js";

/**
 * The fuel inventory is parsed (permissively) from the profile's fuelling.products block. It must
 * categorise sensibly, skip a malformed entry rather than throw, default sane timing per category, and the
 * carb-combo selector must deterministically reach a target (or note the gap when there's nothing to pick).
 */

const profileWith = (products: unknown[]): Profile => ({ schema_version: 1, identity: {}, fuelling: { products } }) as unknown as Profile;

test("loadInventory parses products and infers categories from name/keywords", () => {
  const inv = loadInventory(
    profileWith([
      { name: "Beta Fuel Gel", carbs_g: 40 },
      { name: "Flapjack", brand: "Flapjack Co", carbs_g: 65, serving: "1 bar (120g)" },
      { name: "5 Electrolytes Lemon", brand: "PowerBar", category: "electrolyte", caffeine_mg: 75 },
      { name: "REGO Whey Protein", brand: "SIS", protein_g: 21, carbs_g: 4 },
      { name: "Beta-Alanine", brand: "XXL", category: "supplement" },
      { name: "Beet It RE:GEN", brand: "Beet It" },
    ]),
  );
  assert.equal(inv.length, 6);
  assert.equal(inv.find((p) => p.name === "Beta Fuel Gel")?.category, "gel");
  assert.equal(inv.find((p) => p.name === "Flapjack")?.category, "bar");
  assert.equal(inv.find((p) => p.name.includes("Electrolytes"))?.category, "electrolyte");
  assert.equal(inv.find((p) => p.name.includes("REGO"))?.category, "recovery");
  assert.equal(inv.find((p) => p.name === "Beta-Alanine")?.category, "supplement");
  assert.equal(inv.find((p) => p.name.includes("Beet"))?.category, "nitrate");
});

test("parseProduct skips an entry with no name; defaults timing from category", () => {
  assert.equal(parseProduct({ carbs_g: 40 }, 0), null, "no name → skipped");
  const gel = parseProduct({ name: "Some Gel", carbs_g: 30 }, 0)!;
  assert.deepEqual(gel.timing, ["during"], "gels default to during");
  const rec = parseProduct({ name: "Whey", category: "recovery" }, 1)!;
  assert.deepEqual(rec.timing, ["after"]);
  const sup = parseProduct({ name: "Creatine", category: "supplement" }, 2)!;
  assert.deepEqual(sup.timing, ["daily"]);
});

test("loadInventory tolerates a malformed product entry without throwing", () => {
  const inv = loadInventory(profileWith([{ name: "Gel", carbs_g: 30 }, "not-an-object", 42, null, { name: "Bar", carbs_g: 50 }]));
  assert.equal(inv.length, 2, "two valid products survive the junk entries");
});

test("normalizeCategory falls back to keyword sniffing then 'other'", () => {
  assert.equal(normalizeCategory(undefined, "chocolate milk recovery drink"), "recovery");
  assert.equal(normalizeCategory("drink_mix"), "drink_mix");
  assert.equal(normalizeCategory(undefined, "mystery item"), "other");
});

test("chooseCarbCombo reaches the target with the products on hand", () => {
  const inv = loadInventory(profileWith([
    { name: "Flapjack", carbs_g: 65 },
    { name: "Gel", carbs_g: 22 },
  ]));
  const combo = chooseCarbCombo(150, carbCandidates(inv));
  assert.ok(combo.totalCarbsG >= 110, `combo should approach 150g, got ${combo.totalCarbsG}`);
  assert.ok(combo.items.length >= 1);
});

test("chooseCarbCombo avoids caffeine when asked (evening session)", () => {
  const inv = loadInventory(profileWith([
    { name: "Caffeine Gel", carbs_g: 30, caffeine_mg: 75 },
    { name: "Plain Gel", carbs_g: 30 },
  ]));
  const combo = chooseCarbCombo(60, carbCandidates(inv), { avoidCaffeine: true });
  assert.equal(combo.totalCaffeineMg, 0, "no caffeinated picks when avoidCaffeine is set");
});

test("chooseCarbCombo returns empty when there are no carb candidates", () => {
  const inv = loadInventory(profileWith([{ name: "Electrolyte tab", category: "electrolyte" }]));
  const combo = chooseCarbCombo(60, carbCandidates(inv));
  assert.equal(combo.items.length, 0);
  assert.equal(combo.totalCarbsG, 0);
});

test("selection helpers split the inventory by role", () => {
  const inv = loadInventory(profileWith([
    { name: "Tab", category: "electrolyte" },
    { name: "Whey", category: "recovery", protein_g: 21 },
    { name: "Beta-Alanine", category: "supplement" },
  ]));
  assert.equal(electrolyteProducts(inv).length, 1);
  assert.equal(recoveryProducts(inv).length, 1);
  assert.equal(dailySupplements(inv).length, 1);
});
