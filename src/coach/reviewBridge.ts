import type { SessionDetail } from "./session.js";

/**
 * Review → plan bridge: the session-review half of the propose→confirm loop. It turns a COMPLETED
 * session's DETERMINISTIC outcome into a flagged, one-click draft plan adjustment for the days ahead —
 * closing a loop neither AI Endurance nor Humango is documented to close (an adjustment driven by how the
 * session actually executed, not just a readiness score).
 *
 * Two halves, deliberately split:
 *  - the TRIGGER is pure and deterministic (computed here, never by the LLM) — so the "should this change
 *    the plan?" decision can't be hallucinated;
 *  - only the resulting MINIMAL edit is drafted by the existing gated proposer (`draftGatedProposals`),
 *    targeted at a real upcoming workoutId, and it still requires an explicit propose→confirm.
 *
 * Conservative by design: a false flag becomes a declined proposal, which makes the proposer cautious, so
 * the trigger fires only on clearly directional signals on solid ground (decoupling is judged only on a
 * long, steady-ish effort where second-half drift means something) and stays silent otherwise.
 */

/** Aerobic decoupling above this (%), on a long-enough effort, reads as the aerobic base being under-built
 *  for that duration — the textbook >10% "base lacking" band (5–10% is "building", which we don't flag). */
export const DECOUPLE_FLAG_PCT = 10;
/** Only judge decoupling on an effort at least this long: it is invalid on short / interval sessions, and a
 *  long steady effort is where output-to-HR drift in the second half actually carries a signal. */
export const STEADY_MIN_MINUTES = 60;
/** TSB at/below this on the session day = the athlete trained deep in the hole. Set conservatively (a
 *  productive build sits ~-10..-20); below this, the days that follow want protected recovery rather than
 *  another quality session landing on accumulated fatigue. */
export const DEEP_FATIGUE_TSB = -25;

export type ReviewSignalKind = "deep-fatigue" | "aerobic-fade";

export interface ReviewSignal {
  kind: ReviewSignalKind;
  /** One-line, athlete-facing observation — the deterministic "why" shown on the card. */
  headline: string;
  /** The specific deterministic facts this rests on — cited to the proposer and in the confirmation basis. */
  reasons: string[];
  /** The direction of change to draft, in plain English — fed to the proposer as the request. */
  suggestion: string;
}

/**
 * The deterministic signal a completed session sends to the plan, or null when nothing warrants a change.
 * Pure and side-effect-free — the testable core of the bridge. Picks the single most significant signal
 * (deep fatigue outranks aerobic fade) so the card never nags with two competing asks.
 */
export function sessionPlanSignal(d: SessionDetail): ReviewSignal | null {
  const sport = d.sport.toLowerCase();
  const dateSport = `${d.date} ${sport}`;

  // Deep fatigue: trained well into the hole — protect the recovery that follows.
  if (d.tsbOnDay != null && d.tsbOnDay <= DEEP_FATIGUE_TSB) {
    const tsb = Math.round(d.tsbOnDay);
    return {
      kind: "deep-fatigue",
      headline: `You did this ${sport} deep in fatigue (TSB ${tsb}).`,
      reasons: [`TSB ${tsb} on ${d.date} (≤ ${DEEP_FATIGUE_TSB} = deep fatigue)`],
      suggestion:
        `The athlete completed the ${dateSport} session with TSB at ${tsb} — deep fatigue. ` +
        `Protect the recovery that follows: ease or push back the next hard / quality session in the days ahead so ` +
        `it doesn't land on accumulated fatigue. Prefer the smallest change (a move, a skip of one hard session, or ` +
        `a coaching note), not a restructure.`,
    };
  }

  // Aerobic fade: a long steady effort whose output-to-HR drifted apart in the second half.
  if (
    d.decay?.decouplingPct != null &&
    d.decay.decouplingPct > DECOUPLE_FLAG_PCT &&
    d.durationMin != null &&
    d.durationMin >= STEADY_MIN_MINUTES
  ) {
    const dc = +d.decay.decouplingPct.toFixed(1);
    return {
      kind: "aerobic-fade",
      headline: `This ${d.durationMin}-min ${sport} decoupled ${dc}% in the second half (>${DECOUPLE_FLAG_PCT}% = aerobic base under-built for this duration).`,
      reasons: [`Aerobic decoupling ${dc}% on a ${d.durationMin}-min ${sport} (> ${DECOUPLE_FLAG_PCT}% threshold)`],
      suggestion:
        `The athlete's ${dateSport} (${d.durationMin}min) decoupled ${dc}% — output-to-HR drifted apart in the ` +
        `second half, a sign the aerobic base is under-built for that duration. Ease the next quality / threshold ` +
        `session in the days ahead, or protect aerobic (Z2) volume before the next hard block. Smallest change only ` +
        `(a move, a skip of one hard session, or a coaching note) — don't restructure the week.`,
    };
  }

  return null;
}

/**
 * The free-text request handed to the (existing) gated proposer for a session signal. The proposer turns it
 * into a minimal, validated edit against a REAL upcoming workoutId; the deterministic facts ride along as the
 * basis so the confirmation cites the "why". Built server-side from a recomputed signal, never from
 * client-supplied text, so the trigger can't be spoofed into a plan change.
 */
export function buildSessionAdjustRequest(d: SessionDetail, signal: ReviewSignal): string {
  return (
    `A just-completed session flags a change to the days ahead. ${signal.suggestion} ` +
    `Target a SPECIFIC upcoming planned session by id; if nothing upcoming fits, propose nothing and say so in notes. ` +
    `Deterministic basis: ${signal.reasons.join("; ")}.`
  );
}
