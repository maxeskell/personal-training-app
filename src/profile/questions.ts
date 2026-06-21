/**
 * The OPTIONAL athlete-profile fields, each with a plain-language question AND a one-line "why this
 * changes your coaching" — the single source of truth behind `npm run profile:questions` and the
 * generated `docs/profile-questions.md` (kept from drifting by deriving both from this one module).
 *
 * Everything here is OPTIONAL: the coach works fully without any of it (the required identity / weekly
 * hours / first race are handled by `profile:init`, not listed here). These are the extras you can fill
 * whenever you like — by rerunning `profile:init`, editing `profile.local.yaml` by hand, or asking Claude.
 *
 * Honesty rule (CLAUDE.md "honest models"): each `why` is grounded in how the coach ACTUALLY uses the
 * field. The compact coaching context block (`renderProfileContext` in context.ts) is what's injected
 * into the live flows (readiness / weekly / race / ask), so a field IT reads gets a concrete "why".
 * Fields not yet read by any flow say so plainly ("recorded for your reference / for future use") —
 * they're still returned verbatim by the `get_profile` MCP tool, so Claude can see them on request, but
 * we do NOT claim a usage that doesn't exist.
 *
 * Every `field` is a dot-path that must exist in the schema / example profile — a test asserts this so
 * the list can never reference a field that isn't real.
 */

export interface ProfileQuestion {
  /** Top-level profile block this field lives in (also the CLI/doc grouping). */
  area: string;
  /** Dot-path to the field from the profile root, e.g. "health.medication.dose_day". */
  field: string;
  /** Plain-language question to the athlete. */
  question: string;
  /** One line: how answering it changes the coaching/insight/advice (or, honestly, that it's for reference). */
  why: string;
}

/**
 * Grouped so the CLI and doc render the same sections. `READ_BY_COACH` tags areas whose `why` is a
 * concrete live usage; reference-only fields state that in their own `why`.
 */
