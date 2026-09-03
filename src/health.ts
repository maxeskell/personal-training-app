import { stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { config } from "./config.js";
import { AieClient, ReauthRequiredError, UnauthorizedError } from "./mcp/aieClient.js";
import { RETIRED_TOKENS_PREFIX } from "./mcp/oauthProvider.js";

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

/** Basenames of retired token copies in the secrets dir, oldest first. Empty when none / dir absent. */
async function retiredTokenFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.startsWith(RETIRED_TOKENS_PREFIX)).sort();
  } catch {
    return [];
  }
}

export async function fileChecks(): Promise<Check[]> {
  const checks: Check[] = [];

  // AI Endurance OAuth (the required spine). File presence/age only — a present-but-revoked token looks
  // identical here; `doctor`'s live "AI Endurance live read" line is the honest check.
  const aieAge = await fileAgeDays(join(config.secretsDir, "aie-tokens.json"));
  checks.push(
    aieAge == null
      ? { name: "AI Endurance auth", status: "fail", detail: "no cached token — run `npm run auth:aie`" }
      : { name: "AI Endurance auth", status: "ok", detail: `token present (last saved ${aieAge.toFixed(0)}d ago; refreshed on demand)` },
  );
  // A retired copy means a refresh was rejected (invalid_grant) at that moment — the audit trail of the
  // token-loss failure mode (see docs/data-sources.md → "AI Endurance token lifecycle").
  const retired = await retiredTokenFiles(config.secretsDir);
  if (retired.length) {
    checks.push({
      name: "AI Endurance retired tokens",
      status: "info",
      detail: `${retired.length} rejected-token cop${retired.length === 1 ? "y" : "ies"} kept (latest ${retired.at(-1)}) — a refresh was refused then; delete them once understood`,
    });
  }

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

/** The Garmin tool that pulls a raw per-second .FIT (garmin_mcp ≥ d31de79). Absent on older builds. */
const GARMIN_STREAM_TOOL = "download_activity_file";
/** Warn once Garmin daily data is this stale — wellness (RHR/HRV) uploads every worn day, so a >3-day
 *  gap means the sync pipeline is broken (a crashed subprocess, an expired token), not just a rest week. */
export const GARMIN_STALE_WARN_DAYS = 3;

/**
 * Freshness of the archived Garmin *daily* stream — the early-warning signal that a silent Garmin outage
 * (like the mcp-2.0 import crash) went unnoticed for weeks. PURE: takes the newest archived daily date and
 * `now`, returns a Check. `null` when Garmin is disabled (nothing to watch) or has no data yet (fresh setup
 * is not a fault). This is what turns "everything degraded quietly" into a visible ⚠.
 */
export function garminFreshnessCheck(
  newestDailyIso: string | null,
  now: Date,
  enabled: boolean,
  staleWarnDays: number = GARMIN_STALE_WARN_DAYS,
): Check | null {
  if (!enabled) return null;
  if (!newestDailyIso) return { name: "Garmin freshness", status: "info", detail: "no Garmin daily data archived yet" };
  const ageDays = (now.getTime() - new Date(`${newestDailyIso}T00:00:00Z`).getTime()) / 86_400_000;
  if (ageDays > staleWarnDays) {
    return {
      name: "Garmin freshness",
      status: "warn",
      detail: `newest Garmin daily is ${newestDailyIso} (${ageDays.toFixed(0)}d ago) — sync looks stalled; run \`npm run doctor\` for the live reason`,
    };
  }
  return { name: "Garmin freshness", status: "ok", detail: `newest Garmin daily ${newestDailyIso} (${ageDays.toFixed(0)}d ago)` };
}

/**
 * LIVE Garmin liveness: actually spawn the garmin_mcp subprocess and list its tools. This is the check
 * that would have caught the mcp-2.0 crash immediately — the old doctor only read the token's *age*, which
 * stayed green through a 4-week total outage. Best-effort and self-closing; never throws. Only meaningful
 * when Garmin is enabled (callers guard on `config.garmin.enabled`).
 */
export async function garminLiveCheck(): Promise<Check> {
  const { GarminClient } = await import("./mcp/garminClient.js");
  const g = new GarminClient();
  try {
    const connected = await g.connect();
    if (!connected) {
      return { name: "Garmin live", status: "warn", detail: `unreachable — ${g.lastError ?? "subprocess failed to start"} (degrading to AI Endurance only)` };
    }
    const tools = await g.listToolNames();
    if (!tools.includes(GARMIN_STREAM_TOOL)) {
      return { name: "Garmin live", status: "warn", detail: `connected (${tools.length} tools) but no ${GARMIN_STREAM_TOOL} — old garmin_mcp build; raw .FIT download unavailable` };
    }
    return { name: "Garmin live", status: "ok", detail: `connected, ${tools.length} tools incl. ${GARMIN_STREAM_TOOL} (raw .FIT download available)` };
  } finally {
    await g.close();
  }
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

/** The slice of AieClient the probe needs — injectable so the probe is unit-testable with no network. */
export interface AieProbeClient {
  connect(): Promise<void>;
  read(tool: "getUser"): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Live, non-interactive probe of the AI Endurance spine. Bounded + degradable — never throws.
 * connect() alone is NOT health: AI Endurance answers `initialize` without a token (verified 2026-09-02),
 * so a connect-only probe read "ok" for ~30 h of the 30 Aug 2026 outage with no token on disk. One
 * authenticated read (getUser, the cheapest tool) is the actual test.
 */
export async function aieHealthProbe(
  timeoutMs?: number,
  makeClient: () => AieProbeClient = () => new AieClient({ interactive: false, timeoutMs }),
): Promise<AieHealth> {
  const aie = makeClient();
  try {
    await aie.connect();
    await aie.read("getUser");
    return "ok";
  } catch (err) {
    return err instanceof ReauthRequiredError || err instanceof UnauthorizedError ? "reauth_needed" : "unreachable";
  } finally {
    await aie.close().catch(() => {});
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

// redactSecrets moved to ./util/redact.js (a dependency-free leaf) so the AI Endurance / intervals
// error paths can use it without importing health.ts (which imports aieClient → would be a cycle).
// Re-exported here so existing importers keep working.
export { redactSecrets } from "./util/redact.js";

// --- Healthcheck notification dedup (spec 11) ---------------------------------------------------------
//
// cmdHealthRemote used to notify on EVERY failing run — ~100 identical banners in two days during the
// 30 Aug 2026 outage, then silence when the probe went blind — which the app couldn't tell apart from zero
// banners. Notify on change (fail, a different failure, recovery) plus one daily reminder while still down.

export interface HealthNotifyState {
  lastOk: boolean;
  lastDetail: string;
  firstFailTs?: string;
  lastNotifiedTs?: string;
  lastOkTs?: string;
}

export const HEALTH_REMIND_MS = 24 * 3_600_000;

/** Pure: given the previous state and this run's verdict, whether to notify, what to say, and the next state. */
export function healthNotifyDecision(
  prev: HealthNotifyState | null,
  result: RemoteHealthResult,
  now: Date,
  remindMs: number = HEALTH_REMIND_MS,
): { notify: boolean; message: string; next: HealthNotifyState } {
  const ts = now.toISOString();
  if (result.ok) {
    const recovered = prev ? !prev.lastOk : false;
    const hours = prev?.firstFailTs ? Math.round((now.getTime() - new Date(prev.firstFailTs).getTime()) / 3_600_000) : null;
    return {
      notify: recovered,
      message: recovered ? `Recovered${hours != null ? ` after ${hours}h` : ""} — ${result.detail}` : "",
      next: { lastOk: true, lastDetail: result.detail, lastOkTs: ts },
    };
  }
  const stillDown = !!prev && !prev.lastOk;
  const firstFailTs = stillDown ? (prev!.firstFailTs ?? ts) : ts;
  const changed = !stillDown || prev!.lastDetail !== result.detail;
  const lastNotified = stillDown ? prev!.lastNotifiedTs : undefined;
  const reminderDue = !lastNotified || now.getTime() - new Date(lastNotified).getTime() >= remindMs;
  const notify = changed || reminderDue;
  const message = changed ? result.detail : `Still failing since ${firstFailTs.slice(0, 16).replace("T", " ")} — ${result.detail}`;
  return {
    notify,
    message,
    next: { lastOk: false, lastDetail: result.detail, firstFailTs, lastNotifiedTs: notify ? ts : lastNotified, lastOkTs: prev?.lastOkTs },
  };
}
