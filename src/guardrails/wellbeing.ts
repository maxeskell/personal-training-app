import type { AthleteState } from "../state/types.js";

/**
 * Hard wellbeing guardrails — DETERMINISTIC code, not LLM judgement (Build Spec §8).
 *
 * Two jobs:
 *  1. screenNutritionPrompt(): block restriction/deficit/"race weight" framing BEFORE
 *     it reaches the model, and redirect to adequate fuelling (acceptance §9.7).
 *  2. assessHealthRisk(): if multiple risk signals co-occur, raise gently and refer to a
 *     professional — NEVER diagnose (no RED-S labelling), never treat weight loss as a win.
 */

const RESTRICTION_PATTERNS: Array<{ rx: RegExp; label: string }> = [
  { rx: /\b(calorie|caloric)\s+(deficit|restrict)/i, label: "calorie deficit" },
  { rx: /\bdeficit\b/i, label: "deficit" },
  { rx: /\b(cut|cutting|drop|lose|losing|shed)\s+(weight|kg|kilos|pounds|lbs|fat)/i, label: "weight loss" },
  { rx: /\brace\s*weight\b/i, label: "race weight" },
  { rx: /\b(restrict|restricting|under-?eat|undereat)/i, label: "restriction" },
  { rx: /\b(lean(er)?\s+for\s+race|get\s+leaner)\b/i, label: "leaning out" },
  { rx: /\bhow\s+(do\s+i|to)\s+(lose|drop)\b/i, label: "weight loss" },
  { rx: /\b(low[-\s]?carb|keto)\s+to\s+(lose|lean|cut)/i, label: "restrictive diet for weight loss" },
];

export interface NutritionScreen {
  blocked: boolean;
  matched?: string;
  redirect?: string;
}

/**
 * Returns blocked:true with a redirect message if the prompt implies restriction.
 * The caller must surface `redirect` instead of forwarding the prompt to the LLM.
 */
export function screenNutritionPrompt(prompt: string): NutritionScreen {
  for (const { rx, label } of RESTRICTION_PATTERNS) {
    if (rx.test(prompt)) {
      return {
        blocked: true,
        matched: label,
        redirect:
          "I won't help with calorie deficits, restriction, or a 'race weight' — under-fuelling " +
          "endurance training risks your health and your goals. Fuel to train: I'll use AI Endurance's " +
          "nutrition ranges as adequate-fuelling targets, and treat weight only as a long-term trend, " +
          "never a daily target. If you're worried about body composition, that's a conversation for a " +
          "sports dietitian, not a deficit. Want me to pull today's fuelling ranges and your long-run " +
          "carb targets instead?",
      };
    }
  }
  return { blocked: false };
}

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
  return { level: "none", signals };
}
