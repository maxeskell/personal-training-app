/**
 * Granular-data completeness check (the "loud over silent" guardrail).
 *
 * The connector serves summary metrics well, but the per-interval structure underneath them (per-length
 * swim splits, run reps, in-session bike power) lives in the raw per-second `.FIT` stream. When that
 * stream isn't present locally, the deep analysis that needs it (session_feedback biomechanics, CSS from
 * a test set, per-interval splits) silently degrades. This module turns that silence into an explicit,
 * standing readout: for each recent session, is its raw `.FIT` parsed/present, and — if not — WHY
 * (Garmin off, not reachable, the download capability missing, or a download that failed).
 *
 * Pure + deterministic: it takes the recent activities, the streams actually present, and the capability
 * facts, and returns a report. The disk reads (which streams exist, which activities are recent) and the
 * Garmin capability facts are gathered by the caller (orchestrator) and fed in.
 */

export interface MissingStreamSession {
  date: string;
  sport: string;
}

export interface DataCompletenessReport {
  /** Recent sessions whose raw per-second `.FIT` isn't parsed/present locally (the gap). */
  missingStreams: MissingStreamSession[];
  /** Recent sessions whose `.FIT` IS present and parsed. */
  presentCount: number;
  /** Recent sessions considered (within the lookback window). */
  totalRecent: number;
  /** Lookback window used, in days. */
  lookbackDays: number;
  /** Human-readable capability + this-sync-outcome notes. */
  notes: string[];
  /** True when nothing material is missing (every recent session has its stream). */
  complete: boolean;
}

/** This-sync FIT-fetch outcome (a subset of FitSyncResult), present only on the `sync` fetch path. */
export interface FitSyncOutcome {
  streamsDownloaded: number;
  streamsFailed: number;
  streamsSupported: boolean;
  streamFailures?: string[];
}

export interface CompletenessInput {
  /** Recent activities as the coach sees them (date + sport). */
  recent: Array<{ date: string; sport: string }>;
  /** Streams actually present/parsed locally (date + sport), e.g. from loadSessionDecays(). */
  streams: Array<{ date: string; sport: string }>;
  /** ISO date the state describes (YYYY-MM-DD). */
  today: string;
  /** How far back to check for missing streams (default 10 days). */
  lookbackDays?: number;
  garminEnabled: boolean;
  /**
   * Whether Garmin connected on THIS sync. `true`/`false` when a fetch was attempted; `undefined` when
   * not attempted (e.g. get_state reading a snapshot) — the notes say so rather than implying a failure.
   */
  garminConnected?: boolean;
  /** This sync's FIT-fetch outcome, when a fetch was attempted. */
  fitSync?: FitSyncOutcome;
}

/** Sport-name tokens for the date+sport join — mirrors assembleSession's matching (Ride ↔ cycling). */
function sportTokens(sport: string): string[] {
  const s = sport.toLowerCase();
  if (/ride|cycl|bike/.test(s)) return ["ride", "cycl", "bike"];
  if (/run/.test(s)) return ["run"];
  if (/swim/.test(s)) return ["swim"];
  return [s];
}

function shiftIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Does a present stream match this activity by date + (fuzzy) sport? */
function hasStream(act: { date: string; sport: string }, streams: Array<{ date: string; sport: string }>): boolean {
  const tokens = sportTokens(act.sport);
  return streams.some((s) => s.date === act.date && tokens.some((t) => s.sport.toLowerCase().includes(t)));
}

export function assessCompleteness(input: CompletenessInput): DataCompletenessReport {
  const lookbackDays = input.lookbackDays ?? 10;
  const cutoff = shiftIso(input.today, -lookbackDays);

  // De-dup recent activities by date+sport, keep those inside the window.
  const seen = new Set<string>();
  const recent = input.recent
    .filter((a) => a.date && a.date >= cutoff && a.date <= input.today)
    .filter((a) => {
      const k = `${a.date}|${a.sport}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  const missingStreams: MissingStreamSession[] = [];
  let presentCount = 0;
  for (const a of recent) {
    if (hasStream(a, input.streams)) presentCount++;
    else missingStreams.push({ date: a.date, sport: a.sport });
  }
  missingStreams.sort((a, b) => b.date.localeCompare(a.date)); // newest first

  const notes: string[] = [];
  // Capability note — always exactly one, so the reason a stream is missing is never ambiguous.
  if (!input.garminEnabled) {
    notes.push("Garmin is disabled — raw .FIT auto-download is off; export originals into the streams dir to unlock deep analysis.");
  } else if (input.garminConnected === false) {
    notes.push("Garmin is enabled but was NOT reachable this sync (token/MFA?) — re-run garmin-mcp-auth; biomechanics & per-interval splits stay missing until it connects.");
  } else if (input.garminConnected === undefined) {
    notes.push("Capability is from the last snapshot — run `sync` to re-check Garmin and auto-fetch any recent .FIT streams.");
  } else if (input.fitSync && !input.fitSync.streamsSupported) {
    notes.push("Garmin connected, but this garmin_mcp build can't download raw streams (no download_activity_file) — export originals manually (Garmin Connect → ⚙ → Export Original).");
  } else {
    notes.push("Garmin connected; raw-stream download is supported.");
  }

  // This-sync FIT-fetch outcome — make a swallowed download loud (root cause: failures were log-only).
  if (input.fitSync) {
    const f = input.fitSync;
    notes.push(`This sync fetched ${f.streamsDownloaded} new raw stream(s); ${f.streamsFailed} failed.`);
    for (const reason of (f.streamFailures ?? []).slice(0, 3)) notes.push(`· ${reason}`);
  }

  return {
    missingStreams,
    presentCount,
    totalRecent: recent.length,
    lookbackDays,
    notes,
    complete: missingStreams.length === 0,
  };
}

/** Render the report as text lines for the `sync` / `get_state` MCP output (and CLI state). */
export function formatCompleteness(r: DataCompletenessReport): string[] {
  const lines: string[] = [];
  if (r.totalRecent === 0) {
    lines.push(`Data completeness: no sessions in the last ${r.lookbackDays}d to check.`);
  } else if (r.complete) {
    lines.push(`Data completeness: ✓ raw .FIT present for all ${r.totalRecent} recent session(s) (last ${r.lookbackDays}d).`);
  } else {
    lines.push(
      `Data completeness: ⚠ raw .FIT MISSING for ${r.missingStreams.length}/${r.totalRecent} recent session(s) (last ${r.lookbackDays}d) — ` +
        "per-interval splits (CSS, reps, in-session power) & biomechanics are unreachable for these until the .FIT is fetched or exported:",
    );
    for (const m of r.missingStreams) lines.push(`    - ${m.date} ${m.sport}`);
  }
  for (const n of r.notes) lines.push(`  ${n.startsWith("·") ? "  " : "· "}${n}`);
  return lines;
}
