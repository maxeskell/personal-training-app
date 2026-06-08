import Anthropic from "@anthropic-ai/sdk";

/**
 * Thin wrapper over the Anthropic SDK for the coach's reasoning core.
 *
 * - Model: claude-opus-4-8 with adaptive thinking + high effort (intelligence-sensitive).
 * - The (stable) system prompt is prompt-cached: persona + science priors don't change between
 *   requests, so we mark the system block ephemeral and pay the cache write once.
 * - Structured output via output_config.format guarantees a parseable verdict.
 */
export class CoachLLM {
  private readonly client: Anthropic;
  readonly model = "claude-opus-4-8";

  constructor(private readonly systemPrompt: string) {
    // Anthropic() reads ANTHROPIC_API_KEY from the environment.
    this.client = new Anthropic();
  }

  static hasApiKey(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  }

  /**
   * One-shot structured completion. `schema` is a JSON Schema; the response is parsed and
   * returned as T. The system prompt is cached across calls within the 5-minute TTL.
   */
  async structured<T>(userContent: string, schema: Record<string, unknown>): Promise<{ value: T; cacheRead: number }> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema },
      } as never, // SDK types for output_config.effort+format are still settling; shape is correct per API.
      system: [
        { type: "text", text: this.systemPrompt, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: userContent }],
    });

    const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
    let value: T;
    try {
      value = JSON.parse(text) as T;
    } catch {
      throw new Error(`Model did not return valid JSON. Raw: ${text.slice(0, 300)}`);
    }
    return { value, cacheRead: res.usage.cache_read_input_tokens ?? 0 };
  }

  /** Plain-prose completion (for the weekly review and race-prep reports). Same cached system prompt. */
  async text(userContent: string): Promise<{ text: string; cacheRead: number }> {
    // Headroom matters: adaptive thinking consumes part of max_tokens, so a low cap can leave no
    // room for the prose. 12k comfortably covers thinking + a long report.
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 12000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" } as never,
      system: [
        { type: "text", text: this.systemPrompt, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: userContent }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (!text && res.stop_reason === "max_tokens") {
      throw new Error("Model hit max_tokens before emitting prose — raise max_tokens.");
    }
    return { text, cacheRead: res.usage.cache_read_input_tokens ?? 0 };
  }
}
