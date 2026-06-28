/**
 * The Sunday weekly brief — the strategic sibling of the daily Today brief. Where the daily brief diffs
 * today's live state against yesterday's snapshot, the weekly brief diffs the just-completed training week
 * against the week before it: load by sport, fitness (CTL), form (TSB) and zone-adherence. Like the daily
 * brief it makes NO LLM call — it's a deterministic VIEW over two frozen snapshots, rendered as one terse
 * line that sits above the (already-generated) cohesive weekly review on the Plan tab.
 *
 * Two completed weeks, not live-vs-snapshot: the review analyses the week that just ended, so the delta must
 * compare the SAME two weeks (frozen Sunday snapshots), never a half-finished current week. The snapshot is
 * captured once on the Sunday cadence (see cli `runWeeklyBrief`); the render path only READS the two latest
 * and diffs them, degrading to a "building history" note until there are two to compare.
 */

import type { AthleteState } from "../state/types.js";
import type { InsightReport } from "../insights/engine.js";
import type { DecisionRecord } from "../state/decisionLog.js";
import { weeklyAggregates } from "./weekly.js";
import { escapeHtml } from "../util/html.js";

/**
 * The minimal weekly aggregates frozen once per week so the NEXT week's brief has a reference point to diff
 * against. Keyed by the Monday that starts the week (athlete-TZ calendar date). Deliberately small — only the
 * four families the athlete confirmed: by-sport load, fitness (CTL), form (TSB), zone-adherence.
 */
export interface WeeklySnapshot {
  /** Monday (YYYY-MM-DD, athlete TZ) that starts the week this captures. */
  weekStart: string;
  /** When it was captured (ISO) — purely informational. */
  capturedAt: string;
  /** Completed load by sport over the week, in whole minutes. */
  bySportMin: Record<string, number>;
  /** Fitness (CTL) at capture, or null when the load model is unavailable. */
  ctl: number | null;
  /** Form (TSB) at capture, or null when the load model is unavailable. */
  tsb: number | null;
  /** Zone-adherence as % of prescribed (null per-zone when nothing was prescribed). */
  adherencePct: Record<string, number | null>;
}

/** The structured week-over-week delta — pure data, rendered terse by {@link renderWeeklyBriefDelta}. */
export interface WeeklyDelta {
  fromWeek: string;
  toWeek: string;
  bySport: Array<{ sport: string; from: number; to: number; deltaMin: number }>;
  ctl: { from: number; to: number; delta: number } | null;
  tsb: { from: number; to: number; delta: number } | null;
  adherence: Array<{ zone: string; from: number | null; to: number | null }>;
}

/** Min absolute minute-change for a sport to earn a slot on the terse one-liner (filters noise). */
export const SPORT_DELTA_MIN_MINUTES = 10;
/** The base-endurance zone we surface adherence for (labelled "Z2"); other zones stay in the full review. */
const ENDURANCE_ZONE = "Endurance";

/**
 * Build this week's snapshot from the pieces already in hand — pure, no IO, no LLM. CTL/TSB come from the
 * insight engine's load model (the same source the proposer + headline read), so the brief never invents a
 * second fitness number. Used both to persist (Sunday job) and — via the diff — to render.
 */
export function buildWeeklySnapshot(args: { window: AthleteState[]; insights?: InsightReport; now?: number }): WeeklySnapshot {
  const today = args.window[args.window.length - 1];
  const agg = weeklyAggregates(args.window);
  const bySportMin: Record<string, number> = {};
  for (const [sport, e] of Object.entries(agg.bySport)) bySportMin[sport] = Math.round(e.min);
  const adherencePct: Record<string, number | null> = {};
  for (const [zone, v] of Object.entries(agg.adherence)) adherencePct[zone] = v.pct;
  return {
    weekStart: mondayOf(today.date),
    capturedAt: new Date(args.now ?? Date.now()).toISOString(),
    bySportMin,
    ctl: args.insights?.load?.ctl ?? null,
    tsb: args.insights?.load?.tsb ?? null,
    adherencePct,
  };
}

/**
 * Diff the prior week's snapshot against the most recent one, producing the structured delta. Pure. Returns
 * null when there's no prior week to compare (the first weekly snapshot — nothing to diff), so the brief shows
 * a "building history" note rather than a misleading "everything is new" wall (the daily brief's discipline).
 */
