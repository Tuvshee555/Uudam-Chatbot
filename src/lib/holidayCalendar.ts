/**
 * Mongolian holidays customers travel around: "Цагаан сарын үеэр ямар аялал байна",
 * "наадмаар", "шинэ жилээр", "цагаан сарын дараа". A holiday is a WHEN, so it resolves to
 * real calendar dates (with the year) and every date path reads it like a typed date window.
 *
 * Live 2026-11-04: "цагаан сарын үеэр ямар аялалууд байна" got the whole catalogue's
 * soonest (November) departures: nothing read "цагаан сар" as a time, and "аялалууд" made it
 * a whole-catalogue question.
 *
 * No trip, place or price lives here — only the public holiday calendar.
 */

export type HolidayKey = "tsagaan_sar" | "naadam" | "new_year";
export type HolidayRelation = "around" | "after" | "before";
type Period = { startYmd: string; endYmd: string };

/**
 * Tsagaan Sar follows the Mongolian lunar calendar, not the Chinese one (2025: 1 March, while
 * the Chinese New Year was 29 January), and the government announces the days off each year.
 * Each span covers the days off as published by officeholidays.com and viewmongolia.com (they
 * differ by a day; checked 2026-11-04). Add the next year when it is announced. A year missing
 * here is never guessed: the question goes to staff (see resolveHoliday).
 */
const TSAGAAN_SAR_DAYS: Readonly<Record<number, Period>> = {
  2026: { startYmd: "2026-02-16", endYmd: "2026-02-20" },
  2027: { startYmd: "2027-02-06", endYmd: "2027-02-09" },
  2028: { startYmd: "2028-02-24", endYmd: "2028-02-28" },
  2029: { startYmd: "2029-02-13", endYmd: "2029-02-15" },
  2030: { startYmd: "2030-02-03", endYmd: "2030-02-05" },
};

/** How far around a holiday a departure still counts, and how far "before"/"after" looks. */
export const HOLIDAY_AROUND_DAYS = 7;
export const HOLIDAY_BEFORE_AFTER_DAYS = 30;

type HolidayDef = {
  key: HolidayKey;
  /** The holiday's genitive, as in "Цагаан сарын үеэр". */
  genitive: string;
  name: string;
  emoji: string;
  re: RegExp;
  /** The occurrence that starts in `year`, or null when its dates are not known. */
  period(year: number): Period | null;
  /** A wider "around" window than ±HOLIDAY_AROUND_DAYS, when the agency sells one. */
  aroundWindow?(period: Period): [string, string];
  /** Whether a fixed public date (shown without "орчим"). */
  fixed: boolean;
};

// "Цагаан сар", "ц.сар", "tsagaan sar", "сар шинэ", "шинийн нэгэн", "битүүн", "lunar new year".
// "цагаан сараана" is a flower, not the holiday.
const TSAGAAN_SAR_RE = /цагаан\s*сар(?!аан)|ц\.\s*сар|tsa?gaa?n\s*sar|сар\s*шин|sar\s*shin|шинийн\s*(?:нэг|хоёр|гурав)|shiniin\s*(?:neg|hoyor|gurav)|битүү(?:н|ний|гээр)|bituu|lunar\s*new\s*year|mongolian\s*new\s*year/iu;
const NAADAM_RE = /наадам|наадм|naadam|naadm/iu;
// "жил" must end the word: "шинжилгээ" (a medical test) is not New Year.
// "шинэ он / оноор / оны", "shine onoor"; never "шинэ онгоц" (a new plane).
export const NEW_YEAR_RE = /(?:шинэ|шин)\s*жил(?:ийн|ийг|ээрээ|ээр|дээ|д|тэй)?(?!\p{L})|shi?ne?\s*jill?(?:iin|iig|eer|er|r|d|tei)?(?![a-z])|new\s*year|шинэ\s*он(?:ы|оор|д|ыг)?(?!\p{L})|shi?ne?\s*on(?:ii|oor|d|iig)?(?![a-z])/iu;
// "Баярын өдрүүдээр", "bayaraar": a holiday, but which one? ("баярлалаа" is a thank-you.)
const UNSPECIFIED_RE = /(?:^|[^\p{L}])(?:баяр(?:ын|аар)|bayar(?:iin|aar))(?!\p{L})/iu;

