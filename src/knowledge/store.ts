import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * The knowledge layer (`knowledge/sports-science.md`) is loaded into EVERY coaching prompt
 * (`coach/persona.ts`), so editing it updates the coach's priors everywhere. The monthly research
 * digest never writes here directly — it drops proposals in `knowledge/pending/` for the athlete to
 * REVIEW, and only an explicit `approve` folds one in (the human gate, mirroring gated plan writes).
 *
 * Freshness: the file carries a `Last verified: YYYY-MM-DD` marker; `knowledgeFreshness` flags it stale
 * so "how often do we update our knowledge" has a tracked answer instead of an aspirational one.
 */

function knowledgeRoot(): string {
  return join(process.cwd(), "knowledge");
}
export function knowledgePath(): string {
  return join(knowledgeRoot(), "sports-science.md");
}
function pendingDir(): string {
  return join(knowledgeRoot(), "pending");
}

export async function readKnowledge(): Promise<string> {
  return readFile(knowledgePath(), "utf8").catch(() => "");
}

/** Parse the `Last verified: YYYY-MM-DD` marker (first match). Pure — testable. */
export function parseLastVerified(text: string): string | null {
  return text.match(/Last verified:\s*(\d{4}-\d{2}-\d{2})/i)?.[1] ?? null;
}

export interface Freshness {
  lastVerified: string | null;
  ageDays: number | null;
  stale: boolean; // older than `staleAfterDays`, or never stamped
}

/** Compute knowledge-layer freshness. Stale when there's no marker, or it's older than `staleAfterDays`. */
export function knowledgeFreshness(text: string, now: Date = new Date(), staleAfterDays = 35): Freshness {
  const lastVerified = parseLastVerified(text);
  if (!lastVerified) return { lastVerified: null, ageDays: null, stale: true };
  const ageDays = Math.floor((now.getTime() - new Date(`${lastVerified}T00:00:00Z`).getTime()) / 86_400_000);
  return { lastVerified, ageDays, stale: ageDays > staleAfterDays };
}

/** A pending digest file name for a date — e.g. 2026-06-18-research-digest.md. */
export function pendingName(dateIso: string): string {
  return `${dateIso}-research-digest.md`;
}

/** Drop a drafted digest into the review queue. Returns its path. */
export async function writePendingDigest(dateIso: string, markdown: string): Promise<string> {
  const dir = pendingDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, pendingName(dateIso));
  await writeFile(path, markdown.trimEnd() + "\n");
  return path;
}

export interface PendingInfo {
  name: string;
  bytes: number;
}

/** List queued digests awaiting review, newest first. Empty when the dir is absent. */
export async function listPending(): Promise<PendingInfo[]> {
  let files: string[];
  try {
    files = await readdir(pendingDir());
  } catch {
    return [];
  }
  const md = files.filter((f) => f.endsWith(".md")).sort((a, b) => b.localeCompare(a));
  return Promise.all(md.map(async (name) => ({ name, bytes: (await readFile(join(pendingDir(), name), "utf8")).length })));
}

/** Read one pending digest by bare file name (path-traversal guarded). */
export async function readPending(name: string): Promise<string> {
  if (basename(name) !== name || !name.endsWith(".md")) throw new Error(`Invalid pending name: ${name}`);
  return readFile(join(pendingDir(), name), "utf8");
}

/**
 * Fold an approved digest into the knowledge file under a dated section and refresh the verified marker,
 * then remove it from the queue. The human gate: only ever called on a digest the athlete approved.
 */
export async function approvePending(name: string, today: string = new Date().toISOString().slice(0, 10)): Promise<void> {
  const digest = await readPending(name);
  const current = await readKnowledge();
  const stamped = stampVerified(current, today);
  const section = `\n\n## Approved research update — ${today}\n\n${digest.trim()}\n`;
  await writeFile(knowledgePath(), stamped.trimEnd() + section);
  await rm(join(pendingDir(), name));
}

/** Set/replace the `Last verified: YYYY-MM-DD` marker. Pure — testable. */
export function stampVerified(text: string, date: string): string {
  if (/Last verified:\s*\d{4}-\d{2}-\d{2}/i.test(text)) {
    return text.replace(/Last verified:\s*\d{4}-\d{2}-\d{2}/i, `Last verified: ${date}`);
  }
  // No marker yet — add one just under the H1 title (or at the top if there isn't one).
  const lines = text.split("\n");
  const h1 = lines.findIndex((l) => l.startsWith("# "));
  const insertAt = h1 >= 0 ? h1 + 1 : 0;
  lines.splice(insertAt, 0, "", `> Last verified: ${date}`);
  return lines.join("\n");
}
