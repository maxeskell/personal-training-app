import type { InsightReport } from "../insights/engine.js";
import { findingKey } from "../insights/metrics.js";
import { selectMarginalGains } from "../insights/marginalGains.js";
import { categorize, isPlanEdit, CATEGORY_LABEL, type ActionCategory } from "./weeklyActions.js";
import type { Profile } from "../profile/schema.js";
import { PROFILE_QUESTIONS, WAYS_TO_ANSWER, type ProfileQuestion } from "../profile/questions.js";
import type { InsightReaction } from "../state/decisionLog.js";
import { escapeHtml, asOf, ageDaysFrom } from "./dashboardHelpers.js";

/**
 * The "Set up & improve" subsystem (issue #112): the dashboard's deterministic, LLM-free action hub.
 * Builds + renders the grouped, deduped, capped list of actionable items (AI-Endurance gaps, open items,
 * profile questions, marginal gains, the latest weekly review's actions, the latest research digest) and
 * the research-digest parsing the IO loaders feed it. All pure — no card re-runs an LLM flow.
 */

// Friendly copy for the recognised `ai_endurance_todo` keys; unknown keys fall back to a title-cased
// label and (for status tokens) a generic note, so a new key still renders sensibly.
const AIE_TODO_LABELS: Record<string, string> = {
  swim_css: "Set your swim CSS",
  ftp_w: "Resolve your cycling FTP",
};
const AIE_TODO_WHY: Record<string, string> = {
  swim_css: "without it there's no swim model for your races — the highest-value fix for a triathlete",
  ftp_w: "your power sources disagree, so bike zones and race predictions stay uncertain until reconciled",
};
const AIE_TODO_STATUS = new Set(["not_set", "unresolved", "todo", "missing", "none", "pending", "unset"]);

// Self-serve "how to do it" for the recognised AIE gaps (shown in the item's dropdown); unknown keys
// fall back to the generic line.
const AIE_TODO_ACTION: Record<string, string> = {
  swim_css:
    "In AI Endurance: Profile → Thresholds → set your swim CSS (critical swim speed — pace per 100m from a recent CSS test, or estimate it from a 400m + 200m time-trial). It syncs back on the next ↻ Sync and unlocks the swim model + race splits.",
  ftp_w:
    "In AI Endurance: reconcile your cycling FTP (Settings → Thresholds) so the auto-detected and test-based figures agree — the coach uses that one number for bike zones and race predictions. ↻ Sync afterwards.",
};
const AIE_TODO_ACTION_FALLBACK = "Set this directly in AI Endurance, then hit ↻ Sync so the coach reads the new value.";

// Self-serve action copy for the non-AIE sources (shown in each item's dropdown).
const OPEN_ITEM_ACTION =
  "A free-text note you (or the coach) logged. Do it, then clear it — remove the line from `open_items` in profile.local.yaml, or ask Claude to update your profile.";
// Helper line under a training plan-edit card, shown before/instead of an auto-drafted change: plain
// English first, the where-to-do-it spelled out. No "open the report" — the reasoning is on the card.
const TRAINING_MANUAL_HINT =
  "Hit “Make this change” to apply it to your plan in AI Endurance (you’ll confirm the exact edit first). If it can’t be tied to a scheduled session, you’ll get the precise steps to make it yourself in AI Endurance or Garmin.";
/**
 * The dropdown copy for ONE research-digest item — answering the four questions the old generic blurb
 * didn't: what the research IS (its kind), what it actually SAYS (the proposed prior), its SOURCE, and —
 * with the REAL digest file name, never a `<file>` placeholder — the two concrete things to DO (ask the
 * coach, or approve it into the priors). Honest framing throughout: a prior to weigh, not a verdict.
 */
function researchItemAction(t: ResearchTopic, file: string): string {
  const lines: string[] = [];
  if (t.summary) lines.push(`What it says: ${t.summary}`);
  const kindLine =
    t.kind === "new" ? "Flagged NEW since the coach's priors were last refreshed."
      : t.kind === "change" ? "Flagged as a CHANGE to a prior the coach already holds."
        : t.kind === "confirms" ? "CONFIRMS a prior the coach already holds."
          : "";
  if (kindLine) lines.push(kindLine);
  if (t.source) lines.push(`Source: ${t.source}`);
  lines.push("A prior to weigh, not a verdict — your own n=1 data outranks the textbook.");
  lines.push(`What to do: ask the coach what it means for your training, or fold it into the coach's priors with \`npm run knowledge -- approve ${file}\`.`);
  return lines.join("\n");
}

/** Dropdown copy for the fallback pointer (a digest exists but no items parsed out of it cleanly). */
function researchDigestPointerAction(file: string): string {
  return [
    "Your latest monthly research digest is ready — open it with “Read the full digest” below.",
    "It proposes updates to the coach's sports-science priors from recent training, triathlon and gear research.",
    "A prior to weigh, not a verdict — your own n=1 data outranks the textbook.",
    `What to do: read it, ask the coach what any item means for you, or fold it in with \`npm run knowledge -- approve ${file}\`.`,
  ].join("\n");
}

