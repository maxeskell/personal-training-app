import { createServer, type IncomingMessage } from "node:http";
import { pathToFileURL } from "node:url";
import express from "express";
import rateLimit from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { config } from "./config.js";
import { buildServer } from "./mcpServer.js";
import { loadMcpToken, bearerAuthorized } from "./serverAuth.js";
import { CoachOAuthProvider } from "./auth/coachOAuthProvider.js";
import { baseHealth, aieHealthProbe } from "./health.js";

/**
 * HTTP (Streamable HTTP) transport for the coach MCP server. For clients that can only reach a remote
 * URL — notably Claude Cowork, whose sandboxed cloud VM can't spawn a local stdio server. Run this
 * locally and expose it through an AUTHENTICATED HTTPS tunnel (Tailscale Funnel recommended, or a
 * cloudflared named tunnel); see docs/mcp-server.md. Bound to localhost; the body is capped.
 *
 * Two auth modes (COACH_MCP_AUTH):
 *  - "token" (default): a static `Authorization: Bearer <token>` — good for scripts / a self-hosted
 *    Desktop-over-HTTP. Simple, but Claude Cowork's connectors don't speak it.
 *  - "oauth": full OAuth 2.1 (DCR + PKCE + a coach-token-gated consent) — what Cowork's custom
 *    connectors require. Needs COACH_MCP_PUBLIC_URL set to the public tunnel URL.
 *  - "none": no auth (only ever behind a private tunnel you control).
 * In every mode COACH_MCP_READONLY=true drops the gated write tools from this surface.
 */

/** MCP endpoint path. The Cowork connector URL is the public base; Claude POSTs MCP traffic here. */
const MCP_PATH = "/mcp";

const MAX_BODY = 1_000_000; // 1 MB — MCP requests are tiny; refuse anything larger.

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function rpcError(code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
}

/** Build the `/health` body. `?deep=1` additionally probes the AI Endurance spine (bounded, no auth). */
async function healthBody(deep: boolean): Promise<string> {
  const info = baseHealth();
  if (deep) {
    info.aie = await aieHealthProbe();
    if (info.aie !== "ok") info.status = "degraded";
  }
  return JSON.stringify(info);
}

/** Minimum length for a usable bearer/consent secret (the auto-generated token is 48 hex chars). */
const MIN_TOKEN_LEN = 16;

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/** Dispatch to the configured auth mode. */
export async function runHttp(): Promise<void> {
  // Refuse to bind an authenticated server with a weak secret (a user-set short COACH_MCP_TOKEN).
  if (config.mcp.auth !== "none") {
    const t = loadMcpToken();
    if (t.length < MIN_TOKEN_LEN) {
      console.error(`COACH_MCP_TOKEN is too short (<${MIN_TOKEN_LEN} chars) — refusing to start an authenticated server with a weak secret.`);
      console.error("Use a longer COACH_MCP_TOKEN, or unset it to auto-generate a strong one.");
      process.exit(1);
    }
  }
  if (config.mcp.auth === "oauth") return runHttpOAuth();
  return runHttpRaw();
}

/** Raw Node HTTP server for the "token" (bearer) and "none" auth modes. */
async function runHttpRaw(): Promise<void> {
  const token = loadMcpToken();
  const includeWrites = !config.mcp.readOnly;
  const requireToken = config.mcp.auth !== "none";

  // "none" disables all auth, so it must never bind a public interface (that would expose every tool).
  if (!requireToken && !isLoopbackHost(config.mcp.httpHost)) {
    console.error(`COACH_MCP_AUTH=none refuses to bind a non-loopback host (${config.mcp.httpHost}) — it would expose every tool unauthenticated.`);
    console.error("Bind 127.0.0.1 (tunnel to it), or use auth=token / auth=oauth.");
    process.exit(1);
  }

  const httpServer = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === "OPTIONS") {
          res.writeHead(204).end();
          return;
        }
        // Unauthenticated liveness probe — info-only, no secrets — so a tunnel/server check is one curl.
        if (req.method === "GET" && (req.url ?? "").split("?")[0] === "/health") {
          const deep = new URL(req.url ?? "/", "http://localhost").searchParams.get("deep") === "1";
          res.writeHead(200, { "content-type": "application/json" }).end(await healthBody(deep));
          return;
        }
        if (requireToken && !bearerAuthorized(req.headers, token)) {
          res
            .writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" })
            .end(rpcError(-32001, "Unauthorized — present Authorization: Bearer <token>."));
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405, { "content-type": "application/json", allow: "POST" }).end(rpcError(-32000, "Method not allowed"));
          return;
        }
        const body = await readJsonBody(req);
        // Stateless: a fresh server + transport per request, so there's no cross-request session state
        // to leak between calls and no request-id collisions (the SDK's documented stateless pattern).
        const server = buildServer({ includeWrites, includeProfileWrite: config.mcp.profileWrite });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("MCP HTTP error:", msg);
        if (!res.headersSent) {
          res.writeHead(msg === "body too large" ? 413 : 400, { "content-type": "application/json" }).end(rpcError(-32700, msg));
        }
      }
    })();
  });

  httpServer.on("clientError", (_e, socket) => socket.destroy());
  httpServer.listen(config.mcp.httpPort, config.mcp.httpHost, () => {
    console.error(`endurance-coach MCP (HTTP, auth=${config.mcp.auth}) on http://${config.mcp.httpHost}:${config.mcp.httpPort}/  —  ${includeWrites ? "read + gated writes" : "READ-ONLY"}${config.mcp.profileWrite ? " + profile-write" : ""}`);
    if (requireToken) console.error(`Auth: every request needs  Authorization: Bearer <token>.  Token file: ${config.secretsDir}/mcp.token  (or set COACH_MCP_TOKEN).`);
    else console.error("Auth: NONE — only expose this behind a private tunnel you control.");
    console.error("Reach it from Claude Cowork via an authenticated HTTPS tunnel — see docs/mcp-server.md.");
  });
}

