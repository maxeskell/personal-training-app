import { randomBytes } from "node:crypto";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { timingSafeEqualStr } from "../serverAuth.js";

/**
 * Single-user OAuth 2.1 provider for the coach MCP server — what a remote Claude client (Cowork)
 * needs to connect, since those custom connectors authenticate via OAuth, not a static token.
 *
 * It supports Dynamic Client Registration (Claude self-registers), and PKCE is verified by the SDK's
 * token handler (we only store/return the challenge). The authorization step is gated by YOUR coach
 * token: Claude opens the authorize URL in your browser, you paste the token to approve, and only then
 * is a code issued — so possessing the token is what grants access. Codes/tokens are in-memory and
 * cleared on restart (Claude transparently re-authorizes).
 */

const CODE_TTL_MS = 5 * 60_000; // authorization codes: 5 minutes
const ACCESS_TTL_S = 60 * 60; // access tokens: 1 hour

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
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

/** In-memory client registry. The SDK register handler sets the client_id before calling registerClient. */
class InMemoryClients implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }
  registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): OAuthClientInformationFull {
    const full = client as OAuthClientInformationFull; // register handler has already assigned client_id
    this.clients.set(full.client_id, full);
    return full;
  }
}

export class CoachOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new InMemoryClients();
  private readonly codes = new Map<string, CodeRecord>();
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly refreshTokens = new Map<string, { clientId: string; scopes: string[]; resource?: string }>();

  constructor(private readonly coachToken: string) {}

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

    const code = randomBytes(24).toString("hex");
    this.codes.set(code, {
      clientId: f.clientId,
      challenge: f.codeChallenge,
      redirectUri: f.redirectUri,
      scopes: f.scope ? f.scope.split(" ").filter(Boolean) : [],
      resource: f.resource || undefined,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
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
    const granted = scopes && scopes.length ? scopes.filter((s) => rec.scopes.includes(s)) : rec.scopes;
    return this.issue(client.client_id, granted, rec.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = this.tokens.get(token);
    if (!rec) throw new Error("invalid_token");
    if (Date.now() > rec.expiresAt) {
      this.tokens.delete(token);
      throw new Error("invalid_token: expired");
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
    this.refreshTokens.set(refresh, { clientId, scopes, resource });
    return {
      access_token: access,
      token_type: "bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope: scopes.join(" ") || undefined,
    };
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
<form method="POST" action="/coach/approve">
${hid("client_id", f.clientId)}${hid("redirect_uri", f.redirectUri)}${hid("state", f.state)}${hid("code_challenge", f.codeChallenge)}${hid("scope", f.scope)}${hid("resource", f.resource)}
<label>Coach token<br><input type="password" name="coach_token" autocomplete="off" autofocus></label>
<button type="submit">Approve access</button>
</form>
<p class="muted">Your token is in <code>~/.endurance-coach/mcp.token</code> on your Mac (or whatever you set <code>COACH_MCP_TOKEN</code> to).</p>
</div></body></html>`;
  }
}