const HOLIDAYS: readonly HolidayDef[] = [
  {
    key: "tsagaan_sar", genitive: "Цагаан сарын", name: "Цагаан сар", emoji: "🌙", re: TSAGAAN_SAR_RE, fixed: false,
    period: (year) => TSAGAAN_SAR_DAYS[year] ?? null,
  },
  {
    // Naadam days off are fixed by law: 11–15 July.
    key: "naadam", genitive: "Наадмын", name: "Наадам", emoji: "🏇", re: NAADAM_RE, fixed: true,
    period: (year) => ({ startYmd: `${year}-07-11`, endYmd: `${year}-07-15` }),
  },
  {
    // The agency's New Year trips leave from early December to the first days of January.
    key: "new_year", genitive: "Шинэ жилийн", name: "Шинэ жил", emoji: "🎄", re: NEW_YEAR_RE, fixed: true,
    period: (year) => ({ startYmd: `${year}-12-31`, endYmd: `${year + 1}-01-01` }),
    aroundWindow: (period) => [`${period.startYmd.slice(0, 4)}-12-01`, `${period.endYmd.slice(0, 4)}-01-10`],
  },
];

export type HolidayAsk = { holiday: HolidayDef; relation: HolidayRelation; year: number | null };

/**
 * The message with holiday names removed ("цагаан сарын", "шинэ жилийн", "наадмын"). Trip
 * matching reads this: a holiday names a time, never one trip. Live 2026-11-04 a trip titled
 * "<place> … ШИНЭ ЖИЛИЙН АЯЛАЛ" (aliases "Шинэ жил", "Шинэ он") became the answer to every
 * New Year question; the holiday listing finds it by its dates instead.
 */
export function withoutHolidayNames(text: string): string {
  // Only the holiday words go; every other character stays exactly as typed (the matcher's own
  // normalisation runs later — normalising here changed unrelated text).
  let out = text;
  // "Цагаан сарын амралтаар", "шинэ жилийн амралт": the holiday's days off are the same time, so the
  // break word goes with the name. Left behind, it matched a trip titled "… ДАЛАЙН АМРАЛТ" and a
  // family's Tsagaan Sar question was answered about that one trip.
  for (const holiday of HOLIDAYS) out = out.replace(new RegExp(`(?:${holiday.re.source})\\S*(?:\\s+(?:амралт|amralt)\\S*)?`, "giu"), " ");
  // "Шинэ аялал гарсан уу" (has a NEW trip come out?): "new" on its own names nothing either.
  // Only the customer's words lose it; a trip's own title keeps all its words, or a short title
  // would out-score its siblings on the destination alone.
  out = out.replace(/(?<![\p{L}])(?:шинэ|шинээр|shine|shineer)(?![\p{L}])/giu, " ");
  // "Дараа жилийн 2 сард", "ирэх оны 1 сар": the year is a time word. "жилийн" is also a word of a trip
  // titled for the New Year, and the customer's calendar phrase then picked that trip.
  return out.replace(/(?<![\p{L}])(?:дараа|дараагийн|ирэх|энэ|өнгөрсөн|daraa|ireh|ene)\s+(?:(?:жил|он)(?:ийн|ийг|ы|ын|д|оос|ээс|ээр|оор)?(?![\p{L}])|(?:jil|on)(?:iin|iig|d|oos|eer)?(?![a-z]))/giu, " ");
}