/**
 * OAuth 2.1 server (Express) for the "oauth" mode that Claude Cowork's custom connectors require.
 * mcpAuthRouter provides discovery + dynamic client registration + the token endpoint; our
 * CoachOAuthProvider gates the authorize step behind the coach token. The MCP endpoint at /mcp is
 * protected by the issued bearer access token.
 */
async function runHttpOAuth(): Promise<void> {
  const publicUrl = config.mcp.publicUrl;
  if (!publicUrl) {
    console.error("COACH_MCP_AUTH=oauth requires COACH_MCP_PUBLIC_URL — set it to your public HTTPS tunnel URL");
    console.error("(e.g. COACH_MCP_PUBLIC_URL=https://<your-mac>.<tailnet>.ts.net). Aborting.");
    process.exit(1);
  }
  const issuer = new URL(publicUrl);
  const resourceServerUrl = new URL(MCP_PATH, issuer); // <public>/mcp
  // Bind issued tokens to this resource (audience) so a token can't be replayed at another server, and
  // persist clients + tokens to disk so a Claude connection survives a restart (no re-authorization).
  const provider = new CoachOAuthProvider(loadMcpToken(), resourceServerUrl.href, { persist: true });
  const includeWrites = !config.mcp.readOnly;

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // behind a tunnel (Tailscale/cloudflared) — trust one proxy hop for req.ip
  // Unauthenticated liveness probe (before the auth router so it's reachable through the tunnel without a
  // token) — info-only, no secrets. `?deep=1` also reports the AI Endurance spine's reachability.
  app.get("/health", async (req, res) => {
    res.type("application/json").send(await healthBody(req.query.deep === "1"));
  });
  // Discovery, dynamic client registration, authorize + token endpoints.
  app.use(mcpAuthRouter({ provider, issuerUrl: issuer, resourceServerUrl, scopesSupported: ["coach"], resourceName: "Endurance Coach" }));
  // Brute-force guard on the coach-token consent endpoint (mcpAuthRouter rate-limits its own routes,
  // but /coach/approve is ours): cap attempts per IP, since this is the one secret guarding the surface.
  const approveLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
  // The coach-token-gated consent form posts here; on success we redirect back to Claude with a code.
  app.post("/coach/approve", approveLimiter, express.urlencoded({ extended: false }), (req, res) => {
    const result = provider.approve(req.body as Record<string, unknown>);
    if (result.ok && result.redirect) {
      res.redirect(302, result.redirect);
      return;
    }
    console.error(`[mcp-oauth] consent rejected (${result.status ?? 400}) from ${req.ip ?? "?"}`);
    res.status(result.status ?? 400).type("html").send(result.html ?? "Authorization failed.");
  });
  // The MCP endpoint, protected by the issued OAuth access token (must carry the `coach` scope).
  app.post(
    MCP_PATH,
    requireBearerAuth({ verifier: provider, requiredScopes: ["coach"], resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl) }),
    express.json({ limit: MAX_BODY }),
    async (req, res) => {
      const server = buildServer({ includeWrites });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    },
  );

  app.listen(config.mcp.httpPort, config.mcp.httpHost, () => {
    console.error(`endurance-coach MCP (HTTP+OAuth) on ${config.mcp.httpHost}:${config.mcp.httpPort}  —  ${includeWrites ? "read + gated writes" : "READ-ONLY"}${config.mcp.profileWrite ? " + profile-write" : ""}`);
    console.error(`Point the Claude Cowork connector at:  ${resourceServerUrl.href}`);
    console.error(`Authorize gate: your coach token (${config.secretsDir}/mcp.token, or COACH_MCP_TOKEN).`);
  });
}

// Only start when run directly (not when imported by tests).
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runHttp().catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
