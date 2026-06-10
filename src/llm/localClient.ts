import { config } from "../config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LocalChatOpts {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

/** The single capability the intent router needs — kept narrow so tests can supply a fake. */
export interface ChatCompleter {
  chat(opts: LocalChatOpts): Promise<string>;
}

/**
 * Minimal OpenAI-compatible chat client for the local LLM server (an Ollama wrapper exposing
 * POST /v1/chat/completions — see the local-llm-server repo). Dependency-free: native fetch, no SDK.
 *
 * Scope is deliberate — this serves only cheap, low-stakes side tasks (intent classification today),
 * never coaching output. It is built to degrade: the caller treats any throw/timeout as "local model
 * unavailable" and falls back to the regex verdict, mirroring how Garmin is an optional gap-filler.
 */
export class LocalLLM implements ChatCompleter {
  constructor(
    private readonly baseUrl = config.localLlm.baseUrl,
    private readonly apiKey = config.localLlm.apiKey,
    private readonly defaultModel = config.localLlm.model,
    private readonly defaultTimeoutMs = config.localLlm.timeoutMs,
  ) {}

  /** Whether local-model side tasks are turned on (COACH_LOCAL_INTENT=true). */
  static enabled(): boolean {
    return config.localLlm.enabled;
  }

  /** One-shot, non-streaming chat completion. Returns the assistant message text (possibly empty). */
  async chat(opts: LocalChatOpts): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? this.defaultTimeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: opts.model ?? this.defaultModel,
          messages: opts.messages,
          temperature: opts.temperature ?? 0,
          max_tokens: opts.maxTokens ?? 16,
          stream: false,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`local LLM HTTP ${res.status}`);
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return json.choices?.[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timer);
    }
  }
}