/**
 * The message with its holiday phrase removed ("цагаан сарын үеэр", "наадмаас хойш",
 * "шинийн нэгнээр"), so the words left can be checked for a destination. A holiday is a
 * time, never a place.
 */
export function withoutHolidayWords(text: string): string {
  return withoutHolidayNames(text.normalize("NFKC").toLowerCase()).replace(/(?<=^|\s)(?:үеэр|үейр|уеэр|үед|үеийн|дараа|дараах|өмнө|өмнөх|хойш|uyeer|uyed|daraa|umnu|hoish|ирэх|ireh|амралт\S*|amralt\S*)(?=\s|$|[?.!,])/giu, " ");
}

function relationAfter(text: string, at: number): HolidayRelation {
  // The word right after the holiday ("цагаан сарын дараа", "наадмаас хойш", "шинэ жилийн өмнө").
  const tail = text.slice(at, at + 40);
  if (/^\S*\s+(?:\S+\s+)?(?:дараа|хойш|daraa|hoish|after)/iu.test(tail) || /^\S*(?:аас|ээс|оос)\s+хойш/iu.test(tail)) return "after";
  if (/^\S*\s+(?:\S+\s+)?(?:өмнө|umnu|before)/iu.test(tail)) return "before";
  return "around";
}

/** The holiday a message travels around, or "unspecified" for "баярын өдрүүдээр", or null. */
export function detectHoliday(text: string): HolidayAsk | "unspecified" | null {
  const lowered = text.normalize("NFKC").toLowerCase();
  for (const holiday of HOLIDAYS) {
    const match = holiday.re.exec(lowered);
    if (!match) continue;
    // "2028 оны цагаан сар": the year the customer named.
    const year = /(?:^|[^\d])(20\d{2})\s*(?:оны|onii|оны\s)/u.exec(lowered);
    return { holiday, relation: relationAfter(lowered, match.index), year: year ? Number(year[1]) : null };
  }
  return UNSPECIFIED_RE.test(lowered) ? "unspecified" : null;
}

function todayUb(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ulaanbaatar", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function shift(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function windowFor(holiday: HolidayDef, period: Period, relation: HolidayRelation): [string, string] {
  if (relation === "after") return [shift(period.endYmd, 1), shift(period.endYmd, HOLIDAY_BEFORE_AFTER_DAYS)];
  if (relation === "before") return [shift(period.startYmd, -HOLIDAY_BEFORE_AFTER_DAYS), shift(period.startYmd, -1)];
  return holiday.aroundWindow?.(period) ?? [shift(period.startYmd, -HOLIDAY_AROUND_DAYS), shift(period.endYmd, HOLIDAY_AROUND_DAYS)];
}

function spanLabel(period: Period, now: Date, approximate: boolean): string {
  const [sy, sm, sd] = period.startYmd.split("-").map(Number);
  const [ey, em, ed] = period.endYmd.split("-").map(Number);
  const thisYear = Number(todayUb(now).slice(0, 4));
  const year = sy !== thisYear || ey !== thisYear ? `${sy} оны ` : "";
  const span = sm === em ? `${sm} сарын ${sd}–${ed}` : sy === ey ? `${sm} сарын ${sd} – ${em} сарын ${ed}` : `${sm} сарын ${sd} – ${ey} оны ${em} сарын ${ed}`;
  return `${year}${span}${approximate ? " орчим" : ""}`;
}

export type HolidayResolution =
  | { status: "resolved"; ask: HolidayAsk; period: Period; window: [string, string];
      /** "Цагаан сарын үеэр (2027 оны 2 сарын 6–9 орчим)" — the customer-facing name of the window. */
      phrase: string }
  | { status: "unknown"; ask: HolidayAsk };

/**
 * The next occurrence of the holiday the message names (or the year it names), with the
 * departure window to search. Today is Mongolia's today; a holiday whose window has passed
 * means next year's. "unknown" when that year's dates are not published (never a guess).
 */
