import { realpath, readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import { resolve, relative, dirname, isAbsolute, sep } from "node:path";

/**
 * Gated, repo-scoped file read/write — the backend for the `read_file` / `write_file` / `list_files`
 * MCP tools. It lets a (remote) Claude session read and update the project's gitignored files
 * (profile.local.yaml, data/, reports/, knowledge/ …) that a fresh web-session clone never has — the
 * one capability the purpose-built tools don't cover.
 *
 * It is OFF by default and only registered when COACH_MCP_FILE_ACCESS=true (see config.mcp.fileAccess),
 * exactly like the profile-write tool, because on the HTTP/Cowork surface it lets a remote caller
 * read/write files on this machine.
 *
 * Two hard safety rails, both enforced here (pure path math is unit-tested; the IO leaves re-check
 * against symlink escapes):
 *  1. CONTAINMENT — every path resolves inside the repo root; `..`, absolute escapes and symlinks that
 *     point outside the root are refused.
 *  2. SECRETS DENY-LIST — `.env`/secret/credential files, token files, SSH keys, and `.git/` are never
 *     readable or writable (so "any gitignored file EXCEPT env/secrets" holds by construction).
 * `node_modules/` is excluded too — it's vendored noise, not the user's data.
 */

/** The repo root the tools operate within. The MCP service runs with the project as its CWD. */
export function repoRoot(): string {
  return process.cwd();
}

/** Largest file the read tool will return (keeps a huge file from flooding the model context). */
export const MAX_READ_BYTES = 1_000_000;

/**
 * Why a relative path (POSIX-separated, root-relative) is off-limits, or null if it's allowed. Operates
 * on path SHAPE only — no IO — so it's pure and testable. Templates (`.env.example`/`.env.sample`) are
 * allowed: they're committed, carry no secrets, and are the thing a user legitimately edits.
 */
export function deniedReason(relPosix: string): string | null {
  const segs = relPosix.split("/").filter((s) => s && s !== ".");
  if (!segs.length) return "the repo root itself, not a file";
  if (segs.some((s) => s === ".git")) return "inside .git/ (version-control internals)";
  if (segs.some((s) => s === "node_modules")) return "inside node_modules/ (vendored dependencies)";
  const base = segs[segs.length - 1];
  if (base === ".env.example" || base === ".env.sample") return null; // committed templates — safe
  if (/^\.env(\..+)?$/.test(base)) return "an environment file (.env*) — secrets are excluded";
  if (/\.(tokens?\.json|tokens?|pem|key|p12|pfx|crt|cer|asc|gpg)$/i.test(base)) return "a credential/secret file";
  if (/^(id_rsa|id_ed25519|id_dsa|id_ecdsa)(\.pub)?$/.test(base)) return "an SSH key";
  return null;
}

/**
 * Resolve `requested` against `root` and apply containment + the deny-list — PURE (no IO). Returns the
 * absolute path and its root-relative POSIX form, or throws a clear, user-facing error. Symlink escapes
 * are caught separately by the IO functions (which can touch the filesystem).
 */
export function resolveSafePath(root: string, requested: string): { abs: string; rel: string } {
  if (typeof requested !== "string" || !requested.trim()) {
    throw new Error("file access: `path` must be a non-empty path relative to the repo root.");
  }
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, requested);
  const rel = relative(rootAbs, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`refused: "${requested}" escapes the repo directory — file access is scoped to ${rootAbs}.`);
  }
  const relPosix = rel.split(sep).join("/");
  const denied = deniedReason(relPosix);
  if (denied) throw new Error(`refused: "${relPosix || "."}" is ${denied}. File access excludes secrets and VCS internals.`);
  return { abs, rel: relPosix };
}

/** Re-check, against the real filesystem, that `abs` (or its nearest existing ancestor) sits inside the
 *  real root — defeats a symlink inside the repo that points outside it. */
