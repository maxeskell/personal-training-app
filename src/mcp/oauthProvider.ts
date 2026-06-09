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

/**
 * File-backed OAuth client provider for a single-user CLI.
 *
 * - Persists dynamic client registration, PKCE verifier and tokens under the
 *   secrets dir (gitignored, outside the repo by default).
 * - On `redirectToAuthorization` it opens the system browser and runs a tiny
 *   loopback server to capture the `?code=...` redirect, resolving `waitForCode()`.
 *
 * The SDK drives token refresh automatically once tokens are saved here.
 */
export class FileOAuthClientProvider implements OAuthClientProvider {
  private readonly dir = config.secretsDir;
  private readonly tokensPath = join(this.dir, "aie-tokens.json");
  private readonly clientPath = join(this.dir, "aie-client.json");
  private readonly verifierPath = join(this.dir, "aie-verifier.txt");

  private codePromise?: Promise<string>;
  private codeResolve?: (code: string) => void;
  private codeReject?: (err: Error) => void;
  private callbackServer?: Server;

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
        res.end(`<h3>Authorization failed</h3><p>${error ?? "no code returned"}</p>`);
        this.codeReject?.(new Error(`OAuth redirect error: ${error ?? "no code"}`));
      }
      this.closeCallbackServer();
    });

    this.callbackServer.listen(config.aie.redirectPort);
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