/** The links shown under a research item: always the in-app full-digest view, plus the item's own source
 *  URL when the digest gave one. Only `/`-relative + http(s) hrefs (rendered safely — see setupLinkHtml). */
function researchLinks(t: ResearchTopic): SetupLink[] {
  const links: SetupLink[] = [{ label: "Read the full digest", href: "/digest" }];
  if (t.link && /^https?:\/\//i.test(t.link)) links.push({ label: t.source ? `Source: ${t.source.slice(0, 48)}` : "Open the source", href: t.link });
  return links;
}
/** Proposed action for an unfilled profile question: the field + the canonical three ways to answer. */
function questionAction(q: ProfileQuestion): string {
  return `Fills \`${q.field}\` in your profile. Three ways:\n• ${WAYS_TO_ANSWER.join("\n• ")}`;
}

/**
 * `ai_endurance_todo` keys that aren't actionable ANYWHERE, so they must never reach the card (issue
 * #112: only surface items you can actually do something about). AI Endurance has no field for per-race
 * target times — they live in `profile.races[].target_time`, which the coach already reads — so a
 * `race_targets` nag would point at a setting that can't be set.
 */
const NON_ACTIONABLE_AIE = new Set(["race_targets"]);

/** Map one `ai_endurance_todo` entry to a display label + a why-it-matters note. A status token
 *  ("not_set"/"unresolved"/…) uses the curated note; any other value is itself the descriptive note. */
export function aieTodoCopy(key: string, value: string): { label: string; why: string } {
  const label = AIE_TODO_LABELS[key] ?? key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const isStatus = AIE_TODO_STATUS.has(value.trim().toLowerCase());
  const why = isStatus ? (AIE_TODO_WHY[key] ?? "needs setting in AI Endurance") : value.trim();
  return { label, why };
}

/** Where an item is actioned — shown as a tag so the source can be trusted/weighted at a glance. */
export type SetupRoute = "in AI Endurance" | "edit profile" | "discuss with coach" | "in your setup" | "your call";

/** The three sections of the card (issue #112). Finish setup first, then time-bound advice. */
export type SetupGroup = "finish_setup" | "this_week" | "worth_considering";

/** Which producer an item came from (used for tagging, dedupe ordering and the dismissal key). */
export type SetupSource = "ai_endurance" | "open_item" | "profile_question" | "tune" | "weekly" | "research" | "health" | "race";

/** A labelled link shown under a setup item's dropdown (currently the research card: the full digest +
 *  the item's source). Only `/`-relative or http(s) hrefs are rendered — see {@link setupLinkHtml}. */
export interface SetupLink {
  label: string;
  href: string;
}

/** One actionable item on the "Set up & improve" card, tagged by its source and where to act on it. */
export interface SetupItem {
  /**
   * Stable per-item key (`setup:<tag>:<id>`) used to persist a dismissal in the SAME decision-log
   * machinery as insight feedback. Derived from the item's IDENTITY (todo key / field / finding key /
   * normalised text), not its display copy, so rewording a `why` doesn't lose a dismissal. The `setup:`
   * namespace keeps these distinct from insight finding keys in the shared log.
   */
  key: string;
  /** Short title / the action. */
  label: string;
  /** One line: why it's worth doing (or, for a free-text open item, empty). */
  why: string;
  /** Which producer surfaced it — used for tagging + dedupe ordering. */
  source: SetupSource;
  /** Which section of the card it belongs to. */
  group: SetupGroup;
  /** Where the athlete actions it. */
  route: SetupRoute;
  /** Self-serve "how to do it" — the concrete proposed action shown in the item's expandable dropdown. */
  action: string;
  /** Ranking weight (higher = surfaces first); the per-group cap keeps the highest-value items. */
  priority: number;
  /**
   * For advice cards (weekly review + marginal gains): the KIND of change, shown as a chip. Drives the
   * plain-English framing; absent for the plain "go do this elsewhere" setup tasks (which stay `<details>`).
   */
  category?: ActionCategory;
  /**
   * Render this as a "your call" card with 👍 Agree / 👎 Disagree / 💤 Snooze (the logged, reversible
   * insight-feedback machinery) instead of a dismiss-only `<details>`. For fuelling/gear/recovery/general.
   */
  reactable?: boolean;
  /**
   * Render a "Make this change" button that drafts the concrete edit through the gated propose→confirm
   * write to AI Endurance (training plan edits only). `rec` is the recommendation text the drafter acts on.
   */
  applyable?: boolean;
  /** The raw recommendation text an applyable card sends to the drafter (data-rec); set with `applyable`. */
  rec?: string;
  /** Optional links rendered in the dropdown (research items: the full digest + the source). */
  links?: SetupLink[];
}

/** Stable dismissal key for a setup item — namespaced (by source tag) so it never collides with an insight key. */
const SOURCE_TAG: Record<SetupSource, string> = {
  ai_endurance: "aie",
  open_item: "open",
  profile_question: "q",
  tune: "tune",
  weekly: "weekly",
  research: "research",
  health: "health",
  race: "race",
};
function setupKey(source: SetupSource, id: string): string {
  return `setup:${SOURCE_TAG[source]}:${id}`;
}

/** Per-group caps keep the hub calm: a handful of setup gaps, a couple of timely nudges. */
const GROUP_CAP: Record<SetupGroup, number> = { finish_setup: 5, this_week: 3, worth_considering: 2 };

/** Persisted-report freshness windows: an item drops once its source report is older than this. */
const WEEKLY_FRESH_DAYS = 10; // weekly review / tune cadence
const RESEARCH_FRESH_DAYS = 45; // monthly research digest

/**
 * Bold leads / headings that are FIELD LABELS in a research digest, not topic names — the digest lists each
 * item as `**Topic**: … / **Proposed prior**: … / **Source**: …`, so the labels are skipped as topics (and
 * a `**Topic**: X` line yields X, not "Topic"). Without this the card showed "Proposed prior" / "Source".
 */
const RESEARCH_LABELS = /^(topic|source|sources|proposed prior|prior|proposed|reviewer notes?|confidence|apply|link|evidence|change|new|confirms?)$/i;
const RESEARCH_KIND = /\((new|change|confirms?)\)/i;
const RESEARCH_URL = /(https?:\/\/[^\s)<>\]]+)/i;