export const PROFILE_QUESTIONS: ProfileQuestion[] = [
  // --- identity (the optional extras beyond the required name/sex/DOB/units/timezone) ---
  {
    area: "identity",
    field: "identity.location",
    question: "What city/region do you train in?",
    why: "Recorded for your reference and to label reports; the live weather card is driven by COACH_WEATHER_LAT/LON in .env, not this field.",
  },
  {
    area: "identity",
    field: "identity.height_cm",
    question: "What's your standing height (cm)?",
    why: "Stable anthropometry kept for reference (and auto-filled from Garmin when enabled). Weight stays a live number, never stored here.",
  },

  // --- health & medication (dose_day/gi_trough drive the computed dose-cycle the coach reasons around) ---
  {
    area: "health",
    field: "health.medication.name",
    question: "Are you on any regular medication the coach should work around? (name)",
    why: "Surfaced in every coaching flow so advice is given AROUND your medication — the drug/dose/timing stay your prescriber's call, the coach just adapts to them.",
  },
  {
    area: "health",
    field: "health.medication.dose_day",
    question: "Which weekday do you take it?",
    why: "Drives the computed dose-cycle (days_since_dose): the coach keeps your hardest/longest sessions clear of the days the dose hits you hardest.",
  },
  {
    area: "health",
    field: "health.medication.gi_trough_days",
    question: "Which weekdays are your typical GI / low-energy trough?",
    why: "Feeds the dose-cycle's in_gi_trough flag, so the coach steers big fuelling-dependent sessions away from those days and watches for under-fuelling.",
  },
  {
    area: "health",
    field: "health.medication.implications",
    question: "Any coaching implications of the medication you want noted? (free-text list)",
    why: "Printed verbatim as 'Coaching implications' in the profile context block, so the coach factors them into every write-up.",
  },
  {
    area: "health",
    field: "health.conditions",
    question: "Any ongoing health conditions to be aware of? (list of name/status/swim_impact)",
    why: "Recorded for your reference and visible to Claude via get_profile; not yet pulled into the compact live coaching block.",
  },
  {
    area: "health",
    field: "health.strength_sessions_per_week",
    question: "How many strength sessions do you do per week?",
    why: "Recorded for your reference and visible via get_profile; not yet read by an automated flow.",
  },
  {
    area: "health",
    field: "health.sleep",
    question: "Anything notable about your sleep pattern? (free text)",
    why: "Recorded for reference; the coach's live sleep signal comes from Garmin (sleep score/hours), not this note.",
  },

  // --- biomechanics (leg-length / cleat inform run-load + injury notes) ---
  {
    area: "biomechanics",
    field: "biomechanics.leg_length_difference",
    question: "Do you have a leg-length difference, and what correction (run lift / bike shim) is in use?",
    why: "Surfaced to the coach so run-load and injury notes account for it — e.g. flagging asymmetric load when ramping run volume.",
  },
  {
    area: "biomechanics",
    field: "biomechanics.asymmetry",
    question: "Any left/right asymmetry or recurring one-sided niggle?",
    why: "Added to the coaching context as an injury-watch note, so the coach is cautious about the loads that aggravate it.",
  },
  {
    area: "biomechanics",
    field: "biomechanics.cleat",
    question: "Any cleat setup cue you want the coach to remember? (e.g. an angle adjustment)",
    why: "The cleat cue is echoed in the coaching context as a bike-setup reminder tied to knee/foot comfort.",
  },
  {
    area: "biomechanics",
    field: "biomechanics.mobility",
    question: "Any mobility limits worth recording? (hip flexion / internal rotation / hamstrings)",
    why: "Recorded for your reference and visible via get_profile; not yet read by an automated flow.",
  },
  {
    area: "biomechanics",
    field: "biomechanics.rehab",
    question: "Any ongoing rehab / prehab focuses? (list)",
    why: "Recorded for your reference and visible via get_profile; not yet read by an automated flow.",
  },

  // --- availability (shapes the week) ---
  {
    area: "availability",
    field: "availability.rest_day",
    question: "Which weekday is your usual rest day?",
    why: "Shapes the week in the coaching context, so the coach plans hard days and recovery around your fixed rest day.",
  },
  {
    area: "availability",
    field: "availability.fixed_sessions",
    question: "Any fixed weekly sessions (squad swim, club run, long-ride day)?",
    why: "Listed in the coaching context so the coach builds the week around your immovable sessions instead of suggesting conflicts.",
  },
  {
    area: "availability",
    field: "availability.notes",
    question: "Anything else about your weekly availability? (free text)",
    why: "Appended as an availability note the coach reads when shaping the week.",
  },
  {
    area: "availability",
    field: "availability.indoor_trainer",
    question: "Do you have an indoor trainer (turbo/smart bike)?",
    why: "Recorded for your reference and visible via get_profile; not yet read by an automated flow (the weather card decides indoor/outdoor from your .env thresholds).",
  },

  // --- equipment (reference / for the deep session + research context) ---
  {
    area: "equipment",
    field: "equipment.bikes",
    question: "What bikes do you ride (groupset, crank length, and each bike's as-raced weight incl. a bottle)?",
    why: "Visible to Claude via get_profile. A bike's race_weight_g (grams, as-raced) also surfaces in the live coaching block, where the coach adds your live weight to it for total system weight — e.g. to size tyre pressure.",
  },
  {
    area: "equipment",
    field: "equipment.power_meters",
    question: "Do you train with a power meter? (which)",
    why: "Recorded for your reference and visible via get_profile; FTP/power numbers themselves stay live from AI Endurance/Garmin.",
  },
  {
    area: "equipment",
    field: "equipment.wetsuit",
    question: "Do you have a wetsuit (and is it allowed for your races)?",
    why: "Recorded for your reference and visible via get_profile; not yet read by an automated flow.",
  },
  {
    area: "equipment",
    field: "equipment.run_shoes",
    question: "What run shoes are you in (rotation / race-day pair)?",
    why: "Recorded for your reference and visible via get_profile; not yet read by an automated flow.",
  },

  // --- bike_fit (reference) ---
  {
    area: "bike_fit",
    field: "bike_fit.fits",
    question: "Do you have a bike-fit record (saddle height, reach, etc.)?",
    why: "Recorded for your reference and visible to Claude via get_profile; not pulled into the compact live coaching block.",
  },
  {
    area: "bike_fit",
    field: "bike_fit.report_file",
    question: "Is there a bike-fit report PDF in the project to reference?",
    why: "A pointer kept for your reference; the coach doesn't open the file automatically.",
  },

  // --- fuelling (feeds nutrition context) ---
  {
    area: "fuelling",
    field: "fuelling.carb_target_g_per_hour",
    question: "What's your carb target per hour by session type (e.g. long 80, sprint 0)?",
    why: "Read into the coaching context as your per-session fuelling plan, so race/long-session advice references YOUR carb targets (the live nutrition ranges come from AI Endurance).",
  },
  {
    area: "fuelling",
    field: "fuelling.caffeine",
    question: "How do you use caffeine on race day? (your strategy)",
    why: "Surfaced in the coaching context as your caffeine lever, so race-prep advice respects your own plan.",
  },
  {
    area: "fuelling",
    field: "fuelling.products",
    question: "What nutrition do you actually use? (gels, bars, drink mix, electrolytes, recovery, supplements — per-serving carbs/sodium/caffeine)",
    why: "Powers the 'Fuelling — next session' dashboard card and the `fuelling` tool: per-session pre/during/after built from YOUR products, only when a session needs it. See profile.example.yaml → fuelling.products for the format.",
  },

  // --- races (extra targets beyond the first; the first is set in profile:init) ---
  {
    area: "races",
    field: "races",
    question: "Any other races/targets to add beyond your first one?",
    why: "Your race calendar is surfaced as 'Race targets' in every coaching flow so prep and periodisation track your real season (mirror target times into AI Endurance — read-only from here).",
  },
];

