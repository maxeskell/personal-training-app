import {
  latestInsightReactions,
  suppressedInsightKeys,
  type DecisionRecord,
  type InsightReaction,
} from "../state/decisionLog.js";
import type { InsightSnapshot } from "../state/insightLog.js";
import type { LoadModel } from "../insights/metrics.js";

/**
 * "What do I listen to vs ignore" — your engagement model. DETERMINISTIC, pure (no LLM, no network):
 * joins the full surfaced-insight history (state/insightLog) to your agree/disagree/ignore feedback
 * and gated-proposal decisions (state/decisionLog), then surfaces engagement and RECURRENCE patterns.
 *
 * Honest by design: it reports what you were shown, how you reacted, and which dismissed findings came
 * back anyway — it does NOT claim a causal link to performance. The form numbers are the load MODEL.
 */

const UNATTRIBUTED = "(shown before logging)";

export interface FamilyEngagement {
  family: string;
  surfaced: number; // distinct finding keys surfaced in this family
  agreed: number;
  disagreed: number;
  ignored: number;
  noReaction: number; // surfaced, never reacted to
}

export interface DismissedRecurrence {
  key: string;
  family: string;
  title: string;
  reaction: "disagree" | "ignore";
  reactedAt: string;
  recurredAt: string;
  daysLater: number;
}

export interface SuppressedNow {
  key: string;
  family: string;
  title: string;
  reaction: InsightReaction;
  daysAgo: number;
}

export interface ListeningModel {
  window: { from: string; to: string } | null; // first/last snapshot date
  snapshots: number;
  surfacedKeys: number; // distinct finding keys ever surfaced (in the log)
  reactedKeys: number; // distinct surfaced keys that got a reaction
  reactionRate: number | null; // reactedKeys / surfacedKeys (0–1)
  reactions: { agree: number; disagree: number; ignore: number }; // latest reaction per surfaced key
  feedbackBeforeLogging: number; // reacted keys we never recorded surfacing (predate the insight log)
  byFamily: FamilyEngagement[]; // surfaced-desc
  proposals: { accepted: number; declined: number; pending: number; deferred: number };
  suppressedNow: SuppressedNow[];
  recurredAfterDismissal: DismissedRecurrence[];
  form: { ctl: number; atl: number; tsb: number; rampPerWeek: number } | null;
}

interface KeyMeta {
  family: string;
  title: string;
  occurrences: string[]; // snapshot timestamps, ascending
}

const DAY_MS = 86_400_000;
function daysBetween(aIso: string, bIso: string): number {
  return Math.round((new Date(bIso).getTime() - new Date(aIso).getTime()) / DAY_MS);
}

export interface ListeningInput {
  snapshots: InsightSnapshot[];
  decisions: DecisionRecord[];
  load?: LoadModel | null;
  now?: Date;
}

export function analyseListening({ snapshots, decisions, load, now = new Date() }: ListeningInput): ListeningModel {
  // 1. Per-key surfacing history from the insight log (family/title from the most recent occurrence).
  const sorted = [...snapshots].sort((a, b) => a.ts.localeCompare(b.ts));
  const keyMeta = new Map<string, KeyMeta>();
  for (const snap of sorted) {
    for (const f of snap.findings) {
      const m = keyMeta.get(f.key) ?? { family: f.family, title: f.title, occurrences: [] };
      m.family = f.family; // last-seen wins
      m.title = f.title;
      m.occurrences.push(snap.ts);
      keyMeta.set(f.key, m);
    }
  }

  const reactions = latestInsightReactions(decisions);

  // 2. Per-family engagement over the surfaced keys.
  const families = new Map<string, FamilyEngagement>();
  const fam = (name: string): FamilyEngagement =>
    families.get(name) ?? families.set(name, { family: name, surfaced: 0, agreed: 0, disagreed: 0, ignored: 0, noReaction: 0 }).get(name)!;
  const reactionTotals = { agree: 0, disagree: 0, ignore: 0 };
  let reactedKeys = 0;
  for (const [key, meta] of keyMeta) {
    const e = fam(meta.family);
    e.surfaced += 1;
    const r = reactions.get(key)?.reaction;
    if (r === "agree") (e.agreed += 1), (reactionTotals.agree += 1), reactedKeys++;
    else if (r === "disagree") (e.disagreed += 1), (reactionTotals.disagree += 1), reactedKeys++;
    else if (r === "ignore") (e.ignored += 1), (reactionTotals.ignore += 1), reactedKeys++;
    else e.noReaction += 1;
  }
  const byFamily = [...families.values()].sort((a, b) => b.surfaced - a.surfaced || a.family.localeCompare(b.family));

  // Reactions we have on record but never logged surfacing for (feedback predates the insight log).
  let feedbackBeforeLogging = 0;
  for (const key of reactions.keys()) if (!keyMeta.has(key)) feedbackBeforeLogging++;

  // 3. Gated plan-proposal decisions (latest status per id).
  const latestById = new Map<string, DecisionRecord>();
  for (const r of decisions) if (r.kind === "plan-adjust") latestById.set(r.id, r);
  const proposals = { accepted: 0, declined: 0, pending: 0, deferred: 0 };
  for (const r of latestById.values()) {
    if (r.status === "accepted" || r.status === "executed" || r.status === "executing") proposals.accepted++;
    else if (r.status === "declined") proposals.declined++;
    else if (r.status === "deferred") proposals.deferred++;
    else if (r.status === "proposed") proposals.pending++;
  }

  // 4. Currently suppressed (your disagree/ignore inside the cool-off window).
  const suppressedSet = suppressedInsightKeys(reactions, 14, now);
  const suppressedNow: SuppressedNow[] = [...suppressedSet]
    .map((key) => {
      const meta = keyMeta.get(key);
      const r = reactions.get(key)!;
      return {
        key,
        family: meta?.family ?? UNATTRIBUTED,
        title: meta?.title ?? key,
        reaction: r.reaction,
        daysAgo: daysBetween(r.timestamp, now.toISOString()),
      };
    })
    .sort((a, b) => a.daysAgo - b.daysAgo);

  // 5. Dismissed-but-recurred: a disagree/ignore finding that the engine surfaced again afterwards —
  // i.e. the signal persisted despite your call. The honest "did ignoring it cost me?" prompt (no claim).
  const recurredAfterDismissal: DismissedRecurrence[] = [];
  for (const [key, { reaction, timestamp }] of reactions) {
    if (reaction === "agree") continue;
    const meta = keyMeta.get(key);
    if (!meta) continue;
    const after = meta.occurrences.find((ts) => ts > timestamp);
    if (!after) continue;
    recurredAfterDismissal.push({
      key,
      family: meta.family,
      title: meta.title,
      reaction,
      reactedAt: timestamp,
      recurredAt: after,
      daysLater: daysBetween(timestamp, after),
    });
  }
  recurredAfterDismissal.sort((a, b) => b.recurredAt.localeCompare(a.recurredAt));

  const surfacedKeys = keyMeta.size;
  return {
    window: sorted.length ? { from: sorted[0].ts.slice(0, 10), to: sorted[sorted.length - 1].ts.slice(0, 10) } : null,
    snapshots: sorted.length,
    surfacedKeys,
    reactedKeys,
    reactionRate: surfacedKeys ? +(reactedKeys / surfacedKeys).toFixed(2) : null,
    reactions: reactionTotals,
    feedbackBeforeLogging,
    byFamily,
    proposals,
    suppressedNow,
    recurredAfterDismissal,
    form: load ? { ctl: load.ctl, atl: load.atl, tsb: load.tsb, rampPerWeek: load.rampPerWeek } : null,
  };
}

