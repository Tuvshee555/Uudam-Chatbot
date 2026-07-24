/**
 * Fast-path helpers that answer common structured travel questions directly
 * from the DB instead of letting the model guess.
 *
 * This file holds the top-level reply builders (discount/seats/compare/
 * structured trip replies). The supporting logic lives in sibling modules
 * and is re-exported here so every existing import path
 * (`from "../../lib/travelFastPaths"`) keeps working unchanged:
 *   - travelFastPathsSearch.ts   — trip matching/search core
 *   - travelFastPathsProgram.ts  — program/itinerary replies
 *   - travelFastPathsPricing.ts  — date/price parsing + price formatting
 */

import { filterFutureDepartureDates, parseDepartureDateText } from "./travelDates";
import type { TravelTrip } from "./travelOps";
import {
  DISCOUNT_KEYWORDS_EN,
  DISCOUNT_KEYWORDS_MN,
  formatMoney,
  getAliases,
  getStructuredDiscounts,
  getStructuredPriceGroups,
  getTripSearchHaystack,
  isGenericConfirmationText,
  keywordTokens,
  matchScoreForPriceKind,
  normText,
  findBestTripMatch,
  getPriceGroups,
  getPriceValuesFromGroup,
  isStructuredTripQuestion,
  tripIsDirectFlight,
  tripIsLandFlightCombo,
  unique,
  withFutureDepartureDates,
  type CombinedDatePriceMatch,
  type DepartureDateGroup,
  type MonthDay,
} from "./travelFastPathsSearch";
import {
  buildAmbiguousTripReply,
  buildAgeSpecificPriceReply,
  buildIncludedInPriceReply,
  buildPassengerTypePriceReply,
  buildSameTripPriceComparisonReply,
  compactDates,
  detectDirectFlight,
  extractDatesFromText,
  extractMonthOnlyFromText,
  extractNormalizedPrice,
  extractStructuredDates,
  filterPriceGroupsByMonth,
  findPriceGroupByMonthDay,
  formatChildRules,
  formatCompactDepartureList,
  formatDepartureDates,
  formatExtraFeesLine,
  formatRouteName,
  formatSelectedPriceGroups,
  formatSpecificDatePrice,
  formatTripBasePricePremium,
  getImportantNotes,
  getTicketPreference,
  groupMatchesMonthDay,
  hasDatePriceConstraint,
  hasDirectFlightIntent,
  hasDurationIntent,
  hasExistenceIntent,
  hasPriceIntent,
  hasSamePriceComparisonIntent,
  hasScheduleIntent,
  isLandFlightCombo,
  normalizeMnDate,
  parseLooseMonthDays,
  priceGroupMatchesTicketPreference,
} from "./travelFastPathsPricing";

/**
 * duration_text is free text an admin/AI-extraction pass can leave as an
 * internal QA sentinel ("... тодорхойгүй, баталгаажуулах шаардлагатай")
 * instead of an actual duration. Never echo that straight to a customer.
 */
function safeDurationText(durationText: string | null | undefined): string {
  if (!durationText || isGenericConfirmationText(durationText)) return "";
  return durationText;
}

function hasInfantPrice(trip: TravelTrip): boolean {
  if (
    getStructuredPriceGroups(trip).some((group) => typeof group.infant_price === "number") ||
    getPriceGroups(trip).some((group) => typeof group.infant_price === "number")
  ) {
    return true;
  }
  const extra = (trip.extra || {}) as Record<string, unknown>;
  const rules = [extra.child_rules, extra.child_price_rules]
    .flatMap((value) => Array.isArray(value) ? value : []) as Array<Record<string, unknown>>;
  return rules.some(
    (rule) =>
      typeof rule.price === "number" &&
      /нярай|infant/i.test([rule.label, rule.type, rule.age_range].filter(Boolean).join(" ")),
  );
}

function firstPassengerPrice(trip: TravelTrip, key: "adult_price" | "child_price" | "infant_price"): number | null {
  if (key === "adult_price" && typeof trip.adult_price === "number") return trip.adult_price;
  if (key === "child_price" && typeof trip.child_price === "number") return trip.child_price;
  for (const group of getStructuredPriceGroups(trip)) {
    const value = group[key];
    if (typeof value === "number") return value;
  }
  for (const group of getPriceGroups(trip)) {
    const value = group[key];
    if (typeof value === "number") return value;
  }
  return null;
}

