import { day, trip } from "./understandingRoutingFixtures";

/** Invented catalogues for the understanding-routing journeys. Every name, town and price is made up. */

const landDays = [
  day(1, "УЛААНБААТАР – ГАЗАР ХИЛ", "УБ - хилийн чиглэлийн галт тэрэг 16:40-д хөдлөнө."),
  day(2, "ГАЗАР ХИЛ – ЭРДЭН – ЛУМОР", "Өглөө 07:20 цагт хилд бууж автобусаар Лумор хотыг зорино."),
  day(3, "ЛУМОР – САРИВАН", "Автобусаар Саривана уулыг зорино."),
  day(4, "САРИВАН", "Сүм хийдээр аялна."),
  day(5, "САРИВАН – ТОРНЕЛ", "Автобусаар Торнел хотыг зорино."),
  day(6, "ТОРНЕЛ – ЭРДЭН", "Эрдэн хотод ирж чөлөөт цагтай."),
  day(7, "ЭРДЭН – ГАЗАР ХИЛ", "Автобусаар хил гаалиар нэвтэрч галт тэргээр Улаанбаатар руу."),
  day(8, "УЛААНБААТАР", "09:20 цагт Улаанбаатарт ирнэ."),
];

/**
 * Case 11 shape: a LAND trip (selected) whose town word "Эрдэн" also sits in the TITLE of a sibling
 * "<town>-ээс нислэгтэй" trip that flies; a different trip is named by another town ("Волдар").
 */
export const landFamily = [
  trip("sel", "ЭРДЭН – ЛУМОР – САРИВАН – ТОРНЕЛ", ["2098-02-11", "2098-02-25"], [1_207_000, 995_000, null],
    { extra: { transport_type: "land", destinations: ["Эрдэн", "Лумор", "Саривана", "Торнел"], itinerary_days: landDays, aliases: [] } }),
  trip("sib", "ЛУМОР – САРИВАН – ТОРНЕЛ ЭМНЭЛГИЙН АЯЛАЛ", ["2098-02-11", "2098-02-25"], [1_297_000, 995_000, null],
    { duration_text: "9 өдөр 8 шөнө", extra: { transport_type: "land", destinations: ["Лумор", "Саривана", "Торнел"], aliases: [] } }),
  trip("bel", "ЭРДЭН – ЛУМОР – САРИВАН – БЕЛТОР", ["2098-02-11", "2098-02-25"], [1_600_000, 1_300_000, null],
    { duration_text: "9 өдөр 8 шөнө", extra: { transport_type: "land", destinations: ["Эрдэн", "Лумор", "Саривана", "Белтор"], aliases: [] } }),
  trip("far", "ВОЛДАР ХОТЫН АЯЛАЛ – ЭРДЭНЭЭС НИСЛЭГТЭЙ", ["2098-02-04", "2098-02-11"], [2_190_000, 1_890_000, null],
    { category: "Газар + нислэг хосолсон", extra: { transport_type: "land_flight", destinations: ["Эрдэн", "Волдар"], aliases: ["Voldar"],
      itinerary_days: [day(1, "УЛААНБААТАР – ЭРДЭН", "Галт тэргээр хил рүү."), day(2, "ЭРДЭН – ВОЛДАР", "Эрдэн хотоос Волдар руу нисэнэ.")] } }),
  trip("isl", "МАРИНА АРЛЫН АЯЛАЛ", ["2098-02-14", "2098-02-28"], [3_100_000, 2_700_000, null],
    { category: "Шууд нислэгтэй аялал", extra: { transport_type: "direct_flight", destinations: ["Марина"], aliases: [] } }),
];

const seaDays = [1, 2, 3].map((n) => day(n, `ӨДӨР ${n}`, `Хөтөлбөр ${n} (invented).`));

