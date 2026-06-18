import type { AthleteState } from "../state/types.js";

/**
 * Hard wellbeing guardrails — DETERMINISTIC code, not LLM judgement (Build Spec §8).
 *
 * Two jobs:
 *  1. screenNutritionPrompt(): a pre-LLM safety screen on free-text prompts. It blocks three classes
 *     BEFORE they reach the model — (a) acute medical symptoms (stop & see a professional), (b)
 *     disordered-eating cues (non-judgmental support referral), (c) restriction / "race weight" framing
 *     (redirect to adequate fuelling) — returning a category-appropriate `redirect` for the caller to
 *     surface instead of forwarding the prompt. (Also exported as `screenWellbeingPrompt`.)
 *  2. assessHealthRisk(): if multiple risk signals co-occur, raise gently and refer to a
 *     professional — NEVER diagnose (no RED-S labelling), never treat weight loss as a win.
 *
 * These are deterministic backstops; the system prompt's clinical-boundary clause (coach/persona.ts) is
 * the in-LLM defence-in-depth for anything the screens don't catch.
 */

// ---- (a) Acute medical symptoms — most urgent; never forward to a training LLM. ----
const ACUTE_SYMPTOM_PATTERNS: RegExp[] = [
  /\bchest\s+(pain|tightness|pressure)\b|\btight(ness)?\s+in\s+(my\s+)?chest\b|\bchest\b[\w\s'’,-]{0,10}?\bpain\b/i,
  /\b(short(ness)? of breath|can'?t breathe|trouble breathing|breathless)\b/i,
  /\b(faint(ed|ing)?|pass(ed|ing)? out|black(ed|ing)? out|dizzy|dizziness|light-?headed|vertigo)\b/i,
  /\b(numb(ness)?|tingling|pins and needles)\b/i,
  /\b(palpitations|heart (racing|skipping|fluttering|irregular)|irregular (heart ?beat|pulse))\b/i,
  /\b(coughing up blood|blood in (my\s+)?(urine|pee|stool|poo)|peeing blood)\b/i,
  /\b(sharp|severe|stabbing|excruciating)\s+pain\b/i,
  /\b(swollen|swelling|popped|gave way|can'?t (put|bear) weight|can'?t walk)\b/i,
  /\b(concussion|hit my head|head injury|knocked out)\b/i,
];
const ACUTE_REDIRECT =
  "That sounds like a possible medical symptom, not a training question — I'm a training tool, not a " +
  "medical professional, and I can't assess it. If anything is severe, sudden or worrying (chest pain, " +
  "trouble breathing, fainting, numbness, bleeding), stop and seek medical help now — emergency services " +
  "if it's severe. For pain, swelling or an injury that won't settle, see a doctor or physio before you " +
  "train through it. Please don't push through this on my say-so.";

// ---- (b) Disordered-eating cues — non-judgmental support referral; never forwarded. ----
const ED_PATTERNS: RegExp[] = [
  /\b(purge|purging|purged|make myself (sick|throw up|vomit)|throw(ing)? up|vomit(ing|ed)?)\b/i,
  /\b(binge|binging|bingeing|binged)\b/i,
  /\b(laxative|diuretic)s?\b|\bdiet pills?\b/i,
  /\b(starve|starving|starved)\b/i,
  /\b(skip(ping)?\s+(meals|eating)|not eating|barely eat(ing)?|stopped eating)\b/i,
  /\b(guilt(y)?|ashamed|shame|disgust(ed|ing)?)\b[\w\s'’,-]{0,20}?\b(eat(ing)?|food|meal|ate)\b/i,
  /\b(scared|afraid|terrified|anxious)\b[\w\s'’,-]{0,15}?\b(eat(ing)?|food)\b/i,
  /\bout of control\b[\w\s'’,-]{0,15}?\b(eat(ing)?|food)\b|\beat(ing)?\b[\w\s'’,-]{0,15}?\bout of control\b/i,
  /\b(compensate|punish)\b[\w\s'’,-]{0,20}?\b(eat(ing)?|food|calories|binge)\b/i,
];
const ED_REDIRECT =
  "I'm not able to help with that, and I want to be straight with you: purging, skipping meals to lose " +
  "weight, or feeling out of control or guilty around food are signs worth taking seriously — and they're " +
  "outside what a training tool should advise on. Please talk to a doctor, or a service that supports " +
  "disordered eating (an eating-disorder helpline, or a sports physician/registered dietitian who works " +
  "with athletes). You deserve support with this — it matters far more than any session or race.";

// ---- (c) Restriction / under-fuelling / "race weight" intent → redirect to adequate fuelling. ----
// Two-part test: high-signal standalone phrases PLUS a token CO-OCCURRENCE test — any hard reduction verb
// together with any body-mass noun ANYWHERE in the prompt (not just adjacent). The earlier adjacency-only
// regexes leaked "reduce my weight", "get my weight down", "skip breakfast", "8% body fat", "1000 calorie
// diet". The redirect is gentle (fuel-to-train, not a refusal), so we accept some false positives to avoid
// leaking the real thing; legitimate fuelling questions carry no reduction verb and pass.
const REDUCE_VERB = /\b(lose|losing|lost|drop|dropping|cut|cutting|shed|shedding|trim|trimming|reduce|reducing|lower|lowering|shrink|shrinking|burn(?:ing)?\s+off)\b/i;
const BODY_MASS = /\b(weight|kgs?|kilos?|kilograms?|pounds?|lbs?|body\s?fat|bodyfat|fat|waist(?:line)?)\b/i;
const RESTRICTION_PATTERNS: Array<{ rx: RegExp; label: string }> = [
  { rx: /\b(calorie|caloric|kcal)s?\s+(deficit|restrict|cap|limit)\b|\bcalorie\s+deficit\b/i, label: "calorie deficit" },
  { rx: /\bdeficit\b/i, label: "deficit" },
  { rx: /\b\d{2,4}\s*-?\s*(k?cal|calorie)/i, label: "calorie-capped diet" },
  { rx: /\b(under|below)\s+maintenance\b/i, label: "eating under maintenance" },
  { rx: /\b(restrict|restricting|under-?eat|undereat|eat(?:ing)?\s+less)\b/i, label: "restriction" },
  { rx: /\b(race|racing)\s?weight\b/i, label: "race weight" },
  { rx: /\bintermittent\s+fast|fast(?:ing)?\s+(to|for)\s+(lose|lean|weight|cut)|\bfasting\s+diet\b/i, label: "fasting to lose" },
  { rx: /\bskip(?:ping)?\s+(?:a\s+|my\s+)?(meal|meals|breakfast|lunch|dinner|food)\b/i, label: "skipping meals" },
  { rx: /\bget(?:ting)?\s+(shredded|ripped)\b|\bshredded\s+(for|before)\b/i, label: "getting shredded" },
  { rx: /\b\d{1,2}\s*%?\s*body\s?fat\b|\bbody\s?fat\s+(percentage|target|goal|of)\b/i, label: "body-fat target" },
  { rx: /\b(get(?:ting)?\s+lean(er)?|lean(er)?\s+(for|before|out)|lean\s+out|leaning\s+out)\b/i, label: "leaning out" },
  { rx: /\b(slim|trim)\w*\s+(down|up)\b/i, label: "slimming down" },
  { rx: /\b(lighter|lightest|lowest|minimum)\b[\w\s'’,-]{0,20}?\b(weight|race|climb|for)\b/i, label: "getting lighter" },
  { rx: /\bhow\s+(light|low)\b[\w\s'’,-]{0,20}?\b(can|should|safe)\b/i, label: "how light can I get" },
  { rx: /\b(weight|kgs?|kilos?)\b[\w\s'’,-]{0,15}?\bdown\b/i, label: "getting weight down" },
  { rx: /\b(target|goal|ideal|optimal|racing|race)\s+(body\s?)?weight\b/i, label: "weight target" },
  { rx: /\b(body\s?weight|weight)\s+should\s+i\s+(be|race|aim|target|get|eat)\b/i, label: "weight target" },
  { rx: /\b(on|do|doing|start|starting|put me on)\s+a\s+cut\b/i, label: "a cut" },
  { rx: /\b(low[-\s]?carb|keto)\s+to\s+(lose|lean|cut)/i, label: "restrictive diet for weight loss" },
];
const RESTRICTION_REDIRECT =
  "I won't help with calorie deficits, restriction, or a 'race weight' — under-fuelling " +
  "endurance training risks your health and your goals. Fuel to train: I'll use AI Endurance's " +
  "nutrition ranges as adequate-fuelling targets, and treat weight only as a long-term trend, " +
  "never a daily target. If you're worried about body composition, that's a conversation for a " +
  "sports dietitian, not a deficit. Want me to pull today's fuelling ranges and your long-run " +
  "carb targets instead?";

function matchRestriction(prompt: string): string | null {
  for (const { rx, label } of RESTRICTION_PATTERNS) if (rx.test(prompt)) return label;
  if (REDUCE_VERB.test(prompt) && BODY_MASS.test(prompt)) return "weight loss";
  return null;
}

export interface NutritionScreen {
  blocked: boolean;
  category?: "acute-symptom" | "disordered-eating" | "restriction";
  matched?: string;
  redirect?: string;
}

/**
 * Pre-LLM safety screen. Returns blocked:true with a category-appropriate `redirect` when the prompt is an
 * acute medical symptom, a disordered-eating cue, or restriction/weight-target framing. The caller MUST
 * surface `redirect` instead of forwarding the prompt to the model. Checked most-urgent-first.
 */
export function screenNutritionPrompt(prompt: string): NutritionScreen {
  if (ACUTE_SYMPTOM_PATTERNS.some((rx) => rx.test(prompt))) {
    return { blocked: true, category: "acute-symptom", matched: "acute symptom", redirect: ACUTE_REDIRECT };
  }
  if (ED_PATTERNS.some((rx) => rx.test(prompt))) {
    return { blocked: true, category: "disordered-eating", matched: "disordered eating", redirect: ED_REDIRECT };
  }
  const label = matchRestriction(prompt);
  if (label) return { blocked: true, category: "restriction", matched: label, redirect: RESTRICTION_REDIRECT };
  return { blocked: false };
}

/** Clearer name for the broadened screen; same function. */
export const screenWellbeingPrompt = screenNutritionPrompt;

export type RiskLevel = "none" | "watch" | "raise";

export interface HealthRiskAssessment {
  level: RiskLevel;
  signals: string[];
  message?: string;
}

/**
 * Co-occurrence check across recent daily states. NOT a diagnosis — counts how many
 * health-risk signals are concurrently present and, if several co-occur, advises a gentle
 * check-in and professional referral. Never labels RED-S, never frames loss as good.
 *
 * @param window trailing daily states (ascending), should include today.
 */
export function assessHealthRisk(window: AthleteState[]): HealthRiskAssessment {
  if (window.length < 3) return { level: "none", signals: [] };

  const today = window[window.length - 1];
  const signals: string[] = [];

  // 1. Rapid/unexplained weight loss: >2% over the window (trend, not a single reading).
  const weights = window.map((s) => s.weightKg.value).filter((w): w is number => w != null);
  if (weights.length >= 3) {
    const first = weights[0];
    const last = weights[weights.length - 1];
    if (first > 0 && (first - last) / first > 0.02) {
      signals.push(`weight trend down >2% (${first.toFixed(1)}→${last.toFixed(1)} kg)`);
    }
  }

  // 2. Suppressed HRV vs baseline (today materially below 7d baseline).
  const hrv = today.hrvOvernight.value;
  const hrvBase = today.hrv7dBaseline.value;
  if (hrv != null && hrvBase != null && hrvBase > 0 && hrv < hrvBase * 0.85) {
    signals.push(`HRV suppressed (${hrv} vs ${hrvBase.toFixed(0)} baseline)`);
  }

  // 3. Poor sleep (recent average below ~6.5h, where sleep is present).
  const sleeps = window.map((s) => s.sleep.value?.hours).filter((h): h is number => h != null);
  if (sleeps.length >= 3) {
    const avg = sleeps.reduce((a, b) => a + b, 0) / sleeps.length;
    if (avg < 6.5) signals.push(`low sleep (avg ${avg.toFixed(1)}h)`);
  }

  // 4. Rising resting HR vs baseline.
  const rhr = today.restingHr.value;
  const rhrBase = today.restingHr7dBaseline.value;
  if (rhr != null && rhrBase != null && rhrBase > 0 && rhr > rhrBase + 5) {
    signals.push(`resting HR elevated (${rhr} vs ${rhrBase.toFixed(0)} baseline)`);
  }

  // Gentle, non-clinical escalation: 3+ co-occurring signals → raise; 2 → watch.
  if (signals.length >= 3) {
    return {
      level: "raise",
      signals,
      message:
        "A few signals are pointing the same way at once: " +
        signals.join("; ") +
        ". I'm not diagnosing anything — but when several of these co-occur it's worth easing off " +
        "and checking in with a doctor or sports physician, especially to rule out under-fuelling. " +
        "Please don't treat the weight change as a win. Prioritise rest and full fuelling for now.",
    };
  }
  if (signals.length === 2) {
    return {
      level: "watch",
      signals,
      message:
        "Two signals worth keeping an eye on: " +
        signals.join("; ") +
        ". Not alarming on its own — make sure you're fuelling and sleeping well, and we'll watch the trend.",
    };
  }
  // A rapid/unexplained weight drop is a health concern on its OWN — it must never be gated behind a
  // second co-occurring signal (criterion #6: flag rapid weight loss as a concern, not a win). A single
  // non-weight signal (one poor night) stays "none" — that's the trend-over-point stance.
  const hasWeightLoss = signals.some((s) => /weight trend down/.test(s));
  if (hasWeightLoss) {
    return {
      level: "watch",
      signals,
      message:
        signals.join("; ") +
        ". A rapid weight drop is a health signal, not a win — make sure you're fully fuelling. If it " +
        "continues or you can't explain it, check in with a doctor or sports dietitian. Weight is a " +
        "long-term trend, never a target.",
    };
  }
  return { level: "none", signals };
}
