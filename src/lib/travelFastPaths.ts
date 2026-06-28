/**
 * Fast-path helpers that answer common structured travel questions directly
 * from the DB instead of letting the model guess.
 */

import { parseDepartureDateText } from "./travelDates";
import type { TravelTrip } from "./travelOps";

type DepartureDateGroup = {
  label?: string | null;
  dates?: string[];
  adult_price?: number | null;
  child_price?: number | null;
  infant_price?: number | null;
  notes?: string | null;
};

type TripMatch = {
  trip: TravelTrip;
  matchedWords: string[];
  keywordCoverage: number;
  score: number;
};

type MonthDay = {
  month: number;
  day: number;
};

type CombinedDatePriceMatch = {
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
  trip: TravelTrip;
  brochure: ProgramAsset | null;
  mediaUrls: string[];
};

const SEATS_KEYWORDS_MN = [
  "суудал",
  "зай",
  "хоосон",
  "үлдсэн",
  "бий юу",
  "бий эсэх",
  "хүрэлцэх",
];
const SEATS_KEYWORDS_EN = ["seat", "seats", "available", "left", "space", "vacancy"];

const COMPARE_KEYWORDS_MN = [
  "харьцуул",
  "ялгаа",
  "аль нь дээр",
  "аль нь сайн",
  "ялгаатай",
  "зэрэгцүүл",
  "vs",
];
const COMPARE_KEYWORDS_EN = ["compare", "comparison", "vs", "versus", "difference", "better"];

const DISCOUNT_KEYWORDS_MN = ["хямдрал", "хямдралтай", "хөнгөлөлт", "тусгай", "урамшуулал", "промо"];
const DISCOUNT_KEYWORDS_EN = ["discount", "promo", "promotion", "special", "deal", "offer", "sale"];

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

const DIRECT_FLIGHT_POSITIVE_PATTERNS = [/шууд\s+нислэг/i];
const DIRECT_FLIGHT_NEGATIVE_PATTERNS = [
  /газар\s*\+\s*нислэг/i,
  /газар\s+нислэг\s+хосолсон/i,
  /газар\s+аялал/i,
  /газрын\s+аялал/i,
];

// Only language/script normalizations here — no trip-specific city names.
// City aliases (жанжиажэ, beidaihe, sanya, …) belong in each trip's
// extra.aliases array in the database, editable via the admin panel.
const ALIAS_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bnaadam\b/gi, "наадам"],
  [/наадмын/gi, "наадам"],
  [/\bnisleggvi\b/gi, "нислэггүй"],
  [/\bnisleggui\b/gi, "нислэггүй"],
  [/\bniseleggvi\b/gi, "нислэггүй"],
  [/\bno flight\b/gi, "нислэггүй"],
  [/\bland tour\b/gi, "газрын аялал"],
  [/\bwith ticket\b/gi, "тийзтэй"],
  [/\bwithout ticket\b/gi, "тийзгүй"],
  [/\bticketless\b/gi, "тийзгүй"],
  [/\bticket included\b/gi, "тийзтэй"],
];

