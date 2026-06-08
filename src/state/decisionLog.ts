import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";

/**
 * Persistent decision log (Path-B need #3): a durable, append-only record of what the
 * coach proposed, what was decided, and — later — how the call held up. Survives beyond
 * chat history. Stored as JSONL so it's append-cheap and inspectable.
 */

export type DecisionStatus = "proposed" | "accepted" | "declined" | "deferred" | "executed" | "note";

export interface DecisionRecord {
  id: string;
  timestamp: string;
  kind: "readiness" | "plan-adjust" | "note";
  summary: string;
  tradeoff?: string;
  /** For plan-adjust proposals: the gated write that would fire on acceptance. */
  write?: { tool: string; args: Record<string, unknown> };
  status: DecisionStatus;
  /** Optional retrospective note on how the call held up. */
  retro?: string;
}

export class DecisionLog {
  private readonly file = join(config.dataDir, "decisions", "log.jsonl");

  async append(record: DecisionRecord): Promise<void> {
    await mkdir(join(config.dataDir, "decisions"), { recursive: true });
    await appendFile(this.file, JSON.stringify(record) + "\n");
  }

  async all(): Promise<DecisionRecord[]> {
    try {
      const text = await readFile(this.file, "utf8");
      return text
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as DecisionRecord);
    } catch {
      return [];
    }
  }

  /** Append a status change as a new line referencing the original id (append-only audit trail). */
  async updateStatus(id: string, status: DecisionStatus, retro?: string): Promise<void> {
    const original = (await this.all()).find((r) => r.id === id);
    if (!original) throw new Error(`No decision with id ${id}`);
    await this.append({ ...original, status, retro, timestamp: nowIso() });
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Deterministic-ish id from timestamp + a short suffix (no Math.random dependency). */
export function decisionId(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return `dec_${Math.abs(h).toString(36)}`;
}
