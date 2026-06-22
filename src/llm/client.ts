import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { appendCostRecord, costUsd, type LlmUsage } from "./costLog.js";

/**
 * Thin wrapper over the Anthropic SDK for the coach's reasoning core.
 *
 * - Model: claude-opus-4-8 with adaptive thinking + high effort (intelligence-sensitive).
 * - The (stable) system prompt is marked ephemeral for prompt-caching. NOTE: the prompt is currently
 *   ~3k tokens, below Opus 4.8's 4096-token cache minimum, so the marker is a no-op until the prompt
 *   grows — every call pays full input price today (see the cost report).
 * - Structured output via output_config.format guarantees a parseable verdict.
 * - Every call records its token usage + dollar cost to the local cost log (see costLog.ts).
 */
export class CoachLLM {
  private readonly client: Anthropic;
  readonly model = "claude-opus-4-8";

  /**
   * `operation` labels the call in the cost log (e.g. "readiness", "ask", "session").
   * `effort` trades reasoning depth for token cost — "high" (default) for the deep flows
   * (weekly / race / deep-dive / plan proposals), "medium" for the cheap, frequent ones.
   */
  constructor(
    private readonly systemPrompt: string,
    private readonly operation = "unknown",
    private readonly effort: "low" | "medium" | "high" | "xhigh" | "max" = "high",
  ) {
    // Anthropic() reads ANTHROPIC_API_KEY from the environment.
    this.client = new Anthropic();
  }

  /** Pull the four billable buckets off a response, compute cost, and append to the cost log. */
  private async meter(usageRaw: Anthropic.Usage): Promise<{ usage: LlmUsage; costUsd: number }> {
    const usage: LlmUsage = {
      input: usageRaw.input_tokens ?? 0,
      output: usageRaw.output_tokens ?? 0,
      cacheWrite: usageRaw.cache_creation_input_tokens ?? 0,
      cacheRead: usageRaw.cache_read_input_tokens ?? 0,
    };
    const cost = costUsd(usage, this.model);
    await appendCostRecord({ ts: new Date().toISOString(), operation: this.operation, model: this.model, ...usage, costUsd: cost });
    return { usage, costUsd: cost };
  }

  static hasApiKey(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  }

  /**
   * Cap a single SDK call at `ms` so a hung request can't stall a flow indefinitely. The budget is
   * per-shape: the interactive `structured` flows use COACH_LLM_TIMEOUT_MS; the long STREAMED flows
   * (reports + research, which can legitimately run for minutes) use the larger `longTimeoutMs`.
   * Passes an AbortSignal the SDK uses to abort the underlying request/stream; the SDK's own 429/5xx
   * retries run within the deadline. A non-positive `ms` disables the cap.
   */
  private async withDeadline<T>(make: (signal: AbortSignal | undefined) => Promise<T>, ms: number): Promise<T> {
    if (!Number.isFinite(ms) || ms <= 0) return make(undefined);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await make(ctrl.signal);
    } catch (err) {
      if (ctrl.signal.aborted) throw new Error(`CoachLLM ${this.operation} call exceeded its ${ms}ms wall-clock budget (COACH_LLM_TIMEOUT_MS).`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One-shot structured completion. `schema` is a JSON Schema; the response is parsed and
   * returned as T. The system prompt is cached across calls within the 5-minute TTL.
   */
  async structured<T>(userContent: string, schema: Record<string, unknown>): Promise<{ value: T; cacheRead: number; costUsd: number }> {
    const res = await this.withDeadline((signal) => this.client.messages.create(
      {
        model: this.model,
        max_tokens: 4000,
        thinking: { type: "adaptive" },
        output_config: {
          effort: this.effort,
          format: { type: "json_schema", schema },
        } as never, // SDK types for output_config.effort+format are still settling; shape is correct per API.
        system: [
          { type: "text", text: this.systemPrompt, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: userContent }],
      },
      { signal },
    ), config.coachLlm.timeoutMs);

    // A truncated response can yield structurally-valid-but-incomplete JSON (e.g. a cut-off proposals
    // array) that downstream code — including the write gate — would treat as authoritative. Refuse it.
    if (res.stop_reason === "max_tokens") {
      throw new Error("LLM response was truncated (max_tokens) — not using a partial structured result.");
    }
    const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
    let value: T;
    try {
      value = JSON.parse(text) as T;
    } catch {
      throw new Error(`Model did not return valid JSON. Raw: ${text.slice(0, 300)}`);
    }
    if (value == null || typeof value !== "object") throw new Error("LLM structured output was not an object.");
    for (const k of (schema.required as string[] | undefined) ?? []) {
      if (!(k in (value as Record<string, unknown>))) throw new Error(`LLM structured output missing required field: ${k}`);
    }
    const { usage, costUsd } = await this.meter(res.usage);
    return { value, cacheRead: usage.cacheRead, costUsd };
  }

  /**
   * Web-grounded completion for the monthly research digest — the ONLY flow that reaches the public web,
   * via Anthropic's server-side web_search tool. Used to draft proposed knowledge-layer updates that the
   * athlete then REVIEWS (never auto-applied). Degradable: callers treat a throw as "no digest this run".
   * NOTE: web search bills per search on top of tokens; only token cost is recorded in the cost log.
   */
  async research(userContent: string, maxSearches = 6): Promise<{ text: string; cacheRead: number; costUsd: number }> {
    // Streamed: a high-effort web-grounded run can take minutes (adaptive thinking + several searches),
    // and a non-streaming call risks the SDK's HTTP timeout. finalMessage() collects the full result.
    const res = await this.withDeadline((signal) => this.client.messages
      .stream(
        {
          model: this.model,
          max_tokens: 8000,
          thinking: { type: "adaptive" },
          output_config: { effort: this.effort } as never,
          system: [{ type: "text", text: this.systemPrompt, cache_control: { type: "ephemeral" } }],
          // Server-side web search (current 2026-02 tool — adds dynamic result filtering on Opus 4.8). Capped to bound cost.
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: maxSearches } as never],
          messages: [{ role: "user", content: userContent }],
        },
        { signal },
      )
      .finalMessage(), config.coachLlm.longTimeoutMs);
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (!text && res.stop_reason === "max_tokens") {
      throw new Error("Model hit max_tokens before emitting the digest — raise max_tokens.");
    }
    const { usage, costUsd } = await this.meter(res.usage);
    return { text, cacheRead: usage.cacheRead, costUsd };
  }

  /** Plain-prose completion (for the weekly review and race-prep reports). Same cached system prompt. */
  async text(userContent: string): Promise<{ text: string; cacheRead: number; costUsd: number }> {
    // Headroom matters: adaptive thinking consumes part of max_tokens, so a low cap can leave no
    // room for the prose. 12k comfortably covers thinking + a long report. Streamed so a long
    // high-effort generation can't trip the SDK's non-streaming HTTP timeout; finalMessage() collects it.
    const res = await this.withDeadline((signal) => this.client.messages
      .stream(
        {
          model: this.model,
          max_tokens: 12000,
          thinking: { type: "adaptive" },
          output_config: { effort: this.effort } as never,
          system: [
            { type: "text", text: this.systemPrompt, cache_control: { type: "ephemeral" } },
          ],
          messages: [{ role: "user", content: userContent }],
        },
        { signal },
      )
      .finalMessage(), config.coachLlm.longTimeoutMs);
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (!text && res.stop_reason === "max_tokens") {
      throw new Error("Model hit max_tokens before emitting prose — raise max_tokens.");
    }
    const { usage, costUsd } = await this.meter(res.usage);
    return { text, cacheRead: usage.cacheRead, costUsd };
  }
}
