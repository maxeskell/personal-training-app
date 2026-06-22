import { config } from "../config.js";
import type { Finding } from "../insights/metrics.js";
import { LocalEmbeddings } from "../llm/embeddings.js";
import { loadAdviceEmbeddings, saveAdviceEmbeddings } from "../state/adviceEmbeddings.js";

/**
 * Sync-time precompute for cross-source recommendation clustering — runs OFF the render path, right after a
 * prose flow logs its advice. Ensures every just-surfaced recommendation has a CURRENT embedding in the
 * cache, embedding only the misses (new or changed text) via the local server. The cache is cumulative
 * across surfaces, so by render time the readiness / deep-dive / ask vectors all coexist and the
 * deterministic clusterer can collapse the same idea phrased differently across them.
 *
 * Strictly best-effort: a no-op when clustering is disabled, and any failure (server down, timeout, bad
 * payload) is swallowed — the render just falls back to per-source grouping. Never throws, never blocks a
 * sync. Matches the "degrade, don't crash" contract the weather/Garmin/local-LLM fetches already follow.
 */
export async function refreshAdviceEmbeddings(findings: Finding[]): Promise<void> {
  if (!LocalEmbeddings.enabled()) return;
  const advice = findings.filter(
    (f): f is Finding & { key: string } =>
      typeof f.key === "string" && f.key.startsWith("advice:") && f.title.trim().length > 0,
  );
  if (!advice.length) return;
  try {
    const cache = await loadAdviceEmbeddings();
    const model = config.adviceClustering.model;
    const missing = advice.filter((f) => {
      const e = cache.get(f.key);
      return !e || e.text !== f.title || e.model !== model;
    });
    if (!missing.length) return;
    const vectors = await new LocalEmbeddings().embed(missing.map((f) => f.title));
    const ts = new Date().toISOString();
    missing.forEach((f, i) => {
      const vector = vectors[i];
      if (vector?.length) cache.set(f.key, { text: f.title, model, vector, ts });
    });
    await saveAdviceEmbeddings(cache);
  } catch {
    /* degrade: leave the cache as-is; the card falls back to per-source grouping */
  }
}
