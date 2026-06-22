import type { Profile } from "../profile/schema.js";

/**
 * The athlete's fuel inventory — the nutrition they actually use, read from the local profile's
 * `fuelling.products` block (profile.local.yaml — gitignored, hand-editable). Parsing is DELIBERATELY
 * permissive (same defensive style as profile/context.ts): only fields that are present are read, a
 * malformed entry is skipped rather than throwing, and nothing is invented. This is stable context, so
 * it lives in the profile, not in a live AI Endurance / Garmin field.
 *
 * The categories drive the deterministic fuel plan (fuelPlan.ts): which products are during-session
 * carbs, which are hydration, which are recovery, which are pre-session nitrate/caffeine, and which are
 * daily ergogenic supplements (consistency, not per-session timing).
 */

export type FuelCategory =
  | "drink_mix" // carbohydrate drink powder (carbs + often electrolytes)
  | "gel"
  | "chew"
  | "bar" // energy bar / flapjack / real-food bar
  | "real_food"
  | "electrolyte" // hydration tabs/low-calorie electrolytes (minimal carbs)
  | "recovery" // post-session protein / carb+protein
  | "nitrate" // beetroot / nitrate shot (pre-session ergogenic)
  | "caffeine" // standalone caffeine source
  | "supplement" // daily/chronic ergogenic (beta-alanine, carnitine, NO booster, …)
  | "other";

/** Categories that contribute usable during-session carbohydrate. */
export const DURING_CARB_CATEGORIES: ReadonlySet<FuelCategory> = new Set<FuelCategory>(["drink_mix", "gel", "chew", "bar", "real_food"]);

export interface FuelProduct {
  /** Slug derived from the name — stable key for selection + logging. */
  id: string;
  name: string;
  brand?: string;
  category: FuelCategory;
  /** Human serving label, e.g. "1 bar (120 g)", "1 scoop (30 g)", "1 tab in 500 ml". */
  serving?: string;
  carbsG?: number; // per serving
  sodiumMg?: number; // per serving
  caffeineMg?: number; // per serving
  proteinG?: number; // per serving
  fluidMl?: number; // fluid the serving is taken in / provides (a drink/tab)
  /** When the athlete uses it: any of "pre" | "during" | "after" | "daily". */
  timing: string[];
  notes?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // tolerate a numeric string ("80") since YAML scalars from a hand-edited file can arrive as text
  if (typeof v === "string" && /^[+-]?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return undefined;
};
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Map a free-text category/keyword to a known FuelCategory; falls back to keyword-sniffing the name. */
export function normalizeCategory(raw: string | undefined, nameAndNotes = ""): FuelCategory {
  const t = `${raw ?? ""} ${nameAndNotes}`.toLowerCase();
  // Product-FORM words win first (a "Beta Fuel Gel" is a gel, not the drink-mix brand family) — brand
  // names like Beta Fuel / Maurten are ambiguous (they make both), so we don't key off them.
  if (/\bgel\b/.test(t)) return "gel";
  if (/\bchew|block|shot blok|jelly|gummies\b/.test(t)) return "chew";
  if (/\bdrink.?mix|carb.?(drink|powder)|energy drink|\bmix\b/.test(t)) return "drink_mix";
  if (/\bbar\b|flapjack|cake|rice cake|banana/.test(t)) return "bar";
  if (/real.?food|sandwich|fig roll|date/.test(t)) return "real_food";
  if (/electrolyte|hydration|salt|sodium tab|nuun|precision/.test(t)) return "electrolyte";
  if (/recovery|whey|protein|rego|casein|milk/.test(t)) return "recovery";
  if (/beet|nitrate|cherry/.test(t)) return "nitrate";
  if (/caffeine|espresso|pro plus/.test(t)) return "caffeine";
  if (/beta.?alanine|carnitine|creatine|nitro|citrulline|arginine|supplement|capsule|veggiecap|tablet/.test(t)) return "supplement";
  // exact category words
  if (raw) {
    const r = raw.toLowerCase().replace(/[^a-z]+/g, "_");
    const known: FuelCategory[] = ["drink_mix", "gel", "chew", "bar", "real_food", "electrolyte", "recovery", "nitrate", "caffeine", "supplement", "other"];
    const hit = known.find((k) => k === r);
    if (hit) return hit;
  }
  return "other";
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

function parseTiming(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\s]+/) : [];
  const allowed = new Set(["pre", "during", "after", "daily"]);
  const out = raw.map((x) => String(x).toLowerCase().trim()).filter((x) => allowed.has(x));
  return [...new Set(out)];
}

/** Default timing when the entry doesn't state one — inferred from the category so the plan still works. */
function defaultTiming(cat: FuelCategory): string[] {
  switch (cat) {
    case "drink_mix":
    case "gel":
    case "chew":
      return ["during"];
    case "bar":
    case "real_food":
      return ["pre", "during"];
    case "electrolyte":
      return ["during"];
    case "recovery":
      return ["after"];
    case "nitrate":
    case "caffeine":
      return ["pre"];
    case "supplement":
      return ["daily"];
    default:
      return [];
  }
}

