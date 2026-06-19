/**
 * Manual-export fallback for raw `.FIT` streams (the reliable path when the Garmin auto-download can't run
 * — Garmin off, an old garmin_mcp build, a fragile connection, or an activity outside the sync window).
 *
 * The flow: Garmin Connect → the activity → ⚙ → **Export Original** → drop the `.FIT` into the watched
 * streams dir (`FIT_STREAMS_DIR`, default `data/fit-streams/`). The loaders read ANY `*.fit` there and match
 * it to a session by the date+sport *inside* the file, so the filename is cosmetic. This module:
 *   - `reportStreamsDir()` — what's in the dir, each file's validity + a one-line summary (confirms the path);
 *   - `ingestFitFile()` — validate a dropped/exported `.FIT` at a path and copy it in, reporting what it found.
 *
 * Read-only to AI Endurance; never invents — an undecodable file is reported invalid, not silently kept.
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFit, type FitActivity } from "../insights/fitParser.js";
import { fitStreamsDir } from "../insights/fit.js";

export interface FitFileReport {
  file: string;
  valid: boolean;
  sport?: string;
  date?: string;
  durationMin?: number;
  laps?: number;
  lengths?: number;
  samples?: number;
  note?: string;
}

function summarize(name: string, fit: FitActivity | null): FitFileReport {
  if (!fit) return { file: name, valid: false, note: "not a decodable .FIT (header/signature failed)" };
  const firstT = fit.samples.find((s) => s.t != null)?.t ?? fit.laps.find((l) => l.startTimeS != null)?.startTimeS;
  return {
    file: name,
    valid: true,
    sport: fit.sportName,
    date: firstT != null ? new Date(firstT * 1000).toISOString().slice(0, 10) : undefined,
    durationMin: fit.session.durationSec != null ? Math.round(fit.session.durationSec / 60) : undefined,
    laps: fit.laps.length,
    lengths: fit.lengths.length,
    samples: fit.samples.length,
  };
}

/** Report every `.FIT` already in the streams dir — valid? + a one-line summary. Confirms the watched path. */
export function reportStreamsDir(dir = fitStreamsDir()): { dir: string; files: FitFileReport[] } {
  if (!existsSync(dir)) return { dir, files: [] };
  const names = readdirSync(dir)
    .filter((n) => /\.(fit|FIT)$/.test(n))
    .sort();
  const files = names.map((n) => {
    try {
      return summarize(n, parseFit(readFileSync(join(dir, n))));
    } catch {
      return { file: n, valid: false, note: "unreadable" };
    }
  });
  return { dir, files };
}

export interface IngestResult extends FitFileReport {
  ingested: boolean;
  dest?: string;
}

/** Validate a `.FIT` at `src` and, if it decodes, copy it into the streams dir so the tools can read it. */
export function ingestFitFile(src: string, dir = fitStreamsDir()): IngestResult {
  if (!existsSync(src)) return { file: src, valid: false, ingested: false, note: "file not found" };
  let fit: FitActivity | null = null;
  try {
    fit = parseFit(readFileSync(src));
  } catch {
    fit = null;
  }
  const rep = summarize(basename(src), fit);
  if (!fit) return { ...rep, ingested: false, note: "not a decodable .FIT — is it the *original* export (Export Original), not a .gpx/.tcx/.zip?" };
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, basename(src).replace(/\.FIT$/, ".fit"));
  if (existsSync(dest)) return { ...rep, ingested: false, dest, note: "already in the streams dir (skipped — delete it there first to re-ingest)" };
  copyFileSync(src, dest);
  return { ...rep, ingested: true, dest };
}

function summaryLine(r: FitFileReport): string {
  if (!r.valid) return `  ✗ ${r.file} — ${r.note ?? "invalid"}`;
  const bits = [r.sport ?? "?", r.date ?? "no date", r.durationMin != null ? `${r.durationMin}min` : "—", `${r.laps ?? 0} laps`, `${r.lengths ?? 0} lengths`, `${r.samples ?? 0} samples`];
  return `  ✓ ${r.file} — ${bits.join(", ")}`;
}

/** Render the streams-dir report, leading with the absolute watched path + the drop instructions. */
export function formatStreamsReport(rep: { dir: string; files: FitFileReport[] }): string[] {
  const lines = [
    `Raw .FIT streams dir (watched): ${rep.dir}`,
    "Drop 'Export Original' .FIT files here (any name ending .fit) — they're matched to a session by the date+sport inside the file, so the filename is cosmetic.",
    "",
  ];
  if (!rep.files.length) {
    lines.push("(empty — no .FIT files yet. Run the `sync` tool / `npm run fit-sync` to auto-fetch, or export originals from Garmin Connect and drop them here.)");
    return lines;
  }
  lines.push(`${rep.files.length} file(s):`, ...rep.files.map(summaryLine));
  const bad = rep.files.filter((f) => !f.valid).length;
  if (bad) lines.push("", `${bad} file(s) failed to decode — re-export the ORIGINAL .FIT (not .gpx/.tcx/.zip) and replace them.`);
  return lines;
}

/** Render a single ingest outcome. */
export function formatIngest(r: IngestResult): string[] {
  if (!r.valid) return [`✗ Could not ingest ${r.file}: ${r.note ?? "invalid .FIT"}`];
  if (!r.ingested) return [`• ${r.file}: ${r.note ?? "not ingested"}${r.dest ? ` (${r.dest})` : ""}`];
  return [
    `✓ Ingested ${r.file} → ${r.dest}`,
    `  ${r.sport ?? "?"} on ${r.date ?? "?"}, ${r.durationMin ?? "?"}min · ${r.laps ?? 0} laps, ${r.lengths ?? 0} lengths, ${r.samples ?? 0} samples.`,
    "  Now available to the `splits` and `session_feedback` tools.",
  ];
}