export function diffWeeklySnapshots(prev: WeeklySnapshot | null, curr: WeeklySnapshot | null): WeeklyDelta | null {
  if (!prev || !curr) return null;

  const sports = [...new Set([...Object.keys(prev.bySportMin), ...Object.keys(curr.bySportMin)])];
  const bySport = sports.map((sport) => {
    const from = prev.bySportMin[sport] ?? 0;
    const to = curr.bySportMin[sport] ?? 0;
    return { sport, from, to, deltaMin: to - from };
  });

  const ctl = prev.ctl != null && curr.ctl != null ? { from: prev.ctl, to: curr.ctl, delta: +(curr.ctl - prev.ctl).toFixed(1) } : null;
  const tsb = prev.tsb != null && curr.tsb != null ? { from: prev.tsb, to: curr.tsb, delta: +(curr.tsb - prev.tsb).toFixed(1) } : null;

  const zones = [...new Set([...Object.keys(prev.adherencePct), ...Object.keys(curr.adherencePct)])];
  const adherence = zones.map((zone) => ({ zone, from: prev.adherencePct[zone] ?? null, to: curr.adherencePct[zone] ?? null }));

  return { fromWeek: prev.weekStart, toWeek: curr.weekStart, bySport, ctl, tsb, adherence };
}

/** "+47m" / "−1h05" — a signed duration token for a delta line (intentionally NOT the h:mm totals format). */
function signedDuration(deltaMin: number): string {
  const sign = deltaMin < 0 ? "−" : "+"; // U+2212 minus, matches the dashboard's typographic minus
  const abs = Math.abs(Math.round(deltaMin));
  if (abs < 60) return `${sign}${abs}m`;
  const h = Math.floor(abs / 60);
  const mm = abs % 60;
  return `${sign}${h}h${String(mm).padStart(2, "0")}`;
}

/** "+3" / "−8" — a signed integer token (CTL/TSB moves). */
function signedNum(delta: number): string {
  const r = Math.round(delta);
  return r < 0 ? `−${Math.abs(r)}` : `+${r}`;
}