/**
 * Group the questions by `area`, preserving first-seen order, for the CLI and the doc to render the
 * same sections. Pure.
 */
export function questionsByArea(questions: ProfileQuestion[] = PROFILE_QUESTIONS): Array<{ area: string; items: ProfileQuestion[] }> {
  const order: string[] = [];
  const map = new Map<string, ProfileQuestion[]>();
  for (const q of questions) {
    if (!map.has(q.area)) {
      map.set(q.area, []);
      order.push(q.area);
    }
    map.get(q.area)!.push(q);
  }
  return order.map((area) => ({ area, items: map.get(area)! }));
}

/** The three ways to answer any of these — shown in the CLI header and the doc, kept in one place. */
export const WAYS_TO_ANSWER: string[] = [
  "Rerun the guided intake:  npm run profile:init  (it pre-fills what your integrations hold).",
  "Edit profile.local.yaml directly (it's gitignored and never shared).",
  "Ask Claude to fill it in for you (e.g. via the get_profile MCP tool / your assistant).",
];

/** Render the grouped question list as plain text for the CLI. Pure (no IO). */
export function renderQuestionsText(questions: ProfileQuestion[] = PROFILE_QUESTIONS): string {
  const lines: string[] = [];
  lines.push("Optional athlete-profile fields — fill in whatever's useful, whenever you like.");
  lines.push("ALL of these are OPTIONAL: the coach works fully without any of them. (The required");
  lines.push("identity / weekly hours / first race are set by `npm run profile:init`, not listed here.)");
  lines.push("");
  lines.push("Three ways to answer any of them:");
  for (const w of WAYS_TO_ANSWER) lines.push(`  • ${w}`);
  lines.push("");
  for (const { area, items } of questionsByArea(questions)) {
    lines.push(`${area}:`);
    for (const q of items) {
      lines.push(`  • ${q.question}`);
      lines.push(`      field: ${q.field}`);
      lines.push(`      why:   ${q.why}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Render the grouped question list as the `docs/profile-questions.md` body. Pure (no IO). */
export function renderQuestionsMarkdown(questions: ProfileQuestion[] = PROFILE_QUESTIONS): string {
  const lines: string[] = [];
  lines.push("<!-- GENERATED FROM src/profile/questions.ts — do not edit by hand. Regenerate: npm run profile:questions -- --write-doc -->");
  lines.push("");
  lines.push("# Optional profile questions");
  lines.push("");
  lines.push("These are the **optional** athlete-profile fields you can fill in whenever you like, each with a");
  lines.push("plain-language question and a one-line reason it matters. **All of them are optional** — the coach");
  lines.push("works fully without any of them. The *required* fields (identity, weekly hours, a first race) are");
  lines.push("handled by `npm run profile:init` and aren't repeated here.");
  lines.push("");
  lines.push("This page is generated from `src/profile/questions.ts` (the same data behind");
  lines.push("`npm run profile:questions`), so the CLI and this doc can't drift.");
  lines.push("");
  lines.push("## Three ways to answer any of them");
  lines.push("");
  for (const w of WAYS_TO_ANSWER) lines.push(`- ${w}`);
  lines.push("");
  // Escape for a Markdown table cell. Escape the backslash FIRST (otherwise a literal `\` in the
  // text would combine with the pipe-escape we add and mis-encode), then the cell separator.
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  for (const { area, items } of questionsByArea(questions)) {
    lines.push(`## ${area}`);
    lines.push("");
    lines.push("| Field | Question | Why it matters |");
    lines.push("|---|---|---|");
    for (const q of items) {
      lines.push(`| \`${esc(q.field)}\` | ${esc(q.question)} | ${esc(q.why)} |`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