/** Parse one raw product entry into a FuelProduct, or null if it has no usable name. */
export function parseProduct(raw: unknown, index: number): FuelProduct | null {
  const o = obj(raw);
  if (!o) return null;
  const name = str(o.name) ?? str(o.product) ?? str(o.title);
  if (!name) return null;
  const notes = str(o.notes) ?? str(o.note);
  const category = normalizeCategory(str(o.category) ?? str(o.type), `${name} ${notes ?? ""}`);
  const timing = parseTiming(o.timing) ;
  return {
    id: str(o.id) ? `${str(o.id)}` : `${slug(name)}-${index}`,
    name,
    brand: str(o.brand),
    category,
    serving: str(o.serving) ?? str(o.serving_size),
    carbsG: num(o.carbs_g) ?? num(o.carbs) ?? num(o.carb_g),
    sodiumMg: num(o.sodium_mg) ?? num(o.sodium),
    caffeineMg: num(o.caffeine_mg) ?? num(o.caffeine),
    proteinG: num(o.protein_g) ?? num(o.protein),
    fluidMl: num(o.fluid_ml) ?? num(o.fluid),
    timing: timing.length ? timing : defaultTiming(category),
    notes,
  };
}

/** Read the full inventory from a profile's fuelling.products block. Empty array when absent/empty. */
export function loadInventory(profile: Profile | undefined): FuelProduct[] {
  const f = obj(profile?.fuelling);
  const list = Array.isArray(f?.products) ? (f!.products as unknown[]) : [];
  const out: FuelProduct[] = [];
  list.forEach((raw, i) => {
    const p = parseProduct(raw, i);
    if (p) out.push(p);
  });
  return out;
}

// ---- Selection helpers (pure) ----------------------------------------------

const byCategory = (inv: FuelProduct[], ...cats: FuelCategory[]): FuelProduct[] => inv.filter((p) => cats.includes(p.category));

/** During-session carbohydrate candidates with a known per-serving carb figure, biggest carb first. */
export function carbCandidates(inv: FuelProduct[]): FuelProduct[] {
  return inv
    .filter((p) => DURING_CARB_CATEGORIES.has(p.category) && (p.carbsG ?? 0) > 0)
    .sort((a, b) => (b.carbsG ?? 0) - (a.carbsG ?? 0));
}

export const electrolyteProducts = (inv: FuelProduct[]): FuelProduct[] => byCategory(inv, "electrolyte");
export const recoveryProducts = (inv: FuelProduct[]): FuelProduct[] => byCategory(inv, "recovery");
export const nitrateProducts = (inv: FuelProduct[]): FuelProduct[] => byCategory(inv, "nitrate");
export const caffeineSources = (inv: FuelProduct[]): FuelProduct[] => inv.filter((p) => (p.caffeineMg ?? 0) > 0 || p.category === "caffeine");
export const dailySupplements = (inv: FuelProduct[]): FuelProduct[] => inv.filter((p) => p.category === "supplement" || p.timing.includes("daily"));

export interface CarbCombo {
  items: Array<{ product: FuelProduct; count: number }>;
  totalCarbsG: number;
  totalCaffeineMg: number;
}

/**
 * Greedily assemble a combination of carb products that reaches `targetG` (best-effort — stops when met or
 * when adding the smallest remaining item would only overshoot a lot). Deterministic: largest-carb item
 * first, then top up with the smallest item. `avoidCaffeine` skips caffeinated picks (late-day sessions).
 * Returns an empty combo when there are no candidates (the caller then notes the inventory gap honestly).
 */
export function chooseCarbCombo(targetG: number, candidates: FuelProduct[], opts: { avoidCaffeine?: boolean } = {}): CarbCombo {
  const pool = candidates.filter((p) => !(opts.avoidCaffeine && (p.caffeineMg ?? 0) > 0));
  const empty: CarbCombo = { items: [], totalCarbsG: 0, totalCaffeineMg: 0 };
  if (!pool.length || targetG <= 0) return empty;
  const big = pool[0]; // largest carb per serving
  const small = pool[pool.length - 1]; // smallest — for topping up
  const items = new Map<string, { product: FuelProduct; count: number }>();
  let total = 0;
  const add = (p: FuelProduct) => {
    const e = items.get(p.id) ?? { product: p, count: 0 };
    e.count += 1;
    items.set(p.id, e);
    total += p.carbsG ?? 0;
  };
  // Use the big item to get most of the way (cap servings so we don't suggest something absurd).
  const bigCarb = big.carbsG ?? 0;
  while (bigCarb > 0 && total + bigCarb <= targetG && [...items.values()].reduce((n, e) => n + e.count, 0) < 6) add(big);
  // Top up with the smallest item if we're still short by more than half a small serving.
  const smallCarb = small.carbsG ?? 0;
  while (smallCarb > 0 && targetG - total > smallCarb / 2 && [...items.values()].reduce((n, e) => n + e.count, 0) < 8) add(small);
  // If nothing fit (target smaller than the smallest item), still suggest the single smallest item.
  if (!items.size) add(small);
  const list = [...items.values()];
  return {
    items: list,
    totalCarbsG: Math.round(total),
    totalCaffeineMg: Math.round(list.reduce((mg, e) => mg + (e.product.caffeineMg ?? 0) * e.count, 0)),
  };
}
