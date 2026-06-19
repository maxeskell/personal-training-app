/**
 * Categorise a coach recommendation (a weekly-review "Next week" bullet, or a marginal-gain tweak) so the
 * dashboard can give each the RIGHT in-app action — instead of one flat "open the report / discuss with
 * coach" pointer. Pure + deterministic (keyword heuristics, no LLM), so it runs in the LLM-free dashboard
 * render path and is unit-testable. Honest by design: a recommendation it can't place lands in "general",
 * which still gets agree/disagree/snooze — never a dead end.
 *
 * Two independent questions:
 *   • {@link categorize} — what KIND of change is this (training / fuelling / gear / recovery / general)?
 *     Drives the category chip shown on the card.
 *   • {@link isPlanEdit} — is this a change to the training PLAN (move/cut/skip/add a session)? Drives the
 *     interaction: a plan edit gets the gated "Make this change" → propose→confirm write to AI Endurance;
 *     everything else gets agree/disagree/snooze. A fuelling/gear cue is never auto-written to the plan.
 */

export type ActionCategory = "training" | "fuelling" | "gear" | "recovery" | "general";

/** Short chip label shown on the card per category. */
export const CATEGORY_LABEL: Record<ActionCategory, string> = {
  training: "Training",
  fuelling: "Fuelling",
  gear: "Gear",
  recovery: "Recovery",
  general: "Note",
};

// Noun/topic keywords per category. Order of the CHECKS below (recovery → fuelling → gear → training)
// resolves overlaps deterministically: "recovery week" reads as recovery, not training; a fuelling cue
// that also names a run ("fuel the long run with 60g/h") reads as fuelling, not training.
const RECOVERY_RE = /\b(sleep|naps?|rest days?|rest-days?|recover(y|ing)?|deload|down ?weeks?|de-?load|hrv|stress|lifestyle|down\s?time|days? off)\b/i;
const FUELLING_RE = /\b(fuel|fuell\w*|carbs?|carbos?|gels?|glycogen|hydrat\w*|electrolytes?|sodium|protein|nutrition|calories?|kcal|under-?fuel\w*|gut|g\/h|grams?\/hour|drink mix|race fuel|breakfasts?|pre-?race meal)\b/i;
const GEAR_RE = /\b(shoes?|trainer plates?|bike ?fit|saddles?|cranks?|wheels?|tyres?|tires?|tubeless|tubes?|psi|pressure|wetsuits?|goggles|helmets?|kit|chamois|cleats?|aero|position|gear|equipment|gadgets?|sensors?|power meter|watch)\b/i;
const TRAINING_RE = /\b(rides?|runs?|swims?|sessions?|workouts?|intervals?|tempo|threshold|zone\s?\d|z\d|long runs?|long rides?|bricks?|volume|mileage|cadence|climbs?|hills?|tss|aerobic|endurance|sprints?|race pace|easy|hard|blocks?|taper|weeks?)\b/i;

/** What KIND of change a recommendation is — drives the category chip. Falls back to "general". */
export function categorize(text: string): ActionCategory {
  const t = text.toLowerCase();
  if (RECOVERY_RE.test(t)) return "recovery";
  if (FUELLING_RE.test(t)) return "fuelling";
  if (GEAR_RE.test(t)) return "gear";
  if (TRAINING_RE.test(t)) return "training";
  return "general";
}

// A plan EDIT is an imperative verb that restructures the schedule, aimed at a session/sport/time slot.
// Both halves must match, so "move the long run", "cut a ride", "add a recovery week" read as plan edits
// while "start the brick run 5s/km easier" (an execution CUE, not a reschedule) does not.
const PLAN_VERB_RE = /\b(move|moved|reschedul\w*|shift|cut|drop|skip|swap|replace|remove|reduce|trim|add|insert|push|pull|delay|bring forward|bump|split|space|spread|advance)\b/i;
const PLAN_TARGET_RE = /\b(rides?|runs?|swims?|sessions?|workouts?|bricks?|intervals?|tempo|threshold|long runs?|long rides?|sets?|weeks?|days?|blocks?|rest days?|recovery weeks?|easy days?|hard days?|doubles?)\b/i;

/**
 * Is this recommendation a change to the training PLAN (a session moved/cut/skipped/added) — i.e. something
 * the gated propose→confirm write can action in AI Endurance? Pure heuristic; the actual write is always
 * re-validated against the athlete's real scheduled sessions, so a false positive just drafts nothing.
 */
export function isPlanEdit(text: string): boolean {
  return PLAN_VERB_RE.test(text) && PLAN_TARGET_RE.test(text);
}
