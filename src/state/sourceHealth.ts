import type { AthleteState } from "./types.js";

/**
 * Per-source health of one assemble (spec 11 — the 30 Aug 2026 outage). The assemble already degrades
 * every failed AI Endurance read to a Provenanced null; what it never said was WHETHER THE SPINE ANSWERED
 * AT ALL, so an all-null snapshot with a fresh `assembledAt` passed for fresh data on every surface for
 * three days. These helpers are pure so every consumer (dashboard, MCP, doctor, ping, weekly brief) judges
 * the same way — and `aieOutage()` also reads legacy snapshots that pre-date the `sources` field.
 */

export type AieSourceStatus = "ok" | "degraded" | "down";

export interface AieSourceHealth {
  status: AieSourceStatus;
  /** Convenience: status !== "down". */
  ok: boolean;
  /** AI Endurance tools whose read failed in this assemble. */
  failedTools: string[];
  /** True when a failed read said re-authorisation is needed (token missing or rejected). */
  reauthNeeded: boolean;
  /** ISO time of the newest assemble whose AIE reads worked — this one, or carried from a prior snapshot. */
  lastGoodAt: string | null;
}

export interface GarminSourceHealth {
  enabled: boolean;
  ok: boolean;
}

export interface SourcesHealth {
  aie: AieSourceHealth;
  garmin: GarminSourceHealth;
}

const REAUTH_RE = /authorization is missing or expired|AIE_REAUTH_REQUIRED|re-auth/i;

/** The `{ error }` marker assembleState stores for a failed read, or null when the read succeeded. */
export function readError(v: unknown): string | null {
  return v && typeof v === "object" && typeof (v as { error?: unknown }).error === "string" ? (v as { error: string }).error : null;
}

/** Pure: judge the AI Endurance spine from one assemble's raw read outcomes. */
export function judgeAieReads(
  raw: Record<string, unknown> | undefined,
  tools: readonly string[],
): Pick<AieSourceHealth, "status" | "ok" | "failedTools" | "reauthNeeded"> {
  const failedTools = tools.filter((t) => readError(raw?.[t]) != null);
  const reauthNeeded = failedTools.some((t) => REAUTH_RE.test(readError(raw?.[t]) ?? ""));
  const status: AieSourceStatus =
    tools.length === 0 ? "down" : failedTools.length === 0 ? "ok" : failedTools.length === tools.length || reauthNeeded ? "down" : "degraded";
  return { status, ok: status !== "down", failedTools, reauthNeeded };
}

/** Pure: does a snapshot written before `sources` existed look like an outage? (Every AIE read errored.) */
function legacyLooksDown(s: AthleteState): boolean {
  const tools = aieToolKeys(s.raw);
  if (!tools.length) return false; // no raw at all (demo/tests/fresh) — not an outage signal
  return judgeAieReads(s.raw, tools).status === "down";
}

function aieToolKeys(raw: Record<string, unknown> | undefined): string[] {
  return Object.keys(raw ?? {}).filter((k) => k.startsWith("get"));
}

/**
 * Pure: the newest good AI Endurance sync time — this assemble's time when its reads worked, otherwise
 * carried forward from prior snapshots (any order; the newest good one wins), else null.
 */
export function carryLastGoodAt(status: AieSourceStatus, assembledAt: string, prior: readonly AthleteState[]): string | null {
  if (status !== "down") return assembledAt;
  const sorted = [...prior].sort((a, b) => (a.assembledAt < b.assembledAt ? 1 : -1));
  for (const s of sorted) {
    const h = s.sources?.aie;
    if (h) {
      if (h.lastGoodAt) return h.lastGoodAt;
      continue;
    }
    if (!legacyLooksDown(s)) return s.assembledAt;
  }
  return null;
}

export interface AieOutage {
  down: boolean;
  reauthNeeded: boolean;
  /** Newest good sync, or null when unknown. */
  since: string | null;
  failedTools: string[];
}

/** Pure: the outage view of ANY snapshot — `sources` when present, else inferred from raw read errors. */
export function aieOutage(state: AthleteState): AieOutage {
  const h = state.sources?.aie;
  if (h) return { down: !h.ok, reauthNeeded: h.reauthNeeded, since: h.lastGoodAt, failedTools: h.failedTools };
  const tools = aieToolKeys(state.raw);
  const j = judgeAieReads(state.raw, tools);
  const down = tools.length > 0 && j.status === "down";
  return { down, reauthNeeded: j.reauthNeeded, since: down ? null : state.assembledAt, failedTools: j.failedTools };
}
