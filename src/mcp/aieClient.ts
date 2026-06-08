import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { config } from "../config.js";
import { FileOAuthClientProvider } from "./oauthProvider.js";

/** The 20 AI Endurance tools, split by side-effect. Writes are gated (M3). */
export const AIE_READ_TOOLS = [
  "getUser",
  "getAvailability",
  "getPlannedWorkouts",
  "getCyclingActivity",
  "getRunningActivity",
  "getSwimmingActivity",
  "getCyclingActivityDetail",
  "getRunningActivityDetail",
  "getSwimmingActivityDetail",
  "getRaceGoalEvent",
  "getPrediction",
  "getRecoveryModel",
  "getPlanProgress",
  "getNutritionModel",
] as const;

export const AIE_WRITE_TOOLS = [
  "setZones",
  "changeWorkoutDate",
  "skipWorkout",
  "changeWorkoutAdvice",
  "createRideRunWorkout",
  "createSwimWorkout",
  "createStrengthOtherWorkout",
] as const;

export type AieReadTool = (typeof AIE_READ_TOOLS)[number];
export type AieWriteTool = (typeof AIE_WRITE_TOOLS)[number];

const WRITE_SET = new Set<string>(AIE_WRITE_TOOLS);

/**
 * Thin, auth-aware client for the AI Endurance remote MCP server.
 *
 * Required spine: every read flows through here. Connects over Streamable HTTP
 * with OAuth (PKCE), persisting tokens via FileOAuthClientProvider so subsequent
 * runs are non-interactive until the token expires.
 */
export class AieClient {
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private readonly auth = new FileOAuthClientProvider();

  /** Connect, running the interactive OAuth dance only if needed. */
  async connect(): Promise<void> {
    this.client = new Client(
      { name: "endurance-coach", version: "0.1.0" },
      { capabilities: {} },
    );
    this.transport = new StreamableHTTPClientTransport(new URL(config.aie.serverUrl), {
      authProvider: this.auth,
    });

    try {
      await this.client.connect(this.transport);
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      // First run (or expired): provider has opened the browser + loopback server.
      const code = await this.auth.waitForCode();
      await this.transport.finishAuth(code);
      // Reconnect with the freshly minted token.
      this.transport = new StreamableHTTPClientTransport(new URL(config.aie.serverUrl), {
        authProvider: this.auth,
      });
      await this.client.connect(this.transport);
    }
  }

  /** List the tools the server actually exposes — used to detect API drift. */
  async listToolNames(): Promise<string[]> {
    const { tools } = await this.require().listTools();
    return tools.map((t) => t.name);
  }

  /** Call a READ tool. Write tools are rejected here — they must go through the gate. */
  async read(tool: AieReadTool, args: Record<string, unknown> = {}): Promise<unknown> {
    if (WRITE_SET.has(tool)) {
      throw new Error(
        `${tool} is a write tool and cannot be called via read(); use the write gate.`,
      );
    }
    return this.callRaw(tool, args);
  }

  /**
   * Low-level call. Intentionally NOT exported for writes yet — the write gate
   * (M3) will be the only caller permitted to invoke write tools, behind
   * explicit per-action confirmation.
   * @internal
   */
  async callRaw(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const res = await this.require().callTool({ name: tool, arguments: args });
    return res;
  }

  async close(): Promise<void> {
    await this.transport?.close().catch(() => {});
    this.client = undefined;
    this.transport = undefined;
  }

  private require(): Client {
    if (!this.client) throw new Error("AieClient not connected — call connect() first.");
    return this.client;
  }
}
