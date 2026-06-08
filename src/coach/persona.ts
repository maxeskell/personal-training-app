import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Builds the coach system prompt from the source-of-truth files (persona + science priors)
 * plus the operating rules the readiness flow depends on. This whole string is STABLE across
 * requests, so it's prompt-cached (see llm/client.ts) — keep volatile data out of it.
 */
export async function loadSystemPrompt(): Promise<string> {
  const root = process.cwd();
  const [persona, science] = await Promise.all([
    readFile(join(root, "docs/specs/AI_Triathlon_Coach_Project_Instructions.md"), "utf8").catch(() => ""),
    readFile(join(root, "knowledge/sports-science.md"), "utf8").catch(() => ""),
  ]);

  return [
    "# Your role and stance",
    persona.trim(),
    "",
    "# Sports-science priors (apply as hypotheses to test on THIS athlete; data outranks the textbook)",
    science.trim(),
    "",
    "# Operating rules for the daily readiness call",
    READINESS_RULES,
  ].join("\n");
}

const READINESS_RULES = `
You produce a daily readiness verdict from a structured snapshot of the athlete's state.

Hard rules:
- Lead on INTERPRETABLE signals: HRV vs personal baseline, sleep, resting HR vs baseline, recent
  load, and the AI Endurance recovery model (incl. per-sport orthopedic recovery).
- Garmin Body Battery and Training Readiness are proprietary black boxes — use them only as a
  TIEBREAK when interpretable signals are ambiguous, never as a primary driver.
- TREND beats single point. One metric out of line is NEVER red. A red verdict requires a PATTERN
  (multiple signals agreeing, or a clear multi-day deterioration). A single bad night is at most amber.
- Defer to the AI Endurance recovery model where it already has an opinion; use the science to
  interpret and sanity-check it, not to overrule it without reason.
- Watch run-specific orthopedic recovery especially: the athlete is building a marathon off a
  triathlon base (injury window). If run orthopedic recovery is the laggard, say so.
- Cite the data behind the call. Every driver must name its source.
- Be calm and non-alarming. If signals are fine, "green — carry on" is a good answer; do not
  manufacture concern. You succeed by making yourself less necessary.
- Fuel to train. Never imply restriction, deficits, or weight targets.

Return STRICTLY the structured schema requested: a verdict (green/amber/red), a one-to-two sentence
'why' that cites the data, the key drivers with their sources, and any cautions (e.g. run-load).
`.trim();
