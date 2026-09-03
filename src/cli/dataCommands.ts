import { config } from "../config.js";
import { ArchiveStore } from "../archive/store.js";
import { GarminClient } from "../mcp/garminClient.js";
import { withAie, todayIso } from "../coach/orchestrator.js";
import { extractJson, garminInner } from "../state/assemble.js";
import { scanKeys, firstObjectArray, listCoverage } from "../util/keyScan.js";
import { backfillActivities, backfillGarmin, backfillGarminActivities, earliestGarminActivityDate } from "../archive/backfill.js";
import { syncFitSummaries } from "../archive/fitSync.js";
import { recoverGaps, DEFAULT_RECOVER_STALE_DAYS } from "../archive/recover.js";
import { activityArchiveDir, importDir, archiveSummary } from "../archive/activityArchive.js";
import { backfillGarminFits } from "../archive/activityArchiveBackfill.js";

/**
 * Data/archive CLI commands (backfill / probe / fit-sync / archive-status / archive-compact), extracted
 * from the monolithic cli.ts so the entry point stays a thin dispatcher. Behaviour unchanged.
 */

/**
 * `backfill [fromDate] [--chunk N]` — archive full history.
 *  - AIE activities (month-paged, ~2024+) + AIE recovery already in the daily snapshot.
 *  - Garmin ACTIVITIES: ALL of them (the full decade), paginated — one-shot, fast.
 *  - Garmin DAILY metrics (sleep/HRV/RHR): from your earliest Garmin activity forward, throttled,
 *    resumable, and CHUNKED (--chunk N caps days per run) so a decade grinds over days/weeks.
 *  `fromDate` defaults to "auto" (earliest Garmin activity). Pass a date to override.
 */
export async function cmdBackfill(): Promise<void> {
  const args = process.argv.slice(3);
  const chunkIdx = args.indexOf("--chunk");
  const chunk = chunkIdx >= 0 ? Number(args[chunkIdx + 1]) : Infinity;
  const dailyOnly = args.includes("--daily-only"); // scheduled grind uses this (skips AIE + activity re-paginate)
  const fromArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || "auto";
  const to = todayIso();
  const store = new ArchiveStore();
  console.log(`\nBackfilling into ${config.dataDir}/archive/ …\n`);

  // AIE activities (only go back to ~2024) — skipped in daily-only grind mode.
  if (!dailyOnly) {
    await withAie(async (aie) => {
      const added = await backfillActivities(aie, store, fromArg === "auto" ? "2024-01-01" : fromArg, to, (m) => console.log(m));
      console.log(`AIE activities: +${added} new.\n`);
    });
  }

  if (!config.garmin.enabled) {
    console.log("Garmin disabled — skipped (set GARMIN_ENABLED=true to include it).\n");
  } else {
    const g = new GarminClient();
    if (await g.connect()) {
      // All Garmin activities first (fast, gives us the earliest date) — skipped in grind mode.
      if (!dailyOnly) {
        console.log("Garmin activities (full history, paginated):");
        const a = await backfillGarminActivities(g, store, (m) => console.log(m));
        console.log(`Garmin activities: +${a} new.\n`);
      }

      const from = fromArg === "auto" ? (await earliestGarminActivityDate(store)) ?? "2014-01-01" : fromArg;
      console.log(`Garmin daily metrics from ${from} (throttled, resumable${Number.isFinite(chunk) ? `, ${chunk}/run` : ""}):`);
      const d = await backfillGarmin(g, store, from, to, (m) => console.log(m), 250, chunk);
      console.log(`Garmin daily: +${d} new days.\n`);
      await g.close();
    } else {
      console.log("Garmin enabled but unavailable — skipped (re-run when connected).\n");
    }
  }

  await printArchiveStatus(store);
}

/**
 * `probe` — Phase-2 data introspection. Lists the live Garmin MCP tool surface and captures one sample
 * payload per tool (trying common arg shapes), plus AIE run+ride activity summary-vs-detail so we can
 * confirm the activityId join — and a FIELD HUNT that reports where durability / decoupling / drift /
 * power_is_from_hr keys live and how densely durability is populated (AIE's 2026-08 durability-for-all-
 * workouts update lands as data, not a tool change, so this is the check that confirms it). Writes
 * everything to a gitignored reports/ file to build mappers against REAL field shapes instead of
 * guesses. Review before sharing — it's your own data.
 */
