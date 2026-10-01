/**
 * "2 том хүн 1 хүүхэд 8 настай, нийт хэд болох вэ?" — the total price for a
 * party on one named trip. Split out of travelFastPaths.ts (size cap).
 */
import { filterFutureDepartureDates } from "./travelDates";
import {
  childFareTiers,
  extractDatesFromText,
  findPriceGroupByMonthDay,
  formatGroupDateLabel,
  isPassengerCountOnly,
  tripResolvedDates,
} from "./travelFastPathsPricing";
import { formatMoney, getStructuredPriceGroups, isDocumentedFreeFare, normText } from "./travelFastPathsSearch";
import type { TravelTrip } from "./travelOps";

export function extractPassengerCounts(text: string): { adult: number; child: number; infant: number } | null {
  const normalized = normText(text);
  const hasTotalIntent =
    normalized.includes("нийт") ||
    normalized.includes("хэд болох") ||
    normalized.includes("нийлээд") ||
    normalized.includes("total") ||
    isPassengerCountOnly(text);
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

/** Children's stated ages ("8 настай", "5, 8 настай"), in years. */
function statedChildAges(text: string): number[] {
  const match = /((?:\d{1,2}\s*,?\s*(?:ба|болон|and)?\s*)+)\s*(?:настай|насны|нас)(?![\p{L}])/iu.exec(text);
  if (!match) return [];
  return [...match[1].matchAll(/\d{1,2}/g)].map((m) => Number(m[0])).filter((age) => age >= 0 && age <= 17);
}

/** The narrowest "a-b нас" tier that covers this age, or null. */
function tierForAge(tiers: Array<{ price: number; band: string }>, age: number) {
  const covering = tiers
    .map((tier) => ({ tier, range: /(\d{1,2})\s*[-–]\s*(\d{1,2})\s*нас/.exec(tier.band) }))
    .filter(({ range }) => range && Number(range[1]) <= age && age <= Number(range[2]))
    .sort((a, b) => (Number(a.range![2]) - Number(a.range![1])) - (Number(b.range![2]) - Number(b.range![1])));
  return covering[0]?.tier ?? null;
}

type Counts = { adult: number; child: number; infant: number };

function totalForGroup(trip: TravelTrip, selected: Record<string, unknown> | null, counts: Counts, ages: number[]) {
  const currency = trip.currency || "MNT";
  const adultPrice = typeof selected?.adult_price === "number" ? selected.adult_price : trip.adult_price;
  const childPrice = typeof selected?.child_price === "number" ? selected.child_price : trip.child_price;
  const infantPrice = typeof selected?.infant_price === "number" ? selected.infant_price : trip.infant_price;
  const rows: string[] = [];
  let total = 0;
  let spread = 0;
  const add = (label: string, count: number, price: number | null | undefined, free: boolean) => {
    if (count <= 0) return;
    if (free) {
      rows.push(`• ${label} ${count} x Үнэгүй`);
      return;
    }
    // 0₮ means the poster never carried this fare — report it as unknown rather
    // than billing the passenger nothing.
    if (typeof price !== "number" || price <= 0) {
      rows.push(`• ${label} ${count}: үнэ тодорхойгүй`);
      return;
    }
    total += count * price;
    rows.push(`• ${label} ${count} x ${formatMoney(price, currency)} = ${formatMoney(count * price, currency)}`);
  };

  add("Том хүн", counts.adult, adultPrice, false);
  const tiers = counts.child > 0 && !isDocumentedFreeFare(trip, "child") ? childFareTiers(trip, selected) : [];
  // Ages given for every child: price each child by the tier that covers its age.
  const agedTiers = tiers.length >= 2 && ages.length === counts.child ? ages.map((age) => tierForAge(tiers, age)) : [];
  if (agedTiers.length > 0 && agedTiers.every(Boolean)) {
    agedTiers.forEach((tier, index) => {
      total += tier!.price;
      rows.push(`• Хүүхэд ${ages[index]} настай${tier!.band ? ` /${tier!.band}/` : ""} = ${formatMoney(tier!.price, currency)}`);
    });
  } else if (tiers.length >= 2) {
    // Several child fares by age/birth year and no age given: the total
    // depends on which band each child is in, so give the range.
    const prices = tiers.map((tier) => tier.price);
    const low = Math.min(...prices);
    spread = counts.child * (Math.max(...prices) - low);
    total += counts.child * low;
    for (const tier of tiers) {
      rows.push(`• Хүүхэд${tier.band ? ` /${tier.band}/` : ""} ${counts.child} x ${formatMoney(tier.price, currency)} = ${formatMoney(counts.child * tier.price, currency)}`);
    }
  } else {
    add("Хүүхэд", counts.child, childPrice, isDocumentedFreeFare(trip, "child"));
  }
  add("Нярай", counts.infant, infantPrice, isDocumentedFreeFare(trip, "infant"));
  const money = (value: number) => formatMoney(value, currency) || `${value}₮`;
  const totalText: string = spread > 0
    ? `${money(total)} – ${money(total + spread)} (хүүхдийн насаас хамаарна)`
    : money(total);
  return { total, totalText, rows };
}

export function buildPassengerTotalReply(trip: TravelTrip, text: string, now = new Date()): string | null {
  const currentLine = text.split("\n").pop() || text;
  const counts = extractPassengerCounts(currentLine);
  if (!counts) return null;
  const ages = statedChildAges(currentLine);

  const monthDay = extractDatesFromText(currentLine)[0];
  const dayGroup = monthDay ? findPriceGroupByMonthDay(trip, monthDay.month, monthDay.day, now) : null;
  const groups = getStructuredPriceGroups(trip);

  // No date named and the price differs by departure: one total per set of
  // departures. The first group's total used to be given as THE total, which
  // for most departures of a trip priced by date was too low.
  if (!monthDay && groups.length > 1) {
    const resolved = tripResolvedDates(trip);
    const byTotal = new Map<string, { dates: string[]; totalText: string }>();
    let rows: string[] = [];
    let rowsDates: string[] = [];
    for (const group of groups) {
      const dates = Array.isArray(group.display_dates) && group.display_dates.length
        ? (group.display_dates as string[])
        : Array.isArray(group.dates) ? (group.dates as string[]) : [];
      const future = filterFutureDepartureDates(dates, now, resolved);
      if (dates.length > 0 && future.length === 0) continue;
      const result = totalForGroup(trip, group, counts, ages);
      if (result.total <= 0) continue;
      if (rows.length === 0) {
        rows = result.rows;
        rowsDates = future;
      }
      const entry = byTotal.get(result.totalText) ?? { dates: [], totalText: result.totalText };
      entry.dates.push(...future);
      byTotal.set(result.totalText, entry);
    }
    if (byTotal.size > 1) {
      const lines = [...byTotal.values()].map((entry) =>
        `• ${entry.dates.length ? formatGroupDateLabel(entry.dates) : "Бусад"}: ${entry.totalText}`);
      return [`✈️ ${trip.route_name}`, "💰 Нийт үнэ гарах өдрөөс хамаарна:", ...lines, "", `Задаргаа (${rowsDates.length ? formatGroupDateLabel(rowsDates) : "эхний гаралт"}):`, ...rows].join("\n");
    }
  }

  const selected = (dayGroup || groups[0] || null) as Record<string, unknown> | null;
  const result = totalForGroup(trip, selected, counts, ages);
  if (result.total <= 0) return null;
  const label = monthDay ? `${monthDay.month} сарын ${monthDay.day}-ны ` : "";
  return [`✈️ ${trip.route_name}`, `💰 ${label}нийт: ${result.totalText}`, ...result.rows].join("\n");
}