/**
 * One parsed item from a research digest: the topic, plus — where the markdown gives them — the KIND of
 * update (new / change / confirms), a one-line summary of the proposed prior ("what it says"), a source
 * attribution and a link. Everything but `topic` is optional: format drift just yields a thinner item.
 */
export interface ResearchTopic {
  topic: string;
  kind?: "new" | "change" | "confirms";
  summary?: string;
  source?: string;
  link?: string;
}

function researchKind(raw: string | undefined): ResearchTopic["kind"] | undefined {
  const k = raw?.toLowerCase() ?? "";
  return k.startsWith("confirm") ? "confirms" : k === "new" ? "new" : k === "change" ? "change" : undefined;
}
/** Drop a "(NEW|CHANGE|CONFIRMS)" qualifier + tidy surrounding punctuation from a topic / heading. */
function cleanTopic(s: string): string {
  return s.replace(RESEARCH_KIND, "").replace(/^[\s:–-]+|[\s:.]+$/g, "").trim();
}
/** A proposed-prior sentence: drop a leading kind qualifier + bullet punctuation, keep the text. */
function cleanSummary(s: string): string {
  return s.replace(RESEARCH_KIND, "").replace(/^[\s:–-]+/, "").trim();
}
/** A source attribution with any trailing URL stripped (the URL is captured separately as the link). */
function cleanSource(s: string): string {
  return s.replace(RESEARCH_URL, "").replace(/[\s—–-]+$/, "").replace(/[\s.]+$/, "").trim();
}

/**
 * Parse a research-digest markdown into structured items (topic + what-it-says + source + link), grouping a
 * `### Heading` (or a flat `- **Topic** (KIND): …` bullet) with the labelled sub-bullets that follow it
 * (`- **Proposed prior**: …`, `- **Source**: …`). Pure + tolerant: format drift yields thinner items (or
 * none, and the caller falls back to a generic "review the digest" pointer). Deduped by topic, capped.
 */
