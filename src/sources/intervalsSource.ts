import { fetchIntervals } from "./intervals/api.js";
import { mapIntervals } from "./intervals/map.js";
import type { AthleteState } from "../state/types.js";
import type { AssembleContext, DataSource } from "./types.js";

/**
 * intervals.icu spine (Phase 3b). Fetches the trailing window + upcoming events and maps them to the
 * uniform AthleteState. A thinner coach than AI Endurance — DFA-α1 durability, AIE race predictions and
 * plan-progress adherence have no intervals.icu equivalent, so those cards degrade (mapIntervals leaves
 * them absent). Read-only; the gated AIE write path is not available on this source.
 */
export class IntervalsDataSource implements DataSource {
  readonly id = "intervals";
  readonly label = "intervals.icu";

  async assemble(ctx: AssembleContext): Promise<AthleteState> {
    const raw = await fetchIntervals(new Date(`${ctx.date}T00:00:00Z`));
    return mapIntervals(raw, { date: ctx.date, assembledAt: ctx.assembledAt });
  }
}
