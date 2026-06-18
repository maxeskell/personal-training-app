import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config } from "../config.js";
import { redactSecrets } from "../health.js";

/**
 * OPTIONAL, degradable Garmin gap-filler (Taxuspt/garmin_mcp over stdio).
 *
 * Design rule (Integration Spec §2.2): Garmin must NEVER block the coach.
 * Every method here is best-effort — on any failure it returns `null` and the
 * caller proceeds on AI Endurance alone. We pull only the five gap metrics.
 *
 * Auth is handled out-of-band by `garmin-mcp-auth` (tokens in ~/.garminconnect,
 * ~6-month lifetime). If those are missing/expired the subprocess fails to serve
 * and we degrade cleanly.
 */
export class GarminClient {
  private client?: Client;
  private transport?: StdioClientTransport;
  available = false;

  /** Attempt to start the stdio subprocess. Returns false if Garmin is unavailable. */
  async connect(): Promise<boolean> {
    if (!config.garmin.enabled) {
      this.available = false;
      return false;
    }
    try {
      this.transport = new StdioClientTransport({
        command: config.garmin.command,
        args: config.garmin.args,
      });
      this.client = new Client(
        { name: "endurance-coach-garmin", version: "0.1.0" },
        { capabilities: {} },
      );
      await this.withTimeout(this.client.connect(this.transport), "connect");
      this.available = true;
      return true;
    } catch (err) {
      this.warn("connect", err);
      await this.close();
      return false;
    }
  }

  /** List available tool names, or [] if Garmin is down. */
  async listToolNames(): Promise<string[]> {
    if (!this.available || !this.client) return [];
    try {
      const { tools } = await this.withTimeout(this.client.listTools(), "listTools");
      return tools.map((t) => t.name);
    } catch (err) {
      this.warn("listTools", err);
      return [];
    }
  }

  /** Best-effort tool call. Returns null on any error/timeout — never throws. */
  async tryCall(tool: string, args: Record<string, unknown> = {}): Promise<unknown | null> {
    if (!this.available || !this.client) return null;
    try {
      return await this.withTimeout(
        this.client.callTool({ name: tool, arguments: args }),
        tool,
      );
    } catch (err) {
      this.warn(tool, err);
      return null;
    }
  }

  async close(): Promise<void> {
    await this.transport?.close().catch(() => {});
    this.client = undefined;
    this.transport = undefined;
    this.available = false;
  }

  private withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
    // Capture and CLEAR the timer: assemble() calls Garmin up to ~14× sequentially, and a leaked timer
    // per call keeps the event loop alive (process can't exit cleanly) and accumulates on the long-running
    // server. Clearing it on settle bounds the live-timer count to at most one in flight.
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Garmin ${label} timed out after ${config.garmin.timeoutMs}ms`)),
        config.garmin.timeoutMs,
      );
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  private warn(op: string, err: unknown): void {
    const raw = err instanceof Error ? err.message : String(err);
    const msg = redactSecrets(raw);
    // The ~6-month token expiry / MFA re-auth is the predictable failure — make it actionable.
    const looksLikeAuth = /401|403|unauthor|forbidden|login|token|expired|mfa|authenticate/i.test(raw);
    const hint = looksLikeAuth
      ? " — token likely expired; re-run: uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp-auth"
      : "";
    console.warn(`[garmin] ${op} failed — degrading to AI Endurance only: ${msg}${hint}`);
  }
}
