import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deniedReason,
  resolveSafePath,
  listRepoDir,
  readRepoFile,
  writeRepoFile,
  formatReadResult,
  MAX_READ_BYTES,
} from "../src/mcp/fileAccess.js";

/**
 * The gated repo file tools must NEVER hand out a secret or escape the repo root. These tests lock the
 * two rails: the secrets deny-list (pure) and path containment (pure + a real symlink-escape check),
 * plus the read/write/list round-trip on a tmpdir fixture (no network, no real repo touched).
 */

test("deniedReason blocks secrets/VCS but allows ordinary + template files", () => {
  // Allowed: real user data and committed templates.
  for (const ok of ["profile.local.yaml", "data/state/2026-06-21.json", "reports/weekly.md", "knowledge/pending/x.md", ".env.example", ".env.sample"]) {
    assert.equal(deniedReason(ok), null, `${ok} should be allowed`);
  }
  // Blocked: env/secret/credential files, SSH keys, VCS + vendored dirs.
  for (const bad of [
    ".env",
    ".env.local",
    "config/.env.production",
    "aie.tokens.json",
    "garmin.token",
    "server.pem",
    "tls.key",
    "id_rsa",
    "id_ed25519.pub",
    ".git/config",
    "node_modules/pkg/index.js",
  ]) {
    assert.ok(deniedReason(bad), `${bad} should be denied`);
  }
});

test("resolveSafePath rejects traversal and absolute escapes, accepts in-repo paths", () => {
  const root = "/repo";
  assert.equal(resolveSafePath(root, "profile.local.yaml").rel, "profile.local.yaml");
  assert.equal(resolveSafePath(root, "./data/x.json").rel, "data/x.json");
  for (const bad of ["../outside.txt", "../../etc/passwd", "/etc/passwd", "data/../../escape"]) {
    assert.throws(() => resolveSafePath(root, bad), /escapes the repo directory/, bad);
  }
  // A denied path is refused even though it's in-repo.
  assert.throws(() => resolveSafePath(root, ".env"), /excludes secrets/);
  assert.throws(() => resolveSafePath(root, ""), /non-empty path/);
});

test("read/write/list round-trip within a tmpdir, and the deny-list + containment hold against the real fs", async () => {
  const root = await mkdtemp(join(tmpdir(), "coach-files-"));
  try {
    await mkdir(join(root, "data"), { recursive: true });
    await writeFile(join(root, "profile.local.yaml"), "identity:\n  name: Test\n");
    await writeFile(join(root, ".env"), "SECRET=keep-out\n");
    await writeFile(join(root, "data", "note.json"), "{}\n");

    // list hides the secret and shows the rest.
    const { entries } = await listRepoDir(root, ".");
    const names = entries.map((e) => e.name);
    assert.ok(names.includes("profile.local.yaml"));
    assert.ok(names.includes("data"));
    assert.ok(!names.includes(".env"), ".env must be hidden from listings");

    // read returns content; reading the secret is refused.
    assert.match((await readRepoFile(root, "profile.local.yaml")).content, /name: Test/);
    await assert.rejects(readRepoFile(root, ".env"), /excludes secrets/);
    await assert.rejects(readRepoFile(root, "does-not-exist.txt"), /no such file/);

    // write creates parent dirs and round-trips; writing a secret path is refused.
    const w = await writeRepoFile(root, "data/sub/created.txt", "hello");
    assert.equal(w.bytes, 5);
    assert.equal(await readFile(join(root, "data/sub/created.txt"), "utf8"), "hello");
    await assert.rejects(writeRepoFile(root, ".env", "x"), /excludes secrets/);
    await assert.rejects(writeRepoFile(root, "../escape.txt", "x"), /escapes the repo directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlink pointing outside the root is refused at IO time (not just by path math)", async () => {
  const root = await mkdtemp(join(tmpdir(), "coach-files-"));
  const outside = await mkdtemp(join(tmpdir(), "coach-outside-"));
  try {
    await writeFile(join(outside, "secret.txt"), "exfiltrate me");
    // A symlink that lives INSIDE the root but points OUTSIDE it — path math alone wouldn't catch it.
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    await assert.rejects(readRepoFile(root, "link.txt"), /symlink to outside the repo/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("read_file returns content VERBATIM so a read → edit → write round-trip is lossless", async () => {
  const root = await mkdtemp(join(tmpdir(), "coach-files-"));
  try {
    // A YAML file whose very first line is real content — exactly the case a prepended `# <path>`
    // header would corrupt, because `#` is a valid YAML comment and the damage parses cleanly.
    const original = "schema_version: 1\nidentity:\n  name: Test\n";
    await writeFile(join(root, "profile.local.yaml"), original);

    // What the read_file tool hands back must be the file's exact bytes — no header, no label.
    const { content } = await readRepoFile(root, "profile.local.yaml");
    const toolText = formatReadResult(content);
    assert.equal(toolText, original, "read_file output must equal the file content exactly");
    assert.ok(!toolText.startsWith("# "), "no synthetic '# <path>' header may be prepended");

    // The naive round-trip that previously duplicated a header: write back exactly what was read.
    await writeRepoFile(root, "profile.local.yaml", toolText);
    assert.equal((await readRepoFile(root, "profile.local.yaml")).content, original, "round-trip is lossless");

    // And a genuine leading comment is preserved as-is (not stripped, not doubled).
    const commented = "# hand-written header\nkey: value\n";
    await writeRepoFile(root, "data/note.yaml", commented);
    const back = formatReadResult((await readRepoFile(root, "data/note.yaml")).content);
    assert.equal(back, commented);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read refuses a file over the size cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "coach-files-"));
  try {
    await writeFile(join(root, "big.txt"), "x".repeat(MAX_READ_BYTES + 1));
    await assert.rejects(readRepoFile(root, "big.txt"), /too large/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