export function parseResearchItems(markdown: string, limit = 4): ResearchTopic[] {
  const out: ResearchTopic[] = [];
  const seen = new Set<string>();
  let cur: ResearchTopic | null = null;
  const flush = () => {
    if (!cur) return;
    const topic = cleanTopic(cur.topic);
    const key = topic.toLowerCase();
    if (topic && topic.length <= 80 && !RESEARCH_LABELS.test(key) && !seen.has(key)) {
      seen.add(key);
      out.push({ ...cur, topic });
    }
    cur = null;
  };
  const noteUrl = (line: string) => {
    if (cur && !cur.link) {
      const m = line.match(RESEARCH_URL);
      if (m) cur.link = m[1];
    }
  };
  for (const line of markdown.split("\n")) {
    if (out.length >= limit) break;
    const heading = line.match(/^#{2,4}\s+(.*\S)/); // a "### Topic" heading (skip the digest's own H1)
    if (heading && !RESEARCH_LABELS.test(cleanTopic(heading[1]).toLowerCase())) {
      flush();
      cur = { topic: heading[1] };
      const kind = researchKind(heading[1].match(RESEARCH_KIND)?.[1]);
      if (kind) cur.kind = kind;
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s*\*\*(.+?)\*\*\s*(.*)$/); // "- **Lead** rest"
    if (!bullet) {
      noteUrl(line);
      continue;
    }
    const lead = bullet[1].replace(/[:.\s]+$/, "").trim();
    const rest = bullet[2].trim();
    if (RESEARCH_LABELS.test(lead)) {
      const label = lead.toLowerCase();
      const value = rest.replace(/^[:\-–\s]+/, "").trim();
      if (label === "topic") {
        cur ??= { topic: "" };
        cur.topic = value;
        cur.kind = researchKind(value.match(RESEARCH_KIND)?.[1]) ?? cur.kind;
      } else if (/^(proposed prior|prior|proposed|apply)$/.test(label)) {
        if (cur && !cur.summary) cur.summary = cleanSummary(value);
      } else if (label === "source" || label === "sources") {
        if (cur && !cur.source) cur.source = cleanSource(value);
        noteUrl(line);
      } else if (label === "link") {
        if (cur) cur.link = value.match(RESEARCH_URL)?.[1] ?? cur.link;
      }
      continue; // confidence / reviewer notes / evidence → noise, skipped
    }
    // Flat form: the bold lead IS a new topic; the trailing text is its one-line summary.
    flush();
    cur = { topic: lead };
    const kind = researchKind(lead.match(RESEARCH_KIND)?.[1] ?? rest.match(RESEARCH_KIND)?.[1]);
    if (kind) cur.kind = kind;
    const summary = cleanSummary(rest);
    if (summary) cur.summary = summary;
    noteUrl(line);
  }
  flush();
  return out.slice(0, limit);
}

/**
 * Extract the bullet actions under the first heading matching `headingRe` (e.g. the weekly review's
 * "## Next week" section), stripping markdown emphasis. Pure + tolerant: a missing/renamed section just
 * yields fewer (or no) items, so the caller falls back to a "revisit the review" pointer. Deduped, capped.
 */
export function parseActionBullets(markdown: string, headingRe: RegExp, limit = 4): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let inSection = false;
  for (const line of markdown.split("\n")) {
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (heading) {
      inSection = headingRe.test(heading[1]); // entering the matched section ends at the next heading
      continue;
    }
    if (!inSection) continue;
    const m = /^\s*[-*]\s+(.*)$/.exec(line);
    if (!m) continue;
    const text = m[1].replace(/\*\*/g, "").replace(/`/g, "").replace(/[:.]+$/, "").trim();
    const k = text.toLowerCase();
    if (!text || seen.has(k)) continue;
    seen.add(k);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Per-source ranking weights (higher = surfaces first) so the ~5 cap keeps the highest-VALUE items, not
 * just the first ones in catalogue order. AI-Endurance gaps block a whole discipline model / zones, and
 * open items are actions the athlete explicitly flagged, so both outrank profile questions; among
 * questions, a field the coach actually READS beats a reference-only one (so "what's your height?" never
 * crowds out a real gap).
 */
const SETUP_PRIORITY = { health: 90, race: 80, ai_endurance: 100, open_item: 70, question_coach: 50, question_reference: 20, health_low: 60, tune: 60, weekly: 40, research: 30 } as const;

/**
 * A profile question is "reference-only" (lower priority) when its `why` follows the questions.ts honesty
 * convention for fields no flow reads yet — "for your reference", "for future use", "not yet read…". This
 * only nudges ORDERING, so a reworded `why` at worst mis-ranks an item; it never breaks the card.
 */
const REFERENCE_ONLY_WHY = /for (your )?reference|for future use|not (yet )?read|not (yet )?pulled into/i;

function questionPriority(q: ProfileQuestion): number {
  return REFERENCE_ONLY_WHY.test(q.why) ? SETUP_PRIORITY.question_reference : SETUP_PRIORITY.question_coach;
}

/** Treat null / blank string / empty collection as "not filled in" when scanning for open questions. */
function isBlank(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length === 0;
  return false;
}

/** Resolve a dot-path (e.g. "health.medication.dose_day") against the profile; undefined if absent. */
function valueAtPath(obj: unknown, dotPath: string): unknown {
  let cur: unknown = obj;
  for (const part of dotPath.split(".")) {
    if (cur && typeof cur === "object" && !Array.isArray(cur)) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

/** Normalised key for dedup — collapses case/punctuation so a restated item doesn't show twice. */
function dedupeKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * The unmissable training-setup topics that get restated under different wording (an `ai_endurance_todo`
 * gap AND a hand-written `open_item` describing the same gap). Verbatim dedupe misses them because the
 * copy differs ("Set your swim CSS" vs "Swim CSS not set in AI Endurance: …"), so within Finish-setup we
 * also fold by topic: CSS and FTP are unambiguous in this domain, so any two items naming the same one
 * collapse to the highest-value phrasing (AIE gap sorts first → it wins). Scoped to these two on purpose.
 */
const SETUP_TOPIC_PATTERNS: Array<[RegExp, string]> = [
  [/\bswim\s*css\b|\bcss\b/i, "swim-css"],
  [/\bftp\b/i, "ftp"],
];
function setupTopic(label: string): string | null {
  for (const [re, topic] of SETUP_TOPIC_PATTERNS) if (re.test(label)) return topic;
  return null;
}

/** Options for {@link buildSetupItems} / {@link renderSetupImprove}. */
export interface SetupOptions {
  /** Profile-question catalogue (defaults to the real one; injectable for tests). */
  questions?: ProfileQuestion[];
  /** Item keys the athlete dismissed (snoozed) within the cool-off window — dropped before the cap. */
  suppressed?: Set<string>;
  /** Saved agree/disagree per key — so a "your call" advice card shows its persisted reaction state. */
  reactions?: Map<string, InsightReaction>;
  /** Already-built insight report — its deterministic marginal-gains feed the "This week" group (no LLM). */
  insights?: InsightReport;
  /** Finding keys already shown in the Top-insights box — excluded from "This week" so a recommendation
   *  the athlete has already seen (and can react to) above isn't restated here. */
  surfacedInsightKeys?: Set<string>;
  /** Latest persisted weekly review (date + the parsed "## Next week" action bullets); drops when stale. */
  weeklyReview?: { date: string; actions: string[] };
  /** Latest research digest (date + file + parsed items) for the "Worth considering" group (drops when stale). */
  researchDigest?: { date: string; file: string; items: ResearchTopic[] };
  /** Tool/integration health signals (computed in the IO layer) → operational "Finish setup" nudges. */
  setupHealth?: { lastSyncAgeHours?: number; hasApiKey?: boolean; waterTempSet?: boolean };
  /** Clock for staleness (defaults to Date.now()). */
  now?: number;
}

/** Display order + dedupe precedence for the three groups (finish setup wins a cross-group duplicate). */
const GROUP_ORDER: Record<SetupGroup, number> = { finish_setup: 0, this_week: 1, worth_considering: 2 };

/**
 * Build the grouped, deduped, capped list of "Set up & improve" items — NO LLM, all from data the
 * dashboard already loads or has persisted (issue #112). Sources, each tagged + routed:
 *   • Finish setup      ← `ai_endurance_todo` gaps · `open_items` · unfilled profile questions.
 *   • This week         ← the deterministic marginal-gains selection (the `tune` flow's LLM-free core,
 *                          computed live so it's always current) + a pointer to a recent weekly review.
 *   • Worth considering ← the last persisted research digest's topics (read-only; never re-run live).
 * Time-bound items (weekly/research) carry an "as of …" tag and drop once their report goes stale.
 * Dismissed items (snoozed via the shared insight-feedback machinery) are dropped first; the rest are
 * ranked, deduped across sources (finish-setup wins), and capped per group so the card stays calm. Pure.
 */
export function buildSetupItems(profile: Profile | undefined, opts: SetupOptions = {}): SetupItem[] {
  if (!profile) return [];
  const questions = opts.questions ?? PROFILE_QUESTIONS;
  const suppressed = opts.suppressed ?? new Set<string>();
  const now = opts.now ?? Date.now();
  const items: SetupItem[] = [];

  // --- Finish setup ---------------------------------------------------------------------------------
  // 1) Actionable AI-Endurance gaps (skip resolved/blank values and the non-actionable keys).
  for (const [key, value] of Object.entries(profile.ai_endurance_todo ?? {})) {
    if (NON_ACTIONABLE_AIE.has(key)) continue;
    const v = value == null ? "" : String(value).trim();
    if (v === "" || v.toLowerCase() === "resolved") continue;
    const { label, why } = aieTodoCopy(key, v);
    items.push({ key: setupKey("ai_endurance", key), label, why, source: "ai_endurance", group: "finish_setup", route: "in AI Endurance", action: AIE_TODO_ACTION[key] ?? AIE_TODO_ACTION_FALLBACK, priority: SETUP_PRIORITY.ai_endurance });
  }
  // 2) Free-text open items (a running list of unresolved actions) → raise them with the coach.
  for (const raw of profile.open_items ?? []) {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) continue;
    items.push({ key: setupKey("open_item", dedupeKey(text)), label: text, why: "", source: "open_item", group: "finish_setup", route: "discuss with coach", action: OPEN_ITEM_ACTION, priority: SETUP_PRIORITY.open_item });
  }
  // 3) Unfilled optional profile questions → fill them in (or tell Claude via update_profile).
  for (const q of questions) {
    if (!isBlank(valueAtPath(profile, q.field))) continue;
    items.push({ key: setupKey("profile_question", q.field), label: `Answer: ${q.question}`, why: q.why, source: "profile_question", group: "finish_setup", route: "edit profile", action: questionAction(q), priority: questionPriority(q) });
  }
  // 4) Tool/integration health (operational nudges) — things that block the app doing its best work.
  const h = opts.setupHealth;
  if (h?.hasApiKey === false) {
    items.push({ key: setupKey("health", "apikey"), label: "Add your ANTHROPIC_API_KEY", why: "unlocks the AI write-ups — readiness, weekly, ask and session feedback", source: "health", group: "finish_setup", route: "in your setup", action: "Add `ANTHROPIC_API_KEY=sk-ant-…` to your .env, then redeploy with `npm run update`. The dashboard, zones and health checks already work without it; this turns on the AI write-ups (readiness, weekly, ask, session feedback).", priority: SETUP_PRIORITY.health });
  }
  if (h?.lastSyncAgeHours != null && h.lastSyncAgeHours >= 72) {
    items.push({ key: setupKey("health", "sync"), label: "Sync your training data", why: `last synced ${Math.round(h.lastSyncAgeHours / 24)}d ago — the cards are reading stale data`, source: "health", group: "finish_setup", route: "in your setup", action: "Hit ↻ Sync at the top of the dashboard (it also auto-syncs when the snapshot goes stale). If it keeps failing, refresh your AI Endurance / Garmin auth with `npm run auth:aie`.", priority: SETUP_PRIORITY.health });
  }
  if (h?.waterTempSet === false) {
    items.push({ key: setupKey("health", "watertemp"), label: "Set your open-water temperature", why: "COACH_WATER_TEMP_C has no public feed — set it when the venue posts a reading", source: "health", group: "finish_setup", route: "in your setup", action: "Set `COACH_WATER_TEMP_C=<°C>` in .env and redeploy (`npm run update`). There's no public feed for open-water temperature, so update it whenever your venue posts a reading — it gates open-water-swim advice.", priority: SETUP_PRIORITY.health_low });
  }
  // 5) Incomplete race entries — a named race with no date can't drive the countdown/taper/race-day plan.
  for (const r of (profile.races ?? []).slice(0, 4)) {
    const name = typeof r?.name === "string" ? r.name.trim() : "";
    if (!name || r?.date) continue;
    items.push({ key: setupKey("race", dedupeKey(name)), label: `Add the date for ${name}`, why: "so the countdown, periodisation and race-day plan line up", source: "race", group: "finish_setup", route: "edit profile", action: `Add a \`date: YYYY-MM-DD\` (and ideally \`distance\` + \`priority\`) to "${name}" under \`races:\` in profile.local.yaml — or ask Claude. It drives the countdown, the periodisation/taper shape and the race-day split plan.`, priority: SETUP_PRIORITY.race });
  }

  // --- This week (Phase 2: marginal gains + last weekly review's actions, read-only/LLM-free) --------
  // Skip any gain already surfaced in the Top-insights box above — it's shown (and reactable) there, so
  // restating its recommendation here is the dedupe the dashboard most needs. Select a few extra (the
  // per-group cap trims later) so a filtered-out one frees its slot for the next-best gain.
  // Each "This week" item is an in-app "your call" card: lead with the plain-English action, the tech detail
  // sits muted underneath, and the buttons ARE the call to action. Fuelling/gear/recovery/general get
  // agree/disagree/snooze; a training PLAN edit gets "Make this change" (the gated propose→confirm write).
  if (opts.insights) {
    const surfaced = opts.surfacedInsightKeys ?? new Set<string>();
    for (const f of selectMarginalGains(opts.insights)) {
      if (surfaced.has(findingKey(f))) continue;
      const action = `${f.detail}${f.evidence ? ` (${f.evidence})` : ""}`;
      // Marginal gains are execution cues, not schedule edits → always agree/disagree/snooze.
      items.push({ key: setupKey("tune", findingKey(f)), label: f.recommendation ?? f.title, why: f.title, source: "tune", group: "this_week", route: "your call", action, priority: SETUP_PRIORITY.tune, category: categorize(`${f.family} ${f.title} ${f.recommendation ?? ""}`), reactable: true });
    }
  }
  if (opts.weeklyReview) {
    const age = ageDaysFrom(opts.weeklyReview.date, now);
    if (age != null && age <= WEEKLY_FRESH_DAYS) {
      // The weekly review's own "Next week" actions, each typed + given the right in-app interaction.
      // No items → nothing to show (no "revisit the report" pointer; the reasoning lives on the cards).
      for (const a of opts.weeklyReview.actions.slice(0, GROUP_CAP.this_week)) {
        const category = categorize(a);
        const planEdit = isPlanEdit(a);
        items.push({
          key: setupKey("weekly", dedupeKey(a)),
          label: a,
          why: `from this week’s review — ${asOf(age)}`,
          source: "weekly",
          group: "this_week",
          route: "your call",
          action: planEdit ? TRAINING_MANUAL_HINT : "",
          priority: SETUP_PRIORITY.weekly,
          category,
          reactable: !planEdit, // a plan edit applies; everything else is agree/disagree/snooze
          applyable: planEdit,
          rec: planEdit ? a : undefined,
        });
      }
    }
  }

  // --- Worth considering (Phase 3: last research digest, read-only/LLM-free) ------------------------
  if (opts.researchDigest) {
    const age = ageDaysFrom(opts.researchDigest.date, now);
    if (age != null && age <= RESEARCH_FRESH_DAYS) {
      const { file } = opts.researchDigest;
      const topics = opts.researchDigest.items.slice(0, GROUP_CAP.worth_considering);
      if (topics.length) {
        for (const t of topics) {
          items.push({ key: setupKey("research", dedupeKey(t.topic)), label: t.topic, why: `from the research digest — ${asOf(age)}`, source: "research", group: "worth_considering", route: "discuss with coach", action: researchItemAction(t, file), links: researchLinks(t), priority: SETUP_PRIORITY.research });
        }
      } else {
        items.push({ key: setupKey("research", "digest"), label: "Review the latest research digest", why: asOf(age), source: "research", group: "worth_considering", route: "discuss with coach", action: researchDigestPointerAction(file), links: [{ label: "Read the full digest", href: "/digest" }], priority: SETUP_PRIORITY.research });
      }
    }
  }

  // Drop dismissed items, then order by group → priority → insertion (stable). Dedupe across sources
  // (finish-setup sorts first, so it wins a cross-group restatement), and cap PER GROUP — filtering
  // before the cap means a dismissal lets the next-best item in that group take the freed slot.
  const ranked = items
    .filter((item) => !suppressed.has(item.key))
    .map((item, i) => ({ item, i }))
    .sort((a, b) => GROUP_ORDER[a.item.group] - GROUP_ORDER[b.item.group] || b.item.priority - a.item.priority || a.i - b.i)
    .map((d) => d.item);
  const seen = new Set<string>();
  const seenTopics = new Set<string>(); // CSS/FTP folding, Finish-setup only (see SETUP_TOPIC_PATTERNS)
  const perGroup: Record<SetupGroup, number> = { finish_setup: 0, this_week: 0, worth_considering: 0 };
  const out: SetupItem[] = [];
  for (const item of ranked) {
    const k = dedupeKey(item.label);
    if (seen.has(k)) continue;
    const topic = item.group === "finish_setup" ? setupTopic(item.label) : null;
    if (topic && seenTopics.has(topic)) continue; // a restatement of an already-listed setup gap
    seen.add(k);
    if (topic) seenTopics.add(topic);
    if (perGroup[item.group] >= GROUP_CAP[item.group]) continue;
    perGroup[item.group] += 1;
    out.push(item);
  }
  return out;
}

