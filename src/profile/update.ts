import { readFile, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { config } from "../config.js";
import { LOCAL_PROFILE, EXAMPLE_PROFILE } from "./load.js";
import { validateProfile, type Profile } from "./schema.js";

/**
 * Write to the athlete profile (profile.local.yaml) from a partial patch — the backend for the
 * `update_profile` MCP tool, so the user can fill the profile by talking to Claude. The merge +
 * validation are PURE (unit-tested on fixtures); only `updateLocalProfile` touches disk.
 *
 * Safety: every write goes through `validateProfile`, so the schema AND the no-live-numbers guard
 * apply — a patch carrying FTP/weight/HRV/CSS/pace/load is rejected loudly, never written. The result
 * lands ONLY in the gitignored profile.local.yaml (never the committed example, never git).
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge `patch` onto `base`: plain objects merge recursively; arrays and scalars REPLACE (so a
 * races[] patch swaps the list rather than concatenating, and a scalar overwrites). `undefined` patch
 * values are skipped (they don't blank a field). Pure — returns a new value, mutates nothing.
 */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch; // scalar/array/type-mismatch → replace
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}

/**
 * Apply a partial-profile patch onto a base profile and VALIDATE the result (schema + no-live-numbers
 * guard). Pure; throws a clear error when the patch isn't an object or the merged profile is invalid.
 */
export function applyProfilePatch(base: Profile, patch: unknown): Profile {
  if (!isPlainObject(patch)) {
    throw new Error("update_profile: `patch` must be an object of profile fields to set (e.g. { health: { medication: { dose_day: \"sunday\" } } }).");
  }
  return validateProfile(deepMerge(base, patch));
}

/** Resolve the file the profile WRITES to — the override path if set, else profile.local.yaml (gitignored). */
function localTarget(): string {
  const p = config.profilePath || LOCAL_PROFILE;
  return isAbsolute(p) ? p : join(process.cwd(), p);
}

/**
 * Read the current profile as the merge base WITHOUT validating it — the override/local file if present
 * (so an update preserves the fields already there), else the committed blank example. Parsing the raw
 * YAML (not loadProfile) means a pre-existing local with a stale field still forms the base; the merged
 * result is what gets validated.
 */
async function readBase(): Promise<Profile> {
  const localText = await readFile(localTarget(), "utf8").catch(() => null);
  const text = localText ?? (await readFile(join(process.cwd(), EXAMPLE_PROFILE), "utf8"));
  return parseYaml(text) as Profile;
}

/**
 * Merge `patch` onto the current profile, validate, and write profile.local.yaml. Returns the path
 * written and the top-level keys the patch touched. Throws (loudly) on an invalid patch / live number,
 * so nothing invalid is ever persisted.
 */
export async function updateLocalProfile(patch: unknown): Promise<{ path: string; changed: string[] }> {
  const next = applyProfilePatch(await readBase(), patch);
  const target = localTarget();
  await writeFile(target, stringifyYaml(next));
  return { path: target, changed: isPlainObject(patch) ? Object.keys(patch) : [] };
}
