import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { timingSafeEqualStr } from "../serverAuth.js";
import { escapeHtml as esc } from "../util/html.js";

/**
 * Single-user OAuth 2.1 provider for the coach MCP server — what a remote Claude client (Cowork)
 * needs to connect, since those custom connectors authenticate via OAuth, not a static token.
 *
 * It supports Dynamic Client Registration (Claude self-registers), and PKCE is verified by the SDK's
 * token handler (we only store/return the challenge). The authorization step is gated by YOUR coach
 * token: Claude opens the authorize URL in your browser, you paste the token to approve, and only then
 * is a code issued — so possessing the token is what grants access. Codes/tokens are in-memory and
 * cleared on restart (Claude transparently re-authorizes).
 *
 * Hardening (defense-in-depth for an internet-reachable surface):
 *  - issued tokens carry the `coach` scope and (when the client requested one) a resource that is
 *    checked against THIS server on every verify — a token isn't a bearer-for-anything;
 *  - dynamic registration rejects non-HTTPS / non-loopback redirect URIs (anti-phishing);
 *  - all in-memory stores are bounded and expired entries are swept, so a long-running always-on
 *    service can't be grown without limit (DoS).
 */

const CODE_TTL_MS = 5 * 60_000; // authorization codes: 5 minutes
const ACCESS_TTL_S = 60 * 60; // access tokens: 1 hour
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000; // refresh tokens: 30 days
const MAX_CLIENTS = 100; // registered clients kept (oldest evicted past this)
const MAX_CODES = 500; // outstanding auth codes
const MAX_TOKENS = 1000; // outstanding access/refresh tokens

/** A redirect URI is allowed only if it's HTTPS or a loopback http URL (the standard OAuth exceptions). */
export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1" || u.hostname === "[::1]")) return true;
  return false;
}

interface CodeRecord {
  clientId: string;
  challenge: string;
  redirectUri: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}
interface TokenRecord {
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}
interface RefreshRecord {
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}
interface ConsentFields {
  clientLabel: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope: string;
  resource: string;
}

export interface ApproveResult {
  ok: boolean;
  redirect?: string;
  html?: string;
  status?: number;
}

/** Drop the oldest entries from a Map until it's at most `max` long (insertion order = oldest first). */
function capMap<K, V>(m: Map<K, V>, max: number): void {
  while (m.size > max) {
    const oldest = m.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}

/** In-memory client registry. The SDK register handler sets the client_id before calling registerClient. */
class InMemoryClients implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  constructor(private readonly onChange?: () => void) {}
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }
  registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): OAuthClientInformationFull {
    const full = client as OAuthClientInformationFull; // register handler has already assigned client_id
    // Reject clients whose redirect URIs aren't HTTPS/loopback — narrows the phishing/redirect surface.
    for (const uri of full.redirect_uris ?? []) {
      if (!isAllowedRedirectUri(uri)) {
        throw new Error(`invalid redirect_uri: ${uri} (must be https:// or loopback http://)`);
      }
    }
    this.clients.set(full.client_id, full);
    capMap(this.clients, MAX_CLIENTS); // bound growth on an always-on, openly-registrable server
    this.onChange?.(); // persist the registration so a client survives a restart
    return full;
  }
  all(): OAuthClientInformationFull[] {
    return [...this.clients.values()];
  }
  restore(list: OAuthClientInformationFull[]): void {
    for (const c of list) this.clients.set(c.client_id, c);
  }
}

