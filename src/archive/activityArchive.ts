/**
 * Durable, portable ARCHIVE of your raw activity files — the source-of-truth corpus you own forever and can
 * take anywhere, independent of Garmin / TrainingPeaks / AI Endurance.
 *
 * Design (see SETUP.md → "Activity archive"):
 *  - A COLD store at `data/activity-archive/` (gitignored), kept SEPARATE from the hot `data/fit-streams/`
 *    so it never slows the live dashboard (which scans fit-streams every request). Originals are preserved
 *    byte-for-byte (any format: .fit/.tcx/.pwx/.gpx, gzipped or not), foldered by year.
 *  - A `manifest.jsonl` index — one self-describing line per file — makes the folder portable + queryable
 *    and is the basis for DEDUP: identical content (hash of the *decompressed* bytes, so a `.gz` and its
 *    plain twin collapse) is never stored twice. Distinct FORMATS of the same activity are BOTH kept
 *    (lossless — the "keep all formats" policy). Append-only + resumable: re-running only adds the new.
 *
 * Feeds (built elsewhere): `archive:import` (an export folder → here), the Garmin raw-.FIT backfill, and an
 * auto-archive hook on sync (every future activity). This module is the store + dedup + metadata core.
 *
 * Best-effort + degrade-don't-crash: an unreadable/odd file is recorded as `format:"other"` with whatever
 * metadata we can derive (or skipped), never thrown.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { basename, join } from "node:path";
import { config } from "../config.js";
import { parseFit } from "../insights/fitParser.js";
import { parseTcx } from "../insights/tcxParser.js";
import { parsePwx } from "../insights/pwxParser.js";

/** Where the archive lives: $COACH_ARCHIVE_DIR, else <dataDir>/activity-archive. */
export function activityArchiveDir(): string {
  return process.env.COACH_ARCHIVE_DIR ?? join(config.dataDir, "activity-archive");
}
function manifestPath(dir = activityArchiveDir()): string {
  return join(dir, "manifest.jsonl");
}

export type ActivityFormat = "fit" | "tcx" | "pwx" | "gpx" | "other";

/** Activity file extensions we archive (each optionally `.gz`). CSV/JSON summaries are NOT activity files. */
const ACTIVITY_EXTS: ActivityFormat[] = ["fit", "tcx", "pwx", "gpx"];

export interface ArchiveEntry {
  /** Garmin activity id when derivable from the name, else `h<hash12>` — stable per activity. */
  id: string;
  /** sha256 of the DECOMPRESSED bytes — the dedup key (gz vs plain collapse; distinct formats don't). */
  contentHash: string;
  date: string; // YYYY-MM-DD ("" if undateable)
  sport: string; // Run | Ride | Swim | … | "unknown"
  format: ActivityFormat;
  gzipped: boolean;
  source: string; // "trainingpeaks" | "garmin" | "import" | …
  originalName: string;
  /** Path relative to the archive dir, e.g. "by-year/2015/3126568831.fit.gz". */
  path: string;
  bytes: number;
  importedAt: string; // ISO date
}

/** Classify a filename → {format, gzipped} (case-insensitive, handles a single `.gz`). null if not an activity file. */
export function classify(name: string): { format: ActivityFormat; gzipped: boolean } | null {
  const lower = name.toLowerCase();
  const gzipped = lower.endsWith(".gz");
  const base = gzipped ? lower.slice(0, -3) : lower;
  const ext = base.slice(base.lastIndexOf(".") + 1) as ActivityFormat;
  return ACTIVITY_EXTS.includes(ext) ? { format: ext, gzipped } : null;
}

const num2 = (n: number) => String(n).padStart(2, "0");

/** Pull a date out of a filename when parsing can't: ISO `2015-12-26`, or TrainingPeaks `DD_MM_YYYY`. */
function dateFromName(name: string): string {
  const iso = name.match(/(20\d{2})[-_]?(\d{2})[-_]?(\d{2})/);
  if (iso && +iso[2] >= 1 && +iso[2] <= 12 && +iso[3] >= 1 && +iso[3] <= 31) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = name.match(/(\d{2})_(\d{2})_(20\d{2})/); // DD_MM_YYYY
  if (dmy && +dmy[2] >= 1 && +dmy[2] <= 12) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return "";
}

/** Garmin activity id from the filename (`…GarminPush.3126568831.fit.gz`, `12345.fit`, `activity_12345.tcx`). */
function idFromName(name: string): string | undefined {
  const m = name.match(/(?:^|[._-])(\d{6,})(?=\.[a-z]+(?:\.gz)?$)/i) ?? name.match(/(\d{6,})/);
  return m?.[1];
}

/** Decode date + sport from the (decompressed) bytes via the right parser; best-effort. */
function metadata(decompressed: Buffer, format: ActivityFormat): { date: string; sport: string } {
  try {
    const fit = format === "fit" ? parseFit(decompressed) : format === "tcx" ? parseTcx(decompressed) : format === "pwx" ? parsePwx(decompressed) : null;
    if (fit) {
      const firstT = fit.samples.find((s) => s.t != null)?.t ?? fit.laps.find((l) => l.startTimeS != null)?.startTimeS;
      const date = firstT != null ? new Date(firstT * 1000).toISOString().slice(0, 10) : "";
      return { date, sport: fit.sportName || "unknown" };
    }
  } catch {
    /* fall through to name-based */
  }
  return { date: "", sport: "unknown" };
}

export interface ArchiveResult {
  archived: boolean;
  reason?: "duplicate" | "not-activity" | "error";
  entry?: ArchiveEntry;
}