async function assertRealContained(root: string, abs: string): Promise<void> {
  const rootReal = await realpath(resolve(root));
  let cur = abs;
  for (;;) {
    const real = await realpath(cur).catch(() => null);
    if (real) {
      const rel = relative(rootReal, real);
      if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
        throw new Error("refused: path resolves through a symlink to outside the repo directory.");
      }
      return;
    }
    const parent = dirname(cur);
    if (parent === cur) return; // walked to the fs root without an existing ancestor — nothing to escape
    cur = parent;
  }
}

export interface DirEntry {
  name: string;
  type: "dir" | "file" | "other";
  size?: number;
}

/** List a directory's entries (root-relative `relDir`, default the repo root), with denied entries and
 *  VCS/vendor noise filtered out. Throws if the path escapes the root or isn't a directory. */
export async function listRepoDir(root: string, relDir = "."): Promise<{ rel: string; entries: DirEntry[] }> {
  const { abs, rel } = relDir === "." || relDir.trim() === "" ? { abs: resolve(root), rel: "." } : resolveSafePath(root, relDir);
  await assertRealContained(root, abs);
  const st = await stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error(`not a directory: "${rel}".`);
  const names = await readdir(abs, { withFileTypes: true });
  const entries: DirEntry[] = [];
  for (const d of names) {
    const childRel = (rel === "." ? d.name : `${rel}/${d.name}`).split(sep).join("/");
    if (deniedReason(childRel)) continue; // hide secrets / .git / node_modules from the listing
    const type: DirEntry["type"] = d.isDirectory() ? "dir" : d.isFile() ? "file" : "other";
    const size = d.isFile() ? (await stat(`${abs}/${d.name}`).catch(() => null))?.size : undefined;
    entries.push({ name: d.name, type, size });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { rel, entries };
}

/**
 * The exact text the `read_file` MCP tool returns for a file: the file's content VERBATIM, with nothing
 * prepended or appended. This is deliberate — it keeps a read → edit → write round-trip LOSSLESS, so a
 * caller can hand what it read straight back to `write_file` and reproduce the file byte-for-byte.
 *
 * An earlier version prefixed a `# <path>` header for readability. That silently corrupts round-trips:
 * a caller reproducing the file copies the header back into `content`, `write_file` writes it literally,
 * and the next read prepends a fresh header on top — so the line DUPLICATES on every cycle. It is
 * especially nasty for YAML/TOML/shell/Python, where a leading `# …` is a real comment that parses
 * cleanly, so the corruption is invisible until it accumulates. The file's identity is already carried
 * by the tool call's own `path` argument, so the header bought readability at the cost of correctness.
 * Keep this the identity of `content`; if you ever want a label, return it OUTSIDE this string.
 */
export function formatReadResult(content: string): string {
  return content;
}

/** Read a repo file as UTF-8 text. Throws on containment/deny violations or when the file is too large. */
export async function readRepoFile(root: string, requested: string): Promise<{ rel: string; content: string }> {
  const { abs, rel } = resolveSafePath(root, requested);
  await assertRealContained(root, abs);
  const st = await stat(abs).catch(() => null);
  if (!st) throw new Error(`no such file: "${rel}".`);
  if (st.isDirectory()) throw new Error(`"${rel}" is a directory — use list_files for that.`);
  if (st.size > MAX_READ_BYTES) {
    throw new Error(`"${rel}" is ${st.size} bytes (> ${MAX_READ_BYTES} limit) — too large to return as text.`);
  }
  return { rel, content: await readFile(abs, "utf8") };
}

/** Write UTF-8 text to a repo file, creating parent directories within the root as needed. Throws on
 *  containment/deny violations. Returns the path written and the byte count. */
export async function writeRepoFile(root: string, requested: string, content: string): Promise<{ rel: string; abs: string; bytes: number }> {
  if (typeof content !== "string") throw new Error("file access: `content` must be a string.");
  const { abs, rel } = resolveSafePath(root, requested);
  await mkdir(dirname(abs), { recursive: true });
  await assertRealContained(root, abs); // after mkdir so the parent chain exists to realpath
  await writeFile(abs, content, "utf8");
  return { rel, abs, bytes: Buffer.byteLength(content, "utf8") };
}
