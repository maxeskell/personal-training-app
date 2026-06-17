import { mkdir, readFile, appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { config } from "../config.js";

/**
 * Persistent decision log (Path-B need #3): a durable, append-only record of what the
 * coach proposed, what was decided, and — later — how the call held up. Survives beyond
 * chat history. Stored as JSONL so it's append-cheap and inspectable.
 */

export type DecisionStatus = "proposed" | "accepted" | "declined" | "deferred" | "executing" | "executed" | "note";

/** How the athlete reacted to a surfaced insight (maps to accepted/declined/deferred). */
export type InsightReaction = "agree" | "disagree" | "ignore";

export interface DecisionRecord {
  id: string;
  timestamp: string;
  kind: "readiness" | "plan-adjust" | "note" | "insight-feedback";
  summary: string;
  tradeoff?: string;
  /** For plan-adjust proposals: the gated write that would fire on acceptance. */
  write?: { tool: string; args: Record<string, unknown> };
  status: DecisionStatus;
  /** For insight-feedback: the stable key of the finding being reacted to. */
  insightKey?: string;
  /** Optional retrospective note on how the call held up. */
  retro?: string;
}

const REACTION_STATUS: Record<InsightReaction, DecisionStatus> = {
  agree: "accepted",
  disagree: "declined",
  ignore: "deferred",
};

export class DecisionLog {
  private readonly file = join(config.dataDir, "decisions", "log.jsonl");

  async append(record: DecisionRecord): Promise<void> {
    await mkdir(join(config.dataDir, "decisions"), { recursive: true });
    await appendFile(this.file, JSON.stringify(record) + "\n");
  }

  /**
   * Run `fn` while holding an exclusive cross-process lock on the log (proper-lockfile: atomic mkdir,
   * mtime-refreshed, stale-aware — robust on a local filesystem). Serializes a critical section across
   * the CLI and the dashboard-server processes, so a check-then-act (e.g. WriteGate.confirm) can't
   * interleave and double-fire. Crash-safe: a stale lock (mtime older than `stale`) is reclaimed.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(join(config.dataDir, "decisions"), { recursive: true });
    await appendFile(this.file, ""); // ensure the lock target exists (no-op if it already does)
    const release = await lockfile.lock(this.file, {
      stale: 30_000, // a confirm includes a network write; keep the lock valid well past that
      realpath: false,
      retries: { retries: 20, factor: 1.5, minTimeout: 100, maxTimeout: 1000 },
    });
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  async all(): Promise<DecisionRecord[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return []; // no log yet
    }
    // Parse per line so one corrupt/partial line (crash mid-append) can't lose the whole audit trail.
    const out: DecisionRecord[] = [];
    let skipped = 0;
    for (const l of text.split("\n")) {
      if (!l.trim()) continue;
      try {
        out.push(JSON.parse(l) as DecisionRecord);
      } catch {
        skipped++;
      }
    }
    if (skipped) console.warn(`[decisionLog] skipped ${skipped} unparseable line(s)`);
    return out;
  }

  /** Append a status change as a new line referencing the original id (append-only audit trail). */
  async updateStatus(id: string, status: DecisionStatus, retro?: string): Promise<void> {
    const original = (await this.all()).find((r) => r.id === id);
    if (!original) throw new Error(`No decision with id ${id}`);
    await this.append({ ...original, status, retro, timestamp: nowIso() });
  }

  /** Record an agree/disagree/ignore reaction to a surfaced insight. */
  async recordInsightFeedback(insightKey: string, reaction: InsightReaction, summary: string): Promise<void> {
    await this.append({
      id: randomUUID(), // collision-free (was a 32-bit second-granularity hash that could collide)
      timestamp: nowIso(),
      kind: "insight-feedback",
      summary,
      insightKey,
      status: REACTION_STATUS[reaction],
    });
  }

  /** Latest reaction per insight key (most recent wins). */
  async insightReactions(): Promise<Map<string, { reaction: InsightReaction; timestamp: string }>> {
    return latestInsightReactions(await this.all());
  }
}

/** Map a stored insight-feedback status back to the athlete's reaction. */
export function reactionOf(status: DecisionStatus): InsightReaction {
  return status === "accepted" ? "agree" : status === "declined" ? "disagree" : "ignore";
}

/** Latest reaction per insight key from a set of decision records (most recent wins). Pure — testable. */
export function latestInsightReactions(
  records: DecisionRecord[],
): Map<string, { reaction: InsightReaction; timestamp: string }> {
  const out = new Map<string, { reaction: InsightReaction; timestamp: string }>();
  for (const r of records) {
    if (r.kind !== "insight-feedback" || !r.insightKey) continue;
    out.set(r.insightKey, { reaction: reactionOf(r.status), timestamp: r.timestamp });
  }
  return out;
}

/**
 * Keys the athlete has dismissed (disagree/ignore) within `withinDays` — suppressed from surfacing.
 * Agreeing re-activates a key (it's a real signal they want to keep seeing).
 */
export function suppressedInsightKeys(
  reactions: Map<string, { reaction: InsightReaction; timestamp: string }>,
  withinDays = 14,
  now: Date = new Date(),
): Set<string> {
  const out = new Set<string>();
  for (const [key, { reaction, timestamp }] of reactions) {
    if (reaction === "agree") continue;
    const ageDays = (now.getTime() - new Date(timestamp).getTime()) / 86_400_000;
    if (ageDays <= withinDays) out.add(key);
  }
  return out;
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
