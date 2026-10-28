// Turns a GTC tour (see globalTravel.ts) into Uudam's poster data, so the copied prices, dates, hotels
// and programme flow through the normal poster -> chatbot -> website pipeline with no special cases.
//
// The poster is MERGED, not replaced: Uudam's own photos, layout, contacts and wording stay, and
// everything GTC publishes (prices, dates, hotels, programme text, included/excluded) is copied over.
import type { PartnerDay, PartnerRow, PartnerTour } from "./globalTravel";
import { isDeepStrictEqual } from "node:util";

const fmt = (amount: number) => `${amount.toLocaleString("en-US")}₮`;
const cell = (amount: number | null) => (amount == null ? "-" : fmt(amount));

/**
 * The poster price table, in the exact shape src/lib/poster/tripMapper.ts reads. It finds the adult
 * column by its header ("Том хүн"), the hotel by "Буудал", children by "Хүүхэд ..." and infants by
 * "Нярай ...", so the headers below are load-bearing: a differently named column is silently read as
 * no price at all (a first version of this stored a null price that way).
 */
export const PRICE_TABLE_COLUMNS = [
  "Буудал",
  "Том хүн",
  "Хүүхэд 6-11 нас оргүй",
  "Хүүхэд 2-5 нас оргүй",
  "Нярай 0-2 нас",
  "Ганцаараа байрлах нэмэлт",
] as const;

export const PACKAGE_FREE = "Хөтөлбөргүй";
export const PACKAGE_PROGRAM = "Хөтөлбөртэй";

/**
 * The hotel label the rest of the system keys fares on. GTC sells each hotel at two prices (with and
 * without the daily programme), and the validator rejects two different adult fares for one hotel,
 * date and passenger category, so the package is part of the label.
 */
export const accommodationLabel = (hotel: string, packageLabel: string) => `${hotel} · ${packageLabel}`;

type PackagePrices = { package: string; adult: number | null; child2to5: number | null; child6to11: number | null };

/** The two package variants GTC publishes for a row; a variant with no adult fare is not offered. */
export function packageVariants(row: PartnerRow): PackagePrices[] {
  const { prices } = row;
  const variants: PackagePrices[] = [
    { package: PACKAGE_FREE, adult: prices.adult, child2to5: prices.child2to5, child6to11: prices.child6to11 },
    { package: PACKAGE_PROGRAM, adult: prices.programAdult, child2to5: prices.programChild2to5, child6to11: prices.programChild6to11 },
  ];
  return variants.filter((variant) => variant.adult != null);
}

export function buildPriceTable(tour: PartnerTour) {
  return {
    note: "",
    columns: [...PRICE_TABLE_COLUMNS],
    rows: tour.rows.flatMap((row) =>
      packageVariants(row).map((variant) => ({
        dates: row.date,
        cells: [
          accommodationLabel(row.hotel, variant.package),
          cell(variant.adult),
          cell(variant.child6to11),
          cell(variant.child2to5),
          cell(row.prices.infant),
          cell(row.prices.single),
        ],
      })),
    ),
  };
}

/** The cheapest adult fare GTC currently shows for a bookable date; the trip's headline price. */
export function lowestAdultPrice(tour: PartnerTour): number | null {
  const open = tour.rows.filter((row) => row.open);
  const rows = open.length ? open : tour.rows;
  const prices = rows.flatMap((row) => packageVariants(row).map((variant) => variant.adult)).filter((price): price is number => price != null);
  return prices.length ? Math.min(...prices) : null;
}

type Existing = Record<string, unknown>;
const asRecord = (value: unknown): Existing => (value && typeof value === "object" && !Array.isArray(value) ? (value as Existing) : {});

/** Keep presentation assets; replace the source-owned itinerary facts. */
function mergeDays(existing: unknown, days: PartnerDay[]): Existing[] {
  const current = Array.isArray(existing) ? existing.map(asRecord) : [];
  return days.map((day, index) => {
    const own = current.find((item) => Number(item.day) === day.day) ?? current[index] ?? {};
    return {
      ...own,
      day: day.day,
      route: day.title,
      summary: day.lines.join("\n"),
      distance: day.distance ?? "",
      flight: day.transportation ?? "",
      meals: day.meals,
      show_meals: true,
      // GTC names a hotel only on the arrival day. Another day keeps no old hotel text of Uudam's, or
      // a hotel GTC does not offer would still be quoted (the old poster named Gentle Grown here).
      hotel: day.accommodation ?? "",
    };
  });
}

