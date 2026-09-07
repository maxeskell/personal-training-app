/**
 * Import an OFFICIAL race result (the block you copy off the timing company's results page) into the
 * career history (`data/career-history.json`) — the one place the app reads race results from. This is
 * the hand-authored path the career build already honours ("anything you hand-author always wins"),
 * just without editing JSON by hand: paste the results block, name the race, done.
 *
 * Why this exists: the career build derives performance from your OWN files (a matched `.FIT`), which
 * gives leg times and HR/power but never the OFFICIAL clock, your placing, or the transitions the
 * timing mats saw. Those only exist on the results page — and nothing here scrapes the web (standing
 * design choice), so the athlete pastes them. Once the result lands, the spec-07 post-race hook judges
 * the frozen pre-race prediction against it on the next dashboard render (`recordAndReviewRaces`).
 *
 * Everything in this module is PURE (parse + merge); the CLI (`race-result`) does the one file read /
 * atomic write. Tolerant of results-page formatting: any `Key: value` line is read, leg keys are
 * matched loosely (Swim / T1 / Cycle|Bike / T2 / Run), and the finish line (`38  Jane Doe  02:42:11.9  FIN`)
 * is picked out wherever it sits. Official tenths are rounded to the second (the career page shows
 * whole seconds everywhere; the tenth is kept in the summary line so nothing is silently lost).
 */

import type { CareerHistory, Race, RaceResult, RaceSplit } from "./careerHistory.js";

/** What the results page said, normalised. Nothing here is a MODEL — it is the timing company's record. */
export interface OfficialResult {
  /** Whole-second finish clock, pre-formatted like the rest of the career file ("2:42:12"). */
  time: string;
  /** Finish clock in seconds (rounded from tenths where the page gave them). */
  timeSec: number;
  /** The exact string the page showed (e.g. "02:42:11.9") — kept so rounding is visible. */
  timeRaw: string;
  /** Overall placing, when the finish line carries one. */
  overallPos?: number;
  /** Age-group placing ("4/18" → 4 of 18). */
  agPos?: number;
  agTotal?: number;
  /** Age-group label as printed ("Ages 45 - 49" → "45–49"). */
  ageGroup?: string;
  category?: string;
  raceNo?: string;
  team?: string;
  finishStatus?: string;
  /** Per-leg official splits in race order, labelled the way the career splits table expects. */
  legs: RaceSplit[];
}

/** Leg keys as results pages print them → the label the career splits (and the FIT-derived legs) use. */
const LEG_KEYS: Array<{ match: RegExp; label: string }> = [
  { match: /^swim$/i, label: "Swim" },
  { match: /^t\s?1$|^transition\s?1$/i, label: "T1" },
  { match: /^(cycle|bike|ride|cycling)$/i, label: "Bike" },
  { match: /^t\s?2$|^transition\s?2$/i, label: "T2" },
  { match: /^run$/i, label: "Run" },
];

/** "02:42:11.9" / "35:58.4" / "1:06" → seconds (rounded to the whole second), or null. */
export function officialClockToSeconds(s: string): number | null {
  const m = s.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d+))?$/);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (min > 59 || sec > 59) return null;
  const tenths = m[4] ? Number(`0.${m[4]}`) : 0;
  return Math.round(h * 3600 + min * 60 + sec + tenths);
}

/** Seconds → the career file's pre-formatted clock ("2:42:12" / "35:58"). */
export function clockFromSeconds(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
}

const CLOCK = /\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?/;

/**
 * Parse a pasted results block. Returns null when no finish clock can be found (the one thing a result
 * must carry). Leg lines are optional — a run-only race has none.
 */
