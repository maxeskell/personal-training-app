import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, archiveBuffer, importDir, loadManifest, archiveSummary, manifestHashes } from "../src/archive/activityArchive.js";

const TCX = `<?xml version="1.0"?><TrainingCenterDatabase><Activities><Activity Sport="Running">
<Lap StartTime="2015-12-26T10:00:00Z"><TotalTimeSeconds>1500</TotalTimeSeconds><DistanceMeters>5000</DistanceMeters><AverageHeartRateBpm><Value>150</Value></AverageHeartRateBpm><Track></Track></Lap>
</Activity></Activities></TrainingCenterDatabase>`;
const PWX = `<?xml version="1.0"?><pwx><workout><sportType>Bike</sportType><time>2013-07-07T06:30:00Z</time>
<summarydata><beginning>0</beginning><duration>9000</duration><dist>90000</dist></summarydata>
<segment><summarydata><beginning>0</beginning><duration>9000</duration><dist>90000</dist></summarydata></segment></workout></pwx>`;

test("classify: recognises activity formats incl. gzip; rejects others", () => {
  assert.deepEqual(classify("maxeskell.2015-12-26.GarminPush.31.fit.gz"), { format: "fit", gzipped: true });
  assert.deepEqual(classify("ride.PWX"), { format: "pwx", gzipped: false });
  assert.deepEqual(classify("run.tcx.gz"), { format: "tcx", gzipped: true });
  assert.equal(classify("activities_tp.csv"), null);
  assert.equal(classify(".DS_Store"), null);
});

test("archiveBuffer: dedups identical content (gz vs plain collapse), keeps distinct formats", () => {
  const dir = mkdtempSync(join(tmpdir(), "arc-"));
  const hashes = new Set<string>();
  // same TCX content, once plain and once gzipped → second is a duplicate (hash of decompressed bytes)
  const a = archiveBuffer(Buffer.from(TCX), { originalName: "run.tcx", source: "import" }, hashes, dir);
  const b = archiveBuffer(gzipSync(Buffer.from(TCX)), { originalName: "run.tcx.gz", source: "import" }, hashes, dir);
  assert.equal(a.archived, true);
  assert.equal(b.archived, false);
  assert.equal(b.reason, "duplicate");
  // a different format (PWX) of a different activity → archived (distinct content)
  const c = archiveBuffer(Buffer.from(PWX), { originalName: "ride.pwx", source: "import" }, hashes, dir);
  assert.equal(c.archived, true);
  // a non-activity file is skipped, not archived
  assert.equal(archiveBuffer(Buffer.from("x,y"), { originalName: "summary.csv", source: "import" }, hashes, dir).reason, "not-activity");

  const man = loadManifest(dir);
  assert.equal(man.length, 2);
  const tcx = man.find((e) => e.format === "tcx");
  assert.equal(tcx?.date, "2015-12-26"); // parsed from the lap
  assert.equal(tcx?.sport, "Run");
  assert.ok(existsSync(join(dir, tcx!.path)));
  assert.equal(man.find((e) => e.format === "pwx")?.date, "2013-07-07");
});

test("importDir: recursive, deduped, idempotent; status reflects it", () => {
  const src = mkdtempSync(join(tmpdir(), "tpexport-"));
  mkdirSync(join(src, "2015"));
  mkdirSync(join(src, "2013"));
  writeFileSync(join(src, "2015", "run.tcx.gz"), gzipSync(Buffer.from(TCX)));
  writeFileSync(join(src, "2013", "ride.pwx.gz"), gzipSync(Buffer.from(PWX)));
  writeFileSync(join(src, "activities_tp.csv"), "a,b,c"); // non-activity → skipped
  const dir = mkdtempSync(join(tmpdir(), "arc-"));

  const first = importDir(src, "trainingpeaks", dir);
  assert.equal(first.archived, 2);
  assert.equal(first.skipped, 1); // the csv
  // re-import → everything is a duplicate (idempotent)
  const second = importDir(src, "trainingpeaks", dir);
  assert.equal(second.archived, 0);
  assert.equal(second.duplicates, 2);

  const sum = archiveSummary(dir);
  assert.equal(sum.total, 2);
  assert.equal(sum.dateRange, "2013-07-07 → 2015-12-26");
  assert.equal(sum.byFormat.tcx, 1);
  assert.equal(sum.byFormat.pwx, 1);
  assert.equal(sum.bySource.trainingpeaks, 2);
  assert.equal(manifestHashes(dir).size, 2);
});
