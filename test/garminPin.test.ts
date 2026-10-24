import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { config, GARMIN_MCP_COMMIT, garminAuthArgs } from "../src/config.js";
import { weatherTempC } from "../src/archive/fitSync.js";

/**
 * The garmin_mcp pin moved d31de79 → a2ca5fc with a garminconnect override (the 0.3.2 login breaks with 429).
 * These pin the spawn args and the one output-shape change the app depends on (activity weather).
 */

test("default Garmin spawn args: reviewed commit, mcp<2 kept, overrides file exists and forces garminconnect 0.3.20", () => {
  if (process.env.GARMIN_MCP_ARGS) return; // a local override replaces the default entirely
  const a = config.garmin.args;
  assert.ok(a.includes("mcp<2"), "mcp<2 must stay: garmin_mcp still imports mcp.server.fastmcp");
  assert.ok(a.some((x) => x.endsWith(`garmin_mcp@${GARMIN_MCP_COMMIT}`)));
  const ov = a[a.indexOf("--overrides") + 1];
  assert.ok(ov && existsSync(ov), `overrides file at ${ov}`);
  assert.match(readFileSync(ov, "utf8"), /^garminconnect==0\.3\.20$/m);
  assert.equal(a[a.length - 1], "garmin-mcp");
});

test("weatherTempC: legacy °F-in-celsius field, new temperature + unit, and unknown unit", () => {
  assert.equal(weatherTempC({ temperature_celsius: 63 }), 17.2, "old builds: °F mislabelled, corrected");
  assert.equal(weatherTempC({ temperature_celsius: 14 }), 14);
  assert.equal(weatherTempC({ temperature: 12, temperature_unit: "C" }), 12);
  assert.equal(weatherTempC({ temperature: 50, temperature_unit: "F" }), 10);
  assert.equal(weatherTempC({ temperature: 59, temperature_unit: null }), 15, "unit unknown → heuristic");
  assert.equal(weatherTempC(null), undefined);
  assert.equal(weatherTempC({ humidity_percent: 80 }), undefined);
});

test("garminAuthArgs: same args as the server, auth entry point swapped in", () => {
  const server = ["--python", "3.12", "--with", "mcp<2", "--overrides", "/x/garmin-overrides.txt", "--from", "git+https://g/garmin_mcp@abc", "garmin-mcp"];
  assert.deepEqual(garminAuthArgs(server), [...server.slice(0, -1), "garmin-mcp-auth"]);
  assert.deepEqual(garminAuthArgs(["--from", "x"]), ["--from", "x", "garmin-mcp-auth"]);
});
