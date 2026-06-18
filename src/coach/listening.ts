import {
  latestInsightReactions,
  suppressedInsightKeys,
  type DecisionRecord,
  type InsightReaction,
} from "../state/decisionLog.js";
import type { InsightSnapshot } from "../state/insightLog.js";
import type { LoadModel } from "../insights/metrics.js";
import type { AthleteState, PlannedSession } from "../state/types.js";
import type { EngagementContext } from "../insights/engagement.js";

/**
 * "What do I listen to vs ignore" — your engagement model. DETERMINISTIC, pure (no LLM, no network):
 * joins the full surfaced-insight history (state/insightLog) to your agree/disagree/ignore feedback and
 * gated-proposal decisions (state/decisionLog), plus your daily AthleteStates for plan ADHERENCE and
 * PLAN CHANGES. Surfaces engagement, recurrence, whether you actually do the planned work, and edits.
 *
 * Adherence DEFERS to AI Endurance's own getPlanProgress (done vs planned hours) — we trend its numbers,
 * never re-derive a competing planned-vs-actual match. Plan changes are something the platform doesn't
 * surface, so those we DO compute, by diffing consecutive daily plannedSessions snapshots.
 *
 * Honest by design: it reports what you were shown, how you reacted, which dismissed findings came back,
 * and how closely you followed the plan — it does NOT claim a causal link to performance. Form = MODEL.
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
  /** How many times the engine re-surfaced this finding AFTER the dismissal (persistence strength). */
  timesAfter: number;
}

export interface SuppressedNow {
  key: string;
  family: string;
  title: string;
  reaction: InsightReaction;
  daysAgo: number;
}

/**
 * Plan adherence — DEFERRED to AI Endurance's own plan progress (getPlanProgress done_sec/plan_sec),
 * never re-derived from a competing planned-vs-actual match. This is the authoritative "are you doing
 * the planned work" signal: a low % means skipped or shortened sessions.
 */
export interface ZoneAdherence {
  zone: string;
  plannedH: number;
  actualH: number;
  pct: number | null; // actualH / plannedH (null when nothing was planned in the zone)
}
export interface AdherenceSummary {
  asOf: string; // date of the latest snapshot carrying plan progress
  totalPlannedH: number;
  totalActualH: number;
  pct: number | null; // overall done / planned (0–1+; can exceed 1 if you did more than planned)
  byZone: ZoneAdherence[];
  /** Same metric ~a week earlier, for "is adherence slipping?" — null when there's no earlier snapshot. */
  trend: { priorPct: number | null; deltaPts: number | null } | null;
}

/** A change to the plan, detected by diffing consecutive daily plannedSessions snapshots (approximate). */
export interface PlanChangeEvent {
  at: string; // the date we first saw the change (the later snapshot's state date)
  kind: "added" | "removed" | "retimed";
  title: string;
  detail: string;
}
export interface PlanChangeSummary {
  added: number;
  removed: number; // an upcoming workout that dropped out of the plan (not one that simply passed)
  retimed: number; // same workout id, moved to a different date
  events: PlanChangeEvent[]; // most-recent-first, capped
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
  adherence: AdherenceSummary | null; // plan progress (deferred to AI Endurance)
  planChanges: PlanChangeSummary; // plan edits diffed from daily snapshots
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
  /** Trailing daily AthleteStates (any order) — for plan adherence + plan-change detection. */
  states?: AthleteState[];
  load?: LoadModel | null;
  now?: Date;
}

/** Overall done/planned from one snapshot's per-zone plan progress. */
function adherenceOf(byZone: Record<string, { actualH: number; prescribedH: number }>): {
  totalPlannedH: number;
  totalActualH: number;
  pct: number | null;
} {
  let totalPlannedH = 0;
  let totalActualH = 0;
  for (const z of Object.values(byZone)) {
    totalPlannedH += z.prescribedH;
    totalActualH += z.actualH;
  }
  return {
    totalPlannedH: +totalPlannedH.toFixed(2),
    totalActualH: +totalActualH.toFixed(2),
    pct: totalPlannedH > 0 ? +(totalActualH / totalPlannedH).toFixed(3) : null,
  };
}

/** Plan adherence from the daily states, deferring to AI Endurance's getPlanProgress numbers. */
function buildAdherence(states: AthleteState[]): AdherenceSummary | null {
  const withProgress = states
    .filter((s) => s.adherenceByZone?.value && Object.keys(s.adherenceByZone.value).length)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!withProgress.length) return null;
  const latest = withProgress[withProgress.length - 1];
  const byZoneRaw = latest.adherenceByZone.value!;
  const overall = adherenceOf(byZoneRaw);
  const byZone: ZoneAdherence[] = Object.entries(byZoneRaw).map(([zone, v]) => ({
    zone,
    plannedH: +v.prescribedH.toFixed(2),
    actualH: +v.actualH.toFixed(2),
    pct: v.prescribedH > 0 ? +(v.actualH / v.prescribedH).toFixed(3) : null,
  }));

  // Trend: the latest snapshot at least 5 days before `latest` (so it's a different plan-progress point).
  let trend: AdherenceSummary["trend"] = null;
  const prior = withProgress.filter((s) => daysBetween(s.date, latest.date) >= 5).pop();
  if (prior) {
    const priorPct = adherenceOf(prior.adherenceByZone.value!).pct;
    trend = {
      priorPct,
      deltaPts: overall.pct != null && priorPct != null ? Math.round((overall.pct - priorPct) * 100) : null,
    };
  }
  return { asOf: latest.date, ...overall, byZone, trend };
}

