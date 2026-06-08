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
  },

  /** Where persisted secrets/tokens live — gitignored, outside the repo by default. */
  secretsDir: process.env.COACH_SECRETS_DIR ?? join(home, ".endurance-coach"),

  /** Where daily AthleteState records are persisted (inside repo, gitignored). */
  dataDir: process.env.COACH_DATA_DIR ?? join(process.cwd(), "data"),
} as const;

export type Config = typeof config;
