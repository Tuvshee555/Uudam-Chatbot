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

function phoneticTokenMatches(queryToken: string, candidateToken: string): boolean {
  return queryToken === candidateToken || isOneEditApart(queryToken, candidateToken);
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

export function getStructuredPriceGroups(trip: TravelTrip): Array<Record<string, unknown>> {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  if (Array.isArray(extra.price_groups) && extra.price_groups.length > 0) {
    return (extra.price_groups as Array<Record<string, unknown>>).map((group) => {
      const hasAdult = typeof group.adult_price === "number";
      const hasChild = typeof group.child_price === "number";
      const hasInfant = typeof group.infant_price === "number";
      // Malformed import: a group carrying ONLY an infant price (no adult/child) is
      // not a real tier. Rendered verbatim it drops the adult and child and shows
      // just the infant line. Backfill adult/child from the trip's base prices so
      // the customer still sees the full price. Well-formed groups pass untouched.
      if (!hasAdult && !hasChild && hasInfant) {
        return {
          ...group,
          adult_price: typeof trip.adult_price === "number" ? trip.adult_price : group.adult_price,
          child_price: typeof trip.child_price === "number" ? trip.child_price : group.child_price,
        };
      }
      return group;
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
      durationVariantScore(text, trip) +
      examFeeIntentScore(text, trip);

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
  const routeOnlyQuestion =
    !hasSpecificTripPreference &&
    routeContentTokens(text).length === 1 &&
    matches.length > 1;
  if (routeOnlyQuestion) {
    return { status: "ambiguous", trip: null, candidates: matches.slice(0, 3).map((match) => match.trip) };
  }
  if (
    second &&
    best.score - second.score <= 5 &&
    Math.abs(best.keywordCoverage - second.keywordCoverage) <= 0.15
  ) {
    return { status: "ambiguous", trip: null, candidates: matches.slice(0, 3).map((match) => match.trip) };
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
  return /нислэг|онгоц|хосолсон|нислэгтэй/i.test(query);
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
