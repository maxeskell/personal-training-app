import { AieClient } from "../mcp/aieClient.js";
import { assembleState } from "../state/assemble.js";
import type { AthleteState } from "../state/types.js";
import type { AssembleContext, DataSource } from "./types.js";

/**
 * AI Endurance — the default and most capable spine. This wraps the existing AIE assemble path verbatim
 * (connect → assembleState → close), so routing through the seam is a zero-behaviour-change refactor:
 * the AthleteState produced is identical to the pre-seam code.
 */
export class AieDataSource implements DataSource {
  readonly id = "ai-endurance";
  readonly label = "AI Endurance";

  async assemble(ctx: AssembleContext): Promise<AthleteState> {
    const aie = new AieClient(); // non-interactive — same as the previous withAie() default
    await aie.connect();
    try {
      return await assembleState(aie, ctx.garmin, ctx.store, { date: ctx.date, assembledAt: ctx.assembledAt });
    } finally {
      await aie.close();
    }
  }
}
