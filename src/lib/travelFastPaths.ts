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

function getAliases(trip: TravelTrip): string[] {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  return Array.isArray(extra.aliases) ? (extra.aliases as string[]).filter(Boolean) : [];
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

    // Check aliases for an exact match bonus
    const aliases = getAliases(trip);
    const aliasHit = aliases.some((alias) => {
      const aliasNorm = normText(alias);
      return query.includes(aliasNorm) || aliasNorm.includes(query);
    }) ? 1 : 0;

    const matchedWords = routeKeywords.filter((word) => queryWords.includes(word));
    const coverage = matchedWords.length / routeKeywords.length;
    const exactRouteHit = query.includes(routeNorm) ? 1 : 0;
    const minMatchCount = routeKeywords.length === 1 ? 1 : 2;

    if (matchedWords.length < minMatchCount && exactRouteHit === 0 && aliasHit === 0) continue;
    if (coverage < 0.5 && exactRouteHit === 0 && aliasHit === 0) continue;

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

    const score =
      exactRouteHit * 100 +
      aliasHit * 80 +
      matchedWords.length * 20 +
      coverage * 10 -
      Math.max(0, routeKeywords.length - matchedWords.length) +
      discountBoost;

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

  // ISO date: 2026-06-27
  const isoMatch = /^\d{4}-(\d{1,2})-(\d{1,2})$/.exec(dateText.trim());
  if (isoMatch) {
    return [{ month: parseInt(isoMatch[1], 10), day: parseInt(isoMatch[2], 10) }];
  }

  // Slash format: 6/27
  const slashMatch = /^(\d{1,2})\/(\d{1,2})$/.exec(dateText.trim());
  if (slashMatch) {
    return [{ month: parseInt(slashMatch[1], 10), day: parseInt(slashMatch[2], 10) }];
  }

  // Mongolian format: parse all "N сарын D" segments, with optional trailing day numbers
  // Pattern: one or more "N сарын D[, D2, ...]" groups
  const segmentPattern = /(\d{1,2})\s*сарын\s*(\d{1,2})((?:\s*,\s*\d{1,2})*)/g;
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
  // Match "N сарын D" with optional extra days
  const segmentPattern = /(\d{1,2})\s*сарын\s*(\d{1,2})((?:\s*,\s*\d{1,2}(?!\s*сарын))*)/g;
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
  const discountText = [best.notes, best.source_description]
    .filter(Boolean)
    .join(" ");
  const hasDiscountInText = /хямдрал|тусгай|үнэгүй|хөнгөлөлт|discount|promo/i.test(discountText);

  if (discountGroups.length === 0 && !hasDiscountInText) {
    const lines = [
      `✈️ ${best.route_name}`,
      "💡 Хямдралтай үнийн мэдээлэл одоогоор тусдаа баталгаажаагүй байна.",
      formatTripBasePrice(best),
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

  lines.push("Дэлгэрэнгүй мэдээлэл эсвэл захиалга хийхийн тулд манай аяллын зөвлөхтэй холбогдоорой.");
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
  if (hasSamePriceComparisonIntent(text) && !samePriceReply) {
    const fallbackLines = [
      `✈️ ${best.route_name}`,
      formatTripBasePrice(best),
    ];
    if (best.departure_dates.length > 0) {
      fallbackLines.push(`📅 Гарах өдрүүд: ${formatDepartureDates(best)}`);
    }
    return fallbackLines.join("\n");
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
        lines.push(formatTripBasePrice(best));
      }
    } else if (requestedDates.length > 0) {
      for (const ymd of requestedDates) {
        lines.push(formatSpecificDatePrice(best, ymd, ymd, now));
      }
    } else {
      lines.push(formatTripBasePrice(best));
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