export function resolveHoliday(text: string, now = new Date()): HolidayResolution | null {
  const ask = detectHoliday(text);
  if (!ask || ask === "unspecified") return null;
  const today = todayUb(now);
  const thisYear = Number(today.slice(0, 4));
  const years = ask.year ? [ask.holiday.key === "new_year" ? ask.year - 1 : ask.year] : [thisYear - 1, thisYear, thisYear + 1, thisYear + 2];
  for (const year of years) {
    const period = ask.holiday.period(year);
    if (!period) {
      // A year that could be the next occurrence and has no published dates: unknown, never
      // a skip to a later year. Only last year's occurrence may be missing (it has passed).
      if (ask.year || year >= thisYear) return { status: "unknown", ask };
      continue;
    }
    const window = windowFor(ask.holiday, period, ask.relation);
    if (!ask.year && window[1] < today) continue;
    const start = window[0] < today ? today : window[0];
    const around = `${ask.holiday.genitive} ${ask.relation === "after" ? "дараа" : ask.relation === "before" ? "өмнө" : "үеэр"}`;
    // The New Year window is the season the agency sells (December to early January), so it is
    // named as that season, not as the one night.
    const shown = ask.holiday.key === "new_year" && ask.relation === "around" ? "12 сар – 1 сарын эхээр" : spanLabel(period, now, !ask.holiday.fixed);
    return { status: "resolved", ask, period, window: [start, window[1]], phrase: `${around} (${shown})` };
  }
  return { status: "unknown", ask };
}

/** The upcoming holidays with their dates, for "which holiday?" and the model's context. */
export function upcomingHolidays(now = new Date()): Array<{ name: string; emoji: string; label: string; period: Period }> {
  return HOLIDAYS.flatMap((holiday) => {
    const resolved = resolveHoliday(holiday.name, now);
    return resolved?.status === "resolved"
      ? [{ name: holiday.name, emoji: holiday.emoji, label: spanLabel(resolved.period, now, !holiday.fixed), period: resolved.period }]
      : [];
  }).sort((a, b) => a.period.startYmd.localeCompare(b.period.startYmd));
}

/**
 * "Цагаан сарын үеэр (2027 оны 2 сарын 6–9 орчим) гарах аяллууд": the bracket restates the
 * holiday's own days, it is not a departure. The checkers drop only that bracket (on a line
 * that names a holiday), so the trip names and every departure listed are still verified.
 * A model writing "Цагаан сарын үеэр 2 сарын 6-нд гарна" keeps its date checked.
 */
const HOLIDAY_NAME_RE = /цагаан\s*сар|наадам|наадм|шинэ\s*жил/iu;
export function withoutHolidaySpans(text: string): string {
  return text.split("\n").map((line) => HOLIDAY_NAME_RE.test(line)
    ? line.replace(/\((?=[^)]*\d)[^)]*(?:сар|оны)[^)]*\)/gu, " ")
    : line).join("\n");
}

/** One line for the model's time context when the customer names a holiday. */
export function holidayPromptLine(text: string, now = new Date()): string | null {
  const resolved = resolveHoliday(text, now);
  if (!resolved) return detectHoliday(text) === "unspecified"
    ? `The customer mentions a holiday without naming it. Upcoming holidays: ${upcomingHolidays(now).map((h) => `${h.name} ${h.period.startYmd}..${h.period.endYmd}`).join("; ")}. Ask which one; never guess.`
    : null;
  if (resolved.status === "unknown") return `The customer refers to ${resolved.ask.holiday.name}, whose dates for that year are not published: output REFER for any date answer.`;
  return `The customer refers to ${resolved.ask.holiday.name} (${resolved.ask.relation}): holiday ${resolved.period.startYmd}..${resolved.period.endYmd}; matching departures are ${resolved.window[0]}..${resolved.window[1]}. Never present a departure outside that window as during the holiday.`;
}
