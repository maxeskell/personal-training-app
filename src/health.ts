import { stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { config } from "./config.js";
import { AieClient, ReauthRequiredError } from "./mcp/aieClient.js";

/**
 * Hardening checks (Build Spec §10 M6). File/env-level health — no network. The CLI `doctor`
 * command composes these with a live AIE tool-drift check.
 */

export type Health = "ok" | "warn" | "fail" | "info";
export interface Check {
  name: string;
  status: Health;
  detail: string;
}

async function fileAgeDays(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return (Date.now() - s.mtimeMs) / 86_400_000;
  } catch {
    return null;
  }
}

/** Garmin tokens last ~6 months; warn well before expiry so a re-auth never silently breaks a ping. */
const GARMIN_REAUTH_WARN_DAYS = 150;

export async function fileChecks(): Promise<Check[]> {
  const checks: Check[] = [];

  // AI Endurance OAuth (the required spine).
  const aieAge = await fileAgeDays(join(config.secretsDir, "aie-tokens.json"));
  checks.push(
    aieAge == null
      ? { name: "AI Endurance auth", status: "fail", detail: "no cached token — run `npm run auth:aie`" }
      : { name: "AI Endurance auth", status: "ok", detail: `token present (refreshed ${aieAge.toFixed(0)}d ago; auto-refreshes)` },
  );

  // Anthropic key (the LLM core).
  checks.push(
    process.env.ANTHROPIC_API_KEY
      ? { name: "Anthropic API key", status: "ok", detail: "set" }
      : { name: "Anthropic API key", status: "fail", detail: "not set — LLM flows disabled (add to .env)" },
  );

  // Garmin (optional, degradable). The ~6-month token is the predictable failure mode.
  if (!config.garmin.enabled) {
    checks.push({ name: "Garmin", status: "info", detail: "disabled (optional; GARMIN_ENABLED=false)" });
  } else {
    const gAge = await fileAgeDays(join(homedir(), ".garminconnect", "garmin_tokens.json"));
    if (gAge == null) {
      checks.push({ name: "Garmin auth", status: "warn", detail: "enabled but no token — run garmin-mcp-auth (see .env.example)" });
    } else if (gAge > GARMIN_REAUTH_WARN_DAYS) {
      checks.push({
        name: "Garmin auth",
        status: "warn",
        detail: `token is ${gAge.toFixed(0)}d old (~6mo lifetime) — re-run garmin-mcp-auth soon to avoid a silent break`,
      });
    } else {
      checks.push({ name: "Garmin auth", status: "ok", detail: `token ${gAge.toFixed(0)}d old (re-auth by ~180d)` });
    }
  }

  return checks;
}

// --- HTTP /health surface + remote self-check (PROD hardening) -------------------------------------
//
// The MCP server exposes an UNAUTHENTICATED `/health` so "is the connector up?" is one curl through the
// tunnel instead of an authed probe. A scheduled `health-remote` then hits the PUBLIC url and alerts on
// trouble — so a down tunnel / expired token is noticed before Cowork does.

/** AI Endurance reachability as seen by a probe. */
export type AieHealth = "ok" | "reauth_needed" | "unreachable";

export interface HealthInfo {
  status: "ok" | "degraded";
  service: string;
  version: string;
  readOnly: boolean;
  authMode: string;
  /** Present only on a deep probe (?deep=1). */
  aie?: AieHealth;
  time: string;
}

/** Cheap, no-network snapshot of the server itself. */
export function baseHealth(now: Date = new Date()): HealthInfo {
  return {
    status: "ok",
    service: "endurance-coach-mcp",
    version: "0.1.0",
    readOnly: config.mcp.readOnly,
    authMode: config.mcp.auth,
    time: now.toISOString(),
  };
}

/** Live, non-interactive probe of the AI Endurance spine. Bounded + degradable — never throws. */
export async function aieHealthProbe(timeoutMs?: number): Promise<AieHealth> {
  const aie = new AieClient({ interactive: false, timeoutMs });
  try {
    await aie.connect();
    return "ok";
  } catch (err) {
    return err instanceof ReauthRequiredError ? "reauth_needed" : "unreachable";
  } finally {
    await aie.close();
  }
}

export interface RemoteHealthResult {
  ok: boolean;
  detail: string;
}

/** Turn an HTTP status + parsed /health body into a pass/fail verdict for the self-check. Pure. */
export function interpretRemoteHealth(httpStatus: number | null, body: unknown): RemoteHealthResult {
  if (httpStatus == null) {
    return { ok: false, detail: "unreachable (no response / timeout) — the tunnel or the server is down" };
  }
  if (httpStatus !== 200) {
    return { ok: false, detail: `HTTP ${httpStatus} from /health — server reachable but unhealthy` };
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.status === "ok") return { ok: true, detail: `ok (aie=${b.aie ?? "n/a"})` };
  if (b.aie === "reauth_needed") {
    return { ok: false, detail: "AI Endurance re-auth needed — run `npm run auth:aie` on the host" };
  }
  if (b.aie === "unreachable") return { ok: false, detail: "AI Endurance unreachable from the server" };
  return { ok: false, detail: `degraded (status=${b.status ?? "?"}, aie=${b.aie ?? "?"})` };
}

/** Fetch `<baseUrl>/health?deep=1` and interpret it. `fetchImpl` is injectable so tests stay offline. */
export async function checkRemoteHealth(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<RemoteHealthResult> {
  const url = baseUrl.replace(/\/+$/, "") + "/health?deep=1";
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body — interpret on status alone */
    }
    return interpretRemoteHealth(res.status, body);
  } catch {
    return interpretRemoteHealth(null, undefined);
  }
}

/** Redact anything token-shaped from a string before it reaches a log/notification. */
export function redactSecrets(s: string): string {
  return s
    .replace(/\b(sk-ant-[A-Za-z0-9_-]{6,})\b/g, "sk-ant-***")
    .replace(/\b(gh[opsu]_[A-Za-z0-9]{6,})\b/g, "gh*_***")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer ***")
    .replace(/("?(?:access_token|refresh_token|api_key)"?\s*[:=]\s*)"?[A-Za-z0-9._-]{8,}"?/gi, "$1***");
}