export function parseOfficialResult(text: string): OfficialResult | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const fields = new Map<string, string>();
  const legs: RaceSplit[] = [];
  let finish: { raw: string; sec: number; pos?: number } | undefined;

  for (const line of lines) {
    const kv = line.match(/^([A-Za-z][A-Za-z0-9 /]*?)\s*:\s*(.+)$/);
    if (kv) {
      const key = kv[1].trim();
      const value = kv[2].trim();
      const leg = LEG_KEYS.find((k) => k.match.test(key));
      if (leg) {
        const sec = officialClockToSeconds(value);
        if (sec != null) legs.push({ label: leg.label, time: clockFromSeconds(sec) });
        continue;
      }
      fields.set(key.toLowerCase().replace(/\s+/g, " "), value);
      continue;
    }
    // The finish line: "<pos>  <name>  <clock>  <status>" — any line carrying a full H:MM:SS clock and no
    // key. The first such line wins (a results page lists the athlete once).
    if (!finish) {
      const clock = line.match(CLOCK);
      if (clock) {
        const sec = officialClockToSeconds(clock[0]);
        if (sec != null) {
          const pos = line.match(/^(\d{1,4})\b/);
          finish = { raw: clock[0], sec, pos: pos ? Number(pos[1]) : undefined };
        }
      }
    }
  }
  // Some pages print the finish as a "Time:"/"Finish:"/"Overall:" field instead of a results row.
  if (!finish) {
    for (const key of ["time", "finish", "finish time", "overall", "total", "chip time", "gun time"]) {
      const v = fields.get(key);
      const sec = v ? officialClockToSeconds(v) : null;
      if (v && sec != null) {
        finish = { raw: v, sec };
        break;
      }
    }
  }
  if (!finish) return null;

  const agRaw = fields.get("a/g pos") ?? fields.get("ag pos") ?? fields.get("age group pos") ?? fields.get("category pos");
  const ag = agRaw?.match(/^(\d+)\s*(?:\/|of)\s*(\d+)/);
  const ageRaw = fields.get("age group") ?? fields.get("a/g category");
  const ageRange = ageRaw?.match(/(\d{2})\s*[-–]\s*(\d{2})/);
  const overallField = fields.get("overall pos") ?? fields.get("pos") ?? fields.get("position");
  const overallFromField = overallField?.match(/^(\d+)/);

  return {
    time: clockFromSeconds(finish.sec),
    timeSec: finish.sec,
    timeRaw: finish.raw,
    overallPos: finish.pos ?? (overallFromField ? Number(overallFromField[1]) : undefined),
    agPos: ag ? Number(ag[1]) : undefined,
    agTotal: ag ? Number(ag[2]) : undefined,
    ageGroup: ageRange ? `${ageRange[1]}–${ageRange[2]}` : ageRaw && !/^\d+\/\d+$/.test(ageRaw) ? ageRaw : undefined,
    category: fields.get("category"),
    raceNo: fields.get("race no") ?? fields.get("bib") ?? fields.get("number"),
    team: fields.get("team") ?? fields.get("club"),
    finishStatus: fields.get("finish status") ?? fields.get("status"),
    legs,
  };
}

const ordinal = (n: number): string => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

/** The career page's hand-authored `position` line, e.g. "38th overall · 4th of 18 AG (45–49)". */
export function positionLabel(r: OfficialResult): string | undefined {
  const bits: string[] = [];
  if (r.overallPos != null) bits.push(`${ordinal(r.overallPos)} overall`);
  if (r.agPos != null && r.agTotal != null) bits.push(`${ordinal(r.agPos)} of ${r.agTotal} AG${r.ageGroup ? ` (${r.ageGroup})` : ""}`);
  else if (r.agPos != null) bits.push(`${ordinal(r.agPos)} AG${r.ageGroup ? ` (${r.ageGroup})` : ""}`);
  return bits.length ? bits.join(" · ") : undefined;
}

export interface RaceIdentity {
  date: string; // YYYY-MM-DD
  event?: string; // "Alderford Triathlon"
  type: string; // "Olympic triathlon", "Half-marathon", ...
  sport?: string; // default: inferred from `type` (triathlon/duathlon/run/ride/swim)
  location?: string;
}

/** Infer the career `sport` family from a race type label when the caller didn't give one. */
export function inferSport(type: string): string {
  const t = type.toLowerCase();
  if (/tri|olympic|sprint|70\.?3|iron|standard|middle/.test(t)) return "triathlon";
  if (/duathlon/.test(t)) return "duathlon";
  if (/aquathlon|aquabike|swimrun/.test(t)) return "multisport";
  if (/swim/.test(t)) return "swim";
  if (/sportive|ride|bike|cycl|tt\b|time trial/.test(t)) return "ride";
  if (/run|marathon|\b\d+\s?k\b|mile/.test(t)) return "run";
  return "other";
}

/** Turn a parsed official result + the race's identity into a career-history race entry. */
export function raceFromOfficial(id: RaceIdentity, r: OfficialResult): Race {
  const result: RaceResult = { time: r.time };
  if (r.legs.length) result.splits = r.legs.map((l) => ({ ...l }));
  return {
    date: id.date,
    sport: id.sport ?? inferSport(id.type),
    type: id.type,
    event: id.event,
    location: id.location,
    confidence: id.location ? "confirmed" : undefined,
    source: "official",
    position: positionLabel(r),
    result,
  };
}