/**
 * Archive one activity file (raw bytes + original name) into the cold store, deduped by content. Idempotent:
 * a byte-identical file already present returns `{archived:false, reason:"duplicate"}`. Pure aside from the
 * one write + manifest append; the caller supplies `hashes` (the existing content hashes) so a bulk import
 * dedups in-memory without re-reading the manifest per file.
 */
export function archiveBuffer(
  buf: Buffer,
  opts: { originalName: string; source: string },
  hashes: Set<string>,
  dir = activityArchiveDir(),
): ArchiveResult {
  const cls = classify(opts.originalName);
  if (!cls) return { archived: false, reason: "not-activity" };
  try {
    let decompressed = buf;
    if (cls.gzipped) {
      try {
        decompressed = gunzipSync(buf);
      } catch {
        decompressed = buf; // corrupt gzip — still archive the original, hash it raw
      }
    }
    const contentHash = createHash("sha256").update(decompressed).digest("hex");
    if (hashes.has(contentHash)) return { archived: false, reason: "duplicate" };

    const meta = metadata(decompressed, cls.format);
    const date = meta.date || dateFromName(opts.originalName);
    const year = /^\d{4}-/.test(date) ? date.slice(0, 4) : "undated";
    const id = idFromName(opts.originalName) ?? `h${contentHash.slice(0, 12)}`;
    const extChain = `${cls.format}${cls.gzipped ? ".gz" : ""}`;
    const yearDir = join(dir, "by-year", year);
    mkdirSync(yearDir, { recursive: true });
    // <id>.<ext> — content-hash dedup means a name clash here is a genuinely different recording; suffix it.
    let fileName = `${id}.${extChain}`;
    if (existsSync(join(yearDir, fileName))) fileName = `${id}-${contentHash.slice(0, 6)}.${extChain}`;
    const rel = join("by-year", year, fileName);
    writeFileSync(join(dir, rel), buf);

    const entry: ArchiveEntry = {
      id,
      contentHash,
      date,
      sport: meta.sport,
      format: cls.format,
      gzipped: cls.gzipped,
      source: opts.source,
      originalName: basename(opts.originalName),
      path: rel,
      bytes: buf.length,
      importedAt: new Date().toISOString().slice(0, 10),
    };
    appendFileSync(manifestPath(dir), JSON.stringify(entry) + "\n");
    hashes.add(contentHash);
    return { archived: true, entry };
  } catch {
    return { archived: false, reason: "error" };
  }
}

/** Read the manifest (dedup on contentHash, last write wins). Empty when absent. Never throws. */
export function loadManifest(dir = activityArchiveDir()): ArchiveEntry[] {
  const p = manifestPath(dir);
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const byHash = new Map<string, ArchiveEntry>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as ArchiveEntry;
      if (e.contentHash) byHash.set(e.contentHash, e);
    } catch {
      /* skip a partial line */
    }
  }
  return [...byHash.values()];
}

/** The set of content hashes already archived — the dedup index for an import/backfill/sync. */
export function manifestHashes(dir = activityArchiveDir()): Set<string> {
  return new Set(loadManifest(dir).map((e) => e.contentHash));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const p = join(dir, n);
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (isDir) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

export interface ImportStats {
  scanned: number;
  archived: number;
  duplicates: number;
  skipped: number; // non-activity files (csv/json/…)
  errors: number;
}

/** Recursively import every activity file under `srcDir` into the archive, deduped. Idempotent. */
export function importDir(srcDir: string, source: string, dir = activityArchiveDir(), onProgress?: (s: ImportStats) => void): ImportStats {
  const stats: ImportStats = { scanned: 0, archived: 0, duplicates: 0, skipped: 0, errors: 0 };
  if (!existsSync(srcDir)) return stats;
  mkdirSync(dir, { recursive: true });
  const hashes = manifestHashes(dir);
  for (const path of walk(srcDir)) {
    if (!classify(basename(path))) {
      stats.skipped++;
      continue;
    }
    stats.scanned++;
    let buf: Buffer;
    try {
      buf = readFileSync(path);
    } catch {
      stats.errors++;
      continue;
    }
    const r = archiveBuffer(buf, { originalName: basename(path), source }, hashes, dir);
    if (r.archived) stats.archived++;
    else if (r.reason === "duplicate") stats.duplicates++;
    else stats.errors++;
    if (onProgress && stats.scanned % 250 === 0) onProgress(stats);
  }
  return stats;
}

export interface ArchiveSummary {
  total: number;
  dateRange: string;
  byFormat: Record<string, number>;
  bySport: Record<string, number>;
  bySource: Record<string, number>;
  totalBytes: number;
  dir: string;
}

/** A status readout over the manifest — counts, date range, format/sport/source breakdowns, on-disk size. */
export function archiveSummary(dir = activityArchiveDir()): ArchiveSummary {
  const m = loadManifest(dir);
  const dated = m.map((e) => e.date).filter((d) => /^\d{4}-/.test(d)).sort();
  const tally = (key: (e: ArchiveEntry) => string) => {
    const o: Record<string, number> = {};
    for (const e of m) o[key(e)] = (o[key(e)] ?? 0) + 1;
    return o;
  };
  return {
    total: m.length,
    dateRange: dated.length ? `${dated[0]} → ${dated[dated.length - 1]}` : "—",
    byFormat: tally((e) => e.format),
    bySport: tally((e) => e.sport || "unknown"),
    bySource: tally((e) => e.source),
    totalBytes: m.reduce((a, e) => a + (e.bytes || 0), 0),
    dir,
  };
}
