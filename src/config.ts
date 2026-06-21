import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { config as loadEnv } from "dotenv";
import { parse as parseYaml } from "yaml";

loadEnv();

/**
 * Resolve the athlete's IANA timezone for "today" calculations. Precedence: an explicit COACH_TZ wins;
 * otherwise the app-owned profile (identity.timezone) is the source of truth; otherwise Europe/London.
 * Reading the profile here — a tiny synchronous parse, matching loadProfile's resolution order — lets
 * the required profile field actually drive scheduling (dose_cycle, age, which calendar day "today" is)
 * without a second env var to keep in sync. Best-effort: any missing/malformed file falls through.
 */
export function resolveAthleteTimezone(): string {
  const explicit = process.env.COACH_TZ?.trim();
  if (explicit) return explicit;
  const candidates = [process.env.COACH_PROFILE_PATH, "profile.local.yaml", "profile.example.yaml"].filter(
    (p): p is string => Boolean(p),
  );
  for (const c of candidates) {
    try {
      const path = isAbsolute(c) ? c : join(process.cwd(), c);
      const parsed = parseYaml(readFileSync(path, "utf8")) as { identity?: { timezone?: unknown } } | null;
      const tz = parsed?.identity?.timezone;
      if (typeof tz === "string" && tz.trim()) return tz.trim();
    } catch {
      /* missing/malformed candidate — try the next, then the default */
    }
  }
  return "Europe/London";
}

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
 * Parse a manual swim-CSS pace into sec/100m. Accepts "m:ss" (e.g. "1:52"), bare seconds ("112"), or
 * undefined. Gated to a sane 60–240 s/100m; anything outside that (or unparseable) → undefined.
 */
