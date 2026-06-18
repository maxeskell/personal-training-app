import type { Finding } from "./metrics.js";

/**
 * Closes the feedback loop: insights GENERATED from the athlete's own engagement, so their reactions and
 * adherence don't just get recorded — they produce findings and reshape what surfaces. Deterministic and
 * DESCRIPTIVE (no causal claim): "you keep setting this aside but it recurs", and "you're doing X% of the
 * plan". These flow through the normal surfacing/suppression/feedback path, so each is itself dismissable.
 *
 * `EngagementContext` is the compact, IO-free hand-off built from the listening model
 * (coach/listening.ts → buildEngagementContext) and fed into buildInsights via BuildOptions.engagement.
 */

export interface EngagementContext {
  /** Per-family ranking multipliers for surfaceFindings (watch/info only; flags are exempt). */
  familyWeights?: Map<string, number>;
  /** Findings the athlete dismissed that the engine has re-surfaced repeatedly since. */
  recurringDismissed?: Array<{ key: string; family: string; title: string; times: number; reaction: "disagree" | "ignore" }>;
  /** Current plan adherence (AI Endurance plan progress) for the divergence nudge. */
  adherence?: { pct: number; priorPct: number | null; deltaPts: number | null; plannedH: number } | null;
}

const FOLLOW_THROUGH = "Follow-through";

/** Min re-surfaces (after a dismissal) before we gently re-raise a set-aside finding. */
export const RECURRING_MIN_TIMES = 2;
/** Adherence floor (doing <70% of planned) or drop (≥15 pts) that warrants a follow-through nudge. */
export const ADHERENCE_PCT_FLOOR = 0.7;
export const ADHERENCE_DROP_PTS = 15;
/** Don't nag about adherence on a trivially small plan block. */
const ADHERENCE_MIN_PLANNED_H = 2;

/** Build the engagement-derived findings (family "Follow-through"). Empty when there's nothing to say. */
export function engagementFindings(ctx: EngagementContext | undefined): Finding[] {
  if (!ctx) return [];
  const out: Finding[] = [];

  for (const r of ctx.recurringDismissed ?? []) {
    if (r.times < RECURRING_MIN_TIMES) continue;
    out.push({
      family: FOLLOW_THROUGH,
      title: `Recurring signal you've set aside: ${r.title}`,
      severity: "watch",
      detail: `You snoozed this, but it's resurfaced ${r.times}× since — the data keeps raising it.`,
      evidence: "your insight feedback vs surfaced history",
      recommendation: "Take a fresh look — if it still doesn't fit, dismiss it again; otherwise act on it.",
      confidence: 0.6,
      key: `follow-through-recurring-${r.key}`,
    });
  }

  const a = ctx.adherence;
  if (a && a.plannedH >= ADHERENCE_MIN_PLANNED_H) {
    const low = a.pct < ADHERENCE_PCT_FLOOR;
    const dropped = a.deltaPts != null && a.deltaPts <= -ADHERENCE_DROP_PTS;
    if (low || dropped) {
      const priorTxt = a.priorPct != null ? ` (was ${Math.round(a.priorPct * 100)}% ~a week ago)` : "";
      out.push({
        family: FOLLOW_THROUGH,
        title: "Plan adherence is slipping",
        severity: "watch",
        detail: `You've completed ${Math.round(a.pct * 100)}% of planned hours${priorTxt} [ai-endurance plan progress].`,
        evidence: "getPlanProgress done_sec/plan_sec",
        recommendation: "If the plan's too much right now, ease it — or ask me to propose an adjustment.",
        confidence: 0.65,
        key: "follow-through-adherence-slipping",
      });
    }
  }
  return out;
}
