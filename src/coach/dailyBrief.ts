/**
 * The daily brief — a deterministic morning "what changed + what to look at today" router for the
 * dashboard's Today tab. It makes NO LLM call: it's a VIEW over already-computed pieces (the LLM-written
 * readiness verdict from the decisions log, the deterministic metric-change diff, the surfaced insights,
 * the week-ahead weather + fuelling), so it never becomes a second source of truth and never disagrees
 * with the cards below it (the two-channel rule).
 *
 * Its one genuinely new signal is the SINCE-YESTERDAY diff: we persist a tiny `BriefSnapshot` per day
 * (see briefStore.ts) and compare today's live state against the most recent prior day's snapshot, so the
 * brief can lead with "Readiness amber → green", "New: HRV dropped", "Bike FTP 250 → 262 W" rather than
 * re-stating the same cards every morning. When nothing moved it stays short (the fuelling card's
 * "water's fine" discipline) instead of padding.
 */

import type { AthleteState } from "../state/types.js";
import type { InsightReport } from "../insights/engine.js";
import type { DecisionRecord } from "../state/decisionLog.js";
import { findingKey } from "../insights/metrics.js";
import { detectMetricChanges, type MetricChange } from "./metricChanges.js";

export type Verdict = "green" | "amber" | "red";

/**
 * The minimal salient state persisted once per day so the NEXT day's brief has a reference point to diff
 * against. Deliberately small — only the things whose change is worth surfacing day-over-day.
 */
export interface BriefSnapshot {
  /** The state date this captures (YYYY-MM-DD). */
  date: string;
  /** When it was captured (ISO) — purely informational. */
  capturedAt: string;
  /** The readiness call from that day's last readiness write-up (green/amber/red), or null if none. */
  readiness: Verdict | null;
  /** Active metric-change keys (FTP/threshold/CSS/VO₂max moves) — a new one tomorrow = "changed". */
  metricKeys: string[];
  /** Surfaced flag/watch insight keys — a new one tomorrow = a watcher spoke up. */
  insightKeys: string[];
}

/** One line in the "Since yesterday" block — a pointer with a delta, never a restatement of a card. */
export interface BriefChange {
  text: string;
  /** Up = improvement, down = worth attention, neutral = just a change. Drives the dot colour. */
  tone: "up" | "down" | "neutral";
  /** Which tab the detail lives on, so the line can route there. */
  target: "decide" | "plan";
}

/** Pull the latest readiness verdict word from the decisions log (same source the header leads on). */
export function latestReadinessVerdict(decisions: DecisionRecord[]): Verdict | null {
  const last = [...decisions].reverse().find((d) => d.kind === "readiness");
  const word = last?.summary.split(":")[0]?.trim().toLowerCase();
  return word === "green" || word === "amber" || word === "red" ? word : null;
}

/** The surfaced flag/watch findings (the ones a "new since yesterday" diff cares about), keyed stably. */
function activeInsightKeys(insights: InsightReport | undefined): string[] {
  if (!insights) return [];
  return insights.topFindings.filter((f) => f.severity === "flag" || f.severity === "watch").map((f) => findingKey(f));
}

/**
 * Build today's snapshot from the pieces already in hand on the render path — pure, no IO, no LLM. Used
 * both to diff (in the brief) and to persist (in the IO layer), so the two always agree.
 */
export function buildBriefSnapshot(args: {
  window: AthleteState[];
  insights?: InsightReport;
  decisions: DecisionRecord[];
  now?: number;
}): BriefSnapshot {
  const today = args.window[args.window.length - 1];
  const metricKeys = detectMetricChanges(args.window, { now: args.now }).map((c) => c.key);
  return {
    date: today.date,
    capturedAt: new Date(args.now ?? Date.now()).toISOString(),
    readiness: latestReadinessVerdict(args.decisions),
    metricKeys,
    insightKeys: activeInsightKeys(args.insights),
  };
}

/** Greens are good; ambers/reds want a look. Direction of a readiness move for the dot colour. */
function verdictTone(from: Verdict, to: Verdict): BriefChange["tone"] {
  const rank: Record<Verdict, number> = { red: 0, amber: 1, green: 2 };
  if (rank[to] > rank[from]) return "up";
  if (rank[to] < rank[from]) return "down";
  return "neutral";
}

/**
 * Diff today's snapshot against the most recent PRIOR-day snapshot, producing the "Since yesterday"
 * lines. Pure. Returns [] when there's no prior snapshot (the first day — nothing to compare), so the
 * brief simply shows today-at-a-glance without a misleading "everything is new" wall.
 *
 * Scope is deliberately the three robust day-over-day signals: the readiness call, newly-detected metric
 * changes, and newly-surfaced flag/watch insights. (Plan/weather flips need same-session cross-day
 * tracking and are a later iteration.)
 */
export function diffBriefSnapshots(
  prev: BriefSnapshot | null,
  curr: BriefSnapshot,
  ctx: { metricChanges: MetricChange[]; insightTitle: (key: string) => string | undefined },
): BriefChange[] {
  if (!prev) return [];
  const out: BriefChange[] = [];

  if (prev.readiness && curr.readiness && prev.readiness !== curr.readiness) {
    out.push({ text: `Readiness ${prev.readiness} → ${curr.readiness}`, tone: verdictTone(prev.readiness, curr.readiness), target: "decide" });
  }

  const prevMetrics = new Set(prev.metricKeys);
  for (const c of ctx.metricChanges) {
    if (prevMetrics.has(c.key)) continue;
    out.push({ text: `${c.label} ${c.from} → ${c.to}`, tone: "neutral", target: "decide" });
  }

  const prevInsights = new Set(prev.insightKeys);
  for (const key of curr.insightKeys) {
    if (prevInsights.has(key)) continue;
    const title = ctx.insightTitle(key);
    if (!title) continue;
    out.push({ text: `New: ${title}`, tone: "down", target: "decide" });
  }

  return out;
}
