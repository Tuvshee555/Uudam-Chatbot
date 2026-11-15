import type { FixtureTrip } from "./conversationGateHarness";

/**
 * An INVENTED catalogue for the calendar / holiday journeys (no real trip, place, price or date).
 * Departures cover: a February-2027 flight trip family, a trip with no February date, trips that are
 * on the road over 31 December, a trip named for the New Year, a medical check-up trip, and a trip
 * whose adult fare equals the child fare of several others.
 */
export const fixtureTrip = (id: string, name: string, dates: string[], fares: [number, number | null, number | null], fields: Record<string, unknown> = {}) => ({
  id, route_name: name, operator_name: "Fixture agency", category: "Аялал", adult_price: fares[0], child_price: fares[1], infant_price: fares[2],
  currency: "MNT", status: "active", duration_text: "8 өдөр 7 шөнө", departure_dates: dates, seats_total: 20, seats_left: 10,
  has_food: null, hotel: "", photo_urls: [], notes: "", source_description: "",
  extra: { customer_visible: true, age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" } }, ...fields,
} as unknown as FixtureTrip);

export const HOLIDAY_CATALOG: FixtureTrip[] = [
  fixtureTrip("tarvia-a", "ТАРВИЯ АЯЛАЛ — ЛУМАР, ВЕЛНА", ["2026-11-14", "2026-11-21", "2026-12-05", "2027-01-30", "2027-02-06", "2027-02-13"], [5_090_000, 4_790_000, 790_000]),
  fixtureTrip("tarvia-b", "ТАРВИЯ — ОРМЕЛ АЯЛАЛ", ["2026-12-06", "2026-12-13", "2027-02-11", "2027-02-14", "2027-02-21"], [5_990_000, 4_790_000, 790_000]),
  fixtureTrip("velmora", "ВЕЛМОРА — ДОРНАН АЯЛАЛ", ["2026-12-12", "2026-12-29", "2027-01-30", "2027-02-06"], [5_090_000, 4_490_000, 790_000]),
  fixtureTrip("pekara-air", "ПЕКАРА - ТОРВИН ШУУД НИСЛЭГТЭЙ АЯЛАЛ", ["2026-12-30"], [3_090_000, 2_790_000, 390_000], { duration_text: "5 өдөр 4 шөнө" }),
  fixtureTrip("pekara-4", "ПЕКАРА - ЖИРОН 4 ХОТЫН АЯЛАЛ", ["2026-11-08", "2026-11-15", "2026-11-22", "2027-01-10"], [1_690_000, 1_290_000, null]),
  fixtureTrip("sanvia-ny", "САНВИЯ - ХОРТ НИСЛЭГТЭЙ ШИНЭ ЖИЛИЙН АЯЛАЛ", ["2026-12-27", "2026-12-28", "2026-12-29", "2026-12-30"], [4_290_000, 3_990_000, 690_000]),
  fixtureTrip("sanvia-tue", "САНВИЯ - ХОРТ НИСЛЭГТЭЙ - Мягмар гариг", ["2026-12-01", "2026-12-08", "2026-12-29"], [2_890_000, 2_690_000, null]),
  fixtureTrip("hortan-check", "ХОРТАН ХОТЫН БҮТЭН БИЕИЙН ШИНЖИЛГЭЭТЭЙ АЯЛАЛ", ["2026-12-01", "2026-12-06"], [1_290_000, 950_000, null], { duration_text: "7 өдөр 6 шөнө" }),
  fixtureTrip("jorvin", "ЖОРВИН-МИНИ ВАЛДА-ХОРТАН ХОТЫН АЯЛАЛ", ["2026-11-12", "2026-12-03", "2026-12-10", "2026-12-17", "2026-12-24", "2026-12-31", "2027-01-07"], [990_000, 850_000, null], { duration_text: "7 өдөр 6 шөнө" }),
  fixtureTrip("korvelin-ad", "КОРВЕЛИН + МАРДУН ГҮҮР ШУУД НИСЛЭГТЭЙ АЯЛАЛ", ["2026-11-19"], [3_760_000, 3_430_000, null]),
  fixtureTrip("korvelin-q1", "УБ-КОРВЕЛИН ХОТЫН 1,2,3-Р САРЫН АЯЛАЛ", ["2027-01-14", "2027-01-21", "2027-01-28", "2027-02-18", "2027-03-06"], [3_390_000, 3_090_000, null], { duration_text: "6 өдөр 5 шөнө" }),
];

/** Early November 2026: the Tsagaan Sar table has 2026-2030, so the coming one is 2027-02-06..09. */
export const HOLIDAY_NOW = "2026-11-06T04:00:00Z";

/** A trip sold on a weekly schedule written as text: it has no calendar date, only fares. */
export const WEEKLY_TRIP = fixtureTrip("kordan-weekly", "КОРДАН - МИРЕЛ ШУУД НИСЛЭГТЭЙ (Пүрэв, Ням гариг)", ["Пүрэв, Ням гариг"], [880_000, 780_000, null], { duration_text: "6 өдөр 5 шөнө" });

/** Trips whose CHILD or INFANT fare ends in the same amount as another trip's adult fare (990,000₮ vs the Жорвин trip). */
export const PRICE_NOISE_TRIPS: FixtureTrip[] = [
  fixtureTrip("lornan-child", "ЛОРНАН - ВЕСТРА АЯЛАЛ", ["2027-03-12", "2027-03-19"], [1_690_000, 990_000, null]),
  fixtureTrip("lornan-infant", "ЛОРНАН - ТАВИРА АЯЛАЛ", ["2027-03-12", "2027-03-19"], [2_290_000, 1_890_000, 990_000]),
];