/** Title-case the first letter of a sport name for display (cosmetic; escaped downstream). */
function cap(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * The terse one-liner: `This week vs last · Bike +47m · CTL +3 · TSB −8 · Z2 72→81%`. Every interpolated
 * value is escaped (sport/zone names come from imported activity data). Only non-null, above-noise parts are
 * joined, so a quiet week stays short. Returns "" only when there's no prior week (delta null) — the caller
 * then shows the "building history" note instead.
 */
export function renderWeeklyBriefDelta(delta: WeeklyDelta | null): string {
  if (!delta) return "";
  const parts: string[] = [];

  for (const s of delta.bySport) {
    if (Math.abs(s.deltaMin) >= SPORT_DELTA_MIN_MINUTES) parts.push(`${cap(s.sport)} ${signedDuration(s.deltaMin)}`);
  }
  if (delta.ctl && delta.ctl.delta !== 0) parts.push(`CTL ${signedNum(delta.ctl.delta)}`);
  if (delta.tsb && delta.tsb.delta !== 0) parts.push(`TSB ${signedNum(delta.tsb.delta)}`);

  const z2 = delta.adherence.find((a) => a.zone === ENDURANCE_ZONE);
  if (z2 && z2.from != null && z2.to != null && z2.from !== z2.to) parts.push(`Z2 ${z2.from}→${z2.to}%`);

  const body = parts.length ? parts.join(" · ") : "broadly in line with last week";
  const line = `This week vs last · ${body}`;
  return `<div class="weekly-delta" style="font-size:13px;color:#666;margin:0 0 10px">${escapeHtml(line)}</div>`;
}

// --- week-boundary helpers (athlete-TZ calendar dates; date-string arithmetic, DST-proof) ---------------
// We treat a YYYY-MM-DD string (already resolved in the athlete's timezone by todayIso) as a UTC instant
// ONLY to read its weekday and step whole days — we never convert to local time, so a clock shift (DST)
// can't move the label. mondayOf/isSunday are therefore pure string→string and unit-testable.

function parseUtcDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00Z`);
}

/** True when the athlete-TZ calendar date falls on a Sunday (the week-end capture day). */
export function isSunday(dateStr: string): boolean {
  return parseUtcDate(dateStr).getUTCDay() === 0;
}

/** The Monday (YYYY-MM-DD) that starts the week containing `dateStr`. Sunday maps back 6 days, not forward. */
export function mondayOf(dateStr: string): string {
  const d = parseUtcDate(dateStr);
  const dow = d.getUTCDay(); // 0=Sun … 6=Sat
  const offset = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

// --- next-week proposal provenance + lifecycle (pure; shared by the Sunday job and the render path) -------
// The Sunday job drafts ≤3 gated proposals from the review's "## Next week" bullets, each tagged with a
// sourceKey `weekly:<reviewDate>#<bulletIndex>`. That bullet index is the join: the render path uses it to
// (a) server-render the open proposals as Apply/Dismiss cards on Decide, and (b) SUPPRESS the matching
// informational "This week" card so the same action never shows twice. Keeping these pure keeps both ends
// honest and unit-testable, and keeps the LLM drafting (weeklyProposals.ts) off the render path.

/** Mirror of WriteGate.PROPOSAL_TTL_DAYS — a proposal older than this is effectively dead (confirm refuses it). */
export const WEEKLY_PROPOSAL_TTL_DAYS = 7;

/** sourceKey tying a gated weekly proposal back to bullet `bulletIndex` of the review dated `reviewDate`. */
export function weeklyProposalSourceKey(reviewDate: string, bulletIndex: number): string {
  return `weekly:${reviewDate}#${bulletIndex}`;
}

const WEEKLY_KEY_RE = /^weekly:(\d{4}-\d{2}-\d{2})#(\d+)$/;

/** Parse a `weekly:<date>#<i>` sourceKey, or null if it isn't one (validates the format at every boundary). */
export function parseWeeklyProposalKey(key: string | undefined | null): { reviewDate: string; index: number } | null {
  const m = key ? WEEKLY_KEY_RE.exec(key) : null;
  return m ? { reviewDate: m[1], index: Number(m[2]) } : null;
}

/**
 * The dedup identity of a gated write: two proposals with the same effect collapse to one. Advice TEXT is
 * deliberately NOT part of the key, so two coaching-note edits on the same session don't both queue.
 */
export function proposalEquivKey(tool: string, args: Record<string, unknown>): string {
  const id = String(args.workoutId ?? "");
  if (tool === "changeWorkoutDate") return `changeWorkoutDate:${id}:${String(args.newDate ?? "")}`;
  if (tool === "skipWorkout") return `skipWorkout:${id}`;
  if (tool === "changeWorkoutAdvice") return `changeWorkoutAdvice:${id}`;
  return `${tool}:${JSON.stringify(args)}`;
}

/** A weekly proposal as the Decide tab renders it (server-side Apply/Dismiss card, from the durable log). */
export interface WeeklyProposalView {
  id: string;
  summary: string;
  tradeoff?: string;
  basis?: string[];
  sourceKey: string;
  index: number;
}

/**
 * From the decision log, the weekly proposals for ONE review date, split into the two things the render path
 * needs (pure, latest-status-per-id wins; the log is append-only chronological):
 *   • `open`      — status `proposed` and within TTL → render as Apply/Dismiss + count on the inbox badge.
 *   • `suppress`  — sourceKeys of any non-dead proposal (fresh-proposed / executing / executed) → hide the
 *                   matching "This week" card. A declined or expired-proposed bullet is NOT suppressed, so it
 *                   falls back to its informational cue.
 */
export function selectWeeklyProposals(
  records: DecisionRecord[],
  reviewDate: string,
  opts?: { now?: number; ttlDays?: number },
): { open: WeeklyProposalView[]; suppress: Set<string> } {
  const ttlMs = (opts?.ttlDays ?? WEEKLY_PROPOSAL_TTL_DAYS) * 86_400_000;
  const now = opts?.now ?? Date.now();
  const latest = new Map<string, DecisionRecord>();
  for (const r of records) if (r.kind === "plan-adjust" && parseWeeklyProposalKey(r.sourceKey)) latest.set(r.id, r);

  const open: WeeklyProposalView[] = [];
  const suppress = new Set<string>();
  for (const r of latest.values()) {
    const parsed = parseWeeklyProposalKey(r.sourceKey);
    if (!parsed || parsed.reviewDate !== reviewDate) continue;
    const age = now - Date.parse(r.timestamp);
    const fresh = Number.isFinite(age) && age <= ttlMs;
    const live = r.status === "executing" || r.status === "executed" || (r.status === "proposed" && fresh);
    if (live) suppress.add(r.sourceKey!);
    if (r.status === "proposed" && fresh) {
      open.push({ id: r.id, summary: r.summary, tradeoff: r.tradeoff, basis: r.basis, sourceKey: r.sourceKey!, index: parsed.index });
    }
  }
  open.sort((a, b) => a.index - b.index);
  return { open, suppress };
}

/**
 * Equivalence keys of every currently-LIVE gated proposal (any source — weekly, session-bridge, This-week),
 * so the Sunday job won't queue a second proposal with the same effect as one already waiting. Live =
 * proposed-and-fresh / executing / executed; a declined or expired-proposed one frees its slot.
 */
export function openProposalEquivKeys(records: DecisionRecord[], opts?: { now?: number; ttlDays?: number }): Set<string> {
  const ttlMs = (opts?.ttlDays ?? WEEKLY_PROPOSAL_TTL_DAYS) * 86_400_000;
  const now = opts?.now ?? Date.now();
  const latest = new Map<string, DecisionRecord>();
  for (const r of records) if (r.kind === "plan-adjust" && r.write) latest.set(r.id, r);
  const out = new Set<string>();
  for (const r of latest.values()) {
    if (!r.write) continue;
    const age = now - Date.parse(r.timestamp);
    const fresh = Number.isFinite(age) && age <= ttlMs;
    const live = r.status === "executing" || r.status === "executed" || (r.status === "proposed" && fresh);
    if (live) out.add(proposalEquivKey(r.write.tool, r.write.args));
  }
  return out;
}
