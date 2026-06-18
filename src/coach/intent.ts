import { config } from "../config.js";
import { LocalLLM, type ChatCompleter } from "../llm/localClient.js";
import { HaikuRouter } from "../llm/haikuRouter.js";

/**
 * Question intent for the `ask` flow. `last_session` routes to the deep single-session pipeline
 * (joins .FIT biomechanics + thermal); `general` stays in free-form Q&A. New routed intents
 * (weekly / race / deep-dive) can be added here and to the classifier prompt without touching ask.ts.
 */
export type Intent = "last_session" | "general";

/** How the verdict was reached — surfaced for transparency/logging. */
export type IntentSource = "regex" | "local-model" | "haiku-model" | "fallback";

/**
 * The configured model router for a regex miss, or null for regex-only. `haiku` is the recommended
 * upgrade (a cheap claude-haiku-4-5 call on the existing API key, no server); `local` is the advanced
 * Ollama path; `regex` (default) returns null. Each returns null when unavailable, so we degrade safely.
 */
export function defaultIntentRouter(): ChatCompleter | null {
  switch (config.intentRouter) {
    case "haiku":
      return HaikuRouter.enabled() ? new HaikuRouter() : null;
    case "local":
      return LocalLLM.enabled() ? new LocalLLM() : null;
    default:
      return null;
  }
}

export interface IntentResult {
  intent: Intent;
  source: IntentSource;
}

/**
 * "What happened in my last run?" — a recency word + a session noun routes to the deep single-session
 * pipeline instead of the general Q&A. Conservative on purpose: "how were my long rides this month?"
 * has no recency word, so it stays in general Q&A. High precision, modest recall — which is exactly
 * why the local model backstops it on the misses.
 */
const SESSION_RECENCY = /\b(last|latest|most[- ]recent|recent|todays?|yesterdays?|this morning'?s?)\b/i;
const SESSION_NOUN = /\b(run|ride|bike|cycl\w*|swim|session|workout|activity|long run|long ride|brick)\b/i;
export function isLastSessionQuestion(q: string): boolean {
  return SESSION_RECENCY.test(q) && SESSION_NOUN.test(q);
}

const CLASSIFIER_SYSTEM = [
  "You are an intent classifier for an endurance-coaching app. Decide whether the athlete's question is",
  "asking for feedback or analysis of ONE specific recent training session — a particular run, ride, swim,",
  "brick, or workout (e.g. \"how did Tuesday's ride go\", \"break down my last hard effort\", \"was that swim ok\")",
  "— or is a GENERAL question (overall trends, fitness, plans, multiple sessions, metrics, or advice).",
  "Reply with EXACTLY ONE word and nothing else: LAST_SESSION or GENERAL.",
].join(" ");

/**
 * Parse the classifier reply leniently — small local models add stray casing, punctuation, or
 * surrounding words. Returns null when neither label is present so the caller can fall back.
 */
export function parseIntentReply(raw: string): Intent | null {
  const t = raw.toUpperCase();
  if (/LAST[\s_-]?SESSION/.test(t)) return "last_session";
  if (/\bGENERAL\b/.test(t)) return "general";
  return null;
}

/**
 * Hybrid intent router. The regex is the high-precision fast path — when it fires we route with no
 * model call at all. On a regex miss, an optional local model catches the paraphrases the regex can't
 * ("break down Tuesday's ride", "how'd my most recent hard effort go"). Any failure — server down,
 * timeout, or an unparseable reply — falls back to the regex verdict (general), so the Q&A never
 * blocks on, or is broken by, the local model.
 *
 * `llm` is injectable for tests; by default it's the configured router (regex → null, haiku, or local).
 */
export async function classifyIntent(
  question: string,
  llm: ChatCompleter | null = defaultIntentRouter(),
): Promise<IntentResult> {
  if (isLastSessionQuestion(question)) return { intent: "last_session", source: "regex" };
  if (!llm) return { intent: "general", source: "regex" };
  try {
    const reply = await llm.chat({
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM },
        { role: "user", content: question },
      ],
    });
    const parsed = parseIntentReply(reply);
    if (parsed) return { intent: parsed, source: llm.sourceLabel ?? "local-model" };
  } catch {
    /* server down / timeout / bad payload — fall through to the safe default */
  }
  return { intent: "general", source: "fallback" };
}