export async function cmdProbe(): Promise<void> {
  const today = todayIso();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const out: Record<string, unknown> = { capturedAt: new Date().toISOString(), today };

  // --- Garmin: list the tool surface, then sample each tool with candidate arg shapes ---
  if (!config.garmin.enabled) {
    console.log("Garmin disabled (GARMIN_ENABLED=false) — skipping Garmin probe. Set it true + auth to capture health metrics.");
  } else {
    const g = new GarminClient();
    if (await g.connect()) {
      const tools = await g.listToolNames();
      console.log(`\nGarmin tools available (${tools.length}):\n  ${tools.join("\n  ")}\n`);

      // SAFETY: only sample read-only tools. Never call mutating ones (set_/add_/delete_/upload_/…).
      const readOnly = (name: string) => /^(get_|count_)/.test(name) && name !== "request_reload";

      // Many tools need a real activity_id — pull a recent one from get_activities first.
      let activityId: number | string | undefined;
      try {
        const actsRaw = garminInner(await g.tryCall("get_activities", { limit: 5 }));
        const list = (actsRaw as { activities?: Array<Record<string, unknown>> })?.activities ?? (Array.isArray(actsRaw) ? (actsRaw as Array<Record<string, unknown>>) : []);
        const a0 = list[0] ?? {};
        // get_activities reports the id as `id` (not `activityId`) — accept either.
        activityId = (a0.activityId ?? a0.id ?? a0.activity_id) as number | string | undefined;
        console.log(`  (using activity_id=${activityId} for per-activity tools)`);
      } catch { /* best effort */ }

      const argCandidates: Array<Record<string, unknown>> = [
        {},
        { date: today },
        { start_date: weekAgo, end_date: today },
        { end_date: today },
        { start_date: monthAgo },
        ...(activityId != null ? [{ activity_id: activityId }, { activity_id: activityId, start_date: weekAgo, end_date: today }] : []),
      ];
      const samples: Record<string, unknown> = {};
      let captured = 0, skipped = 0;
      for (const tool of tools) {
        if (!readOnly(tool)) { samples[tool] = { skipped: "non-read-only (not sampled)" }; skipped++; continue; }
        let sample: unknown = null;
        let usedArgs: Record<string, unknown> | null = null;
        for (const args of argCandidates) {
          const r = await g.tryCall(tool, args);
          if (r != null && !isErrorResult(r)) { sample = r; usedArgs = args; break; }
        }
        samples[tool] = { args: usedArgs, sample: sample ?? "(no non-error response for tried arg shapes)" };
        if (sample != null) captured++;
        console.log(`  · ${tool}: ${sample != null ? "captured" : "no data"}`);
      }
      console.log(`\nGarmin: ${captured} captured, ${skipped} mutating tools skipped, ${tools.length - captured - skipped} read-only with no data.`);
      out.garminTools = tools;
      out.garminSamples = samples;
      await g.close();
    } else {
      console.log("Garmin enabled but unavailable — run garmin-mcp-auth and retry.");
    }
  }

  // --- AIE: run + ride summary vs detail — join keys, zone/FTP fields, and the 2026-08 field hunt ---
  try {
    const aieSamples: Record<string, unknown> = {};
    await withAie(async (aie) => {
      // Per-tool best-effort: one tool erroring (e.g. a detail tool with no callable arg shape — the
      // activity_id join gap, Insight_Engine_Spec §6) must not cost the probe the other samples; that ONE
      // sample degrades to a probeError note instead.
      for (const tool of ["getRunningActivity", "getRunningActivityDetail", "getCyclingActivity", "getCyclingActivityDetail", "getUser"] as const) {
        try {
          aieSamples[tool] = extractJson(await aie.read(tool, {}));
        } catch (err) {
          aieSamples[tool] = { probeError: err instanceof Error ? err.message : String(err) };
        }
      }
      // 2026-08-25 (AIE reply, spec 10): the a1 fields are opt-in on the list tools (with_dfa_alpha1 —
      // production passes it), summaries carry an `id`, and the Detail tools are due to grow
      // with_dfa_alpha1 / with_power_curve durability payloads (they return a bare {} until AIE's
      // rollout lands). Sample the flagged + id-joined variants so the field hunt self-detects the
      // rollout — when the Detail sample stops being empty, phase 2 of spec 10 is buildable.
      for (const [tool, detail] of [
        ["getRunningActivity", "getRunningActivityDetail"],
        ["getCyclingActivity", "getCyclingActivityDetail"],
      ] as const) {
        try {
          const flagged = extractJson(await aie.read(tool, { with_dfa_alpha1: true }));
          aieSamples[`${tool}+with_dfa_alpha1`] = flagged;
          const id = (firstObjectArray(flagged)?.[0] as Record<string, unknown> | undefined)?.id;
          if (id != null) {
            aieSamples[`${detail}+flags`] = extractJson(
              await aie.read(detail, { activityId: id, with_dfa_alpha1: true, with_power_curve: true }),
            );
          }
        } catch (err) {
          aieSamples[`${tool}+with_dfa_alpha1`] = { probeError: err instanceof Error ? err.message : String(err) };
        }
      }
    });
    out.aieSamples = aieSamples;
    console.log("\nAIE: sampled getRunningActivity(+Detail) + getCyclingActivity(+Detail) + getUser (join-key / zone / FTP inspection).");

    // Field hunt for AIE's 2026-08 announcements: per-workout durability for ALL run & ride workouts
    // (previously DFA-α1-only — spec 08 measured run 20% / ride 4% coverage) and the partner-API-documented
    // power_is_from_hr honesty flag. Prints key NAMES + types + coverage only — values stay in the report.
    const HUNT = [/durab/i, /decoupl/i, /drift/i, /dfa/i, /alpha/i, /power_?is_?from_?hr/i, /(^|_)id$/i, /curve/i, /within/i, /time_?series/i];
    const hunt: Record<string, unknown> = {};
    console.log("\nAIE field hunt (durability / decoupling / drift / DFA-α1 / power_is_from_hr / id / curve / within / time-series):");
    for (const [tool, sample] of Object.entries(aieSamples)) {
      const hits = scanKeys(sample, HUNT, { maxHits: 40 });
      const list = firstObjectArray(sample);
      const coverage = list ? listCoverage(list, [/durab/i, /decoupl/i, /drift/i]) : null;
      hunt[tool] = { hits, coverage };
      const uniqueKeys = [...new Set(hits.map((h) => h.key))];
      const head = uniqueKeys.length ? uniqueKeys.slice(0, 4).join(", ") + (uniqueKeys.length > 4 ? ", …" : "") : "no matching keys";
      const cov = coverage && coverage.keys.length ? ` — durability-ish populated on ${coverage.withValue}/${coverage.total} items` : "";
      console.log(`  · ${tool}: ${head}${cov}`);
    }
    out.aieFieldHunt = hunt;
  } catch (err) {
    console.log(`\nAIE probe skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = join(process.cwd(), "reports");
  await mkdir(dir, { recursive: true });
  // Timestamp to the second so repeated runs in a day don't overwrite each other.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); // YYYY-MM-DDTHH-MM-SS
  const path = join(dir, `probe-${stamp}.json`);
  await writeFile(path, JSON.stringify(out, null, 2));
  console.log(`\nProbe written → ${path}`);
  console.log("Review it (it's your own health data, gitignored), redact anything you want, then share it back so I can build the Phase-2 mappers against your real field shapes.");
}

/**
 * `fit-sync [n]` — pull the most recent n Garmin run/ride/swim activities into BOTH .FIT layers:
 * per-activity summaries via get_activity_fit_data (+ get_activity_weather) → archive (heat confounder,
 * thermal block), and raw per-second streams via download_activity_file → data/fit-streams/ (decoupling /
 * cadence / GCT). Resumable: archived ids and existing stream files are skipped. On garmin_mcp builds
 * older than d31de79 the stream layer degrades to manual export (Garmin Connect → Export Original).
 */
export async function cmdFitSync(): Promise<void> {
  if (!config.garmin.enabled) {
    console.error("\nGarmin is disabled. Set GARMIN_ENABLED=true (and run garmin-mcp-auth) to sync.\n");
    process.exit(1);
  }
  const limit = Number(process.argv[3]) || 25;
  const store = new ArchiveStore();
  const g = new GarminClient();
  if (!(await g.connect())) {
    console.error("\nGarmin unavailable — run garmin-mcp-auth and retry.\n");
    process.exit(1);
  }
  try {
    console.log(`\nfit-sync: scanning ${limit} recent activities → fit-summaries archive\n`);
    const r = await syncFitSummaries(g, store, limit, (m) => console.log(m));
    console.log(`\nfit-sync: +${r.added} new summaries, ${r.skipped} already archived, ${r.failed} failed → data/archive/fit-summaries.jsonl`);
    console.log(`fit-sync: ⬇ ${r.streamsDownloaded} raw .FIT streams, ${r.streamsFailed} failed → data/fit-streams/ ${r.streamsSupported ? "(biomechanics layer)" : "(download tool unavailable — garmin_mcp too old; streams need a manual Export Original)"}`);
    // Surface WHY a stream download failed (was previously swallowed to a single log line) so a missing
    // biomechanics layer is never a silent zero.
    for (const f of r.streamFailures) console.log(`  ! ${f}`);
    console.log("Summaries feed the heat confounder + the session card's thermal block; streams unlock decoupling/cadence/GCT.");
  } finally {
    await g.close();
  }
}

/**
 * `archive-import [--from <dir>] [--source <name>]` — import an activity-file export (e.g. a TrainingPeaks
 * "WorkoutFileExport") into the DURABLE archive at data/activity-archive/, deduped by content. With no
 * `--from`, just prints the archive status. Idempotent — re-running only adds genuinely-new files.
 */
export async function cmdActivityArchiveImport(): Promise<void> {
  const args = process.argv.slice(3);
  const fromIdx = args.indexOf("--from");
  const from = fromIdx >= 0 ? args[fromIdx + 1] : undefined;
  const srcIdx = args.indexOf("--source");
  const source = srcIdx >= 0 ? args[srcIdx + 1] : "import";
  const dir = activityArchiveDir();
  if (from) {
    console.log(`\nImporting activity files from ${from} → ${dir} (deduped, keeps all formats) …`);
    const t0 = Date.now();
    const s = importDir(from, source, dir, (p) => process.stdout.write(`\r  …${p.scanned} scanned, ${p.archived} archived, ${p.duplicates} dup  `));
    process.stdout.write("\n");
    console.log(
      `Imported: +${s.archived} new, ${s.duplicates} duplicate(s), ${s.errors} error(s), ${s.skipped} non-activity skipped ` +
        `(${s.scanned} activity files in ${((Date.now() - t0) / 1000).toFixed(0)}s).`,
    );
  }
  printActivityArchiveStatus(dir);
}

/**
 * `archive-backfill [--chunk N]` — pull raw `.FIT` for your Garmin activity HISTORY into the durable
 * archive. Resumable (skips already-archived ids), throttled, and chunked (--chunk caps a run). Run it a
 * few times (or with a chunk) to grind a decade without hammering Garmin.
 */
export async function cmdActivityArchiveBackfill(): Promise<void> {
  if (!config.garmin.enabled) {
    console.error("\nGarmin is disabled. Set GARMIN_ENABLED=true (and run garmin-mcp-auth) to backfill.\n");
    process.exit(1);
  }
  const args = process.argv.slice(3);
  const chunkIdx = args.indexOf("--chunk");
  const chunk = chunkIdx >= 0 ? Number(args[chunkIdx + 1]) : Infinity;
  const dir = activityArchiveDir();
  const store = new ArchiveStore();
  const g = new GarminClient();
  if (!(await g.connect())) {
    console.error("\nGarmin unavailable — run garmin-mcp-auth and retry.\n");
    process.exit(1);
  }
  try {
    console.log(`\narchive:backfill — pulling raw .FIT for your Garmin history → ${dir}\n`);
    const added = await backfillGarminActivities(g, store, (m) => console.log(m)); // ensure the id list is current
    if (added) console.log(`  (+${added} newly-listed activities)`);
    const acts = await store.loadGarminActivities();
    const r = await backfillGarminFits(g, acts, { chunk: Number.isFinite(chunk) ? chunk : undefined }, (m) => console.log(m));
    console.log(
      `\narchive:backfill: ${r.pending} pending of ${r.total} activities → ⬇ ${r.downloaded} downloaded, ` +
        `+${r.archived} archived, ${r.duplicates} already-had, ${r.failed} failed.`,
    );
    for (const f of r.failures.slice(0, 20)) console.log(`  ! ${f}`);
    if (r.pending > r.archived + r.duplicates + r.failed) console.log("  …resumable — re-run to continue (use --chunk N to cap each run).");
  } finally {
    await g.close();
  }
  printActivityArchiveStatus(dir);
}

/**
 * `archive-heal [--chunk N]` — the RECURRING gap-filler (vs `archive-backfill`, the one-time full pull).
 * Refreshes the Garmin activity list INCREMENTALLY (stops once it reaches already-known activities, so it's
 * cheap to run often) and pulls the raw `.FIT` for any recent activity not yet archived. Bounded by --chunk
 * (default 200). Designed to run on a schedule (see `npm run archive:heal:install`) so gaps self-heal.
 */
export async function cmdActivityArchiveHeal(): Promise<void> {
  if (!config.garmin.enabled) {
    console.error("\nGarmin is disabled. Set GARMIN_ENABLED=true (and run garmin-mcp-auth) to auto-heal the archive.\n");
    process.exit(1);
  }
  const args = process.argv.slice(3);
  const chunkIdx = args.indexOf("--chunk");
  const chunk = chunkIdx >= 0 ? Number(args[chunkIdx + 1]) : Number(process.env.COACH_ARCHIVE_HEAL_CHUNK ?? 200);
  const dir = activityArchiveDir();
  const store = new ArchiveStore();
  const g = new GarminClient();
  if (!(await g.connect())) {
    console.error("\nGarmin unavailable — run garmin-mcp-auth and retry.\n");
    process.exit(1);
  }
  try {
    const newlyListed = await backfillGarminActivities(g, store, () => {}, 100, true); // incremental: cheap in steady state
    const acts = await store.loadGarminActivities();
    const r = await backfillGarminFits(g, acts, { chunk }, (m) => console.log(m));
    console.log(
      `archive:heal — ${newlyListed} newly-listed; ${r.pending} pending of ${r.total} → ⬇ ${r.downloaded}, +${r.archived} archived, ${r.failed} failed (≤${chunk}/run).`,
    );
    for (const f of r.failures.slice(0, 10)) console.log(`  ! ${f}`);
  } finally {
    await g.close();
  }
}

function printActivityArchiveStatus(dir: string): void {
  const s = archiveSummary(dir);
  const fmt = (o: Record<string, number>) =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(", ") || "—";
  console.log(`\nActivity archive (${s.dir}):`);
  console.log(`  files:   ${s.total}  (${(s.totalBytes / 1e6).toFixed(1)} MB on disk)`);
  console.log(`  dates:   ${s.dateRange}`);
  console.log(`  formats: ${fmt(s.byFormat)}`);
  console.log(`  sports:  ${fmt(s.bySport)}`);
  console.log(`  sources: ${fmt(s.bySource)}`);
}

/** A Garmin MCP result is an "error" if flagged isError or its text is a tool/validation error. */
function isErrorResult(r: unknown): boolean {
  if (r && typeof r === "object") {
    if ((r as { isError?: boolean }).isError) return true;
    const text = (r as { content?: Array<{ text?: string }> }).content?.[0]?.text;
    if (typeof text === "string" && /Error executing tool|validation error|Field required/.test(text)) return true;
  }
  return false;
}

async function printArchiveStatus(store: ArchiveStore): Promise<void> {
  const s = await store.summary();
  console.log(`\nArchive (${config.dataDir}/archive/):`);
  console.log(`  AIE activities:    ${s.activities} (${s.actRange})`);
  // The 30-minute Garmin grind prints this line 48× a day — make it a lag monitor too (spec 11: the AIE
  // archive sat at 28 Aug for six days in plain sight while every run said nothing).
  const aieNewest = /(\d{4}-\d{2}-\d{2})\s*$/.exec(String(s.actRange ?? ""))?.[1];
  const lagDays = aieNewest ? Math.round((Date.parse(todayIso()) - Date.parse(aieNewest)) / 86_400_000) : null;
  if (lagDays != null && lagDays > DEFAULT_RECOVER_STALE_DAYS) {
    console.log(`  ⚠ AI Endurance activities are ${lagDays}d behind — run \`npm run catch-up\`; if it keeps lagging, \`npm run doctor\` → "AI Endurance live read"`);
  }
  console.log(`  Garmin activities: ${s.garminActivities} (${s.garActRange})`);
  console.log(`  Garmin daily:      ${s.garminDays} days (${s.garRange})`);
}

