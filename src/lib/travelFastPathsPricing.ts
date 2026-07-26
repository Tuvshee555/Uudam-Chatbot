/**
 * Date/price parsing utilities and price-formatting reply builders for the
 * fast-path layer: intent detectors (price/duration/schedule/flight/etc.),
 * Mongolian date-text parsing, price-group lookups, and the price-focused
 * reply fragments reused by the top-level structured-reply builder.
 */

import { filterFutureDepartureDates, parseDepartureDateText } from "./travelDates";
import type { TravelTrip } from "./travelOps";
import {
  formatMoney,
  getPriceGroups,
  getStructuredPriceGroups,
  isDocumentedFreeFare,
  isInfantShapedAge,
  normText,
  unique,
  uniqueMonthDays,
  type DepartureDateGroup,
  type MonthDay,
} from "./travelFastPathsSearch";

/**
 * Passenger fares only. A 0₮ adult/child/infant price is missing data from an
 * extracted poster, not a real free seat — and rendered verbatim it tells the
 * customer "Нярай: 0₮", i.e. this passenger travels free, which the agency then
 * has to either honour or argue out of a screenshot. Treat non-positive fares as
 * absent so the caller falls back to a real price or stays silent.
 *
 * Deliberately NOT applied to deposits, discounts or extra fees: a genuine 0
 * there ("no deposit required") is meaningful, so those keep using formatMoney.
 */
export function formatPassengerMoney(value: number | null | undefined, currency: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return formatMoney(value, currency);
}

const DIRECT_FLIGHT_POSITIVE_PATTERNS = [/шууд\s+нислэг/i];
const DIRECT_FLIGHT_NEGATIVE_PATTERNS = [
  /газар\s*\+\s*нислэг/i,
  /газар\s+нислэг\s+хосолсон/i,
  /газар\s+аялал/i,
  /газрын\s+аялал/i,
];

export function hasPriceIntent(text: string) {
  return (
    /үнэ|хэд\s+вэ|хэдээр|хэд\s+болох|нийт|төлбөр|price|cost|total/i.test(text) ||
    /(\d{1,2}\s*(?:настай|нас|сар|сартай)\s*(?:хүүхэд|нярай)?|(?:хүүхэд|нярай)\s*\d{1,2}\s*(?:настай|нас|сар|сартай))/i.test(text)
  );
}

export function hasDurationIntent(text: string) {
  return /хэдэн\s+өдөр|хэд\s+хоног|үргэлжил|duration|how long/i.test(text);
}

export function hasScheduleIntent(text: string) {
  return /гарах|огноо|хуваарь|хэзээ|schedule|date/i.test(text);
}

export function hasDirectFlightIntent(text: string) {
  return /шууд\s+нислэг|нислэгтэй\s+юу|flight/i.test(text);
}

export function hasExistenceIntent(text: string) {
  return /байна\s+уу|байгаа\s+юу|байх\s+уу|available/i.test(text);
}

export function hasSamePriceComparisonIntent(text: string) {
  return hasPriceIntent(text) && /адилхан|ижил|ялгаатай|өөр\s+үү/i.test(text);
}