/** Human heading per group (only shown when more than one group is present). */
const GROUP_HEADING: Record<SetupGroup, string> = {
  finish_setup: "Finish setup",
  this_week: "This week",
  worth_considering: "Worth considering",
};

/** Small category chip (Training / Fuelling / Gear / …) shown on a "your call" advice card. */
function categoryChip(c: ActionCategory | undefined): string {
  return c ? `<span class="cat cat-${c}">${escapeHtml(CATEGORY_LABEL[c])}</span> ` : "";
}

/** The saved-reaction "state" + button-highlight class for a keyed card (mirrors renderInsightsBox). */
function reactionState(key: string, reactions?: Map<string, InsightReaction>): { state: string; reacted: string } {
  const saved = reactions?.get(key); // "agree" | "disagree" — snoozed items are filtered out before render
  const state = saved === "agree" ? "like" : saved === "disagree" ? "dislike" : "";
  const reacted = state === "like" ? "👍 agreed" : state === "dislike" ? "👎 disagreed (still shown)" : "";
  return { state, reacted };
}

/**
 * A "your call" advice card (fuelling / gear / recovery / general): plain-English action first, the tech
 * detail muted underneath, then 👍 Agree / 👎 Disagree / 💤 Snooze — the same logged, reversible
 * insight-feedback machinery the Top-insights box uses (so a reaction here is read by the listening model).
 */
