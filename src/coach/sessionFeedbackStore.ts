import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";

/**
 * Persisted per-session deep-feedback store. The `session` deep dive used to be on-demand (a dashboard
 * button / `npm run session`); now it's generated automatically at sync for every session that has the
 * data for it, and kept here as an append-only JSONL log so the dashboard can show it inline (no LLM on
 * render) and so the feedback history is available for future analysis. Gitignored (lives in dataDir),
 * same discipline as the decision log / cost log.
 */

export const SESSION_FEEDBACK_SCHEMA_VERSION = 1;

export interface SessionFeedbackRecord {
  schemaVersion: number;
  /** Session date (YYYY-MM-DD) — the key the dashboard's "Last session" card looks up. */
  date: string;
  sport: string;
  /** True when the raw .FIT biomechanics were present (a full deep dive); false = summary-only. */
  deep: boolean;
  generatedAt: string; // ISO
  costUsd: number;
  markdown: string;
}

function file(): string {
  return join(config.dataDir, "session-feedback.jsonl");
}

/** Append one feedback record. Best-effort: a logging failure must never break a sync. */
export async function saveSessionFeedback(rec: Omit<SessionFeedbackRecord, "schemaVersion">): Promise<void> {
  try {
    await mkdir(config.dataDir, { recursive: true });
    await appendFile(file(), JSON.stringify({ ...rec, schemaVersion: SESSION_FEEDBACK_SCHEMA_VERSION }) + "\n");
  } catch {
    /* never let feedback persistence break the flow */
  }
}

/** All stored records (newest-first not guaranteed). Empty when the log is absent. */
export async function loadSessionFeedbacks(): Promise<SessionFeedbackRecord[]> {
  let text: string;
  try {
    text = await readFile(file(), "utf8");
  } catch {
    return [];
  }
  const out: SessionFeedbackRecord[] = [];
  for (const l of text.split("\n")) {
    const t = l.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as SessionFeedbackRecord);
    } catch {
      /* skip a malformed line rather than fail the whole read */
    }
  }
  return out;
}

/** Latest record per session date (most recent `generatedAt` wins) — append-only history collapsed. Pure. */
export function latestByDate(records: SessionFeedbackRecord[]): Map<string, SessionFeedbackRecord> {
  const m = new Map<string, SessionFeedbackRecord>();
  for (const r of records) {
    const prev = m.get(r.date);
    if (!prev || r.generatedAt > prev.generatedAt) m.set(r.date, r);
  }
  return m;
}

/** The composite session key — `${date}|${sport}` — so a multi-sport day keeps one readout per session. */
export function sessionFeedbackKey(date: string, sport: string): string {
  return `${date}|${sport}`;
}

/**
 * Latest record per (date, sport) — the key the dashboard and the on-demand route look up. A triathlete's
 * swim + ride + run on one day each get their own readout instead of colliding on the date alone. Pure.
 */
export function latestByDateSport(records: SessionFeedbackRecord[]): Map<string, SessionFeedbackRecord> {
  const m = new Map<string, SessionFeedbackRecord>();
  for (const r of records) {
    const k = sessionFeedbackKey(r.date, r.sport);
    const prev = m.get(k);
    if (!prev || r.generatedAt > prev.generatedAt) m.set(k, r);
  }
  return m;
}
