import { test } from "node:test";
import assert from "node:assert/strict";
import { assessCompleteness, formatCompleteness } from "../src/state/dataCompleteness.js";

const TODAY = "2026-06-19";

test("assessCompleteness: a recent session with no matching stream is flagged missing", () => {
  const r = assessCompleteness({
    recent: [{ date: TODAY, sport: "Swim" }],
    streams: [], // no .FIT present
    today: TODAY,
    garminEnabled: true,
    garminConnected: true,
    fitSync: { streamsDownloaded: 0, streamsFailed: 0, streamsSupported: true },
  });
  assert.equal(r.complete, false);
  assert.equal(r.totalRecent, 1);
  assert.equal(r.presentCount, 0);
  assert.deepEqual(r.missingStreams, [{ date: TODAY, sport: "Swim" }]);
  // The formatted output leads with the loud warning, not a clean zero.
  const text = formatCompleteness(r).join("\n");
  assert.match(text, /⚠ raw \.FIT MISSING for 1\/1/);
  assert.match(text, /2026-06-19 Swim/);
});

test("assessCompleteness: a present stream (fuzzy sport match) is NOT flagged", () => {
  const r = assessCompleteness({
    recent: [{ date: TODAY, sport: "Ride" }],
    streams: [{ date: TODAY, sport: "cycling" }], // Ride ↔ cycling must match
    today: TODAY,
    garminEnabled: true,
    garminConnected: true,
  });
  assert.equal(r.complete, true);
  assert.equal(r.presentCount, 1);
  assert.deepEqual(r.missingStreams, []);
  assert.match(formatCompleteness(r).join("\n"), /✓ raw \.FIT present for all 1/);
});

test("assessCompleteness: sessions older than the lookback window are ignored", () => {
  const r = assessCompleteness({
    recent: [{ date: "2026-05-01", sport: "Run" }], // > 10d before today
    streams: [],
    today: TODAY,
    garminEnabled: true,
    garminConnected: true,
  });
  assert.equal(r.totalRecent, 0);
  assert.equal(r.complete, true);
  assert.match(formatCompleteness(r).join("\n"), /no sessions in the last 10d/);
});

test("assessCompleteness: capability note names WHY when Garmin can't be reached", () => {
  const r = assessCompleteness({
    recent: [{ date: TODAY, sport: "Run" }],
    streams: [],
    today: TODAY,
    garminEnabled: true,
    garminConnected: false, // attempted, failed
  });
  assert.match(r.notes.join("\n"), /NOT reachable this sync/);
  assert.match(r.notes.join("\n"), /garmin-mcp-auth/);
});

test("assessCompleteness: Garmin disabled is stated explicitly", () => {
  const r = assessCompleteness({
    recent: [{ date: TODAY, sport: "Run" }],
    streams: [],
    today: TODAY,
    garminEnabled: false,
  });
  assert.match(r.notes.join("\n"), /Garmin is disabled/);
});

test("assessCompleteness: a download tool that's missing on the build is called out", () => {
  const r = assessCompleteness({
    recent: [{ date: TODAY, sport: "Swim" }],
    streams: [],
    today: TODAY,
    garminEnabled: true,
    garminConnected: true,
    fitSync: { streamsDownloaded: 0, streamsFailed: 0, streamsSupported: false },
  });
  assert.match(r.notes.join("\n"), /can't download raw streams/);
});

test("assessCompleteness: this-sync download failures surface their reasons (loud, not swallowed)", () => {
  const r = assessCompleteness({
    recent: [{ date: TODAY, sport: "Swim" }],
    streams: [],
    today: TODAY,
    garminEnabled: true,
    garminConnected: true,
    fitSync: { streamsDownloaded: 0, streamsFailed: 1, streamsSupported: true, streamFailures: ["X1: call failed (auth)"] },
  });
  const text = r.notes.join("\n");
  assert.match(text, /This sync fetched 0 new raw stream\(s\); 1 failed/);
  assert.match(text, /X1: call failed \(auth\)/);
});

test("assessCompleteness: snapshot read (garminConnected undefined) says capability is from the snapshot", () => {
  const r = assessCompleteness({
    recent: [{ date: TODAY, sport: "Run" }],
    streams: [{ date: TODAY, sport: "running" }],
    today: TODAY,
    garminEnabled: true,
    // garminConnected omitted — get_state snapshot path
  });
  assert.match(r.notes.join("\n"), /from the last snapshot/);
});
