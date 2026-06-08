import type { AieClient, AieWriteTool } from "../mcp/aieClient.js";
import { AIE_WRITE_TOOLS } from "../mcp/aieClient.js";
import { DecisionLog, decisionId, nowIso, type DecisionRecord } from "../state/decisionLog.js";

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
    const id = decisionId(`${p.tool}:${JSON.stringify(p.args)}:${nowIso()}`);
    const proposal: Proposal = { id, ...p };
    this.pending.set(id, proposal);

    const record: DecisionRecord = {
      id,
      timestamp: nowIso(),
      kind: "plan-adjust",
      summary: p.rationale,
      tradeoff: p.tradeoff,
      write: { tool: p.tool, args: p.args },
      status: "proposed",
    };
    await this.log.append(record);
    return proposal;
  }

  /**
   * Execute a previously-proposed write — ONLY with explicit confirmation. Throws if the id
   * is unknown (never proposed, or already consumed). The confirmation is single-use.
   */
  async confirm(id: string): Promise<unknown> {
    const proposal = this.pending.get(id);
    if (!proposal) {
      throw new Error(
        `Refusing to write: no pending proposal ${id}. Writes require an explicit, un-consumed confirmation.`,
      );
    }
    this.pending.delete(id); // single-use
    // callRaw is the only place a write tool is invoked, and only from here.
    const result = await this.aie.callRaw(proposal.tool, proposal.args);
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
