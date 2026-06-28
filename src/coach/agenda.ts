import type { SetupItem, SetupGroup } from "./setupCard.js";
import type { SurfacedFinding } from "../state/insightLog.js";
import type { InsightReaction, CoachDiscussion } from "../state/decisionLog.js";

/**
 * The coaching AGENDA — the exact items the dashboard surfaces on its "This week" and "Set up & improve"
 * cards, flattened into a structured list a coach (in Claude Code) can walk through with the athlete:
 * confirm → discuss → record the outcome. It is the READ half of the coach↔dashboard loop — both surfaces
 * read the same items from the same builders, so the coach talks about exactly what the athlete sees.
 *
 * Pure + deterministic (no LLM, no IO): the MCP `agenda` tool assembles the inputs (setup items, coach
 * recommendations, current reactions) exactly as the dashboard does, then calls `buildAgenda` to annotate
 * each item with its current decision-log state. Recording an outcome is the WRITE half (`react_to_insight`).
 */

export type AgendaGroup = SetupGroup | "coach_rec";

export interface AgendaItem {
  /** Stable decision-log key (`setup:*` or an advice `key`) — the SAME key the dashboard reacts under. */
  key: string;
  /** Which card section it sits in. "coach_rec" = the readiness/deep-dive recommendations atop "This week". */
  group: AgendaGroup;
  /** Short title / the action headline. */
  label: string;
  /** One line on why it matters (may be empty for a free-text open item). */
  why: string;
  /** Concrete "how to do it" — the action the athlete would take. */
  action: string;
  /** Producer tag (setup source, or "advice" for a coach recommendation). */
  source: string;
  /** Current persisted reaction for this key, if any (agree/disagree/ignore/done/dismiss/applied). */
  reaction?: InsightReaction;
  /** A gated plan-change has been confirmed+executed for this key. */
  applied?: boolean;
  /** Offers a gated "Make this change" (training-plan edit). */
  applyable?: boolean;
  /** Takes 👍/👎/💤 reactions (vs a dismiss-only setup task). */
  reactable?: boolean;
  /** Finding family (for a marginal-gain / coach-rec card) — carried so a reaction weights by family. */
  family?: string;
  /** This item's latest reaction was recorded as a coach DISCUSSION (via Claude Code), not a bare click. */
  discussed?: boolean;
  /** The one-line note captured when the item was discussed with the athlete (the why behind the call). */
  note?: string;
}

export interface Agenda {
  items: AgendaItem[];
  /** Count of items the athlete has not yet acted on (no reaction, not applied) — the "open" agenda. */
  openCount: number;
}

/** Group display order + headings — coach recommendations and timely cues first, housekeeping last. */
const GROUP_ORDER: AgendaGroup[] = ["coach_rec", "this_week", "finish_setup", "worth_considering"];
const GROUP_HEADING: Record<AgendaGroup, string> = {
  coach_rec: "Coach recommendations (from your latest readiness / deep-dive)",
  this_week: "This week — coaching cues",
  finish_setup: "Set up & improve — finish setup",
  worth_considering: "Set up & improve — worth considering",
};

/** True when the athlete hasn't acted on an item yet (no opinion logged, no gated change applied). */
function isOpen(it: AgendaItem): boolean {
  return !it.applied && (it.reaction == null || it.reaction === "clear");
}

/**
 * Build the structured agenda from the same inputs the dashboard renders: the setup items, the coach
 * recommendations (latest readiness/deep-dive advice), and the current reaction + applied state per key.
 */
export function buildAgenda(
  setupItems: SetupItem[],
  coachRecs: SurfacedFinding[],
  reactions: Map<string, InsightReaction>,
  appliedKeys: Set<string>,
  discussions?: Map<string, CoachDiscussion>,
): Agenda {
  const items: AgendaItem[] = [];

  for (const rec of coachRecs) {
    const d = discussions?.get(rec.key);
    items.push({
      key: rec.key,
      group: "coach_rec",
      label: rec.title,
      why: rec.detail,
      action: rec.recommendation ?? "",
      source: "advice",
      reaction: reactions.get(rec.key) ?? d?.reaction,
      applied: appliedKeys.has(rec.key),
      reactable: true,
      family: rec.family,
      discussed: d != null,
      note: d?.note,
    });
  }

  for (const it of setupItems) {
    const d = discussions?.get(it.key);
    items.push({
      key: it.key,
      group: it.group,
      label: it.label,
      why: it.why,
      action: it.action,
      source: it.source,
      reaction: reactions.get(it.key) ?? d?.reaction,
      applied: appliedKeys.has(it.key),
      applyable: it.applyable,
      reactable: it.reactable,
      family: it.family,
      discussed: d != null,
      note: d?.note,
    });
  }

  // Stable order: by group, then open items before acted-on ones, preserving builder priority within.
  const order = (g: AgendaGroup) => GROUP_ORDER.indexOf(g);
  items.sort((a, b) => order(a.group) - order(b.group) || Number(isOpen(b)) - Number(isOpen(a)));

  return { items, openCount: items.filter(isOpen).length };
}

/** Emoji chip label (a bare dashboard reaction) and the plain outcome word (a coach discussion) per reaction. */
const REACTION_CHIP: Record<string, string> = { agree: "👍 agreed", disagree: "👎 disagreed", ignore: "💤 snoozed", done: "✓ done", dismiss: "🚫 ignored" };
const REACTION_WORD: Record<string, string> = { agree: "agreed", disagree: "disagreed", ignore: "snoozed", done: "done", dismiss: "ignored" };

/** One-line human label for an item's current state. */
function stateLabel(it: AgendaItem): string {
  if (it.applied) return "✓ applied to AI Endurance";
  if (!it.reaction || !(it.reaction in REACTION_WORD)) return "— open (not yet discussed)";
  // A call reached WITH the coach (in chat) reads as a discussion; a bare dashboard click keeps its chip.
  return it.discussed ? `✓ discussed with coach — ${REACTION_WORD[it.reaction]}` : REACTION_CHIP[it.reaction];
}

/**
 * Render the agenda as text for the coach to read and walk through. Groups in display order; each item
 * shows its key (so an outcome can be recorded against it), state, why and the concrete action.
 */
export function formatAgendaText(agenda: Agenda): string {
  if (!agenda.items.length) return "Nothing on the agenda — no open cues or setup items. You're clear.";
  const out: string[] = [
    `Coaching agenda — ${agenda.items.length} item(s), ${agenda.openCount} not yet discussed.`,
    "Walk these with the athlete; record each outcome with `react_to_insight` (key=… + like/dislike/snooze/clear).",
  ];
  for (const group of GROUP_ORDER) {
    const inGroup = agenda.items.filter((it) => it.group === group);
    if (!inGroup.length) continue;
    out.push("", `## ${GROUP_HEADING[group]}`);
    for (const it of inGroup) {
      const flags = [it.applyable ? "gated plan-change available" : "", it.reactable ? "reactable" : ""].filter(Boolean).join(", ");
      out.push(
        `- [${stateLabel(it)}] ${it.label}  (key=${it.key}${flags ? ` · ${flags}` : ""})`,
        it.note ? `    note: ${it.note}` : "",
        it.why ? `    why: ${it.why}` : "",
        it.action ? `    how: ${it.action}` : "",
      );
    }
  }
  return out.filter((l) => l !== "").join("\n");
}
