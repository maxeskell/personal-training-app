import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { parse as parseYaml } from "yaml";
import { config } from "../config.js";
import { computeDoseCycle, validateProfile, type DoseCycle, type Profile } from "./schema.js";

/**
 * Load the athlete profile from disk. Resolution order:
 *   1. COACH_PROFILE_PATH if set (an explicit override),
 *   2. profile.local.yaml (the user's real, gitignored data),
 *   3. profile.example.yaml (the committed blank template — so a fresh clone still works).
 *
 * The file is YAML-parsed and validated against the schema (incl. the no-live-numbers guard).
 * `loadProfile` throws loudly on a missing/invalid profile (used by the `get_profile` MCP tool, where
 * silence would hide a real config error); `loadProfileSafe` swallows everything to null for the
 * best-effort coaching-context injection (degrade, don't crash).
 */

export const LOCAL_PROFILE = "profile.local.yaml";
export const EXAMPLE_PROFILE = "profile.example.yaml";

function resolve(p: string): string {
  return isAbsolute(p) ? p : join(process.cwd(), p);
}

export interface LoadedProfile {
  profile: Profile;
  /** Absolute path the profile was read from — so callers/tests can show which file won. */
  path: string;
  /** Which slot in the resolution order matched. */
  source: "override" | "local" | "example";
}

/** Read the first candidate file that exists, returning its text + which source it was. */
async function readFirstPresent(): Promise<{ text: string; path: string; source: LoadedProfile["source"] } | null> {
  const candidates: Array<{ path: string; source: LoadedProfile["source"] }> = [];
  if (config.profilePath) candidates.push({ path: resolve(config.profilePath), source: "override" });
  candidates.push({ path: resolve(LOCAL_PROFILE), source: "local" });
  candidates.push({ path: resolve(EXAMPLE_PROFILE), source: "example" });
  for (const c of candidates) {
    const text = await readFile(c.path, "utf8").catch(() => null);
    if (text != null) return { text, path: c.path, source: c.source };
  }
  return null;
}

/** Load + validate the profile, throwing a clear error if it's missing or invalid. */
export async function loadProfile(): Promise<LoadedProfile> {
  const found = await readFirstPresent();
  if (!found) {
    throw new Error(
      `No athlete profile found (looked for ${config.profilePath ? `${config.profilePath}, ` : ""}${LOCAL_PROFILE}, ${EXAMPLE_PROFILE}). ` +
        `Run \`npm run setup\` (or \`npm run profile:init\`), or copy ${EXAMPLE_PROFILE} to ${LOCAL_PROFILE} and fill it in.`,
    );
  }
  let data: unknown;
  try {
    data = parseYaml(found.text);
  } catch (e) {
    throw new Error(`Could not parse ${found.path} as YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return { profile: validateProfile(data), path: found.path, source: found.source };
  } catch (e) {
    throw new Error(`${found.path} failed validation: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Best-effort load for ambient use (coaching context): returns null on any error, never throws. */
export async function loadProfileSafe(): Promise<LoadedProfile | null> {
  return loadProfile().catch(() => null);
}

/** The slice of a profile race the spec-07 target gate needs (structurally matches
 *  insights/raceTargetGate's ProfileRaceTarget — defined here too so profile/ never imports insights/). */
export interface ProfileRaceTargetLite {
  name?: string | null;
  date?: string | null;
  target_time?: string | null;
}

/**
 * SYNC, best-effort read of just the profile's races (name/date/target_time) — for the deterministic
 * flows (the insight engine's target gate, race-prep) that can't await. Same resolution order as
 * {@link loadProfile}; returns [] on ANY failure (no profile, bad YAML, failed validation) — the gate
 * simply doesn't run. Callers pass the result in (BuildOptions.profileRaces / runRacePrep's param);
 * the engine itself never touches the disk for it, so its tests stay hermetic.
 */
export function loadProfileRacesSync(): ProfileRaceTargetLite[] {
  const candidates = [config.profilePath ? resolve(config.profilePath) : null, resolve(LOCAL_PROFILE), resolve(EXAMPLE_PROFILE)].filter(
    (p): p is string => p != null,
  );
  for (const path of candidates) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue; // not present → next candidate (same resolution order as loadProfile)
    }
    try {
      const profile = validateProfile(parseYaml(text));
      return (profile.races ?? []).map((r) => ({ name: r.name, date: r.date, target_time: r.target_time }));
    } catch {
      return []; // present but invalid: mirror loadProfileSafe (no silent fallback to the example)
    }
  }
  return [];
}

export interface ProfileWithDoseCycle extends LoadedProfile {
  /** Computed on read from `today` + medication.dose_day/gi_trough_days; null when no medication set. */
  dose_cycle: DoseCycle | null;
}

/** Load the profile and attach the computed dose-cycle for `today` (YYYY-MM-DD). Loud on failure. */
export async function getProfileWithDoseCycle(today: string): Promise<ProfileWithDoseCycle> {
  const loaded = await loadProfile();
  return { ...loaded, dose_cycle: computeDoseCycle(loaded.profile, today) };
}
