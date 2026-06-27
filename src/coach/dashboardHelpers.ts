import type { Tone } from "../insights/headline.js";
import { escapeHtml } from "../util/html.js";

/**
 * Shared pure render/format primitives for the dashboard cards — the small format helpers used by ≥2
 * cards (sparklines, time/date formatting, freshness tags, the escaped-markdown renderer). Re-exports
 * {@link escapeHtml} so cards import it from one place. No card logic lives here — see dashboard.ts.
 */

export { escapeHtml };

export const TONE_COLOR: Record<Tone, string> = { good: "#1a8a3a", neutral: "#777", warn: "#c98a00", bad: "#c0392b" };

/**
 * A Decide-inbox item is "new" until you've done something with it (👍/👎/💤/✓/📌). We key newness off the
 * reaction map the cards already carry: a RENDERED item with no reaction is one you haven't triaged — the
 * snoozed/dismissed/done items are filtered out before render, so a present-but-reacted key means like /
 * dislike / pin (you dealt with it). Untyped on the value so callers needn't import the reaction enum. Pure.
 */
export function isDecideItemNew(key: string, reactions?: ReadonlyMap<string, unknown>): boolean {
  return !reactions?.has(key);
}

/** The "NEW" pill for an un-actioned Decide item (empty string once it's been reacted to). Pure. */
export function newBadge(key: string, reactions?: ReadonlyMap<string, unknown>): string {
  return isDecideItemNew(key, reactions) ? `<span class="newbadge">NEW</span>` : "";
}

