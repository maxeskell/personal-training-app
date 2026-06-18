import type { AthleteState } from "../state/types.js";
import type { GarminClient } from "../mcp/garminClient.js";
import type { StateStore } from "../state/store.js";

/**
 * Data-source seam (Phase 3a). A DataSource is the training-data SPINE the coach assembles today's
 * AthleteState from — AI Endurance today; intervals.icu and others later. The point of the seam is that
 * the rest of the app (insight engine, dashboard, MCP, flows) consumes a uniform `AthleteState` and never
 * knows which source produced it. Garmin stays a cross-cutting OPTIONAL gap-filler, passed in here, not a
 * source of its own.
 *
 * Adding a source = implement this interface + register it in `selectDataSource` (see ./index.ts).
 */

export interface AssembleContext {
  store: StateStore;
  /** Optional Garmin gap-filler — already connected; the CALLER owns its lifecycle (connect/close). */
  garmin?: GarminClient;
  date: string;
  assembledAt: string;
}

export interface DataSource {
  /** Stable id used by config (COACH_SOURCE) and as the provenance tag. */
  readonly id: string;
  /** Human label for logs/UI. */
  readonly label: string;
  /** Assemble today's AthleteState from this source (+ the optional Garmin gap-filler). */
  assemble(ctx: AssembleContext): Promise<AthleteState>;
}
