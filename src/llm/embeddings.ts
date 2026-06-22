import { config } from "../config.js";

/**
 * Minimal OpenAI-compatible embeddings client for the local LLM server (POST /v1/embeddings — an Ollama
 * wrapper, see the local-llm-server repo). Dependency-free native fetch, mirroring {@link LocalLLM}.
 *
 * Scope is deliberately narrow: it serves ONE low-stakes side task — embedding the coach's short
 * recommendation lines so the dashboard can collapse cross-source duplicates — never coaching output. It
 * is built to degrade: any non-2xx / timeout / malformed response throws, and the only caller
 * ({@link refreshAdviceEmbeddings}) swallows the throw so the card falls back to per-source grouping.
 * Runs OFF the render path (at sync time), so a slow server can never stall a page load.
 */
export class LocalEmbeddings {
  constructor(
    private readonly baseUrl = config.adviceClustering.baseUrl,
    private readonly apiKey = config.adviceClustering.apiKey,
    private readonly model = config.adviceClustering.model,
    private readonly timeoutMs = config.adviceClustering.timeoutMs,
  ) {}

  /** Whether cross-source recommendation clustering is turned on (COACH_ADVICE_CLUSTERING=true). */
  static enabled(): boolean {
    return config.adviceClustering.enabled;
  }

  /**
   * Embed a batch of texts, returning one vector per input IN INPUT ORDER plus the prompt-token count from
   * the response's `usage` (for the local cost log; 0 when absent). Throws on any failure.
   */
  async embed(texts: string[]): Promise<{ vectors: number[][]; promptTokens: number }> {
    if (!texts.length) return { vectors: [], promptTokens: 0 };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`local embeddings HTTP ${res.status}`);
      const json = await res.json();
      return { vectors: parseEmbeddingResponse(json, texts.length), promptTokens: embeddingPromptTokens(json) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Read `usage.prompt_tokens` from an OpenAI-shaped embeddings response (0 when absent). Pure. */
export function embeddingPromptTokens(json: unknown): number {
  const tokens = (json as { usage?: { prompt_tokens?: unknown } } | null)?.usage?.prompt_tokens;
  return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : 0;
}

/**
 * Pull the vectors out of an OpenAI-shaped embeddings response (`{ data: [{ index, embedding }] }`),
 * ordered by `index` so they line up with the input. Pure — unit-tested without a server. Throws when the
 * payload isn't the expected shape or count, so a garbled reply degrades like a server-down throw.
 */
export function parseEmbeddingResponse(json: unknown, expected: number): number[][] {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("embeddings response missing data[]");
  const out = [...data]
    .map((d) => d as { index?: number; embedding?: unknown })
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => {
      if (!Array.isArray(d.embedding) || !d.embedding.every((n) => typeof n === "number")) {
        throw new Error("embeddings response item has no numeric embedding");
      }
      return d.embedding as number[];
    });
  if (out.length !== expected) throw new Error(`expected ${expected} embeddings, got ${out.length}`);
  return out;
}
