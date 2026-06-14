import { mkdir, writeFile, readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * Dated markdown reports (Build Spec §10 M4). Each flow writes a timestamped file under
 * reports/ so there's a durable artifact beyond the terminal scrollback. Gitignored (personal).
 */
function reportsDir(): string {
  return join(process.cwd(), "reports");
}

export async function writeReport(flow: string, date: string, markdown: string): Promise<string> {
  const dir = reportsDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${date}-${flow}.md`);
  await writeFile(path, markdown.trimEnd() + "\n");
  return path;
}

export interface ReportInfo {
  name: string;
  /** Leading YYYY-MM-DD from the file name, or "" if it isn't dated. */
  date: string;
  bytes: number;
  modified: string;
}

/** List the dated markdown reports under reports/, newest first. Empty when the dir is absent. */
export async function listReports(): Promise<ReportInfo[]> {
  let files: string[];
  try {
    files = await readdir(reportsDir());
  } catch {
    return [];
  }
  const md = files.filter((f) => f.endsWith(".md"));
  const infos = await Promise.all(
    md.map(async (name) => {
      const s = await stat(join(reportsDir(), name));
      return {
        name,
        date: name.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? "",
        bytes: s.size,
        modified: s.mtime.toISOString(),
      };
    }),
  );
  return infos.sort((a, b) => b.modified.localeCompare(a.modified));
}

/**
 * Read one report by file name. Guards against path traversal: the name must be a bare `*.md`
 * file (no directory parts) — so an MCP/agent caller can't read arbitrary files off disk.
 */
export async function readReport(name: string): Promise<string> {
  if (basename(name) !== name || !name.endsWith(".md")) {
    throw new Error(`Invalid report name: ${name} (expected a bare *.md file from reports/)`);
  }
  return readFile(join(reportsDir(), name), "utf8");
}
