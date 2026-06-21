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

export type DecisionStatus = "proposed" | "accepted" | "declined" | "deferred" | "executing" | "executed" | "completed" | "dismissed" | "note" | "cleared";

/**
 * How the athlete reacted to a surfaced insight or setup task. like/dislike (agree/disagree) are
 * persistent, visible OPINIONS — neither hides the item; dislike just down-ranks it. snooze (ignore) is
 * the timed hide (~2-week cool-off, then it can resurface). done and dismiss are the two PERMANENT hides
 * on a Finish-setup task: done = "I've done this" (and, for an AI-Endurance gap, it's written `resolved`
 * back to the profile), dismiss = "ignore this advice, don't show it again". clear removes a previous
 * opinion (back to neutral). Maps to the statuses below.
 */
export type InsightReaction = "agree" | "disagree" | "ignore" | "done" | "dismiss" | "clear" | "applied";

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
  /**
   * For insight-feedback on a family-bearing card (a "Set up & improve → This week" marginal gain): the
   * finding FAMILY the reaction belongs to. Carried with the reaction because these cards react under a
   * `setup:*` key that never enters the insight log, so the engagement model can't recover the family from
   * the surfacing history — it reads it from here instead. Absent for Top-insights reactions (family comes
   * from the insight log) and for non-family cards (weekly/research/finish-setup tasks).
   */
  family?: string;
  /** Optional retrospective note on how the call held up. */
  retro?: string;
}

const REACTION_STATUS: Record<InsightReaction, DecisionStatus> = {
  agree: "accepted",
  disagree: "declined",
  ignore: "deferred",
  done: "completed",
  dismiss: "dismissed",
  clear: "cleared",
  applied: "executed",
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

  /** Record a reaction to a surfaced insight or setup card. `family` is set only for family-bearing
   *  cards (This-week marginal gains), so the engagement model can attribute the reaction (see DecisionRecord.family). */
  async recordInsightFeedback(insightKey: string, reaction: InsightReaction, summary: string, family?: string): Promise<void> {
    await this.append({
      id: randomUUID(), // collision-free (was a 32-bit second-granularity hash that could collide)
      timestamp: nowIso(),
      kind: "insight-feedback",
      summary,
      insightKey,
      family,
      status: REACTION_STATUS[reaction],
    });
  }

  /** Latest reaction per insight key (most recent wins). */
  async insightReactions(): Promise<Map<string, { reaction: InsightReaction; timestamp: string }>> {
    return latestInsightReactions(await this.all());
  }

  /**
   * Record a RETROSPECTIVE on a surfaced insight / setup item — "how did this advice hold up?". Stored as a
   * `note` record (NOT an insight-feedback record, so it never alters the reaction) carrying the same
   * `insightKey` + a free-text `retro`. Joined back to the insight by `listening` and shown by `decisions`,
   * so the athlete can later answer "advice → my reaction → outcome".
   */
  async recordRetro(insightKey: string, note: string, summary?: string): Promise<void> {
    await this.append({
      id: randomUUID(),
      timestamp: nowIso(),
      kind: "note",
      summary: summary ?? insightKey,
      insightKey,
      retro: note,
      status: "note",
    });
  }
}

/** Latest retrospective note per insight key (most recent wins) — from the `note` records carrying a retro. */
export function latestRetros(records: DecisionRecord[]): Map<string, { note: string; timestamp: string }> {
  const out = new Map<string, { note: string; timestamp: string }>();
  for (const r of records) {
    if (r.kind !== "note" || !r.insightKey || !r.retro) continue;
    out.set(r.insightKey, { note: r.retro, timestamp: r.timestamp });
  }
  return out;
}

/** Map a stored insight-feedback status back to the athlete's reaction (inverse of REACTION_STATUS;
 *  any unexpected status falls back to "ignore" so an old/unknown record is treated as a benign hide). */
const STATUS_REACTION: Partial<Record<DecisionStatus, InsightReaction>> = {
  accepted: "agree",
  declined: "disagree",
  deferred: "ignore",
  completed: "done",
  dismissed: "dismiss",
  executed: "applied",
};
export function reactionOf(status: DecisionStatus): InsightReaction {
  return STATUS_REACTION[status] ?? "ignore";
}

/**
 * Canonicalise a UI/agent reaction label to a stored InsightReaction. Both the dashboard buttons
 * (like/dislike/snooze/clear) and the canonical names (agree/disagree/ignore) are accepted, so the
 * website endpoint and the MCP `react_to_insight` tool share one vocabulary. Returns undefined if unknown.
 */
const REACTION_LABELS: Record<string, InsightReaction> = {
  like: "agree", dislike: "disagree", snooze: "ignore", clear: "clear",
  agree: "agree", disagree: "disagree", ignore: "ignore",
  done: "done", dismiss: "dismiss", applied: "applied",
};
export function reactionFromLabel(label: string): InsightReaction | undefined {
  return REACTION_LABELS[label];
}

/** Latest reaction per insight key from a set of decision records (most recent wins). Pure — testable. */
export function latestInsightReactions(
  records: DecisionRecord[],
): Map<string, { reaction: InsightReaction; timestamp: string }> {
  const out = new Map<string, { reaction: InsightReaction; timestamp: string }>();
  for (const r of records) {
    if (r.kind !== "insight-feedback" || !r.insightKey) continue;
    if (r.status === "cleared") {
      out.delete(r.insightKey); // a later "clear" drops the prior opinion (back to neutral)
      continue;
    }
    out.set(r.insightKey, { reaction: reactionOf(r.status), timestamp: r.timestamp });
  }
  return out;
}

/**
 * Keys the athlete chose to HIDE — suppressed from surfacing. Three reactions hide; the rest don't:
 *   • done / dismiss → PERMANENT (a completed or ignored setup task never resurfaces);
 *   • ignore (snooze) → TIMED — hidden only within `withinDays`, then it lapses and can surface again
 *     (and re-snooze, which is how "it keeps coming back" is detected);
 *   • like/dislike are visible opinions (dislike just down-ranks), so they never suppress.
 */
export function suppressedInsightKeys(
  reactions: Map<string, { reaction: InsightReaction; timestamp: string }>,
  withinDays = 14,
  now: Date = new Date(),
): Set<string> {
  const out = new Set<string>();
  for (const [key, { reaction, timestamp }] of reactions) {
    if (reaction === "done" || reaction === "dismiss") {
      out.add(key); // permanent — completed or explicitly ignored, never lapses
      continue;
    }
    if (reaction !== "ignore") continue; // like/dislike stay visible
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
