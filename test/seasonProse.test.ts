import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderSeasonPage,
  stripLeadingH1,
  stripNextWeek,
  type SeasonProse,
} from "../src/coach/seasonPage.js";
import { latestSeasonNarrative, latestWeeklyReviewProse } from "../src/coach/setupSources.js";
import { buildSeasonArc, type SeasonArcInput } from "../src/coach/seasonArc.js";

const baseInput = (): SeasonArcInput => ({
  today: "2026-06-22",
  plan: undefined,
  ctlNow: 42,
  ctlSeries: [{ date: "2026-06-22", v: 42 }],
  career: { races: [], bests: [], trajectory: [] },
  profile: undefined,
});

const REPORT = buildSeasonArc(baseInput());
const FRESH = new Date().toISOString().slice(0, 10);

// ── Pure markdown extraction helpers ────────────────────────────────────────

test("stripLeadingH1 drops a single leading # title, keeps body and inner headings", () => {
  assert.equal(stripLeadingH1("# Season arc — review (2026-06-22)\n\nBody here.\n## Levers\nx"), "Body here.\n## Levers\nx");
  // no H1 → unchanged
  assert.equal(stripLeadingH1("Body with no title.\n## Next\nx"), "Body with no title.\n## Next\nx");
  // doesn't eat an H2/H3
  assert.equal(stripLeadingH1("## Not an H1\nbody"), "## Not an H1\nbody");
});

test("stripNextWeek removes the weekly '## Next week' section to its end", () => {
  const md = "Takeaway.\n\n## Recovery\nfine\n\n## Next week\n- Cut a grey ride\n- Fuel 60g/h\n";
  const out = stripNextWeek(md);
  assert.ok(out.includes("## Recovery"));
  assert.ok(!/next week/i.test(out), "the Next week heading is gone");
  assert.ok(!out.includes("Cut a grey ride"), "the action bullets are gone");
  // a report with no Next week section is untouched
  assert.equal(stripNextWeek("Just a takeaway.\n## Recovery\nx"), "Just a takeaway.\n## Recovery\nx");
});

// ── renderSeasonPage prose cards ─────────────────────────────────────────────