export class CoachOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: InMemoryClients;
  private readonly codes = new Map<string, CodeRecord>();
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly refreshTokens = new Map<string, RefreshRecord>();
  private readonly persistent: boolean;

  /**
   * @param resourceUrl this server's canonical resource URL (e.g. https://host/mcp) for audience binding.
   * @param opts.persist when true, registered clients + issued tokens are written to
   *   `<secretsDir>/mcp-oauth.json` (0600) and reloaded on construct, so a Claude connection survives a
   *   server restart with no re-authorization. Short-lived auth codes are never persisted.
   */
  constructor(
    private readonly coachToken: string,
    private readonly resourceUrl?: string,
    opts?: { persist?: boolean },
  ) {
    this.persistent = opts?.persist ?? false;
    this.clientsStore = new InMemoryClients(() => this.persist());
    if (this.persistent) this.load();
  }

  private storePath(): string {
    return join(config.secretsDir, "mcp-oauth.json");
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.storePath(), "utf8")) as {
        clients?: OAuthClientInformationFull[];
        tokens?: Array<[string, TokenRecord]>;
        refreshTokens?: Array<[string, RefreshRecord]>;
      };
      const now = Date.now();
      this.clientsStore.restore(raw.clients ?? []);
      for (const [k, v] of raw.tokens ?? []) if (v.expiresAt > now) this.tokens.set(k, v);
      for (const [k, v] of raw.refreshTokens ?? []) if (v.expiresAt > now) this.refreshTokens.set(k, v);
    } catch {
      /* no store yet, or unreadable — start empty */
    }
  }

  private persist(): void {
    if (!this.persistent) return;
    try {
      mkdirSync(config.secretsDir, { recursive: true });
      const data = { clients: this.clientsStore.all(), tokens: [...this.tokens], refreshTokens: [...this.refreshTokens] };
      writeFileSync(this.storePath(), JSON.stringify(data), { mode: 0o600 });
    } catch {
      /* best-effort: a failed persist must never break the auth flow */
    }
  }

  /** authorize handler entry — render the coach-token-gated consent page (no code issued yet). */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(
      this.renderConsent(
        {
          clientLabel: client.client_name || client.client_id,
          clientId: client.client_id,
          redirectUri: params.redirectUri,
          state: params.state ?? "",
          codeChallenge: params.codeChallenge,
          scope: (params.scopes ?? []).join(" "),
          resource: params.resource?.href ?? "",
        },
        null,
      ),
    );
  }

  /** Consent form POST: verify the coach token, then issue an auth code + the redirect back to Claude. */
  approve(body: Record<string, unknown>): ApproveResult {
    const f: ConsentFields & { coachToken: string } = {
      coachToken: String(body.coach_token ?? ""),
      clientLabel: String(body.client_id ?? ""),
      clientId: String(body.client_id ?? ""),
      redirectUri: String(body.redirect_uri ?? ""),
      state: String(body.state ?? ""),
      codeChallenge: String(body.code_challenge ?? ""),
      scope: String(body.scope ?? ""),
      resource: String(body.resource ?? ""),
    };

    if (!timingSafeEqualStr(f.coachToken, this.coachToken)) {
      return { ok: false, status: 401, html: this.renderConsent(f, "That coach token didn't match. Try again.") };
    }
    const client = this.clientsStore.getClient(f.clientId);
    if (!client || !f.redirectUri) {
      return { ok: false, status: 400, html: this.renderConsent(f, "Unknown client or redirect — restart the connection from Claude.") };
    }
    if (!client.redirect_uris.includes(f.redirectUri)) {
      return { ok: false, status: 400, html: this.renderConsent(f, "Redirect URL is not registered for this client.") };
    }

    // Always grant the `coach` scope (single-scope server) so the token is consistently labelled.
    const scopes = f.scope ? f.scope.split(" ").filter(Boolean) : [];
    if (!scopes.includes("coach")) scopes.push("coach");

    const code = randomBytes(24).toString("hex");
    this.codes.set(code, {
      clientId: f.clientId,
      challenge: f.codeChallenge,
      redirectUri: f.redirectUri,
      scopes,
      resource: f.resource || undefined,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    this.prune();
    const url = new URL(f.redirectUri);
    url.searchParams.set("code", code);
    if (f.state) url.searchParams.set("state", f.state);
    return { ok: true, redirect: url.href };
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const rec = this.codes.get(authorizationCode);
    if (!rec || rec.clientId !== client.client_id) throw new Error("invalid_grant: unknown authorization code");
    return rec.challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const rec = this.codes.get(authorizationCode);
    if (!rec || rec.clientId !== client.client_id) throw new Error("invalid_grant: unknown authorization code");
    this.codes.delete(authorizationCode); // single-use, regardless of outcome below
    if (Date.now() > rec.expiresAt) throw new Error("invalid_grant: authorization code expired");
    if (redirectUri && redirectUri !== rec.redirectUri) throw new Error("invalid_grant: redirect_uri mismatch");
    return this.issue(client.client_id, rec.scopes, rec.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const rec = this.refreshTokens.get(refreshToken);
    if (!rec || rec.clientId !== client.client_id) throw new Error("invalid_grant: unknown refresh token");
    this.refreshTokens.delete(refreshToken); // rotate on use
    if (Date.now() > rec.expiresAt) throw new Error("invalid_grant: refresh token expired");
    const granted = scopes && scopes.length ? scopes.filter((s) => rec.scopes.includes(s)) : rec.scopes;
    return this.issue(client.client_id, granted, rec.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = this.tokens.get(token);
    if (!rec) throw new Error("invalid_token");
    if (Date.now() > rec.expiresAt) {
      this.tokens.delete(token);
      this.persist();
      throw new Error("invalid_token: expired");
    }
    // Audience binding (RFC 8707): a token scoped to a different resource must not be accepted here.
    // Lenient when the client never sent a resource (token unbound) — strict only on an actual mismatch.
    if (rec.resource && this.resourceUrl && rec.resource !== this.resourceUrl) {
      throw new Error("invalid_token: wrong resource (audience mismatch)");
    }
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: Math.floor(rec.expiresAt / 1000),
      resource: rec.resource ? new URL(rec.resource) : undefined,
    };
  }

  private issue(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const access = randomBytes(32).toString("hex");
    const refresh = randomBytes(32).toString("hex");
    this.tokens.set(access, { clientId, scopes, resource, expiresAt: Date.now() + ACCESS_TTL_S * 1000 });
    this.refreshTokens.set(refresh, { clientId, scopes, resource, expiresAt: Date.now() + REFRESH_TTL_MS });
    this.prune();
    return {
      access_token: access,
      token_type: "bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope: scopes.join(" ") || undefined,
    };
  }

  /** Sweep expired entries and bound each store — keeps an always-on server from growing without limit. */
  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.codes) if (now > v.expiresAt) this.codes.delete(k);
    for (const [k, v] of this.tokens) if (now > v.expiresAt) this.tokens.delete(k);
    for (const [k, v] of this.refreshTokens) if (now > v.expiresAt) this.refreshTokens.delete(k);
    capMap(this.codes, MAX_CODES);
    capMap(this.tokens, MAX_TOKENS);
    capMap(this.refreshTokens, MAX_TOKENS);
    this.persist(); // issue()/approve() both prune, so this captures every token/code mutation to disk
  }

  private renderConsent(f: ConsentFields, error: string | null): string {
    const hid = (name: string, val: string) => `<input type="hidden" name="${esc(name)}" value="${esc(val)}">`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Endurance Coach</title>
<style>body{font:16px/1.5 system-ui,-apple-system,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem;color:#111}
.card{border:1px solid #e3e3e3;border-radius:14px;padding:1.5rem;box-shadow:0 1px 4px rgba(0,0,0,.06)}
h1{font-size:1.2rem;margin:.2rem 0 1rem}input[type=password]{width:100%;padding:.6rem;font-size:1rem;border:1px solid #bbb;border-radius:8px;box-sizing:border-box}
button{margin-top:1rem;width:100%;padding:.7rem;font-size:1rem;border:0;border-radius:8px;background:#111;color:#fff;cursor:pointer}
.err{color:#b00020;margin:.5rem 0}.muted{color:#666;font-size:.85rem;margin-top:1rem}</style></head>
<body><div class="card"><h1>Authorize <strong>${esc(f.clientLabel)}</strong></h1>
<p>A Claude client wants to connect to your Endurance Coach. Paste your coach token to approve — only you have it.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<p class="muted">It will redirect to: <code>${esc(f.redirectUri)}</code></p>
<form method="POST" action="/coach/approve">
${hid("client_id", f.clientId)}${hid("redirect_uri", f.redirectUri)}${hid("state", f.state)}${hid("code_challenge", f.codeChallenge)}${hid("scope", f.scope)}${hid("resource", f.resource)}
<label>Coach token<br><input type="password" name="coach_token" autocomplete="off" autofocus></label>
<button type="submit">Approve access</button>
</form>
<p class="muted">Your token is in <code>~/.endurance-coach/mcp.token</code> on your Mac (or whatever you set <code>COACH_MCP_TOKEN</code> to).</p>
</div></body></html>`;
  }
}
