import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Auth + origin defenses for the local dashboard server (Spec 1). The server can reach AI Endurance
 * WRITES and spend LLM budget, so every route is gated by a per-install token (cookie or header), the
 * Host header is allow-listed to defeat DNS-rebinding, and request bodies are capped. Pure, unit-tested
 * helpers live here; server.ts wires them.
 */

/** Token for this install: COACH_TOKEN env, else a random token persisted under the secrets dir. */
export function loadDashboardToken(): string {
  if (process.env.COACH_TOKEN) return process.env.COACH_TOKEN;
  const path = join(config.secretsDir, "dashboard.token");
  try {
    const t = readFileSync(path, "utf8").trim();
    if (t) return t;
  } catch {
    /* create below */
  }
  const tok = randomBytes(24).toString("hex");
  try {
    mkdirSync(config.secretsDir, { recursive: true });
    writeFileSync(path, tok, { mode: 0o600 });
  } catch {
    /* fall back to in-memory token for this process */
  }
  return tok;
}

/** Bearer token for the MCP HTTP surface: COACH_MCP_TOKEN env, else a random token persisted 0600. */
export function loadMcpToken(): string {
  if (process.env.COACH_MCP_TOKEN) return process.env.COACH_MCP_TOKEN;
  const path = join(config.secretsDir, "mcp.token");
  try {
    const t = readFileSync(path, "utf8").trim();
    if (t) return t;
  } catch {
    /* create below */
  }
  const tok = randomBytes(24).toString("hex");
  try {
    mkdirSync(config.secretsDir, { recursive: true });
    writeFileSync(path, tok, { mode: 0o600 });
  } catch {
    /* fall back to in-memory token for this process */
  }
  return tok;
}

/** Pull the token out of an `Authorization: Bearer <token>` header. Undefined when absent/malformed. */
export function bearerToken(headers: { authorization?: string | string[] }): string | undefined {
  const h = headers.authorization;
  const v = Array.isArray(h) ? h[0] : h;
  if (!v) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(v.trim());
  return m ? m[1].trim() : undefined;
}

/** True iff the request carries the expected bearer token (constant-time compare). */
export function bearerAuthorized(headers: { authorization?: string | string[] }, token: string): boolean {
  const p = bearerToken(headers);
  return p != null && timingSafeEqualStr(p, token);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Token presented via the X-Coach-Token header or the coach_auth cookie. */
export function presentedToken(headers: { cookie?: string; "x-coach-token"?: string | string[] }): string | undefined {
  const h = headers["x-coach-token"];
  if (typeof h === "string" && h) return h;
  return parseCookies(headers.cookie) ["coach_auth"] || undefined;
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export function isAuthorized(headers: { cookie?: string; "x-coach-token"?: string | string[] }, token: string): boolean {
  const p = presentedToken(headers);
  return p != null && timingSafeEqualStr(p, token);
}

/**
 * The Host header host-part must be localhost or an explicitly-allowed host (the machine's own LAN IPs
 * when LAN mode is on). A rebound DNS name (attacker.com → 127.0.0.1) carries Host: attacker.com and is
 * rejected, so a malicious web page can't drive the local server.
 */
export function hostAllowed(hostHeader: string | undefined, allowed: string[] = []): boolean {
  if (!hostHeader) return false;
  // strip port; handle bracketed IPv6
  const host = hostHeader.startsWith("[") ? hostHeader.slice(0, hostHeader.indexOf("]") + 1) : hostHeader.split(":")[0];
  const set = new Set(["localhost", "127.0.0.1", "[::1]", "::1", ...allowed.map((h) => h.toLowerCase())]);
  return set.has(host.toLowerCase());
}

/**
 * Extra Host values always permitted, parsed from COACH_ALLOWED_HOSTS (comma/space separated). This is
 * how a *stable* remote name reaches the dashboard — e.g. a Tailscale IP / MagicDNS name so a phone can
 * open it from anywhere. Unlike the live LAN IPs (recomputed from the interfaces at startup, so a reboot
 * that races the dashboard ahead of Tailscale can drop them), a configured host is a static string that
 * always matches — it works even if Tailscale connects after the server boots. Each entry is lower-cased
 * with any scheme + port stripped, so "https://Foo.ts.net:3000" and "foo.ts.net" both match the Host check.
 */
export function parseAllowedHosts(env: string | undefined): string[] {
  if (!env) return [];
  return env
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, ""))
    .filter(Boolean)
    .map((h) => (h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0])) // strip port (IPv6-safe)
    .filter(Boolean);
}

export const COOKIE = (token: string): string => `coach_auth=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
