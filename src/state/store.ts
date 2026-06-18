import { mkdir, readFile, writeFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { config } from "../config.js";
import { emptyState, type AthleteState } from "./types.js";

/** A Provenanced slot is `{ value, source }`. A persisted (possibly hand-edited) slot that isn't that
 * shape must be treated as corrupt and dropped back to `absent()`, never trusted by a consumer. */
function looksProvenanced(x: unknown): boolean {
  return !!x && typeof x === "object" && "source" in (x as object) && "value" in (x as object);
}

/**
 * Dead-simple local-first store: one JSON file per day under data/state/.
 * Flat files keep the store inspectable and git-diffable; swap for SQLite later
 * if query needs grow. Data dir is gitignored (contains personal data).
 */
export class StateStore {
  private readonly dir = join(config.dataDir, "state");

  private fileFor(date: string): string {
    return join(this.dir, `${date}.json`);
  }

  async save(state: AthleteState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // Atomic write (temp + rename) prevents a concurrent reader seeing a half-written file. The
    // cross-process LOCK additionally serializes writers — the dashboard autosync (/refresh) and a cron
    // `update` can otherwise both assemble and rename today.json, last-writer-wins. proper-lockfile is
    // the same primitive the decision log uses; a stale lock (crash) is reclaimed after `stale`.
    const release = await lockfile.lock(this.dir, {
      stale: 20_000,
      realpath: false,
      retries: { retries: 15, factor: 1.5, minTimeout: 100, maxTimeout: 1000 },
    });
    try {
      const final = this.fileFor(state.date);
      const tmp = `${final}.${process.pid}.tmp`;
      // The athlete profile is ambient context attached in-memory for the coaching prompts — it must
      // NEVER reach disk (medical data, DOB, …). Strip it here so the privacy guarantee is enforced at
      // the store layer, not left to every caller saving before it attaches the profile.
      const { profile: _profile, ...persistable } = state;
      await writeFile(tmp, JSON.stringify(persistable, null, 2));
      await rename(tmp, final);
    } finally {
      await release();
    }
  }

  async load(date: string): Promise<AthleteState | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.fileFor(date), "utf8")) as Partial<AthleteState> & { date: string; assembledAt?: string };
      // Normalise against the current schema: states persisted by an older build are missing slots
      // added since (zones, trainingStatus, racePredictions, …). Merging over emptyState() fills those
      // with `absent()` provenance so consumers can always read `state.<slot>.value` without crashing.
      const empty = emptyState(parsed.date ?? date, parsed.assembledAt ?? new Date().toISOString());
      const merged: Record<string, unknown> = { ...empty, ...parsed };
      // Shape-guard: a present-but-malformed Provenanced slot (corrupt write, hand-edit, schema drift)
      // is dropped back to the `absent()` default rather than passed through to crash a consumer.
      for (const [k, ev] of Object.entries(empty)) {
        if (looksProvenanced(ev) && !looksProvenanced(merged[k])) merged[k] = ev;
      }
      return merged as unknown as AthleteState;
    } catch {
      return undefined;
    }
  }

  /** All persisted dates, ascending. */
  async dates(): Promise<string[]> {
    try {
      const files = await readdir(this.dir);
      return files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""))
        .sort();
    } catch {
      return [];
    }
  }

  /** Load the `n` most recent states up to and including `date`, ascending. */
  async recent(date: string, n: number): Promise<AthleteState[]> {
    const dates = (await this.dates()).filter((d) => d <= date).slice(-n);
    const states = await Promise.all(dates.map((d) => this.load(d)));
    return states.filter((s): s is AthleteState => Boolean(s));
  }

  /**
   * Lightweight history read for trend slopes: the `n` most recent snapshots (≤ `date`) reduced to
   * `{ date, v }` via `valueOf`. Parsed one at a time (not `Promise.all`) so peak memory stays at a
   * single full state — snapshots embed raw API payloads, so retaining hundreds would be wasteful when
   * a slope only needs one scalar per day. Points where `valueOf` is undefined/non-finite are dropped.
   */
  async series(date: string, n: number, valueOf: (s: AthleteState) => number | undefined): Promise<Array<{ date: string; v: number }>> {
    const dates = (await this.dates()).filter((d) => d <= date).slice(-n);
    const out: Array<{ date: string; v: number }> = [];
    for (const d of dates) {
      const s = await this.load(d);
      const v = s ? valueOf(s) : undefined;
      if (v != null && Number.isFinite(v)) out.push({ date: d, v });
    }
    return out;
  }
}
