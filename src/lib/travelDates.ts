import type { TravelTrip } from "./travelOps";

export const MONGOLIA_TIME_ZONE = "Asia/Ulaanbaatar";

type DateParts = {
  year: number;
  month: number;
  day: number;
};

type RequestedDate = {
  ymd: string;
  label: string;
  source: "relative" | "explicit";
};

type DepartureDateMatch = {
  trip: TravelTrip;
  matchedDateText: string;
};

const MN_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: MONGOLIA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const RELATIVE_DATE_PATTERNS: Array<{
  offsetDays: number;
  label: string;
  patterns: RegExp[];
}> = [
  {
    offsetDays: 0,
    label: "өнөөдөр",
    patterns: [/\b(today|unuudur|unuudur|onooodor)\b/i, /өнөөдөр/i],
  },
  {
    offsetDays: 1,
    label: "маргааш",
    patterns: [/\b(tomorrow|margaash|margash)\b/i, /маргааш/i],
  },
  {
    offsetDays: 2,
    label: "нөгөөдөр",
    patterns: [/\b(day after tomorrow|nuguudur|nuguudor|nogoodor)\b/i, /н[өо]г[өо]{2}дөр/i],
  },
];

function getMongoliaDateParts(now = new Date()): DateParts {
  const parts = MN_DATE_FORMAT.formatToParts(now);
  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(lookup.get("year")),
    month: Number(lookup.get("month")),
    day: Number(lookup.get("day")),
  };
}

