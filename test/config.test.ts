import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The athlete timezone (used for "today" → dose_cycle weekday, age, calendar day) resolves with a
 * deliberate precedence: an explicit COACH_TZ wins, else the app-owned profile's identity.timezone,
 * else Europe/London. This keeps the required profile field authoritative for scheduling without a
 * second env var, while not changing setups that already pin COACH_TZ.
 */

async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("COACH_TZ wins outright (explicit env beats the profile)", async () => {
  const { resolveAthleteTimezone } = await import("../src/config.js");
  const dir = await mkdtemp(join(tmpdir(), "coach-tz-"));
  const path = join(dir, "p.yaml");
  await writeFile(path, "identity:\n  timezone: America/New_York\n");
  await withEnv({ COACH_TZ: "Asia/Tokyo", COACH_PROFILE_PATH: path }, () => {
    assert.equal(resolveAthleteTimezone(), "Asia/Tokyo");
  });
  await rm(dir, { recursive: true, force: true });
});

test("with COACH_TZ unset, the profile's identity.timezone drives 'today'", async () => {
  const { resolveAthleteTimezone } = await import("../src/config.js");
  const dir = await mkdtemp(join(tmpdir(), "coach-tz-"));
  const path = join(dir, "p.yaml");
  await writeFile(path, "identity:\n  timezone: America/New_York\n");
  await withEnv({ COACH_TZ: undefined, COACH_PROFILE_PATH: path }, () => {
    assert.equal(resolveAthleteTimezone(), "America/New_York");
  });
  await rm(dir, { recursive: true, force: true });
});

test("a blank/absent profile timezone falls back to Europe/London", async () => {
  const { resolveAthleteTimezone } = await import("../src/config.js");
  const dir = await mkdtemp(join(tmpdir(), "coach-tz-"));
  const path = join(dir, "p.yaml");
  await writeFile(path, "identity:\n  timezone:\n"); // null, like the blank example
  await withEnv({ COACH_TZ: undefined, COACH_PROFILE_PATH: path }, () => {
    assert.equal(resolveAthleteTimezone(), "Europe/London");
  });
  await rm(dir, { recursive: true, force: true });
});
