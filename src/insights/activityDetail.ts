/**
 * Per-session durability from AIE's Detail tools (the 2026-08 "durability for all workouts" rollout,
 * live since MCP v1.1/1.2 on 2026-08-25 — spec 10). Two measurements, deliberately kept distinct:
 *
 *  - `within` (external, mechanical): sustained power / GAP pace fading along the session's OWN
 *    accumulated-work axis (kJ for rides, km for runs) vs its fresh state. Needs no HRV — present on
 *    nearly every ride and run.
 *  - `drift` (internal): this session's HR / DFA-α1 / respiration drift vs the athlete's own fitted
 *    ~multi-week trend at matched work (mean residual, band position, trend %-loss at work anchors,
 *    and the n of sessions behind the fit). Needs clean R-R — sparse, like the old durability %.
 *
 * This module is PURE (mapper + text builders, fixture-testable). The live fetcher — which owns the
 * AIE connection — lives in `coach/sessionDurability.ts`. Payload shapes are mapped defensively from
 * the 2026-08-25 Mac probe: anything unrecognised degrades to null/absent, never throws.
 */

export interface FadeWindowRead {
  /** Rolling-window label the fade is measured on, e.g. "5min", "20min". */
  window: string;
  fadePctTotal: number | null;
  /** Fresh-state reference, human-readable ("414 W", "4:59"). */
  fresh: string | null;
}

export interface WithinFamilyRead {
  /** "power" | "pace" (GAP) — which signal is fading. */
  metric: string;
  /** The session's own accumulated-work axis: "kj" (rides) or "km" (runs). */
  axis: string | null;
  windows: FadeWindowRead[];
}

export interface DriftMetricRead {
  /** "hr" | "a1" | "rf" — the internal signal measured against the trend. */
  metric: string;
  nPoints: number | null;
  meanResidual: number | null;
  bandLabel: string | null;
  inBand: number | null;
  above: number | null;
  below: number | null;
  /** How many sessions the fitted trend rests on — the weight to give this read. */
  trendN: number | null;
  pctLossAtAnchors: Array<{ anchor: string; pct: number }>;
}

export interface ActivityDurability {
  within: WithinFamilyRead[];
  drift: { axis: string | null; metrics: DriftMetricRead[] } | null;
  /** % of recent best at the headline curve anchors (from the same Detail payload). */
  recentBest: Array<{ anchor: string; pct: number }>;
  referenceDays: number | null;
  referenceCount: number | null;
}

/** Injected into the session flow so tests stay hermetic — the live impl is `aieDurabilityFetcher()`. */
export type DurabilityFetcher = (sport: "Run" | "Ride" | "Swim", id: number) => Promise<ActivityDurability | null>;

