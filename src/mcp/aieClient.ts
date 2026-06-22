import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { config } from "../config.js";
import { redactSecrets } from "../util/redact.js";
import { retry, RetryableHttpError, looksLikeRetryableHttp } from "../util/retry.js";
import { FileOAuthClientProvider, ReauthRequiredError } from "./oauthProvider.js";

export { ReauthRequiredError };

export interface AieClientOptions {
  /**
   * Open a browser + loopback to interactively re-authorize when the token is missing/expired.
   * ONLY the explicit `auth` CLI flow sets this true; every other context (MCP/dashboard server, cron,
   * Cowork) leaves it false and fails fast with a ReauthRequiredError instead of blocking on a browser
   * that can never appear. Default: false.
   */
  interactive?: boolean;
  /** Hard timeout (ms) for connect/reconnect. Defaults to config.aie.timeoutMs. */
  timeoutMs?: number;
}

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
  "createRideRunWorkoutAdvanced", // added by AIE after the v1 README; gated as a write (verify args before use)
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
  private readonly interactive: boolean;
  private readonly timeoutMs: number;
  private readonly auth: FileOAuthClientProvider;

  constructor(opts: AieClientOptions = {}) {
    this.interactive = opts.interactive ?? false;
    this.timeoutMs = opts.timeoutMs ?? config.aie.timeoutMs;
    this.auth = new FileOAuthClientProvider({ interactive: this.interactive });
  }

  /** Connect, running the interactive OAuth dance only when explicitly allowed (the `auth` flow). */
  async connect(): Promise<void> {
    this.client = new Client(
      { name: "endurance-coach", version: "0.1.0" },
      { capabilities: {} },
    );
    this.transport = new StreamableHTTPClientTransport(new URL(config.aie.serverUrl), {
      authProvider: this.auth,
    });

    try {
      await this.withTimeout(this.client.connect(this.transport), "connect");
    } catch (err) {
      // Non-interactive provider already refused the browser dance — surface it as-is (fast + clean).
      if (err instanceof ReauthRequiredError) throw err;
      if (!(err instanceof UnauthorizedError)) throw err;
      // Token missing/expired. A headless context must never wait on a browser that can't appear.
      if (!this.interactive) throw new ReauthRequiredError();
      // Interactive CLI (`auth`): the provider opened the browser + loopback. Wait for the human — that
      // 5-minute wait is intentional and NOT bounded by timeoutMs — then reconnect with the fresh token.
      const code = await this.auth.waitForCode();
      await this.transport.finishAuth(code);
      this.transport = new StreamableHTTPClientTransport(new URL(config.aie.serverUrl), {
        authProvider: this.auth,
      });
      await this.withTimeout(this.client.connect(this.transport), "reconnect");
    }
  }

  /** Bound a connect attempt so a hung network call can't stall a flow (mirrors GarminClient). */
  private withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`AI Endurance ${label} timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
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
   * Low-level call. The write gate (`WriteGate.confirm`) is the ONLY caller permitted to invoke a write
   * tool, and it must say so explicitly via `opts.allowWrite` (see the direct-write guard below).
   * @internal
   */
  async callRaw(tool: string, args: Record<string, unknown> = {}, opts: { allowWrite?: boolean } = {}): Promise<unknown> {
    const isWrite = WRITE_SET.has(tool);
    // Direct-write guard (defence-in-depth): the AI Endurance plan is mutated ONLY through the write gate
    // (propose → human confirm → WriteGate.confirm). callRaw refuses any write-set tool unless the caller
    // explicitly asserts it came through that gate (`allowWrite`). read() also pre-rejects writes; this is
    // the structural backstop so a future code path can't accidentally direct-write the plan.
    if (isWrite && !opts.allowWrite) {
      throw new Error(`${tool} is a write tool; AI Endurance writes must go through the write gate (callRaw direct-write guard).`);
    }
    // A write is fired exactly once — never retried (a re-issued create/change could double-fire). Reads
    // are idempotent, so a transient 429/5xx is retried with bounded jitter.
    if (isWrite) return this.callOnce(tool, args);
    return retry(() => this.callOnce(tool, args));
  }

  /** A single bounded, redacted tool call. Wraps the SDK callTool in the per-tool timeout and classifies
   *  transient HTTP failures as retryable so callRaw's read path can recover from a blip. */
  private async callOnce(tool: string, args: Record<string, unknown>): Promise<unknown> {
    let res: { isError?: boolean; content?: Array<{ text?: string }> };
    try {
      // Per-tool timeout: connect was already bounded; an individual tool call must be too, or a hung
      // upstream call after connect stalls every read/flow/confirm indefinitely.
      res = (await this.withTimeout(
        this.require().callTool({ name: tool, arguments: args }),
        `tool ${tool}`,
      )) as { isError?: boolean; content?: Array<{ text?: string }> };
    } catch (err) {
      // Auth failures are not transient — surface them as-is so the caller re-auths (never retry/wrap).
      if (err instanceof ReauthRequiredError || err instanceof UnauthorizedError) throw err;
      // Redact before the error detail reaches MCP output / logs, then flag transient 429/5xx as retryable.
      const msg = redactSecrets(err instanceof Error ? err.message : String(err));
      if (looksLikeRetryableHttp(msg)) throw new RetryableHttpError(`AIE tool ${tool} failed: ${msg}`);
      throw new Error(`AIE tool ${tool} failed: ${msg}`);
    }
    // MCP signals a tool failure with `isError: true` + an error payload (not a thrown error). Don't let
    // that payload be parsed as data — surface it as a throw so the caller degrades (provenanced null)
    // instead of silently treating an error message as a (missing) reading. Redacted before it escapes.
    if (res?.isError) {
      const detail = redactSecrets(res.content?.map((c) => c?.text).filter(Boolean).join(" ").slice(0, 200) || "(no detail)");
      throw new Error(`AIE tool ${tool} returned an error: ${detail}`);
    }
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