function parsePassengerTotalRequest(text: string): { adultCount: number; childCount: number; infantCount: number } | null {
  const normalized = normText(text);
  if (!/(нийт|niit|total|хэд болох|hed boloh)/i.test(normalized)) return null;

  const findCount = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const match = pattern.exec(normalized);
      if (match) return Number.parseInt(match[1], 10);
    }
    return 0;
  };

  // A digit directly before "том хүн" ("2 том хүн") means the count comes BEFORE the
  // noun; otherwise ("том хүн 2") it comes after. Detecting the convention stops
  // "том хүн (\d+)" from greedily grabbing the NEXT group's number — e.g.
  // "2 том хүн 1 хүүхэд" must read 2 adults + 1 child, not 1 adult + 1 child.
  const numberFirst = /\d+\s*(?:том\s*хүн|насанд\s*хүрэгч|adult)/i.test(normalized);
  const ordered = (numFirst: RegExp[], nounFirst: RegExp[]) =>
    numberFirst ? [...numFirst, ...nounFirst] : [...nounFirst, ...numFirst];

  const adultCount = findCount(ordered(
    [/(\d+)\s*том(?:\s*хүн)?/i, /(\d+)\s*adult/i],
    [/том\s*хүн\s*(\d+)/i, /adult\s*(\d+)/i],
  ));
  const childCount = findCount(ordered(
    [/(\d+)\s*хүүхэд/i, /(\d+)\s*huuhed/i, /(\d+)\s*child/i],
    [/хүүхэд\s*(\d+)/i, /huuhed\s*(\d+)/i, /child\s*(\d+)/i],
  ));
  const infantCount = findCount(ordered(
    [/(\d+)\s*нярай/i, /(\d+)\s*infant/i],
    [/нярай\s*(\d+)/i, /infant\s*(\d+)/i],
  ));

  if (adultCount + childCount + infantCount <= 0) return null;
  return { adultCount, childCount, infantCount };
}

function formatPassengerTotalLine(trip: TravelTrip, counts: { adultCount: number; childCount: number; infantCount: number }): string | null {
  const currency = trip.currency || "MNT";
  const adult = firstPassengerPrice(trip, "adult_price");
  const child = firstPassengerPrice(trip, "child_price");
  const infant = firstPassengerPrice(trip, "infant_price");
  const parts: string[] = [];
  let total = 0;

  if (counts.adultCount > 0) {
    if (typeof adult !== "number") return null;
    total += counts.adultCount * adult;
    parts.push(`${counts.adultCount} том хүн x ${formatMoney(adult, currency)}`);
  }
  if (counts.childCount > 0) {
    if (typeof child !== "number") return null;
    total += counts.childCount * child;
    parts.push(`${counts.childCount} хүүхэд x ${formatMoney(child, currency)}`);
  }
  if (counts.infantCount > 0) {
    if (typeof infant !== "number") return null;
    total += counts.infantCount * infant;
    parts.push(`${counts.infantCount} нярай x ${formatMoney(infant, currency)}`);
  }

  return `• ${trip.route_name}: ${formatMoney(total, currency)} (${parts.join(" + ")})`;
}

export function buildAmbiguousPassengerTotalReply(
  text: string,
  trips: TravelTrip[],
): string | null {
  const counts = parsePassengerTotalRequest(text);
  if (!counts || trips.length < 2) return null;
  const lines = trips
    .slice(0, 5)
    .map((trip) => formatPassengerTotalLine(trip, counts))
    .filter((line): line is string => Boolean(line));
  if (lines.length < 2) return null;
  return [
    "Энэ чиглэлээр хэд хэдэн хувилбар байгаа тул нийт үнийг тус бүрээр нь бодож өгье:",
    ...lines,
    "",
    "Аль аяллынх нь зөв болохыг сонгоорой.",
  ].join("\n");
}

export function hasDiscountIntent(text: string): boolean {
  const normalized = normText(text);
  const hasMn = DISCOUNT_KEYWORDS_MN.some((keyword) => normalized.includes(keyword));
  const hasEn = DISCOUNT_KEYWORDS_EN.some((keyword) => normalized.includes(keyword));
  return hasMn || hasEn;
}

export function hasPriceObjectionIntent(text: string): boolean {
  const normalized = normText(text);
  if (!normalized) return false;
  // "Нярай хүүхэд үнэтэй юу?" and "ямар үнэтэй вэ?" are real price questions.
  if (/[?？]/.test(text) || /\b(хэд|hed|ямар|yamar)\b/i.test(normalized) || /юу|уу|үү|вэ|ve/i.test(normalized)) {
    return false;
  }
  return (
    /\b(expensive|too expensive|pricey)\b/i.test(normalized) ||
    /үнэтэй|үнэ өндөр|арай үнэтэй|их үнэтэй|unetei|une ondor/i.test(normalized)
  );
}

export function buildPriceObjectionReply(text: string): string | null {
  if (!hasPriceObjectionIntent(text)) return null;
  return [
    "Тийм ээ, ойлгож байна. Үнэ өндөр санагдаж болно.",
    "Та ойролцоогоор хэдэн төгрөгийн төсөвтэй, хэдүүлээ явах вэ? Тэрэнд нь ойр аяллын хувилбар байвал шүүж өгье.",
  ].join("\n");
}

