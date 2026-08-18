import { escapeHtml } from "./dashboardHelpers.js";
import { MONTHS, type Profile, type Race, type Supplement } from "../profile/schema.js";

/**
 * "Supplements — what & when" (Plan tab). Deterministic: today's date in the athlete's timezone + the
 * profile race calendar decide which protocol entries are active, which start soon, and which are
 * parked — no LLM on render, no network. The profile is the single source of truth
 * (`profile.local.yaml → supplements:`); an absent/empty list renders NOTHING — the setup nudge rides
 * the profile-questions machinery ("Set up & improve → Finish setup"), not a permanent empty card.
 *
 * Share view: race names and dates are the identifying bits (same rule as the Races card), so race-tied
 * timing lines degrade to "the next race" with no name and no dates. All interpolated text is escaped;
 * the card emits no script and binds no handlers.
 */

const DAY_MS = 86_400_000;

/** How far ahead an out-of-window entry still earns a "Coming up" slot (beyond it, it parks). */
const UPCOMING_HORIZON_DAYS = 60;

export type SupplementBucket = "active" | "upcoming" | "proposed" | "parked";

export interface SupplementView {
  name: string;
  dose?: string;
  /** One plain-words line saying WHEN, computed against today + the race calendar. */
  timing: string;
  evidence?: string;
  why?: string;
  notes?: string;
  bucket: SupplementBucket;
}

/** YYYY-MM-DD "today" in an IANA timezone ("en-CA" formats ISO-style); degrades to UTC on a bad zone. */
export function isoDateInTz(nowMs: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(nowMs));
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10);
  }
}

function parseIsoDay(iso: string | null | undefined): number | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

function daysBetween(fromIso: string, toIso: string): number | null {
  const a = parseIsoDay(fromIso);
  const b = parseIsoDay(toIso);
  return a == null || b == null ? null : Math.round((b - a) / DAY_MS);
}

function shiftDays(iso: string, days: number): string {
  const t = parseIsoDay(iso);
  return t == null ? iso : new Date(t + days * DAY_MS).toISOString().slice(0, 10);
}

const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Thu 3 Sep" — compact near-date display (never used in share view). */
function shortDate(iso: string): string {
  const t = parseIsoDay(iso);
  if (t == null) return iso;
  const d = new Date(t);
  return `${WD_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MO_SHORT[d.getUTCMonth()]}`;
}

function capMonth(m: string): string {
  return m.charAt(0).toUpperCase() + m.slice(1);
}

function monthNameOf(iso: string): string {
  const idx = Number(iso.slice(5, 7)) - 1;
  const m = idx >= 0 && idx < 12 ? MONTHS[idx] : undefined;
  return m ? capMonth(m) : "";
}

/** The next upcoming race (valid YYYY-MM-DD on/after today), or null. */
function nextRace(races: Race[], todayIso: string): { name: string; date: string } | null {
  const upcoming = races
    .map((r) => ({ name: r.name ?? "race", date: String(r.date ?? "") }))
    .filter((r) => parseIsoDay(r.date) != null && r.date >= todayIso)
    .sort((a, b) => a.date.localeCompare(b.date));
  return upcoming[0] ?? null;
}

