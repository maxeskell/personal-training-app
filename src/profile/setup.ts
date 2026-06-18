import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { EXAMPLE_PROFILE, LOCAL_PROFILE } from "./load.js";
import { validateProfile, type Profile } from "./schema.js";
import { config } from "../config.js";
import { todayIso } from "../util/today.js";
import { buildTodayState } from "../coach/orchestrator.js";
import { liveGoals } from "../coach/seasonContext.js";
import { buildPrefilledIntake, type PrefilledIntake } from "./bootstrap.js";

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
  /**
   * Extra races beyond the primary `race` — used by the integration bootstrap to carry ALL upcoming
   * races pulled from AI Endurance, not just the first. The manual flow leaves this unset.
   */
  extraRaces?: Array<{ name?: string; date?: string; priority?: string; distance?: string; target_time?: string }>;
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
  type Race = NonNullable<Profile["races"]>[number];
  const toRace = (r: NonNullable<ProfileIntake["race"]>): Race => ({
    name: clean(r.name) ?? null,
    priority: (clean(r.priority) as Race["priority"]) ?? null,
    date: clean(r.date) ?? null,
    distance: (clean(r.distance) as Race["distance"]) ?? null,
    target_time: clean(r.target_time) ?? null,
    note: null,
  });
  const all = [intake.race, ...(intake.extraRaces ?? [])].filter(
    (r): r is NonNullable<ProfileIntake["race"]> => Boolean(r && (clean(r.name) || clean(r.date))),
  );
  if (all.length) next.races = all.map(toRace);
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

type Ask = (q: string, fallback?: string) => Promise<string>;

/**
 * Best-effort pull of the pre-filled intake from the user's connected integrations. Wraps the live
 * `buildTodayState()` (AIE + optional Garmin) in a try/catch and returns null on ANY failure (AIE down,
 * not authed, Garmin off) so the caller degrades to the manual flow. Never throws.
 */
async function pullPrefill(today: string): Promise<PrefilledIntake | null> {
  try {
    console.log("\n⏳ Pulling your details from AI Endurance…");
    const { state } = await buildTodayState();
    return buildPrefilledIntake(state, liveGoals(state), config, today);
  } catch {
    return null;
  }
}

/** Print the transparent "here's what we pulled and from where" summary. */
function printPrefillSummary(p: PrefilledIntake): void {
  const s = p.summary;
  const aieBits: string[] = [...s.fromAie];
  if (s.raceCount) aieBits.push(`${s.raceCount} upcoming race${s.raceCount === 1 ? "" : "s"}`);
  console.log("\n✓ Pre-filled from your connected integrations — confirm or override each below:");
  if (aieBits.length) console.log(`  • From AI Endurance: ${aieBits.join(", ")}.`);
  if (s.fromConfig.length) console.log(`  • From your .env: ${s.fromConfig.join(", ")}.`);
  if (s.weeklyEstimate) {
    console.log(
      `  • Weekly hours: estimated ${s.weeklyEstimate.band}h from your last ${s.weeklyEstimate.weeks} ` +
        `full week${s.weeklyEstimate.weeks === 1 ? "" : "s"} of training — a MODEL estimate, confirm below.`,
    );
  } else {
    console.log("  • Weekly hours: not enough recent data to estimate — you'll be asked.");
  }
  console.log("  • Date of birth is always asked (AI Endurance exposes age, not your DOB).");
  console.log("  Nothing for biomechanics/medical/equipment/fuelling is pulled — hand-edit those after.\n");
}

/** Default suffix for a prompt that has a pulled value: " (Enter keeps: X)". */
const keep = (v: string | undefined): string => (v && v.trim() ? ` (Enter keeps: ${v.trim()})` : "");

/**
 * Gather the intake interactively. When `prefilled` is provided, each prompt shows the pulled value as
 * the default (Enter keeps it); otherwise it's the full manual flow. DOB is always asked. Pure-ish: all
 * IO goes through the injected `ask`.
 */
async function gatherIntake(ask: Ask, prefilled: ProfileIntake | null, ageHint: number | null): Promise<ProfileIntake> {
  const pf = prefilled ?? {};
  // AI Endurance exposes age but not DOB, so DOB is always asked; show the API age as a sanity hint.
  const dobHint = ageHint != null ? ` (AI Endurance has you at ${ageHint}y — enter the matching DOB)` : "";
  const intake: ProfileIntake = {
    name: await ask(`* Name${keep(pf.name)}: `, pf.name ?? ""),
    sex: await ask(`* Sex [male/female/other]${keep(pf.sex)}: `, pf.sex ?? ""),
    date_of_birth: await ask(`* Date of birth [YYYY-MM-DD]${dobHint}: `),
    location: await ask(`  Location (city/region)${keep(pf.location)}: `, pf.location ?? ""),
    units: await ask(`* Units [metric/imperial]${keep(pf.units) || " (metric)"}: `, pf.units ?? "metric"),
    timezone: await ask(`* Timezone [e.g. Europe/London]${keep(pf.timezone) || " (Europe/London)"}: `, pf.timezone ?? "Europe/London"),
    weekly_hours: await ask(`* Typical training hours/week [e.g. "11-12"]${keep(pf.weekly_hours)}: `, pf.weekly_hours ?? ""),
    race: {
      name: await ask(`* First race — name${keep(pf.race?.name)}: `, pf.race?.name ?? ""),
      date: await ask(`* First race — date [YYYY-MM-DD]${keep(pf.race?.date)}: `, pf.race?.date ?? ""),
      priority: await ask(`  First race — priority [A/B/C]${keep(pf.race?.priority)}: `, pf.race?.priority ?? ""),
      distance: await ask(`  First race — distance [sprint/olympic/70.3/ironman/other]${keep(pf.race?.distance)}: `, pf.race?.distance ?? ""),
      target_time: await ask(`  First race — target time [e.g. "sub 2:00"]${keep(pf.race?.target_time)}: `, pf.race?.target_time ?? ""),
    },
    // Carry any extra pulled races straight through (not prompted one-by-one — the user edits the file).
    extraRaces: pf.extraRaces,
  };
  return intake;
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

  // Best-effort: pre-fill from the connected integrations BEFORE opening the prompt loop. On any
  // failure we degrade to the existing full manual flow (never crash).
  const today = todayIso();
  const prefilled = await pullPrefill(today);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask: Ask = async (q, fallback = "") => (await rl.question(q)).trim() || fallback;
  try {
    console.log("\n🪪  Athlete profile — the stable context AI Endurance/Garmin don't hold.");
    console.log("    NO live numbers here (FTP/weight/HRV/CSS stay live). Required fields are marked *.\n");
    if (prefilled) {
      printPrefillSummary(prefilled);
    } else {
      console.log("  (Auto-pull from AI Endurance was unavailable — entering everything manually.)\n");
    }

    const intake = await gatherIntake(ask, prefilled?.intake ?? null, prefilled?.summary.ageHint ?? null);

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
    if (prefilled && prefilled.races.length > 1) {
      console.log(`  Carried all ${prefilled.races.length} upcoming races from AI Endurance — review them in the file.`);
    }
    console.log("  Open it to fill in biomechanics, equipment, fuelling and medical context.");
    console.log("  Reminder: set swim CSS, FTP and race target times directly in AI Endurance (read-only from here).\n");
  } catch (e) {
    console.error(`\nProfile not written — ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    rl.close();
  }
}
