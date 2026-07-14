/**
 * Date/price parsing utilities and price-formatting reply builders for the
 * fast-path layer: intent detectors (price/duration/schedule/flight/etc.),
 * Mongolian date-text parsing, price-group lookups, and the price-focused
 * reply fragments reused by the top-level structured-reply builder.
 */

import { parseDepartureDateText } from "./travelDates";
import type { TravelTrip } from "./travelOps";
import {
  formatMoney,
  getPriceGroups,
  getStructuredPriceGroups,
  normText,
  unique,
  uniqueMonthDays,
  type DepartureDateGroup,
  type MonthDay,
} from "./travelFastPathsSearch";

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
      const price = formatMoney(typeof rule.price === "number" ? rule.price : null, currency);
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
    const label = (ageRangeIntent?.target || singleAgeIntent?.target) === "infant" ? "Нярай" : "Хүүхэд";
    const ageText = ageRangeIntent
      ? `${ageRangeIntent.min}-${ageRangeIntent.max} насны`
      : `${singleAgeIntent?.age} настай`;
    return `✈️ ${trip.route_name}\n💰 ${label} ${ageText} үнэ: ${formatMoney(priceValue, currency)}`;
  }

  return null;
}

export function buildPassengerTypePriceReply(trip: TravelTrip, text: string): string | null {
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
  const currency = trip.currency || "MNT";
  const groups = getStructuredPriceGroups(trip);
  if (groups.length > 0) {
    const lines = [`✈️ ${trip.route_name}`, `💰 ${label} үнэ:`];
    let found = false;
    for (const group of groups) {
      const price = target === "infant"
        ? (typeof group.infant_price === "number" ? group.infant_price : null)
        : target === "child"
          ? (typeof group.child_price === "number" ? group.child_price : null)
          : (typeof group.adult_price === "number" ? group.adult_price : null);
      if (price === null) continue;
      found = true;
      const age = target === "infant"
        ? (typeof group.infant_age === "string" ? group.infant_age.trim() : "")
        : target === "child"
          ? (typeof group.child_age === "string" ? group.child_age.trim() : "")
          : "";
      const rawDates = Array.isArray(group.dates) ? group.dates as string[] : [];
      const dateLabel = rawDates.length > 0 ? formatGroupDateLabel(rawDates) : "";
      const ageText = age ? ` /${age}/` : "";
      lines.push(`${dateLabel ? `${dateLabel}: ` : ""}${label}${ageText}: ${formatMoney(price, currency)}`);
    }
    if (found) return lines.join("\n");
  }

  const price = target === "infant" ? null : target === "child" ? trip.child_price : trip.adult_price;
  if (typeof price === "number") {
    return `✈️ ${trip.route_name}\n💰 ${label} үнэ: ${formatMoney(price, currency)}`;
  }

  return `✈️ ${trip.route_name}\n${label} үнийн мэдээлэл одоогоор тодорхойгүй байна. Аяллын зөвлөхөөр баталгаажуулна уу.`;
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
export function extractDatesFromText(text: string): Array<{ month: number; day: number }> {
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
  const adult = formatMoney(group.adult_price ?? null, "MNT");
  const child = formatMoney(group.child_price ?? null, "MNT");
  const infant = formatMoney(group.infant_price ?? null, "MNT");

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
          ? `${f.amount.toLocaleString("mn-MN")}${typeof f.currency === "string" ? f.currency : ""}`
          : "";
      const appliesTo = typeof f.applies_to === "string" && f.applies_to ? ` (${f.applies_to})` : "";
      return amount ? `${label}${appliesTo}: ${amount}` : "";
    })
    .filter(Boolean);
  if (parts.length === 0) return "";
  return `⚠️ Дээрх үнэ дээр нэмэлт төлбөр орно: ${parts.join("; ")}`;
}

export function formatTripBasePricePremium(trip: TravelTrip) {
  const priceBlock = formatTripBasePricePremiumCore(trip);
  const feesLine = formatExtraFeesLine(trip);
  return feesLine ? `${priceBlock}\n${feesLine}` : priceBlock;
}

function formatTripBasePricePremiumCore(trip: TravelTrip) {
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

export function extractMonthOnlyFromText(text: string): number | null {
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

export const AMBIGUOUS_REPLY_MARKER = "Аль аяллыг хэлж байгаагаа нэрээр нь нэг тодруулаад бичээрэй";

export function buildAmbiguousTripReply(trips: TravelTrip[]) {
  const names = trips.slice(0, 3).map((trip) => `• ${trip.route_name}`);
  return [
    "Таны асууж байгаа аялал 2-3 өөр хувилбартай байна.",
    AMBIGUOUS_REPLY_MARKER + ":",
    ...names,
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