/** Classify every entry against today + the race calendar. Pure; exported for tests. */
export function buildSupplementViews(supplements: Supplement[], races: Race[], todayIso: string, share: boolean): SupplementView[] {
  const race = nextRace(races, todayIso);

  return supplements.map((s) => {
    const base = {
      name: s.name,
      dose: s.dose ?? undefined,
      evidence: s.evidence ?? undefined,
      why: s.why ?? undefined,
      notes: s.notes ?? undefined,
    };
    const status = s.status ?? "active";
    if (status === "lapsed") return { ...base, bucket: "parked" as const, timing: "not in use" };

    const when = s.when ?? "daily";
    let bucket: SupplementBucket = "active";
    let timing = "daily";

    if (when === "seasonal") {
      const months = s.months ?? [];
      const idx = Number(todayIso.slice(5, 7)) - 1;
      const currentMonth = idx >= 0 && idx < 12 ? MONTHS[idx] : undefined;
      if (!months.length) {
        bucket = "parked";
        timing = "seasonal — no months set (add months: [...] in the profile)";
      } else if (currentMonth && months.includes(currentMonth)) {
        timing = `through ${capMonth(months[months.length - 1] ?? "")}`;
      } else {
        // Soonest 1st-of-a-listed-month, this year or next.
        const year = Number(todayIso.slice(0, 4));
        let best: { iso: string; days: number } | null = null;
        for (const m of months) {
          const mm = String(MONTHS.indexOf(m) + 1).padStart(2, "0");
          let iso = `${year}-${mm}-01`;
          if (iso < todayIso) iso = `${year + 1}-${mm}-01`;
          const days = daysBetween(todayIso, iso);
          if (days != null && (best == null || days < best.days)) best = { iso, days };
        }
        if (best && best.days <= UPCOMING_HORIZON_DAYS) {
          bucket = "upcoming";
          timing = `starts 1 ${monthNameOf(best.iso)} — in ${best.days} day${best.days === 1 ? "" : "s"}`;
        } else {
          bucket = "parked";
          timing = best ? `off-season — resumes 1 ${monthNameOf(best.iso)}` : "off-season";
        }
      }
    } else if (when === "race_week" || when === "race_day") {
      const lead = when === "race_day" ? 0 : Math.max(0, s.days_before_race ?? 3);
      if (!race) {
        bucket = "parked";
        timing = "no upcoming race on the calendar";
      } else {
        const label = share ? "the next race" : `${race.name} (${shortDate(race.date)})`;
        const toRace = daysBetween(todayIso, race.date) ?? 0;
        if (toRace <= lead) {
          timing = toRace === 0 ? `race day — ${label}` : `race week — ${label} in ${toRace} day${toRace === 1 ? "" : "s"}`;
        } else if (toRace - lead <= UPCOMING_HORIZON_DAYS) {
          bucket = "upcoming";
          timing =
            when === "race_day"
              ? `next: race morning before ${label}`
              : share
                ? `final ${lead} days before ${label}`
                : `starts ${shortDate(shiftDays(race.date, -lead))} — final ${lead} days before ${label}`;
        } else {
          bucket = "parked";
          timing = share ? "waiting for the next race window" : `next: ${label}`;
        }
      }
    }

    if (status === "proposed") return { ...base, bucket: "proposed" as const, timing };
    return { ...base, bucket, timing };
  });
}

export interface SupplementCardInput {
  profile?: Profile;
  /** Clock (ms) — injectable for deterministic tests; the dashboard passes its own `now`. */
  nowMs: number;
  /** IANA timezone the "today" boundary is computed in (the athlete's, from config). */
  timezone: string;
  share?: boolean;
}

function itemHtml(v: SupplementView): string {
  const evTag = v.evidence ? ` <span class="muted">[${escapeHtml(v.evidence)}]</span>` : "";
  const why = v.why ? `<div class="k">${escapeHtml(v.why)}</div>` : "";
  const notes = v.notes ? `<div class="k muted">${escapeHtml(v.notes)}</div>` : "";
  return `<div class="fdetail" style="margin-bottom:6px"><b>${escapeHtml(v.name)}</b>${v.dose ? ` — ${escapeHtml(v.dose)}` : ""} · ${escapeHtml(v.timing)}${evTag}${why}${notes}</div>`;
}

/** The card. "" when the profile holds no supplement protocol (quiet by design — see module header). */
export function renderSupplementCard({ profile, nowMs, timezone, share }: SupplementCardInput): string {
  const supplements = profile?.supplements ?? [];
  if (!supplements.length) return "";
  const todayIso = isoDateInTz(nowMs, timezone);
  const views = buildSupplementViews(supplements, profile?.races ?? [], todayIso, !!share);

  const section = (label: string, items: SupplementView[]) =>
    items.length ? `<div class="disch">${label}</div>${items.map(itemHtml).join("")}` : "";
  const parked = views.filter((v) => v.bucket === "parked");
  const parkedHtml = parked.length
    ? `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;color:#888">Not in use / out of window (${parked.length})</summary><div style="margin-top:6px">${parked.map(itemHtml).join("")}</div></details>`
    : "";

  const sections = [
    section("Active now", views.filter((v) => v.bucket === "active")),
    section("Coming up", views.filter((v) => v.bucket === "upcoming")),
    section("Proposed — discuss with coach first", views.filter((v) => v.bucket === "proposed")),
  ]
    .filter(Boolean)
    .join("\n");

  return `<div class="card"><h2>Supplements — what &amp; when</h2>
  ${sections}
  ${parkedHtml}
  <div class="k" style="margin-top:8px">From your profile's supplement protocol, counted off today + your race calendar. Evidence tags are honest gradings, not endorsements — not medical advice.</div>
</div>`;
}
