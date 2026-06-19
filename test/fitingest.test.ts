import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportStreamsDir, ingestFitFile, formatStreamsReport } from "../src/archive/fitIngest.js";

/** Minimal valid .FIT: 12-byte header + a record def (msg 20) + two samples + a session (sport). */
function def(local: number, global: number, fields: Array<[number, number, number]>): Buffer {
  const b = Buffer.alloc(6 + 3 * fields.length);
  b.writeUInt8(0x40 | local, 0);
  b.writeUInt16LE(global, 3);
  b.writeUInt8(fields.length, 5);
  let o = 6;
  for (const [num, size, base] of fields) {
    b.writeUInt8(num, o);
    b.writeUInt8(size, o + 1);
    b.writeUInt8(base, o + 2);
    o += 3;
  }
  return b;
}
function fitBuf(): Buffer {
  const recDef = def(0, 20, [[253, 4, 0x86], [3, 1, 0x02]]); // timestamp, hr
  const rec = (t: number, hr: number) => {
    const v = Buffer.alloc(5);
    v.writeUInt32LE(t, 0);
    v.writeUInt8(hr, 4);
    return Buffer.concat([Buffer.from([0]), v]);
  };
  const sessDef = def(1, 18, [[5, 1, 0x00]]); // sport
  const sess = Buffer.concat([Buffer.from([1]), Buffer.from([1])]); // sport 1 = run
  const body = Buffer.concat([recDef, rec(1000, 150), rec(1300, 152), sessDef, sess]);
  const header = Buffer.alloc(12);
  header.writeUInt8(12, 0);
  header.writeUInt8(0x10, 1);
  header.writeUInt32LE(body.length, 4);
  header.write(".FIT", 8, "ascii");
  return Buffer.concat([header, body]);
}

test("reportStreamsDir: lists valid .FIT files with a summary and confirms the watched path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coach-ingest-"));
  await writeFile(join(dir, "act1.fit"), fitBuf());
  await writeFile(join(dir, "junk.fit"), Buffer.from("not a fit file padding padding padding"));
  const rep = reportStreamsDir(dir);
  assert.equal(rep.dir, dir);
  assert.equal(rep.files.length, 2);
  const ok = rep.files.find((f) => f.file === "act1.fit")!;
  assert.equal(ok.valid, true);
  assert.equal(ok.sport, "Run");
  const bad = rep.files.find((f) => f.file === "junk.fit")!;
  assert.equal(bad.valid, false);
  const text = formatStreamsReport(rep).join("\n");
  assert.match(text, /watched/);
  assert.match(text, new RegExp(dir.replace(/[/\\]/g, "."))); // the absolute path is shown
  assert.match(text, /failed to decode/);
});

test("ingestFitFile: validates + copies a dropped .FIT into the streams dir", async () => {
  const src = await mkdtemp(join(tmpdir(), "coach-src-"));
  const dest = await mkdtemp(join(tmpdir(), "coach-dest-"));
  const srcFile = join(src, "Activity_123.fit");
  await writeFile(srcFile, fitBuf());
  const r = ingestFitFile(srcFile, dest);
  assert.equal(r.valid, true);
  assert.equal(r.ingested, true);
  assert.equal(r.sport, "Run");
  assert.ok(existsSync(join(dest, "Activity_123.fit")), "copied into the streams dir");
  // Second ingest of the same file is a no-op (already present), reported not re-ingested.
  const r2 = ingestFitFile(srcFile, dest);
  assert.equal(r2.ingested, false);
  assert.match(r2.note ?? "", /already/i);
});

test("ingestFitFile: an undecodable file is reported invalid, never silently kept", async () => {
  const src = await mkdtemp(join(tmpdir(), "coach-src2-"));
  const dest = await mkdtemp(join(tmpdir(), "coach-dest2-"));
  const srcFile = join(src, "notes.fit");
  await writeFile(srcFile, Buffer.from("this is not a fit file at all, just text padding"));
  const r = ingestFitFile(srcFile, dest);
  assert.equal(r.valid, false);
  assert.equal(r.ingested, false);
  assert.ok(!existsSync(join(dest, "notes.fit")), "an invalid file is not copied in");
});

test("ingestFitFile: a missing source path errors cleanly", () => {
  const r = ingestFitFile("/no/such/file.fit", "/tmp");
  assert.equal(r.valid, false);
  assert.equal(r.ingested, false);
  assert.match(r.note ?? "", /not found/i);
});
