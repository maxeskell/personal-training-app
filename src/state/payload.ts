/**
 * Pure helpers for unwrapping and reading MCP / AI Endurance / Garmin tool payloads. Extracted from
 * assemble.ts so the envelope-unwrapping + generic accessors — the real parsing-risk surface — live in
 * one small, directly-tested module, leaving assemble.ts as the orchestration/mapping layer.
 */

/** Pull JSON out of an MCP CallToolResult (prefers structuredContent). */
export function extractJson(result: unknown): unknown {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (r.structuredContent !== undefined) return r.structuredContent;
    if (Array.isArray(r.content)) {
      const text = r.content
        .filter((c): c is { type: string; text: string } =>
          Boolean(c && typeof c === "object" && (c as { type?: unknown }).type === "text"),
        )
        .map((c) => c.text)
        .join("\n");
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
  return result;
}

export function asNumber(x: unknown): number | undefined {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x))) return Number(x);
  return undefined;
}

/** Last finite element of a numeric time-series array (AIE returns 60-day series). */
export function lastNum(arr: unknown): number | undefined {
  if (!Array.isArray(arr)) return undefined;
  for (let i = arr.length - 1; i >= 0; i--) {
    const n = asNumber(arr[i]);
    if (n !== undefined) return n;
  }
  return undefined;
}

/** Last non-empty element of an array (e.g. the "driving_recovery" string series). */
export function lastVal(arr: unknown): unknown {
  if (!Array.isArray(arr)) return undefined;
  return arr.length ? arr[arr.length - 1] : undefined;
}

/** Last element of an array, else the value itself (Garmin returns arrays or scalars). */
export function lastEl(v: unknown): unknown {
  return Array.isArray(v) ? (v.length ? v[v.length - 1] : undefined) : v;
}

/** ISO date `n` days before `date` (YYYY-MM-DD), via UTC to avoid TZ drift. */
export function daysAgoIso(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Garmin (Taxuspt) wraps tool output as `{result: "<json string>"}` inside the
 * MCP content. extractJson() unwraps the MCP envelope; this unwraps the inner
 * `result` JSON string. Returns null on any miss so callers degrade cleanly.
 */
export function garminInner(toolResult: unknown): unknown {
  if (toolResult === null || toolResult === undefined) return null;
  const obj = extractJson(toolResult);
  const inner =
    obj && typeof obj === "object" && "result" in (obj as Record<string, unknown>)
      ? (obj as Record<string, unknown>).result
      : obj;
  if (typeof inner === "string") {
    try {
      return JSON.parse(inner);
    } catch {
      return inner; // e.g. "No weight measurements found for …"
    }
  }
  return inner;
}

/** Walk a nested object by keys, returning undefined on any missing link. */
export function get(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return cur;
}
