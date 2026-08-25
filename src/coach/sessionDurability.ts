import { withAie } from "./orchestrator.js";
import { extractJson } from "../state/assemble.js";
import { mapActivityDurability, type DurabilityFetcher } from "../insights/activityDetail.js";

/**
 * Live per-session durability fetcher (AIE Detail tools — spec 10 phase 2). One heavy Detail read for
 * ONE activity, on demand, only from the session-readout flows — never from the daily assemble loop
 * (that bulk weight is what AIE's summary slimming exists to prevent).
 *
 * Self-managing (opens/closes its own AIE connection per fetch) so call sites don't thread a client,
 * and best-effort throughout: no auth, a timeout, a shape change, or the pre-rollout bare `{}` all
 * return null — the readout then degrades to summary metrics (degrade, don't crash). Swims have no
 * Detail durability feed (no R-R in water) — null without a network call.
 */
export function aieDurabilityFetcher(): DurabilityFetcher {
  return async (sport, id) => {
    if (sport === "Swim") return null;
    try {
      return await withAie(async (aie) => {
        const tool = sport === "Run" ? "getRunningActivityDetail" : "getCyclingActivityDetail";
        const raw = extractJson(await aie.read(tool, { activityId: id, with_dfa_alpha1: true, with_power_curve: true }));
        return mapActivityDurability(raw);
      });
    } catch {
      return null;
    }
  };
}
