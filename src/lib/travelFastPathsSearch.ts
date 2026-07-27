/**
 * Trip matching/search core for the fast-path reply layer: normalizes user
 * text (incl. phonetic Latin transliteration for typed-in-English Mongolian),
 * scores trips against a query, and resolves which trip(s) a message is about.
 */

import { filterFutureDepartureDates, type ResolvedDepartureDate } from "./travelDates";
import type { TravelTrip } from "./travelOps";

/**
 * Returns a copy of the trip with past departure dates stripped, so every
 * fast-path reply quotes only current schedules. Recurring/flexible date
 * text ("Пүрэв гараг бүр") is always kept — only verifiably past calendar
 * dates are dropped. A stale trip whose dates are ALL past ends up with an
 * empty list, which the reply builders already treat as "no known dates".
 *
 * Prefers the trip's write-time resolved ISO map (extra.departure_dates_resolved)
 * so a genuine next-season date is not filtered as past; falls back to text
 * parsing when the map is absent (existing trips behave exactly as before).
 */
export function withFutureDepartureDates(trip: TravelTrip, now = new Date()): TravelTrip {
  const dates = trip.departure_dates || [];
  const resolved = ((trip.extra || {}) as Record<string, unknown>)
    .departure_dates_resolved as ResolvedDepartureDate[] | undefined;
  const filtered = filterFutureDepartureDates(dates, now, resolved);
  if (filtered.length === dates.length) return trip;
  return { ...trip, departure_dates: filtered };
}

export type DepartureDateGroup = {
  label?: string | null;
  dates?: string[];
  adult_price?: number | null;
  child_price?: number | null;
  infant_price?: number | null;
  notes?: string | null;
};

export type TripMatch = {
  trip: TravelTrip;
  matchedWords: string[];
  keywordCoverage: number;
  score: number;
};

export type MonthDay = {
  month: number;
  day: number;
};

export type CombinedDatePriceMatch = {
  trip: TravelTrip;
  matchType: "adult" | "child" | "infant" | "passenger" | "discount" | "date_only";
  score: number;
  priceDiff: number;
  matchedPrice: number | null;
  group: Record<string, unknown> | DepartureDateGroup | null;
};

export type ProgramAsset = {
  type: "id" | "url";
  value: string;
};

export type TripProgramReplyResult = {
  reply: string;
  trip: TravelTrip | null;
  brochure: ProgramAsset | null;
  mediaUrls: string[];
};

export type TripResolution =
  | { status: "verified"; trip: TravelTrip; candidates: TravelTrip[] }
  | { status: "ambiguous"; trip: null; candidates: TravelTrip[] }
  | { status: "not_found"; trip: null; candidates: [] };

export const DISCOUNT_KEYWORDS_MN = ["хямдрал", "хямдралтай", "хөнгөлөлт", "тусгай", "урамшуулал", "промо"];
export const DISCOUNT_KEYWORDS_EN = ["discount", "promo", "promotion", "special", "deal", "offer", "sale"];

const GENERIC_ROUTE_WORDS = new Set([
  "аялал",
  "аяллын",
  "хот",
  "хотын",
  "шууд",
  "нислэг",
  "нислэгтэй",
  "газар",
  "газрын",
  "хосолсон",
  "аялалтай",
  "өдөр",
  "шөнө",
  "өдрийн",
  "шөнийн",
  "буюу",
  "тусгай",
  "хямдрал",
  "үнэтэй",
  "үнэтэйхэн",
  "expensive",
  "final",
  "uudam",
  "travel",
  "agency",
  "зураг",
  "зургийг",
  "зурагаа",
  "зургууд",
  "photo",
  "photos",
  "image",
  "images",
  "picture",
  "program",
  "pdf",
  "хөтөлбөр",
]);

const STRUCTURED_QUERY_SIGNALS = [
  "үнэ",
  "хэд вэ",
  "хэдээр",
  "төлбөр",
  "нийт",
  "хэд болох",
  "хэдэн өдөр",
  "хэд хоног",
  "хэзээ",
  "огноо",
  "гарах",
  "хуваарь",
  "шууд нислэг",
  "нислэгтэй юу",
  "байна уу",
  "адилхан",
  "ижил",
  "болно уу",
];

const PROGRAM_QUERY_SIGNALS = [
  "хөтөлбөр",
  "program",
  "pdf",
  "зураг",
  "өдөр өдөр",
  "day by day",
  "itinerary",
];

// Only language/script normalizations here — no trip-specific city names.
// City aliases and romanized destination names belong in each trip's
// extra.aliases array in the database, editable via the admin panel.
const ALIAS_REPLACEMENTS: Array<[RegExp, string]> = [
  [/[бБ]эйд[эеэи]хэ/g, "бэйдайхэ"],
  [/[бБ]айд[эеэи]хэ/g, "бэйдайхэ"],
  [/\bnaadam\b/gi, "наадам"],
  [/наадмын/gi, "наадам"],
  [/\bnisleggvi\b/gi, "нислэггүй"],
  [/\bnisleggui\b/gi, "нислэггүй"],
  [/\bniseleggvi\b/gi, "нислэггүй"],
  [/\bnislegtei\b/gi, "нислэгтэй"],
  [/\bnislegt[eэ]i\b/gi, "нислэгтэй"],
  [/\bnisleg\b/gi, "нислэг"],
  [/\bno flight\b/gi, "нислэггүй"],
  [/\bland tour\b/gi, "газрын аялал"],
  [/\bgazar\b/gi, "газар"],
  [/\bgazr\b/gi, "газар"],
  [/\bgazrin\b/gi, "газрын"],
  [/\bgazriin\b/gi, "газрын"],
  [/\bgazariin\b/gi, "газрын"],
  [/\bgazryn\b/gi, "газрын"],
  [/\bhosolson\b/gi, "хосолсон"],
  [/\bhoslson\b/gi, "хосолсон"],
  [/\baylal\b/gi, "аялал"],
  [/\bayalal\b/gi, "аялал"],
  [/\bzurag\b/gi, "зураг"],
  [/\buzi[eй]?\b/gi, "үзье"],
  [/\bwith ticket\b/gi, "тийзтэй"],
  [/\bwithout ticket\b/gi, "тийзгүй"],
  [/\bticketless\b/gi, "тийзгүй"],
  [/\bticket included\b/gi, "тийзтэй"],
];