/** Index a state's planned sessions by their stable workout id (skipping entries without one). */
function plannedById(state: AthleteState): Map<string, PlannedSession> {
  const out = new Map<string, PlannedSession>();
  for (const w of state.plannedSessions?.value ?? []) if (w.workoutId) out.set(w.workoutId, w);
  return out;
}

/**
 * Detect plan edits by diffing consecutive daily plannedSessions snapshots, keyed on workout id.
 * Guards against window churn: a "removed" only counts when the workout was still UPCOMING as of the
 * later snapshot (so a session that simply passed / completed isn't mistaken for a deletion), and an
 * "added" only counts for a future-dated workout. Approximate — workouts without a stable id are skipped.
 */
function buildPlanChanges(states: AthleteState[]): PlanChangeSummary {
  const ordered = states
    .filter((s) => s.plannedSessions?.value != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const events: PlanChangeEvent[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = plannedById(ordered[i - 1]);
    const cur = plannedById(ordered[i]);
    const stateDate = ordered[i].date; // "today" as of the later snapshot
    for (const [id, w] of cur) {
      const before = prev.get(id);
      if (!before) {
        if (w.date >= stateDate) events.push({ at: stateDate, kind: "added", title: w.title ?? id, detail: `added for ${w.date}` });
      } else if (before.date !== w.date) {
        events.push({ at: stateDate, kind: "retimed", title: w.title ?? id, detail: `${before.date} → ${w.date}` });
      }
    }
    for (const [id, w] of prev) {
      if (!cur.has(id) && w.date >= stateDate) events.push({ at: stateDate, kind: "removed", title: w.title ?? id, detail: `was ${w.date}` });
    }
  }
  events.sort((a, b) => b.at.localeCompare(a.at));
  return {
    added: events.filter((e) => e.kind === "added").length,
    removed: events.filter((e) => e.kind === "removed").length,
    retimed: events.filter((e) => e.kind === "retimed").length,
    events: events.slice(0, 12),
  };
}

export function analyseListening({ snapshots, decisions, states = [], load, now = new Date() }: ListeningInput): ListeningModel {
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
    if (reaction !== "ignore") continue; // only snoozed items can "come back"; dislike stays visible
    const meta = keyMeta.get(key);
    if (!meta) continue;
    const afterOccurrences = meta.occurrences.filter((ts) => ts > timestamp);
    if (!afterOccurrences.length) continue;
    recurredAfterDismissal.push({
      key,
      family: meta.family,
      title: meta.title,
      reaction,
      reactedAt: timestamp,
      recurredAt: afterOccurrences[0],
      daysLater: daysBetween(timestamp, afterOccurrences[0]),
      timesAfter: afterOccurrences.length,
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
    adherence: buildAdherence(states),
    planChanges: buildPlanChanges(states),
    form: load ? { ctl: load.ctl, atl: load.atl, tsb: load.tsb, rampPerWeek: load.rampPerWeek } : null,
  };
}

/** Min surfaced + reactions in a family before its dismiss/agree rate is trusted to weight ranking. */
const FAMILY_WEIGHT_MIN_SAMPLE = 2;

/**
 * Derive the engagement hand-off fed back into buildInsights: per-family ranking weights, the
 * persistently-recurring dismissed findings, and current adherence. Weights are bounded [0.7, 1.2] and
 * only set once a family has enough feedback to trust (else the family stays at the neutral default).
 */
export function buildEngagementContext(model: ListeningModel): EngagementContext {
  const familyWeights = new Map<string, number>();
  for (const f of model.byFamily) {
    const reactions = f.agreed + f.disagreed + f.ignored;
    if (f.surfaced < FAMILY_WEIGHT_MIN_SAMPLE || reactions < FAMILY_WEIGHT_MIN_SAMPLE) continue;
    const agreeRate = f.agreed / f.surfaced;
    const dismissRate = (f.disagreed + f.ignored) / f.surfaced;
    const w = Math.max(0.7, Math.min(1.2, +(1 + 0.4 * agreeRate - 0.4 * dismissRate).toFixed(3)));
    if (w !== 1) familyWeights.set(f.family, w);
  }

  const recurringDismissed = model.recurredAfterDismissal.map((r) => ({
    key: r.key,
    family: r.family,
    title: r.title,
    times: r.timesAfter,
    reaction: r.reaction,
  }));

  const adherence =
    model.adherence && model.adherence.pct != null
      ? {
          pct: model.adherence.pct,
          priorPct: model.adherence.trend?.priorPct ?? null,
          deltaPts: model.adherence.trend?.deltaPts ?? null,
          plannedH: model.adherence.totalPlannedH,
        }
      : null;

  return { familyWeights, recurringDismissed, adherence };
}

function pct(x: number | null): string {
  return x == null ? "—" : `${Math.round(x * 100)}%`;
}

/** Hours as H:MM (repo convention: durations display h:mm, never a bare decimal). */
function hm(hours: number): string {
  const totalMin = Math.round(hours * 60);
  return `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, "0")}`;
}

function adherenceSection(a: AdherenceSummary): string[] {
  const lines: string[] = [`## Adherence to the plan (AI Endurance plan progress, as of ${a.asOf})`, ""];
  let head = `Overall: **${hm(a.totalActualH)}** done of **${hm(a.totalPlannedH)}** planned (**${pct(a.pct)}**)`;
  if (a.trend?.deltaPts != null) {
    const arrow = a.trend.deltaPts > 0 ? "▲" : a.trend.deltaPts < 0 ? "▼" : "→";
    head += ` · vs ~1wk earlier ${pct(a.trend.priorPct)} (${arrow} ${Math.abs(a.trend.deltaPts)} pts)`;
  }
  lines.push(head, "");
  lines.push("| Zone | planned | done | % |", "| --- | --: | --: | --: |");
  for (const z of a.byZone) lines.push(`| ${z.zone} | ${hm(z.plannedH)} | ${hm(z.actualH)} | ${pct(z.pct)} |`);
  lines.push("");
  return lines;
}

function planChangeSection(p: PlanChangeSummary): string[] {
  const lines = ["## Plan changes (detected from daily plan snapshots — approximate)", ""];
  const total = p.added + p.removed + p.retimed;
  if (!total) {
    lines.push("No plan changes detected in the logged window.", "");
    return lines;
  }
  lines.push(`${total} detected: ${p.added} added · ${p.retimed} moved · ${p.removed} dropped (still-upcoming)`, "");
  const verb = { added: "added", removed: "dropped", retimed: "moved" } as const;
  for (const e of p.events) lines.push(`- ${e.at} ${verb[e.kind]}: **${e.title}** (${e.detail})`);
  lines.push("");
  return lines;
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

  if (m.snapshots) {
    lines.push(`Window: ${m.window!.from} → ${m.window!.to} · ${m.snapshots} snapshot(s) logged`);
    lines.push(
      `Insights shown: **${m.surfacedKeys}** distinct · reacted to **${m.reactedKeys}** (${pct(m.reactionRate)}) · ` +
        `${m.surfacedKeys - m.reactedKeys} never got a call`,
    );
    lines.push(`Reactions: 👍 ${m.reactions.agree} agree · 👎 ${m.reactions.disagree} disagree · ✕ ${m.reactions.ignore} ignore`);
  } else {
    lines.push(
      "No surfaced insights have been logged yet — the engagement breakdown fills in once the engine surfaces " +
        "findings (open the dashboard or run the MCP `insights` tool). Adherence and plan changes below still " +
        "come from your daily data.",
    );
  }
  const propTotal = m.proposals.accepted + m.proposals.declined + m.proposals.pending + m.proposals.deferred;
  if (propTotal) {
    lines.push(
      `Plan proposals: ${m.proposals.accepted} accepted · ${m.proposals.declined} declined · ` +
        `${m.proposals.pending} pending${m.proposals.deferred ? ` · ${m.proposals.deferred} deferred` : ""}`,
    );
  }
  if (m.feedbackBeforeLogging) {
    lines.push(`_(plus ${m.feedbackBeforeLogging} older reaction(s) from before insight-history logging began — not attributed below)_`);
  }
  lines.push("");

  if (m.adherence) lines.push(...adherenceSection(m.adherence));
  else lines.push("## Adherence to the plan", "", "_No AI Endurance plan-progress data in the logged window._", "");
  lines.push(...planChangeSection(m.planChanges));

  if (m.byFamily.length) {
    lines.push("## By family — what you act on vs wave away");
    lines.push("");
    lines.push("| Family | shown | 👍 | 👎 | ✕ | no call |");
    lines.push("| --- | --: | --: | --: | --: | --: |");
    for (const f of m.byFamily) {
      lines.push(`| ${f.family} | ${f.surfaced} | ${f.agreed} | ${f.disagreed} | ${f.ignored} | ${f.noReaction} |`);
    }
    lines.push("");
  }

  if (m.recurredAfterDismissal.length) {
    lines.push(`## Dismissed, but came back (${m.recurredAfterDismissal.length})`);
    lines.push("");
    lines.push("_Findings you snoozed that the engine surfaced again after the cool-off — the signal persisted. Worth a second look._");
    lines.push("");
    for (const r of m.recurredAfterDismissal) {
      lines.push(`- **${r.family} / ${r.title}** — snoozed ${r.reactedAt.slice(0, 10)}, resurfaced ${r.daysLater}d later (${r.recurredAt.slice(0, 10)})`);
    }
    lines.push("");
  }

  if (m.suppressedNow.length) {
    lines.push("## Snoozed — hidden until the cool-off ends (~2 weeks)");
    lines.push("");
    for (const s of m.suppressedNow) {
      lines.push(`- **${s.family} / ${s.title}** — snoozed ${s.daysAgo}d ago`);
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
