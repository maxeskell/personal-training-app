import type { PlannedSession } from "../state/types.js";

/**
 * Write-path validation (Spec 2). The LLM may only PROPOSE from a narrow, documented, validatable subset
 * of write tools, and every proposed arg is checked against the athlete's real scheduled sessions BEFORE
 * it can be offered for confirmation — so a hallucinated workoutId / malformed date never becomes a
 * confirmable write. Validation also produces a human-readable summary of the exact change to confirm.
 */
export const PROPOSABLE_WRITE_TOOLS = ["changeWorkoutDate", "skipWorkout", "changeWorkoutAdvice"] as const;
export type ProposableTool = (typeof PROPOSABLE_WRITE_TOOLS)[number];

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  human?: string; // e.g. "Move Threshold Run (Run 2026-06-10) → 2026-06-12"
}

const isYmd = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

function findWorkout(planned: PlannedSession[], id: unknown): PlannedSession | undefined {
  if (id == null) return undefined;
  return planned.find((p) => p.workoutId != null && String(p.workoutId) === String(id));
}
function describe(w: PlannedSession): string {
  return `${w.title ?? "workout"} (${w.sport ?? w.type ?? "?"} ${w.date})`;
}

export function validateWrite(tool: string, args: Record<string, unknown>, planned: PlannedSession[]): ValidationResult {
  if (!(PROPOSABLE_WRITE_TOOLS as readonly string[]).includes(tool)) {
    return { ok: false, reason: `${tool} is not a proposable write tool` };
  }
  const w = findWorkout(planned, args.workoutId);
  if (!w) return { ok: false, reason: `workoutId ${String(args.workoutId ?? "—")} is not one of your scheduled sessions` };

  if (tool === "changeWorkoutDate") {
    if (!isYmd(args.newDate)) return { ok: false, reason: "newDate must be a YYYY-MM-DD date" };
    return { ok: true, human: `Move ${describe(w)} → ${args.newDate}` };
  }
  if (tool === "skipWorkout") {
    return { ok: true, human: `Skip ${describe(w)}` };
  }
  if (tool === "changeWorkoutAdvice") {
    if (typeof args.advice !== "string" || !args.advice.trim()) return { ok: false, reason: "advice must be a non-empty string" };
    return { ok: true, human: `Add a coaching note to ${describe(w)}` };
  }
  return { ok: false, reason: "unhandled tool" };
}