export function detectDirectFlight(trip: TravelTrip) {
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

export function isLandFlightCombo(trip: TravelTrip) {
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

export function formatDepartureDates(trip: TravelTrip) {
  if (!trip.departure_dates.length) return "Гарах өдрийн мэдээлэл одоогоор баталгаажаагүй байна.";
  return trip.departure_dates.join(", ");
}

export function formatRouteName(routeName: string) {
  return routeName.replace(/\s*\+\s*/g, " + ").replace(/\s{2,}/g, " ").trim();
}

export function formatPassengerPriceLines(input: {
  adult?: number | null;
  child?: number | null;
  infant?: number | null;
  childAge?: string | null;
  infantAge?: string | null;
  currency: string;
  // Set when the catalog documents this fare as genuinely free (child_rules
  // note "Үнэгүй"), NOT merely absent — see isDocumentedFreeFare. Without
  // this, a real 0₮ policy and a missing-data 0 both look identical, and
  // formatPassengerMoney's default of treating <=0 as absent would hide a
  // fare the agency actually wants advertised.
  childFree?: boolean;
  infantFree?: boolean;
}) {
  const lines: string[] = [];
  const adult = formatPassengerMoney(input.adult ?? null, input.currency);
  const child = input.childFree ? "Үнэгүй" : formatPassengerMoney(input.child ?? null, input.currency);
  const infant = input.infantFree ? "Үнэгүй" : formatPassengerMoney(input.infant ?? null, input.currency);
  const childAge = input.childAge?.trim() ? ` /${input.childAge.trim()}/` : "";
  const infantAge = input.infantAge?.trim() ? ` /${input.infantAge.trim()}/` : "";

  if (adult) lines.push(`• Том хүн: ${adult}`);
  if (child) lines.push(`• Хүүхэд${childAge}: ${child}`);
  if (infant) lines.push(`• Нярай${infantAge}: ${infant}`);
  return lines;
}

export function getImportantNotes(trip: TravelTrip): string[] {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  return Array.isArray(extra.important_notes)
    ? (extra.important_notes as string[]).filter((value) => typeof value === "string" && value.trim())
    : [];
}

export function getTicketPreference(text: string): "with" | "without" | null {
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

export function priceGroupMatchesTicketPreference(
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

export function formatSelectedPriceGroups(
  trip: TravelTrip,
  groups: Array<Record<string, unknown>>,
  now = new Date(),
): string | null {
  if (!groups.length) return null;
  const currency = trip.currency || "MNT";
  const childFree = isDocumentedFreeFare(trip, "child");
  const infantFree = isDocumentedFreeFare(trip, "infant");
  const lines: string[] = [`✈️ ${trip.route_name}`, "💰 Үнэ:"];
  let pricedGroups = 0;
  for (const group of groups) {
    const groupLabel = typeof group.label === "string" ? group.label : "";
    const rawDates = getPriceGroupDisplayDates(group);
    const futureDates = filterFutureDepartureDates(rawDates, now);
    if (rawDates.length > 0 && futureDates.length === 0) continue;
    // Suppressed 0₮ fares can leave a group with no price lines at all; emitting
    // its label and dates anyway would show the customer a date heading with no
    // number under it, so skip the whole group instead.
    const priceLines = formatPassengerPriceLines({
      adult: typeof group.adult_price === "number" ? group.adult_price : null,
      child: typeof group.child_price === "number" ? group.child_price : null,
      infant: typeof group.infant_price === "number" ? group.infant_price : null,
      childAge: typeof group.child_age === "string" ? group.child_age : "",
      infantAge: typeof group.infant_age === "string" ? group.infant_age : "",
      currency,
      childFree,
      infantFree,
    });
    if (priceLines.length === 0) continue;
    const dateLabel = futureDates.length > 0
      ? formatGroupDateLabel(futureDates)
      : "";
    const labelHasDates = normalizeMnDate(groupLabel).length > 0;
    if (groupLabel && !labelHasDates) lines.push("", groupLabel);
    if (dateLabel && dateLabel !== groupLabel) lines.push(dateLabel);
    lines.push(...priceLines);
    pricedGroups += 1;
  }
  if (pricedGroups === 0) return null;
  const feesLine = formatExtraFeesLine(trip);
  if (feesLine) lines.push(feesLine);
  return lines.join("\n");
}

export function extractAgeRangeIntent(text: string): { min: number; max: number; target: "child" | "infant" } | null {
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

export function extractSingleAgeIntent(text: string): { age: number; target: "child" | "infant" } | null {
  const beforeTarget = /(хүүхэд|нярай)?\s*(\d{1,2})\s*(настай|нас|сар|сартай)\b/i.exec(text);
  const afterTarget = /(?:^|[^\d-])(\d{1,2})\s*(настай|нас|сар|сартай)\s*(хүүхэд|нярай)?/i.exec(text);
  const match = beforeTarget || afterTarget;
  if (!match) return null;

  const age = Number.parseInt(beforeTarget ? match[2] : match[1], 10);
  if (Number.isNaN(age)) return null;
  const unit = beforeTarget ? match[3] : match[2];
  const explicitTarget = beforeTarget ? match[1] : match[3];
  const target = explicitTarget === "нярай" || unit.includes("сар")
    ? "infant"
    : explicitTarget === "хүүхэд"
      ? "child"
      : age <= 1
        ? "infant"
        : "child";
  return { age, target };
}

export function extractRangePriceFromText(
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

function parseAgeRange(text: string): { min: number; max: number } | null {
  const rangeMatch = /(\d{1,2})\s*[-–]\s*(\d{1,2})/.exec(text);
  if (!rangeMatch) return null;
  const min = Number.parseInt(rangeMatch[1], 10);
  const max = Number.parseInt(rangeMatch[2], 10);
  if (Number.isNaN(min) || Number.isNaN(max)) return null;
  return { min, max };
}

function ruleMatchesTarget(rule: Record<string, unknown>, target: "child" | "infant"): boolean {
  const label = typeof rule.label === "string" ? normText(rule.label) : "";
  const range = typeof rule.age_range === "string" ? normText(rule.age_range) : "";
  const haystack = `${label} ${range}`;
  if (target === "infant") return haystack.includes("нярай") || haystack.includes("infant") || haystack.includes("сар");
  return !haystack.includes("нярай") && !haystack.includes("infant") && !haystack.includes("сар");
}

function findSingleAgePriceInText(text: string, target: "child" | "infant", age: number): number | null {
  const role = target === "infant" ? "(нярай|infant)" : "(хүүхэд|child)";
  const pattern = new RegExp(`${role}[^\\d]{0,10}(\\d{1,2})\\s*[-–]\\s*(\\d{1,2})\\s*(?:нас|сар|сартай|age)[^\\d]{0,10}([\\d,\\.\\s]+)\\s*₮?`, "gi");
  for (const match of text.matchAll(pattern)) {
    const min = Number.parseInt(match[2], 10);
    const max = Number.parseInt(match[3], 10);
    if (Number.isNaN(min) || Number.isNaN(max) || age < min || age > max) continue;
    const value = Number.parseInt(match[4].replace(/[^\d]/g, ""), 10);
    if (!Number.isNaN(value)) return value;
  }
  return null;
}

export function buildAgeSpecificPriceReply(trip: TravelTrip, text: string): string | null {
  const lines = text.split("\n");
  const currentLine = lines[lines.length - 1] || text;
  if (extractDatesFromText(currentLine).length > 0) return null;
  const ageRangeIntent = extractAgeRangeIntent(currentLine);
  const singleAgeIntent = ageRangeIntent ? null : extractSingleAgeIntent(currentLine);
  if (!ageRangeIntent && !singleAgeIntent) return null;

  const currency = trip.currency || "MNT";
  const extra = (trip.extra || {}) as Record<string, unknown>;
  if (Array.isArray(extra.child_rules)) {
    for (const rule of extra.child_rules as Array<Record<string, unknown>>) {
      const ageRange = typeof rule.age_range === "string" ? rule.age_range : "";
      const range = parseAgeRange(ageRange);
      if (!range) continue;
      if (ageRangeIntent && (range.min !== ageRangeIntent.min || range.max !== ageRangeIntent.max)) continue;
      if (singleAgeIntent) {
        if (singleAgeIntent.age < range.min || singleAgeIntent.age > range.max) continue;
        if (!ruleMatchesTarget(rule, singleAgeIntent.target)) continue;
      }

      const target = ageRangeIntent?.target || singleAgeIntent?.target || "child";
      const label = typeof rule.label === "string" && rule.label.trim() ? rule.label.trim() : (target === "infant" ? "Нярай" : "Хүүхэд");
      const price = formatPassengerMoney(typeof rule.price === "number" ? rule.price : null, currency);
      if (!price) continue;
      return `✈️ ${trip.route_name}\n💰 ${label} ${range.min}-${range.max} насны үнэ: ${price}`;
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
    const priceValue = ageRangeIntent
      ? extractRangePriceFromText(block, ageRangeIntent.target, ageRangeIntent.min, ageRangeIntent.max)
      : singleAgeIntent
        ? findSingleAgePriceInText(block, singleAgeIntent.target, singleAgeIntent.age)
        : null;
    if (priceValue === null) continue;
    const priceText = formatPassengerMoney(priceValue, currency);
    if (!priceText) continue;
    const label = (ageRangeIntent?.target || singleAgeIntent?.target) === "infant" ? "Нярай" : "Хүүхэд";
    const ageText = ageRangeIntent
      ? `${ageRangeIntent.min}-${ageRangeIntent.max} насны`
      : `${singleAgeIntent?.age} настай`;
    return `✈️ ${trip.route_name}\n💰 ${label} ${ageText} үнэ: ${priceText}`;
  }

  return null;
}

export function buildPassengerTypePriceReply(
  trip: TravelTrip,
  text: string,
  now = new Date(),
): string | null {
  // `text` can be a contextual blob with an earlier turn (often the bot's own
  // previous reply) prepended before the customer's actual current message —
  // see contextualText.ts. That old text can mention "хүүхэд"/"том хүн" from a
  // DIFFERENT question (e.g. "хүүхдийн үнэ хэд вэ?" answered last turn), which
  // must not hijack a new question like "тэр шууд нислэгтэй нь хэд байсан бэ?"
  // into a stale child-price answer. Only the customer's current line (the
  // last line) decides which passenger type is being asked about now.
  const lines = text.split("\n");
  const currentLine = lines[lines.length - 1] || text;
  if (extractDatesFromText(currentLine).length > 0) return null;
  const normalized = normText(currentLine);
  const target = normalized.includes("нярай") || normalized.includes("infant")
    ? "infant"
    : normalized.includes("хүүхэд") || normalized.includes("хүүхдийн") || normalized.includes("child")
      ? "child"
      : normalized.includes("том хүн") || normalized.includes("adult")
        ? "adult"
        : null;
  if (!target) return null;

  const label = target === "infant" ? "Нярай" : target === "child" ? "Хүүхэд" : "Том хүн";
  const possessiveLabel = target === "infant" ? "нярайн" : target === "child" ? "хүүхдийн" : "том хүний";
  const currency = trip.currency || "MNT";
  const requestedMonth = extractMonthOnlyFromText(currentLine);
  const allGroups = getStructuredPriceGroups(trip);
  const groups = requestedMonth === null
    ? allGroups
    : filterPriceGroupsByMonth(allGroups, requestedMonth);
  if (groups.length > 0) {
    const heading = requestedMonth === null
      ? `💰 ${label} үнэ:`
      : `💰 ${requestedMonth} сарын ${possessiveLabel} үнэ:`;
    const lines = [`✈️ ${trip.route_name}`, heading];
    let found = false;
    for (const group of groups) {
      const price = target === "infant"
        ? (typeof group.infant_price === "number" ? group.infant_price : null)
        : target === "child"
          ? (typeof group.child_price === "number" ? group.child_price : null)
          : (typeof group.adult_price === "number" ? group.adult_price : null);
      const isFree = target === "infant"
        ? group.infant_price_free === true
        : target === "child"
          ? group.child_price_free === true
          : false;
      const priceText = isFree ? "Үнэгүй" : formatPassengerMoney(price, currency);
      if (!priceText) continue;
      const age = target === "infant"
        ? (typeof group.infant_age === "string" ? group.infant_age.trim() : "")
        : target === "child"
          ? (typeof group.child_age === "string" ? group.child_age.trim() : "")
          : "";
      const rawDates = Array.isArray(group.dates) ? group.dates as string[] : [];
      const futureDates = filterFutureDepartureDates(rawDates, now);
      const relevantDates = requestedMonth === null
        ? futureDates
        : futureDates.filter((date) => normalizeMnDate(date).some((value) => value.month === requestedMonth));
      if (rawDates.length > 0 && relevantDates.length === 0) continue;
      found = true;
      const dateLabel = relevantDates.length > 0 ? formatGroupDateLabel(relevantDates) : "";
      const ageText = age ? ` /${age}/` : "";
      lines.push(`${dateLabel ? `${dateLabel}: ` : ""}${label}${ageText}: ${priceText}`);
    }
    if (found) return lines.join("\n");
  }

  if (requestedMonth !== null && allGroups.length > 0) return null;

  if (target === "infant" || target === "child") {
    if (isDocumentedFreeFare(trip, target)) {
      return `✈️ ${trip.route_name}\n💰 ${label} үнэ: Үнэгүй`;
    }
  }

  const price = target === "infant" ? null : target === "child" ? trip.child_price : trip.adult_price;
  const flatPriceText = formatPassengerMoney(price, currency);
  if (flatPriceText) {
    return `✈️ ${trip.route_name}\n💰 ${label} үнэ: ${flatPriceText}`;
  }

  // The catalog claims a fare for this passenger type but every value is 0 —
  // suppressed above as missing data. Return a definite "we don't know this one"
  // rather than falling through to a generic adult/child block that never
  // mentions the passenger type asked about.
  //
  // NOTE: this wording intentionally matches shouldSilenceNoDataReply(), so the
  // webhook and demo both swallow it and hand off to staff — the owner's rule is
  // that what the bot cannot provide, it does not talk around. The value of
  // returning it here rather than null is that the handoff becomes deterministic
  // and costs no model call. If that policy is ever relaxed, this is the text
  // the customer would see.
  const claimsFare = allGroups.some((group) => {
    const value = target === "infant"
      ? group.infant_price
      : target === "child"
        ? group.child_price
        : group.adult_price;
    return typeof value === "number";
  });
  if (claimsFare) {
    const possessive = possessiveLabel.charAt(0).toUpperCase() + possessiveLabel.slice(1);
    return `✈️ ${trip.route_name}\n💰 ${possessive} үнэ тодорхойгүй байгаа тул аяллын зөвлөх тодруулж хэлэх болно. Холбогдох дугаараа үлдээгээрэй 🙏`;
  }

  return null;
}

export function hasIncludedInPriceIntent(text: string): boolean {
  return /багтсан\s+уу|орсон\s+уу|included|include|үнэд\s+.*багтсан/i.test(text);
}

export function buildIncludedInPriceReply(trip: TravelTrip, text: string): string | null {
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
  const price = formatPassengerMoney(trip.adult_price, currency);

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

export function groupDatesForDisplay(dates: string[]): Array<{ month: number | null; days: number[]; raw: string[] }> {
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

export function joinDayList(days: number[]) {
  if (days.length === 0) return "";
  if (days.length <= 2) return days.join(", ");
  return `${days.slice(0, -1).join(", ")}, ${days[days.length - 1]}`;
}

export function formatGroupDateLabel(dates: string[], suffix = "гаралт") {
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

function getPriceGroupDisplayDates(group: Record<string, unknown> | DepartureDateGroup): string[] {
  const raw = group as Record<string, unknown>;
  const dates = Array.isArray(raw.dates)
    ? raw.dates.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  if (dates.length > 0) {
    return dates.flatMap((dateText) => {
      const parsed = normalizeMnDate(dateText);
      return parsed.length > 0
        ? parsed.map((date) => `${date.month} сарын ${date.day}`)
        : [dateText];
    });
  }

  const label = typeof raw.label === "string" ? raw.label : "";
  return normalizeMnDate(label).map((date) => `${date.month} сарын ${date.day}`);
}

export function formatCompactDepartureList(dates: string[]) {
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

export function findPriceGroupByYmd(
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
export function normalizeMnDate(dateText: string): Array<{ month: number; day: number }> {
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

  const yearMonthDayPattern = /(?:\d{4}\s*он\s*)?(\d{1,2})\s*сар(?:ын)?\s*(\d{1,2})((?:\s*,\s*\d{1,2}(?!\s*сар(?:ын)?))*)/g;
  let yearMonthDayMatch: RegExpExecArray | null;
  while ((yearMonthDayMatch = yearMonthDayPattern.exec(trimmed)) !== null) {
    const month = parseInt(yearMonthDayMatch[1], 10);
    results.push({
      month,
      day: parseInt(yearMonthDayMatch[2], 10),
    });
    const extras = yearMonthDayMatch[3];
    if (extras) {
      const extraDays = extras.split(",").map((s) => s.trim()).filter(Boolean);
      for (const ds of extraDays) {
        const day = parseInt(ds, 10);
        if (!isNaN(day)) results.push({ month, day });
      }
    }
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
export function extractDatesFromText(text: string): Array<{ month: number; day: number }> {
  const results: Array<{ month: number; day: number }> = [];
  const yearMonthDayPattern = /(?:\d{4}\s*он\s*)?(\d{1,2})\s*сар(?:ын)?\s*(\d{1,2})((?:\s*,\s*\d{1,2}(?!\s*сар(?:ын)?))*)/g;
  let yearMonthDayMatch: RegExpExecArray | null;
  while ((yearMonthDayMatch = yearMonthDayPattern.exec(text)) !== null) {
    const month = parseInt(yearMonthDayMatch[1], 10);
    results.push({
      month,
      day: parseInt(yearMonthDayMatch[2], 10),
    });
    const extras = yearMonthDayMatch[3];
    if (extras) {
      const extraDays = extras.split(",").map((s) => s.trim()).filter(Boolean);
      for (const ds of extraDays) {
        const day = parseInt(ds, 10);
        if (!isNaN(day)) results.push({ month, day });
      }
    }
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

export function extractStructuredDates(text: string): MonthDay[] {
  return uniqueMonthDays(parseLooseMonthDays(text));
}

export function extractNormalizedPrice(text: string): number | null {
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

export function hasDatePriceConstraint(text: string) {
  return extractStructuredDates(text).length > 0 && extractNormalizedPrice(text) !== null;
}

export function parseLooseMonthDays(text: string): MonthDay[] {
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

export function getGroupDateTexts(group: Record<string, unknown> | DepartureDateGroup): string[] {
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

export function groupMatchesMonthDay(
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
export function findPriceGroupByMonthDay(
  trip: TravelTrip,
  month: number,
  day: number,
  now = new Date(),
): Record<string, unknown> | DepartureDateGroup | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const requestedThisYear = new Date(now.getFullYear(), month - 1, day);
  if (requestedThisYear < today) return null;

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

export function formatPriceLine(group: {
  label?: string | null;
  adult_price?: number | null;
  child_price?: number | null;
  infant_price?: number | null;
}) {
  const parts: string[] = [];
  const adult = formatPassengerMoney(group.adult_price ?? null, "MNT");
  const child = formatPassengerMoney(group.child_price ?? null, "MNT");
  const infant = formatPassengerMoney(group.infant_price ?? null, "MNT");

  if (adult) parts.push(`Том хүн: ${adult}`);
  if (child) parts.push(`Хүүхэд: ${child}`);
  if (infant) parts.push(`Нярай: ${infant}`);

  return parts.join(" | ");
}

export function formatChildRules(trip: TravelTrip, currency: string): string {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  if (!Array.isArray(extra.child_rules) || (extra.child_rules as unknown[]).length === 0) return "";
  const rules = extra.child_rules as Array<Record<string, unknown>>;
  const lines: string[] = ["👶 Хүүхдийн насны ангилал:"];
  for (const r of rules) {
    const label = typeof r.label === "string" && r.label ? r.label : "";
    const age = typeof r.age_range === "string" && r.age_range ? ` (${r.age_range})` : "";
    // This rule's own note is the direct, per-entry source of "genuinely free"
    // vs "price never got extracted" — no need to re-derive it trip-wide.
    const note = normText(typeof r.note === "string" ? r.note : "");
    const isFree = r.price === 0 && (note.includes("үнэгүй") || note.includes("free"));
    const price = isFree ? "Үнэгүй" : formatPassengerMoney(typeof r.price === "number" ? r.price : null, currency);
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
export function compactDates(dates: string[]): string {
  if (dates.length <= 4) return dates.join(", ");
  return `${dates.slice(0, 3).join(", ")} … (нийт ${dates.length} өдөр)`;
}

export function formatTripBasePrice(trip: TravelTrip) {
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
      const adult = formatPassengerMoney(typeof g.adult_price === "number" ? g.adult_price : null, currency);
      const child = formatPassengerMoney(typeof g.child_price === "number" ? g.child_price : null, currency);
      const infant = formatPassengerMoney(typeof g.infant_price === "number" ? g.infant_price : null, currency);
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
      const rawDates = getPriceGroupDisplayDates(g);
      const futureDates = filterFutureDepartureDates(rawDates);
      if (rawDates.length > 0 && futureDates.length === 0) continue;
      const labelStr = typeof g.label === "string" && g.label ? g.label : "";
      const existing = grouped.find((gr) => gr.priceKey === priceKey);
      if (existing) {
        existing.dates.push(...futureDates);
      } else {
        grouped.push({ priceKey, priceStr: priceParts.join(" | "), dates: [...futureDates], label: labelStr });
      }
    }

    // Every group can be skipped above (all its dates already departed, or it
    // carries no prices). Returning here anyway would send the customer a bare
    // "💰 Үнэ (гарах огноогоор):" header with no number under it, so fall
    // through to the flat trip price instead.
    if (grouped.length > 0) {
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
  }

  // Fall back to legacy departure_date_groups
  const groups = getPriceGroups(trip);
  if (groups.length > 0) {
    // Also group by price to avoid repetition
    type LegacyGroup = { priceKey: string; priceStr: string; dates: string[] };
    const grouped: LegacyGroup[] = [];
    for (const g of groups) {
      const adult = formatPassengerMoney(g.adult_price ?? null, currency);
      const child = formatPassengerMoney(g.child_price ?? null, currency);
      const infant = formatPassengerMoney(g.infant_price ?? null, currency);
      const priceParts: string[] = [];
      if (adult) priceParts.push(`Том хүн: ${adult}`);
      if (child) priceParts.push(`Хүүхэд: ${child}`);
      if (infant) priceParts.push(`Нярай: ${infant}`);
      if (!priceParts.length) continue;
      const priceKey = priceParts.join("|");
      const rawDates = getPriceGroupDisplayDates(g);
      const futureDates = filterFutureDepartureDates(rawDates);
      if (rawDates.length > 0 && futureDates.length === 0) continue;
      const existing = grouped.find((gr) => gr.priceKey === priceKey);
      if (existing) {
        existing.dates.push(...futureDates);
      } else {
        grouped.push({ priceKey, priceStr: priceParts.join(" | "), dates: [...futureDates] });
      }
    }
    // Same fall-through as the structured branch: no renderable group means no
    // header, so the flat trip price below can still answer the question.
    if (grouped.length > 0) {
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
  }

  // Fall back to flat price
  const adult = formatPassengerMoney(trip.adult_price, currency);
  const child = formatPassengerMoney(trip.child_price, currency);
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
/**
 * Mandatory add-on charges (exam fees, single-room supplements, etc.) stored
 * per-trip in extra.extra_fees. These are often in CNY/HKD while the base
 * price is in MNT — a customer asking for the TOTAL cost needs this line or
 * they are quoted a number that is not what they will actually pay.
 */
export function formatExtraFeesLine(trip: TravelTrip): string {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  const fees = Array.isArray(extra.extra_fees)
    ? (extra.extra_fees as Array<Record<string, unknown>>)
    : [];
  if (fees.length === 0) return "";
  const parts = fees
    .map((f) => {
      const label = typeof f.label === "string" && f.label ? f.label : "Нэмэлт төлбөр";
      const amount =
        typeof f.amount === "number"
          ? formatMoney(f.amount, typeof f.currency === "string" ? f.currency : "")
          : "";
      const appliesTo = typeof f.applies_to === "string" && f.applies_to ? ` (${f.applies_to})` : "";
      return amount ? `${label}${appliesTo}: ${amount}` : "";
    })
    .filter(Boolean);
  if (parts.length === 0) return "";
  return `⚠️ Дээрх үнэ дээр нэмэлт төлбөр орно: ${parts.join("; ")}`;
}

export function formatTripBasePricePremium(trip: TravelTrip, now = new Date()) {
  const priceBlock = formatTripBasePricePremiumCore(trip, now);
  const feesLine = formatExtraFeesLine(trip);
  return feesLine ? `${priceBlock}\n${feesLine}` : priceBlock;
}

function formatTripBasePricePremiumCore(trip: TravelTrip, now = new Date()) {
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
        childFree: g.child_price_free === true,
        infantFree: g.infant_price_free === true,
      });
      if (!priceLines.length) continue;
      const priceKey = priceLines.join("|");
      const rawDates = getPriceGroupDisplayDates(g);
      const futureDates = filterFutureDepartureDates(rawDates, now);
      if (rawDates.length > 0 && futureDates.length === 0) continue;
      const label = typeof g.label === "string" ? g.label : "";
      const existing = grouped.find((entry) => entry.priceKey === priceKey);
      if (existing) existing.dates.push(...futureDates);
      else grouped.push({ priceKey, priceLines, dates: [...futureDates], label });
    }
    // Only commit to the price-group rendering if at least one group survived
    // the departed-dates filter; otherwise fall through so the room/flat price
    // tiers below can answer instead of returning a bare "💰 Үнэ:" header.
    if (grouped.length > 0) {
      for (const entry of grouped) {
        const dateLabel = entry.dates.length > 0 ? formatGroupDateLabel(entry.dates) : entry.label;
        const groupLabel = entry.label.trim();
        const labelHasDates = normalizeMnDate(groupLabel).length > 0;
        const heading = groupLabel && !labelHasDates && dateLabel && groupLabel !== dateLabel
          ? `${groupLabel}\n${dateLabel}`
          : (dateLabel || (labelHasDates ? "" : groupLabel));
        if (heading) sections.push("", heading);
        sections.push(...entry.priceLines);
      }
      return sections.join("\n");
    }
  }

  const legacyGroups = getPriceGroups(trip);
  if (legacyGroups.length > 0) {
    // Buffer the group lines so an all-departed set of groups falls through to
    // the room/flat price tiers instead of returning a header on its own.
    const groupSections: string[] = [];
    for (const group of legacyGroups) {
      const rawDates = getPriceGroupDisplayDates(group);
      const futureDates = filterFutureDepartureDates(rawDates, now);
      if (rawDates.length > 0 && futureDates.length === 0) continue;
      const dateLabel = futureDates.length > 0 ? formatGroupDateLabel(futureDates) : (group.label || "");
      const priceLines = formatPassengerPriceLines({
        adult: group.adult_price ?? null,
        child: group.child_price ?? null,
        infant: group.infant_price ?? null,
        currency,
        childFree: isDocumentedFreeFare(trip, "child"),
        infantFree: isDocumentedFreeFare(trip, "infant"),
      });
      if (!priceLines.length) continue;
      if (dateLabel) groupSections.push("", dateLabel);
      groupSections.push(...priceLines);
    }
    if (groupSections.length > 0) {
      return [...sections, ...groupSections].join("\n");
    }
  }

  const extra = (trip.extra || {}) as Record<string, unknown>;
  const roomPrices = Array.isArray(extra.room_prices)
    ? (extra.room_prices as Array<Record<string, unknown>>)
    : [];
  const roomLines = roomPrices
    .map((room) => {
      const roomType = typeof room.room_type === "string" && room.room_type.trim()
        ? room.room_type.trim()
        : "Өрөөний үнэ";
      const amount = typeof room.price === "number"
        ? formatMoney(room.price, typeof room.currency === "string" ? room.currency : currency)
        : "";
      return amount ? `• ${roomType}: ${amount}` : "";
    })
    .filter(Boolean);
  if (roomLines.length > 0) {
    return [...sections, "", "Өрөөний төрлөөр:", ...roomLines.slice(0, 8)].join("\n");
  }

  // A single flat child_price can silently pick ONE of several age-banded child
  // fares this catalog stores in child_rules (observed: a trip with a
  // 1,390,000₮ tier for children born 2014-2015 and a SEPARATE 1,290,000₮ tier
  // for 2016-2023, collapsed by the extraction to one flat trip.child_price) —
  // quoting that single number to every family either over- or under-charges
  // whichever band it doesn't match. When child_rules documents more than one
  // distinct non-infant fare, break them out instead.
  const childTierLines = formatDistinctChildTiers(trip, currency);
  if (childTierLines.length > 0) {
    const lines = [...sections, ""];
    const adultText = formatPassengerMoney(trip.adult_price, currency);
    if (adultText) lines.push(`• Том хүн: ${adultText}`);
    lines.push(...childTierLines);
    if (isDocumentedFreeFare(trip, "infant")) lines.push("• Нярай: Үнэгүй");
    return lines.join("\n");
  }

  const flatLines = formatPassengerPriceLines({
    adult: trip.adult_price,
    child: trip.child_price,
    currency,
    childFree: isDocumentedFreeFare(trip, "child"),
  });
  // "Infants ride free" is a trip-level policy from child_rules, not a fare
  // attached to any one departure — so it must survive the fall-through that
  // happens once every price group's dates have passed. Without this, a live
  // trip awaiting new dates silently stopped mentioning free infants in its
  // main price answer, while the infant-specific question still said Үнэгүй:
  // two different answers to the same question depending on how it was asked.
  // (There is no trip.infant_price column, so this cannot come from the flat
  // fields the way the child fare does.)
  if (isDocumentedFreeFare(trip, "infant")) flatLines.push("• Нярай: Үнэгүй");
  if (!flatLines.length) return "💰 Үнийн мэдээлэл одоогоор тодорхойгүй байна.";
  return [...sections, "", ...flatLines].join("\n");
}

/**
 * Distinct age-banded child fares from child_rules/child_price_rules, infant
 * tiers excluded (those render separately as "Нярай: Үнэгүй"). Returns [] when
 * there is nothing to break out — either no rules, or every rule agrees with
 * the flat trip.child_price, in which case the existing single-line render is
 * already correct and adding a second identical line would be noise.
 */
function formatDistinctChildTiers(trip: TravelTrip, currency: string): string[] {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  const rules = [extra.child_rules, extra.child_price_rules]
    .flatMap((value) => (Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []))
    .filter((rule) => typeof rule.price === "number" && rule.price > 0)
    .filter((rule) => {
      const label = normText(typeof rule.label === "string" ? rule.label : "");
      const ageRange = typeof rule.age_range === "string" ? rule.age_range : "";
      return !isInfantShapedAge(label, ageRange);
    });
  const distinctPrices = new Set(rules.map((rule) => rule.price));
  if (distinctPrices.size < 2) return [];
  return rules
    .map((rule) => {
      const priceText = formatPassengerMoney(rule.price as number, currency);
      if (!priceText) return "";
      const ageRange = typeof rule.age_range === "string" && rule.age_range.trim() ? ` /${rule.age_range.trim()}/` : "";
      return `• Хүүхэд${ageRange}: ${priceText}`;
    })
    .filter((line): line is string => Boolean(line));
}

export function extractMonthOnlyFromText(text: string): number | null {
  const MN_MONTH_WORDS: Record<string, number> = {
    "нэгдүгээр": 1, "хоёрдугаар": 2, "гуравдугаар": 3, "дөрөвдүгээр": 4,
    "тавдугаар": 5, "зургадугаар": 6, "долоодугаар": 7, "наймдугаар": 8,
    "есдүгээр": 9, "аравдугаар": 10, "арваннэгдүгээр": 11, "арвандолоодугаар": 12,
  };
  // "7 сард" / "7-р сард" / "7 сарын үнэ" — but not "7 сарын 9"
  // or an age such as "8 сартай". JavaScript's `\b` only understands ASCII
  // word characters, so it cannot safely delimit Mongolian suffixes here.
  const numMatch = /(\d{1,2})\s*(?:-\s*р|р)?\s*сар(ын|д|тай)?/iu.exec(text);
  if (numMatch) {
    const suffix = numMatch[2] || "";
    const remainder = text.slice((numMatch.index || 0) + numMatch[0].length);
    if (suffix !== "тай" && !/^\s*\d/.test(remainder)) {
      const month = parseInt(numMatch[1], 10);
      if (month >= 1 && month <= 12) return month;
    }
  }
  // Mongolian word forms
  for (const [word, month] of Object.entries(MN_MONTH_WORDS)) {
    if (text.toLowerCase().includes(word)) return month;
  }
  return null;
}

/** Filter price_groups to only those containing dates in the given month. */
export function filterPriceGroupsByMonth(
  groups: Array<Record<string, unknown>>,
  month: number,
): Array<Record<string, unknown>> {
  return groups.filter((g) => {
    const rawDates = Array.isArray(g.dates) ? g.dates as string[] : [];
    return rawDates.some((d) => normalizeMnDate(d).some((nd) => nd.month === month));
  });
}

export function formatSpecificDatePrice(
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
  const adult = formatPassengerMoney(group.adult_price ?? null, currency);
  const child = formatPassengerMoney(group.child_price ?? null, currency);
  const infant = formatPassengerMoney(group.infant_price ?? null, currency);
  const parts: string[] = [];
  if (adult) parts.push(`Том хүн: ${adult}`);
  if (child) parts.push(`Хүүхэд: ${child}`);
  if (infant) parts.push(`Нярай: ${infant}`);
  const suffix = parts.length ? parts.join(" | ") : "Аяллын зөвлөхтэй холбогдоорой.";
  return `💰 ${label}: ${suffix}`;
}

export const AMBIGUOUS_REPLY_MARKER = "Аль аяллыг нь сонирхож байна вэ?";

function firstStructuredPassengerPrice(trip: TravelTrip, key: "child_price" | "infant_price"): number | null {
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

export function buildAmbiguousTripReply(trips: TravelTrip[]) {
  const names = trips.slice(0, 5).map((trip) => {
    const currency = trip.currency || "MNT";
    const adult = typeof trip.adult_price === "number" ? trip.adult_price : null;
    const child = firstStructuredPassengerPrice(trip, "child_price");
    const infant = firstStructuredPassengerPrice(trip, "infant_price");
    const adultText = formatPassengerMoney(adult, currency);
    const childText = formatPassengerMoney(child, currency);
    const infantText = formatPassengerMoney(infant, currency);
    const details = [
      trip.duration_text,
      adultText ? `том хүн ${adultText}` : "",
      childText ? `хүүхэд ${childText}` : "",
      infantText ? `нярай ${infantText}` : "",
    ].filter(Boolean);
    return `• ${trip.route_name}${details.length ? ` — ${details.join(" · ")}` : ""}`;
  });
  return [
    "Энэ чиглэлээр хэд хэдэн сонголт байна 😊",
    ...names,
    "",
    AMBIGUOUS_REPLY_MARKER,
  ].join("\n");
}

/** The single lead-capture ask reused by every fast-path answer. */
export const LEAD_CAPTURE_CTA =
  "Утасны дугаараа үлдээвэл манай аяллын зөвлөх тан руу шууд холбогдоно 🙌";

/**
 * Appends the phone-number ask to a fast-path reply so the deterministic
 * answers capture leads the same way the AI path does. The fast paths used to
 * answer price/seats/dates and stop — exactly the hot-buyer questions — so the
 * best leads were never asked for a number.
 *
 * Skips when: the phone is already collected; the reply is a clarifying
 * (ambiguous) question, where a phone ask is explicitly disallowed; or the
 * reply already requests contact details (no double ask).
 */
export function appendLeadCaptureCta(reply: string, phoneCollected: boolean): string {
  const text = (reply || "").trim();
  if (!text || phoneCollected) return reply;
  if (text.includes(AMBIGUOUS_REPLY_MARKER)) return reply;
  if (/утас|дугаар/i.test(text)) return reply;
  return `${text}\n\n${LEAD_CAPTURE_CTA}`;
}

export function buildSameTripPriceComparisonReply(
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
      const adultStr = formatPassengerMoney(p.adult, currency);
      const childStr = formatPassengerMoney(p.child, currency);
      const infantStr = formatPassengerMoney(p.infant, currency);
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