export function daysTo(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${String(toIso).slice(0, 10)}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** Inline SVG sparkline from a numeric series (nulls skipped). */
export function spark(values: Array<number | null | undefined>, w = 140, h = 30): string {
  const pts = values.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
  const real = pts.filter((v): v is number => v != null);
  if (real.length < 2) return `<span class="muted">—</span>`;
  const min = Math.min(...real);
  const max = Math.max(...real);
  const span = max - min || 1;
  const n = pts.length;
  const coords = pts
    .map((v, i) => (v == null ? null : `${(i / (n - 1)) * w},${h - ((v - min) / span) * h}`))
    .filter((c): c is string => c != null);
  const last = real[real.length - 1];
  const first = real[0];
  const dir = last > first ? "up" : last < first ? "down" : "flat";
  return `<svg width="${w}" height="${h}" class="spark ${dir}"><polyline points="${coords.join(" ")}" fill="none" stroke-width="2"/></svg>`;
}

/**
 * Minimal, escape-FIRST markdown → HTML for stored feedback rendered server-side (mirrors the client
 * `mdToHtml`): headers, bold, inline code, bullets. Everything is escaped before any formatting, so
 * injected markup can't break out (dashboard escaping convention). Pure.
 */
export function mdLite(md: string): string {
  let h = escapeHtml(md);
  h = h.replace(/^#{1,3} (.*)$/gm, '<b style="font-size:15px">$1</b>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  h = h.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  h = h.replace(/^- /gm, "• ");
  return h;
}

/**
 * Generic race words that are NOT identifying on their own — never redacted as a standalone token, so a
 * race called "Birmingham Marathon" doesn't blank the word "marathon" everywhere else on the page. The
 * distinctive part (the city/venue) still goes.
 */
const RACE_WORD_STOP = new Set([
  "triathlon", "ironman", "duathlon", "aquathlon", "aquabike", "marathon", "half", "full", "sprint",
  "olympic", "standard", "middle", "long", "short", "super", "distance", "race", "races", "series",
  "challenge", "classic", "festival", "national", "international", "championship", "championships",
  "open", "water", "swim", "bike", "ride", "run", "running", "cycling", "the", "and", "of", "at",
  "city", "park", "lake", "reservoir", "trail", "relay", "grand", "prix",
]);

function raceTokenRegex(token: string): RegExp {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${esc}\\b`, "gi");
}

/**
 * Share view: scrub real race names out of free-text coaching output, replacing each with the neutral
 * "Race N" label the cards already use. The structured race cards redact by swapping `event_name` for
 * "Race N", but free text — the deep session feedback, an insight title like "Birmingham: behind target",
 * the headline — is generated prose, and the LLM (and some findings) refer to a race by a single
 * distinctive word, its city/venue. So we redact both the full event name AND each distinctive token,
 * longest match first. `names` MUST be in the dashboard's canonical date-sorted order (index i → "Race i+1")
 * so the redaction is consistent with the cards. No-op when `names` is empty (i.e. not sharing), so the
 * normal page is byte-for-byte unchanged. Pure.
 */
export function redactRaceNames(text: string, names: string[]): string {
  if (!text || !names.length) return text;
  const subs: Array<{ re: RegExp; to: string; len: number }> = [];
  names.forEach((raw, i) => {
    const label = `Race ${i + 1}`;
    const name = (raw ?? "").trim();
    if (!name || name === "—") return;
    subs.push({ re: raceTokenRegex(name), to: label, len: name.length });
    for (const tok of name.split(/[^A-Za-z0-9]+/)) {
      if (tok.length >= 4 && !RACE_WORD_STOP.has(tok.toLowerCase())) {
        subs.push({ re: raceTokenRegex(tok), to: label, len: tok.length });
      }
    }
  });
  // Longest match first: a full multi-word name wins over its own single-word tokens, and a longer
  // distinctive token wins over a shorter one it contains.
  subs.sort((a, b) => b.len - a.len);
  let out = text;
  for (const { re, to } of subs) out = out.replace(re, to);
  return out;
}

/** Wrap bare http(s) URLs in ALREADY-ESCAPED text with anchors. The input has no raw `<` (it's escaped),
 *  so the matched URL can't break out — used by the read-only digest page so sources are one click away. */
export function linkifyEscaped(escaped: string): string {
  return escaped.replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

/** Whole days from a YYYY-MM-DD report date to `now` (negative clamped to 0 for a future-dated file). */
export function ageDaysFrom(date: string, now: number): number | null {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/** "as of today" / "as of 3d ago" — the freshness tag the issue asks every time-bound item to carry. */
export function asOf(ageDays: number): string {
  return ageDays <= 0 ? "as of today" : `as of ${ageDays}d ago`;
}

export const SOURCE_LABEL: Record<string, string> = { "ai-endurance": "AI Endurance", garmin: "Garmin", intervals: "intervals.icu", derived: "derived", manual: "you" };

export function hms(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** Race finish rounded to the nearest minute (a projection isn't second-accurate): "1:38" or "38 min". */
export function clockMin(sec: number): string {
  const totalMin = Math.round(sec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}` : `${m} min`;
}

/** Minutes → "1h 35m" / "45m" (user ask: weekly totals in hours+minutes, not raw minutes). */
export function hMin(totalMin: number): string {
  const t = Math.round(totalMin);
  const h = Math.floor(t / 60);
  const m = t % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** A small status chip (label + value, tone-coloured). */
export function chip(label: string, value: string, tone: Tone = "neutral"): string {
  return `<span style="display:inline-block;background:#f4f1ea;border-left:3px solid ${TONE_COLOR[tone]};border-radius:4px;padding:3px 8px;margin:0 6px 6px 0;font-size:12px"><span class="k">${escapeHtml(label)}</span> <b>${escapeHtml(value)}</b></span>`;
}

/** Weekday/month labels for the readable "last updated" line. */
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Wed 18 Jun 2026, 14:03" (withTime) or "Wed 18 Jun 2026" (date only). Echoes the input if unparseable. */
export function fmtWhen(iso: string, withTime: boolean): string {
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p2 = (n: number) => String(n).padStart(2, "0");
  const date = `${WD[d.getDay()]} ${d.getDate()} ${MO[d.getMonth()]} ${d.getFullYear()}`;
  return withTime ? `${date}, ${p2(d.getHours())}:${p2(d.getMinutes())}` : date;
}

/** Outcome word shown on the "discussed with coach" line, per stored reaction. */
const DISCUSSION_OUTCOME: Record<string, string> = {
  agree: "agreed",
  disagree: "disagreed",
  ignore: "snoozed",
  done: "done",
  dismiss: "ignored",
  applied: "applied",
};

/**
 * One-line "discussed with coach" annotation for a card whose latest reaction was recorded in a coaching
 * chat (Claude Code) rather than a bare dashboard click — so a discussion held off-screen shows up on the
 * display surface. Escaped; returns "" when there's no discussion. `d` is a CoachDiscussion (reaction +
 * timestamp + optional note); typed loosely here so cards needn't import the decision-log type.
 */
export function discussedLineHtml(d: { reaction: string; timestamp: string; note?: string } | undefined): string {
  if (!d) return "";
  const dt = new Date(d.timestamp);
  const when = Number.isNaN(dt.getTime()) ? "" : `${dt.getDate()} ${MO[dt.getMonth()]}`;
  const outcome = DISCUSSION_OUTCOME[d.reaction] ?? escapeHtml(d.reaction);
  const note = d.note ? ` — ${escapeHtml(d.note)}` : "";
  return `<div class="coach-discussed" style="margin:4px 0;font-size:12px;color:#1a8a3a">✓ discussed with coach${when ? ` · ${when}` : ""} · ${outcome}${note}</div>`;
}

/** Human "time since": "2d 3h ago" / "3h 41m ago" / "4m ago" / "just now". `suffix` lets callers reword. */
export function fmtSince(ms: number, suffix = " ago"): string {
  if (ms < 0) return "in the future";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return `just now`;
  const h = Math.floor(min / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d}d ${h % 24}h${suffix}`;
  if (h >= 1) return `${h}h ${min % 60}m${suffix}`;
  return `${min}m${suffix}`;
}

/** A simple number formatter: null/undefined → "—", else fixed to `d` decimals. */
export function fmt(n: number | null | undefined, d = 0): string {
  return n == null ? "—" : n.toFixed(d);
}
