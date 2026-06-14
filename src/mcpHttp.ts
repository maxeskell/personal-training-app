import { createServer, type IncomingMessage } from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { buildServer } from "./mcpServer.js";
import { loadMcpToken, bearerAuthorized } from "./serverAuth.js";

/**
 * HTTP (Streamable HTTP) transport for the coach MCP server. For clients that can only reach a remote
 * URL — notably Claude Cowork, whose sandboxed cloud VM can't spawn a local stdio server. Run this
 * locally and expose it through an AUTHENTICATED HTTPS tunnel (cloudflared / Tailscale Funnel); see
 * docs/mcp-server.md.
 *
 * Safety: bound to localhost, every request must carry `Authorization: Bearer <token>` (constant-time
 * checked), and the body is capped. Health data + (optionally) the gated write tools are reachable over
 * the tunnel, so the token is mandatory — set COACH_MCP_READONLY=true to drop the write tools here.
 */

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

export async function runHttp(): Promise<void> {
  const token = loadMcpToken();
  const includeWrites = !config.mcp.readOnly;

  const httpServer = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === "OPTIONS") {
          res.writeHead(204).end();
          return;
        }
        if (!bearerAuthorized(req.headers, token)) {
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
        const server = buildServer({ includeWrites });
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
    console.error(`endurance-coach MCP (HTTP) on http://${config.mcp.httpHost}:${config.mcp.httpPort}/  —  ${includeWrites ? "read + gated writes" : "READ-ONLY"}`);
    console.error(`Auth: every request needs  Authorization: Bearer <token>.  Token file: ${config.secretsDir}/mcp.token  (or set COACH_MCP_TOKEN).`);
    console.error("Reach it from Claude Cowork via an authenticated HTTPS tunnel — see docs/mcp-server.md.");
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