function num(x: unknown): number | null {
  const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
}
function str(x: unknown): string | null {
  return typeof x === "string" && x.trim() ? x : null;
}
function obj(x: unknown): Record<string, unknown> | null {
  return x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function mapFadeSeries(fs: Record<string, unknown>): FadeWindowRead[] {
  const out: FadeWindowRead[] = [];
  for (const [window, v] of Object.entries(fs)) {
    const w = obj(v);
    if (!w) continue;
    const freshNum = num(w.fresh);
    out.push({
      window,
      fadePctTotal: num(w.fade_percent_total),
      fresh: freshNum != null ? `${Math.round(freshNum)} W` : str(w.fresh_pace) ?? str(w.fresh),
    });
  }
  return out;
}

/** One within-session family node: `{ axis, fade_series }`. Metric name from the family key / signal type. */
function mapWithinFamily(metric: string, node: Record<string, unknown>): WithinFamilyRead | null {
  const fs = obj(node.fade_series);
  if (!fs) return null;
  const windows = mapFadeSeries(fs);
  return windows.length ? { metric, axis: str(node.axis), windows } : null;
}

function mapDriftMetric(metric: string, node: Record<string, unknown>): DriftMetricRead {
  const band = obj(node.band_position);
  const anchors: Array<{ anchor: string; pct: number }> = [];
  for (const [anchor, v] of Object.entries(obj(node.trend_pct_loss_at_anchors) ?? {})) {
    const pct = num(v);
    if (pct != null) anchors.push({ anchor, pct });
  }
  return {
    metric,
    nPoints: num(node.n_points),
    meanResidual: num(node.mean_residual_vs_trend),
    bandLabel: band ? str(band.label) : null,
    inBand: band ? num(band.in_band) : null,
    above: band ? num(band.above) : null,
    below: band ? num(band.below) : null,
    trendN: num(node.trend_ride_count) ?? num(node.trend_run_count) ?? num(node.trend_activity_count) ?? num(node.trend_count),
    pctLossAtAnchors: anchors,
  };
}

/**
 * Map a raw `get*ActivityDetail` payload (with `with_power_curve` / `with_dfa_alpha1`) into the compact
 * durability read. Handles both observed shapes: a ride's single `{axis, fade_series}` family and a
 * run's keyed families `{gap: {...}, power: {...}}`. Returns null when the payload carries neither
 * measurement (e.g. the pre-rollout bare `{}`).
 */
export function mapActivityDurability(raw: unknown): ActivityDurability | null {
  const root = obj(raw);
  if (!root) return null;

  const within: WithinFamilyRead[] = [];
  const wsd = obj(root.within_session_durability);
  if (wsd) {
    if (wsd.fade_series != null) {
      // Single-family shape (rides): the signal is power; fresh values are watts.
      const fam = mapWithinFamily("power", wsd);
      if (fam) within.push(fam);
    } else {
      // Keyed-family shape (runs): `gap` (pace) and/or `power`.
      for (const [key, v] of Object.entries(wsd)) {
        const node = obj(v);
        if (!node) continue;
        const fam = mapWithinFamily(key === "gap" ? "pace" : key, node);
        if (fam) within.push(fam);
      }
    }
  }

  let drift: ActivityDurability["drift"] = null;
  const dd = obj(root.durability_drift);
  if (dd) {
    const metrics = Object.entries(obj(dd.metrics) ?? {})
      .map(([k, v]) => (obj(v) ? mapDriftMetric(k, obj(v)!) : null))
      .filter((m): m is DriftMetricRead => m != null);
    if (metrics.length) drift = { axis: str(dd.axis), metrics };
  }

  const recentBest: Array<{ anchor: string; pct: number }> = [];
  for (const anchor of ["5min", "20min"] as const) {
    const pct = num(obj(root.pct_of_recent_best)?.[anchor]);
    if (pct != null) recentBest.push({ anchor, pct });
  }
  const ref = obj(root.reference_window);

  if (!within.length && !drift) return null;
  return {
    within,
    drift,
    recentBest,
    referenceDays: ref ? num(ref.days) : null,
    referenceCount: ref ? num(ref.activity_count) : null,
  };
}

const r1 = (n: number | null): string => (n == null ? "—" : (Math.round(n * 10) / 10).toString());

/** Context lines for the session-readout LLM — labelled MODEL, both measurements kept distinct. */
export function durabilityContextLines(d: ActivityDurability): string[] {
  const lines: string[] = ["AIE PER-SESSION DURABILITY [ai-endurance — MODEL; two distinct measurements]:"];
  if (d.within.length) {
    const fams = d.within.map((f) => {
      const w = f.windows.map((x) => `${x.window} faded ${r1(x.fadePctTotal)}%${x.fresh ? ` from fresh ${x.fresh}` : ""}`).join(", ");
      return `${f.metric}: ${w}${f.axis ? ` (along the session's ${f.axis} axis)` : ""}`;
    });
    lines.push(`- Within-session fade (mechanical, vs THIS session's own fresh state): ${fams.join("; ")}`);
  }
  if (d.drift) {
    const ms = d.drift.metrics.map((m) => {
      const band = m.bandLabel ? `${m.bandLabel}${m.inBand != null ? ` (${m.inBand} in / ${m.above ?? 0} above / ${m.below ?? 0} below band)` : ""}` : "band —";
      const loss = m.pctLossAtAnchors.length ? `, trend loses ${m.pctLossAtAnchors.map((a) => `${r1(a.pct)}% by ${a.anchor}${d.drift!.axis ?? ""}`).join(" / ")}` : "";
      return `${m.metric}: residual ${r1(m.meanResidual)} vs your ${m.trendN ?? "?"}-session trend, ${band}${loss}`;
    });
    lines.push(`- Internal drift vs your own fitted trend (needs clean R-R — weight by trend size): ${ms.join("; ")}`);
  } else {
    lines.push(`- Internal drift vs trend: not computed for this session (needs clean R-R + enough trend history) — normal, not a data gap.`);
  }
  if (d.recentBest.length) {
    const ref = d.referenceDays != null ? ` (reference: last ${d.referenceDays}d${d.referenceCount != null ? `, ${d.referenceCount} activities` : ""})` : "";
    lines.push(`- vs recent best: ${d.recentBest.map((b) => `${b.anchor} at ${r1(b.pct)}%`).join(", ")}${ref}`);
  }
  lines.push(`- Read fade against session intent: intervals or a hard finish fade by design — judge vs the plan, not vs zero.`);
  return lines;
}

/** One compact plain-text line for the dashboard's Last-session card (caller escapes for HTML). */
export function durabilityCardLine(d: ActivityDurability): string {
  const bits: string[] = [];
  for (const f of d.within) {
    const w = f.windows[0];
    if (w?.fadePctTotal != null) bits.push(`${f.metric} fade ${r1(w.fadePctTotal)}% (${w.window})`);
  }
  if (d.drift) {
    const ms = d.drift.metrics.filter((m) => m.bandLabel).map((m) => `${m.metric} ${String(m.bandLabel).replace(/_/g, " ")}`);
    if (ms.length) bits.push(`drift vs trend: ${ms.join(", ")}`);
  }
  return bits.join(" · ");
}
