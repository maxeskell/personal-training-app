import { stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { config } from "./config.js";

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

/** Redact anything token-shaped from a string before it reaches a log/notification. */
export function redactSecrets(s: string): string {
  return s
    .replace(/\b(sk-ant-[A-Za-z0-9_-]{6,})\b/g, "sk-ant-***")
    .replace(/\b(gh[opsu]_[A-Za-z0-9]{6,})\b/g, "gh*_***")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer ***")
    .replace(/("?(?:access_token|refresh_token|api_key)"?\s*[:=]\s*)"?[A-Za-z0-9._-]{8,}"?/gi, "$1***");
}
