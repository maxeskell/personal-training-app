import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import open from "open";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { config } from "../config.js";
import { escapeHtml } from "../util/html.js";

/**
 * Thrown when AI Endurance needs an interactive (re)authorization that the current context can't do.
 *
 * Only the explicit CLI `auth` flow runs the browser dance; every other context (the MCP/dashboard
 * server, cron, Cowork) runs NON-interactively and gets this instead — so a missing/expired token fails
 * fast with an actionable message rather than opening a browser nobody can see and blocking for minutes.
 */
export class ReauthRequiredError extends Error {
  readonly code = "AIE_REAUTH_REQUIRED";
  constructor(
    message = "AI Endurance authorization is missing or expired — run `npm run auth:aie` on the host to re-authorize.",
  ) {
    super(message);
    this.name = "ReauthRequiredError";
  }
}

export interface FileOAuthClientProviderOptions {
  /** Whether this context may run the interactive browser + loopback dance. Servers/cron set false. */
  interactive?: boolean;
  /** Browser launcher (defaults to the `open` package). Injectable so tests never open a real browser. */
  openBrowser?: (url: string) => Promise<void>;
  /** Sink for the one-line token-lifecycle audit trail (defaults to stderr → the launchd job logs). */
  log?: (line: string) => void;
}

/** Basename prefix of a retired token file (see invalidateCredentials). */
export const RETIRED_TOKENS_PREFIX = "aie-tokens.revoked-";

/**
 * File-backed OAuth client provider for a single-user CLI.
 *
 * - Persists dynamic client registration, PKCE verifier and tokens under the
 *   secrets dir (gitignored, outside the repo by default).
 * - On `redirectToAuthorization` it opens the system browser and runs a tiny
 *   loopback server to capture the `?code=...` redirect, resolving `waitForCode()`.
 *   In NON-interactive mode it throws `ReauthRequiredError` instead — no browser, no held port.
 *
 * The SDK drives token refresh automatically once tokens are saved here. One file is shared by every
 * process that talks to AI Endurance (dashboard + MCP services, the scheduled jobs, CLI runs, Claude
 * sessions), so the lifecycle below is deliberately conservative:
 *  - saves are atomic (tmp + rename) — a crash mid-write can't leave a truncated file;
 *  - a token the server rejects on refresh (the SDK then calls `invalidateCredentials('tokens')`) is
 *    RETIRED to a timestamped copy, never deleted — it was the only copy, and silently rm-ing it is how
 *    the 30 Aug 2026 outage left no trace;
 *  - every save/retire writes one `[aie-oauth]` audit line (never a token value — a short fingerprint of
 *    the refresh token, so rotation is observable);
 *  - one browser authorization at a time: a second one the SDK starts mid-dance reuses the listener and
 *    keeps the first PKCE verifier (the open tab carries THAT challenge).
 */
export class FileOAuthClientProvider implements OAuthClientProvider {
  private readonly dir = config.secretsDir;
  private readonly tokensPath = join(this.dir, "aie-tokens.json");
  private readonly clientPath = join(this.dir, "aie-client.json");
  private readonly verifierPath = join(this.dir, "aie-verifier.txt");

  private readonly interactive: boolean;
  private readonly openBrowser: (url: string) => Promise<void>;
  private readonly log: (line: string) => void;

  private codePromise?: Promise<string>;
  private codeResolve?: (code: string) => void;
  private codeReject?: (err: Error) => void;
  private callbackServer?: Server;

  constructor(opts: FileOAuthClientProviderOptions = {}) {
    // Default true keeps the original CLI behaviour for any direct user; AieClient passes an explicit value.
    this.interactive = opts.interactive ?? true;
    this.openBrowser = opts.openBrowser ?? ((url) => open(url).then(() => undefined));
    this.log = opts.log ?? ((line) => console.error(line));
  }

  get redirectUrl(): string {
    return config.aie.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Personal Endurance Coach (local)",
      redirect_uris: [config.aie.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: config.aie.scopes.join(" "),
    };
  }

