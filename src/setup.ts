import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { initProfile } from "./profile/setup.js";

/**
 * `npm run setup` — a one-command interactive wizard that replaces the SETUP.md Step-3 checklist:
 * asks for the handful of things most people set (Anthropic key, units, training location, Garmin),
 * writes/updates `.env`, and points at the next step. Degrades cleanly when stdin isn't a TTY.
 *
 * The env-merging is a pure function (`upsertEnv`) so it's unit-tested; the wizard is a thin shell.
 */

/**
 * Set each `KEY=value` in an existing .env body, preserving everything else. If a line `KEY=…` (or a
 * commented `#KEY=…` template line) exists it's replaced in place; otherwise the pair is appended.
 * Pure — no IO — so it's testable. A value of `undefined` leaves that key untouched.
 */
export function upsertEnv(content: string, kv: Record<string, string | undefined>): string {
  let lines = content.length ? content.split("\n") : [];
  for (const [key, value] of Object.entries(kv)) {
    if (value === undefined) continue;
    const re = new RegExp(`^#?\\s*${key}=`);
    const idx = lines.findIndex((l) => re.test(l));
    const line = `${key}=${value}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  return lines.join("\n");
}

export interface SetupAnswers {
  anthropicKey?: string;
  units?: string;
  weatherLat?: string;
  weatherLon?: string;
  weatherEnabled?: string; // "false" to disable the card
  garminEnabled?: string; // "true" to enable
}

/** Map the wizard's answers to the env keys to upsert (skipping blanks). Pure — testable. */
export function answersToEnv(a: SetupAnswers): Record<string, string | undefined> {
  return {
    ANTHROPIC_API_KEY: a.anthropicKey || undefined,
    COACH_UNITS: a.units || undefined,
    COACH_WEATHER_LAT: a.weatherLat || undefined,
    COACH_WEATHER_LON: a.weatherLon || undefined,
    COACH_WEATHER_ENABLED: a.weatherEnabled,
    GARMIN_ENABLED: a.garminEnabled,
  };
}

function envPath(): string {
  return join(process.cwd(), ".env");
}
function envExamplePath(): string {
  return join(process.cwd(), ".env.example");
}

/** Current .env if present, else the .env.example template, else empty — the base we upsert into. */
async function baseEnv(): Promise<string> {
  return (await readFile(envPath(), "utf8").catch(() => null)) ?? (await readFile(envExamplePath(), "utf8").catch(() => "")) ?? "";
}

export async function runSetup(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log(
      "\n`npm run setup` is interactive — run it in a terminal. Or set values by hand in .env\n" +
        "(copy .env.example first). The three most people set: ANTHROPIC_API_KEY, COACH_UNITS,\n" +
        "COACH_WEATHER_LAT/LON. Then: npm run auth:aie && npm start\n",
    );
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, fallback = ""): Promise<string> => (await rl.question(q)).trim() || fallback;
  try {
    console.log("\n🏊🚴🏃  Endurance Coach setup — a few questions, then you're ready.\n");
    console.log("Everything here is optional; press Enter to accept the default or skip.\n");

    const anthropicKey = await ask(
      "1) Anthropic API key (for the AI write-ups — readiness/weekly/ask/…; the dashboard works without it).\n   Paste sk-ant-… or Enter to skip: ",
    );
    const units = await ask("2) Units [metric, UK]: ", "metric, UK");
    console.log("3) Training location (for the weather card). Find your lat/lon at e.g. latlong.net.");
    const weatherLat = await ask("   Latitude (Enter to skip the weather card): ");
    const weatherLon = weatherLat ? await ask("   Longitude: ") : "";
    const garminYes = /^y/i.test(await ask("4) Use Garmin device data (HRV, training status, .FIT)? [y/N]: ", "n"));

    const answers: SetupAnswers = {
      anthropicKey,
      units,
      weatherLat: weatherLat || undefined,
      weatherLon: weatherLon || undefined,
      weatherEnabled: weatherLat ? undefined : "false",
      garminEnabled: garminYes ? "true" : "false",
    };
    const next = upsertEnv(await baseEnv(), answersToEnv(answers));
    await writeFile(envPath(), next.endsWith("\n") ? next : next + "\n");
    console.log(`\n✓ Wrote ${envPath()}`);

    // Offer the athlete-profile intake (stable context — body, kit, medical, availability, races).
    // It's a separate file (profile.local.yaml, gitignored), so it's optional and skippable here.
    if (/^y/i.test(await ask("\n5) Set up your athlete profile now (body, kit, medical, availability, races)? [Y/n]: ", "y"))) {
      rl.close();
      await initProfile();
    }

    console.log("\nNext steps:");
    console.log("  1. Connect AI Endurance (one-time browser login):  npm run auth:aie");
    if (garminYes) console.log("  2. One-time Garmin login:  uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp-auth");
    console.log(`  ${garminYes ? "3" : "2"}. Start the coach:  npm start   (then open the printed http://localhost link)`);
    console.log("\nSee it on sample data right now with:  npm run demo\n");
  } finally {
    rl.close();
  }
}
