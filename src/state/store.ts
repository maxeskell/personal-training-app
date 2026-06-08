import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import type { AthleteState } from "./types.js";

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
    await writeFile(this.fileFor(state.date), JSON.stringify(state, null, 2));
  }

  async load(date: string): Promise<AthleteState | undefined> {
    try {
      return JSON.parse(await readFile(this.fileFor(date), "utf8")) as AthleteState;
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