/** Corrections shape: a city trip, two sea trips, and a pair of trips that share a town word. */
export const correctionsCatalog = [
  trip("city", "НОРВЕЛ ХОТЫН АЯЛАЛ", ["2098-03-15", "2098-03-29"], [1_791_000, 1_591_000, 381_000],
    { extra: { transport_type: "land", destinations: ["Норвел"], aliases: ["Норвел"], itinerary_days: seaDays } }),
  trip("seaA", "ВЭЛМОР ДАЛАЙН ЭРГИЙН АЯЛАЛ", ["2098-02-15", "2098-03-06"], [1_391_000, 1_191_000, null],
    { extra: { transport_type: "direct_flight", destinations: ["Вэлмор"], aliases: ["Вэлмор", "далайн аялал"], itinerary_days: seaDays } }),
  trip("seaB", "ТАРСИС АРЛЫН ДАЛАЙН АМРАЛТ", ["2098-02-20", "2098-03-10"], [2_291_000, 1_891_000, null],
    { extra: { transport_type: "direct_flight", destinations: ["Тарсис"], aliases: ["Тарсис"], itinerary_days: seaDays } }),
  trip("verdan", "ВЕРДАН ХОТЫН АЯЛАЛ", ["2098-02-12", "2098-02-26"], [2_990_000, 2_390_000, null],
    { extra: { transport_type: "direct_flight", destinations: ["Вердан"], aliases: ["Verdan"], itinerary_days: seaDays } }),
  trip("juran", "ВЕРДАН - ЖУРАН - МАКУР ГАЗАР НИСЛЭГ ХОСОЛСОН АЯЛАЛ", ["2098-02-14", "2098-03-14"], [3_190_000, 2_790_000, null],
    { extra: { transport_type: "land_flight", destinations: ["Вердан", "Журан", "Макур"], aliases: ["Журан"], itinerary_days: seaDays } }),
  trip("juranDirect", "ЖУРАН ХОТ ШУУД НИСЛЭГТЭЙ АЯЛАЛ", ["2098-02-18", "2098-03-18"], [3_490_000, 2_990_000, null],
    { extra: { transport_type: "direct_flight", destinations: ["Журан"], aliases: ["Журан", "Juran"], itinerary_days: seaDays } }),
];

const gateDays = Array.from({ length: 8 }, (_, i) => day(i + 1, `ӨДӨР ${i + 1}`, `Өдөр ${i + 1}-ийн хөтөлбөр (invented).`));

/**
 * Case 13 shape: the trip the customer names ("вердан зорентын хаалга") has ONE date and it is fully
 * booked; a sibling that shares the landmark word is open; plain city trips are open.
 */
export const namedFullCatalog = (state: "SOLD_OUT" | "OPEN") => [
  trip("named", "ВЕРДАН + ЗОРЕНТЫН ХААЛГА ШУУД НИСЛЭГТЭЙ АЯЛАЛ ( Мирова - Аватар )", ["2098-02-19"], [3_760_000, 3_430_000, null], {
    extra: { transport_type: "direct_flight", destinations: ["Вердан", "Мирова"], aliases: ["Зорентын хаалга", "Verdan", "Mirova"], itinerary_days: gateDays,
      website_departure_availability: [{ date: "2098-02-19", status: state, seatsLeft: state === "OPEN" ? 3 : 0 }] } }),
  trip("combo", "ЗОРЕНТЫН ХААЛГАНЫ ГАЗАР НИСЛЭГ ХОСОЛСОН АЯЛАЛ ( Мирова - Аватар )", ["2098-02-10", "2098-03-01", "2098-03-15"], [2_750_000, 2_450_000, null], {
    duration_text: "10 өдөр 9 шөнө", category: "Газар + нислэг хосолсон",
    extra: { transport_type: "land_flight", destinations: ["Дорвал", "Мирова"], aliases: ["Зорентын хаалга", "Mirova", "Zorent"], itinerary_days: gateDays } }),
  trip("cityA", "УБ-Вердан хотын 2-р сарын аяллын хөтөлбөр", ["2098-02-12", "2098-02-26"], [2_990_000, 2_390_000, null], {
    duration_text: "6 өдөр 5 шөнө", extra: { transport_type: "direct_flight", destinations: ["Вердан"], aliases: ["Verdan"], itinerary_days: gateDays } }),
  trip("cityB", "УБ-Вердан хотын 3-р сарын аяллын хөтөлбөр", ["2098-03-22"], [2_990_000, 2_590_000, null], {
    duration_text: "5 өдөр 4 шөнө", extra: { transport_type: "direct_flight", destinations: ["Вердан"], aliases: ["Verdan"], itinerary_days: gateDays } }),
  trip("sea", "ЛАГУНА АРЛЫН АЯЛАЛ", ["2098-02-15", "2098-03-06"], [1_391_000, 1_191_000, null],
    { extra: { transport_type: "direct_flight", destinations: ["Лагуна"], aliases: [] } }),
];
