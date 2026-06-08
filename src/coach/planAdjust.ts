import type { CoachLLM } from "../llm/client.js";
import type { AthleteState } from "../state/types.js";
import { AIE_WRITE_TOOLS } from "../mcp/aieClient.js";

/**
 * Plan-adjustment proposals (Build Spec §5.3): the model proposes concrete changes with
 * trade-offs; nothing is written here. Each proposal names a write tool + args (as a JSON
 * string, parsed in code) that the WriteGate will only fire on explicit confirmation.
 * Never restructure a week unprompted — proposals are scoped to the athlete's request.
 */
export interface RawProposal {
  summary: string;
  tradeoff: string;
  tool: string;
  argsJson: string;
}

export const PLAN_ADJUST_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    proposals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          summary: { type: "string", description: "What to change, in one line." },
          tradeoff: { type: "string", description: "The cost/benefit so the athlete can decide." },
          tool: { type: "string", enum: [...AIE_WRITE_TOOLS] },
          argsJson: {
            type: "string",
            description: "A JSON object string of the tool's arguments, e.g. {\"workoutId\":\"123\",\"newDate\":\"2026-07-01\"}.",
          },
        },
        required: ["summary", "tradeoff", "tool", "argsJson"],
        additionalProperties: false,
      },
    },
    notes: { type: "string", description: "Any context or a recommendation to make no change." },
  },
  required: ["proposals", "notes"],
  additionalProperties: false,
};

export interface PlanAdjustResult {
  proposals: RawProposal[];
  notes: string;
}

const WRITE_TOOL_REFERENCE = `
AI Endurance write tools you may propose (use exact arg names):
- changeWorkoutDate { workoutId, newDate (YYYY-MM-DD), title? } — move a workout
- skipWorkout { workoutId, title? } — remove a future workout
- changeWorkoutAdvice { workoutId, advice, title? } — add/adjust coaching note (no structure change)
- createRideRunWorkout { dateStr, title, actType ("Ride"|"Run"), stepsGeneral[], isTaper?, advice? }
- createSwimWorkout { dateStr, title, swimSections[], isTaper?, advice? }
- createStrengthOtherWorkout { dateStr, title, strengthOtherText, isTaper? }
- setZones { actType ("Run"|"Ride"), zones }
Use workoutIds and dates from the snapshot's planned sessions. If you can't identify a concrete
workoutId, propose changeWorkoutAdvice or describe the change in notes rather than guessing an id.
`.trim();

export async function proposeAdjustments(
  llm: CoachLLM,
  request: string,
  today: AthleteState,
): Promise<{ result: PlanAdjustResult; cacheRead: number }> {
  const planned = (today.plannedSessions.value ?? [])
    .map((p) => `  - id=${p.workoutId ?? "?"} ${p.date} ${p.sport ?? p.type ?? ""} ${p.durationMin ?? ""}m "${p.title ?? ""}"`)
    .join("\n");

  const prompt = [
    "The athlete is asking for a plan adjustment. Propose specific, minimal changes with clear",
    "trade-offs. Do NOT restructure the week — only address the request. Prefer the smallest change",
    "that meets the need. If no change is warranted, return an empty proposals array and say so in notes.",
    "Respect the season shape and the Alderford capped-tempo / marathon run-load cautions.",
    "",
    `ATHLETE REQUEST: ${request}`,
    "",
    "CURRENT PLANNED SESSIONS [ai-endurance]:",
    planned || "  (none in the next 14 days)",
    "",
    WRITE_TOOL_REFERENCE,
  ].join("\n");

  const { value, cacheRead } = await llm.structured<PlanAdjustResult>(prompt, PLAN_ADJUST_SCHEMA);
  return { result: value, cacheRead };
}

/** Parse a proposal's argsJson safely into an args object. */
export function parseArgs(argsJson: string): Record<string, unknown> {
  try {
    const v = JSON.parse(argsJson);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