/** `archive-status` — show what's archived (used by `npm run backfill:status`). */
export async function cmdArchiveStatus(): Promise<void> {
  await printArchiveStatus(new ArchiveStore());
}

/**
 * `archive-compact` — physically de-duplicate the archive files (one record per date/id). The loaders
 * already dedup on read, so this is housekeeping: it shrinks the on-disk JSONL and realigns the raw
 * line counts with the distinct counts. Safe to re-run; a no-op when there's nothing to remove.
 */
export async function cmdArchiveCompact(): Promise<void> {
  const store = new ArchiveStore();
  const report = await store.compact();
  const total = report.reduce((n, r) => n + r.removed, 0);
  console.log(`\nCompacting ${config.dataDir}/archive/ …\n`);
  for (const r of report) {
    const note = r.removed ? `−${r.removed} dup(s) → ${r.after}` : "no dups";
    console.log(`  ${r.file.padEnd(24)} ${String(r.before).padStart(6)} → ${String(r.after).padStart(6)}  (${note})`);
  }
  console.log(total ? `\nRemoved ${total} duplicate record(s).` : "\nNothing to compact — archive already clean.");
  await printArchiveStatus(store);
}

/**
 * `catch-up` — automatic gap recovery after a connection was down for a while. Measures how far each source
 * (AI Endurance activities, Garmin daily, Garmin activities+streams) is behind today and, for any that are
 * stale AND reachable now, downloads exactly the missing span. Unlike the fixed-window jobs (dashboard
 * refresh syncs the 5 latest, `fit-sync` the 25 latest, `archive-heal` a ≤200 backlog slice), it sizes the
 * backfill to the actual gap, so a multi-week outage is healed in one pass. Best-effort per source — a still-
 * unreachable source is reported, not fatal. Also runs automatically on the morning ping.
 * `--stale-days N` overrides the trigger threshold (default 2).
 */
