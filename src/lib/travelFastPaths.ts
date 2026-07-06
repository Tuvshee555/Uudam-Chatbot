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

import { parseDepartureDateText } from "./travelDates";
import type { TravelTrip } from "./travelOps";
import {
  DISCOUNT_KEYWORDS_EN,
  DISCOUNT_KEYWORDS_MN,
  formatMoney,
  getAliases,
  getStructuredDiscounts,
  getStructuredPriceGroups,
  getTripSearchHaystack,
  keywordTokens,
  matchScoreForPriceKind,
  normText,
  findBestTripMatch,
  getPriceGroups,
  getPriceValuesFromGroup,
  isStructuredTripQuestion,
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

export function hasDiscountIntent(text: string): boolean {
  const normalized = normText(text);
  const hasMn = DISCOUNT_KEYWORDS_MN.some((keyword) => normalized.includes(keyword));
  const hasEn = DISCOUNT_KEYWORDS_EN.some((keyword) => normalized.includes(keyword));
  return hasMn || hasEn;
}

export function buildDiscountReply(
  text: string,
  trips: TravelTrip[],
  now = new Date(),
): string | null {
  const { best: bestRaw, ambiguous } = findBestTripMatch(text, trips);
  if (!bestRaw) return ambiguous.length ? buildAmbiguousTripReply(ambiguous) : null;
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

  if (trip.duration_text) {
    lines.push(`🗓 Хугацаа: ${trip.duration_text}`, "");
  }

  lines.push(formatTripBasePricePremium(trip));

  if (trip.departure_dates.length > 0) {
    lines.push("", `📅 Гарах өдрүүд:`, formatCompactDepartureList(trip.departure_dates));
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

  lines.push("", "Та аль гарах өдрийг сонирхож байна вэ? 😊");
  return lines.join("\n");
}

export function buildSeatsReply(text: string, trips: TravelTrip[]): string | null {
  const { best, ambiguous } = findBestTripMatch(text, trips);
  if (!best) return ambiguous.length ? buildAmbiguousTripReply(ambiguous) : null;

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
  const candidates = matched.slice(0, 4).map((trip) => withFutureDepartureDates(trip));

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
    return buildTripInfoReply(routeOnlyCandidate.best, now);
  }

  const { best: bestRaw, ambiguous } = findBestTripMatch(text, trips);
  if (!bestRaw) return ambiguous.length ? buildAmbiguousTripReply(ambiguous) : null;
  const best = withFutureDepartureDates(bestRaw, now);

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

// Re-export every public symbol from the sibling modules so existing imports
// of `from "../../lib/travelFastPaths"` (webhook.ts, demo.ts, welcomeFlow.ts,
// tests) keep working unchanged after the split.
export * from "./travelFastPathsSearch";
export * from "./travelFastPathsProgram";
export * from "./travelFastPathsPricing";