function normText(text: string) {
  let normalized = text.toLowerCase();
  for (const [pattern, replacement] of ALIAS_REPLACEMENTS) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized
    .replace(/[+_/\\|()[\],.:;!?-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function keywordTokens(text: string) {
  return normText(text)
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2 && !GENERIC_ROUTE_WORDS.has(word));
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}

function uniqueMonthDays(values: MonthDay[]) {
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

function formatMoney(value: number | null, currency: string) {
  if (typeof value !== "number") return null;
  const formatted = value.toLocaleString("mn-MN");
  const suffix = currency === "MNT" || !currency ? "₮" : ` ${currency}`;
  return `${formatted}${suffix}`;
}

function getPriceGroups(trip: TravelTrip): DepartureDateGroup[] {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  const groups = extra.departure_date_groups;
  return Array.isArray(groups) ? (groups as DepartureDateGroup[]) : [];
}

function getTripLooseField(trip: TravelTrip, key: string): unknown {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  if (key in extra) return extra[key];
  const record = trip as unknown as Record<string, unknown>;
  return record[key];
}

function getAliases(trip: TravelTrip): string[] {
  const raw = getTripLooseField(trip, "aliases");
  return Array.isArray(raw) ? (raw as string[]).filter(Boolean) : [];
}

function getStructuredPriceGroups(trip: TravelTrip): Array<Record<string, unknown>> {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  if (Array.isArray(extra.price_groups) && extra.price_groups.length > 0) {
    return extra.price_groups as Array<Record<string, unknown>>;
  }
  return [];
}

function getStructuredDiscounts(trip: TravelTrip): Array<Record<string, unknown>> {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  if (Array.isArray(extra.discounts) && extra.discounts.length > 0) {
    return extra.discounts as Array<Record<string, unknown>>;
  }
  return [];
}

function getTripSearchHaystack(trip: TravelTrip): string {
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

function matchScoreForPriceKind(kind: CombinedDatePriceMatch["matchType"]): number {
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

function getPriceValuesFromGroup(
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

function findTripMatches(text: string, trips: TravelTrip[]): TripMatch[] {
  const query = normText(text);
  const queryWords = unique(keywordTokens(text));
  if (!queryWords.length) return [];
  const landOnly = queryWantsLandOnlyEnhanced(text);
  const wantsCombo = queryWantsLandFlightCombo(text);
  const wantsFlight = queryWantsFlight(text);

  const matches: TripMatch[] = [];
  for (const trip of trips) {
    if (trip.status !== "active") continue;

    const routeNorm = normText(trip.route_name);
    const routeKeywords = unique(keywordTokens(trip.route_name));
    if (!routeKeywords.length) continue;

    // Check aliases — full string OR token-level overlap.
    // This means an alias like "Жанжиажэ" (stored in DB) will match
    // a query containing "жанжиажэ" even without hardcoded replacements.
    const aliases = getAliases(trip);
    const aliasHit = aliases.some((alias) => {
      const aliasNorm = normText(alias);
      if (query.includes(aliasNorm) || aliasNorm.includes(query)) return true;
      return hasLooseAliasMatch(query, queryWords, alias);
    }) ? 1 : 0;

    const matchedWords = routeKeywords.filter((word) => queryWords.includes(word));
    const coverage = matchedWords.length / routeKeywords.length;
    const exactRouteHit = query.includes(routeNorm) ? 1 : 0;
    const minMatchCount = routeKeywords.length === 1 ? 1 : 2;
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
    const tripCat = normText(trip.category || "");
    let intentBoost = 0;
    if (landOnly) {
      if (tripCat.includes("газрын аялал")) intentBoost += 160;
      if (isCombo && !wantsFlight) intentBoost -= 220;
    }
    if (wantsCombo) {
      if (isCombo) intentBoost += 160;
      else intentBoost -= 140;
    }
    if (wantsFlight && isCombo) intentBoost += 35;

    const score =
      exactRouteHit * 100 +
      aliasHit * 80 +
      matchedWords.length * 20 +
      coverage * 10 -
      Math.max(0, routeKeywords.length - matchedWords.length) +
      discountBoost +
      intentBoost;

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

function findBestTripMatch(text: string, trips: TravelTrip[]) {
  const matches = findTripMatches(text, trips);
  if (!matches.length) {
    const looseBest = findLooseTripMatch(text, trips);
    return { best: looseBest, ambiguous: [] as TravelTrip[] };
  }

  const [best, second] = matches;
  if (
    second &&
    best.score - second.score <= 5 &&
    Math.abs(best.keywordCoverage - second.keywordCoverage) <= 0.15
  ) {
    const looseBest = findLooseTripMatch(text, trips);
    if (looseBest) return { best: looseBest, ambiguous: [] as TravelTrip[] };
    return {
      best: null,
      ambiguous: matches.slice(0, 3).map((match) => match.trip),
    };
  }

  return { best: best.trip, ambiguous: [] as TravelTrip[] };
}

// Whether the query explicitly signals a land-only (no-flight) trip.
function queryWantsLandOnly(query: string): boolean {
  return (
    /газрын\s+аялал/i.test(query) ||
    /нислэггүй/i.test(query) ||
    /газраар/i.test(query)
  );
}

function hasLooseAliasMatch(query: string, queryKeywords: string[], alias: string): boolean {
  const aliasNorm = normText(alias);
  if (query.includes(aliasNorm) || aliasNorm.includes(query)) return true;

  const aliasTokens = unique(keywordTokens(alias));
  if (!aliasTokens.length) return false;

  const overlap = aliasTokens.filter((token) => queryKeywords.includes(token)).length;
  const requiredOverlap = aliasTokens.length === 1 ? 1 : Math.min(2, aliasTokens.length);
  return overlap >= requiredOverlap;
}

function queryExplicitlyRejectsFlight(query: string): boolean {
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

function queryWantsLandOnlyEnhanced(query: string): boolean {
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

function queryWantsLandFlightCombo(query: string): boolean {
  const normalized = normText(query);
  if (queryExplicitlyRejectsFlight(query)) return false;
  return (
    normalized.includes("газар нислэг") ||
    normalized.includes("нислэг хосолсон") ||
    normalized.includes("хосолсон")
  );
}

// Whether the query explicitly mentions a flight component.
function queryWantsFlight(query: string): boolean {
  if (queryExplicitlyRejectsFlight(query)) return false;
  return /нислэг|онгоц|хосолсон|нислэгтэй/i.test(query);
}

// Whether a trip is a land+flight combo based on its category or name.
function tripIsLandFlightCombo(trip: TravelTrip): boolean {
  const cat = (trip.category || "").toLowerCase();
  if (cat.includes("газар") && cat.includes("нислэг")) return true;
  const name = normText(trip.route_name);
  return /газар\s*\+\s*нислэг|газар\s+нислэг\s+хосолсон/.test(name);
}

function findLooseTripMatch(text: string, trips: TravelTrip[], options?: { hasBrochureIntent?: boolean }) {
  const query = normText(text);
  // Use keywordTokens() so generic route words (газар, нислэг, аялал, хосолсон…)
  // don't act as false-positive boosters and rank the wrong trip higher.
  const queryKeywords = unique(keywordTokens(text));
  const landOnly = queryWantsLandOnlyEnhanced(text);
  const wantsCombo = queryWantsLandFlightCombo(text);
  const wantsFlight = queryWantsFlight(text);
  const hasBrochure = options?.hasBrochureIntent ?? false;
  let best: TravelTrip | null = null;
  let bestScore = 0;
  let secondScore = 0;

  for (const trip of trips) {
    if (trip.status !== "active") continue;
    const routeNorm = normText(trip.route_name);
    // Filter route words through keywordTokens as well (strips GENERIC_ROUTE_WORDS).
    const routeKeywords = unique(keywordTokens(trip.route_name));
    const matchedWordCount = routeKeywords.filter((word) => queryKeywords.includes(word)).length;
    const aliases = getAliases(trip);
    const aliasExactHit = aliases.some((alias) => query.includes(normText(alias))) ? 1 : 0;
    const aliasTokenHit = aliases.some((alias) => hasLooseAliasMatch(query, queryKeywords, alias)) ? 1 : 0;
    const exactRouteHit = query.includes(routeNorm) ? 1 : 0;
    let score =
      exactRouteHit * 10 +
      aliasExactHit * 8 +
      aliasTokenHit * 6 +
      matchedWordCount * 3;

    // Category-intent alignment bonuses and penalties.
    const isCombo = tripIsLandFlightCombo(trip);
    const tripCat = (trip.category || "").toLowerCase();
    if (landOnly) {
      if (tripCat === "газрын аялал") score += 100;
      // Penalise land+flight combos heavily when user said "газрын аялал".
      if (isCombo && !wantsFlight) score -= 100;
    }
    if (wantsCombo && isCombo) score += 180;
    if (wantsCombo && !isCombo) score -= 180;
    if (wantsFlight && isCombo) score += 50;
    if (landOnly && tripCat.includes("газрын") && tripCat.includes("аялал")) score += 20;
    if (landOnly && isCombo && !wantsFlight) score -= 50;

    // Bonus when alias is a precise land-only spelling variant.
    const landAliasHit = getAliases(trip).some((alias) => {
      const an = normText(alias);
      return an.includes("газрын") && query.includes(an);
    });
    if (landAliasHit) score += 80;
    const enhancedLandAliasHit = aliases.some((alias) => {
      const an = normText(alias);
      return (
        (an.includes("газрын") || an.includes("газраар") || an.includes("нислэггүй")) &&
        hasLooseAliasMatch(query, queryKeywords, alias)
      );
    });
    if (enhancedLandAliasHit && !landAliasHit) score += 100;
    else if (enhancedLandAliasHit) score += 20;

    // Bonus when user wants a brochure and this trip actually has one.
    if (hasBrochure && getTripBrochureAsset(trip)) score += 100;
    if (hasBrochure && getTripBrochureAsset(trip)) score += 20;

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

function isStructuredTripQuestion(text: string) {
  const normalized = normText(text);
  return STRUCTURED_QUERY_SIGNALS.some((signal) => normalized.includes(signal));
}

export function hasProgramIntent(text: string) {
  const normalized = normText(text);
  return (
    PROGRAM_QUERY_SIGNALS.some((signal) => normalized.includes(signal)) ||
    /\u0445\u04e9\u0442\u04e9\u043b\u0431\u04e9\u0440|\u0437\u0443\u0440\u0430\u0433|\u04e9\u0434\u04e9\u0440\s*\u04e9\u0434\u04e9\u0440|program|pdf|itinerary|day\s*by\s*day/i.test(text)
  );
}

function getTripBrochureAsset(trip: TravelTrip): ProgramAsset | null {
  const id = getTripLooseField(trip, "source_file_attachment_id");
  if (typeof id === "string" && id.length > 0) return { type: "id", value: id };

  const url = getTripLooseField(trip, "brochure_pdf_url");
  if (typeof url === "string" && url.startsWith("https://")) return { type: "url", value: url };
  return null;
}

function pushMediaUrl(target: string[], value: unknown) {
  if (typeof value === "string" && value.startsWith("https://") && !target.includes(value)) {
    target.push(value);
  }
}

function getTripProgramMediaUrls(trip: TravelTrip): string[] {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  const urls: string[] = [];

  const directKeys = [
    "program_images",
    "program_image_urls",
    "itinerary_images",
    "itinerary_image_urls",
  ];
  for (const key of directKeys) {
    const value = extra[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) pushMediaUrl(urls, item);
  }

  const mediaAssets = extra.media_assets;
  const visit = (value: unknown, path = "") => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, path);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const metaText = [
      path,
      typeof record.kind === "string" ? record.kind : "",
      typeof record.type === "string" ? record.type : "",
      typeof record.category === "string" ? record.category : "",
      typeof record.purpose === "string" ? record.purpose : "",
      typeof record.label === "string" ? record.label : "",
    ]
      .join(" ")
      .toLowerCase();
    const isProgramLike =
      metaText.includes("program") ||
      metaText.includes("itinerary") ||
      metaText.includes("хөтөлбөр") ||
      metaText.includes("өдөр");

    if (isProgramLike) {
      pushMediaUrl(urls, record.url);
      pushMediaUrl(urls, record.src);
      pushMediaUrl(urls, record.image_url);
      pushMediaUrl(urls, record.imageUrl);
    }

    for (const [key, nested] of Object.entries(record)) {
      visit(nested, `${path} ${key}`);
    }
  };

  visit(mediaAssets, "media_assets");
  return urls.slice(0, 6);
}

function getTripItineraryLines(trip: TravelTrip): string[] {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  const rawDays = Array.isArray(extra.itinerary_days) ? extra.itinerary_days : [];
  const lines: string[] = [];

  for (const [index, item] of rawDays.entries()) {
    if (typeof item === "string" && item.trim()) {
      lines.push(`• Өдөр ${index + 1}: ${item.trim()}`);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const dayValue =
      typeof record.day === "number"
        ? record.day
        : typeof record.day_number === "number"
          ? record.day_number
          : index + 1;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const description = typeof record.description === "string" ? record.description.trim() : "";
    const summary = [title, description].filter(Boolean).join(" — ");
    if (summary) {
      lines.push(`• Өдөр ${dayValue}: ${summary}`);
    }
  }

  return lines;
}

function formatPrice(amount: number | null | undefined): string {
  if (!amount) return "";
  return amount.toLocaleString("mn-MN") + "₮";
}

function buildTripSummaryLines(trip: TravelTrip): string {
  const lines: string[] = [];
  if (trip.duration_text) lines.push(`⏱ ${trip.duration_text}`);
  const adult = formatPrice(trip.adult_price);
  const child = formatPrice(trip.child_price);
  if (adult && child) lines.push(`💰 Насанд хүрэгч: ${adult} | Хүүхэд: ${child}`);
  else if (adult) lines.push(`💰 Үнэ: ${adult}`);
  const dates = trip.departure_dates?.filter(Boolean) ?? [];
  if (dates.length > 0) lines.push(`📅 Гарах өдрүүд: ${dates.slice(0, 5).join(", ")}${dates.length > 5 ? "…" : ""}`);
  return lines.join("\n");
}

export function buildTripProgramReply(
  text: string,
  trips: TravelTrip[],
): TripProgramReplyResult | null {
  if (!hasProgramIntent(text)) return null;

  const query = normText(text);
  const wantsCombo = queryWantsLandFlightCombo(text);
  const wantsLandOnly = queryWantsLandOnlyEnhanced(text) && !queryWantsFlight(text);
  const exactMentionedTrips = trips.filter((trip) => {
    if (query.includes(normText(trip.route_name))) return true;
    return getAliases(trip).some((alias) => query.includes(normText(alias)));
  });
  const exactMentionedComboTrips = exactMentionedTrips.filter((trip) => tripIsLandFlightCombo(trip));
  const exactMentionedLandTrips = exactMentionedTrips.filter((trip) => !tripIsLandFlightCombo(trip));
  const scopedTrips = wantsCombo
    ? exactMentionedComboTrips.length > 0
      ? exactMentionedComboTrips
      : trips.filter((trip) => tripIsLandFlightCombo(trip))
    : wantsLandOnly
      ? exactMentionedLandTrips.length > 0
        ? exactMentionedLandTrips
        : trips.filter((trip) => !tripIsLandFlightCombo(trip))
      : exactMentionedTrips.length > 0
        ? exactMentionedTrips
        : trips;
  const candidateTrips = scopedTrips.length > 0 ? scopedTrips : trips;
  const best = candidateTrips.length === 1
    ? candidateTrips[0]
    : findLooseTripMatch(text, candidateTrips, { hasBrochureIntent: true });
  if (!best) return null;

  const summary = buildTripSummaryLines(best);
  const summaryBlock = summary ? `\n\n${summary}` : "";

  const mediaUrls = getTripProgramMediaUrls(best);
  const itineraryLines = mediaUrls.length > 0 ? [] : getTripItineraryLines(best);

  if (mediaUrls.length > 0) {
    return {
      reply: `✈️ ${best.route_name}${summaryBlock}\n\nДэлгэрэнгүй хөтөлбөрийн зургуудыг илгээж байна.`,
      trip: best,
      brochure: null,
      mediaUrls,
    };
  }

  if (itineraryLines.length > 0) {
    return {
      reply: [`✈️ ${best.route_name}`, summary, "", "Өдөр өдрийн хөтөлбөр:", ...itineraryLines].filter(s => s !== "").join("\n"),
      trip: best,
      brochure: null,
      mediaUrls: [],
    };
  }

  return {
    reply: `✈️ ${best.route_name}${summaryBlock}\n\nОдоогоор энэ аяллын нэмэлт зураг системд ороогүй байна. 🙌`,
    trip: best,
    brochure: null,
    mediaUrls: [],
  };
}

function hasPriceIntent(text: string) {
  return /үнэ|хэд\s+вэ|хэдээр|төлбөр|price|cost/i.test(text);
}

function hasDurationIntent(text: string) {
  return /хэдэн\s+өдөр|хэд\s+хоног|үргэлжил|duration|how long/i.test(text);
}

function hasScheduleIntent(text: string) {
  return /гарах|огноо|хуваарь|хэзээ|schedule|date/i.test(text);
}

function hasDirectFlightIntent(text: string) {
  return /шууд\s+нислэг|нислэгтэй\s+юу|flight/i.test(text);
}

function hasExistenceIntent(text: string) {
  return /байна\s+уу|байгаа\s+юу|байх\s+уу|available/i.test(text);
}

function hasSamePriceComparisonIntent(text: string) {
  return hasPriceIntent(text) && /адилхан|ижил|ялгаатай|өөр\s+үү/i.test(text);
}

function detectDirectFlight(trip: TravelTrip) {
  const haystack = normText(
    [trip.route_name, trip.source_description, trip.notes].filter(Boolean).join(" "),
  );

  if (DIRECT_FLIGHT_NEGATIVE_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return false;
  }
  if (DIRECT_FLIGHT_POSITIVE_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return true;
  }
  return null;
}

function isLandFlightCombo(trip: TravelTrip) {
  const raw = [trip.route_name, trip.source_description, trip.notes]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const normalized = normText(raw);
  return (
    /газар\s*\+\s*нислэг/.test(raw) ||
    normalized.includes("газар нислэг хосолсон") ||
    normalized.includes("газар нислэг")
  );
}

function formatDepartureDates(trip: TravelTrip) {
  if (!trip.departure_dates.length) return "Гарах өдрийн мэдээлэл одоогоор баталгаажаагүй байна.";
  return trip.departure_dates.join(", ");
}

function formatRouteName(routeName: string) {
  return routeName.replace(/\s*\+\s*/g, " + ").replace(/\s{2,}/g, " ").trim();
}

function formatPassengerPriceLines(input: {
  adult?: number | null;
  child?: number | null;
  infant?: number | null;
  childAge?: string | null;
  infantAge?: string | null;
  currency: string;
}) {
  const lines: string[] = [];
  const adult = formatMoney(input.adult ?? null, input.currency);
  const child = formatMoney(input.child ?? null, input.currency);
  const infant = formatMoney(input.infant ?? null, input.currency);
  const childAge = input.childAge?.trim() ? ` /${input.childAge.trim()}/` : "";
  const infantAge = input.infantAge?.trim() ? ` /${input.infantAge.trim()}/` : "";

  if (adult) lines.push(`• Том хүн: ${adult}`);
  if (child) lines.push(`• Хүүхэд${childAge}: ${child}`);
  if (infant) lines.push(`• Нярай${infantAge}: ${infant}`);
  return lines;
}

function getImportantNotes(trip: TravelTrip): string[] {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  return Array.isArray(extra.important_notes)
    ? (extra.important_notes as string[]).filter((value) => typeof value === "string" && value.trim())
    : [];
}

function getTicketPreference(text: string): "with" | "without" | null {
  const normalized = normText(text);
  if (
    normalized.includes("тийзгүй") ||
    normalized.includes("ticketless") ||
    normalized.includes("without ticket")
  ) {
    return "without";
  }
  if (
    normalized.includes("тийзтэй") ||
    normalized.includes("with ticket") ||
    normalized.includes("ticket included")
  ) {
    return "with";
  }
  return null;
}

function priceGroupMatchesTicketPreference(
  group: Record<string, unknown>,
  preference: "with" | "without",
): boolean {
  const haystack = normText([
    typeof group.label === "string" ? group.label : "",
    typeof group.note === "string" ? group.note : "",
    typeof group.notes === "string" ? group.notes : "",
  ].join(" "));

  if (preference === "without") {
    return haystack.includes("тийзгүй") || haystack.includes("without ticket") || haystack.includes("ticketless");
  }

  return (
    (haystack.includes("тийзтэй") || haystack.includes("with ticket") || haystack.includes("ticket included")) &&
    !haystack.includes("тийзгүй")
  );
}

function formatSelectedPriceGroups(
  trip: TravelTrip,
  groups: Array<Record<string, unknown>>,
): string | null {
  if (!groups.length) return null;
  const currency = trip.currency || "MNT";
  const lines: string[] = [`✈️ ${trip.route_name}`, "💰 Үнэ:"];
  for (const group of groups) {
    const groupLabel = typeof group.label === "string" ? group.label : "";
    const dateLabel = Array.isArray(group.dates) && (group.dates as string[]).length > 0
      ? formatGroupDateLabel(group.dates as string[])
      : "";
    if (groupLabel) lines.push("", groupLabel);
    if (dateLabel && dateLabel !== groupLabel) lines.push(dateLabel);
    lines.push(...formatPassengerPriceLines({
      adult: typeof group.adult_price === "number" ? group.adult_price : null,
      child: typeof group.child_price === "number" ? group.child_price : null,
      infant: typeof group.infant_price === "number" ? group.infant_price : null,
      childAge: typeof group.child_age === "string" ? group.child_age : "",
      infantAge: typeof group.infant_age === "string" ? group.infant_age : "",
      currency,
    }));
  }
  return lines.join("\n");
}

function extractAgeRangeIntent(text: string): { min: number; max: number; target: "child" | "infant" } | null {
  const match = /(хүүхэд|нярай)?\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\s*(нас|сар|сартай|age)/i.exec(text);
  if (!match) return null;

  const min = Number.parseInt(match[2], 10);
  const max = Number.parseInt(match[3], 10);
  if (Number.isNaN(min) || Number.isNaN(max)) return null;

  const unit = match[4];
  const explicitTarget = match[1];
  const target = explicitTarget === "нярай" || unit.includes("сар") || max <= 2 ? "infant" : "child";
  return { min, max, target };
}

function extractRangePriceFromText(
  text: string,
  target: "child" | "infant",
  min: number,
  max: number,
): number | null {
  const role = target === "infant" ? "(нярай|infant)" : "(хүүхэд|child)";
  const pattern = new RegExp(`${role}[^\\d]{0,10}${min}\\s*[-–]\\s*${max}\\s*(?:нас|сар|сартай|age)[^\\d]{0,10}([\\d,\\.\\s]+)\\s*₮?`, "i");
  const match = pattern.exec(text);
  if (!match) return null;
  const value = Number.parseInt(match[2].replace(/[^\d]/g, ""), 10);
  return Number.isNaN(value) ? null : value;
}

function buildAgeSpecificPriceReply(trip: TravelTrip, text: string): string | null {
  const ageIntent = extractAgeRangeIntent(text);
  if (!ageIntent) return null;

  const currency = trip.currency || "MNT";
  const extra = (trip.extra || {}) as Record<string, unknown>;
  if (Array.isArray(extra.child_rules)) {
    for (const rule of extra.child_rules as Array<Record<string, unknown>>) {
      const ageRange = typeof rule.age_range === "string" ? rule.age_range : "";
      const rangeMatch = /(\d{1,2})\s*[-–]\s*(\d{1,2})/.exec(ageRange);
      if (!rangeMatch) continue;
      const ruleMin = Number.parseInt(rangeMatch[1], 10);
      const ruleMax = Number.parseInt(rangeMatch[2], 10);
      if (ruleMin !== ageIntent.min || ruleMax !== ageIntent.max) continue;

      const label = typeof rule.label === "string" && rule.label.trim() ? rule.label.trim() : (ageIntent.target === "infant" ? "Нярай" : "Хүүхэд");
      const price = formatMoney(typeof rule.price === "number" ? rule.price : null, currency);
      if (!price) continue;
      return `✈️ ${trip.route_name}\n💰 ${label} ${ageIntent.min}-${ageIntent.max} насны үнэ: ${price}`;
    }
  }

  const textBlocks: string[] = [
    trip.notes,
    trip.source_description,
    ...getImportantNotes(trip),
  ];
  for (const group of getStructuredPriceGroups(trip)) {
    if (typeof group.note === "string") textBlocks.push(group.note);
    if (typeof group.notes === "string") textBlocks.push(group.notes);
  }

  for (const block of textBlocks) {
    if (!block) continue;
    const priceValue = extractRangePriceFromText(block, ageIntent.target, ageIntent.min, ageIntent.max);
    if (priceValue === null) continue;
    const label = ageIntent.target === "infant" ? "Нярай" : "Хүүхэд";
    return `✈️ ${trip.route_name}\n💰 ${label} ${ageIntent.min}-${ageIntent.max} насны үнэ: ${formatMoney(priceValue, currency)}`;
  }

  return null;
}

function hasIncludedInPriceIntent(text: string): boolean {
  return /багтсан\s+уу|орсон\s+уу|included|include|үнэд\s+.*багтсан/i.test(text);
}

function buildIncludedInPriceReply(trip: TravelTrip, text: string): string | null {
  if (!hasIncludedInPriceIntent(text)) return null;

  const normalized = normText(text);
  const asksAboutFlightTicket =
    normalized.includes("нислэгийн тийз") ||
    normalized.includes("онгоцны тийз") ||
    normalized.includes("flight ticket") ||
    normalized.includes("ticket");
  if (!asksAboutFlightTicket) return null;

  const extra = (trip.extra || {}) as Record<string, unknown>;
  const includedItems = Array.isArray(extra.included_items) ? (extra.included_items as string[]) : [];
  const excludedItems = Array.isArray(extra.excluded_items) ? (extra.excluded_items as string[]) : [];
  const evidenceBlocks = [
    trip.notes,
    trip.source_description,
    ...getImportantNotes(trip),
    ...includedItems,
    ...excludedItems,
  ];
  for (const group of getStructuredPriceGroups(trip)) {
    if (typeof group.note === "string") evidenceBlocks.push(group.note);
    if (typeof group.notes === "string") evidenceBlocks.push(group.notes);
  }
  const evidence = evidenceBlocks.filter(Boolean).join(" ");
  const currency = trip.currency || "MNT";
  const price = formatMoney(trip.adult_price, currency);

  if (/нэмэгдэнэ|\+\s*тийз|багтаагүй|тусдаа/i.test(evidence)) {
    const priceText = price ? `Одоогийн ${price} үнэд ` : "Одоогийн үнэд ";
    return `✈️ ${trip.route_name}\n${priceText}нислэгийн тийз нэмэгдэнэ гэж тэмдэглэгдсэн байна. Тиймээс тийзийн нөхцөлийг аяллын зөвлөхөөр баталгаажуулах хэрэгтэй.`;
  }

  if (includedItems.some((item) => /нислэгийн?\s+тийз|онгоцны?\s+тийз/i.test(item))) {
    return `✈️ ${trip.route_name}\nТийм ээ, үнэд нислэгийн тийз багтсан гэж тэмдэглэгдсэн байна.`;
  }

  if (excludedItems.some((item) => /нислэгийн?\s+тийз|онгоцны?\s+тийз/i.test(item))) {
    return `✈️ ${trip.route_name}\nҮгүй, үнэд нислэгийн тийз багтаагүй гэж тэмдэглэгдсэн байна.`;
  }

  return `✈️ ${trip.route_name}\nНислэгийн тийз үнэд орсон эсэх мэдээлэл тодорхойгүй байна. Аяллын зөвлөхөөр баталгаажуулна уу.`;
}

function groupDatesForDisplay(dates: string[]): Array<{ month: number | null; days: number[]; raw: string[] }> {
  const groups: Array<{ month: number | null; days: number[]; raw: string[] }> = [];
  for (const raw of dates) {
    const parsed = normalizeMnDate(raw);
    if (parsed.length === 0) {
      groups.push({ month: null, days: [], raw: [raw] });
      continue;
    }
    for (const value of parsed) {
      let group = groups.find((entry) => entry.month === value.month);
      if (!group) {
        group = { month: value.month, days: [], raw: [] };
        groups.push(group);
      }
      if (!group.days.includes(value.day)) group.days.push(value.day);
    }
  }
  for (const group of groups) group.days.sort((a, b) => a - b);
  return groups;
}

function joinDayList(days: number[]) {
  if (days.length === 0) return "";
  if (days.length <= 2) return days.join(", ");
  return `${days.slice(0, -1).join(", ")}, ${days[days.length - 1]}`;
}

function formatGroupDateLabel(dates: string[], suffix = "гаралт") {
  const grouped = groupDatesForDisplay(dates);
  if (grouped.length === 0) return "";
  if (grouped.every((entry) => entry.month !== null)) {
    const parts = grouped.map((entry) => `${entry.month} сарын ${joinDayList(entry.days)}-ны`);
    return parts.length === 1
      ? `${parts[0]} ${suffix}`
      : `${parts.slice(0, -1).join(", ")} болон ${parts[parts.length - 1]} ${suffix}`;
  }
  return dates.join(", ");
}

function formatCompactDepartureList(dates: string[]) {
  const grouped = groupDatesForDisplay(dates);
  if (grouped.length === 0) return compactDates(dates);
  if (grouped.every((entry) => entry.month !== null)) {
    const values: string[] = [];
    for (const entry of grouped) {
      for (const day of entry.days) values.push(`${entry.month}/${day}`);
    }
    return values.join(", ");
  }
  return compactDates(dates);
}

function findPriceGroupByYmd(
  trip: TravelTrip,
  ymd: string,
  now = new Date(),
): DepartureDateGroup | null {
  for (const group of getPriceGroups(trip)) {
    const dates = Array.isArray(group.dates) ? group.dates : [];
    for (const dateText of dates) {
      const parsed = parseDepartureDateText(dateText, now);
      if (parsed.includes(ymd)) return group;
    }
  }
  return null;
}

/**
 * Parse Mongolian date text into an array of {month, day} objects.
 * Handles:
 *   "6 сарын 27"            → [{month:6, day:27}]
 *   "7 сарын 18, 8 сарын 8" → [{month:7, day:18}, {month:8, day:8}]
 *   "6 сарын 19, 26"        → [{month:6, day:19}, {month:6, day:26}]
 *   "2026-06-27"            → [{month:6, day:27}]
 *   "6/27"                  → [{month:6, day:27}]
 */
function normalizeMnDate(dateText: string): Array<{ month: number; day: number }> {
  const results: Array<{ month: number; day: number }> = [];
  const trimmed = dateText.trim();

  // ISO date: 2026-06-27
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (isoMatch) {
    return [{ month: parseInt(isoMatch[2], 10), day: parseInt(isoMatch[3], 10) }];
  }

  // Slash format: 6/27
  const slashMatch = /^(\d{1,2})\/(\d{1,2})$/.exec(trimmed);
  if (slashMatch) {
    return [{ month: parseInt(slashMatch[1], 10), day: parseInt(slashMatch[2], 10) }];
  }

  const yearMonthDayPattern = /(?:\d{4}\s*он\s*)?(\d{1,2})\s*сар(?:ын)?\s*(\d{1,2})/g;
  let yearMonthDayMatch: RegExpExecArray | null;
  while ((yearMonthDayMatch = yearMonthDayPattern.exec(trimmed)) !== null) {
    results.push({
      month: parseInt(yearMonthDayMatch[1], 10),
      day: parseInt(yearMonthDayMatch[2], 10),
    });
  }
  if (results.length > 0) return results;

  // Mongolian format: parse all "N сарын D" segments, with optional trailing day numbers
  // Pattern: one or more "N сарын D[, D2, ...]" groups
  const segmentPattern = /(\d{1,2})\s*сар(?:ын)?\s*(\d{1,2})((?:\s*,\s*\d{1,2})*)/g;
  let match: RegExpExecArray | null;
  while ((match = segmentPattern.exec(dateText)) !== null) {
    const month = parseInt(match[1], 10);
    const firstDay = parseInt(match[2], 10);
    results.push({ month, day: firstDay });
    // Extra days for same month: ", 26" etc.
    const extras = match[3];
    if (extras) {
      const extraDays = extras.split(",").map((s) => s.trim()).filter(Boolean);
      for (const ds of extraDays) {
        const d = parseInt(ds, 10);
        if (!isNaN(d)) results.push({ month, day: d });
      }
    }
  }

  return results;
}

/**
 * Extract date mentions from a user query string.
 * e.g. "6 сарын 27, 7 сарын 18 үнэ" → [{month:6,day:27},{month:7,day:18}]
 */
function extractDatesFromText(text: string): Array<{ month: number; day: number }> {
  const results: Array<{ month: number; day: number }> = [];
  const yearMonthDayPattern = /(?:\d{4}\s*он\s*)?(\d{1,2})\s*сар(?:ын)?\s*(\d{1,2})/g;
  let yearMonthDayMatch: RegExpExecArray | null;
  while ((yearMonthDayMatch = yearMonthDayPattern.exec(text)) !== null) {
    results.push({
      month: parseInt(yearMonthDayMatch[1], 10),
      day: parseInt(yearMonthDayMatch[2], 10),
    });
  }
  if (results.length > 0) return uniqueMonthDays(results);

  // Match "N сарын D" with optional extra days
  const segmentPattern = /(\d{1,2})\s*сар(?:ын)?\s*(\d{1,2})((?:\s*,\s*\d{1,2}(?!\s*сар(?:ын)?))*)/g;
  let match: RegExpExecArray | null;
  while ((match = segmentPattern.exec(text)) !== null) {
    const month = parseInt(match[1], 10);
    const firstDay = parseInt(match[2], 10);
    results.push({ month, day: firstDay });
    const extras = match[3];
    if (extras) {
      const extraDays = extras.split(",").map((s) => s.trim()).filter(Boolean);
      for (const ds of extraDays) {
        const d = parseInt(ds, 10);
        if (!isNaN(d)) results.push({ month, day: d });
      }
    }
  }
  return results;
}

function extractStructuredDates(text: string): MonthDay[] {
  return uniqueMonthDays(parseLooseMonthDays(text));
}

function extractNormalizedPrice(text: string): number | null {
  const compact = text.replace(/\s+/g, " ").trim();

  const millionMatch = /(\d+(?:[.,]\d+)?)\s*сая(?:\s+(\d{1,4}))?/i.exec(compact);
  if (millionMatch) {
    const whole = Number.parseFloat(millionMatch[1].replace(",", "."));
    if (!Number.isNaN(whole)) {
      let price = Math.round(whole * 1_000_000);
      if (millionMatch[2]) {
        const tail = Number.parseInt(millionMatch[2], 10);
        if (!Number.isNaN(tail)) {
          price = Math.trunc(whole) * 1_000_000 + (tail < 1000 ? tail * 1000 : tail);
        }
      }
      return price;
    }
  }

  const kiloMatch = /(?:^|[^\d])(\d{3,5}(?:[.,]\d+)?)\s*[кk]\b/i.exec(compact);
  if (kiloMatch) {
    const amount = Number.parseFloat(kiloMatch[1].replace(",", "."));
    if (!Number.isNaN(amount)) return Math.round(amount * 1000);
  }

  const groupedMatch = /(?:^|[^\d])(\d{1,3}(?:[.,]\d{3})+|\d{6,8})(?!\d)/.exec(compact);
  if (groupedMatch) {
    const digits = groupedMatch[1].replace(/[.,]/g, "");
    const amount = Number.parseInt(digits, 10);
    if (!Number.isNaN(amount)) return amount;
  }

  return null;
}

function hasDatePriceConstraint(text: string) {
  return extractStructuredDates(text).length > 0 && extractNormalizedPrice(text) !== null;
}

function parseLooseMonthDays(text: string): MonthDay[] {
  const results: MonthDay[] = [];
  for (const match of text.matchAll(/(?:^|[^\d])(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/g)) {
    results.push({ month: parseInt(match[2], 10), day: parseInt(match[3], 10) });
  }
  for (const match of text.matchAll(/(?:^|[^\d])(\d{1,2})\/(\d{1,2})(?!\d)/g)) {
    results.push({ month: parseInt(match[1], 10), day: parseInt(match[2], 10) });
  }
  for (const match of text.matchAll(/(\d{1,2})\s*[^\d\s,./-]{2,12}\s*(\d{1,2})/g)) {
    results.push({ month: parseInt(match[1], 10), day: parseInt(match[2], 10) });
  }
  return results;
}

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

function groupMatchesMonthDay(
  group: Record<string, unknown> | DepartureDateGroup,
  month: number,
  day: number,
): boolean {
  return getGroupDateTexts(group).some((dateText) =>
    parseLooseMonthDays(dateText).some((value) => value.month === month && value.day === day),
  );
}

/**
 * Find the price group for a given month+day, checking:
 * 1. extra.price_groups (admin-entered) using normalizeMnDate
 * 2. extra.departure_date_groups (AI-imported) using parseDepartureDateText + ISO compare
 */
function findPriceGroupByMonthDay(
  trip: TravelTrip,
  month: number,
  day: number,
  now = new Date(),
): Record<string, unknown> | DepartureDateGroup | null {
  const mStr = String(month);
  const dStr = String(day);
  const mPad = mStr.padStart(2, "0");
  const dPad = dStr.padStart(2, "0");
  const mnVariants = new Set([
    `${mStr} сарын ${dStr}`,
    `${mPad} сарын ${dStr}`,
    `${mStr} сарын ${dPad}`,
    `${mPad} сарын ${dPad}`,
    `${mStr}/${dStr}`,
    `${mPad}/${dStr}`,
    `${mStr}/${dPad}`,
    `${mPad}/${dPad}`,
  ]);
  const yearCandidates = [now.getFullYear(), now.getFullYear() + 1];
  for (const yr of yearCandidates) mnVariants.add(`${yr}-${mPad}-${dPad}`);

  // 1. Check structured price_groups — prefer date_keys if populated, fall back to normalizeMnDate
  const structuredGroups = getStructuredPriceGroups(trip);
  for (const g of structuredGroups) {
    const dateKeys = Array.isArray(g.date_keys) ? (g.date_keys as string[]) : [];
    if (dateKeys.length > 0) {
      if (dateKeys.some((k) => mnVariants.has(k))) return g;
    } else {
      // fallback: parse dates on the fly
      const rawDates = Array.isArray(g.dates) ? (g.dates as string[]) : [];
      for (const dateText of rawDates) {
        const parsed = normalizeMnDate(dateText);
        if (parsed.some((d) => d.month === month && d.day === day)) return g;
      }
    }
  }

  // 2. Fall back to legacy departure_date_groups via ISO comparison
  for (const year of yearCandidates) {
    const ymd = `${year}-${mPad}-${dPad}`;
    for (const group of getPriceGroups(trip)) {
      const dates = Array.isArray(group.dates) ? group.dates : [];
      for (const dateText of dates) {
        const parsed = parseDepartureDateText(dateText, now);
        if (parsed.includes(ymd)) return group;
      }
    }
  }

  return null;
}

function formatPriceLine(group: {
  label?: string | null;
  adult_price?: number | null;
  child_price?: number | null;
  infant_price?: number | null;
}) {
  const parts: string[] = [];
  const adult = formatMoney(group.adult_price ?? null, "MNT");
  const child = formatMoney(group.child_price ?? null, "MNT");
  const infant = formatMoney(group.infant_price ?? null, "MNT");

  if (adult) parts.push(`Том хүн: ${adult}`);
  if (child) parts.push(`Хүүхэд: ${child}`);
  if (infant) parts.push(`Нярай: ${infant}`);

  return parts.join(" | ");
}

function formatChildRules(trip: TravelTrip, currency: string): string {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  if (!Array.isArray(extra.child_rules) || (extra.child_rules as unknown[]).length === 0) return "";
  const rules = extra.child_rules as Array<Record<string, unknown>>;
  const lines: string[] = ["👶 Хүүхдийн насны ангилал:"];
  for (const r of rules) {
    const label = typeof r.label === "string" && r.label ? r.label : "";
    const age = typeof r.age_range === "string" && r.age_range ? ` (${r.age_range})` : "";
    const price = formatMoney(typeof r.price === "number" ? r.price : null, currency);
    const display = label ? `${label}${age}` : age.replace(/[()]/g, "").trim();
    if (display && price) {
      lines.push(`  ${display}: ${price}`);
    } else if (display) {
      lines.push(`  ${display}: үнэ тодорхойгүй`);
    }
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

// Compact a list of date strings: if more than 4, show first 3 + "… (N нийт)"
function compactDates(dates: string[]): string {
  if (dates.length <= 4) return dates.join(", ");
  return `${dates.slice(0, 3).join(", ")} … (нийт ${dates.length} өдөр)`;
}

function formatTripBasePrice(trip: TravelTrip) {
  const currency = trip.currency || "MNT";

  // Prefer new structured price_groups from extra
  const structuredGroups = getStructuredPriceGroups(trip);
  if (structuredGroups.length > 0) {
    // Group price_groups by identical adult/child/infant price to avoid verbose repetition
    type GroupedPrice = {
      priceKey: string;
      priceStr: string;
      dates: string[];
      label: string;
    };
    const grouped: GroupedPrice[] = [];

    for (const g of structuredGroups) {
      const adult = formatMoney(typeof g.adult_price === "number" ? g.adult_price : null, currency);
      const child = formatMoney(typeof g.child_price === "number" ? g.child_price : null, currency);
      const infant = formatMoney(typeof g.infant_price === "number" ? g.infant_price : null, currency);
      const priceParts: string[] = [];
      if (adult) priceParts.push(`Том хүн: ${adult}`);
      if (child) {
        const childAge = typeof g.child_age === "string" && g.child_age.trim() ? ` (${g.child_age.trim()})` : "";
        priceParts.push(`Хүүхэд${childAge}: ${child}`);
      }
      if (infant) {
        const infantAge = typeof g.infant_age === "string" && g.infant_age.trim() ? ` (${g.infant_age.trim()})` : "";
        priceParts.push(`Нярай${infantAge}: ${infant}`);
      }
      if (!priceParts.length) continue;
      const priceKey = priceParts.join("|");
      const rawDates = Array.isArray(g.dates) && (g.dates as string[]).length > 0
        ? g.dates as string[]
        : [];
      const labelStr = typeof g.label === "string" && g.label ? g.label : "";
      const existing = grouped.find((gr) => gr.priceKey === priceKey);
      if (existing) {
        existing.dates.push(...rawDates);
      } else {
        grouped.push({ priceKey, priceStr: priceParts.join(" | "), dates: [...rawDates], label: labelStr });
      }
    }

    const lines: string[] = ["💰 Үнэ (гарах огноогоор):"];
    for (const gr of grouped) {
      const dateDisplay = gr.dates.length > 0 ? compactDates(gr.dates) : gr.label;
      if (dateDisplay) {
        lines.push(`  ${dateDisplay}: ${gr.priceStr}`);
      } else {
        lines.push(`  ${gr.priceStr}`);
      }
    }
    const childRulesStr = formatChildRules(trip, currency);
    if (childRulesStr) lines.push(childRulesStr);
    return lines.join("\n");
  }

  // Fall back to legacy departure_date_groups
  const groups = getPriceGroups(trip);
  if (groups.length > 0) {
    // Also group by price to avoid repetition
    type LegacyGroup = { priceKey: string; priceStr: string; dates: string[] };
    const grouped: LegacyGroup[] = [];
    for (const g of groups) {
      const adult = formatMoney(g.adult_price ?? null, currency);
      const child = formatMoney(g.child_price ?? null, currency);
      const infant = formatMoney(g.infant_price ?? null, currency);
      const priceParts: string[] = [];
      if (adult) priceParts.push(`Том хүн: ${adult}`);
      if (child) priceParts.push(`Хүүхэд: ${child}`);
      if (infant) priceParts.push(`Нярай: ${infant}`);
      if (!priceParts.length) continue;
      const priceKey = priceParts.join("|");
      const rawDates = Array.isArray(g.dates) && g.dates.length > 0 ? g.dates : (g.label ? [g.label] : []);
      const existing = grouped.find((gr) => gr.priceKey === priceKey);
      if (existing) {
        existing.dates.push(...rawDates);
      } else {
        grouped.push({ priceKey, priceStr: priceParts.join(" | "), dates: [...rawDates] });
      }
    }
    const lines: string[] = ["💰 Үнэ (гарах огноогоор):"];
    for (const gr of grouped) {
      const dateDisplay = compactDates(gr.dates);
      if (dateDisplay) {
        lines.push(`  ${dateDisplay}: ${gr.priceStr}`);
      } else {
        lines.push(`  ${gr.priceStr}`);
      }
    }
    return lines.join("\n");
  }

  // Fall back to flat price
  const adult = formatMoney(trip.adult_price, currency);
  const child = formatMoney(trip.child_price, currency);
  const parts: string[] = [];
  if (adult) parts.push(`💰 Том хүн: ${adult}`);
  if (child) parts.push(`💰 Хүүхэд: ${child}`);
  if (!parts.length) {
    return "💰 Үнийн мэдээлэл дэлгэрэнгүй мэдэхийг хүсвэл аяллын зөвлөхтэй холбогдоорой.";
  }
  return parts.join("\n");
}

/**
 * Extract a single month number from phrases like "7 сард", "7-р сард", "долоодугаар сард".
 * Returns null if no month-only mention found (without a specific day).
 */
function formatTripBasePricePremium(trip: TravelTrip) {
  const currency = trip.currency || "MNT";
  const sections: string[] = ["💰 Үнэ:"];
  const structuredGroups = getStructuredPriceGroups(trip);

  if (structuredGroups.length > 0) {
    type GroupedPrice = { priceKey: string; priceLines: string[]; dates: string[]; label: string };
    const grouped: GroupedPrice[] = [];
    for (const g of structuredGroups) {
      const priceLines = formatPassengerPriceLines({
        adult: typeof g.adult_price === "number" ? g.adult_price : null,
        child: typeof g.child_price === "number" ? g.child_price : null,
        infant: typeof g.infant_price === "number" ? g.infant_price : null,
        childAge: typeof g.child_age === "string" ? g.child_age : "",
        infantAge: typeof g.infant_age === "string" ? g.infant_age : "",
        currency,
      });
      if (!priceLines.length) continue;
      const priceKey = priceLines.join("|");
      const rawDates = Array.isArray(g.dates) ? g.dates as string[] : [];
      const label = typeof g.label === "string" ? g.label : "";
      const existing = grouped.find((entry) => entry.priceKey === priceKey);
      if (existing) existing.dates.push(...rawDates);
      else grouped.push({ priceKey, priceLines, dates: [...rawDates], label });
    }
    for (const entry of grouped) {
      const dateLabel = entry.dates.length > 0 ? formatGroupDateLabel(entry.dates) : entry.label;
      if (dateLabel) sections.push("", dateLabel);
      sections.push(...entry.priceLines);
    }
    return sections.join("\n");
  }

  const legacyGroups = getPriceGroups(trip);
  if (legacyGroups.length > 0) {
    for (const group of legacyGroups) {
      const dateLabel = Array.isArray(group.dates) && group.dates.length > 0 ? formatGroupDateLabel(group.dates) : (group.label || "");
      const priceLines = formatPassengerPriceLines({
        adult: group.adult_price ?? null,
        child: group.child_price ?? null,
        infant: group.infant_price ?? null,
        currency,
      });
      if (!priceLines.length) continue;
      if (dateLabel) sections.push("", dateLabel);
      sections.push(...priceLines);
    }
    return sections.join("\n");
  }

  const flatLines = formatPassengerPriceLines({
    adult: trip.adult_price,
    child: trip.child_price,
    currency,
  });
  if (!flatLines.length) return "💰 Үнийн мэдээлэл одоогоор тодорхойгүй байна.";
  return [...sections, "", ...flatLines].join("\n");
}

function extractMonthOnlyFromText(text: string): number | null {
  const MN_MONTH_WORDS: Record<string, number> = {
    "нэгдүгээр": 1, "хоёрдугаар": 2, "гуравдугаар": 3, "дөрөвдүгээр": 4,
    "тавдугаар": 5, "зургадугаар": 6, "долоодугаар": 7, "наймдугаар": 8,
    "есдүгээр": 9, "аравдугаар": 10, "арваннэгдүгээр": 11, "арвандолоодугаар": 12,
  };
  // "7 сард" / "7-р сард" — but NOT when followed by "ны N" (specific day)
  const numMatch = /(\d{1,2})[\s-]*(?:р\s+)?сар(?:д|ын)?\b(?!\s*\d)/.exec(text);
  if (numMatch) return parseInt(numMatch[1], 10);
  // Mongolian word forms
  for (const [word, month] of Object.entries(MN_MONTH_WORDS)) {
    if (text.toLowerCase().includes(word)) return month;
  }
  return null;
}

/** Filter price_groups to only those containing dates in the given month. */
function filterPriceGroupsByMonth(
  groups: Array<Record<string, unknown>>,
  month: number,
): Array<Record<string, unknown>> {
  return groups.filter((g) => {
    const rawDates = Array.isArray(g.dates) ? g.dates as string[] : [];
    return rawDates.some((d) => normalizeMnDate(d).some((nd) => nd.month === month));
  });
}

function formatSpecificDatePrice(
  trip: TravelTrip,
  ymd: string,
  label: string,
  now = new Date(),
) {
  const group = findPriceGroupByYmd(trip, ymd, now);
  if (!group) {
    return `💰 ${label}-ны үнийн мэдээлэл дэлгэрэнгүй мэдэхийг хүсвэл аяллын зөвлөхтэй холбогдоорой.`;
  }

  const currency = trip.currency || "MNT";
  const adult = formatMoney(group.adult_price ?? null, currency);
  const child = formatMoney(group.child_price ?? null, currency);
  const infant = formatMoney(group.infant_price ?? null, currency);
  const parts: string[] = [];
  if (adult) parts.push(`Том хүн: ${adult}`);
  if (child) parts.push(`Хүүхэд: ${child}`);
  if (infant) parts.push(`Нярай: ${infant}`);
  const suffix = parts.length ? parts.join(" | ") : "Аяллын зөвлөхтэй холбогдоорой.";
  return `💰 ${label}: ${suffix}`;
}

function buildAmbiguousTripReply(trips: TravelTrip[]) {
  const names = trips.slice(0, 3).map((trip) => `• ${trip.route_name}`);
  return [
    "Таны асууж байгаа аялал 2-3 өөр хувилбартай байна.",
    "Аль аяллыг хэлж байгаагаа нэрээр нь нэг тодруулаад бичээрэй:",
    ...names,
  ].join("\n");
}

function buildSameTripPriceComparisonReply(
  trip: TravelTrip,
  text: string,
  now = new Date(),
) {
  // Extract {month, day} pairs from user text (handles Mongolian date text in price_groups)
  const mnDates = extractDatesFromText(text);

  if (mnDates.length >= 2) {
    // Use the new month/day-based lookup that covers both price_groups and departure_date_groups
    const groups = mnDates.map((md) => ({
      label: `${md.month} сарын ${md.day}`,
      month: md.month,
      day: md.day,
      group: findPriceGroupByMonthDay(trip, md.month, md.day, now),
    }));

    if (groups.some((entry) => !entry.group)) return null;

    const getPrice = (g: Record<string, unknown> | DepartureDateGroup) => ({
      adult: typeof (g as Record<string, unknown>).adult_price === "number"
        ? (g as Record<string, unknown>).adult_price as number
        : (g as DepartureDateGroup).adult_price ?? null,
      child: typeof (g as Record<string, unknown>).child_price === "number"
        ? (g as Record<string, unknown>).child_price as number
        : (g as DepartureDateGroup).child_price ?? null,
      infant: typeof (g as Record<string, unknown>).infant_price === "number"
        ? (g as Record<string, unknown>).infant_price as number
        : (g as DepartureDateGroup).infant_price ?? null,
    });

    const first = getPrice(groups[0].group!);
    const same = groups.every((entry) => {
      const p = getPrice(entry.group!);
      return p.adult === first.adult && p.child === first.child && p.infant === first.infant;
    });

    const currency = trip.currency || "MNT";
    const lines = [
      `✈️ ${trip.route_name} аяллын ${same ? "үнэ адилхан байна." : "үнэ адил биш байна."}`,
    ];

    for (const entry of groups) {
      const g = entry.group!;
      const p = getPrice(g);
      const adultStr = formatMoney(p.adult, currency);
      const childStr = formatMoney(p.child, currency);
      const infantStr = formatMoney(p.infant, currency);
      const priceParts: string[] = [];
      if (adultStr) priceParts.push(`Том хүн: ${adultStr}`);
      if (childStr) priceParts.push(`Хүүхэд: ${childStr}`);
      if (infantStr) priceParts.push(`Нярай: ${infantStr}`);
      const priceStr = priceParts.length ? priceParts.join(" | ") : "Үнийн мэдээлэл алга байна.";
      lines.push(`💰 ${entry.label}: ${priceStr}`);
    }

    return lines.join("\n");
  }

  // Fallback: use ISO date parsing (legacy path for departure_date_groups)
  const dates = unique(parseDepartureDateText(text, now));
  if (dates.length < 2) return null;

  const groups = dates.map((ymd) => ({
    ymd,
    group: findPriceGroupByYmd(trip, ymd, now),
  }));
  if (groups.some((entry) => !entry.group)) return null;

  const first = groups[0].group!;
  const same = groups.every(
    (entry) =>
      entry.group?.adult_price === first.adult_price &&
      entry.group?.child_price === first.child_price &&
      entry.group?.infant_price === first.infant_price,
  );

  const lines = [
    `✈️ ${trip.route_name} аяллын ${same ? "үнэ адилхан байна." : "үнэ адил биш байна."}`,
  ];

  for (const entry of groups) {
    const group = entry.group!;
    const label = Array.isArray(group.dates) && group.dates.length > 0 ? group.dates[0] : entry.ymd;
    lines.push(formatSpecificDatePrice(trip, entry.ymd, label, now));
  }

  return lines.join("\n");
}

export function hasDiscountIntent(text: string): boolean {
  const normalized = normText(text);
  const hasMn = DISCOUNT_KEYWORDS_MN.some((keyword) => normalized.includes(keyword));
  const hasEn = DISCOUNT_KEYWORDS_EN.some((keyword) => normalized.includes(keyword));
  return hasMn || hasEn;
}

export function buildDiscountReply(text: string, trips: TravelTrip[]): string | null {
  const { best, ambiguous } = findBestTripMatch(text, trips);
  if (!best) return ambiguous.length ? buildAmbiguousTripReply(ambiguous) : null;

  const extra = (best.extra || {}) as Record<string, unknown>;
  const currency = best.currency || "MNT";

  // Check admin-entered discounts first, then fall back to AI-imported discount_groups
  const adminDiscounts = getStructuredDiscounts(best);
  const aiDiscountGroups = Array.isArray(extra.discount_groups)
    ? (extra.discount_groups as Array<Record<string, unknown>>)
    : [];
  const discountGroups = adminDiscounts.length > 0 ? adminDiscounts : aiDiscountGroups;

  // Check notes and source_description for discount info
  const discountText = [
    best.notes,
    best.source_description,
    ...getImportantNotes(best),
    ...getStructuredPriceGroups(best).flatMap((group) => [
      typeof group.note === "string" ? group.note : "",
      typeof group.notes === "string" ? group.notes : "",
    ]),
  ]
    .filter(Boolean)
    .join(" ");
  const hasDiscountInText = /хямдрал|тусгай|үнэгүй|хөнгөлөлт|bonus|бонус|discount|promo|2\+1|5\+1/i.test(discountText);

  if (discountGroups.length === 0 && !hasDiscountInText) {
    const lines = [
      `✈️ ${best.route_name}`,
      "💡 Хямдралтай үнийн мэдээлэл одоогоор тусдаа баталгаажаагүй байна.",
      formatTripBasePricePremium(best),
    ];
    if (best.departure_dates.length > 0) {
      lines.push(`📅 Гарах өдрүүд: ${formatDepartureDates(best)}`);
    }
    lines.push("Дэлгэрэнгүйг манай аяллын зөвлөхөөс лавлаарай.");
    return lines.join("\n");
  }

  const lines: string[] = [`✈️ ${best.route_name} — Хямдралтай үнэ:`];

  if (discountGroups.length > 0) {
    for (const g of discountGroups) {
      const dates = Array.isArray(g.dates) ? (g.dates as string[]).join(", ") : String(g.dates ?? "");
      const adult = formatMoney(typeof g.adult_price === "number" ? g.adult_price : null, currency);
      const child = formatMoney(typeof g.child_price === "number" ? g.child_price : null, currency);
      const infant = formatMoney(typeof g.infant_price === "number" ? g.infant_price : null, currency);
      const label = typeof g.label === "string" && g.label ? `${g.label}: ` : "";
      const cond = typeof g.condition === "string" && g.condition ? ` (${g.condition})` : "";
      const note = typeof g.note === "string" && g.note ? ` — ${g.note}` : "";
      const priceParts: string[] = [];
      if (adult) priceParts.push(`Том хүн: ${adult}`);
      if (child) priceParts.push(`Хүүхэд: ${child}`);
      if (infant) priceParts.push(`Нярай: ${infant}`);
      const priceStr = priceParts.join(" | ");
      if (dates) lines.push(`  ${label}${dates}: ${priceStr}${cond}${note}`);
      else lines.push(`  ${label}${priceStr}${cond}${note}`);
    }
  }

  // Show regular price for comparison
  const regularAdult = formatMoney(best.adult_price, currency);
  const regularChild = formatMoney(best.child_price, currency);
  if (regularAdult || regularChild) {
    const regular: string[] = [];
    if (regularAdult) regular.push(`Том хүн: ${regularAdult}`);
    if (regularChild) regular.push(`Хүүхэд: ${regularChild}`);
    lines.push(`Үндсэн үнэ: ${regular.join(" | ")}`);
  }

  // Append child rules if available
  const childRulesStr = formatChildRules(best, currency);
  if (childRulesStr) lines.push(childRulesStr);

  if (hasDiscountInText) {
    lines.push(`\n${discountText.trim()}`);
  }

  return lines.join("\n");
}

export function hasSeatsIntent(text: string): boolean {
  const normalized = normText(text);
  const hasMn = SEATS_KEYWORDS_MN.some((keyword) => normalized.includes(keyword));
  const hasEn = SEATS_KEYWORDS_EN.some((keyword) => normalized.includes(keyword));
  return hasMn || hasEn;
}

function getSeatSalesMessage(trip: TravelTrip): string | null {
  if (typeof trip.seats_left !== "number" || Number.isNaN(trip.seats_left)) {
    return null;
  }

  if (trip.seats_left === 0) {
    return "Уучлаарай, энэ гаралтын суудал дүүрсэн байна.\nДараагийн гарах өдрийг санал болгоё.";
  }

  if (trip.seats_left >= 1 && trip.seats_left <= 7) {
    return "Суудал цөөн үлдсэн тул захиалга өгөх бол аяллын зөвлөхтэй хурдан холбогдоорой.";
  }

  return null;
}

function buildTripInfoReply(trip: TravelTrip) {
  const lines = [`\u2708\uFE0F ${formatRouteName(trip.route_name)}`, ""];

  if (trip.duration_text) {
    lines.push(`\uD83D\uDDD3 Хугацаа: ${trip.duration_text}`, "");
  }

  lines.push(formatTripBasePricePremium(trip));

  if (trip.departure_dates.length > 0) {
    lines.push("", `\uD83D\uDCC5 Гарах өдрүүд:`, formatCompactDepartureList(trip.departure_dates));
  }

  const seatMessage = getSeatSalesMessage(trip);
  if (seatMessage) {
    lines.push("", seatMessage);
  }

  if (isLandFlightCombo(trip)) {
    lines.push("", "Энэ нь газар + нислэг хосолсон аялал бөгөөд УБ–Бэйдайхэ чиглэлийн нислэг багтсан.");
  }

  lines.push("", "Та аль гарах өдрийг сонирхож байна вэ? 😊");
  return lines.join("\n");
}

export function buildSeatsReply(text: string, trips: TravelTrip[]): string | null {
  const { best, ambiguous } = findBestTripMatch(text, trips);
  if (!best) return ambiguous.length ? buildAmbiguousTripReply(ambiguous) : null;

  return buildTripInfoReply(best);
}

export function hasCompareIntent(text: string): boolean {
  const normalized = normText(text);
  const hasMn = COMPARE_KEYWORDS_MN.some((keyword) => normalized.includes(keyword));
  const hasEn = COMPARE_KEYWORDS_EN.some((keyword) => normalized.includes(keyword));
  return hasMn || hasEn;
}

export function buildSmartButtons(replyText: string, trips: TravelTrip[]): string[] | null {
  const { best } = findBestTripMatch(replyText, trips);
  if (!best) return null;

  const buttons: string[] = ["Дэлгэрэнгүй", "Захиалах"];
  if (best.seats_left !== null) buttons.push("Суудал бий юу?");
  return buttons;
}

export function buildCompareReply(text: string, trips: TravelTrip[]): string | null {
  const query = normText(text);
  const activeTrips = trips.filter((trip) => trip.status === "active");

  const matched = activeTrips.filter((trip) => {
    const keywords = unique(keywordTokens(trip.route_name));
    const matchedWords = keywords.filter((word) => query.includes(word));
    return matchedWords.length >= Math.min(2, keywords.length);
  });

  if (matched.length < 2) return null;
  const candidates = matched.slice(0, 4);

  const lines: string[] = ["📊 Аялал харьцуулалт:", ""];
  for (const trip of candidates) {
    const price = formatMoney(trip.adult_price, trip.currency);
    lines.push(`▶ ${trip.route_name}`);
    lines.push(`Үнэ (том хүн): ${price || "тодорхойгүй"}`);
    lines.push(`Хугацаа: ${trip.duration_text || "тодорхойгүй"}`);
    lines.push(
      `Хоол: ${
        trip.has_food === true ? "Тийм" : trip.has_food === false ? "Үгүй" : "тодорхойгүй"
      }`,
    );
    if (trip.departure_dates.length > 0) {
      lines.push(
        `Гарах өдрүүд: ${trip.departure_dates.slice(0, 3).join(", ")}${
          trip.departure_dates.length > 3 ? " …" : ""
        }`,
      );
    }
    const seatMessage = getSeatSalesMessage(trip);
    if (seatMessage) {
      lines.push(seatMessage);
    }
    lines.push("");
  }

  lines.push("Дэлгэрэнгүй мэдээлэл эсвэл захиалга хийхийн тулд манай аяллын зөвлөхтэй холбогдоорой.");
  return lines.join("\n");
}

function findCombinedDatePriceMatches(
  text: string,
  trips: TravelTrip[],
): { date: MonthDay; price: number; matches: CombinedDatePriceMatch[]; hasExact: boolean } | null {
  const date = extractStructuredDates(text)[0];
  const price = extractNormalizedPrice(text);
  if (!date || price === null) return null;

  const query = normText(text);
  const matches: CombinedDatePriceMatch[] = [];

  for (const trip of trips) {
    if (trip.status !== "active") continue;
    if (!getTripSearchHaystack(trip)) continue;

    let bestForTrip: CombinedDatePriceMatch | null = null;
    const consider = (
      group: Record<string, unknown> | DepartureDateGroup | null,
      matchType: CombinedDatePriceMatch["matchType"],
      matchedPrice: number | null,
    ) => {
      const diff = matchedPrice === null ? Number.POSITIVE_INFINITY : Math.abs(matchedPrice - price);
      const candidate: CombinedDatePriceMatch = {
        trip,
        matchType,
        score: matchScoreForPriceKind(matchType) - Math.min(diff / 1000, 50),
        priceDiff: diff,
        matchedPrice,
        group,
      };
      if (
        !bestForTrip ||
        candidate.score > bestForTrip.score ||
        (candidate.score === bestForTrip.score && candidate.priceDiff < bestForTrip.priceDiff)
      ) {
        bestForTrip = candidate;
      }
    };

    const searchGroups = (
      groups: Array<Record<string, unknown> | DepartureDateGroup>,
      adultKind: "adult" | "discount",
    ) => {
      for (const group of groups) {
        if (!groupMatchesMonthDay(group, date.month, date.day)) continue;
        let added = false;
        for (const priceValue of getPriceValuesFromGroup(group, adultKind)) {
          added = true;
          consider(group, priceValue.value === price ? priceValue.kind : "date_only", priceValue.value);
        }
        if (!added) consider(group, "date_only", null);
      }
    };

    searchGroups(getStructuredPriceGroups(trip), "adult");
    searchGroups(getStructuredDiscounts(trip), "discount");
    searchGroups(getPriceGroups(trip), "adult");

    if (!bestForTrip) {
      const hasTripDate = trip.departure_dates.some((value) =>
        parseLooseMonthDays(value).some((dateValue) => dateValue.month === date.month && dateValue.day === date.day),
      );
      if (hasTripDate) {
        const fallbackPrices = [trip.adult_price, trip.child_price]
          .filter((value): value is number => typeof value === "number");
        const closest = fallbackPrices.length > 0
          ? fallbackPrices.reduce((bestValue, current) =>
            Math.abs(current - price) < Math.abs(bestValue - price) ? current : bestValue
          )
          : null;
        consider(null, "date_only", closest);
      }
    }

    if (bestForTrip) {
      const finalMatch = bestForTrip as CombinedDatePriceMatch;
      if (query.includes(normText(trip.route_name))) finalMatch.score += 8;
      if (getAliases(trip).some((alias) => query.includes(normText(alias)))) finalMatch.score += 5;
      matches.push(finalMatch);
    }
  }

  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.priceDiff !== b.priceDiff) return a.priceDiff - b.priceDiff;
    return a.trip.route_name.localeCompare(b.trip.route_name, "mn");
  });

  return {
    date,
    price,
    matches,
    hasExact: matches.some((match) => match.matchType !== "date_only" && match.priceDiff === 0),
  };
}

function getCombinedMatchPriceFields(match: CombinedDatePriceMatch): Array<{ label: string; value: number | null }> {
  const raw = (match.group || {}) as Record<string, unknown>;
  const fields: Array<{ label: string; value: number | null }> = [
    { label: "Том хүн", value: typeof raw.adult_price === "number" ? raw.adult_price : match.trip.adult_price },
    { label: "Хүүхэд", value: typeof raw.child_price === "number" ? raw.child_price : match.trip.child_price },
    { label: "Нярай", value: typeof raw.infant_price === "number" ? raw.infant_price : null },
  ];

  if (Array.isArray(raw.passenger_prices)) {
    for (const item of raw.passenger_prices) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (typeof record.price !== "number") continue;
      const label = typeof record.label === "string" && record.label.trim()
        ? record.label.trim()
        : "Зорчигч";
      fields.push({ label, value: record.price });
    }
  }

  return fields;
}

function formatCombinedDatePriceReply(
  result: { date: MonthDay; price: number; matches: CombinedDatePriceMatch[]; hasExact: boolean },
): string | null {
  if (result.matches.length === 0) return null;

  const dateLabel = `${result.date.month} сарын ${result.date.day}`;
  const askedPrice = formatMoney(result.price, "MNT") || `${result.price}`;

  if (result.hasExact) {
    const exactMatches = result.matches
      .filter((match) => match.matchType !== "date_only" && match.priceDiff === 0)
      .slice(0, 3);
    const intro = exactMatches.length > 1
      ? `${dateLabel}-нд энэ үнэтэй хэд хэдэн аялал байна:`
      : `Тийм ээ. ${dateLabel}-нд гарах ${askedPrice}-ийн аялал байна:`;
    const blocks = exactMatches.map((match) => {
      const lines = [`✈️ ${match.trip.route_name}`];
      if (match.trip.duration_text) lines.push(`🗓 Хугацаа: ${match.trip.duration_text}`);
      for (const field of getCombinedMatchPriceFields(match)) {
        const formatted = formatMoney(field.value, match.trip.currency || "MNT");
        if (formatted) lines.push(`💰 ${field.label}: ${formatted}`);
      }
      if (isLandFlightCombo(match.trip)) {
        lines.push("Энэ нь газар + нислэг хосолсон аялал бөгөөд УБ–Бэйдайхэ 2 талын нислэг багтсан.");
      }
      return lines.join("\n");
    });
    return [intro, ...blocks].join("\n\n");
  }

  const closeMatches = result.matches.slice(0, 3);
  const lines = [
    `${dateLabel}-нд ${askedPrice}-өөр яг таарах аялал олдсонгүй. Харин ${dateLabel}-нд гарах ойролцоо үнэтэй аяллууд байна:`,
  ];
  for (const match of closeMatches) {
    const duration = match.trip.duration_text ? ` • ${match.trip.duration_text}` : "";
    const priceText = formatMoney(match.matchedPrice, match.trip.currency || "MNT");
    lines.push(`• ${match.trip.route_name}${duration}${priceText ? ` • ${priceText}` : ""}`);
  }
  return lines.join("\n");
}

export function buildStructuredTripReply(
  text: string,
  trips: TravelTrip[],
  now = new Date(),
): string | null {
  const combinedDatePrice = findCombinedDatePriceMatches(text, trips);
  if (combinedDatePrice) {
    const combinedReply = formatCombinedDatePriceReply(combinedDatePrice);
    if (combinedReply) return combinedReply;
  }

  const routeOnlyCandidate = !isStructuredTripQuestion(text) && !hasDatePriceConstraint(text)
    ? findBestTripMatch(text, trips)
    : null;
  if (!isStructuredTripQuestion(text) && !hasDatePriceConstraint(text)) {
    if (!routeOnlyCandidate?.best) return routeOnlyCandidate?.ambiguous?.length
      ? buildAmbiguousTripReply(routeOnlyCandidate.ambiguous)
      : null;
    return buildTripInfoReply(routeOnlyCandidate.best);
  }

  const { best, ambiguous } = findBestTripMatch(text, trips);
  if (!best) return ambiguous.length ? buildAmbiguousTripReply(ambiguous) : null;

  const samePriceReply = buildSameTripPriceComparisonReply(best, text, now);
  if (samePriceReply && hasSamePriceComparisonIntent(text)) {
    return samePriceReply;
  }
  if (hasSamePriceComparisonIntent(text) && !samePriceReply) {
    const fallbackLines = [
      `✈️ ${best.route_name}`,
      formatTripBasePricePremium(best),
    ];
    if (best.departure_dates.length > 0) {
      fallbackLines.push(`📅 Гарах өдрүүд: ${formatDepartureDates(best)}`);
    }
    return fallbackLines.join("\n");
  }

  const includedReply = buildIncludedInPriceReply(best, text);
  if (includedReply) return includedReply;

  const lines: string[] = [];
  const askedPrice = hasPriceIntent(text);
  const askedDuration = hasDurationIntent(text);
  const askedSchedule = hasScheduleIntent(text);
  const askedDirectFlight = hasDirectFlightIntent(text);
  const askedExistence = hasExistenceIntent(text);
  const ageSpecificReply = askedPrice ? buildAgeSpecificPriceReply(best, text) : null;
  if (ageSpecificReply) return ageSpecificReply;
  const ticketPreference = askedPrice ? getTicketPreference(text) : null;
  if (ticketPreference) {
    const matchingGroups = getStructuredPriceGroups(best).filter((group) => priceGroupMatchesTicketPreference(group, ticketPreference));
    const filteredReply = formatSelectedPriceGroups(best, matchingGroups);
    if (filteredReply) return filteredReply;
  }
  if (!askedPrice && !askedDuration && !askedSchedule && !askedDirectFlight && !askedExistence) {
    return buildTripInfoReply(best);
  }
  const requestedDates = unique(parseDepartureDateText(text, now));

  if (askedExistence && !askedPrice && !askedDuration && !askedSchedule && !askedDirectFlight) {
    lines.push(`✈️ Тийм ээ, ${best.route_name} аялал манайд идэвхтэй байна.`);
  } else {
    lines.push(`✈️ ${best.route_name}`);
  }

  if (askedDirectFlight) {
    const directFlight = detectDirectFlight(best);
    if (directFlight === true) {
      lines.push("✈️ Энэ аялал шууд нислэгтэй.");
    } else if (directFlight === false) {
      // Check if it's a land+flight combo tour
      const isLandFlight = isLandFlightCombo(best);
      if (isLandFlight) {
        lines.push("✈️ Энэ нь газар + нислэг хосолсон аялал. Зөвхөн шууд нислэгтэй биш — газрын маршруттай хавсарсан аялал.");
      } else {
        lines.push("✈️ Энэ аялал шууд нислэгтэй биш.");
      }
    } else {
      if (isLandFlightCombo(best)) {
        lines.push("✈️ Энэ нь газар + нислэг хосолсон аялал. Зөвхөн шууд нислэгтэй биш — газрын маршруттай хавсарсан аялал.");
      } else {
        // Check source text for partial clues before giving up
        const srcText = [best.notes, best.source_description].filter(Boolean).join(" ");
        if (/нислэг|flight/i.test(srcText)) {
          lines.push("✈️ Нислэгийн дэлгэрэнгүй (шууд эсэх) нь аяллын зөвлөхөөр баталгаажуулна уу.");
        } else {
          lines.push("✈️ Нислэгийн мэдээлэл тодорхойгүй байна. Аяллын зөвлөхтэй холбогдоорой.");
        }
      }
    }
  }

  if (askedDuration) {
    lines.push(`🗓 Хугацаа: ${best.duration_text || "Хугацааны мэдээлэл алга байна."}`);
  }

  // Detect if user asked about a specific month only (without a specific day)
  const askedMonthOnly = extractMonthOnlyFromText(text);

  if (askedPrice) {
    const mnDates = extractDatesFromText(text);
    if (mnDates.length > 0) {
      // Specific day(s) requested — use month/day lookup
      const currency = best.currency || "MNT";
      for (const md of mnDates) {
        const g = findPriceGroupByMonthDay(best, md.month, md.day, now);
        const label = `${md.month} сарын ${md.day}`;
        if (!g) {
          lines.push(`💰 ${label}-д тохирох үнийн мэдээлэл олдсонгүй. Аяллын зөвлөхтэй холбогдоорой.`);
        } else {
          const adult = formatMoney(
            typeof (g as Record<string, unknown>).adult_price === "number"
              ? (g as Record<string, unknown>).adult_price as number
              : ((g as DepartureDateGroup).adult_price ?? null),
            currency,
          );
          const child = formatMoney(
            typeof (g as Record<string, unknown>).child_price === "number"
              ? (g as Record<string, unknown>).child_price as number
              : ((g as DepartureDateGroup).child_price ?? null),
            currency,
          );
          const infant = formatMoney(
            typeof (g as Record<string, unknown>).infant_price === "number"
              ? (g as Record<string, unknown>).infant_price as number
              : ((g as DepartureDateGroup).infant_price ?? null),
            currency,
          );
          const parts: string[] = [];
          if (adult) parts.push(`Том хүн: ${adult}`);
          if (child) parts.push(`Хүүхэд: ${child}`);
          if (infant) parts.push(`Нярай: ${infant}`);
          lines.push(`💰 ${label}: ${parts.length ? parts.join(" | ") : "аяллын зөвлөхтэй холбогдоорой"}`);
        }
      }
    } else if (askedMonthOnly !== null) {
      // Month-only request: filter price_groups to that month
      const currency = best.currency || "MNT";
      const monthGroups = filterPriceGroupsByMonth(getStructuredPriceGroups(best), askedMonthOnly);
      if (monthGroups.length > 0) {
        lines.push(`💰 ${askedMonthOnly} сарын үнэ:`);
        for (const g of monthGroups) {
          const adult = formatMoney(typeof g.adult_price === "number" ? g.adult_price : null, currency);
          const child = formatMoney(typeof g.child_price === "number" ? g.child_price : null, currency);
          const infant = formatMoney(typeof g.infant_price === "number" ? g.infant_price : null, currency);
          const priceParts: string[] = [];
          if (adult) priceParts.push(`Том хүн: ${adult}`);
          if (child) {
            const childAge = typeof g.child_age === "string" && g.child_age.trim() ? ` (${g.child_age.trim()})` : "";
            priceParts.push(`Хүүхэд${childAge}: ${child}`);
          }
          if (infant) priceParts.push(`Нярай: ${infant}`);
          const rawDates = Array.isArray(g.dates) ? g.dates as string[] : [];
          // Only show dates belonging to this month
          const monthDates = rawDates.filter((d) => normalizeMnDate(d).some((nd) => nd.month === askedMonthOnly));
          const dateDisplay = monthDates.length > 0 ? compactDates(monthDates) : (typeof g.label === "string" ? g.label : "");
          if (dateDisplay) {
            lines.push(`  ${dateDisplay}: ${priceParts.join(" | ")}`);
          } else if (priceParts.length) {
            lines.push(`  ${priceParts.join(" | ")}`);
          }
        }
        const childRulesStr = formatChildRules(best, currency);
        if (childRulesStr) lines.push(childRulesStr);
      } else {
        // Fall back to full price table
        lines.push(formatTripBasePricePremium(best));
      }
    } else if (requestedDates.length > 0) {
      for (const ymd of requestedDates) {
        lines.push(formatSpecificDatePrice(best, ymd, ymd, now));
      }
    } else {
      lines.push(formatTripBasePricePremium(best));
    }
  }

  // Schedule: filter departure_dates to asked month if applicable
  if (askedSchedule || (askedPrice && best.departure_dates.length > 0)) {
    if (askedMonthOnly !== null && best.departure_dates.length > 0) {
      const monthDates = best.departure_dates.filter((d) => {
        // Match "N сарын D", "N/D", or ISO "YYYY-MM-DD"
        const mn = normalizeMnDate(d);
        if (mn.length > 0) return mn.some((nd) => nd.month === askedMonthOnly);
        // ISO check
        const isoM = /^\d{4}-(\d{2})-\d{2}$/.exec(d);
        if (isoM) return parseInt(isoM[1], 10) === askedMonthOnly;
        return false;
      });
      if (monthDates.length > 0) {
        lines.push(`📅 ${askedMonthOnly} сарын гарах өдрүүд: ${compactDates(monthDates)}`);
      } else {
        lines.push(`📅 Гарах өдрүүд: ${formatDepartureDates(best)}`);
      }
    } else {
      lines.push(`📅 Гарах өдрүүд: ${formatDepartureDates(best)}`);
    }
  }

  if (
    !askedPrice &&
    !askedDuration &&
    !askedSchedule &&
    !askedDirectFlight &&
    askedExistence
  ) {
    lines.push(`🗓 Хугацаа: ${best.duration_text || "Мэдээлэл алга байна."}`);
    lines.push(formatTripBasePricePremium(best));
    if (best.departure_dates.length > 0) {
      lines.push(`📅 Гарах өдрүүд: ${formatDepartureDates(best)}`);
    }
  }

  if (askedDirectFlight && !askedDuration) {
    lines.push(`🗓 Хугацаа: ${best.duration_text || "Хугацааны мэдээлэл алга байна."}`);
  }

  if (lines.length === 1) {
    lines.push(`🗓 Хугацаа: ${best.duration_text || "Мэдээлэл алга байна."}`);
    lines.push(formatTripBasePricePremium(best));
  }

  return lines.join("\n");
}