export async function cmdRecoverGaps(): Promise<void> {
  const args = process.argv.slice(3);
  const sdIdx = args.indexOf("--stale-days");
  const staleDaysArg = sdIdx >= 0 ? Number(args[sdIdx + 1]) : NaN;
  const staleDays = Number.isFinite(staleDaysArg) ? staleDaysArg : undefined;
  console.log(`\nCatch-up: checking each source's lag vs today${staleDays != null ? ` (stale > ${staleDays}d)` : ""} …\n`);
  const rec = await recoverGaps({ staleDays, log: (m) => console.log(m) });
  console.log("");
  for (const s of rec.sources) {
    const icon = s.status === "recovered" ? "⬇" : s.status === "current" ? "✓" : s.status === "disabled" ? "·" : "⚠";
    const detail =
      s.status === "recovered"
        ? `+${s.added}${s.streams != null ? ` (+${s.streams} streams)` : ""} over ${s.gapDays}d`
        : s.status === "current"
          ? `current (${s.gapDays}d behind)`
          : s.status === "disabled"
            ? "disabled"
            : `${s.status}${s.note ? ` — ${s.note}` : ""} (${s.gapDays}d behind)`;
    console.log(`  ${icon} ${s.source.padEnd(26)} ${detail}`);
  }
  console.log(`\n${rec.summary}`);
  await printArchiveStatus(new ArchiveStore());
}
