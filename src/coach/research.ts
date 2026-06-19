import { CoachLLM } from "../llm/client.js";
import { engagementSteer } from "../insights/engagement.js";
import type { EngagementContext } from "../insights/engagement.js";

/**
 * Monthly research digest. Uses the LLM's web search to scan for recent developments in endurance /
 * triathlon training, fuelling and gear (e.g. the wider-tyre shift, fuelling g/h creep, heat protocols),
 * read against the current knowledge layer, and DRAFTS proposed updates. The output is a review proposal
 * written to `knowledge/pending/` — it never edits the live priors itself. Best-effort: any failure
 * (no key, web search unavailable, network) leaves the knowledge layer untouched.
 */

export const RESEARCH_PROMPT = (knowledge: string, today: string, steer?: string | null) =>
  [
    `You are refreshing a triathlon coach's sports-science knowledge layer. Today is ${today}.`,
    "Using web search, look for DEVELOPMENTS IN THE LAST ~12 MONTHS that would change or add to the",
    "priors below — endurance/triathlon training, fuelling, durability, tapering, recovery, and GEAR",
    "(e.g. tyre width/pressure, aero, footwear). Prioritise meta-analyses, position stands and strong",
    "reviews over single studies or blogs.",
    ...(steer ? [`ENGAGEMENT STEER [from the athlete's feedback history]: ${steer}`] : []),
    "",
    "Output a concise MARKDOWN review proposal — NOT a rewrite of the file. For each item:",
    "- **Topic** and whether it's NEW, a CHANGE to an existing prior, or CONFIRMS one.",
    "- The proposed one-to-two-sentence prior, in the file's voice ('Apply:' guidance where useful).",
    "- **Source**: author, year and venue, plus a resolvable **DOI or URL** — prefer a DOI written in",
    "  full as `https://doi.org/10.…` so it's one click to the original; only if you genuinely cannot",
    "  find one, write '(no link found)'. Then your confidence.",
    "Keep the whole thing scannable; 4–8 items max. End with a short 'Reviewer notes' line flagging",
    "anything uncertain or conflicting that the athlete should weigh personally.",
    "",
    "Output ONLY the finished markdown proposal. Do NOT narrate your search process or include any",
    "preamble — no 'I'll research…', 'Let me search…', 'Here's a proposal…' or running commentary",
    "between sections. Begin directly with the first item (or a short heading).",
    "",
    "Honour the coach's hard rules: priors are hypotheses that yield to this athlete's n=1 data; NO",
    "clinical-syndrome claims; fuel to train (never restriction/deficits/'race weight').",
    "",
    "=== CURRENT KNOWLEDGE LAYER (knowledge/sports-science.md) ===",
    knowledge.trim(),
  ].join("\n");

export async function runResearchDigest(
  llm: CoachLLM,
  knowledge: string,
  today: string,
  engagement?: EngagementContext,
): Promise<{ markdown: string; costUsd: number }> {
  const { text, costUsd } = await llm.research(RESEARCH_PROMPT(knowledge, today, engagementSteer(engagement)));
  const header = [
    `# Research digest — ${today} (PROPOSED — review before applying)`,
    "",
    "_Drafted by the monthly research flow with web search. Nothing here is active until you approve it",
    "(`npm run knowledge -- approve <file>`), at which point it's folded into the priors and the coach",
    "uses it. Treat as a starting point — verify sources, and remember your own data outranks the textbook._",
    "",
  ].join("\n");
  return { markdown: header + text.trim() + "\n", costUsd };
}
