/**
 * Pure key-name scanner for probe payload introspection ("field hunt").
 *
 * `npm run probe` captures live AIE/Garmin samples so mappers are built against REAL field shapes, never
 * guesses (the repo's probe-first rule). This module makes that check mechanical: given a captured sample,
 * find every key whose NAME matches a pattern (e.g. /durab/i after AI Endurance's 2026-08 "durability for
 * all run & ride workouts" update) and report WHERE it lives and what TYPE it holds — types only, never
 * values, so the console summary stays free of health data (the gitignored report carries the raw samples).
 *
 * Pure + deterministic, no I/O — unit-tested with fixtures in test/keyscan.test.ts.
 */

export interface KeyHit {
  /** Dot/bracket path from the sample root, e.g. "activities[3].aerobic_durability_…_in_percent". */
  path: string;
  key: string;
  /** "null" | "number" | "string" | "boolean" | "array" | "object" — null covers undefined too. */
  type: string;
}

export interface ScanOptions {
  /** Recursion depth cap — a pathological payload must never hang a probe. */
  maxDepth?: number;
  /** Total hit cap — a hit on every item of a 5-year list would drown the summary. */
  maxHits?: number;
}

function typeOf(v: unknown): string {
  if (v == null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Walk any JSON-ish value and return every key whose NAME matches one of `patterns`. */
export function scanKeys(value: unknown, patterns: RegExp[], opts: ScanOptions = {}): KeyHit[] {
  const maxDepth = opts.maxDepth ?? 8;
  const maxHits = opts.maxHits ?? 200;
  const hits: KeyHit[] = [];
  const walk = (v: unknown, path: string, depth: number): void => {
    if (hits.length >= maxHits || depth > maxDepth || v == null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      return;
    }
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (hits.length >= maxHits) return;
      if (patterns.some((p) => p.test(k))) hits.push({ path: path ? `${path}.${k}` : k, key: k, type: typeOf(child) });
      walk(child, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  walk(value, "", 0);
  return hits;
}

/**
 * Find the first array of plain objects anywhere in a sample (list payloads arrive under unknown
 * wrappers — {activities:[…]}, {data:[…]}, or a bare array — and we must not hardcode a guess).
 * Breadth-first so a top-level list wins over a nested one.
 */
export function firstObjectArray(value: unknown, maxDepth = 4): Array<Record<string, unknown>> | null {
  const queue: Array<{ v: unknown; depth: number }> = [{ v: value, depth: 0 }];
  while (queue.length) {
    const { v, depth } = queue.shift()!;
    if (v == null || typeof v !== "object" || depth > maxDepth) continue;
    if (Array.isArray(v)) {
      if (v.length && v.every((x) => x != null && typeof x === "object" && !Array.isArray(x))) {
        return v as Array<Record<string, unknown>>;
      }
      continue; // an array of primitives / mixed — not a record list
    }
    for (const child of Object.values(v as Record<string, unknown>)) queue.push({ v: child, depth: depth + 1 });
  }
  return null;
}

export interface ListCoverage {
  /** Items inspected. */
  total: number;
  /** Items carrying ≥1 matched key with a NON-NULL value (a present-but-null slot is not coverage). */
  withValue: number;
  /** Distinct matched key names seen (populated or not) — the mapper's candidate field list. */
  keys: string[];
}

/**
 * Coverage of matched keys across a record list: on how many items is the field actually populated?
 * This is the live re-run of spec 08's sparsity measurement (run 20% / ride 4% / swim 0%) — after AIE's
 * durability-for-all-workouts update the run/ride numbers should jump toward the item count.
 */
export function listCoverage(items: Array<Record<string, unknown>>, patterns: RegExp[]): ListCoverage {
  const keys = new Set<string>();
  let withValue = 0;
  for (const item of items) {
    const hits = scanKeys(item, patterns, { maxDepth: 4, maxHits: 50 });
    hits.forEach((h) => keys.add(h.key));
    if (hits.some((h) => h.type !== "null")) withValue++;
  }
  return { total: items.length, withValue, keys: [...keys].sort() };
}
