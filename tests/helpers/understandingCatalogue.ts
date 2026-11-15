import type { FixtureTrip } from "./conversationGateHarness";

/**
 * The INVENTED catalogue of the understanding scenario suite, built to hold every situation the
 * owner's 17 conversations needed, with a mocked clock in November 2026. No name, fare or date
 * here is real (AGENTS.md). The shapes it carries:
 *  - ТАРВИЯ: a "Thailand-like" trio of packages, all with February 2027 departures, one of them
 *    inside the Tsagaan Sar window, and January departures for a competition-quote case
 *  - ПЕКАРА: a "Beijing-like" family with NO February departure, one of them a theme-park trip
 *  - САНВИЯ / ЖОРВИН / ХОРТАН: New-Year-overlapping trips, one New-Year-named, one at the quoted
 *    price, one check-up trip whose CHILD fare equals that price (noise for a price match)
 *  - ВЕРДАН / ЗОРЕНТ: a "Shanghai-like" city family, a fully booked landmark trip with an open
 *    land+flight sibling, an archived trip for a customer's own closed departure
 *  - ЗОРГАН: a 4-stop package of a "Zhuhai-like" city that no trip reaches directly
 *  - ЭРДЭН: land trips sharing a border-town word with a sibling "flies from there" trip
 *  - НЕЛМАР: an archived border-town trip
 *  - ДАЛАЙ / НОРВЕЛ: sea trips and an ordinary city trip with programme, hotel and fares
 *  - ДОРМАН: three sibling island trips sharing a short alias that sits inside an ordinary word
 */
export const day = (n: number, title: string, description: string) => ({ day: n, title, description, meals: { breakfast: false, lunch: false, dinner: false } });

