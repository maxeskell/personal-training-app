import type { PlannedSession } from "../state/types.js";
import { screenNutritionPrompt } from "./wellbeing.js";

/**
 * Write-path validation (Spec 2). The LLM may only PROPOSE from a narrow, documented, validatable subset
 * of write tools, and every proposed arg is checked against the athlete's real scheduled sessions BEFORE
 * it can be offered for confirmation — so a hallucinated workoutId / malformed date never becomes a
 * confirmable write. Validation also produces a human-readable summary of the exact change to confirm.
 *
 * Beyond targeting, it bounds MAGNITUDE/SAFETY (a valid id + well-formed date isn't enough): a move can't
 * go into the past or absurdly far out, can't stack a session onto/next to a race, and a coaching-note
 * `advice` string is run through the same wellbeing screen as free-text — so a plausible-looking but
 * unsafe change can't reach a confirm.
 */
export const PROPOSABLE_WRITE_TOOLS = ["changeWorkoutDate", "skipWorkout", "changeWorkoutAdvice"] as const;
export type ProposableTool = (typeof PROPOSABLE_WRITE_TOOLS)[number];

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  human?: string; // e.g. "Move Threshold Run (Run 2026-06-10) → 2026-06-12"
}

/** Optional bounds context. Omitted fields skip the corresponding check (back-compatible). */
export interface WriteContext {
  today?: string; // YYYY-MM-DD — reject moves into the past / absurdly far out
  raceDates?: string[]; // YYYY-MM-DD race-goal dates — don't stack a session on/next to a race
}

/** A move more than this far out is treated as a fat-finger and refused. */
const MAX_FUTURE_DAYS = 365;

const isYmd = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

function daysApart(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86_400_000);
}

function findWorkout(planned: PlannedSession[], id: unknown): PlannedSession | undefined {
  if (id == null) return undefined;
  return planned.find((p) => p.workoutId != null && String(p.workoutId) === String(id));
}
function describe(w: PlannedSession): string {
  return `${w.title ?? "workout"} (${w.sport ?? w.type ?? "?"} ${w.date})`;
}

export function validateWrite(tool: string, args: Record<string, unknown>, planned: PlannedSession[], ctx: WriteContext = {}): ValidationResult {
  if (!(PROPOSABLE_WRITE_TOOLS as readonly string[]).includes(tool)) {
    return { ok: false, reason: `${tool} is not a proposable write tool` };
  }
  const w = findWorkout(planned, args.workoutId);
  if (!w) return { ok: false, reason: `workoutId ${String(args.workoutId ?? "—")} is not one of your scheduled sessions` };

  if (tool === "changeWorkoutDate") {
    if (!isYmd(args.newDate)) return { ok: false, reason: "newDate must be a YYYY-MM-DD date" };
    const nd = args.newDate;
    if (ctx.today) {
      const delta = daysApart(ctx.today, nd);
      if (delta < 0) return { ok: false, reason: `newDate ${nd} is in the past (today is ${ctx.today})` };
      if (delta > MAX_FUTURE_DAYS) return { ok: false, reason: `newDate ${nd} is more than ${MAX_FUTURE_DAYS} days out — refusing as a likely error` };
    }
    const clash = (ctx.raceDates ?? []).find((rd) => isYmd(rd) && Math.abs(daysApart(rd, nd)) <= 1);
    if (clash) return { ok: false, reason: `newDate ${nd} lands on/next to a race (${clash}) — refusing to stack a session on race day` };
    return { ok: true, human: `Move ${describe(w)} → ${nd}` };
  }
  if (tool === "skipWorkout") {
    return { ok: true, human: `Skip ${describe(w)}` };
  }
  if (tool === "changeWorkoutAdvice") {
    if (typeof args.advice !== "string" || !args.advice.trim()) return { ok: false, reason: "advice must be a non-empty string" };
    // The note is athlete-facing text written into the plan — screen it like any free-text prompt so
    // restriction / disordered-eating / acute-symptom framing can never be written in as "coaching".
    const screen = screenNutritionPrompt(args.advice);
    if (screen.blocked) return { ok: false, reason: `advice rejected by the wellbeing screen (${screen.category}) — never write restriction/medical framing into the plan` };
    return { ok: true, human: `Add a coaching note to ${describe(w)}` };
  }
  return { ok: false, reason: "unhandled tool" };
}