export function buildDiscountReply(
  text: string,
  trips: TravelTrip[],
  now = new Date(),
): string | null {
  const { best: bestRaw, ambiguous } = findBestTripMatch(text, trips);
  if (!bestRaw) {
    if (ambiguous.length) {
      const totalReply = buildAmbiguousPassengerTotalReply(text, ambiguous);
      if (totalReply) return totalReply;
      return buildAmbiguousTripReply(ambiguous);
    }
    const soldOut = buildSoldOutTripReply(text, trips);
    if (soldOut) return soldOut;
    const directUnavailable = buildDirectFlightUnavailableReply(text, trips);
    if (directUnavailable) return directUnavailable;
    return null;
  }
  const best = withFutureDepartureDates(bestRaw, now);

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
      formatTripBasePricePremium(best, now),
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

function buildTripInfoReply(rawTrip: TravelTrip, now = new Date()) {
  const trip = withFutureDepartureDates(rawTrip, now);
  const lines = [`✈️ ${formatRouteName(trip.route_name)}`, ""];

  const infoDuration = safeDurationText(trip.duration_text);
  if (infoDuration) {
    lines.push(`🗓 Хугацаа: ${infoDuration}`, "");
  }

  const priceBlock = formatTripBasePricePremium(trip, now);
  lines.push(priceBlock);

  const departureText = formatCompactDepartureList(trip.departure_dates).trim();
  const showDepartureSection = Boolean(departureText && !priceBlock.includes(departureText));
  if (showDepartureSection) {
    lines.push("", `📅 Гарах өдрүүд:`, departureText);
  }

  const seatMessage = getSeatSalesMessage(trip);
  if (seatMessage) {
    lines.push("", seatMessage);
  }

  if (isLandFlightCombo(trip)) {
    // No route claim here: the flight leg differs per trip. Naming a route
    // in code once told customers every combo trip flies UB–Beidaihe.
    lines.push("", "Энэ нь газар + нислэг хосолсон аялал.");
  }

  if (showDepartureSection) {
    lines.push("", "Та аль гарах өдрийг сонирхож байна вэ? 😊");
  }
  return lines.join("\n");
}

export function buildSeatsReply(text: string, trips: TravelTrip[]): string | null {
  const { best, ambiguous } = findBestTripMatch(text, trips);
  if (!best) {
    const soldOut = buildSoldOutTripReply(text, trips);
    if (soldOut) return soldOut;
    if (ambiguous.length) {
      const totalReply = buildAmbiguousPassengerTotalReply(text, ambiguous);
      if (totalReply) return totalReply;
      return buildAmbiguousTripReply(ambiguous);
    }
    return null;
  }

  return buildTripInfoReply(best);
}

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
const COMPARE_QUERY_STOP_WORDS = new Set([
  "аль",
  "дээр",
  "сайн",
  "ямар",
  "эсвэл",
  "хооронд",
  "ялгаа",
  "ялгаатай",
  "харьцуул",
  "байна",
  "байгаа",
  "better",
  "compare",
  "comparison",
  "versus",
]);

export function hasCompareIntent(text: string): boolean {
  const normalized = normText(text);
  const hasMn = COMPARE_KEYWORDS_MN.some((keyword) => normalized.includes(keyword));
  const hasEn = COMPARE_KEYWORDS_EN.some((keyword) => normalized.includes(keyword));
  return hasMn || hasEn;
}

export function hasBudgetIntent(text: string): boolean {
  const normalized = normText(text);
  return (
    normalized.includes("хамгийн хямд") ||
    normalized.includes("хямд аялал") ||
    normalized.includes("саяас доош") ||
    normalized.includes("сая дотор") ||
    normalized.includes("доош үнэтэй") ||
    normalized.includes("cheapest") ||
    normalized.includes("under budget")
  );
}

function extractBudgetLimit(text: string): number | null {
  const normalized = normText(text);
  const million = /(\d+(?:[.,]\d+)?)\s*сая/.exec(normalized);
  if (million) {
    const value = Number(million[1].replace(",", "."));
    if (Number.isFinite(value) && value > 0) return Math.round(value * 1_000_000);
  }
  const numeric = /(\d[\d\s,.]{4,})\s*(?:₮|mnt|төгрөг)/i.exec(text);
  if (numeric) {
    const value = Number.parseInt(numeric[1].replace(/[^\d]/g, ""), 10);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function lowestAdultPrice(trip: TravelTrip): number | null {
  const prices = [
    trip.adult_price,
    ...getStructuredPriceGroups(trip).map((group) =>
      typeof group.adult_price === "number" ? group.adult_price : null,
    ),
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  if (prices.length === 0) return null;
  return Math.min(...prices);
}

export function buildBudgetReply(
  text: string,
  trips: TravelTrip[],
  now = new Date(),
): string | null {
  const normalized = normText(text);
  const wantsCheapest = normalized.includes("хамгийн хямд") || normalized.includes("cheapest");
  const wantsDirect = hasDirectFlightIntent(text);
  const budgetLimit = extractBudgetLimit(text);
  if (!wantsCheapest && budgetLimit === null) return null;

  const candidates = trips
    .filter((trip) => trip.status === "active")
    .map((trip) => withFutureDepartureDates(trip, now))
    .filter((trip) => !wantsDirect || tripIsDirectFlight(trip))
    .map((trip) => ({ trip, price: lowestAdultPrice(trip) }))
    .filter((item): item is { trip: TravelTrip; price: number } =>
      typeof item.price === "number" && (budgetLimit === null || item.price <= budgetLimit),
    )
    .sort((a, b) => {
      if (a.price !== b.price) return a.price - b.price;
      return a.trip.route_name.localeCompare(b.trip.route_name, "mn");
    })
    .slice(0, wantsCheapest && budgetLimit === null ? 1 : 7);

  if (candidates.length === 0) {
    const directText = wantsDirect ? " шууд нислэгтэй" : "";
    const budgetText = budgetLimit ? ` ${formatMoney(budgetLimit, "MNT")}-аас доош` : "";
    return `Одоогоор${budgetText}${directText} аялал тодорхой олдсонгүй. Аяллын зөвлөхөөр ойролцоо хувилбар шалгуулъя.`;
  }

  const title = wantsCheapest
    ? (wantsDirect ? "Хамгийн хямд шууд нислэгтэй аяллууд:" : "Хамгийн хямд аяллууд:")
    : `${formatMoney(budgetLimit, "MNT")}-аас доош үнэтэй аяллууд:`;
  const lines = [title];
  for (const { trip, price } of candidates) {
    const parts = [`• ${trip.route_name}`];
    const duration = safeDurationText(trip.duration_text);
    if (duration) parts.push(duration);
    parts.push(`том хүн ${formatMoney(price, trip.currency || "MNT")}`);
    // Only pair child with adult when the shown adult IS the trip's base price.
    // When `price` is a lower date-group price, the base child_price would be a
    // mismatched pair (a discounted adult beside a full-price child), so leave
    // child out rather than print an inconsistent couple.
    if (typeof trip.child_price === "number" && price === trip.adult_price) {
      parts.push(`хүүхэд ${formatMoney(trip.child_price, trip.currency || "MNT")}`);
    }
    if (trip.departure_dates.length > 0) {
      parts.push(`гарах: ${formatCompactDepartureList(trip.departure_dates)}`);
    }
    lines.push(parts.join(" — "));
  }
  lines.push("Аль аяллыг нь сонирхож байна вэ?");
  return lines.join("\n");
}

function hasStandalonePriceLookupIntent(text: string): boolean {
  const normalized = normText(text);
  if (extractNormalizedPrice(text) === null) return false;
  if (
    normalized.includes("төлсөн") ||
    normalized.includes("шилжүүл") ||
    normalized.includes("баримт") ||
    normalized.includes("баталгааж")
  ) {
    return false;
  }
  return (
    normalized.includes("гэсэн аялал") ||
    normalized.includes("аль аялал") ||
    normalized.includes("ямар аялал") ||
    normalized.includes("аль нь") ||
    normalized.includes("үнэтэй аялал")
  );
}

function buildStandalonePriceLookupReply(text: string, trips: TravelTrip[]): string | null {
  if (!hasStandalonePriceLookupIntent(text)) return null;
  const price = extractNormalizedPrice(text);
  if (price === null) return null;

  const matches: Array<{ trip: TravelTrip; label: string }> = [];
  const seen = new Set<string>();
  const add = (trip: TravelTrip, label: string, value: number | null | undefined) => {
    if (typeof value !== "number" || value !== price || seen.has(trip.id)) return;
    seen.add(trip.id);
    matches.push({ trip, label });
  };

  for (const trip of trips) {
    if (trip.status !== "active") continue;
    add(trip, "Том хүн", trip.adult_price);
    add(trip, "Хүүхэд", trip.child_price);

    for (const group of getStructuredPriceGroups(trip)) {
      for (const value of getPriceValuesFromGroup(group, "adult")) {
        add(trip, value.kind === "child" ? "Хүүхэд" : value.kind === "infant" ? "Нярай" : "Том хүн", value.value);
      }
    }
    for (const group of getPriceGroups(trip)) {
      for (const value of getPriceValuesFromGroup(group, "adult")) {
        add(trip, value.kind === "child" ? "Хүүхэд" : value.kind === "infant" ? "Нярай" : "Том хүн", value.value);
      }
    }
    for (const discount of getStructuredDiscounts(trip)) {
      for (const value of getPriceValuesFromGroup(discount, "discount")) {
        add(trip, value.kind === "discount" ? "Хямдрал" : value.kind === "child" ? "Хүүхэд" : "Том хүн", value.value);
      }
    }
  }

  if (matches.length === 0) return null;
  const priceText = formatMoney(price, "MNT") || `${price}`;
  const lines = [`${priceText} үнэтэй тохирох аяллууд:`];
  for (const { trip, label } of matches.slice(0, 6)) {
    const duration = safeDurationText(trip.duration_text);
    const parts = [`• ${trip.route_name}`, label];
    if (duration) parts.push(duration);
    if (trip.departure_dates.length > 0) {
      parts.push(`гарах: ${formatCompactDepartureList(trip.departure_dates)}`);
    }
    lines.push(parts.join(" — "));
  }
  if (matches.length > 6) lines.push(`... нийт ${matches.length} тохирол байна.`);
  lines.push("Аль аяллыг нь сонирхож байна вэ?");
  return lines.join("\n");
}

function extractPassengerCounts(text: string): { adult: number; child: number; infant: number } | null {
  const normalized = normText(text);
  const hasTotalIntent =
    normalized.includes("нийт") ||
    normalized.includes("хэд болох") ||
    normalized.includes("нийлээд") ||
    normalized.includes("total");
  if (!hasTotalIntent) return null;

  const readCount = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const match = pattern.exec(normalized);
      if (!match) continue;
      const value = Number(match[1]);
      if (Number.isInteger(value) && value >= 0 && value <= 50) return value;
    }
    return 0;
  };

  // "2 том хүн" (number first) vs "том хүн 2" (number after). Detect the convention
  // so "том хүн (\d)" doesn't grab the NEXT group's number in "2 том хүн 1 хүүхэд".
  const numberFirst = /\d+\s*(?:том\s+хүн|насанд хүрэгч|adult)/i.test(normalized);
  const pick = (numFirst: RegExp[], nounFirst: RegExp[]) =>
    numberFirst ? [...numFirst, ...nounFirst] : [...nounFirst, ...numFirst];
  const adult = readCount(pick(
    [/(\d{1,2})\s*(?:том(?:\s+хүн)?|насанд хүрэгч|adult)/i],
    [/(?:том\s+хүн|насанд хүрэгч|adult)\s*(\d{1,2})/i],
  ));
  const child = readCount(pick(
    [/(\d{1,2})\s*(?:хүүхэд|child)/i],
    [/(?:хүүхэд|child)\s*(\d{1,2})/i],
  ));
  const infant = readCount(pick(
    [/(\d{1,2})\s*(?:нярай|infant)/i],
    [/(?:нярай|infant)\s*(\d{1,2})/i],
  ));
  if (adult + child + infant <= 0) return null;
  return { adult, child, infant };
}

function buildPassengerTotalReply(
  trip: TravelTrip,
  text: string,
  now = new Date(),
): string | null {
  const currentLine = text.split("\n").pop() || text;
  const counts = extractPassengerCounts(currentLine);
  if (!counts) return null;

  const currency = trip.currency || "MNT";
  const monthDay = extractDatesFromText(currentLine)[0];
  const group = monthDay ? findPriceGroupByMonthDay(trip, monthDay.month, monthDay.day, now) : null;
  const structuredGroup = !group ? getStructuredPriceGroups(trip)[0] : null;
  const selected = (group || structuredGroup || null) as Record<string, unknown> | null;
  const adultPrice = typeof selected?.adult_price === "number" ? selected.adult_price : trip.adult_price;
  const childPrice = typeof selected?.child_price === "number" ? selected.child_price : trip.child_price;
  const infantPrice = typeof selected?.infant_price === "number" ? selected.infant_price : null;

  const rows: string[] = [];
  let total = 0;
  const add = (label: string, count: number, price: number | null | undefined) => {
    if (count <= 0) return;
    if (typeof price !== "number") {
      rows.push(`• ${label} ${count}: үнэ тодорхойгүй`);
      return;
    }
    const subtotal = count * price;
    total += subtotal;
    rows.push(`• ${label} ${count} x ${formatMoney(price, currency)} = ${formatMoney(subtotal, currency)}`);
  };

  add("Том хүн", counts.adult, adultPrice);
  add("Хүүхэд", counts.child, childPrice);
  add("Нярай", counts.infant, infantPrice);
  if (total <= 0) return null;

  const label = monthDay ? `${monthDay.month} сарын ${monthDay.day}-ны ` : "";
  return [`✈️ ${trip.route_name}`, `💰 ${label}нийт: ${formatMoney(total, currency)}`, ...rows].join("\n");
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

  let matched = activeTrips.filter((trip) => {
    const keywords = unique(keywordTokens(trip.route_name));
    const matchedWords = keywords.filter((word) => query.includes(word));
    return matchedWords.length >= Math.min(2, keywords.length);
  });

  if (matched.length < 2) {
    const broadTokens = unique(keywordTokens(query))
      .filter((word) => !COMPARE_QUERY_STOP_WORDS.has(word));
    const broadMatches: TravelTrip[] = [];
    for (const token of broadTokens) {
      const best = activeTrips
        .filter((trip) => getTripSearchHaystack(trip).includes(token))
        .sort((a, b) => {
          const aPrice = typeof a.adult_price === "number" ? a.adult_price : Number.MAX_SAFE_INTEGER;
          const bPrice = typeof b.adult_price === "number" ? b.adult_price : Number.MAX_SAFE_INTEGER;
          return aPrice - bPrice;
        })[0];
      if (best && !broadMatches.some((trip) => trip.id === best.id)) {
        broadMatches.push(best);
      }
    }
    if (broadMatches.length >= 2) matched = broadMatches;
  }

  if (matched.length < 2) return null;
  const candidates = matched.slice(0, 4).map((trip) => withFutureDepartureDates(trip));

  const lines: string[] = ["📊 Аялал харьцуулалт:", ""];
  for (const trip of candidates) {
    const price = formatMoney(trip.adult_price, trip.currency);
    lines.push(`▶ ${trip.route_name}`);
    lines.push(`Үнэ (том хүн): ${price || "тодорхойгүй"}`);
    lines.push(`Хугацаа: ${safeDurationText(trip.duration_text) || "тодорхойгүй"}`);
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
      const blockDuration = safeDurationText(match.trip.duration_text);
      if (blockDuration) lines.push(`🗓 Хугацаа: ${blockDuration}`);
      for (const field of getCombinedMatchPriceFields(match)) {
        const formatted = formatMoney(field.value, match.trip.currency || "MNT");
        if (formatted) lines.push(`💰 ${field.label}: ${formatted}`);
      }
      if (isLandFlightCombo(match.trip)) {
        lines.push("Энэ нь газар + нислэг хосолсон аялал.");
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
    const closeDuration = safeDurationText(match.trip.duration_text);
    const duration = closeDuration ? ` • ${closeDuration}` : "";
    const priceText = formatMoney(match.matchedPrice, match.trip.currency || "MNT");
    lines.push(`• ${match.trip.route_name}${duration}${priceText ? ` • ${priceText}` : ""}`);
  }
  return lines.join("\n");
}

function buildDirectFlightUnavailableReply(text: string, trips: TravelTrip[]): string | null {
  if (!hasDirectFlightIntent(text)) return null;
  const nearby = findBestTripMatch(
    text
      .replace(/шууд\s+нислэгтэй/gi, "")
      .replace(/шууд\s+нислэг/gi, "")
      .replace(/direct\s+flight/gi, ""),
    trips,
  );
  const options = nearby.ambiguous.length
    ? nearby.ambiguous
    : nearby.best
      ? [nearby.best]
      : [];
  if (options.length === 0) return null;
  const names = options
    .slice(0, 3)
    .map((trip) => {
      const kind = tripIsLandFlightCombo(trip)
        ? "газар + нислэг хосолсон"
        : trip.category || "өөр хувилбар";
      return `• ${trip.route_name} (${kind})`;
    });
  return [
    "Тэр чиглэлд яг шууд нислэгтэй аялал одоогоор тодорхой олдсонгүй.",
    "Ойролцоо байгаа хувилбарууд:",
    ...names,
    "Та эдгээрээс алийг нь сонирхож байна вэ?",
  ].join("\n");
}

function buildSoldOutTripReply(text: string, trips: TravelTrip[]): string | null {
  const soldOutTrips = trips.filter((trip) => trip.status === "sold_out");
  if (soldOutTrips.length === 0) return null;

  const { best, ambiguous } = findBestTripMatch(text, soldOutTrips, { includeSoldOut: true });
  if (!best && ambiguous.length === 0) return null;

  if (!best && ambiguous.length > 0) {
    return [
      "Таны асуусан нэрээр суудал дууссан хэд хэдэн аялал байна.",
      "Алийг нь хэлж байгаагаа нэг тодруулаад бичээрэй:",
      ...ambiguous.slice(0, 3).map((trip) => `• ${trip.route_name}`),
    ].join("\n");
  }
  if (!best) return null;

  // A sold-out answer that stops at "дууссан" buries the sellable catalog: a
  // generic "Бээжин" question was leading with the dead Universal trip while
  // three bookable Beijing trips went unmentioned. Pitch ACTIVE trips that
  // share the sold-out trip's destination words (data-driven — never
  // hardcoded names) in the same breath, like a human agent would.
  const soldOutTokens = unique([
    ...keywordTokens(best.route_name),
    ...getAliases(best).flatMap((alias) => keywordTokens(alias)),
  ]).filter((token) => token.length >= 4);
  const alternatives = trips
    .filter((trip) => trip.status === "active" && trip.id !== best.id)
    .map((trip) => {
      const candidateTokens = new Set([
        ...keywordTokens(trip.route_name),
        ...getAliases(trip).flatMap((alias) => keywordTokens(alias)),
        ...keywordTokens(trip.source_description || ""),
      ]);
      const overlap = soldOutTokens.filter((token) => candidateTokens.has(token));
      return { trip, score: overlap.length, overlap };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aPrice = typeof a.trip.adult_price === "number" ? a.trip.adult_price : Number.MAX_SAFE_INTEGER;
      const bPrice = typeof b.trip.adult_price === "number" ? b.trip.adult_price : Number.MAX_SAFE_INTEGER;
      return aPrice - bPrice;
    })
    .slice(0, 3)
    .map((candidate) => candidate.trip);

  if (alternatives.length > 0) {
    const altLines = alternatives.map((trip) => {
      const duration = safeDurationText(trip.duration_text);
      const price = formatMoney(trip.adult_price, trip.currency || "MNT");
      const details = [duration, price ? `Том хүн: ${price}` : ""]
        .filter(Boolean)
        .join(" — ");
      return `• ${trip.route_name}${details ? ` (${details})` : ""}`;
    });
    return [
      `✈️ ${best.route_name} — энэ аяллын суудал дууссан байна.`,
      "",
      "Гэхдээ ижил чиглэлд эдгээр аялал нээлттэй байна:",
      ...altLines,
      "",
      "Аль нь сонирхол татаж байна вэ? 😊",
    ].join("\n");
  }

  return [
    `✈️ ${best.route_name}`,
    "Энэ аяллын суудал дууссан байна.",
    "Одоогоор захиалга авах боломжгүй тул ижил төстэй өөр хувилбарыг аяллын зөвлөхөөс тодруулж өгье.",
  ].join("\n");
}

export function buildStructuredTripReply(
  text: string,
  trips: TravelTrip[],
  now = new Date(),
): string | null {
  // `text` can be a contextual blob with an earlier turn (often the bot's own
  // previous reply, full of real dates and prices) prepended before the
  // customer's actual current message — see contextualText.ts. A combined
  // date+price query ("7 сарын 9-нд 2,150,000-аар байна уу?") is only ever a
  // deliberate statement in the CURRENT message; scanning the whole blob lets
  // stray numbers from the stale previous reply (e.g. an age range "2-10 нас"
  // read as a date, or an old price) misfire this match. Use only the last
  // line for this specific detector.
  const currentLine = text.split("\n").pop() || text;
  const standalonePriceLookupReply = buildStandalonePriceLookupReply(currentLine, trips);
  if (standalonePriceLookupReply) return standalonePriceLookupReply;

  const combinedDatePrice = findCombinedDatePriceMatches(currentLine, trips);
  if (combinedDatePrice) {
    const combinedReply = formatCombinedDatePriceReply(combinedDatePrice);
    if (combinedReply) return combinedReply;
  }

  const routeOnlyCandidate = !isStructuredTripQuestion(text) && !hasDatePriceConstraint(text)
    ? findBestTripMatch(text, trips)
    : null;
  if (!isStructuredTripQuestion(text) && !hasDatePriceConstraint(text)) {
    if (!routeOnlyCandidate?.best) {
      if (routeOnlyCandidate?.ambiguous?.length) {
        const totalReply = buildAmbiguousPassengerTotalReply(currentLine, routeOnlyCandidate.ambiguous);
        if (totalReply) return totalReply;
        return buildAmbiguousTripReply(routeOnlyCandidate.ambiguous);
      }
      const soldOut = buildSoldOutTripReply(text, trips);
      if (soldOut) return soldOut;
      const directUnavailable = buildDirectFlightUnavailableReply(text, trips);
      if (directUnavailable) return directUnavailable;
      return null;
    }
    return buildTripInfoReply(routeOnlyCandidate.best, now);
  }

  const matchedTrip = findBestTripMatch(text, trips);
  let bestRaw = matchedTrip.best;
  const { ambiguous } = matchedTrip;
  if (
    !bestRaw &&
    hasPriceIntent(currentLine) &&
    /нярай|infant/i.test(currentLine)
  ) {
    const candidatesWithInfantPrice = ambiguous.filter(hasInfantPrice);
    if (candidatesWithInfantPrice.length === 1) {
      bestRaw = candidatesWithInfantPrice[0];
    }
  }
  if (!bestRaw) {
    if (ambiguous.length) {
      const totalReply = buildAmbiguousPassengerTotalReply(currentLine, ambiguous);
      if (totalReply) return totalReply;
      return buildAmbiguousTripReply(ambiguous);
    }
    const soldOut = buildSoldOutTripReply(text, trips);
    if (soldOut) return soldOut;
    const directUnavailable = buildDirectFlightUnavailableReply(text, trips);
    if (directUnavailable) return directUnavailable;
    return null;
  }
  let best = withFutureDepartureDates(bestRaw, now);
  const currentMonthDays = extractDatesFromText(currentLine);
  if (currentMonthDays.length > 0) {
    const bestHasRequestedDate = currentMonthDays.some((md) =>
      Boolean(findPriceGroupByMonthDay(best, md.month, md.day, now)),
    );
    if (!bestHasRequestedDate) {
      const datedTrips = trips.filter((trip) =>
        trip.status === "active" &&
        currentMonthDays.some((md) => Boolean(findPriceGroupByMonthDay(trip, md.month, md.day, now))),
      );
      const bestRouteTokens = unique(keywordTokens(best.route_name));
      const relatedByRoute = datedTrips
        .map((trip) => ({
          trip,
          overlap: unique(keywordTokens(trip.route_name)).filter((token) =>
            bestRouteTokens.includes(token),
          ).length,
        }))
        .filter((item) => item.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap);
      if (relatedByRoute[0] && (!relatedByRoute[1] || relatedByRoute[0].overlap > relatedByRoute[1].overlap)) {
        best = withFutureDepartureDates(relatedByRoute[0].trip, now);
      } else {
        const datedMatch = datedTrips.length > 0 ? findBestTripMatch(text, datedTrips) : null;
        if (datedMatch?.best && datedMatch.best.id !== best.id) {
          best = withFutureDepartureDates(datedMatch.best, now);
        }
      }
    }
  }

  // If a broad destination match lands on a variant with no infant price,
  // prefer a uniquely matching sibling variant that actually has the detail
  // the customer requested. This avoids referring "Бэйдайхэ нярай хэд вэ?"
  // when the combo itinerary has a stored infant price and the ground one does
  // not.
  if (
    hasPriceIntent(currentLine) &&
    /нярай|infant/i.test(currentLine) &&
    !hasInfantPrice(best)
  ) {
    const routeTokens = unique(keywordTokens(best.route_name));
    const infantCandidates = trips.filter((trip) => {
      if (trip.status !== "active" || trip.id === best.id || !hasInfantPrice(trip)) return false;
      const candidateTokens = unique(keywordTokens(trip.route_name));
      return candidateTokens.some((token) => routeTokens.includes(token));
    });
    const infantMatch = infantCandidates.length > 0
      ? findBestTripMatch(text, infantCandidates)
      : null;
    if (infantMatch?.best) {
      best = withFutureDepartureDates(infantMatch.best, now);
    }
  }

  // A phrase such as "8 сарын хүүхдийн үнэ өөр үү?" contains comparison
  // wording, but its primary constraint is a passenger type in one month.
  // Resolve that exact slice before the broad same-price comparison fallback,
  // which otherwise prints the complete price table.
  const monthPassengerTypeReply = extractMonthOnlyFromText(currentLine) !== null && hasPriceIntent(currentLine)
    ? buildPassengerTypePriceReply(best, currentLine, now)
    : null;
  if (monthPassengerTypeReply) return monthPassengerTypeReply;

  const samePriceReply = buildSameTripPriceComparisonReply(best, text, now);
  if (samePriceReply && hasSamePriceComparisonIntent(text)) {
    return samePriceReply;
  }
  if (hasSamePriceComparisonIntent(text) && !samePriceReply) {
    const fallbackLines = [
      `✈️ ${best.route_name}`,
      formatTripBasePricePremium(best, now),
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
  const passengerTotalReply = askedPrice ? buildPassengerTotalReply(best, text, now) : null;
  if (passengerTotalReply) return passengerTotalReply;
  const ageSpecificReply = askedPrice ? buildAgeSpecificPriceReply(best, text) : null;
  if (ageSpecificReply) return ageSpecificReply;
  const passengerTypeReply = askedPrice ? buildPassengerTypePriceReply(best, text, now) : null;
  if (passengerTypeReply) return passengerTypeReply;
  const ticketPreference = askedPrice ? getTicketPreference(text) : null;
  if (ticketPreference) {
    const matchingGroups = getStructuredPriceGroups(best).filter((group) => priceGroupMatchesTicketPreference(group, ticketPreference));
    const filteredReply = formatSelectedPriceGroups(best, matchingGroups, now);
    if (filteredReply) return filteredReply;
    return "REFER";
  }
  if (!askedPrice && !askedDuration && !askedSchedule && !askedDirectFlight && !askedExistence) {
    return buildTripInfoReply(best);
  }
  // Scoped to the current line only (see comment on `currentLine` above): a
  // bare "N-M" pattern like an age range "(2-10 нас)" surviving from a stale
  // prepended previous reply reads as a valid month/day and rolls forward to
  // a bogus future date otherwise.
  const requestedDates = unique(parseDepartureDateText(currentLine, now));

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
    lines.push(`🗓 Хугацаа: ${safeDurationText(best.duration_text) || "Хугацааны мэдээлэл алга байна."}`);
  }

  // Detect if user asked about a specific month only (without a specific day)
  const askedMonthOnly = extractMonthOnlyFromText(currentLine);

  if (askedPrice) {
    const mnDates = extractDatesFromText(currentLine);
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
      const feesLine = formatExtraFeesLine(best);
      if (feesLine) lines.push(feesLine);
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
          const futureDates = filterFutureDepartureDates(rawDates, now);
          // Only show dates belonging to this month
          const monthDates = futureDates.filter((d) => normalizeMnDate(d).some((nd) => nd.month === askedMonthOnly));
          if (rawDates.length > 0 && monthDates.length === 0) continue;
          const dateDisplay = monthDates.length > 0 ? compactDates(monthDates) : (typeof g.label === "string" ? g.label : "");
          if (dateDisplay) {
            lines.push(`  ${dateDisplay}: ${priceParts.join(" | ")}`);
          } else if (priceParts.length) {
            lines.push(`  ${priceParts.join(" | ")}`);
          }
        }
        const childRulesStr = formatChildRules(best, currency);
        if (childRulesStr) lines.push(childRulesStr);
        const feesLine = formatExtraFeesLine(best);
        if (feesLine) lines.push(feesLine);
      } else {
        // Fall back to full price table
        lines.push(formatTripBasePricePremium(best, now));
      }
    } else if (requestedDates.length > 0) {
      for (const ymd of requestedDates) {
        lines.push(formatSpecificDatePrice(best, ymd, ymd, now));
      }
      const feesLine = formatExtraFeesLine(best);
      if (feesLine) lines.push(feesLine);
    } else {
      lines.push(formatTripBasePricePremium(best, now));
    }
  }

  // Schedule: filter departure_dates to asked month if applicable
  if (askedSchedule || (askedPrice && best.departure_dates.length > 0)) {
    if (askedMonthOnly !== null && best.departure_dates.length > 0) {
      const monthDates = filterFutureDepartureDates(best.departure_dates, now).filter((d) => {
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
        const departureText = formatDepartureDates(best).trim();
        if (departureText) lines.push(`📅 Гарах өдрүүд: ${departureText}`);
      }
    } else {
      const departureText = formatDepartureDates(best).trim();
      if (departureText) lines.push(`📅 Гарах өдрүүд: ${departureText}`);
    }
  }

  if (
    !askedPrice &&
    !askedDuration &&
    !askedSchedule &&
    !askedDirectFlight &&
    askedExistence
  ) {
    lines.push(`🗓 Хугацаа: ${safeDurationText(best.duration_text) || "Мэдээлэл алга байна."}`);
    lines.push(formatTripBasePricePremium(best, now));
    if (best.departure_dates.length > 0) {
      const departureText = formatDepartureDates(best).trim();
      if (departureText) lines.push(`📅 Гарах өдрүүд: ${departureText}`);
    }
  }

  if (askedDirectFlight && !askedDuration) {
    lines.push(`🗓 Хугацаа: ${safeDurationText(best.duration_text) || "Хугацааны мэдээлэл алга байна."}`);
  }

  if (lines.length === 1) {
    lines.push(`🗓 Хугацаа: ${safeDurationText(best.duration_text) || "Мэдээлэл алга байна."}`);
    lines.push(formatTripBasePricePremium(best, now));
  }

  return lines.join("\n");
}

// Re-export every public symbol from the sibling modules so existing imports
// of `from "../../lib/travelFastPaths"` (webhook.ts, demo.ts, welcomeFlow.ts,
// tests) keep working unchanged after the split.
export * from "./travelFastPathsSearch";
export * from "./travelFastPathsProgram";
export * from "./travelFastPathsPricing";