/** Flight times come from the day-1 / last-day text GTC writes ("23:50 цагт … нислэг"). */
function flightLines(days: PartnerDay[]): Existing {
  const outbound = days[0]?.lines.find((line) => /нислэг/i.test(line));
  const back = days[days.length - 1]?.lines.find((line) => /Улаанбаатар\s+чиглэлд|нисээд/i.test(line));
  return { outbound: outbound ?? "", return: back ?? "" };
}

export function buildPosterData(tour: PartnerTour, existing: unknown = {}): Existing {
  const own = asRecord(existing);
  const adult = lowestAdultPrice(tour);
  return {
    ...own,
    source_url: tour.sourceUrl,
    subtitle: tour.description,
    destinations: tour.destinations,
    duration_days: tour.durationDays ?? own.duration_days,
    duration_nights: tour.durationNights ?? own.duration_nights,
    price_desc: tour.description,
    price_note: adult != null ? `Том хүн: ${fmt(adult)}-с` : own.price_note,
    price_table: buildPriceTable(tour),
    departures: tour.dates.map((date) => ({ date })),
    days: mergeDays(own.days, tour.days),
    flights: flightLines(tour.days),
    includes: tour.includes,
    excludes: tour.excludes,
  };
}

type Field = { label: string; read: (row: PartnerRow, pkg: PackagePrices) => number | null };
const FIELDS: Field[] = [
  { label: "Том хүн", read: (_row, pkg) => pkg.adult },
  { label: "Хүүхэд 6-11", read: (_row, pkg) => pkg.child6to11 },
  { label: "Хүүхэд 2-5", read: (_row, pkg) => pkg.child2to5 },
  { label: "Нярай", read: (row) => row.prices.infant },
  { label: "Ганцаараа", read: (row) => row.prices.single },
];

function flatten(tour: PartnerTour) {
  const cells = new Map<string, { row: PartnerRow; pkg: PackagePrices }>();
  for (const row of tour.rows) for (const pkg of packageVariants(row)) cells.set(`${row.date}|${accommodationLabel(row.hotel, pkg.package)}`, { row, pkg });
  return cells;
}

/** What changed between two copies of the GTC tour, one line each, for the Telegram message. */
export function describeChanges(before: PartnerTour | null, after: PartnerTour): string[] {
  if (!before) return [`Анхны хуулалт: ${after.rows.length} огноо·буудал, ${after.dates.length} огноо.`];
  const lines: string[] = [];
  const was = flatten(before);
  const now = flatten(after);

  for (const [key, current] of now) {
    const previous = was.get(key);
    const [date, hotel] = key.split("|");
    if (!previous) { lines.push(`➕ ${date} ${hotel}: ${cell(current.pkg.adult)}`); continue; }
    for (const field of FIELDS) {
      const a = field.read(previous.row, previous.pkg);
      const b = field.read(current.row, current.pkg);
      if (a !== b) lines.push(`${b != null && a != null && b < a ? "📉" : "📈"} ${date} ${hotel} ${field.label}: ${cell(a)} → ${cell(b)}`);
    }
    if (previous.row.open !== current.row.open) lines.push(`${current.row.open ? "✅" : "❌"} ${date} ${hotel}: ${current.row.open ? "дахин нээгдлээ" : "суудал дүүрсэн"}`);
  }
  for (const key of was.keys()) if (!now.has(key)) lines.push(`➖ ${key.replace("|", " ")} жагсаалтаас хасагдлаа`);

  if (before.days.length !== after.days.length) lines.push(`📝 Хөтөлбөр: ${before.days.length} → ${after.days.length} өдөр`);
  if (!isDeepStrictEqual(before.days, after.days) && before.days.length === after.days.length) lines.push("📝 Хөтөлбөрийн текст өөрчлөгдсөн");
  if (!isDeepStrictEqual(before.includes, after.includes)) lines.push(`📝 Үнэд багтсан: ${before.includes.length} → ${after.includes.length} зүйл`);
  if (!isDeepStrictEqual(before.excludes, after.excludes)) lines.push(`📝 Үнэд багтаагүй: ${before.excludes.length} → ${after.excludes.length} зүйл`);
  return lines;
}
