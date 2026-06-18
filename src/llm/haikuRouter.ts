import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { appendCostRecord, costUsd } from "./costLog.js";
import type { ChatCompleter, LocalChatOpts } from "./localClient.js";

/** Cheap side-task model for `ask` intent routing (alias — avoids pinning a dated snapshot). */
const HAIKU_MODEL = "claude-haiku-4-5";

/**
 * Haiku-backed intent router (a `ChatCompleter`, so it drops into the same hybrid router LocalLLM uses).
 *
 * A single cheap `claude-haiku-4-5` micro-call using the **ANTHROPIC_API_KEY the coach already needs** —
 * no separate server to stand up (unlike the Ollama-backed LocalLLM). Used ONLY for low-stakes intent
 * classification; coaching output always stays on Opus. The call is cost-logged like any other (operation
 * "intent", priced from the Haiku table). Hard timeout + `maxRetries: 0` so a slow/failed call throws fast
 * and the caller falls back to the zero-cost regex verdict — routing never blocks the Q&A.
 */
export class HaikuRouter implements ChatCompleter {
  readonly sourceLabel = "haiku-model" as const;
  private readonly client = new Anthropic();

  /** On only when selected (COACH_INTENT_ROUTER=haiku) AND a key is present — the call needs one. */
  static enabled(): boolean {
    return config.intentRouter === "haiku" && Boolean(process.env.ANTHROPIC_API_KEY);
  }

  async chat(opts: LocalChatOpts): Promise<string> {
    const system = opts.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const messages = opts.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 4000);
    try {
      const res = await this.client.messages.create(
        { model: HAIKU_MODEL, max_tokens: opts.maxTokens ?? 8, system, messages },
        { signal: ctrl.signal, maxRetries: 0 },
      );
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const usage = {
        input: res.usage.input_tokens ?? 0,
        output: res.usage.output_tokens ?? 0,
        cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
        cacheRead: res.usage.cache_read_input_tokens ?? 0,
      };
      // Best-effort cost log (priced from the Haiku table); a logging failure never breaks routing.
      await appendCostRecord({ ts: new Date().toISOString(), operation: "intent", model: HAIKU_MODEL, ...usage, costUsd: costUsd(usage, HAIKU_MODEL) });
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}
