import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { EXAMPLE_PROFILE, LOCAL_PROFILE } from "./load.js";
import { validateProfile, type Profile } from "./schema.js";

/**
 * `npm run profile:init` (and the profile step of `npm run setup`) — copy profile.example.yaml to
 * profile.local.yaml and walk the user through the REQUIRED fields, validating as it goes. The
 * required set (per the build brief): identity {name, sex, date_of_birth, units, timezone},
 * availability.weekly_hours, and at least one race {name, date}. Everything else is optional and can
 * be filled in by hand afterwards.
 *
 * The merge + required-field check are pure functions so they're unit-tested without a TTY.
 */

export interface ProfileIntake {
  name?: string;
  sex?: string;
  date_of_birth?: string;
  location?: string;
  units?: string;
  timezone?: string;
  weekly_hours?: string;
  race?: { name?: string; date?: string; priority?: string; distance?: string; target_time?: string };
}

const clean = (s: string | undefined): string | undefined => {
  const t = (s ?? "").trim();
  return t.length ? t : undefined;
};

/** Merge intake answers onto a base profile (the parsed example). Pure — only sets provided fields. */
export function applyIntake(base: Profile, intake: ProfileIntake): Profile {
  const next: Profile = JSON.parse(JSON.stringify(base));
  const id = (next.identity ?? (next.identity = {} as Profile["identity"])) as Record<string, unknown>;
  for (const k of ["name", "sex", "date_of_birth", "location", "units", "timezone"] as const) {
    const v = clean(intake[k]);
    if (v !== undefined) id[k] = v;
  }
  const wk = clean(intake.weekly_hours);
  if (wk !== undefined) {
    const avail = (next.availability ?? (next.availability = {})) as Record<string, unknown>;
    avail.weekly_hours = wk;
  }
  if (intake.race && (clean(intake.race.name) || clean(intake.race.date))) {
    type Race = NonNullable<Profile["races"]>[number];
    next.races = [
      {
        name: clean(intake.race.name) ?? null,
        priority: (clean(intake.race.priority) as Race["priority"]) ?? null,
        date: clean(intake.race.date) ?? null,
        distance: (clean(intake.race.distance) as Race["distance"]) ?? null,
        target_time: clean(intake.race.target_time) ?? null,
        note: null,
      },
    ];
  }
  return next;
}

/** Which required fields are still missing — for the intake's "validating as it goes" check. Pure. */
export function requiredFieldsMissing(profile: Profile): string[] {
  const missing: string[] = [];
  const id = profile.identity ?? {};
  for (const k of ["name", "sex", "date_of_birth", "units", "timezone"] as const) {
    const v = (id as Record<string, unknown>)[k];
    if (typeof v !== "string" || !v.trim()) missing.push(`identity.${k}`);
  }
  const wk = (profile.availability as Record<string, unknown> | undefined)?.weekly_hours;
  if (wk == null || (typeof wk === "string" && !wk.trim())) missing.push("availability.weekly_hours");
  const races = (profile.races ?? []).filter((r) => (typeof r.name === "string" && r.name.trim()) && r.date);
  if (!races.length) missing.push("races (need at least one with name + date)");
  return missing;
}

function localPath(): string {
  return join(process.cwd(), LOCAL_PROFILE);
}
async function fileExists(p: string): Promise<boolean> {
  return access(p).then(() => true).catch(() => false);
}

/** Interactive intake. Degrades cleanly (prints guidance) when stdin isn't a TTY. */
export async function initProfile(): Promise<void> {
  const target = localPath();
  if (!process.stdin.isTTY) {
    console.log(
      `\nProfile setup is interactive — run it in a terminal. Or by hand:\n` +
        `  cp ${EXAMPLE_PROFILE} ${LOCAL_PROFILE}   then edit ${LOCAL_PROFILE} (it's gitignored).\n` +
        `Required: identity (name, sex, date_of_birth, units, timezone), availability.weekly_hours, ≥1 race.\n`,
    );
    return;
  }
  if (await fileExists(target)) {
    const rl0 = createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl0.question(`\n${LOCAL_PROFILE} already exists — overwrite it? [y/N]: `)).trim();
    rl0.close();
    if (!/^y/i.test(ans)) {
      console.log(`Keeping your existing ${LOCAL_PROFILE}. Edit it by hand to make changes.\n`);
      return;
    }
  }

  const exampleText = await readFile(join(process.cwd(), EXAMPLE_PROFILE), "utf8").catch(() => null);
  if (exampleText == null) {
    console.error(`Could not read ${EXAMPLE_PROFILE} — is it in the repo root?`);
    return;
  }
  const base = parseYaml(exampleText) as Profile;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, fallback = ""): Promise<string> => (await rl.question(q)).trim() || fallback;
  try {
    console.log("\n🪪  Athlete profile — the stable context AI Endurance/Garmin don't hold.");
    console.log("    NO live numbers here (FTP/weight/HRV/CSS stay live). Required fields are marked *.\n");

    const intake: ProfileIntake = {
      name: await ask("* Name: "),
      sex: await ask("* Sex [male/female/other]: "),
      date_of_birth: await ask("* Date of birth [YYYY-MM-DD]: "),
      location: await ask("  Location (city/region): "),
      units: await ask("* Units [metric/imperial] (metric): ", "metric"),
      timezone: await ask("* Timezone [e.g. Europe/London] (Europe/London): ", "Europe/London"),
      weekly_hours: await ask('* Typical training hours/week [e.g. "11-12"]: '),
      race: {
        name: await ask("* First race — name: "),
        date: await ask("* First race — date [YYYY-MM-DD]: "),
        priority: await ask("  First race — priority [A/B/C]: "),
        distance: await ask("  First race — distance [sprint/olympic/70.3/ironman/other]: "),
        target_time: await ask('  First race — target time [e.g. "sub 2:00"]: '),
      },
    };

    const next = applyIntake(base, intake);
    const missing = requiredFieldsMissing(next);
    if (missing.length) {
      console.log(`\n⚠ Still missing required fields: ${missing.join(", ")}.`);
      console.log(`  Writing what you gave anyway — edit ${LOCAL_PROFILE} to complete them.`);
    }
    // Validate the structure/contract (loud) before writing — never persist an invalid profile silently.
    validateProfile(next);
    await writeFile(target, stringifyYaml(next));
    console.log(`\n✓ Wrote ${target}  (gitignored — never committed).`);
    console.log("  Open it to fill in biomechanics, equipment, fuelling and medical context.");
    console.log("  Reminder: set swim CSS, FTP and race target times directly in AI Endurance (read-only from here).\n");
  } catch (e) {
    console.error(`\nProfile not written — ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    rl.close();
  }
}