const AGE_RULES = { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" };

export const trip = (id: string, name: string, dates: string[], fares: [number, number | null, number | null], fields: Record<string, unknown> = {}) => ({
  id, route_name: name, operator_name: "Fixture agency", category: "Аялал", adult_price: fares[0], child_price: fares[1], infant_price: fares[2],
  currency: "MNT", status: "active", duration_text: "8 өдөр 7 шөнө", departure_dates: dates, seats_total: 20, seats_left: 10,
  has_food: null, hotel: "", photo_urls: [], notes: "", source_description: name,
  ...fields,
  extra: { customer_visible: true, age_rules: AGE_RULES, ...(fields.extra as Record<string, unknown> | undefined) },
} as unknown as FixtureTrip);

const programme = (count: number, first: string, last: string) => Array.from({ length: count }, (_, index) => day(index + 1,
  index === 0 ? first : index === count - 1 ? last : `Өдөр ${index + 1}`,
  index === 0 ? "Хөтөлбөрийн эхний өдөр." : index === count - 1 ? "Хөтөлбөрийн сүүлийн өдөр." : `Өдөр ${index + 1}-ийн хөтөлбөр.`));

const flightDays = [
  day(1, "Улаанбаатар – Вердан", "УБ хотоос 13:00 цагт нисээд 16:45 цагт Вердан хотод буна."),
  day(2, "Вердан хотоор аялах", "Хотын төвөөр аялна."),
  day(3, "Чөлөөт өдөр", "Чөлөөт цагаа өнгөрөөнө."),
  day(4, "Вердан – Улаанбаатар", "07:50 цагт нисэж 12:00 цагт Улаанбаатарт ирнэ."),
];

const tripProgramme = programme(8, "Улаанбаатар – хот", "Буцах өдөр");

export const CATALOGUE: FixtureTrip[] = [
  // ---- ТАРВИЯ: three packages, all in the February 2027 window, and January departures
  trip("tarvia-a", "ТАРВИЯ АЯЛАЛ — ЛУМАР, ВЕЛНА", ["2026-11-14", "2026-11-21", "2026-12-05", "2027-01-14", "2027-01-30", "2027-02-06", "2027-02-13"], [5_090_000, 4_790_000, 790_000],
    { extra: { transport_type: "direct_flight", destinations: ["Тарвия", "Лумар", "Велна"], itinerary_days: tripProgramme, aliases: ["Tarvia"] } }),
  trip("tarvia-b", "ТАРВИЯ — ОРМЕЛ АЯЛАЛ", ["2026-12-06", "2026-12-13", "2027-01-16", "2027-02-11", "2027-02-14", "2027-02-21"], [5_990_000, 4_790_000, 790_000],
    { extra: { transport_type: "direct_flight", destinations: ["Тарвия", "Ормел"], itinerary_days: tripProgramme, aliases: ["Tarvia"] } }),
  trip("tarvia-c", "ТАРВИЯ – Улаанбаатар - ПАТТАВИЯ нислэг", ["2026-12-20", "2027-01-18", "2027-02-01", "2027-02-08"], [5_790_000, 5_090_000, 690_000],
    { hotel: "Роувен Гранд Хотел эсвэл Ликсон Бэй Хотел", extra: { transport_type: "direct_flight", destinations: ["Тарвия", "Паттавия"], itinerary_days: tripProgramme, aliases: ["Tarvia"] } }),
  // ---- ПЕКАРА: no February departure; one trip is a theme-park trip
  trip("pekara-park", "ПЕКАРА - ЛУНАРИА ПАРК ШУУД НИСЛЭГТЭЙ АЯЛАЛ", ["2026-12-30"], [3_090_000, 2_790_000, 390_000],
    { duration_text: "5 өдөр 4 шөнө", extra: { transport_type: "direct_flight", destinations: ["Пекара", "Лунариа"], aliases: ["Лунариа", "Lunaria"], itinerary_days: programme(5, "Улаанбаатар – Пекара", "Буцах өдөр") } }),
  trip("pekara-4", "ПЕКАРА - ЖИРОН 4 ХОТЫН АЯЛАЛ", ["2026-11-08", "2026-11-15", "2026-11-22", "2027-01-10"], [1_690_000, 1_290_000, null],
    { category: "Газрын аялал", extra: { transport_type: "land", destinations: ["Пекара", "Жирон"], aliases: ["Pekara"], itinerary_days: programme(8, "УБ – хил", "Улаанбаатар") } }),
  trip("pekara-city", "ПЕКАРА ХОТЫН ХЭРЭМ АЯЛАЛ", ["2026-11-20", "2026-11-27", "2026-12-04"], [4_190_000, 3_790_000, 590_000],
    { duration_text: "6 өдөр 5 шөнө", extra: { transport_type: "direct_flight", destinations: ["Пекара"], aliases: ["Pekara"], itinerary_days: programme(6, "Улаанбаатар – Пекара", "Хэрэм үзэх, буцах") } }),
  // ---- New Year: named, overlapping, quoted price, check-up with a child fare at that price
  trip("sanvia-ny", "САНВИЯ - ХОРТ НИСЛЭГТЭЙ ШИНЭ ЖИЛИЙН АЯЛАЛ", ["2026-12-27", "2026-12-28", "2026-12-29", "2026-12-30"], [4_290_000, 3_990_000, 690_000],
    { extra: { transport_type: "direct_flight", destinations: ["Санвия"], itinerary_days: tripProgramme } }),
  trip("sanvia-tue", "САНВИЯ - ХОРТ НИСЛЭГТЭЙ - Мягмар гариг", ["2026-12-01", "2026-12-08", "2026-12-29"], [2_890_000, 2_690_000, null],
    { extra: { transport_type: "direct_flight", destinations: ["Санвия"], itinerary_days: tripProgramme } }),
  trip("hortan-check", "ХОРТАН ХОТЫН БҮТЭН БИЕИЙН ШИНЖИЛГЭЭТЭЙ АЯЛАЛ", ["2026-12-01", "2026-12-06"], [1_290_000, 860_000, null],
    { duration_text: "7 өдөр 6 шөнө", extra: { transport_type: "direct_flight", destinations: ["Хортан"] } }),
  trip("jorvin", "ЖОРВИН-МИНИ ВАЛДА-ХОРТАН ХОТЫН АЯЛАЛ", ["2026-11-12", "2026-12-03", "2026-12-10", "2026-12-17", "2026-12-24", "2026-12-31", "2027-01-07"], [860_000, 760_000, null],
    { duration_text: "7 өдөр 6 шөнө", category: "Газрын аялал", extra: { transport_type: "land", destinations: ["Жорвин", "Валда", "Хортан"], itinerary_days: programme(7, "УБ – хил", "Улаанбаатар") } }),
  // ---- ВЕРДАН: city programmes, the ad trip, a fully booked landmark trip with an open sibling
  trip("verdan-nov", "УБ-Вердан хотын 11-р сарын аяллын хөтөлбөр", ["2026-11-12", "2026-11-26"], [2_990_000, 2_390_000, null],
    { duration_text: "6 өдөр 5 шөнө", extra: { transport_type: "direct_flight", destinations: ["Вердан"], aliases: ["Verdan"], itinerary_days: flightDays } }),
  trip("verdan-dec", "УБ-Вердан хотын 12-р сарын аяллын хөтөлбөр", ["2026-12-22"], [2_990_000, 2_590_000, null],
    { duration_text: "5 өдөр 4 шөнө", extra: { transport_type: "direct_flight", destinations: ["Вердан"], aliases: ["Verdan"], itinerary_days: flightDays } }),
  trip("verdan-q1", "УБ-Вердан хотын 1,2,3-р сарын аяллын хөтөлбөр", ["2027-01-21", "2027-02-18", "2027-03-06"], [3_390_000, 3_090_000, null],
    { duration_text: "6 өдөр 5 шөнө", extra: { transport_type: "direct_flight", destinations: ["Вердан"], aliases: ["Verdan"], itinerary_days: flightDays } }),
  trip("zorent-sold", "ВЕРДАН + ЗОРЕНТЫН ХААЛГА ШУУД НИСЛЭГТЭЙ АЯЛАЛ ( Мирова - Аватар )", ["2026-11-19"], [3_760_000, 3_430_000, null],
    { extra: { transport_type: "direct_flight", destinations: ["Вердан", "Мирова"], aliases: ["Зорентын хаалга", "Mirova"], itinerary_days: tripProgramme,
      website_departure_availability: [{ date: "2026-11-19", status: "SOLD_OUT", seatsLeft: 0 }] } }),
  trip("zorent-combo", "ЗОРЕНТЫН ХААЛГЫН ГАЗАР НИСЛЭГ ХОСОЛСОН АЯЛАЛ ( Мирова - Аватар )", ["2026-11-10", "2026-12-01", "2026-12-15"], [2_750_000, 2_450_000, null],
    { duration_text: "10 өдөр 9 шөнө", category: "Газар + нислэг хосолсон", extra: { transport_type: "land_flight", destinations: ["Дорвал", "Мирова"], aliases: ["Зорентын хаалга", "Mirova"], itinerary_days: tripProgramme } }),
  trip("karmina-ad", "ТОРНЕЛ + КАРМИНА ШУУД НИСЛЭГТЭЙ АЯЛАЛ", ["2026-11-19"], [3_760_000, 3_430_000, null],
    { extra: { transport_type: "direct_flight", destinations: ["Торнел", "Кармина"], aliases: ["Кармина"], itinerary_days: tripProgramme } }),
  // ---- ЗОРГАН: a 4-stop package; nothing goes to Зорган directly
  trip("zorgan-pkg", "ШЭНЗАР – ХОНГСАН – ЗОРГАН – МАКОР 8 ШӨНӨ 9 ӨДӨР", ["2026-11-11", "2026-11-18", "2026-11-25", "2026-12-02"], [4_090_000, 3_790_000, 590_000],
    { duration_text: "9 өдөр 8 шөнө", extra: { transport_type: "direct_flight", destinations: ["Шэнзар", "Хонгсан", "Зорган", "Макор"], aliases: ["Zorgan"], itinerary_days: tripProgramme } }),
  // ---- ЭРДЭН: land trips, a sibling that flies from the border town
  trip("erdan-land", "ЭРДЭН – ЛУМОР – САРИВАН – ТОРНЕЛ", ["2026-11-11", "2026-11-25"], [1_207_000, 995_000, null],
    { category: "Газрын аялал", extra: { transport_type: "land", destinations: ["Эрдэн", "Лумор", "Саривана", "Торнел"], itinerary_days: programme(8, "УЛААНБААТАР – ГАЗАР ХИЛ", "Улаанбаатар") } }),
  trip("erdan-med", "ЛУМОР – САРИВАН – ТОРНЕЛ ЭМНЭЛГИЙН АЯЛАЛ", ["2026-11-11", "2026-11-25"], [1_297_000, 995_000, null],
    { category: "Газрын аялал", duration_text: "9 өдөр 8 шөнө", extra: { transport_type: "land", destinations: ["Лумор", "Саривана", "Торнел"] } }),
  trip("erdan-bel", "ЭРДЭН – ЛУМОР – САРИВАН – БЕЛТОР", ["2026-11-11", "2026-11-25"], [1_600_000, 1_300_000, null],
    { category: "Газрын аялал", duration_text: "9 өдөр 8 шөнө", extra: { transport_type: "land", destinations: ["Эрдэн", "Лумор", "Саривана", "Белтор"] } }),
  trip("volda-fly", "ВОЛДАР ХОТЫН АЯЛАЛ – ЭРДЭНЭЭС НИСЛЭГТЭЙ", ["2026-11-04", "2026-11-18", "2026-12-02"], [2_190_000, 1_890_000, null],
    { category: "Газар + нислэг хосолсон", extra: { transport_type: "land_flight", destinations: ["Эрдэн", "Шилин", "Волдар"], aliases: ["Voldar"],
      itinerary_days: [day(1, "УЛААНБААТАР – ЭРДЭН", "Галт тэргээр хил рүү."), day(2, "ЭРДЭН – ВОЛДАР", "Эрдэн хотоос Волдар руу нисэнэ.")] } }),
  // ---- sea trips, an ordinary city trip with programme, hotel and fares
  trip("sea-a", "ВЭЛМОР ДАЛАЙН ЭРГИЙН АЯЛАЛ", ["2026-11-20", "2026-12-04", "2026-12-18", "2027-01-15"], [1_391_000, 1_191_000, null],
    { extra: { transport_type: "direct_flight", destinations: ["Вэлмор"], aliases: ["Вэлмор"], itinerary_days: programme(6, "Улаанбаатар – Вэлмор", "Буцах өдөр") } }),
  trip("sea-b", "МАРИНА АРЛЫН ДАЛАЙН АМРАЛТ", ["2026-11-28", "2026-12-12"], [3_100_000, 2_700_000, null],
    { extra: { transport_type: "direct_flight", destinations: ["Марина"], aliases: ["Марина"] } }),
  trip("norvel", "НОРВЕЛ ХОТЫН АЯЛАЛ", ["2026-11-22", "2026-12-06", "2027-01-17"], [1_791_000, 1_591_000, 381_000],
    { duration_text: "6 өдөр 5 шөнө", hotel: "Норвел Плаза Хотел", extra: { transport_type: "direct_flight", destinations: ["Норвел"], aliases: ["Норвел", "Norvel"],
      itinerary_days: programme(6, "Улаанбаатар – Норвел", "Буцах өдөр"), included_items: ["Нислэгийн тийз", "Буудал"], excluded_items: ["Хувийн зардал"] } }),
  // ---- ДОРМАН: sibling island trips with an alias that sits inside the ordinary word "санал"
  trip("dorman-a", "ДОРМАН – КЕЛСАРИЯ АЯЛАЛ-Лхагва", ["2026-12-09", "2027-01-13"], [3_290_000, 2_990_000, 490_000],
    { extra: { transport_type: "direct_flight", destinations: ["Дорман"], aliases: ["Dorman", "Kelsaria", "Sana", "Сана"], itinerary_days: tripProgramme } }),
  trip("dorman-b", "ДОРМАН – ЛУНДИН НИСЛЭГТЭЙ ШИНЭ ЖИЛИЙН АЯЛАЛ", ["2026-12-30"], [3_990_000, 3_590_000, 490_000],
    { extra: { transport_type: "direct_flight", destinations: ["Дорман"], aliases: ["Dorman", "Сана", "Sana"] } }),
  trip("dorman-c", "ДОРМАН-КЕЛВИН НИСЛЭГТЭЙ - Мягмар гариг", ["2026-12-15"], [3_190_000, 2_890_000, 490_000],
    { extra: { transport_type: "direct_flight", destinations: ["Дорман"], aliases: ["Dorman", "Kelvin", "Sana", "Сана"] } }),
];

/** Served as the archived catalogue (travel_trip_entries with status = archived). */
export const ARCHIVED: FixtureTrip[] = [
  // The customer's own departure of CASE-16: closed on the 3rd of November 2026.
  trip("verdan-own", "ВЕРДАН - ПАРКЛЭНД - сурагчдын амралт - 11/3", ["2026-11-03"], [2_890_000, 2_690_000, null],
    { status: "archived", extra: { transport_type: "direct_flight", destinations: ["Вердан"], aliases: ["Verdan"], itinerary_days: flightDays, archived_reason: "all_departure_dates_passed" } }),
  // The border-town trip that stopped running.
  trip("nelmar-arch", "ХОРВАТА – НЕЛМАР ХИЛИЙН АЯЛАЛ", ["2026-10-24"], [1_290_000, 1_090_000, null],
    { status: "archived", category: "Газрын аялал", extra: { transport_type: "land", destinations: ["Хорвата", "Нелмар"], archived_reason: "all_departure_dates_passed" } }),
];

export const TRIPS_BY_ID = new Map<string, FixtureTrip>([...CATALOGUE, ...ARCHIVED].map((entry) => [entry.id, entry]));

/** Title of a catalogue trip, for "the reply must (not) name this trip" predicates. */
export function titleOf(id: string): string {
  const found = TRIPS_BY_ID.get(id);
  if (!found) throw new Error(`understanding scenarios: unknown trip id ${id}`);
  return found.route_name;
}

/** Every fare a reply may quote, and every sum of up to 6 passengers of one kind each. */
export function allowedAmounts(): Set<number> {
  const amounts = new Set<number>();
  for (const entry of [...CATALOGUE, ...ARCHIVED]) {
    const fares = [entry.adult_price, entry.child_price, entry.infant_price].map((fare) => (typeof fare === "number" ? fare : 0));
    for (const fare of fares) if (fare) amounts.add(fare);
    for (let adults = 0; adults <= 6; adults += 1) for (let children = 0; children <= 6; children += 1) for (let infants = 0; infants <= 3; infants += 1) {
      const total = adults * fares[0] + children * fares[1] + infants * fares[2];
      if (total) amounts.add(total);
    }
  }
  return amounts;
}

/** Every departure as "M/D" (any year): a reply may print only these, the customer's own dates, or a holiday window. */
export function allowedDays(): Set<string> {
  const days = new Set<string>();
  for (const entry of [...CATALOGUE, ...ARCHIVED]) for (const date of entry.departure_dates) days.add(`${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`);
  return days;
}
