import type { Finding } from "../insights/metrics.js";
import type { SurfacedFinding, InsightSnapshot } from "../state/insightLog.js";
import type { InsightReaction } from "../state/decisionLog.js";
import { escapeHtml } from "./dashboardHelpers.js";

/**
 * Make the LLM prose flows' advice individually reactable (item 4-iii). The readiness verdict and the
 * deep-dive write-up each emit a small, FAMILY-TAGGED list of concrete recommendations alongside their
 * prose; we map those to info-severity Findings and log them to the insight log (surfaces "readiness" /
 * "deep-dive"). That makes each one a first-class, keyed insight — reactable on the dashboard (the
 * "Coach's recommendations" card) and via the MCP `react_to_insight`/`retrospect` tools, first-seen
 * tracked, and (because it carries a family) fed into the engagement weights exactly like any finding.
 *
 * The family the model tags drives the engagement weighting, so it's constrained to the real insight
 * taxonomy — an off-list family falls back to "General" (still keyed + reactable, just not weighted).
 */

export interface AdviceRec {
  text: string;
  family: string;
}

export type AdviceSource = "readiness" | "deep-dive" | "ask";

/** Insight-log surfaces that carry reactable advice recommendations (read back onto the dashboard card). */
export const ADVICE_SURFACES = new Set<string>(["readiness", "deep-dive", "ask"]);

/** The insight families a recommendation may be tagged with (the schema enum + the weighting target). */
export const ADVICE_FAMILIES = [
  "Load & form",
  "Aerobic efficiency",
  "Durability",
  "Fuelling & body comp",
  "Recovery (HRV status)",
  "Illness early-warning",
  "Load & injury risk",
  "Goal tracking",
  "Pacing & execution",
  "Gear",
  "Heat",
  "General",
] as const;

const ADVICE_FAMILY_SET = new Set<string>(ADVICE_FAMILIES);

/** JSON-schema fragment for the structured `recommendations` array (shared by the readiness + deep-dive calls). */
export const ADVICE_RECS_SCHEMA = {
  type: "array",
  maxItems: 4,
  description:
    "The FEWEST genuinely distinct, actionable recommendations the write-up supports (0–4) — each a single " +
    "self-contained imperative line, tagged with the insight family it belongs to. Merge anything that is the " +
    "same underlying action into one line, lead with the most important, and prefer ONE strong recommendation " +
    "over restating the same point several ways. Omit entirely if nothing is genuinely actionable.",
  items: {
    type: "object",
    properties: {
      text: { type: "string", description: "One specific, actionable recommendation in the imperative." },
      family: { type: "string", enum: [...ADVICE_FAMILIES], description: "The insight family this belongs to." },
    },
    required: ["text", "family"],
    additionalProperties: false,
  },
} as const;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "rec";
}

const SOURCE_LABEL: Record<AdviceSource, string> = { readiness: "readiness", "deep-dive": "deep dive", ask: "ask" };

/** The provenance sub-heading each advice source gets on the card, so a coherent stance reads as one
 *  group rather than several independent nags. */
const ADVICE_SOURCE_HEADING: Record<AdviceSource, string> = {
  readiness: "From today's readiness check",
  "deep-dive": "From your latest deep dive",
  ask: "From your recent question",
};

/** Fixed display order — most timely source first (today's readiness), then the durable lenses. */
const ADVICE_SOURCE_ORDER: AdviceSource[] = ["readiness", "deep-dive", "ask"];

/** Parse the advice source back out of a key (`advice:<source>:<slug>`). Null for a non-advice/garbled key. */
export function adviceSourceOfKey(key: string): AdviceSource | null {
  const m = /^advice:(readiness|deep-dive|ask):/.exec(key);
  return m ? (m[1] as AdviceSource) : null;
}

/**
 * Map an LLM-tagged recommendation list to keyed, family-tagged Findings (`advice:<source>:<slug>`),
 * deduped and trimmed. Pure — the deterministic core, unit-tested. An empty/garbled list yields [].
 */