function reactableCardHtml(it: SetupItem, reactions?: Map<string, InsightReaction>): string {
  const { state, reacted } = reactionState(it.key, reactions);
  const on = (which: string) => (state === which ? " on" : "");
  const why = it.why ? `<div class="age">${escapeHtml(it.why)}</div>` : "";
  const detail = it.action ? `<div class="ev">${escapeHtml(it.action)}</div>` : "";
  return `<div class="insight" data-key="${escapeHtml(it.key)}" data-summary="${escapeHtml(it.label)}" data-reaction-state="${state}">
    <div>${categoryChip(it.category)}<b>${escapeHtml(it.label)}</b></div>
    ${detail}${why}
    <div class="acts">
      <button class="agree${on("like")}" data-reaction="like" onclick="feedback(this)">👍 Agree</button>
      <button class="disagree${on("dislike")}" data-reaction="dislike" onclick="feedback(this)">👎 Disagree</button>
      <button class="ignore" data-reaction="snooze" onclick="feedback(this)">💤 Snooze</button>
      <span class="reacted">${reacted}</span>
    </div>
  </div>`;
}

/**
 * An applyable training card: "Make this change" drafts the concrete plan edit through the gated
 * propose→confirm write to AI Endurance (you confirm the exact edit), rendered inline. When it can't be
 * tied to a scheduled session, the drafter returns the precise manual steps instead. Plus 💤 Snooze.
 */
