import type { AthleteState } from "../state/types.js";
import { aieOutage } from "../state/sourceHealth.js";

/**
 * The morning ping's heartbeat (reports/last-ping.json), made honest (spec 11): the 1 Sep 2026 ping ran
 * with every AI Endurance read failed, still said GREEN on Garmin trend alone, and recorded a plain
 * success — so `doctor` showed a healthy heartbeat through a total outage. The record now carries what
 * the ping ran on, and the doctor line says it. Pure helpers; the CLI does the file I/O.
 */

export type PingStatus = "ok" | "degraded" | "reauth_needed" | "failed";

export interface PingRecord {
  date: string;
  ts: string;
  status: PingStatus;
  failedTools?: string[];
  reason?: string;
}

/** What a finished ping should record about the spine it ran on. */
export function pingStatusFor(state: AthleteState): { status: Exclude<PingStatus, "failed">; failedTools: string[] } {
  const o = aieOutage(state);
  if (!o.down) return { status: "ok", failedTools: o.failedTools };
  return { status: o.reauthNeeded ? "reauth_needed" : "degraded", failedTools: o.failedTools };
}

/** Parse the heartbeat file. A legacy `{ date, ts }` record (pre 2026-09-03) counts as ok. */
export function parsePingRecord(j: unknown): PingRecord | null {
  if (!j || typeof j !== "object") return null;
  const r = j as Record<string, unknown>;
  if (typeof r.date !== "string" || typeof r.ts !== "string") return null;
  const statuses: readonly PingStatus[] = ["ok", "degraded", "reauth_needed", "failed"];
  const status = statuses.includes(r.status as PingStatus) ? (r.status as PingStatus) : "ok";
  return {
    date: r.date,
    ts: r.ts,
    status,
    failedTools: Array.isArray(r.failedTools) ? r.failedTools.map(String) : undefined,
    reason: typeof r.reason === "string" ? r.reason : undefined,
  };
}

/** The doctor line for the last heartbeat. */
export function pingHeartbeatCheck(rec: PingRecord | null, now: Date): { status: "ok" | "warn" | "info"; detail: string } {
  if (!rec) return { status: "info", detail: "no ping recorded yet (runs after the first `npm run ping`)" };
  const ageH = (now.getTime() - new Date(rec.ts).getTime()) / 3_600_000;
  const age = `${ageH.toFixed(0)}h ago`;
  if (rec.status === "failed") {
    return { status: "warn", detail: `last ping FAILED on ${rec.date} (${age}): ${rec.reason ?? "no reason recorded"}` };
  }
  if (rec.status === "reauth_needed") {
    return { status: "warn", detail: `last ping (${rec.date}, ${age}) ran with AI Endurance needing re-auth — readiness rested on Garmin trend alone; run \`npm run auth:aie\`` };
  }
  if (rec.status === "degraded") {
    return { status: "warn", detail: `last ping (${rec.date}, ${age}) ran with AI Endurance reads failing (${(rec.failedTools ?? []).join(", ") || "unknown tools"}) — verdict rested on partial data` };
  }
  if (ageH > 25) {
    return { status: "warn", detail: `last success ${age} (${rec.date}) — the scheduled ping may be silently failing` };
  }
  return { status: "ok", detail: `last success ${rec.date} (${age})` };
}