export function recsToFindings(recs: AdviceRec[] | undefined, source: AdviceSource): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const r of recs ?? []) {
    const text = typeof r?.text === "string" ? r.text.trim() : "";
    if (!text) continue;
    const familyRaw = typeof r?.family === "string" ? r.family.trim() : "";
    const family = ADVICE_FAMILY_SET.has(familyRaw) ? familyRaw : "General";
    const key = `advice:${source}:${slug(text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      family,
      title: text,
      severity: "info",
      detail: text,
      evidence: `${SOURCE_LABEL[source]} — coach recommendation`,
      confidence: 0.6,
      key,
    });
  }
  return out;
}

/**
 * The current advice recommendations to show on the dashboard: the findings from the LATEST snapshot of
 * each advice surface, merged, deduped by key, with suppressed (snoozed/dismissed/done) keys dropped.
 * Pure — testable. Reads the same insight log the engagement model does.
 */
export function latestAdviceFindings(snapshots: InsightSnapshot[], suppressed: Set<string> = new Set()): SurfacedFinding[] {
  const latestBySurface = new Map<string, SurfacedFinding[]>();
  for (const s of [...snapshots].sort((a, b) => a.ts.localeCompare(b.ts))) {
    if (ADVICE_SURFACES.has(s.surface)) latestBySurface.set(s.surface, s.findings);
  }
  const out: SurfacedFinding[] = [];
  const seen = new Set<string>();
  for (const findings of latestBySurface.values()) {
    for (const f of findings) {
      if (seen.has(f.key) || suppressed.has(f.key)) continue;
      seen.add(f.key);
      out.push(f);
    }
  }
  return out;
}

/** One reactable advice card — same `.insight` shape + handlers as the "This week" cards (so it reuses the
 *  feedback()/ignoreCard() JS, carries data-family for weighting, and is retrospect-able by key). */
function adviceCardHtml(f: SurfacedFinding, reactions?: Map<string, InsightReaction>): string {
  const saved = reactions?.get(f.key);
  const state = saved === "agree" ? "like" : saved === "disagree" ? "dislike" : "";
  const on = (which: string) => (state === which ? " on" : "");
  const reacted = state === "like" ? "👍 agreed" : state === "dislike" ? "👎 disagreed (still shown)" : "";
  const familyAttr = f.family ? ` data-family="${escapeHtml(f.family)}"` : "";
  return `<div class="insight" data-key="${escapeHtml(f.key)}" data-summary="${escapeHtml(f.title)}" data-reaction-state="${state}"${familyAttr}>
    <div><b>${escapeHtml(f.title)}</b></div>
    <div class="acts">
      <button class="agree${on("like")}" data-reaction="like" onclick="feedback(this)">👍 Agree</button>
      <button class="disagree${on("dislike")}" data-reaction="dislike" onclick="feedback(this)">👎 Disagree</button>
      <button class="ignore" data-reaction="snooze" onclick="feedback(this)">💤 Snooze</button>
      <button class="ignore" title="Ignore this advice — don't show it again" onclick="ignoreCard(this)">🚫 Ignore</button>
      <span class="reacted">${reacted}</span>
    </div>
  </div>`;
}

/** Group the (already deduped + ordered) advice findings by their source, in a fixed most-timely-first
 *  order. Pure — testable. A finding whose key doesn't name a known source falls into a trailing,
 *  header-less group rather than being dropped. */
export function groupAdviceBySource(
  recs: SurfacedFinding[],
): Array<{ source: AdviceSource | null; heading: string | null; items: SurfacedFinding[] }> {
  const bySource = new Map<AdviceSource, SurfacedFinding[]>();
  const other: SurfacedFinding[] = [];
  for (const f of recs) {
    const src = adviceSourceOfKey(f.key);
    if (src) {
      const bucket = bySource.get(src) ?? [];
      bucket.push(f);
      bySource.set(src, bucket);
    } else {
      other.push(f);
    }
  }
  const groups: Array<{ source: AdviceSource | null; heading: string | null; items: SurfacedFinding[] }> = [];
  for (const src of ADVICE_SOURCE_ORDER) {
    const items = bySource.get(src);
    if (items?.length) groups.push({ source: src, heading: ADVICE_SOURCE_HEADING[src], items });
  }
  if (other.length) groups.push({ source: null, heading: null, items: other });
  return groups;
}

/** The "Coach's recommendations" dashboard card — reactable action points pulled from the latest readiness,
 *  deep-dive and ask write-ups, GROUPED by where each came from (so one coherent stance reads as one group,
 *  not several near-identical nags). Deterministic, no LLM. Hidden in share mode and when there's nothing. */
export function renderCoachRecs(recs: SurfacedFinding[], reactions?: Map<string, InsightReaction>, share = false): string {
  if (share || !recs.length) return "";
  const groupsHtml = groupAdviceBySource(recs)
    .map(
      (g) =>
        `${g.heading ? `<div class="setup-group">${escapeHtml(g.heading)}</div>` : ""}${g.items
          .map((f) => adviceCardHtml(f, reactions))
          .join("")}`,
    )
    .join("");
  return `<div class="card"><h2>Coach's recommendations</h2>
  <div class="k" style="margin-bottom:6px">Action points distilled from your latest <b>readiness</b>, <b>deep-dive</b> and <b>ask</b> write-ups, grouped by where they came from — react to shape what the coach surfaces next: 👍 lifts that family · 👎 down-ranks it · 💤 snooze ~2 weeks · 🚫 ignore for good. Each is recorded by key, so you can also <code>retrospect</code> on how it held up.</div>
  <div class="setup">${groupsHtml}</div></div>`;
}