function applyableCardHtml(it: SetupItem): string {
  const why = it.why ? `<div class="age">${escapeHtml(it.why)}</div>` : "";
  const hint = it.action ? `<div class="ev">${escapeHtml(it.action)}</div>` : "";
  return `<div class="insight" data-key="${escapeHtml(it.key)}" data-summary="${escapeHtml(it.label)}" data-rec="${escapeHtml(it.rec ?? it.label)}">
    <div>${categoryChip(it.category)}<b>${escapeHtml(it.label)}</b></div>
    ${hint}${why}
    <div class="item-proposals"></div>
    <div class="acts">
      <button class="agree" onclick="actItem(this)">➡️ Make this change</button>
      <button class="ignore" data-reaction="snooze" onclick="feedback(this)">💤 Snooze</button>
      <span class="reacted"></span>
    </div>
  </div>`;
}

/**
 * One expandable `<details>` for a plain setup TASK (an AI-Endurance gap, a profile question, a config
 * nudge): the summary line (label · why · route tag · dismiss ✕), and — on expand — the **proposed
 * action** (self-serve "how to do it"). The ✕ carries the stable key and stops propagation so a dismiss
 * click doesn't toggle the dropdown.
 */
function setupTaskHtml(it: SetupItem): string {
  const note = it.why ? ` — <span class="muted">${escapeHtml(it.why)}</span>` : "";
  const body = it.action ? `<div class="setup-action">${escapeHtml(it.action)}</div>` : "";
  const links = it.links?.length ? `<div class="setup-links">${it.links.map(setupLinkHtml).join("")}</div>` : "";
  return `<details class="setup-item" data-key="${escapeHtml(it.key)}" data-summary="${escapeHtml(it.label)}"><summary><strong>${escapeHtml(it.label)}</strong>${note} <span class="route">${escapeHtml(it.route)}</span> <button class="dismiss" title="Dismiss — hide this for ~2 weeks" onclick="event.stopPropagation();dismissSetup(this)">✕</button></summary>${body}${links}</details>`;
}

