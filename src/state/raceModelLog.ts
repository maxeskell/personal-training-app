/**
 * Disk half of the spec-07 race-model log (pure logic in insights/raceReview.ts):
 *  - `data/race-predictions.json` — the latest PRE-race splits plan per race, upserted on dashboard
 *    renders while the race is still ahead (small map, atomic temp+rename overwrite).
 *  - `data/race-reviews.jsonl` — one immutable row per completed race: frozen prediction vs official
 *    result (append-only, idempotent by race key).
 * Both are runtime-generated (gitignored `data/`). Everything here is best-effort: a broken file or
 * failed write degrades to "no track record shown", never a crashed render.
 */

import { mkdir, readFile, writeFile, rename, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import type { RaceSplitPlan } from "../insights/splits.js";
import {
  newReviews,
  predictionFromPlan,
  upsertPredictions,
  type CareerRaceLike,
  type RacePredictionRecord,
  type RaceReviewRecord,
} from "../insights/raceReview.js";

const predictionsFile = () => join(config.dataDir, "race-predictions.json");
const reviewsFile = () => join(config.dataDir, "race-reviews.jsonl");

export async function loadRacePredictions(): Promise<RacePredictionRecord[]> {
  try {
    const raw = JSON.parse(await readFile(predictionsFile(), "utf8")) as { predictions?: RacePredictionRecord[] };
    return Array.isArray(raw.predictions) ? raw.predictions : [];
  } catch {
    return [];
  }
}

async function saveRacePredictions(predictions: RacePredictionRecord[]): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  const tmp = `${predictionsFile()}.tmp`;
  await writeFile(tmp, JSON.stringify({ predictions }, null, 1));
  await rename(tmp, predictionsFile());
}

export async function loadRaceReviews(): Promise<RaceReviewRecord[]> {
  try {
    const raw = await readFile(reviewsFile(), "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as RaceReviewRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is RaceReviewRecord => r != null);
  } catch {
    return [];
  }
}

async function appendRaceReviews(rows: RaceReviewRecord[]): Promise<void> {
  if (!rows.length) return;
  await mkdir(config.dataDir, { recursive: true });
  await appendFile(reviewsFile(), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/**
 * The whole post-race hook in one best-effort call (dashboard render path): freeze/refresh the
 * pre-race prediction for every upcoming plan, then review any race whose official result has since
 * landed in career history. Returns ALL reviews (old + new) for display; [] on any failure.
 */
export async function recordAndReviewRaces(
  plans: RaceSplitPlan[],
  stateDate: string,
  races: CareerRaceLike[],
  now: Date = new Date(),
): Promise<RaceReviewRecord[]> {
  try {
    const savedAt = now.toISOString();
    const stored = await loadRacePredictions();
    const merged = upsertPredictions(stored, plans.map((p) => predictionFromPlan(p, stateDate, savedAt)));
    if (JSON.stringify(merged) !== JSON.stringify(stored)) await saveRacePredictions(merged);
    const reviews = await loadRaceReviews();
    const fresh = newReviews(merged, races, new Set(reviews.map((r) => r.key)), savedAt);
    await appendRaceReviews(fresh);
    return [...reviews, ...fresh];
  } catch {
    return []; // degrade: no track record beats a broken dashboard
  }
}