  /** True while a browser authorization is in flight (the loopback listener is up). */
  get authorizationInProgress(): boolean {
    return this.callbackServer != null;
  }

  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    return readJson<OAuthClientInformationFull>(this.clientPath);
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await this.ensureDir();
    await writeJson(this.clientPath, info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return readJson<OAuthTokens>(this.tokensPath);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.ensureDir();
    // Atomic: write beside, then rename over. `saved_at` is ours (the SDK strips unknown keys on its side).
    const tmp = `${this.tokensPath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...tokens, saved_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
    await rename(tmp, this.tokensPath);
    this.event("saved", tokens);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    // A flow already in progress owns the verifier: the browser tab it opened carries THAT code challenge,
    // so a second authorization the SDK starts meanwhile must not overwrite it (the exchange would fail).
    if (this.callbackServer) return;
    await this.ensureDir();
    await writeFile(this.verifierPath, verifier, { mode: 0o600 });
  }

  async codeVerifier(): Promise<string> {
    return readFile(this.verifierPath, "utf8");
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    // The SDK calls this with 'tokens' when the token endpoint answers `invalid_grant` on a refresh — the
    // refresh token on disk is dead (rotated away by a refresh whose reply was lost, or revoked upstream).
    // Retire the file instead of deleting it: the live path must go (so the SDK falls through to a fresh
    // authorization), but a timestamped copy keeps the forensic trail and the audit line says when.
    if (scope === "tokens" || scope === "all") {
      const prior = await this.tokens();
      const kept = await this.retireTokens();
      this.event(`invalidated(${scope})${kept ? ` kept=${kept}` : " no-token-file"}`, prior);
    }
    const rmTargets =
      scope === "all" ? [this.clientPath, this.verifierPath]
      : scope === "client" ? [this.clientPath]
      : scope === "verifier" ? [this.verifierPath]
      : [];
    await Promise.all(rmTargets.map((p) => rm(p, { force: true })));
  }

  /** Opens the browser and starts the loopback listener to capture the code. */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.interactive) {
      // Headless context (server/dashboard/cron/Cowork): never open a browser or hold the loopback port
      // for a human who isn't there. Fail fast so the caller surfaces a clean re-auth error.
      throw new ReauthRequiredError();
    }
    // Idempotent per flow: the SDK can start a second authorization from another 401 in the same process
    // (it did, from its background event-stream GET). One tab, one listener, one verifier.
    if (this.callbackServer) return;
    await this.startCallbackServer();
    console.log("\nOpening your browser to authorize AI Endurance…");
    console.log(`If it doesn't open, visit:\n  ${authorizationUrl.toString()}\n`);
    await this.openBrowser(authorizationUrl.toString()).catch(() => {
      /* headless: user uses the printed URL */
    });
  }

  /** Resolves with the authorization code once the redirect arrives. */
  waitForCode(timeoutMs = 300_000): Promise<string> {
    if (!this.codePromise) {
      throw new Error(
        "waitForCode() called before redirectToAuthorization(); no flow in progress.",
      );
    }
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<string>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out waiting for OAuth redirect.")), timeoutMs);
    });
    // Always free the loopback port + listener once the flow settles (success OR timeout) — otherwise a
    // timed-out flow leaks the callback server and holds the redirect port.
    return Promise.race([this.codePromise, timeout]).finally(() => {
      clearTimeout(timer);
      this.closeCallbackServer();
    });
  }

  /** Resolves once the loopback is listening; rejects (cleanly, not a crash) if the port can't be bound. */
  private startCallbackServer(): Promise<void> {
    this.codePromise = new Promise<string>((resolve, reject) => {
      this.codeResolve = resolve;
      this.codeReject = reject;
    });
    // A listener error can reject the code promise before anyone awaits it — mark it handled so that
    // can't surface as an unhandled rejection; waitForCode() still sees the rejection.
    this.codePromise.catch(() => {});

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${config.aie.redirectPort}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("Not found");
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html" });
      if (code) {
        res.end("<h3>Authorized ✓</h3><p>You can close this tab and return to the terminal.</p>");
        this.codeResolve?.(code);
      } else {
        // Escape the reflected error param — it's attacker-influenceable in the redirect, and even on a
        // transient loopback server an unescaped reflection is reflected XSS.
        res.end(`<h3>Authorization failed</h3><p>${escapeHtml(error ?? "no code returned")}</p>`);
        this.codeReject?.(new Error(`OAuth redirect error: ${error ?? "no code"}`));
      }
      this.closeCallbackServer();
    });
    this.callbackServer = server;

    return new Promise<void>((resolve, reject) => {
      server.once("error", (err: Error) => {
        const wrapped = new Error(
          `OAuth loopback on port ${config.aie.redirectPort} failed: ${err.message} (is another \`npm run auth:aie\` running?)`,
        );
        this.codeReject?.(wrapped);
        this.closeCallbackServer();
        reject(wrapped);
      });
      // Bind loopback only: the OAuth redirect callback is for THIS machine's browser during the ~few-minute
      // auth window; binding 0.0.0.0 would needlessly expose it on the LAN. (The redirect URI is localhost.)
      server.listen(config.aie.redirectPort, "127.0.0.1", () => resolve());
    });
  }

  private closeCallbackServer(): void {
    this.callbackServer?.close();
    this.callbackServer = undefined;
  }

  /** Move aie-tokens.json aside as `aie-tokens.revoked-<time>.json` (same dir, same 0600 mode). Returns the
   *  new basename, or null when there was no live file to retire. */
  private async retireTokens(): Promise<string | null> {
    const name = `${RETIRED_TOKENS_PREFIX}${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    try {
      await rename(this.tokensPath, join(this.dir, name));
      return name;
    } catch {
      return null; // nothing on disk — the SDK already fell through to a fresh authorization
    }
  }

  /** One audit line per lifecycle event. No token values: a short fingerprint of the refresh token only. */
  private event(name: string, tokens?: OAuthTokens): void {
    const fp = tokens?.refresh_token ? ` refresh=${fingerprint(tokens.refresh_token)}` : "";
    this.log(`[aie-oauth] ${new Date().toISOString()} pid=${process.pid} event=${name}${fp}`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }
}

/** First 8 hex chars of SHA-256 — enough to see a rotation in the logs, useless for recovering the value. */
function fingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 8);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function writeJson(path: string, value: unknown, mode = 0o644): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), { mode });
}