function toYmd(parts: DateParts): string {
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function addDays(parts: DateParts, days: number): DateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

function inferYear(month: number, day: number, now = new Date()): number {
  const today = getMongoliaDateParts(now);
  const candidate = { year: today.year, month, day };
  if (!isValidDateParts(candidate.year, candidate.month, candidate.day)) {
    return today.year;
  }
  return toYmd(candidate) >= toYmd(today) ? today.year : today.year + 1;
}

// How to interpret a month/day with no year:
// - "roll-forward" (user queries): "3 сарын 8" asked in July means NEXT March.
// - "current-year" (stored trip dates): "3 сарын 8" on a trip record means
//   THIS March — if it already passed, the departure is stale, not next year's.
type YearInferenceMode = "roll-forward" | "current-year";

function explicitDateCandidates(
  text: string,
  now = new Date(),
  yearMode: YearInferenceMode = "roll-forward",
): DateParts[] {
  const candidates: DateParts[] = [];
  const resolveYear = (month: number, day: number) =>
    yearMode === "current-year"
      ? getMongoliaDateParts(now).year
      : inferYear(month, day, now);
  const push = (year: number, month: number, day: number) => {
    if (!isValidDateParts(year, month, day)) return;
    const ymd = toYmd({ year, month, day });
    if (!candidates.some((candidate) => toYmd(candidate) === ymd)) {
      candidates.push({ year, month, day });
    }
  };

  for (const match of text.matchAll(/\b(20\d{2})[./-](\d{1,2})[./-](\d{1,2})\b/g)) {
    push(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  for (const match of text.matchAll(
    /(?:(20\d{2})\s*(?:оны|он|onii|oni|on)?\s*)?(\d{1,2})\s*(?:-?\s*р)?\s*(?:сарын|сар|sariin|sar)\s*(\d{1,2})/gi,
  )) {
    const month = Number(match[2]);
    const day = Number(match[3]);
    push(match[1] ? Number(match[1]) : resolveYear(month, day), month, day);
  }

  // The lookbehind/lookahead stop this bare month/day pattern from re-matching
  // the "12-01" inside a full ISO date like "2025-12-01" (already captured, with
  // its real year, by the regex above). Without them the fragment was re-parsed
  // as the CURRENT year, so an explicitly past-year date looked like a future one.
  for (const match of text.matchAll(/(?<![\d./-])(\d{1,2})[./-](\d{1,2})(?![\d./-])/g)) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    push(resolveYear(month, day), month, day);
  }

  return candidates;
}

export function resolveRequestedDate(
  text: string,
  now = new Date(),
): RequestedDate | null {
  const today = getMongoliaDateParts(now);

  for (const candidate of RELATIVE_DATE_PATTERNS) {
    if (!candidate.patterns.some((pattern) => pattern.test(text))) continue;
    return {
      ymd: toYmd(addDays(today, candidate.offsetDays)),
      label: candidate.label,
      source: "relative",
    };
  }

  const explicit = explicitDateCandidates(text, now)[0];
  if (!explicit) return null;
  return {
    ymd: toYmd(explicit),
    label: toYmd(explicit),
    source: "explicit",
  };
}

export function parseDepartureDateText(text: string, now = new Date()): string[] {
  return explicitDateCandidates(text, now).map(toYmd);
}

/**
 * Parses a STORED trip departure-date string. Bare month/day means the
 * CURRENT year — a June date read in July is a PAST departure, never next
 * year's. (parseDepartureDateText rolls forward, which is right for user
 * queries but made stale trips look like next-season departures.)
 */
export function parseTripDepartureDateText(text: string, now = new Date()): string[] {
  return explicitDateCandidates(text, now, "current-year").map(toYmd);
}

/**
 * A stored map from each departure-date display string to the ISO date it was
 * resolved to AT WRITE TIME (or null for recurring/flexible text with no
 * calendar date). Kept in `extra.departure_dates_resolved`.
 */
export type ResolvedDepartureDate = { text: string; ymd: string | null };

/**
 * Resolves each departure-date string to a STABLE ISO date at WRITE time.
 *
 * Bare month/day rolls forward from the write moment — which is the correct
 * disambiguation: "1 сарын 15" saved in July means next January, and once
 * frozen it will not drift or be re-guessed on later reads. A genuinely stale
 * trip was saved when its date was near-future, so its frozen ISO is now
 * correctly in the past. Recurring/flexible text resolves to ymd=null.
 */
export function resolveDepartureDatesAtWrite(
  dates: string[],
  now = new Date(),
): ResolvedDepartureDate[] {
  return (dates || []).map((text) => {
    const parsed = explicitDateCandidates(String(text || ""), now, "roll-forward").map(toYmd);
    return { text: String(text || ""), ymd: parsed.length > 0 ? parsed[0] : null };
  });
}

/** Builds a text→ymd lookup from a stored resolved list (ignores blank text). */
function resolvedLookup(
  resolved?: ResolvedDepartureDate[] | null,
): Map<string, string | null> | null {
  if (!Array.isArray(resolved) || resolved.length === 0) return null;
  const map = new Map<string, string | null>();
  for (const entry of resolved) {
    if (entry && typeof entry.text === "string") {
      map.set(entry.text, typeof entry.ymd === "string" ? entry.ymd : null);
    }
  }
  return map;
}

/**
 * Keeps only departure-date strings that are not verifiably in the past.
 * Per string: no parseable date (recurring/flexible text like "Пүрэв гараг
 * бүр", "аяллын групп бүрдсэн огноогоор") → keep; any parsed date today or
 * later → keep; every parsed date in the past → drop. Keep-if-unsure by
 * design: hiding a real future date is worse than showing a stale one.
 *
 * When a write-time `resolved` map is supplied it is preferred over re-parsing:
 * a frozen ISO never drifts, so a genuine next-season date stays visible. Any
 * date not covered by the map falls back to text parsing, so existing trips
 * with no resolved map behave exactly as before (no regression).
 */
export function filterFutureDepartureDates(
  dates: string[],
  now = new Date(),
  resolved?: ResolvedDepartureDate[] | null,
): string[] {
  const todayYmd = toYmd(getMongoliaDateParts(now));
  const lookup = resolvedLookup(resolved);
  return (dates || []).filter((dateText) => {
    const key = String(dateText || "");
    if (lookup && lookup.has(key)) {
      const ymd = lookup.get(key) ?? null;
      return ymd === null ? true : ymd >= todayYmd;
    }
    const parsed = parseTripDepartureDateText(key, now);
    if (parsed.length === 0) return true;
    return parsed.some((ymd) => ymd >= todayYmd);
  });
}

function isDepartureAvailabilityQuestion(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;

  const hasTravelSignal =
    /аялал|aylal|tour|trip|гар|garah|гарах|явах|yavah|departure|өдөр|ognoo|date/.test(
      normalized,
    );
  const hasQuestionSignal =
    /байна|baina|\?|уу|uu|боломж|bolomj|available|гарах|garah|явах|yavah/.test(
      normalized,
    );

  return hasTravelSignal && hasQuestionSignal;
}

export function hasDepartureDateAvailabilityIntent(text: string, now = new Date()): boolean {
  return Boolean(resolveRequestedDate(text, now)) && isDepartureAvailabilityQuestion(text);
}

function formatMoney(value: number | null, currency: string): string {
  if (typeof value !== "number") return "";
  return `${value.toLocaleString("mn-MN")}${currency || "MNT"}`;
}

function formatTripSummary(match: DepartureDateMatch): string {
  const { trip } = match;
  const details: string[] = [];
  const adultPrice = formatMoney(trip.adult_price, trip.currency);
  if (adultPrice) details.push(`том хүн ${adultPrice}`);
  if (typeof trip.seats_left === "number") details.push(`${trip.seats_left} суудал`);

  const suffix = details.length ? ` (${details.join(", ")})` : "";
  return `${trip.route_name} — ${trip.operator_name}${suffix}`;
}

/**
 * The ISO date(s) a stored trip date text resolves to. Prefers the trip's
 * write-time resolved map (frozen, no drift); falls back to current-year text
 * parsing when the map has no entry (existing trips behave exactly as before).
 */
function tripDateYmds(trip: TravelTrip, dateText: string, now: Date): string[] {
  const resolved = ((trip.extra || {}) as Record<string, unknown>)
    .departure_dates_resolved as ResolvedDepartureDate[] | undefined;
  if (Array.isArray(resolved)) {
    const hit = resolved.find((entry) => entry && entry.text === dateText);
    if (hit) return hit.ymd ? [hit.ymd] : [];
  }
  return parseTripDepartureDateText(dateText, now);
}

function findDepartureMatches(
  trips: TravelTrip[],
  requestedYmd: string,
  now = new Date(),
): DepartureDateMatch[] {
  const matches: DepartureDateMatch[] = [];
  for (const trip of trips) {
    if (trip.status !== "active") continue;
    for (const dateText of trip.departure_dates || []) {
      // Trip-date semantics: a stored "3 сарын 8" is THIS March. With
      // roll-forward parsing a stale spring trip matched next year's date.
      const parsedDates = tripDateYmds(trip, dateText, now);
      if (!parsedDates.includes(requestedYmd)) continue;
      matches.push({ trip, matchedDateText: dateText });
      break;
    }
  }
  return matches;
}

function findUpcomingDepartures(
  trips: TravelTrip[],
  afterYmd: string,
  now = new Date(),
): Array<{ ymd: string; trip: TravelTrip }> {
  const upcoming: Array<{ ymd: string; trip: TravelTrip }> = [];
  const seen = new Set<string>();

  for (const trip of trips) {
    if (trip.status !== "active") continue;
    for (const dateText of trip.departure_dates || []) {
      for (const ymd of tripDateYmds(trip, dateText, now)) {
        if (ymd < afterYmd) continue;
        const key = `${ymd}:${trip.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        upcoming.push({ ymd, trip });
      }
    }
  }

  return upcoming.sort((a, b) => a.ymd.localeCompare(b.ymd)).slice(0, 5);
}

export function buildTemporalPromptContext(userText: string, now = new Date()): string {
  const today = getMongoliaDateParts(now);
  const tomorrow = addDays(today, 1);
  const dayAfterTomorrow = addDays(today, 2);
  const requested = resolveRequestedDate(userText, now);

  const lines = [
    `Current date in ${MONGOLIA_TIME_ZONE}: ${toYmd(today)}.`,
    `"маргааш" / "margaash" / "tomorrow" means ${toYmd(tomorrow)}.`,
    `"нөгөөдөр" / "nuguudur" means ${toYmd(dayAfterTomorrow)}.`,
  ];
  if (requested) {
    lines.push(`The user's requested date resolves to ${requested.ymd}.`);
  }
  return lines.join(" ");
}

export function buildDepartureDateAvailabilityReply(input: {
  userText: string;
  trips: TravelTrip[];
  now?: Date;
}): string | null {
  const now = input.now || new Date();
  const requested = resolveRequestedDate(input.userText, now);
  if (!requested || !hasDepartureDateAvailabilityIntent(input.userText, now)) return null;

  const matches = findDepartureMatches(input.trips, requested.ymd, now);
  const dateLabel =
    requested.source === "relative" ? `${requested.label} (${requested.ymd})` : requested.ymd;

  if (matches.length > 0) {
    const shown = matches.slice(0, 4).map(formatTripSummary).join("; ");
    const extra =
      matches.length > 4 ? ` Нийт ${matches.length} аялал таарч байна.` : "";
    return `Тийм ээ, ${dateLabel} гарах аялал байна: ${shown}.${extra} Суудал болон захиалгыг баталгаажуулахын тулд нэр, утсаа үлдээгээрэй.`;
  }

  const upcoming = findUpcomingDepartures(input.trips, requested.ymd, now);
  if (upcoming.length > 0) {
    const options = upcoming
      .map(({ ymd, trip }) => `${ymd}: ${trip.route_name} — ${trip.operator_name}`)
      .join("; ");
    return `${dateLabel} гарах аялал одоогийн мэдээлэлд алга байна. Ойрын гарах өдрүүд: ${options}.`;
  }

  return `${dateLabel} гарах аялал одоогийн мэдээлэлд алга байна. Одоогоор баталгаатай гарах өдөр бүртгэгдээгүй байна.`;
}

/**
 * Generate all date key variants for a single date string.
 *
 * Handles:
 *   "6 сарын 27"         → 5 variants (MN padded/unpadded, slash, ISO with year inference)
 *   "7 сарын 9-14"       → range → each day as ISO + range key
 *   "2026-06-27"         → all Mongolian + slash variants
 *   "6/27"               → all Mongolian + ISO variants
 *
 * Returns deduplicated string array. Pass now to control year inference.
 */
export function generateDateKeys(dateText: string, now = new Date()): string[] {
  const keys = new Set<string>();
  const add = (k: string) => { if (k) keys.add(k.trim()); };

  // ── helper: emit all variants for a single month+day ──────────────────────
  function emitMonthDay(month: number, day: number, year?: number) {
    const m = String(month);
    const mPad = m.padStart(2, "0");
    const d = String(day);
    const dPad = d.padStart(2, "0");

    add(`${m} сарын ${d}`);
    add(`${mPad} сарын ${d}`);
    add(`${m} сарын ${dPad}`);
    add(`${mPad} сарын ${dPad}`);
    add(`${m}/${d}`);
    add(`${mPad}/${d}`);
    add(`${m}/${dPad}`);
    add(`${mPad}/${dPad}`);

    // ISO: use provided year, or infer
    const yr = year ?? inferYear(month, day, now);
    if (yr) add(`${yr}-${mPad}-${dPad}`);
    // Also add next-year ISO so queries near year-end still match
    if (!year) {
      const nextYr = yr + 1;
      add(`${nextYr}-${mPad}-${dPad}`);
    }
  }

  // ── try ISO: 2026-06-27 ───────────────────────────────────────────────────
  const isoM = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateText.trim());
  if (isoM) {
    const [, yr, mo, dy] = isoM.map(Number);
    emitMonthDay(mo, dy, yr);
    return Array.from(keys);
  }

  // ── try slash: 6/27 ──────────────────────────────────────────────────────
  const slashM = /^(\d{1,2})\/(\d{1,2})$/.exec(dateText.trim());
  if (slashM) {
    const [, mo, dy] = slashM.map(Number);
    emitMonthDay(mo, dy);
    return Array.from(keys);
  }

  // ── try Mongolian range: "7 сарын 9-14" ──────────────────────────────────
  const rangeM = /^(\d{1,2})\s*сарын\s*(\d{1,2})\s*[-–—]\s*(\d{1,2})$/.exec(dateText.trim());
  if (rangeM) {
    const [, moStr, startStr, endStr] = rangeM;
    const month = parseInt(moStr, 10);
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    const yr = inferYear(month, start, now);
    const mPad = String(month).padStart(2, "0");
    // Range key
    add(`${month} сарын ${start}-${end}`);
    add(`${yr}-${mPad}-${String(start).padStart(2, "0")}_to_${yr}-${mPad}-${String(end).padStart(2, "0")}`);
    // Each individual day
    for (let dy = start; dy <= end; dy++) {
      if (isValidDateParts(yr, month, dy)) emitMonthDay(month, dy, yr);
    }
    return Array.from(keys);
  }

  // ── try Mongolian multi-day same month: "6 сарын 19, 26" ─────────────────
  const multiM = /^(\d{1,2})\s*сарын\s*(\d{1,2})((?:\s*[,،]\s*\d{1,2})+)$/.exec(dateText.trim());
  if (multiM) {
    const month = parseInt(multiM[1], 10);
    const days = [parseInt(multiM[2], 10)];
    for (const part of multiM[3].split(/[,،]/)) {
      const d = parseInt(part.trim(), 10);
      if (!isNaN(d)) days.push(d);
    }
    for (const dy of days) emitMonthDay(month, dy);
    return Array.from(keys);
  }

  // ── try plain Mongolian: "6 сарын 27" ────────────────────────────────────
  const mnM = /^(\d{1,2})\s*сарын\s*(\d{1,2})$/.exec(dateText.trim());
  if (mnM) {
    const [, mo, dy] = mnM.map(Number);
    emitMonthDay(mo, dy);
    return Array.from(keys);
  }

  // ── fallback: return the original as-is ──────────────────────────────────
  add(dateText);
  return Array.from(keys);
}
