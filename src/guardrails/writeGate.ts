import { randomUUID } from "node:crypto";
import type { AieClient, AieWriteTool } from "../mcp/aieClient.js";
import { AIE_WRITE_TOOLS } from "../mcp/aieClient.js";
import { DecisionLog, nowIso, type DecisionRecord } from "../state/decisionLog.js";

/**
 * The write gate (Build Spec §8 Safety, acceptance §9.4).
 *
 * NO AI Endurance write tool fires without explicit, per-action confirmation. The only
 * path to a write is: propose() → user inspects the trade-off → confirm(id). An attempt to
 * execute without a matching, un-consumed confirmation throws. Every proposal and execution
 * is recorded in the decision log. There is no "auto" mode.
 */

export interface Proposal {
  id: string;
  tool: AieWriteTool;
  args: Record<string, unknown>;
  rationale: string;
  tradeoff: string;
  human?: string; // validated, human-readable description of the exact change being confirmed
}

const WRITE_SET = new Set<string>(AIE_WRITE_TOOLS);

export class WriteGate {
  private pending = new Map<string, Proposal>();

  constructor(
    private readonly aie: AieClient,
    private readonly log: DecisionLog,
  ) {}

  /** Record a proposed write + its trade-off. Does NOT execute. Returns the proposal id. */
  async propose(p: Omit<Proposal, "id">): Promise<Proposal> {
    if (!WRITE_SET.has(p.tool)) {
      throw new Error(`${p.tool} is not an AI Endurance write tool.`);
    }
    const id = randomUUID(); // collision-free (was a 32-bit/second-granularity hash)
    const proposal: Proposal = { id, ...p };
    this.pending.set(id, proposal);

    const record: DecisionRecord = {
      id,
      timestamp: nowIso(),
      kind: "plan-adjust",
      summary: p.human ? `${p.human} — ${p.rationale}` : p.rationale,
      tradeoff: p.tradeoff,
      write: { tool: p.tool, args: p.args },
      status: "proposed",
    };
    await this.log.append(record);
    return proposal;
  }

  /**
   * Execute a previously-proposed write — ONLY with explicit confirmation. Resolves the
   * proposal from the in-memory set or, across CLI processes, from the persisted decision log
   * (must be status "proposed" with a recorded write, and not already executed/declined).
   * Throws otherwise. The confirmation is single-use.
   */
  async confirm(id: string): Promise<unknown> {
    let tool: string | undefined;
    let args: Record<string, unknown> | undefined;

    const inMem = this.pending.get(id);
    if (inMem) {
      this.pending.delete(id); // single-use
      tool = inMem.tool;
      args = inMem.args;
    } else {
      // Cross-process: reconstruct from the append-only log; latest status wins.
      const records = (await this.log.all()).filter((r) => r.id === id);
      const latest = records[records.length - 1];
      if (!latest || latest.status !== "proposed" || !latest.write) {
        throw new Error(
          `Refusing to write: proposal ${id} is not in a confirmable state ` +
            `(${latest ? latest.status : "unknown"}). Writes require an explicit, un-consumed proposal.`,
        );
      }
      tool = latest.write.tool;
      args = latest.write.args;
    }

    if (!WRITE_SET.has(tool)) throw new Error(`${tool} is not a write tool.`);

    // Concurrency claim: append an "executing" marker and re-read; if we didn't win (another confirm
    // raced us), abort before any write fires. Prevents a double-write across two processes/clicks.
    await this.log.updateStatus(id, "executing");
    const claim = (await this.log.all()).filter((r) => r.id === id);
    if (claim[claim.length - 1]?.status !== "executing") {
      throw new Error(`Refusing to write: proposal ${id} is being executed by another action.`);
    }

    // callRaw is the only place a write tool is invoked, and only from here.
    const result = await this.aie.callRaw(tool, args ?? {});
    await this.log.updateStatus(id, "executed");
    return result;
  }

  async decline(id: string): Promise<void> {
    this.pending.delete(id);
    await this.log.updateStatus(id, "declined");
  }

  /** Hard guard: any direct write attempt that didn't come through propose()+confirm() throws. */
  static assertNoDirectWrite(tool: string): void {
    if (WRITE_SET.has(tool)) {
      throw new Error(
        `Blocked: ${tool} is a write tool and must go through WriteGate.propose() + confirm(). ` +
          `No autonomous writes.`,
      );
    }
  }
}
