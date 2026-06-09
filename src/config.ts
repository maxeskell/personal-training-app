import { homedir } from "node:os";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv();

/** Parse GARMIN_MCP_ARGS as a JSON array (handles args with spaces) or fall back to whitespace split. */
function parseArgsList(s: string): string[] {
  const t = s.trim();
  if (t.startsWith("[")) {
    try {
      const a = JSON.parse(t);
      if (Array.isArray(a)) return a.map(String);
    } catch {
      /* fall through to split */
    }
  }
  return t.split(/\s+/).filter(Boolean);
}

/**
 * Central config. Secrets live OUTSIDE the repo by default (~/.endurance-coach),
 * per the privacy NFR (creds out of prompts/logs/repo). Override via env if needed.
 */
const home = homedir();

export const config = {
  /** AI Endurance remote MCP server (the required spine). */
  aie: {
    serverUrl: process.env.AIE_MCP_URL ?? "https://aiendurance.com/mcp",
    scopes: ["read", "write"] as const,
    /** Loopback port the local redirect server listens on during OAuth. */
    redirectPort: Number(process.env.AIE_OAUTH_PORT ?? 8765),
    get redirectUrl() {
      return `http://localhost:${this.redirectPort}/callback`;
    },
  },

  /** Garmin — OPTIONAL, degradable gap-filler. Disabled unless explicitly enabled. */
  garmin: {
    enabled: process.env.GARMIN_ENABLED === "true",
    /** Spawn command for the Taxuspt/garmin_mcp stdio server. */
    command: process.env.GARMIN_MCP_COMMAND ?? "uvx",
    args: parseArgsList(
      process.env.GARMIN_MCP_ARGS ?? "--python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp",
    ),
    /** Hard timeout (ms) for any Garmin call — never let it block the coach. Some endpoints
     *  (power-duration curve, race predictions) parse many activities server-side and are slow. */
    timeoutMs: Number(process.env.GARMIN_TIMEOUT_MS ?? 25000),
    /** Overall wall-clock budget for the whole Garmin phase of an assemble — past it, remaining reads
     *  are skipped (degrade to AIE-only) so one slow tool can't make /refresh hang for minutes. */
    refreshBudgetMs: Number(process.env.GARMIN_REFRESH_BUDGET_MS ?? 90000),
  },

  /**
   * Anthropic pricing ($ per million tokens) for local cost accounting — claude-opus-4-8.
   * cacheWrite is the 5-minute-TTL rate (1.25× input); cacheRead is 0.1× input. Override via env
   * if the published rates change. Used only for the cost log / `cost` report — never sent anywhere.
   */
  pricing: {
    inputPerMTok: Number(process.env.COACH_PRICE_INPUT ?? 5),
    outputPerMTok: Number(process.env.COACH_PRICE_OUTPUT ?? 25),
    cacheWritePerMTok: Number(process.env.COACH_PRICE_CACHE_WRITE ?? 6.25),
    cacheReadPerMTok: Number(process.env.COACH_PRICE_CACHE_READ ?? 0.5),
  },

  /**
   * Local LLM server — OPTIONAL, degradable. An OpenAI-compatible wrapper around Ollama
   * (see the local-llm-server repo). Used only for cheap, low-stakes side tasks (intent
   * routing for `ask`), NEVER for coaching output — that stays on Opus. Off unless
   * COACH_LOCAL_INTENT=true, so the zero-cost regex fast-path is the default everywhere.
   */
  localLlm: {
    enabled: process.env.COACH_LOCAL_INTENT === "true",
    /** Base URL incl. the OpenAI version prefix; trailing slash trimmed so we can append cleanly. */
    baseUrl: (process.env.LOCAL_LLM_URL ?? "http://localhost:8000/v1").replace(/\/+$/, ""),
    /** Bearer token — empty means the server has auth disabled (its local default). */
    apiKey: process.env.LOCAL_LLM_API_KEY ?? "",
    model: process.env.LOCAL_LLM_MODEL ?? "llama3.2:1b",
    /** Hard timeout (ms) — a slow/missing local server must never stall the Q&A; we fall back to regex. */
    timeoutMs: Number(process.env.LOCAL_LLM_TIMEOUT_MS ?? 4000),
  },

  /** Where persisted secrets/tokens live — gitignored, outside the repo by default. */
  secretsDir: process.env.COACH_SECRETS_DIR ?? join(home, ".endurance-coach"),

  /** Where daily AthleteState records are persisted (inside repo, gitignored). */
  dataDir: process.env.COACH_DATA_DIR ?? join(process.cwd(), "data"),
} as const;

export type Config = typeof config;
