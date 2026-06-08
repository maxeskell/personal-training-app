import { mkdir, readFile, writeFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { emptyState, type AthleteState } from "./types.js";

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
    // Atomic write: a concurrent reader (the dashboard server) must never see a half-written file.
    // Write a temp file then rename (atomic on POSIX), so load() always parses a complete state.
    const final = this.fileFor(state.date);
    const tmp = `${final}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, final);
  }

  async load(date: string): Promise<AthleteState | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.fileFor(date), "utf8")) as Partial<AthleteState> & { date: string; assembledAt?: string };
      // Normalise against the current schema: states persisted by an older build are missing slots
      // added since (zones, trainingStatus, racePredictions, …). Merging over emptyState() fills those
      // with `absent()` provenance so consumers can always read `state.<slot>.value` without crashing.
      return { ...emptyState(parsed.date ?? date, parsed.assembledAt ?? new Date().toISOString()), ...parsed } as AthleteState;
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
}