export function parseManualSwimCss(raw: string | undefined): number | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  const sec = /^\d+(\.\d+)?$/.test(s)
    ? Number(s)
    : s.split(":").reduce((acc, p) => {
        const n = Number(p);
        return Number.isFinite(acc) && Number.isFinite(n) && n >= 0 ? acc * 60 + n : NaN;
      }, 0);
  return Number.isFinite(sec) && sec >= 60 && sec <= 240 ? Math.round(sec) : undefined;
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
    /** Hard timeout (ms) for a connect/reconnect to AI Endurance — the required spine must never block a
     *  headless flow on a hung network connect (like Garmin's own cap). The interactive human re-auth wait
     *  in the CLI `auth` flow is intentionally NOT bounded by this. */
    timeoutMs: Number(process.env.AIE_TIMEOUT_MS ?? 20000),
    get redirectUrl() {
      return `http://localhost:${this.redirectPort}/callback`;
    },
  },

  /** Garmin — OPTIONAL, degradable gap-filler. Disabled unless explicitly enabled. */
  garmin: {
    enabled: process.env.GARMIN_ENABLED === "true",
    /** Spawn command for the Taxuspt/garmin_mcp stdio server. Pinned to the commit that added
     *  download_activity_file (raw per-second .FIT download, 2026-06-10) — the pin also makes uvx
     *  rebuild its cached env, so the tool appears without a manual `uvx --refresh`. Bump deliberately. */
    command: process.env.GARMIN_MCP_COMMAND ?? "uvx",
    args: parseArgsList(
      process.env.GARMIN_MCP_ARGS ??
        "--python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp@d31de7980d652289e5368637261fcd17aa2c7d90 garmin-mcp",
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
   * Pricing for the cheap side-task model (claude-haiku-4-5) used by the optional Haiku intent router.
   * Published Haiku 4.5 rates ($/MTok) as of the knowledge cutoff; override via env if they change.
   * The cost log picks this table for any model id containing "haiku" (see costLog.ts).
   */
  pricingHaiku: {
    inputPerMTok: Number(process.env.COACH_PRICE_HAIKU_INPUT ?? 1),
    outputPerMTok: Number(process.env.COACH_PRICE_HAIKU_OUTPUT ?? 5),
    cacheWritePerMTok: Number(process.env.COACH_PRICE_HAIKU_CACHE_WRITE ?? 1.25),
    cacheReadPerMTok: Number(process.env.COACH_PRICE_HAIKU_CACHE_READ ?? 0.1),
  },

  /**
   * `ask` intent routing strategy: `regex` (default, zero-cost, no model), `haiku` (a cheap
   * claude-haiku-4-5 micro-call using your existing ANTHROPIC_API_KEY — no extra server), or `local`
   * (the separate local-llm-server / Ollama, advanced). Back-compat: COACH_LOCAL_INTENT=true ⇒ `local`.
   * Any strategy degrades to the regex verdict on error, so routing never blocks the Q&A.
   */
  intentRouter: ((): "regex" | "haiku" | "local" => {
    const v = process.env.COACH_INTENT_ROUTER;
    if (v === "regex" || v === "haiku" || v === "local") return v;
    return process.env.COACH_LOCAL_INTENT === "true" ? "local" : "regex";
  })(),

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

  /**
   * Week-ahead weather (dashboard "Week ahead — plan vs weather" card). Open-Meteo, free, no key.
   * Coordinates default to a neutral location (London) — set COACH_WEATHER_LAT/LON to your own base.
   * Thresholds encode the athlete's stated preferences (rides want dry + low wind; open-water swims
   * want the venue above a comfort floor, default 13°C).
   */
  weather: {
    enabled: process.env.COACH_WEATHER_ENABLED !== "false",
    lat: Number(process.env.COACH_WEATHER_LAT ?? 51.5074),
    lon: Number(process.env.COACH_WEATHER_LON ?? -0.1278),
    /** Latest manually-entered open-water temp (°C) — the venue has no public live feed. */
    waterTempC: process.env.COACH_WATER_TEMP_C ? Number(process.env.COACH_WATER_TEMP_C) : undefined,
    swimMinWaterC: Number(process.env.COACH_SWIM_MIN_WATER_C ?? 13),
    rideMaxGustKmh: Number(process.env.COACH_RIDE_MAX_GUST_KMH ?? 38),
    rideMaxRainProbPct: Number(process.env.COACH_RIDE_MAX_RAIN_PROB ?? 40),
    timeoutMs: Number(process.env.COACH_WEATHER_TIMEOUT_MS ?? 6000),
  },

  /**
   * Manual swim CSS (Critical Swim Speed), pace per 100m — a fallback for when AI Endurance's `getUser`
   * doesn't surface the CSS you set in its UI. Like COACH_WATER_TEMP_C (a value with no public feed), it
   * lets the dashboard still build a swim model (zones + race swim split). Accepts "m:ss" (e.g. "1:52") or
   * bare seconds ("112"). A CSS that DOES come through from AI Endurance always wins over this fallback.
   */
  manualSwimCssSecPer100: parseManualSwimCss(process.env.COACH_SWIM_CSS),

  /**
   * Dashboard auto-sync: a page load whose snapshot is older than this kicks a background
   * /refresh and reloads when done (the page itself still renders instantly). 0 disables it.
   */
  autoSyncMinutes: Number(process.env.COACH_AUTOSYNC_MIN ?? 30),

  /**
   * Auto deep session-feedback at sync (see README "Deep session feedback"). Each session generated is
   * ONE LLM call, so this is the throttle: `on` = every recent session that has its raw .FIT (default),
   * `latest` = only the single most recent, `off` = none (use `npm run session` on demand instead).
   */
  autoSessionFeedback: ((): "off" | "latest" | "on" => {
    const v = (process.env.COACH_AUTO_SESSION_FEEDBACK ?? "on").trim().toLowerCase();
    return v === "off" || v === "latest" ? v : "on";
  })(),

  /**
   * MCP server (`npm run mcp` stdio · `npm run mcp:http`). HTTP mode exists for clients that can only
   * reach a remote URL — notably Claude Cowork, whose sandboxed cloud VM can't spawn a local stdio
   * server: run HTTP mode locally and expose it through an AUTHENTICATED HTTPS tunnel (see
   * docs/mcp-server.md). Bound to localhost; every HTTP request needs the bearer token
   * (COACH_MCP_TOKEN, else a random one persisted to <secretsDir>/mcp.token, 0600). Set
   * COACH_MCP_READONLY=true to drop the gated write tools (propose/confirm/decline) from the HTTP surface.
   */
  mcp: {
    httpHost: process.env.COACH_MCP_HOST ?? "127.0.0.1",
    httpPort: Number(process.env.COACH_MCP_PORT ?? 8787),
    readOnly: process.env.COACH_MCP_READONLY === "true",
    /** Expose the local-file `update_profile` write tool on the HTTP/Cowork surface. Off by default —
     *  it lets a REMOTE session write profile.local.yaml on the host, so it's opt-in. Always on for
     *  local stdio (Claude Desktop/Code) regardless of this flag. Validated; never stores live numbers. */
    profileWrite: process.env.COACH_MCP_PROFILE_WRITE === "true",
    /** Expose the gated, repo-scoped file tools (`read_file`/`write_file`/`list_files`) on the HTTP/Cowork
     *  surface, so a remote session can read+update the project's gitignored files (profile.local.yaml,
     *  data/, reports/, knowledge/ …). OFF by default — it lets a REMOTE caller read/write files on the
     *  host. Always on for local stdio. Containment + a secrets deny-list (.env*, tokens, keys, .git) are
     *  enforced regardless, so it can never touch secrets. */
    fileAccess: process.env.COACH_MCP_FILE_ACCESS === "true",
    /**
     * HTTP auth mode. "token" (default): a static bearer token — good for scripts and a self-hosted
     * Desktop-over-HTTP. "oauth": full OAuth 2.1 (DCR + PKCE + a coach-token-gated consent) — required
     * by Claude Cowork's custom connectors. "none": no auth (only behind a private tunnel you trust).
     */
    auth: (process.env.COACH_MCP_AUTH ?? "token") as "token" | "oauth" | "none",
    /** Public HTTPS base URL the server is reached at (the tunnel URL). REQUIRED for auth=oauth — the
     *  OAuth metadata/redirects must advertise a publicly-reachable issuer, not localhost. */
    publicUrl: process.env.COACH_MCP_PUBLIC_URL,
  },

  /**
   * Athlete identity that AI Endurance's getUser does NOT expose (device kit, unit preference). Name,
   * age, sex and thresholds come live from getUser; this is only the residue that isn't on the platform.
   * Configurable so it isn't frozen in the coaching prompt — clear COACH_EQUIPMENT to drop it entirely.
   */
  athlete: {
    equipment: process.env.COACH_EQUIPMENT ?? "Garmin Forerunner 970, Edge 1040, Index scale",
    units: process.env.COACH_UNITS ?? "metric, UK",
    /** IANA timezone used to decide which calendar day "today" is. Precedence: COACH_TZ → the profile's
     *  identity.timezone → Europe/London (see resolveAthleteTimezone). Avoids a UTC "today" mis-dating a
     *  late-night session/readiness window, and keeps the dose_cycle on the athlete's own calendar day. */
    timezone: resolveAthleteTimezone(),
  },

  /** Where persisted secrets/tokens live — gitignored, outside the repo by default. */
  secretsDir: process.env.COACH_SECRETS_DIR ?? join(home, ".endurance-coach"),

  /** Where daily AthleteState records are persisted (inside repo, gitignored). */
  dataDir: process.env.COACH_DATA_DIR ?? join(process.cwd(), "data"),

  /**
   * Optional override for the athlete-profile file. Default resolution is profile.local.yaml (your
   * real, gitignored data) → profile.example.yaml (the committed blank template). Set this to point at
   * a profile file elsewhere; relative paths resolve from the repo root.
   */
  profilePath: process.env.COACH_PROFILE_PATH,

  /**
   * intervals.icu — an alternative training-data spine (Phase 3b). A free, popular platform with an
   * API-key'd REST API. Used only when COACH_SOURCE=intervals. Read-only here.
   */
  intervals: {
    apiKey: process.env.COACH_INTERVALS_API_KEY ?? "",
    /** Athlete id, e.g. "i123456" (or just the number — normalised). */
    athleteId: process.env.COACH_INTERVALS_ATHLETE_ID ?? "",
    baseUrl: (process.env.COACH_INTERVALS_URL ?? "https://intervals.icu/api/v1").replace(/\/+$/, ""),
    /** Trailing days of activities/wellness to pull (the analysis window). */
    windowDays: Number(process.env.COACH_INTERVALS_WINDOW_DAYS ?? 60),
    timeoutMs: Number(process.env.COACH_INTERVALS_TIMEOUT_MS ?? 15000),
  },

  /**
   * The training-data SPINE the coach assembles from (see src/sources/). "ai-endurance" is the default
   * and most capable; the adapter seam lets other sources (e.g. intervals.icu) be added later. An unknown
   * value falls back to AI Endurance.
   */
  source: process.env.COACH_SOURCE ?? "ai-endurance",
} as const;

export type Config = typeof config;
