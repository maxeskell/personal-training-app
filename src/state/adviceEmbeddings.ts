import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "../config.js";

/**
 * On-disk cache of recommendation embeddings, so the LLM-free render can cluster near-duplicate advice
 * (see `clusterAdvice` in coach/adviceRecs.ts) WITHOUT a network call. Keyed by advice key
 * (`advice:<source>:<slug>`); each entry pins the exact text and embedding model it was computed for, so a
 * changed recommendation text or a model swap re-embeds rather than clusters on a stale vector.
 *
 * Runtime-generated under `data/` — gitignored and written by the app, never user-authored, so (per the
 * repo's gitignored-data rule) it needs no committed template. An absent or corrupt cache simply yields an
 * empty index, which degrades to "no clustering" (every recommendation stays its own line).
 */
export const ADVICE_EMBED_SCHEMA_VERSION = 1;
/** Bound the cache so a long-lived install can't grow it without limit. Advice keys are few; this is generous. */
const MAX_ENTRIES = 500;

export interface AdviceEmbedding {
  /** The exact recommendation text this vector was computed for (staleness guard). */
  text: string;
  /** The embedding model used (staleness guard — a model change invalidates the vector). */
  model: string;
  vector: number[];
  ts: string;
}

interface CacheFile {
  schemaVersion: number;
  entries: Record<string, AdviceEmbedding>;
}

function cachePath(): string {
  return join(config.dataDir, "insights", "advice-embeddings.json");
}

/** Load the whole cache as a Map. Absent/corrupt → empty Map (render then falls back to grouping). */
export async function loadAdviceEmbeddings(): Promise<Map<string, AdviceEmbedding>> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(), "utf8")) as CacheFile;
    return new Map(Object.entries(parsed.entries ?? {}));
  } catch {
    return new Map();
  }
}

/** Persist the cache, trimmed to the most-recent MAX_ENTRIES. Best-effort — a write failure is swallowed. */
export async function saveAdviceEmbeddings(entries: Map<string, AdviceEmbedding>): Promise<void> {
  try {
    const trimmed = [...entries.entries()]
      .sort((a, b) => b[1].ts.localeCompare(a[1].ts))
      .slice(0, MAX_ENTRIES);
    const file: CacheFile = { schemaVersion: ADVICE_EMBED_SCHEMA_VERSION, entries: Object.fromEntries(trimmed) };
    const path = cachePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(file));
  } catch {
    /* best-effort cache — a write failure just leaves clustering at its previous state */
  }
}

/**
 * Build the render-time key→vector index for the given findings: only entries whose cached text AND model
 * still match the current recommendation are included (a stale entry is treated as a miss → singleton).
 * Reads the cache from disk; does NO network. Returns an empty index when clustering is disabled.
 */
export async function loadAdviceEmbeddingIndex(
  findings: ReadonlyArray<{ key: string; title: string }>,
): Promise<Map<string, number[]>> {
  const idx = new Map<string, number[]>();
  if (!findings.length) return idx;
  const cache = await loadAdviceEmbeddings();
  const model = config.adviceClustering.model;
  for (const f of findings) {
    const e = cache.get(f.key);
    if (e && e.text === f.title && e.model === model && e.vector.length) idx.set(f.key, e.vector);
  }
  return idx;
}
