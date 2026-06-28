/**
 * The Sunday job's gated NEXT-week proposer: it turns the weekly review's "## Next week" bullets into ≤3
 * concrete, validated, GATED plan-adjustment proposals that land on the Decide tab as familiar Apply/Dismiss
 * cards. Nothing is written here — `gate.propose()` only records a proposal; confirming one (in the dashboard
 * or via `confirm`) is the sole path that writes to AI Endurance.
 *
 * Per-bullet, for provenance: each bullet is proposed independently and tagged `weekly:<reviewDate>#<i>`, so
 * the render path can (a) show the open proposals and (b) suppress the matching informational "This week"
 * card — the same action never shows twice. A fuelling/recovery bullet that can't bind to a real upcoming
 * workout produces no proposal (it degrades to its 👍/👎/💤 cue), exactly as intended.
 *
 * Idempotent + dedup-safe across processes (the gate's in-memory set is per-process, so we read the durable
 * log): a re-run skips a bullet that already has a live proposal (self-healing on a partial failure), and a
 * new proposal whose effect equals one already waiting is dropped.
 */

import type { AthleteState } from "../state/types.js";
import type { InsightReport } from "../insights/engine.js";
import type { EngagementContext } from "../insights/engagement.js";
import type { DecisionRecord } from "../state/decisionLog.js";
import type { CoachLLM } from "../llm/client.js";
import type { WriteGate } from "../guardrails/writeGate.js";
import { proposeAdjustments, validateProposals, buildProposerContext, writeContextFor, type GatedProposalInput } from "./planAdjust.js";
import { parseActionBullets, NEXT_WEEK_HEADING_RE } from "./setupCard.js";
import {
  weeklyProposalSourceKey,
  proposalEquivKey,
  selectWeeklyProposals,
  openProposalEquivKeys,
} from "./weeklyBrief.js";

/** The cap the athlete confirmed: never more than this many gated next-week changes waiting at once. */
export const WEEKLY_PROPOSAL_CAP = 3;

/**
 * One bullet → its validated, gate-ready proposals (the proposer's "notes" ride along for the "no change"
 * log). Injected into {@link draftWeeklyProposals} so its idempotency/dedup/cap control flow is testable
 * without the full insight fixture; the production seam is {@link weeklyProposer}.
 */
export type WeeklyProposeFn = (bulletRequest: string) => Promise<{ valid: GatedProposalInput[]; notes?: string }>;

/** The real proposer seam: build the full proposer context once, then run the existing LLM proposer +
 *  validator per bullet (validation re-checks every edit against the athlete's real sessions). */
export function weeklyProposer(args: { state: AthleteState; insights: InsightReport; engagement?: EngagementContext; llm: CoachLLM }): WeeklyProposeFn {
  const ctx = buildProposerContext(args.state, args.insights, args.engagement);
  const planned = args.state.plannedSessions.value ?? [];
  const writeCtx = writeContextFor(args.state);
  return async (bulletRequest: string) => {
    const { result } = await proposeAdjustments(args.llm, bulletRequest, args.state, ctx);
    const { valid } = validateProposals(result.proposals, planned, writeCtx);
    return { valid, notes: result.notes };
  };
}

/**
 * The free-text request handed to the (existing) gated proposer for ONE next-week bullet. It invites the
 * smallest binding edit — a move/skip for a schedule change, or `changeWorkoutAdvice` to attach a
 * fuelling/recovery cue to the most relevant upcoming session — and to propose nothing if it can't tie to a
 * real upcoming workoutId. Built server-side from the review's own text, never client-supplied.
 */
export function weeklyBulletRequest(bullet: string): string {
  return (
    `This week's review sets the following focus for NEXT week: "${bullet}". ` +
    `Draft the single smallest validated edit to an UPCOMING planned session that enacts it — move or skip a ` +
    `session for a schedule change, or attach it as a coaching note (changeWorkoutAdvice) on the most relevant ` +
    `upcoming session for a fuelling/recovery/execution cue. Target a specific upcoming workoutId; if nothing ` +
    `upcoming fits, propose nothing and say so in notes. Prefer one minimal change, never a restructure.`
  );
}

export interface DraftWeeklyResult {
  /** New proposals queued this run. */
  drafted: number;
  /** Bullets skipped because a live proposal already exists for them (idempotent re-run). */
  skipped: number;
  /** Proposer "no change" notes, for the log/console. */
  notes: string[];
}

/**
 * Draft the gated next-week proposals. `existing` is the full decision log (read once by the caller) — used
 * for both the cap (count proposals already open for this review) and dedup (effect already waiting). Pure
 * orchestration around an injected proposer + the gate; the testable decision logic lives in weeklyBrief.ts.
 */
export async function draftWeeklyProposals(args: {
  reviewMarkdown: string;
  reviewDate: string;
  existing: DecisionRecord[];
  propose: WeeklyProposeFn;
  gate: WriteGate;
  cap?: number;
  now?: number;
}): Promise<DraftWeeklyResult> {
  const cap = args.cap ?? WEEKLY_PROPOSAL_CAP;
  const now = args.now ?? Date.now();
  const bullets = parseActionBullets(args.reviewMarkdown, NEXT_WEEK_HEADING_RE);

  const sel = selectWeeklyProposals(args.existing, args.reviewDate, { now });
  const seenEquiv = openProposalEquivKeys(args.existing, { now });
  let total = sel.open.length; // proposals already waiting for this review count toward the cap

  const result: DraftWeeklyResult = { drafted: 0, skipped: 0, notes: [] };
  for (let i = 0; i < bullets.length; i++) {
    if (total >= cap) break;
    const sourceKey = weeklyProposalSourceKey(args.reviewDate, i);
    if (sel.suppress.has(sourceKey)) {
      result.skipped += 1; // already has a live proposal — don't double-draft (idempotent re-run)
      continue;
    }
    const { valid, notes } = await args.propose(weeklyBulletRequest(bullets[i]));
    const pick = valid.find((p) => !seenEquiv.has(proposalEquivKey(p.tool, p.args)));
    if (!pick) {
      if (notes) result.notes.push(notes);
      continue;
    }
    seenEquiv.add(proposalEquivKey(pick.tool, pick.args));
    await args.gate.propose({
      tool: pick.tool as never,
      args: pick.args,
      rationale: pick.summary,
      tradeoff: pick.tradeoff,
      human: pick.human,
      sourceKey,
      basis: pick.basis,
    });
    total += 1;
    result.drafted += 1;
  }
  return result;
}