/** One safe anchor in a setup item's dropdown. Only renders `/`-relative (in-app) or http(s) hrefs — an
 *  external link opens in a new tab with `noopener`; anything else is dropped (the escaping convention). */
function setupLinkHtml(l: SetupLink): string {
  const external = /^https?:\/\//i.test(l.href);
  if (!external && !l.href.startsWith("/")) return "";
  const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
  return `<a class="setup-link" href="${escapeHtml(l.href)}"${attrs}>${escapeHtml(l.label)} →</a>`;
}

/** Dispatch a setup item to the right surface: an applyable training card, a "your call" reaction card, or
 *  the plain `<details>` task. */
function setupItemHtml(it: SetupItem, reactions?: Map<string, InsightReaction>): string {
  if (it.applyable) return applyableCardHtml(it);
  if (it.reactable) return reactableCardHtml(it, reactions);
  return setupTaskHtml(it);
}

const setupListHtml = (its: SetupItem[], reactions?: Map<string, InsightReaction>): string =>
  `<div class="setup">${its.map((it) => setupItemHtml(it, reactions)).join("")}</div>`;

/**
 * "Set up & improve" — the dashboard's deterministic, LLM-free action hub (issue #112). Three sections:
 * **Finish setup** (AI-Endurance gaps · open items · unfilled profile questions) renders as plain
 * `<details>` tasks; **This week** (the marginal-gains selection + the latest weekly review's "Next week"
 * actions) and **Worth considering** (research) render as in-app "your call" cards — agree/disagree/snooze
 * on fuelling/gear/recovery, and a gated "Make this change" on a training plan edit. Nothing points the
 * athlete at a saved report. The time-bound groups READ persisted reports (never re-run the LLM flows) and
 * carry an "as of …" tag. Each item is dismissable/snoozable via the same insight-feedback machinery, so it
 * stays gone ~2wk — a calm hub, not a nag. The group headings only appear when more than one section is
 * present. Omitted in share/screenshot mode and whenever there's nothing outstanding.
 */
export function renderSetupImprove(profile: Profile | undefined, share = false, opts: SetupOptions = {}): string {
  if (share) return "";
  const items = buildSetupItems(profile, opts);
  if (!items.length) return "";
  const groups: SetupGroup[] = ["finish_setup", "this_week", "worth_considering"];
  const present = groups.filter((g) => items.some((it) => it.group === g));
  const reactions = opts.reactions;
  const body =
    present.length <= 1
      ? setupListHtml(items, reactions)
      : present.map((g) => `<h3 class="setup-group">${GROUP_HEADING[g]}</h3>${setupListHtml(items.filter((it) => it.group === g), reactions)}`).join("");
  return `<div class="card"><h2>Set up &amp; improve</h2>
  <div class="k" style="margin-bottom:6px">What to do next — all actioned right here. <b>This week</b> cards are your call: 👍 Agree / 👎 Disagree / 💤 Snooze on fuelling, gear and recovery; a training change has <b>Make this change</b> (applies it in AI Endurance after you confirm the exact edit, or hands you the precise steps). <b>Finish setup</b> tasks open for exactly how to do them.</div>
  ${body}</div>`;
}