test("renderSeasonPage renders both prose cards when passed, newest content visible", () => {
  const prose: SeasonProse = {
    narrative: { markdown: "# Season arc — review\n\nRaise the aerobic floor patiently.", date: FRESH },
    weekly: { markdown: "# Weekly review — 2026-06-22\n\nSolid base week.\n\n## Next week\n- Cut a grey ride", date: FRESH },
  };
  const html = renderSeasonPage(REPORT, false, prose);
  assert.match(html, /Coach&#39;s full season read|Coach's full season read/);
  assert.match(html, /This week/);
  assert.ok(html.includes("Raise the aerobic floor patiently."));
  assert.ok(html.includes("Solid base week."));
  // weekly is first and open; the long narrative folds into a collapsed <details> lower down
  assert.ok(html.indexOf("This week") < html.indexOf("full season read"), "weekly comes before the season read");
  assert.match(html, /<details[^>]*>\s*<summary[^>]*>Coach&#39;s full season read/, "the narrative is collapsed");
  // the H1 title line is stripped (the card carries its own title)
  assert.ok(!html.includes("Season arc — review"));
  // the weekly "## Next week" bullets are stripped (they live on the dashboard)
  assert.ok(!html.includes("Cut a grey ride"));
  assert.ok(!/Next week/i.test(html), "the weekly Next-week section is stripped");
  // honest staleness stamp present, fresh → no stale hint
  assert.match(html, /Updated /);
  assert.ok(!html.includes("stale —"));
});

test("renderSeasonPage omits a prose card cleanly when that piece is absent (no empty card)", () => {
  // "Coach" alone is no longer a reliable proxy (the shared site shell brands every page "Endurance
  // Coach"), so assert against the narrative card's own title — "Coach's full season read".
  const onlyNarrative = renderSeasonPage(REPORT, false, { narrative: { markdown: "# T\n\nbody", date: FRESH } });
  assert.match(onlyNarrative, /season read/);
  assert.ok(!onlyNarrative.includes("This week"));

  const none = renderSeasonPage(REPORT, false, {});
  assert.ok(!none.includes("season read"));
  assert.ok(!none.includes("This week"));

  // backwards-compatible: no prose arg at all
  const noArg = renderSeasonPage(REPORT);
  assert.ok(!noArg.includes("This week"));
});

test("renderSeasonPage escapes hostile markdown in prose (no raw markup breaks out)", () => {
  const prose: SeasonProse = {
    narrative: { markdown: "# T\n\n<script>alert('xss')</script> & <img onerror=1>", date: FRESH },
  };
  const html = renderSeasonPage(REPORT, false, prose);
  assert.ok(!html.includes("<script>alert"), "no raw <script> survives");
  assert.ok(html.includes("&lt;script&gt;"), "the markup is escaped");
});

test("renderSeasonPage shows a stale hint with the refresh command for an old report", () => {
  const old = "2026-01-01"; // far older than STALE_DAYS relative to today
  const html = renderSeasonPage(REPORT, false, {
    narrative: { markdown: "# T\n\nbody", date: old },
    weekly: { markdown: "# T\n\nbody\n", date: old },
  });
  assert.match(html, /stale — run/);
  assert.match(html, /npm run season/);
  assert.match(html, /npm run weekly/);
});

// ── setupSources loaders (hermetic: real IO against a temp cwd) ──────────────

async function withTempReports(fn: (dir: string) => Promise<void>): Promise<void> {
  const cwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "season-prose-"));
  try {
    process.chdir(dir);
    await fn(dir);
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Write a report file and stamp its mtime (listReports sorts newest-first by mtime). */
async function writeAt(dir: string, name: string, body: string, mtimeMs: number): Promise<void> {
  const path = join(dir, "reports", name);
  await writeFile(path, body);
  const t = mtimeMs / 1000;
  await utimes(path, t, t);
}

test("latestSeasonNarrative / latestWeeklyReviewProse pick the newest matching report", async () => {
  await withTempReports(async (dir) => {
    await mkdir(join(dir, "reports"), { recursive: true });
    const base = Date.now();
    await writeAt(dir, "2026-05-01-season-arc.md", "# old\n\nold narrative", base - 2 * 86_400_000);
    await writeAt(dir, "2026-06-01-season-arc.md", "# new\n\nnew narrative", base);
    await writeAt(dir, "2026-06-10-weekly-review.md", "# wk\n\nthis week", base - 86_400_000);
    // an unrelated report must not be mistaken for either flow
    await writeAt(dir, "2026-06-11-race-prep.md", "# race\n\nignore me", base);

    const narrative = await latestSeasonNarrative();
    assert.equal(narrative?.date, "2026-06-01");
    assert.ok(narrative?.markdown.includes("new narrative"));

    const weekly = await latestWeeklyReviewProse();
    assert.equal(weekly?.date, "2026-06-10");
    assert.ok(weekly?.markdown.includes("this week"));
  });
});

test("setupSources loaders degrade to undefined when no matching report exists", async () => {
  await withTempReports(async (dir) => {
    await mkdir(join(dir, "reports"), { recursive: true });
    await writeAt(dir, "2026-06-11-race-prep.md", "# race\n\nonly an unrelated report", Date.now());
    assert.equal(await latestSeasonNarrative(), undefined);
    assert.equal(await latestWeeklyReviewProse(), undefined);
  });
});

test("setupSources loaders degrade to undefined when the reports dir is absent", async () => {
  await withTempReports(async () => {
    // no reports/ dir created at all
    assert.equal(await latestSeasonNarrative(), undefined);
    assert.equal(await latestWeeklyReviewProse(), undefined);
  });
});
