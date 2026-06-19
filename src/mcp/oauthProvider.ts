import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
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

/**
 * File-backed OAuth client provider for a single-user CLI.
 *
 * - Persists dynamic client registration, PKCE verifier and tokens under the
 *   secrets dir (gitignored, outside the repo by default).
 * - On `redirectToAuthorization` it opens the system browser and runs a tiny
 *   loopback server to capture the `?code=...` redirect, resolving `waitForCode()`.
 *   In NON-interactive mode it throws `ReauthRequiredError` instead — no browser, no held port.
 *
 * The SDK drives token refresh automatically once tokens are saved here.
 */
export class FileOAuthClientProvider implements OAuthClientProvider {
  private readonly dir = config.secretsDir;
  private readonly tokensPath = join(this.dir, "aie-tokens.json");
  private readonly clientPath = join(this.dir, "aie-client.json");
  private readonly verifierPath = join(this.dir, "aie-verifier.txt");

  /** Whether this context may run the interactive browser + loopback dance. Servers/cron set false. */
  private readonly interactive: boolean;

  private codePromise?: Promise<string>;
  private codeResolve?: (code: string) => void;
  private codeReject?: (err: Error) => void;
  private callbackServer?: Server;

  constructor(opts: { interactive?: boolean } = {}) {
    // Default true keeps the original CLI behaviour for any direct user; AieClient passes an explicit value.
    this.interactive = opts.interactive ?? true;
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
    await writeJson(this.tokensPath, tokens, 0o600);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.ensureDir();
    await writeFile(this.verifierPath, verifier, { mode: 0o600 });
  }

  async codeVerifier(): Promise<string> {
    return readFile(this.verifierPath, "utf8");
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    const targets: Record<string, string[]> = {
      all: [this.tokensPath, this.clientPath, this.verifierPath],
      client: [this.clientPath],
      tokens: [this.tokensPath],
      verifier: [this.verifierPath],
      discovery: [],
    };
    await Promise.all(
      (targets[scope] ?? []).map((p) => rm(p, { force: true })),
    );
  }

  /** Opens the browser and starts the loopback listener to capture the code. */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.interactive) {
      // Headless context (server/dashboard/cron/Cowork): never open a browser or hold the loopback port
      // for a human who isn't there. Fail fast so the caller surfaces a clean re-auth error.
      throw new ReauthRequiredError();
    }
    this.startCallbackServer();
    console.log("\nOpening your browser to authorize AI Endurance…");
    console.log(`If it doesn't open, visit:\n  ${authorizationUrl.toString()}\n`);
    await open(authorizationUrl.toString()).catch(() => {
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
    const timeout = new Promise<string>((_, reject) =>
      setTimeout(
        () => reject(new Error("Timed out waiting for OAuth redirect.")),
        timeoutMs,
      ),
    );
    // Always free the loopback port + listener once the flow settles (success OR timeout) — otherwise a
    // timed-out flow leaks the callback server and holds the redirect port.
    return Promise.race([this.codePromise, timeout]).finally(() => this.closeCallbackServer());
  }

  private startCallbackServer(): void {
    this.codePromise = new Promise<string>((resolve, reject) => {
      this.codeResolve = resolve;
      this.codeReject = reject;
    });

    this.callbackServer = createServer((req, res) => {
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

    // Bind loopback only: the OAuth redirect callback is for THIS machine's browser during the ~few-minute
    // auth window; binding 0.0.0.0 would needlessly expose it on the LAN. (The redirect URI is localhost.)
    this.callbackServer.listen(config.aie.redirectPort, "127.0.0.1");
  }

  private closeCallbackServer(): void {
    this.callbackServer?.close();
    this.callbackServer = undefined;
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }
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
