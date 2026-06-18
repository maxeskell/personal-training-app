import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { findingKey, type Finding } from "../insights/metrics.js";

/**
 * Surfaced-insight history (the "what was I shown" record). Each time the engine surfaces findings to
 * the athlete — the dashboard Top-insights card, the MCP `insights` tool — we append a snapshot here, so
 * the agree/disagree/ignore feedback in the decision log can be read against the FULL set of things that
 * were put in front of you, not just the ones you reacted to. Pairs with the decision log to answer
 * "what do I listen to vs ignore" (see `coach/listening.ts`).
 *
 * Append-only JSONL in dataDir, same discipline as the decision/cost logs. Gitignored (personal).
 * De-duplicated: an unchanged surface (same findings, same text) is NOT re-appended on every page load,
 * so the log grows roughly once per real change rather than once per dashboard refresh.
 */

export const INSIGHT_LOG_SCHEMA_VERSION = 1;

/** The surface a snapshot was shown on (kept open-ended; just a label for later filtering). */
export type SurfaceKind = "dashboard" | "mcp-insights" | string;

/** One surfaced finding, captured in full (so the text survives even though findings recompute daily). */
export interface SurfacedFinding {
  key: string;
  family: string;
  title: string;
  severity: Finding["severity"];
  detail: string;
  evidence: string;
  recommendation?: string;
  confidence?: number;
}

export interface InsightSnapshot {
  ts: string; // ISO timestamp
  surface: SurfaceKind;
  findings: SurfacedFinding[];
  schemaVersion: number;
}

/** Capture a live Finding as a SurfacedFinding, resolving its stable key (used for feedback joins). */
export function toSurfaced(f: Finding): SurfacedFinding {
  return {
    key: findingKey(f),
    family: f.family,
    title: f.title,
    severity: f.severity,
    detail: f.detail,
    evidence: f.evidence,
    recommendation: f.recommendation,
    confidence: f.confidence,
  };
}

/**
 * Stable signature of a surfaced set — key + severity + detail per finding. Used to skip re-logging an
 * unchanged surface. Includes `detail` so a finding whose numbers moved IS captured as a new snapshot
 * (the point of keeping full text history), but identical repeat renders are not.
 */
export function snapshotSignature(findings: SurfacedFinding[]): string {
  return findings.map((f) => `${f.key}|${f.severity}|${f.detail}`).join("\n");
}

/** Earliest surfacing timestamp per finding key, across all snapshots. Pure — testable. */
export function firstSeenFrom(snapshots: InsightSnapshot[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const snap of snapshots) {
    for (const f of snap.findings) {
      const prior = out.get(f.key);
      if (prior == null || snap.ts < prior) out.set(f.key, snap.ts);
    }
  }
  return out;
}

export class InsightLog {
  private readonly file = join(config.dataDir, "insights", "log.jsonl");

  /** Earliest timestamp each finding key was surfaced — the insight's "age" / first-seen. */
  async firstSeenByKey(): Promise<Map<string, string>> {
    return firstSeenFrom(await this.all());
  }

  async all(): Promise<InsightSnapshot[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return []; // no log yet
    }
    const out: InsightSnapshot[] = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as InsightSnapshot);
      } catch {
        /* skip a malformed line rather than fail the whole read */
      }
    }
    return out;
  }

  /**
   * Append a snapshot of what was just surfaced, unless it's identical to the last snapshot on the same
   * surface. Best-effort: a logging failure must NEVER break a dashboard render or an MCP tool call.
   */
  async recordSurfaced(findings: Finding[], surface: SurfaceKind): Promise<void> {
    try {
      const surfaced = findings.map(toSurfaced);
      const sig = snapshotSignature(surfaced);
      const prior = (await this.all()).filter((s) => s.surface === surface);
      const last = prior[prior.length - 1];
      if (last && snapshotSignature(last.findings) === sig) return; // unchanged — don't re-log
      const record: InsightSnapshot = {
        ts: new Date().toISOString(),
        surface,
        findings: surfaced,
        schemaVersion: INSIGHT_LOG_SCHEMA_VERSION,
      };
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, JSON.stringify(record) + "\n");
    } catch {
      /* never let insight-history logging break a render or tool call */
    }
  }
}