const normLabel = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Merge official splits over whatever the race already had: the official time replaces a derived one
 * per matching label, while FIT-only fields (dist / pace / HR / watts) on that leg are kept. Official
 * legs with no existing counterpart are appended in race order; existing legs the page didn't list
 * (a FIT lap table on a single-sport race, say) are kept only when NO official legs matched at all —
 * mixing a per-leg official table with a per-lap FIT table would double-count.
 */
export function mergeSplits(existing: RaceSplit[] | undefined, official: RaceSplit[]): RaceSplit[] | undefined {
  if (!official.length) return existing;
  if (!existing?.length) return official.map((l) => ({ ...l }));
  const matched = new Set<number>();
  const out: RaceSplit[] = official.map((o) => {
    const i = existing.findIndex((e, idx) => !matched.has(idx) && normLabel(e.label) === normLabel(o.label));
    if (i < 0) return { ...o };
    matched.add(i);
    return { ...existing[i], ...o };
  });
  return out;
}

export interface MergeOutcome {
  history: CareerHistory;
  /** "added" — no race on that date; "updated" — the existing race on that date took the official result. */
  action: "added" | "updated";
  race: Race;
}

/**
 * Upsert the race into the history by DATE (one race per day is this athlete's reality, and it is how
 * the spec-07 review joins too). An existing race on that date keeps its event/location/type unless the
 * import gives new ones, keeps its FIT-derived HR/power/distance, and takes the official time, position
 * and leg times. A missing/empty history becomes one holding just this race.
 */
export function mergeRaceIntoHistory(history: CareerHistory | null, incoming: Race): MergeOutcome {
  const base: CareerHistory = history ?? { races: [], bests: [] };
  const races = base.races.map((r) => ({ ...r }));
  const idx = races.findIndex((r) => r.date === incoming.date);
  if (idx < 0) {
    const race = { ...incoming };
    races.push(race);
    races.sort((a, b) => a.date.localeCompare(b.date));
    return { history: { ...base, races }, action: "added", race };
  }
  const prev = races[idx];
  const prevResult = prev.result ?? {};
  const result: RaceResult = {
    ...prevResult,
    time: incoming.result?.time ?? prevResult.time,
    splits: mergeSplits(prevResult.splits, incoming.result?.splits ?? []),
  };
  if (!result.splits) delete result.splits;
  const race: Race = {
    ...prev,
    sport: incoming.sport ?? prev.sport,
    type: incoming.type || prev.type,
    event: incoming.event ?? prev.event,
    location: incoming.location ?? prev.location,
    confidence: incoming.location ? "confirmed" : prev.confidence,
    source: prev.source ? (prev.source.includes("official") ? prev.source : `${prev.source}+official`) : "official",
    position: incoming.position ?? prev.position,
    result,
  };
  races[idx] = race;
  return { history: { ...base, races }, action: "updated", race };
}

/** Console summary for the CLI — what was read and what was written. */
export function formatImport(parsed: OfficialResult, outcome: MergeOutcome, path: string, dryRun: boolean): string[] {
  const r = outcome.race;
  const lines: string[] = [];
  lines.push(`${dryRun ? "Would write" : outcome.action === "added" ? "Added" : "Updated"} ${r.event ?? r.type} (${r.date}) ${dryRun || outcome.action === "added" ? "to" : "in"} ${path}`);
  lines.push(`  official time ${r.result?.time}${parsed.timeRaw !== r.result?.time ? ` (page: ${parsed.timeRaw}, rounded to the second)` : ""}`);
  if (r.position) lines.push(`  position      ${r.position}`);
  const meta = [parsed.category && `category ${parsed.category}`, parsed.raceNo && `race no ${parsed.raceNo}`, parsed.team && `team ${parsed.team}`, parsed.finishStatus && parsed.finishStatus].filter(Boolean);
  if (meta.length) lines.push(`  page also said ${meta.join(" · ")} (not stored)`);
  if (r.result?.splits?.length) {
    lines.push("  splits:");
    for (const s of r.result.splits) lines.push(`    ${s.label.padEnd(5)} ${s.time ?? "—"}${s.hr != null ? `  ${s.hr} bpm` : ""}${s.watts != null ? `  ${s.watts} W` : ""}`);
  }
  if (!dryRun) lines.push("  The dashboard's next render judges the frozen pre-race prediction against this (Model track record).");
  return lines;
}
