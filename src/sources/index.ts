import { config } from "../config.js";
import { AieDataSource } from "./aieSource.js";
import type { DataSource } from "./types.js";

export type { DataSource, AssembleContext } from "./types.js";

/** Ids that resolve to the AI Endurance spine (accepting a couple of friendly aliases). */
const AIE_IDS = new Set(["ai-endurance", "aie", "aiendurance"]);

/**
 * Select the configured training-data source (spine). AI Endurance is the default and the fallback for
 * any unknown id — degrade, don't crash. Adding a new adapter = a new branch here returning your
 * DataSource implementation; everything downstream consumes the uniform AthleteState unchanged.
 */
export function selectDataSource(id: string = config.source): DataSource {
  const key = id.trim().toLowerCase();
  if (AIE_IDS.has(key)) return new AieDataSource();
  console.warn(`Unknown COACH_SOURCE="${id}" — falling back to AI Endurance.`);
  return new AieDataSource();
}