export function normText(text: string) {
  let normalized = text.toLowerCase();
  for (const [pattern, replacement] of ALIAS_REPLACEMENTS) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized
    .replace(/[+_/\\|()[\],.:;!?-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when a free-text admin/AI-extraction field is actually an internal QA
 * placeholder ("шинэ мэдээлэл уншигдсан, баталгаажуулах шаардлагатай") rather
 * than real customer-facing content. Any reply builder rendering duration_text,
 * notes, or source_description verbatim must filter through this first —
 * otherwise an unverified admin sentinel gets read straight to a customer.
 * Kept in this dependency-free module (no DB/env imports) so every fast-path
 * file and the AI reply path can use the exact same check without pulling in
 * the database layer.
 */
export function isGenericConfirmationText(value: string | null | undefined): boolean {
  const normalized = (value || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return true;
  return (
    normalized.includes("файлнаас шинэ аяллын мэдээлэл уншигдсан") ||
    normalized.includes("шинэ аяллын мэдээлэл уншигдсан") ||
    normalized.includes("баталгаажуулалт шаардлагатай") ||
    normalized.includes("баталгаажуулах шаардлагатай") ||
    (normalized.includes("new trip") && normalized.includes("confirmation")) ||
    (normalized.includes("file") && normalized.includes("confirmation")) ||
    (normalized.includes("file") && normalized.includes("review"))
  );
}

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "yo",
  ж: "j",
  з: "z",
  и: "i",
  й: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  ө: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ү: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sh",
  ъ: "",
  ы: "i",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

export function phoneticLatinText(text: string) {
  return normText(text)
    .split("")
    .map((char) => CYRILLIC_TO_LATIN[char] ?? char)
    .join("")
    .replace(/ts/g, "c")
    .replace(/ch/g, "c")
    .replace(/sh/g, "s")
    .replace(/kyo/g, "kio")
    .replace(/yo/g, "o")
    .replace(/yu/g, "u")
    .replace(/ya/g, "a")
    .replace(/kh/g, "h")
    .replace(/ee+/g, "e")
    .replace(/oo+/g, "o")
    .replace(/uu+/g, "u")
    .replace(/ii+/g, "i")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const GENERIC_ROUTE_WORDS_PHONETIC = new Set(
  Array.from(GENERIC_ROUTE_WORDS, (word) => phoneticLatinText(word)).filter(Boolean),
);

export function keywordTokens(text: string) {
  return normText(text)
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2 && !GENERIC_ROUTE_WORDS.has(word));
}

export function phoneticKeywordTokens(text: string) {
  return phoneticLatinText(text)
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2 && !GENERIC_ROUTE_WORDS_PHONETIC.has(word));
}

export function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}

function isOneEditApart(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * True when the LONGER token is the shorter one plus a trailing Mongolian
 * case suffix — "далянийн" (genitive of "Далянь") vs "dalan"/"dalanin" in
 * phonetic space: "dalanin".startsWith("dalan"). Case endings (genitive,
 * accusative, dative...) add letters rather than substitute them, so this is
 * NOT a typo (isOneEditApart's territory, capped at 1 substitution) — a real
 * customer asking "Далянийн аялалын үнэ хэд вэ?" got "not_found" from the
 * resolver because the query token never equalled the bare route token.
 * Minimum shared length guards against short tokens prefix-matching by
 * coincidence, mirroring the same idiom already used for scoped-clarification
 * attribute answers (fastPathRouting.ts's filterCandidatesByAttribute).
 */
function isCaseSuffixedForm(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 4 && longer.length > shorter.length && longer.startsWith(shorter);
}

function phoneticTokenMatches(queryToken: string, candidateToken: string): boolean {
  return (
    queryToken === candidateToken ||
    isOneEditApart(queryToken, candidateToken) ||
    isCaseSuffixedForm(queryToken, candidateToken)
  );
}

export function uniqueMonthDays(values: MonthDay[]) {
  const seen = new Set<string>();
  const result: MonthDay[] = [];
  for (const value of values) {
    const key = `${value.month}-${value.day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function formatMoney(value: number | null, currency: string) {
  if (typeof value !== "number") return null;
  const formatted = value.toLocaleString("mn-MN");
  const suffix = currency === "MNT" || !currency ? "₮" : ` ${currency}`;
  return `${formatted}${suffix}`;
}

export function getPriceGroups(trip: TravelTrip): DepartureDateGroup[] {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  const groups = extra.departure_date_groups;
  return Array.isArray(groups) ? (groups as DepartureDateGroup[]) : [];
}

export function getTripLooseField(trip: TravelTrip, key: string): unknown {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  if (key in extra) return extra[key];
  const record = trip as unknown as Record<string, unknown>;
  return record[key];
}

export function getAliases(trip: TravelTrip): string[] {
  const raw = getTripLooseField(trip, "aliases");
  return Array.isArray(raw) ? (raw as string[]).filter(Boolean) : [];
}

/**
 * True when a 0₮ fare for `target` is a documented free tier, not a gap in the
 * extracted data. Every trip observed with a 0 fare also carries a
 * `child_rules`/`child_price_rules` entry with `note: "Үнэгүй"` for that same
 * seat — the extraction pipeline records "free" as an explicit note next to a
 * literal 0, not as a distinct sentinel, so this is the one place that
 * information survives to be checked.
 *
 * Deliberately narrow: only INFANTS are ever free in this catalog (agency
 * policy — a 12-year-old "хүүхэд" tier is never free even if some import left
 * it at 0). A rule counts as infant-shaped when its label says so, or its age
 * text is in months ("сар"), or a 0-N years span with N<=3, or a birth-year
 * span whose oldest age this year is <=3 — matching the three real shapes seen
 * in the catalog ("0-23 сар", "0-2 нас", "2024-2026 он").
 */
/**
 * Whether an age_range/label describes an INFANT (0-3ish), the only bucket the
 * agency ever waives — checked independently of whatever label the extraction
 * happened to attach. Real catalog data has a "Хүүхэд" (child) label misapplied
 * to a genuine infant tier (age_range "2024-2026 он", i.e. 0-2 years old this
 * year) sitting alongside a real, non-zero "Хүүхэд" child tier — so the label
 * alone is not trustworthy and the age must be checked directly.
 */
export function isInfantShapedAge(label: string, ageRange: string): boolean {
  if (label.includes("нярай") || label.includes("infant")) return true;
  if (/сар/.test(ageRange)) return true; // age given in months -> infant
  const yearsSpan = /(\d{1,2})\s*[-–]\s*(\d{1,2})\s*нас/.exec(ageRange);
  if (yearsSpan && Number(yearsSpan[1]) === 0 && Number(yearsSpan[2]) <= 3) return true;
  const birthYears = /(\d{4})\s*[-–]\s*(\d{4})/.exec(ageRange);
  if (birthYears) {
    const maxAge = new Date().getFullYear() - Number(birthYears[1]);
    if (maxAge >= 0 && maxAge <= 3) return true;
  }
  return false;
}

export function isDocumentedFreeFare(trip: TravelTrip, target: "child" | "infant"): boolean {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  const rules = [extra.child_rules, extra.child_price_rules]
    .flatMap((value) => (Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []));

  // A blanket "this passenger type is free" claim cannot coexist with a real,
  // positively-priced fare for that same type — if both are present, the 0
  // entry describes a NARROWER band (usually infants), not a free-for-all.
  //
  // This is the time-independent backstop for isInfantShapedAge, which reads
  // the current year: real data labels an infant tier by BIRTH YEARS
  // ("2024-2026 он"), so as those children age out the range stops looking
  // infant-shaped and the very same 0/"Үнэгүй" rule would silently flip into
  // "children are free" — handing out a real 750,000₮ child seat. Caught by a
  // clock-shift sweep landing in 2028; without this guard the bug was
  // invisible today and would have surfaced on its own years later.
  const hasCompetingPaidFare = rules.some((rule) => {
    if (typeof rule.price !== "number" || rule.price <= 0) return false;
    const label = normText(typeof rule.label === "string" ? rule.label : "");
    const ageRange = typeof rule.age_range === "string" ? rule.age_range : "";
    const infantShaped = isInfantShapedAge(label, ageRange);
    return target === "infant" ? infantShaped : !infantShaped;
  });
  if (hasCompetingPaidFare) return false;

  return rules.some((rule) => {
    if (typeof rule.price !== "number" || rule.price !== 0) return false;
    const note = normText(typeof rule.note === "string" ? rule.note : "");
    if (!note.includes("үнэгүй") && !note.includes("free")) return false;
    const label = normText(typeof rule.label === "string" ? rule.label : "");
    const ageRange = typeof rule.age_range === "string" ? rule.age_range : "";
    const infantShaped = isInfantShapedAge(label, ageRange);
    if (target === "infant") return infantShaped;
    // target === "child": must be labelled a child tier AND not actually an
    // infant tier that happened to get the "Хүүхэд" label — an infant-shaped
    // 0/free rule must never zero out a real, separately-priced child tier.
    return (label.includes("хүүхэд") || label.includes("child")) && !infantShaped;
  });
}

export function getStructuredPriceGroups(trip: TravelTrip): Array<Record<string, unknown>> {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  if (Array.isArray(extra.price_groups) && extra.price_groups.length > 0) {
    // Trip-level, not per-group: the "infants ride free" note in child_rules
    // is a blanket policy statement, not tied to a specific departure tier.
    const childFree = isDocumentedFreeFare(trip, "child");
    const infantFree = isDocumentedFreeFare(trip, "infant");
    return (extra.price_groups as Array<Record<string, unknown>>).map((group) => {
      const hasAdult = typeof group.adult_price === "number";
      const hasChild = typeof group.child_price === "number";
      const hasInfant = typeof group.infant_price === "number";
      // Malformed import: a group carrying ONLY an infant price (no adult/child) is
      // not a real tier. Rendered verbatim it drops the adult and child and shows
      // just the infant line. Backfill adult/child from the trip's base prices so
      // the customer still sees the full price. Well-formed groups pass untouched.
      const base = !hasAdult && !hasChild && hasInfant
        ? {
            ...group,
            adult_price: typeof trip.adult_price === "number" ? trip.adult_price : group.adult_price,
            child_price: typeof trip.child_price === "number" ? trip.child_price : group.child_price,
          }
        : group;
      if (!childFree && !infantFree) return base;
      return {
        ...base,
        ...(childFree ? { child_price_free: true } : {}),
        ...(infantFree ? { infant_price_free: true } : {}),
      };
    });
  }
  return [];
}

export function getStructuredDiscounts(trip: TravelTrip): Array<Record<string, unknown>> {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  if (Array.isArray(extra.discounts) && extra.discounts.length > 0) {
    return extra.discounts as Array<Record<string, unknown>>;
  }
  return [];
}

export function getTripSearchHaystack(trip: TravelTrip): string {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  const sections: string[] = [
    trip.route_name,
    trip.source_description || "",
    trip.notes || "",
    ...trip.departure_dates,
    ...getAliases(trip),
  ];

  const appendGroupText = (items: Array<Record<string, unknown> | DepartureDateGroup>) => {
    for (const item of items) {
      sections.push(...getGroupDateTexts(item));
      const record = item as Record<string, unknown>;
      for (const key of ["label", "note", "notes", "condition"]) {
        if (typeof record[key] === "string" && record[key].trim()) {
          sections.push(record[key] as string);
        }
      }
    }
  };

  appendGroupText(getStructuredPriceGroups(trip));
  appendGroupText(getStructuredDiscounts(trip));
  appendGroupText(getPriceGroups(trip));

  for (const key of ["child_rules", "room_prices"]) {
    const items = extra[key];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      for (const value of Object.values(item as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim()) sections.push(value);
      }
    }
  }

  return normText(sections.join(" "));
}

/**
 * Name + alias text only — deliberately excludes notes, departure dates and
 * price-group labels.
 *
 * `getTripSearchHaystack` folds all of those in, which is right for "does this
 * trip mention X at all" lookups but wrong for "is this one of the trips the
 * customer named". A formatted date label such as "8 сарын 6, 13-ны болон
 * 20-ны гаралт" puts the connector "болон" ("and") inside an unrelated trip's
 * haystack, so comparing "<аялал А> болон <аялал Б>" pulled in a third tour whose only
 * connection to the question was the word "and".
 */
export function getTripNameHaystack(trip: TravelTrip): string {
  return normText([trip.route_name, ...getAliases(trip)].join(" "));
}

function tripSearchTokens(trip: TravelTrip): string[] {
  return unique([
    ...keywordTokens(trip.route_name),
    ...getAliases(trip).flatMap((alias) => keywordTokens(alias)),
    ...keywordTokens(trip.category || ""),
    ...keywordTokens(trip.source_description || ""),
    ...keywordTokens(trip.notes || ""),
  ]);
}

function queryTripTokenCoveragePenalty(queryWords: string[], trip: TravelTrip): number {
  const candidateTokens = new Set(tripSearchTokens(trip));
  const meaningfulQueryWords = queryWords.filter((word) => word.length >= 4);
  const missing = meaningfulQueryWords.filter((word) => !candidateTokens.has(word));
  if (meaningfulQueryWords.length <= 1) return 0;
  if (missing.length === 0) return 0;
  return missing.length * 70;
}

export function matchScoreForPriceKind(kind: CombinedDatePriceMatch["matchType"]): number {
  switch (kind) {
    case "adult":
      return 100;
    case "child":
      return 90;
    case "infant":
      return 80;
    case "passenger":
      return 70;
    case "discount":
      return 60;
    default:
      return 10;
  }
}

export function getPriceValuesFromGroup(
  group: Record<string, unknown> | DepartureDateGroup,
  defaultAdultKind: "adult" | "discount",
): Array<{ kind: CombinedDatePriceMatch["matchType"]; value: number }> {
  const raw = group as Record<string, unknown>;
  const values: Array<{ kind: CombinedDatePriceMatch["matchType"]; value: number }> = [];

  const push = (kind: CombinedDatePriceMatch["matchType"], value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) values.push({ kind, value });
  };

  push(defaultAdultKind, raw.adult_price);
  push("child", raw.child_price);
  push("infant", raw.infant_price);

  if (Array.isArray(raw.passenger_prices)) {
    for (const item of raw.passenger_prices) {
      if (!item || typeof item !== "object") continue;
      push("passenger", (item as Record<string, unknown>).price);
    }
  }

  return values;
}

type TripMatchOptions = {
  includeSoldOut?: boolean;
};

function canMatchTripStatus(trip: TravelTrip, options?: TripMatchOptions): boolean {
  if (trip.status === "active") return true;
  return options?.includeSoldOut === true && trip.status === "sold_out";
}

function extractQueryMonthDays(text: string): MonthDay[] {
  const normalized = normText(text);
  const values: MonthDay[] = [];
  const push = (month: number, day: number) => {
    if (!Number.isInteger(month) || !Number.isInteger(day)) return;
    if (month < 1 || month > 12 || day < 1 || day > 31) return;
    values.push({ month, day });
  };

  for (const match of normalized.matchAll(/(\d{1,2})\s*(?:р\s*)?сар(?:ын)?\s*(\d{1,2})/g)) {
    push(Number(match[1]), Number(match[2]));
  }
  for (const match of normalized.matchAll(/(?<![\d./-])(\d{1,2})[./-](\d{1,2})(?![\d./-])/g)) {
    push(Number(match[1]), Number(match[2]));
  }

  return uniqueMonthDays(values);
}

function textHasMonthDay(text: string, date: MonthDay): boolean {
  const normalized = normText(text);
  const month = String(date.month);
  const monthPadded = month.padStart(2, "0");
  const day = String(date.day);
  const dayPadded = day.padStart(2, "0");
  const variants = [
    `${month} сарын ${day}`,
    `${monthPadded} сарын ${day}`,
    `${month} сарын ${dayPadded}`,
    `${monthPadded} сарын ${dayPadded}`,
    `${month}/${day}`,
    `${monthPadded}/${day}`,
    `${month}/${dayPadded}`,
    `${monthPadded}/${dayPadded}`,
  ];
  return variants.some((variant) => normalized.includes(normText(variant)));
}

function tripHasMonthDay(trip: TravelTrip, date: MonthDay): boolean {
  const dateTexts = [
    ...trip.departure_dates,
    ...getStructuredPriceGroups(trip).flatMap(getGroupDateTexts),
    ...getStructuredDiscounts(trip).flatMap(getGroupDateTexts),
    ...getPriceGroups(trip).flatMap(getGroupDateTexts),
  ];
  return dateTexts.some((value) => textHasMonthDay(value, date));
}

const SHANGHAI_SIGNALS = ["\u0448\u0430\u043d\u0445\u0430\u0439", "shanghai"];
const ZHANGJIAJIE_TENGER_SIGNALS = [
  "\u0436\u0430\u043d\u0436\u0438\u0430\u0436\u044d",
  "\u0436\u0430\u043d\u0433\u0436\u0438\u0430\u0436\u044d",
  "zhangjiajie",
  "\u0442\u044d\u043d\u0433\u044d\u0440\u0438\u0439\u043d \u0445\u0430\u0430\u043b\u0433\u0430",
];

function includesAnySignal(text: string, signals: string[]): boolean {
  return signals.some((signal) => text.includes(signal));
}

function hasShanghaiZhangjiajieIntent(query: string): boolean {
  const normalizedQuery = normText(query);
  return (
    includesAnySignal(normalizedQuery, SHANGHAI_SIGNALS) &&
    includesAnySignal(normalizedQuery, ZHANGJIAJIE_TENGER_SIGNALS)
  );
}

function tripTextForVariantSignals(trip: TravelTrip): string {
  return normText([
    trip.route_name,
    trip.source_description || "",
    ...getAliases(trip),
  ].join(" "));
}

function tripMatchesShanghaiZhangjiajieVariant(trip: TravelTrip): boolean {
  const tripText = tripTextForVariantSignals(trip);
  return (
    includesAnySignal(tripText, SHANGHAI_SIGNALS) &&
    includesAnySignal(tripText, ZHANGJIAJIE_TENGER_SIGNALS)
  );
}

function shanghaiZhangjiajieIntentScore(query: string, trip: TravelTrip): number {
  if (!hasShanghaiZhangjiajieIntent(query)) return 0;

  const tripText = tripTextForVariantSignals(trip);
  if (includesAnySignal(tripText, SHANGHAI_SIGNALS)) return 220;
  if (includesAnySignal(tripText, ZHANGJIAJIE_TENGER_SIGNALS)) return -160;
  return 0;
}

export function findTripMatches(text: string, trips: TravelTrip[], options?: TripMatchOptions): TripMatch[] {
  const query = normText(text);
  const queryPhonetic = phoneticLatinText(text);
  const queryWords = unique(keywordTokens(text));
  const queryPhoneticWords = unique(phoneticKeywordTokens(text));
  if (!queryWords.length && !queryPhoneticWords.length) return [];
  const landOnly = queryWantsLandOnlyEnhanced(text);
  const wantsCombo = queryWantsLandFlightCombo(text);
  const wantsDirectFlight = queryWantsDirectFlight(text) && !wantsCombo;
  const wantsFlight = queryWantsFlight(text);
  const wantsSeaBeach = queryWantsSeaBeach(text);
  const requestedMonthDays = extractQueryMonthDays(text);

  const matches: TripMatch[] = [];
  for (const trip of trips) {
    if (!canMatchTripStatus(trip, options)) continue;
    if (wantsCombo && !tripMatchesLandFlightComboIntent(trip)) continue;
    if (wantsDirectFlight && !tripIsDirectFlight(trip)) continue;
    if (landOnly && !wantsFlight && !tripIsLandOnly(trip)) continue;
    if (wantsSeaBeach && !tripHasSeaBeach(trip)) continue;
    if (landOnly && tripIsCruise(trip)) continue;

    const routeNorm = normText(trip.route_name);
    const routePhonetic = phoneticLatinText(trip.route_name);
    const routeKeywords = unique(keywordTokens(trip.route_name));
    const routePhoneticKeywords = unique(phoneticKeywordTokens(trip.route_name));
    if (!routeKeywords.length && !routePhoneticKeywords.length) continue;

    // Check aliases — full string OR token-level overlap.
    // This means an alias like "Жанжиажэ" (stored in DB) will match
    // a query containing "жанжиажэ" even without hardcoded replacements.
    //
    // Bug (found 2026-07-17 replaying real traffic): "Beejin jinin janjakow
    // ereen 4 hotiin aylal" — naming the 4-city Beijing/Jining/Zhangjiakou/
    // Erlian trip by 4 of its own route-name words — matched the UNRELATED
    // Erlian-Beijing-Tianjin-Jeju CRUISE instead, because the cruise's alias
    // "Эрээн Бээжин Тяньжин Чежү Пусан круз" loosely shares 2 destination
    // tokens (Эрээн, Бээжин — both common waypoints on many China routes) and
    // a full alias hit was worth a flat 80, drowning out the 4-city trip's 4
    // real matched route-name words (80 vs 4*20=80, plus the cruise's own
    // partial route match tipped it over). A full/exact alias string match is
    // a strong, deliberate signal (e.g. "Жанжиажэ" naming a whole trip) and
    // keeps its full weight; a LOOSE token-overlap hit on a long multi-word
    // alias is only as strong as the fraction of that alias it covers, so 2
    // of 6 words no longer outweighs a direct 4-word route-name match.
    const aliases = getAliases(trip);
    let aliasHit = 0;
    for (const alias of aliases) {
      const aliasNorm = normText(alias);
      if (query.includes(aliasNorm) || aliasNorm.includes(query)) {
        aliasHit = 1;
        break;
      }
      const aliasPhonetic = phoneticLatinText(alias);
      if (
        aliasPhonetic &&
        queryPhonetic &&
        (queryPhonetic.includes(aliasPhonetic) || aliasPhonetic.includes(queryPhonetic))
      ) {
        aliasHit = 1;
        break;
      }
      if (hasLooseAliasMatch(query, queryWords, alias, queryPhonetic, queryPhoneticWords)) {
        const aliasTokenCount = Math.max(1, unique(keywordTokens(alias)).length);
        const looseStrength = aliasTokenCount <= 2 ? 1 : Math.min(1, 2 / aliasTokenCount);
        aliasHit = Math.max(aliasHit, looseStrength);
      }
    }

    const matchedWords = unique([
      ...routeKeywords.filter((word) => queryWords.includes(word)),
      ...routePhoneticKeywords.filter((word) =>
        queryPhoneticWords.some((queryWord) => phoneticTokenMatches(queryWord, word)),
      ),
    ]);
    const routeTokenPool = unique([...routeKeywords, ...routePhoneticKeywords]);
    const coverage = matchedWords.length / routeTokenPool.length;
    const exactRouteHit = query.includes(routeNorm) || (routePhonetic.length > 0 && queryPhonetic.includes(routePhonetic)) ? 1 : 0;
    const minMatchCount = routeTokenPool.length === 1 ? 1 : 2;
    const strongTokenHit = matchedWords.some((word) => word.length >= 4);

    if (matchedWords.length < minMatchCount && exactRouteHit === 0 && aliasHit === 0 && !strongTokenHit) continue;
    if (coverage < 0.5 && exactRouteHit === 0 && aliasHit === 0 && !strongTokenHit) continue;

    // Discount boost: when user asks about discounts, rank trips with discounts higher
    let discountBoost = 0;
    if (DISCOUNT_KEYWORDS_MN.some((kw) => query.includes(kw))) {
      const tripExtra = (trip.extra || {}) as Record<string, unknown>;
      const hasAdminDiscounts = Array.isArray(tripExtra.discounts) && (tripExtra.discounts as unknown[]).length > 0;
      const nameHasDiscount = DISCOUNT_KEYWORDS_MN.some((kw) =>
        normText(trip.route_name).includes(kw) ||
        normText(trip.source_description || "").includes(kw),
      );
      if (hasAdminDiscounts) discountBoost = 60;
      else if (nameHasDiscount) discountBoost = 40;
    }

    const isCombo = tripIsLandFlightCombo(trip);
    const isCruise = tripIsCruise(trip);
    const tripCat = normText(trip.category || "");
    let intentBoost = 0;
    if (landOnly) {
      if (tripCat.includes("газрын аялал")) intentBoost += 160;
      if (isCombo && !wantsFlight) intentBoost -= 220;
      if (!tripCat.includes("газрын аялал")) intentBoost -= 180;
      if (isCruise) intentBoost -= 260;
    }
    if (wantsCombo) {
      if (isCombo) intentBoost += 160;
      else if (tripMatchesLandFlightComboIntent(trip)) intentBoost += 120;
      else intentBoost -= 140;
    }
    if (wantsFlight && isCombo) intentBoost += 35;
    if (wantsSeaBeach && tripHasSeaBeach(trip)) intentBoost += 180;

    let dateBoost = 0;
    if (requestedMonthDays.length > 0) {
      dateBoost = requestedMonthDays.some((date) => tripHasMonthDay(trip, date))
        ? 180
        : -40;
    }

    const score =
      exactRouteHit * 100 +
      aliasHit * 80 +
      matchedWords.length * 20 +
      coverage * 10 -
      Math.max(0, routeKeywords.length - matchedWords.length) +
      discountBoost +
      intentBoost +
      dateBoost +
      shanghaiZhangjiajieIntentScore(text, trip) +
      durationVariantScore(text, trip) +
      examFeeIntentScore(text, trip) -
      queryTripTokenCoveragePenalty(queryWords, trip);

    matches.push({
      trip,
      matchedWords,
      keywordCoverage: coverage,
      score,
    });
  }

  return matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.matchedWords.length !== a.matchedWords.length) {
      return b.matchedWords.length - a.matchedWords.length;
    }
    return a.trip.route_name.localeCompare(b.trip.route_name, "mn");
  });
}

export function resolveTripFromUserMessage(
  text: string,
  trips: TravelTrip[],
  options: { allowLooseFallback?: boolean } & TripMatchOptions = {},
): TripResolution {
  const allowLooseFallback = options.allowLooseFallback !== false;
  const matches = findTripMatches(text, trips, options);
  if (!matches.length) {
    const looseBest = allowLooseFallback ? findLooseTripMatch(text, trips, options) : null;
    return looseBest
      ? { status: "verified", trip: looseBest, candidates: [] }
      : { status: "not_found", trip: null, candidates: [] };
  }

  const [best, second] = matches;
  const requestedMonthDays = extractQueryMonthDays(text);
  if (requestedMonthDays.length > 0) {
    const datedMatches = matches.filter((match) =>
      requestedMonthDays.some((date) => tripHasMonthDay(match.trip, date)),
    );
    if (datedMatches.length === 1) {
      return { status: "verified", trip: datedMatches[0].trip, candidates: [] };
    }
  }
  const hasSpecificTripPreference =
    queryWantsLandOnlyEnhanced(text) ||
    queryWantsLandFlightCombo(text) ||
    queryWantsDirectFlight(text) ||
    queryWantsFlight(text) ||
    queryWantsSeaBeach(text) ||
    hasDisambiguatingModifier(text);
  // Strongest possible signal: the customer typed one tour's COMPLETE name.
  // Checked before the ambiguity test below, because sibling tours are often
  // supersets of each other's names ("Жинин-Мини аватар-Хөх хотын аялал" is a
  // prefix of "…-Хөх хот - Ордос хотын аялал"), so name-word coverage alone
  // would call a fully-typed name ambiguous and ask a pointless question.
  const normalizedQuery = normText(text);
  const fullNameMentions = matches.filter((match) => {
    const name = normText(match.trip.route_name);
    return name.length >= 8 && normalizedQuery.includes(name);
  });
  if (fullNameMentions.length === 1) {
    return { status: "verified", trip: fullNameMentions[0].trip, candidates: [] };
  }

  const shanghaiZhangjiajieMentions = hasShanghaiZhangjiajieIntent(text)
    ? matches.filter((match) => tripMatchesShanghaiZhangjiajieVariant(match.trip))
    : [];
  if (shanghaiZhangjiajieMentions.length === 1) {
    return { status: "verified", trip: shanghaiZhangjiajieMentions[0].trip, candidates: [] };
  }

  // Trips the customer's words do not rule out: every route word they typed
  // appears in the trip's own name. When several qualify, their message simply
  // does not say which tour they mean — "Тэнгэрийн хаалга" is the name of three
  // different ones — so the top score is not evidence of intent. Committing to
  // it ships a wrong price, programme AND poster at full confidence, which is
  // how a customer ends up holding a poster for the tour they did not ask
  // about. Ask the question a human agent would ask instead.
  const queryRouteTokens = routeContentTokens(text);
  const indistinguishable = hasSpecificTripPreference
    ? []
    : matches.filter((match) => tripNameCoversQuery(match.trip, queryRouteTokens));
  const routeOnlyQuestion =
    !hasSpecificTripPreference &&
    matches.length > 1 &&
    (queryRouteTokens.length === 1 || indistinguishable.length > 1);
  if (routeOnlyQuestion) {
    const candidates = indistinguishable.length > 1 ? indistinguishable : matches;
    return {
      status: "ambiguous",
      trip: null,
      candidates: candidates.slice(0, 3).map((match) => match.trip),
    };
  }
  // Exactly one trip's own name contains everything the customer typed, and it
  // is also the top match. That is a direct naming of that tour, so the
  // near-tie test below must not turn it into a "which one did you mean?" —
  // a rival that merely shares one generic word ("онгоцны") can sit within the
  // score margin without being a plausible reading of the question at all.
  // Gated on `best` so a weak covering match cannot outrank a stronger one.
  if (indistinguishable.length === 1 && indistinguishable[0].trip.id === best.trip.id) {
    return { status: "verified", trip: indistinguishable[0].trip, candidates: [] };
  }

  if (
    second &&
    best.score - second.score <= 5 &&
    Math.abs(best.keywordCoverage - second.keywordCoverage) <= 0.15
  ) {
    return { status: "ambiguous", trip: null, candidates: matches.slice(0, 3).map((match) => match.trip) };
  }

  // Exactly one trip's own name contains everything the customer typed. That is
  // a direct naming of that tour: it outranks the similarity score (which can
  // favour a shorter name that merely shares tokens) and it settles the query,
  // so the weak-evidence guard below must not second-guess it.
  if (indistinguishable.length === 1) {
    return { status: "verified", trip: indistinguishable[0].trip, candidates: [] };
  }

  // Every candidate scored negative: the query shares only weak, generic signal
  // with these names — typically romanised input that did not transliterate
  // cleanly ("shanghai" vs "шанхай" → "shanhai"). A negative best score is not
  // evidence of intent, and guessing on it is how "shanghai tengerin haalga"
  // returned the standalone Тэнгэрийн хаалга tour instead of the Шанхай one.
  if (best.score <= 0 && matches.length > 1) {
    return {
      status: "ambiguous",
      trip: null,
      candidates: matches.slice(0, 3).map((match) => match.trip),
    };
  }

  return { status: "verified", trip: best.trip, candidates: [] };
}

export function findBestTripMatch(text: string, trips: TravelTrip[], options?: TripMatchOptions) {
  const resolution = resolveTripFromUserMessage(text, trips, options);
  if (resolution.status === "verified") return { best: resolution.trip, ambiguous: [] as TravelTrip[] };
  if (resolution.status === "ambiguous") return { best: null, ambiguous: resolution.candidates };
  return { best: null, ambiguous: [] as TravelTrip[] };
}

function hasLooseAliasMatch(
  query: string,
  queryKeywords: string[],
  alias: string,
  queryPhonetic = "",
  queryPhoneticKeywords: string[] = [],
): boolean {
  const aliasNorm = normText(alias);
  if (query.includes(aliasNorm) || aliasNorm.includes(query)) return true;

  const aliasPhonetic = phoneticLatinText(alias);
  if (
    aliasPhonetic &&
    queryPhonetic &&
    (queryPhonetic.includes(aliasPhonetic) || aliasPhonetic.includes(queryPhonetic))
  ) {
    return true;
  }

  const aliasTokens = unique(keywordTokens(alias));
  const aliasPhoneticTokens = unique(phoneticKeywordTokens(alias));
  if (!aliasTokens.length && !aliasPhoneticTokens.length) return false;

  const overlap = aliasTokens.filter((token) => queryKeywords.includes(token)).length;
  const phoneticOverlap = aliasPhoneticTokens.filter((token) => queryPhoneticKeywords.includes(token)).length;
  const requiredOverlap = aliasTokens.length === 1 ? 1 : Math.min(2, aliasTokens.length);
  const requiredPhoneticOverlap = aliasPhoneticTokens.length === 1 ? 1 : Math.min(2, aliasPhoneticTokens.length);
  return overlap >= requiredOverlap || phoneticOverlap >= requiredPhoneticOverlap;
}

export function queryExplicitlyRejectsFlight(query: string): boolean {
  const normalized = normText(query);
  return (
    normalized.includes("нислэггүй") ||
    normalized.includes("газрын аялал") ||
    normalized.includes("газрын аяллын") ||
    normalized.includes("газраар") ||
    normalized.includes("автобусаар") ||
    normalized.includes("галт тэрэг") ||
    normalized.includes("no flight") ||
    normalized.includes("land tour")
  );
}

export function queryWantsLandOnlyEnhanced(query: string): boolean {
  const normalized = normText(query);
  if (queryExplicitlyRejectsFlight(query)) return true;

  const explicitlyWantsFlight =
    normalized.includes("газар нислэг") ||
    normalized.includes("хосолсон") ||
    normalized.includes("онгоц") ||
    normalized.includes("нислэгтэй");
  if (explicitlyWantsFlight) return false;

  return (
    normalized.includes("газрын аялал") ||
    normalized.includes("газрын аяллын") ||
    normalized.includes("газрын") ||
    normalized.includes("газраар") ||
    normalized.includes("автобусаар") ||
    normalized.includes("галт тэрэг") ||
    normalized.includes("land tour")
  );
}

export function queryWantsLandFlightCombo(query: string): boolean {
  const normalized = normText(query);
  if (queryExplicitlyRejectsFlight(query)) return false;
  return (
    normalized.includes("газар нислэг") ||
    normalized.includes("нислэг хосолсон") ||
    normalized.includes("хосолсон")
  );
}

// Whether the query explicitly mentions a flight component.
export function queryWantsFlight(query: string): boolean {
  if (queryExplicitlyRejectsFlight(query)) return false;
  // "Онгоцны тийз багтсан уу?" asks what the fare covers — it is not a request
  // for a flight-based tour. Left in, the bare "онгоц" made this read as a trip
  // preference, which suppressed the name-coverage check and let the cruise
  // ("Усан онгоцны аялал") stand as a rival candidate to a tour the customer
  // had already named. Drop the ticket phrase before judging preference.
  const withoutTicketPhrases = query.replace(
    /(?:онгоцны|нислэгийн)?\s*тийз(?:ний|гүй|тэй)?/gi,
    " ",
  );
  return /нислэг|онгоц|хосолсон|нислэгтэй/i.test(withoutTicketPhrases);
}

export function queryWantsDirectFlight(query: string): boolean {
  const normalized = normText(query);
  return (
    normalized.includes("шууд нислэг") ||
    normalized.includes("шууд нислэгтэй") ||
    normalized.includes("direct flight")
  );
}

export function queryWantsSeaBeach(query: string): boolean {
  const normalized = normText(query);
  return (
    normalized.includes("далай") ||
    normalized.includes("далайн") ||
    normalized.includes("далайтай") ||
    normalized.includes("тэнгис") ||
    normalized.includes("тэнгисийн") ||
    normalized.includes("эрэг") ||
    normalized.includes("beach") ||
    normalized.includes("sea") ||
    normalized.includes("seaside")
  );
}

function tripHasSeaBeach(trip: TravelTrip): boolean {
  const haystack = normText(
    [
      trip.category || "",
      trip.route_name,
      trip.source_description || "",
      trip.notes || "",
      ...getAliases(trip),
    ].join(" "),
  );
  return (
    haystack.includes("далай") ||
    haystack.includes("далайн") ||
    haystack.includes("тэнгис") ||
    haystack.includes("тэнгисийн") ||
    haystack.includes("эрэг") ||
    haystack.includes("beach") ||
    haystack.includes("sea") ||
    haystack.includes("seaside")
  );
}

function hasDisambiguatingModifier(query: string): boolean {
  const normalized = normText(query);
  return (
    normalized.includes("наадам") ||
    normalized.includes("наадмын") ||
    normalized.includes("парк") ||
    normalized.includes("усан") ||
    normalized.includes("shopping") ||
    normalized.includes("дэлгүүр") ||
    normalized.includes("хямд") ||
    normalized.includes("хамгийн") ||
    normalized.includes("тусгай") ||
    /(\d{1,2})\s*(өдөр|шөнө)/.test(normalized)
  );
}

function tripSearchText(trip: TravelTrip): string {
  return normText([
    trip.route_name,
    trip.duration_text,
    trip.category,
    trip.notes,
    trip.source_description,
    ...getAliases(trip),
  ].filter(Boolean).join(" "));
}

function durationVariantScore(query: string, trip: TravelTrip): number {
  const normalized = normText(query);
  const haystack = tripSearchText(trip);
  let score = 0;
  for (const match of normalized.matchAll(/(\d{1,2})\s*(өдөр|шөнө)/g)) {
    const amount = match[1];
    const unit = match[2];
    const target = `${amount} ${unit}`;
    const hasTarget = haystack.includes(target);
    const hasCompetingSameUnit = new RegExp(`\\d{1,2}\\s*${unit}`).test(haystack);
    if (hasTarget) score += 120;
    else if (hasCompetingSameUnit) score -= 120;
  }
  return score;
}

function examFeeIntentScore(query: string, trip: TravelTrip): number {
  const normalized = normText(query);
  const asksFreeExam = normalized.includes("үнэгүй шинжилгээ");
  const asksPaidExam = normalized.includes("үнэтэй шинжилгээ") || normalized.includes("төлбөртэй шинжилгээ");
  if (!asksFreeExam && !asksPaidExam) return 0;

  const haystack = tripSearchText(trip);
  const extra = (trip.extra || {}) as Record<string, unknown>;
  const hasExamFees = Array.isArray(extra.extra_fees) &&
    (extra.extra_fees as Array<Record<string, unknown>>).some((fee) =>
      typeof fee.label === "string" && normText(fee.label).includes("шинжилгээ"),
    );

  if (asksFreeExam) {
    if (haystack.includes("үнэгүй шинжилгээ")) return 180;
    if (haystack.includes("үнэтэй шинжилгээ") || hasExamFees) return -180;
  }
  if (asksPaidExam) {
    if (haystack.includes("үнэтэй шинжилгээ") || hasExamFees) return 180;
    if (haystack.includes("үнэгүй шинжилгээ")) return -180;
  }
  return 0;
}

/**
 * A trip's own identity text — route name plus aliases, nothing else. Notes,
 * descriptions and day-by-day itineraries are deliberately excluded: a city
 * mentioned in passing inside a programme must not make that trip look like a
 * name match for the city the customer asked about.
 */
function tripIdentityText(trip: TravelTrip): string {
  return normText([trip.route_name, ...getAliases(trip)].join(" "));
}

/**
 * True when every route word the customer typed appears in this trip's own
 * name — i.e. nothing in their message rules this trip out.
 *
 * Checked against the Cyrillic name AND its phonetic Latin form, because real
 * customers type romanised Mongolian ("shanghai tengerin haalga"). Comparing
 * Latin input to a Cyrillic-only name matches nothing, which would make an
 * ambiguous query look specific and send one tour's price and poster.
 */
function tripNameCoversQuery(trip: TravelTrip, tokens: string[]): boolean {
  if (!tokens.length) return false;
  const identity = tripIdentityText(trip);
  const identityLatin = phoneticLatinText(identity);
  return tokens.every((token) => {
    if (identity.includes(token)) return true;
    const latinToken = phoneticLatinText(token);
    return Boolean(latinToken) && identityLatin.includes(latinToken);
  });
}

function routeContentTokens(query: string): string[] {
  const filler = new Set([
    "хэд",
    "юу",
    "вэ",
    "уу",
    "байна",
    "байгаа",
    "бол",
    "болно",
    "талаар",
    "мэдээлэл",
    "мэдээ",
    "авах",
    "авъя",
    "авя",
    "awy",
    "medeelel",
    "medee",
    "une",
    "hed",
    "ve",
    "uu",
    "baina",
    "yu",
    // Cyrillic counterparts of the Latin filler above. Without these, "Тэнгэрийн
    // хаалга үнэ хэд вэ?" keeps "үнэ" as a route token, no trip name contains
    // it, and the ambiguity check below silently concludes the query is
    // specific — the exact path that answered a 3-way ambiguous name with one
    // confident price.
    "үнэ",
    "үнийн",
    "зураг",
    "зургууд",
    "хөтөлбөр",
    "хөтөлбөрийг",
    "үзэх",
    "үзүүлээч",
    "харах",
    "харуулаач",
    // Words that belong to the QUESTION, not to a destination. "онгоцны тийз"
    // ("plane ticket") made "<аялал> онгоцны тийз багтсан уу?" nominate the
    // cruise tour, whose name contains "онгоцны" ("Усан онгоцны аялал"), so a
    // customer who named their trip was asked which trip they meant.
    "онгоц",
    "онгоцны",
    "нислэгийн",
    "тийз",
    "тийзний",
    "багтсан",
    "багтаагүй",
    "орсон",
    "хоол",
    "хооллолт",
  ]);
  return unique(keywordTokens(query).filter((token) => !filler.has(token)));
}

// Whether a trip is a land+flight combo based on its category or name.
export function tripIsLandFlightCombo(trip: TravelTrip): boolean {
  const haystack = normText(
    [
      trip.category || "",
      trip.route_name,
      trip.source_description || "",
      trip.notes || "",
      ...getAliases(trip),
    ].join(" "),
  );
  return (
    haystack.includes("газар нислэг") ||
    (haystack.includes("газар") &&
      haystack.includes("нислэг") &&
      haystack.includes("хосолсон"))
  );
}

function tripMatchesLandFlightComboIntent(trip: TravelTrip): boolean {
  if (tripIsLandFlightCombo(trip)) return true;
  const haystack = normText(
    [
      trip.category || "",
      trip.route_name,
      trip.source_description || "",
      trip.notes || "",
      ...getAliases(trip),
    ].join(" "),
  );
  // Some imported combo products say only "хосолсон аялал" in the source
  // description, not the stricter "газар нислэг хосолсон" category. When the
  // customer explicitly asks for a land+flight/combo variant, include these
  // inferred combo trips so the resolver does not fall through to the model
  // and guess the plain direct-flight sibling.
  return haystack.includes("хосолсон") && !tripIsDirectFlight(trip);
}

function tripIsLandOnly(trip: TravelTrip): boolean {
  if (tripIsLandFlightCombo(trip)) return false;
  const haystack = normText(
    [
      trip.category || "",
      trip.route_name,
      trip.source_description || "",
      trip.notes || "",
      ...getAliases(trip),
    ].join(" "),
  );
  return (
    haystack.includes("газрын аялал") ||
    haystack.includes("газрын") ||
    haystack.includes("газраар") ||
    haystack.includes("автобус") ||
    haystack.includes("галт тэрэг") ||
    haystack.includes("нислэггүй")
  );
}

export function tripIsDirectFlight(trip: TravelTrip): boolean {
  if (tripIsLandFlightCombo(trip)) return false;
  const haystack = normText(
    [
      trip.category || "",
      trip.route_name,
      trip.source_description || "",
      trip.notes || "",
      ...getAliases(trip),
    ].join(" "),
  );
  return (
    haystack.includes("шууд нислэг") ||
    haystack.includes("шууд нислэгтэй") ||
    haystack.includes("direct flight")
  );
}

export function tripIsCruise(trip: TravelTrip): boolean {
  const category = normText(trip.category || "");
  const name = normText(trip.route_name);
  return (
    category.includes("круз") ||
    category.includes("усан онгоц") ||
    name.includes("круз") ||
    name.includes("усан онгоц")
  );
}

function findLooseTripMatch(text: string, trips: TravelTrip[], options?: { hasBrochureIntent?: boolean } & TripMatchOptions) {
  const query = normText(text);
  const queryPhonetic = phoneticLatinText(text);
  // Use keywordTokens() so generic route words (газар, нислэг, аялал, хосолсон…)
  // don't act as false-positive boosters and rank the wrong trip higher.
  const queryKeywords = unique(keywordTokens(text));
  const queryPhoneticKeywords = unique(phoneticKeywordTokens(text));
  const landOnly = queryWantsLandOnlyEnhanced(text);
  const wantsCombo = queryWantsLandFlightCombo(text);
  const wantsDirectFlight = queryWantsDirectFlight(text) && !wantsCombo;
  const wantsFlight = queryWantsFlight(text);
  const wantsSeaBeach = queryWantsSeaBeach(text);
  const hasBrochure = options?.hasBrochureIntent ?? false;
  const requestedMonthDays = extractQueryMonthDays(text);
  let best: TravelTrip | null = null;
  let bestScore = 0;
  let secondScore = 0;

  for (const trip of trips) {
    if (!canMatchTripStatus(trip, options)) continue;
    if (wantsCombo && !tripIsLandFlightCombo(trip)) continue;
    if (wantsDirectFlight && !tripIsDirectFlight(trip)) continue;
    if (landOnly && !wantsFlight && !tripIsLandOnly(trip)) continue;
    if (wantsSeaBeach && !tripHasSeaBeach(trip)) continue;
    if (landOnly && tripIsCruise(trip)) continue;
    const routeNorm = normText(trip.route_name);
    const routePhonetic = phoneticLatinText(trip.route_name);
    // Filter route words through keywordTokens as well (strips GENERIC_ROUTE_WORDS).
    const routeKeywords = unique(keywordTokens(trip.route_name));
    const routePhoneticKeywords = unique(phoneticKeywordTokens(trip.route_name));
    const matchedWordCount = routeKeywords.filter((word) => queryKeywords.includes(word)).length;
    const phoneticMatchedWordCount = routePhoneticKeywords.filter((word) => queryPhoneticKeywords.includes(word)).length;
    const aliases = getAliases(trip);
    const aliasExactHit = aliases.some((alias) => {
      const aliasNorm = normText(alias);
      const aliasPhonetic = phoneticLatinText(alias);
      return query.includes(aliasNorm) || (aliasPhonetic.length > 0 && queryPhonetic.includes(aliasPhonetic));
    }) ? 1 : 0;
    const aliasTokenHit = aliases.some((alias) =>
      hasLooseAliasMatch(query, queryKeywords, alias, queryPhonetic, queryPhoneticKeywords),
    ) ? 1 : 0;
    const exactRouteHit = query.includes(routeNorm) || (routePhonetic.length > 0 && queryPhonetic.includes(routePhonetic)) ? 1 : 0;
    let score =
      exactRouteHit * 10 +
      aliasExactHit * 8 +
      aliasTokenHit * 6 +
      Math.max(matchedWordCount, phoneticMatchedWordCount) * 3;

    // Category-intent alignment bonuses and penalties.
    const isCombo = tripIsLandFlightCombo(trip);
    const isCruise = tripIsCruise(trip);
    const tripCat = (trip.category || "").toLowerCase();
    if (landOnly) {
      if (tripCat === "газрын аялал") score += 100;
      // Penalise land+flight combos heavily when user said "газрын аялал".
      if (isCombo && !wantsFlight) score -= 100;
      if (!tripCat.includes("газрын") || !tripCat.includes("аялал")) score -= 180;
      if (isCruise) score -= 260;
    }
    if (wantsCombo && isCombo) score += 180;
    if (wantsCombo && !isCombo) score -= 180;
    if (wantsFlight && isCombo) score += 50;
    if (wantsSeaBeach && tripHasSeaBeach(trip)) score += 180;
    if (landOnly && tripCat.includes("газрын") && tripCat.includes("аялал")) score += 20;
    if (landOnly && isCombo && !wantsFlight) score -= 50;
    score += durationVariantScore(text, trip);
    score += examFeeIntentScore(text, trip);

    // Bonus when alias is a precise land-only spelling variant.
    const landAliasHit = getAliases(trip).some((alias) => {
      const an = normText(alias);
      const ap = phoneticLatinText(alias);
      return an.includes("газрын") && (query.includes(an) || (ap.length > 0 && queryPhonetic.includes(ap)));
    });
    if (landAliasHit) score += 80;
    const enhancedLandAliasHit = aliases.some((alias) => {
      const an = normText(alias);
      return (
        (an.includes("газрын") || an.includes("газраар") || an.includes("нислэггүй")) &&
        hasLooseAliasMatch(query, queryKeywords, alias, queryPhonetic, queryPhoneticKeywords)
      );
    });
    if (enhancedLandAliasHit && !landAliasHit) score += 100;
    else if (enhancedLandAliasHit) score += 20;

    // Bonus when user wants a brochure and this trip actually has one.
    if (hasBrochure && getTripBrochureAsset(trip)) score += 100;
    if (requestedMonthDays.length > 0) {
      score += requestedMonthDays.some((date) => tripHasMonthDay(trip, date))
        ? 120
        : -30;
    }

    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      best = trip;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  if (!best || bestScore === 0) return null;
  if (bestScore - secondScore <= 1) return null;
  return best;
}

export function isStructuredTripQuestion(text: string) {
  const normalized = normText(text);
  return STRUCTURED_QUERY_SIGNALS.some((signal) => normalized.includes(signal));
}

export function hasProgramIntent(text: string) {
  const normalized = normText(text);
  return (
    PROGRAM_QUERY_SIGNALS.some((signal) => normalized.includes(signal)) ||
    /хөтөлбөр|зураг|өдөр\s*өдөр|program|pdf|itinerary|day\s*by\s*day/i.test(text)
  );
}

export function getTripBrochureAsset(trip: TravelTrip): ProgramAsset | null {
  const id = getTripLooseField(trip, "source_file_attachment_id");
  if (typeof id === "string" && id.length > 0) return { type: "id", value: id };

  const url = getTripLooseField(trip, "brochure_pdf_url");
  if (typeof url === "string" && url.startsWith("https://")) return { type: "url", value: url };
  return null;
}

// getGroupDateTexts lives in travelFastPathsPricing.ts, but getTripSearchHaystack
// (defined above) needs it — re-declared here to avoid a circular import since
// pricing imports search helpers. Kept byte-identical to the pricing copy.
function getGroupDateTexts(group: Record<string, unknown> | DepartureDateGroup): string[] {
  const values: string[] = [];
  const raw = group as Record<string, unknown>;
  for (const key of ["dates", "date_keys", "display_dates"]) {
    const input = raw[key];
    if (!Array.isArray(input)) continue;
    for (const item of input) {
      if (typeof item === "string" && item.trim()) values.push(item.trim());
    }
  }
  return unique(values);
}
