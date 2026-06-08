import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Dated markdown reports (Build Spec §10 M4). Each flow writes a timestamped file under
 * reports/ so there's a durable artifact beyond the terminal scrollback. Gitignored (personal).
 */
export async function writeReport(flow: string, date: string, markdown: string): Promise<string> {
  const dir = join(process.cwd(), "reports");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${date}-${flow}.md`);
  await writeFile(path, markdown.trimEnd() + "\n");
  return path;
}
