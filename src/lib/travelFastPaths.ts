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

const DIRECT_FLIGHT_POSITIVE_PATTERNS = [/шууд\s+нислэг/i];
const DIRECT_FLIGHT_NEGATIVE_PATTERNS = [
  /газар\s*\+\s*нислэг/i,
  /газар\s+нислэг\s+хосолсон/i,
  /газар\s+аялал/i,
  /газрын\s+аялал/i,
];

const ALIAS_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bnaadam\b/gi, "наадам"],
  [/наадмын/gi, "наадам"],
  [/жанжиажэ|жанжиажэ|жанжиажиэ|zhangjiajie|zhanjiajie/gi, "тэнгэрийн хаалга"],
  [/цунчин|чунцин|chongqing/gi, "чунчин"],
  [/бэйдэхэ|бэйдэйхэ|beidaihe/gi, "бэйдайхэ"],
  [/хөххот|hohhot|huhhot/gi, "хөх хот"],
  [/саняа|sanya/gi, "саньяа"],
  [/хайкоү|haikou/gi, "хайкоу"],
  [/жежү|jeju/gi, "жэжү"],
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

function findTripMatches(text: string, trips: TravelTrip[]): TripMatch[] {
  const query = normText(text);
  const queryWords = unique(keywordTokens(text));
  if (!queryWords.length) return [];

  const matches: TripMatch[] = [];
  for (const trip of trips) {
    if (trip.status !== "active") continue;

    const routeNorm = normText(trip.route_name);
    const routeKeywords = unique(keywordTokens(trip.route_name));
    if (!routeKeywords.length) continue;

    const matchedWords = routeKeywords.filter((word) => queryWords.includes(word));
    const coverage = matchedWords.length / routeKeywords.length;
    const exactRouteHit = query.includes(routeNorm) ? 1 : 0;
    const minMatchCount = routeKeywords.length === 1 ? 1 : 2;

    if (matchedWords.length < minMatchCount && exactRouteHit === 0) continue;
    if (coverage < 0.5 && exactRouteHit === 0) continue;

    const score =
      exactRouteHit * 100 +
      matchedWords.length * 20 +
      coverage * 10 -
      Math.max(0, routeKeywords.length - matchedWords.length);

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
  if (!matches.length) return { best: null, ambiguous: [] as TravelTrip[] };

  const [best, second] = matches;
  if (
    second &&
    best.score - second.score <= 5 &&
    Math.abs(best.keywordCoverage - second.keywordCoverage) <= 0.15
  ) {
    return {
      best: null,
      ambiguous: matches.slice(0, 3).map((match) => match.trip),
    };
  }

  return { best: best.trip, ambiguous: [] as TravelTrip[] };
}

function isStructuredTripQuestion(text: string) {
  const normalized = normText(text);
  return STRUCTURED_QUERY_SIGNALS.some((signal) => normalized.includes(signal));
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

function formatDepartureDates(trip: TravelTrip) {
  if (!trip.departure_dates.length) return "Гарах өдрийн мэдээлэл одоогоор баталгаажаагүй байна.";
  return trip.departure_dates.join(", ");
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

function formatTripBasePrice(trip: TravelTrip) {
  const adult = formatMoney(trip.adult_price, trip.currency);
  const child = formatMoney(trip.child_price, trip.currency);
  const parts: string[] = [];
  if (adult) parts.push(`💰 Том хүн: ${adult}`);
  if (child) parts.push(`💰 Хүүхэд: ${child}`);
  if (!parts.length) {
    return "💰 Үнийн мэдээлэл одоогоор баталгаажаагүй байна.";
  }
  return parts.join("\n");
}

function formatSpecificDatePrice(
  trip: TravelTrip,
  ymd: string,
  label: string,
  now = new Date(),
) {
  const group = findPriceGroupByYmd(trip, ymd, now);
  if (!group) {
    return `💰 ${label}-ны үнийн мэдээлэл одоогоор тусдаа баталгаажаагүй байна.`;
  }

  const currency = trip.currency || "MNT";
  const adult = formatMoney(group.adult_price ?? null, currency);
  const child = formatMoney(group.child_price ?? null, currency);
  const infant = formatMoney(group.infant_price ?? null, currency);
  const parts: string[] = [];
  if (adult) parts.push(`Том хүн: ${adult}`);
  if (child) parts.push(`Хүүхэд: ${child}`);
  if (infant) parts.push(`Нярай: ${infant}`);
  const suffix = parts.length ? parts.join(" | ") : "Үнийн мэдээлэл алга байна.";
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

export function hasSeatsIntent(text: string): boolean {
  const normalized = normText(text);
  const hasMn = SEATS_KEYWORDS_MN.some((keyword) => normalized.includes(keyword));
  const hasEn = SEATS_KEYWORDS_EN.some((keyword) => normalized.includes(keyword));
  return hasMn || hasEn;
}

export function buildSeatsReply(text: string, trips: TravelTrip[]): string | null {
  const { best, ambiguous } = findBestTripMatch(text, trips);
  if (!best) return ambiguous.length ? buildAmbiguousTripReply(ambiguous) : null;

  if (best.seats_left === null) {
    return `${best.route_name}: суудлын мэдээлэл одоогоор байхгүй байна.`;
  }
  if (best.seats_left === 0 || best.status === "sold_out") {
    return `${best.route_name}: суудал дүүрсэн байна.`;
  }
  return `${best.route_name}: ${best.seats_left} суудал үлдсэн байна.`;
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
    if (trip.seats_left !== null) {
      lines.push(`Үлдсэн суудал: ${trip.seats_left}`);
    }
    lines.push("");
  }

  lines.push("Дэлгэрэнгүй мэдээлэл эсвэл захиалга хийхийн тулд манай ажилтантай холбогдоорой.");
  return lines.join("\n");
}

export function buildStructuredTripReply(
  text: string,
  trips: TravelTrip[],
  now = new Date(),
): string | null {
  if (!isStructuredTripQuestion(text)) return null;

  const { best, ambiguous } = findBestTripMatch(text, trips);
  if (!best) return ambiguous.length ? buildAmbiguousTripReply(ambiguous) : null;

  const samePriceReply = buildSameTripPriceComparisonReply(best, text, now);
  if (samePriceReply && hasSamePriceComparisonIntent(text)) {
    return samePriceReply;
  }

  const lines: string[] = [];
  const askedPrice = hasPriceIntent(text);
  const askedDuration = hasDurationIntent(text);
  const askedSchedule = hasScheduleIntent(text);
  const askedDirectFlight = hasDirectFlightIntent(text);
  const askedExistence = hasExistenceIntent(text);
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
      lines.push("✈️ Энэ аялал шууд нислэгтэй биш.");
    } else {
      lines.push("✈️ Нислэгийн төрлийн мэдээлэл одоогоор баталгаажаагүй байна.");
    }
  }

  if (askedDuration) {
    lines.push(`🗓 Хугацаа: ${best.duration_text || "Хугацааны мэдээлэл алга байна."}`);
  }

  if (askedPrice) {
    if (requestedDates.length > 0) {
      for (const ymd of requestedDates) {
        lines.push(formatSpecificDatePrice(best, ymd, ymd, now));
      }
    } else {
      lines.push(formatTripBasePrice(best));
    }
  }

  if (askedSchedule || (askedPrice && best.departure_dates.length > 0)) {
    lines.push(`📅 Гарах өдрүүд: ${formatDepartureDates(best)}`);
  }

  if (
    !askedPrice &&
    !askedDuration &&
    !askedSchedule &&
    !askedDirectFlight &&
    askedExistence
  ) {
    lines.push(`🗓 Хугацаа: ${best.duration_text || "Мэдээлэл алга байна."}`);
    lines.push(formatTripBasePrice(best));
    if (best.departure_dates.length > 0) {
      lines.push(`📅 Гарах өдрүүд: ${formatDepartureDates(best)}`);
    }
  }

  if (askedDirectFlight && !askedDuration) {
    lines.push(`🗓 Хугацаа: ${best.duration_text || "Хугацааны мэдээлэл алга байна."}`);
  }

  if (lines.length === 1) {
    lines.push(`🗓 Хугацаа: ${best.duration_text || "Мэдээлэл алга байна."}`);
    lines.push(formatTripBasePrice(best));
  }

  return lines.join("\n");
}