function pct(x: number | null): string {
  return x == null ? "—" : `${Math.round(x * 100)}%`;
}

/** Render the engagement model as a markdown report (CLI prints it; also written to reports/). */
export function formatListening(m: ListeningModel, date: string): string {
  const lines: string[] = [];
  lines.push(`# What you listen to — your engagement model (${date})`);
  lines.push("");
  lines.push(
    "_Descriptive and deterministic — built from your 👍/👎/✕ feedback and the full set of insights you've " +
      "been shown. It tracks engagement and recurrence, **not** proven cause-and-effect with performance; " +
      "the form numbers are the load MODEL._",
  );
  lines.push("");

  if (!m.snapshots) {
    lines.push(
      "No surfaced insights have been logged yet. Open the dashboard (or run the MCP `insights` tool) so " +
        "the engine starts recording what it puts in front of you — then this model fills in.",
    );
    return lines.join("\n") + "\n";
  }

  lines.push(`Window: ${m.window!.from} → ${m.window!.to} · ${m.snapshots} snapshot(s) logged`);
  lines.push(
    `Insights shown: **${m.surfacedKeys}** distinct · reacted to **${m.reactedKeys}** (${pct(m.reactionRate)}) · ` +
      `${m.surfacedKeys - m.reactedKeys} never got a call`,
  );
  lines.push(`Reactions: 👍 ${m.reactions.agree} agree · 👎 ${m.reactions.disagree} disagree · ✕ ${m.reactions.ignore} ignore`);
  lines.push(
    `Plan proposals: ${m.proposals.accepted} accepted · ${m.proposals.declined} declined · ` +
      `${m.proposals.pending} pending${m.proposals.deferred ? ` · ${m.proposals.deferred} deferred` : ""}`,
  );
  if (m.feedbackBeforeLogging) {
    lines.push(`_(plus ${m.feedbackBeforeLogging} older reaction(s) from before insight-history logging began — not attributed below)_`);
  }
  lines.push("");

  lines.push("## By family — what you act on vs wave away");
  lines.push("");
  lines.push("| Family | shown | 👍 | 👎 | ✕ | no call |");
  lines.push("| --- | --: | --: | --: | --: | --: |");
  for (const f of m.byFamily) {
    lines.push(`| ${f.family} | ${f.surfaced} | ${f.agreed} | ${f.disagreed} | ${f.ignored} | ${f.noReaction} |`);
  }
  lines.push("");

  if (m.recurredAfterDismissal.length) {
    lines.push(`## Dismissed, but came back (${m.recurredAfterDismissal.length})`);
    lines.push("");
    lines.push("_Findings you disagreed with or ignored that the engine surfaced again afterwards — the signal persisted. Worth a second look._");
    lines.push("");
    for (const r of m.recurredAfterDismissal) {
      lines.push(`- **${r.family} / ${r.title}** — ${r.reaction === "ignore" ? "ignored" : "disagreed"} ${r.reactedAt.slice(0, 10)}, resurfaced ${r.daysLater}d later (${r.recurredAt.slice(0, 10)})`);
    }
    lines.push("");
  }

  if (m.suppressedNow.length) {
    lines.push("## Currently hidden — your call (~2-week cool-off)");
    lines.push("");
    for (const s of m.suppressedNow) {
      lines.push(`- **${s.family} / ${s.title}** — ${s.reaction === "ignore" ? "ignored" : "disagreed"} ${s.daysAgo}d ago`);
    }
    lines.push("");
  }

  if (m.form) {
    lines.push("## Form context (MODEL)");
    lines.push("");
    lines.push(`CTL ${m.form.ctl} · ATL ${m.form.atl} · TSB ${m.form.tsb >= 0 ? "+" : ""}${m.form.tsb} · ramp ${m.form.rampPerWeek >= 0 ? "+" : ""}${m.form.rampPerWeek}/wk`);
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}
