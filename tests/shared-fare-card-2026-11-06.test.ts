/**
 * Every trip gets the shared fare card (2026-11-06). The old card read the trip's raw
 * fields for the trips the shared one could not print: a weekly schedule whose price row
 * carries the poster header "Үнэ" as its label, named packages, room or cabin prices and
 * trips with no fare at all. It is gone; these pin what the shared card prints instead,
 * and that the reply checker accepts each card. Trip names and prices are invented.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { TravelTrip } from "../src/lib/travelTypes";
import { buildFarePriceLines, buildFareSection, displayAgeBand, NO_FARE_LINE, SEATS_FULL_LINE } from "../src/lib/tripFareBlock";
import { priceRowPackageLabel } from "../src/lib/tripOffers";
import { verifyTripReply } from "../src/lib/tripReplyVerification";
import { shouldSilenceNoDataReply } from "../src/lib/reply";
import { buildTripProgramReply } from "../src/lib/travelFastPathsProgram";

const NOW = new Date("2026-11-06T04:00:00Z");

function trip(fields: Partial<TravelTrip> = {}): TravelTrip {
  return {
    id: "velmor", category: "Аялал", operator_name: "Uudam", route_name: "Вэлмор Нарвэл аялал", duration_text: "5 өдөр 4 шөнө",
    adult_price: 1_690_000, child_price: 1_490_000, infant_price: null, currency: "MNT", departure_dates: ["Ням гараг бүр"],
    seats_total: null, seats_left: null, has_food: true, status: "active", notes: "", hotel: "", source_description: "",
    photo_urls: [], extra: {}, created_at: "", updated_at: "", ...fields,
  };
}

/** A weekly trip shaped like the live ones: the poster header as the row label, birth-year bands, a free infant. */
function weeklyTrip(extra: Record<string, unknown> = {}): TravelTrip {
  return trip({
    extra: {
      price_groups: [{ label: "Үнэ", dates: [], adult_price: 1_690_000, child_price: 1_490_000, passenger_prices: [
        { label: "Хүүхэд 2014-2015 он", age_range: "2014-2015 он", price: 1_490_000 },
        { label: "Хүүхэд 2016-2023 он", age_range: "2016-2023 он", price: 1_290_000 },
      ] }],
      child_rules: [{ note: "Үнэгүй", label: "Нярай", price: 0, age_range: "0-2 нас" }],
      ...extra,
    },
  });
}

const card = (t: TravelTrip, extra: string[] = []) => [t.route_name, ...buildFareSection(t, NOW, extra)].join("\n");
const accepted = (t: TravelTrip, text: string) => assert.equal(verifyTripReply({ reply: text, trips: [t], now: NOW }), text);

test("the poster header 'Үнэ' as a row label is neither a package nor a date", () => {
  for (const label of ["Үнэ", "үнийн мэдээлэл", "Price", "ҮНЭ"]) assert.equal(priceRowPackageLabel({ label }, NOW), null, label);
  // Dates and schedules are not packages either.
  for (const label of ["7 сарын 10", "Баасан гараг бүр", "Баасан гариг болгон", "Пүрэв, Ням гариг", "Ням гаригт", "Өдөр бүр",
    "1-р сарын үнэ", "12/2, 12/9", "10-ны гаралт", ""]) assert.equal(priceRowPackageLabel({ label }, NOW), null, label);
  // A label naming what the price includes is a package.
  for (const label of ["Онгоцны тийзтэй үнэ", "Онгоцны тийзгүй", "Хөтөлбөртэй"]) assert.equal(priceRowPackageLabel({ label }, NOW), label);
});

test("a weekly schedule the calendar cannot date prints its fares under the trip's own schedule text", () => {
  const t = weeklyTrip();
  const block = buildFarePriceLines(t, NOW);
  assert.equal(block.kind, "undated");
  assert.equal(block.schedule, "Ням гараг бүр");
  const text = card(t);
  assert.equal(text, [
    "Вэлмор Нарвэл аялал",
    "💰 Үнэ:",
    "• Том хүн: 1,690,000₮",
    "• Хүүхэд /2016-2023 онд төрсөн/: 1,290,000₮",
    "• Хүүхэд /2014-2015 онд төрсөн/: 1,490,000₮",
    "• Нярай /0-2 нас/: Үнэгүй",
    "",
    "📅 Гарах өдрүүд:",
    "Ням гараг бүр",
  ].join("\n"));
  accepted(t, text);
});

test("the same weekly trip with the website's departures loaded is a dated card", () => {
  const t = weeklyTrip({ website_departure_availability: [
    { date: "2026-11-08", status: "OPEN", seatsLeft: null },
    { date: "2026-11-15", status: "OPEN", seatsLeft: null },
  ] });
  const block = buildFarePriceLines(t, NOW);
  assert.equal(block.kind, "dated");
  assert.deepEqual(block.onSale, ["2026-11-08", "2026-11-15"]);
  const text = card(t);
  assert.match(text, /• Хүүхэд \/2016-2023 онд төрсөн\/: 1,290,000₮/);
  assert.match(text, /📅 Гарах өдрүүд:\n11\/8, 11\/15$/);
  assert.doesNotMatch(text, /Багц:/);
  accepted(t, text);
});

test("a trip with no fare is the no-data sentence alone: silence and a staff lead", () => {
  const t = trip({ adult_price: null, child_price: null, departure_dates: ["2026-11-13"], extra: {
    extra_fees: [{ label: "Боомтын хураамж", amount: 50, currency: "USD" }],
  } });
  const block = buildFarePriceLines(t, NOW);
  assert.equal(block.kind, "no_fare");
  assert.deepEqual(buildFareSection(t, NOW, ["⚠️ fees"]), [NO_FARE_LINE]);
  assert.ok(shouldSilenceNoDataReply(card(t)));
  // No schedule at all, and every departure passed (the live bot archives such a trip), alike.
  assert.equal(buildFarePriceLines(trip({ departure_dates: [] }), NOW).kind, "no_fare");
  assert.equal(buildFarePriceLines(trip({ departure_dates: ["2026-10-01"] }), NOW).kind, "no_fare");
});

test("a trip whose every departure the resolver calls contradictory has no fare, never the raw fields", () => {
  const t = trip({ departure_dates: ["2026-12-02"], extra: { price_groups: [
    { dates: ["2026-12-02"], adult_price: 1_111_000 },
    { dates: ["2026-12-02"], adult_price: 1_222_000 },
  ] } });
  const block = buildFarePriceLines(t, NOW);
  assert.equal(block.kind, "no_fare");
  assert.doesNotMatch(card(t), /1,111,000|1,222,000|1,690,000/);
});

test("every near departure full is the seats-full line", () => {
  const t = trip({ departure_dates: ["2026-12-02", "2026-12-09"], extra: { website_departure_availability: [
    { date: "2026-12-02", status: "SOLD_OUT", seatsLeft: 0 },
    { date: "2026-12-09", status: "SOLD_OUT", seatsLeft: 0 },
  ] } });
  const block = buildFarePriceLines(t, NOW);
  assert.equal(block.kind, "sold_out");
  assert.deepEqual(buildFareSection(t, NOW, ["⚠️ fees"]), [SEATS_FULL_LINE]);
});

test("a cabin-priced trip prints its room prices, and the checker accepts them", () => {
  const rooms = [
    { room_type: "4 ортой цонхтой өрөө", price: 1_210_000, currency: "MNT" },
    { room_type: "2 ортой цонхтой өрөө", price: 1_320_000, currency: "MNT" },
  ];
  // Two departures: with exactly one in the reply the checker (tripFacts quotablePrices) reads
  // that date's passenger fares only, so a single-departure cabin card is still refused there.
  const t = trip({ adult_price: null, child_price: null, departure_dates: ["2026-12-02", "2026-12-09"], extra: { room_prices: rooms } });
  const block = buildFarePriceLines(t, NOW);
  assert.equal(block.kind, "rooms");
  const text = card(t, ["⚠️ Дээрх үнэ дээр нэмэлт төлбөр орно: Боомтын хураамж: 50 USD"]);
  assert.equal(text, [
    "Вэлмор Нарвэл аялал",
    "💰 Үнэ:",
    "",
    "Өрөөний төрлөөр:",
    "• 4 ортой цонхтой өрөө: 1,210,000₮",
    "• 2 ортой цонхтой өрөө: 1,320,000₮",
    "⚠️ Дээрх үнэ дээр нэмэлт төлбөр орно: Боомтын хураамж: 50 USD",
    "",
    "📅 Гарах өдрүүд:",
    "12/2, 12/9",
  ].join("\n"));
  accepted(t, text);
  // A weekly cabin trip prints them under its schedule text.
  const weekly = trip({ adult_price: null, child_price: null, extra: { room_prices: rooms } });
  assert.equal(buildFarePriceLines(weekly, NOW).kind, "rooms");
  assert.match(card(weekly), /• 2 ортой цонхтой өрөө: 1,320,000₮\n\n📅 Гарах өдрүүд:\nНям гараг бүр$/);
  // One room priced twice is no answer, not a guess between the two.
  const twice = trip({ adult_price: null, child_price: null, departure_dates: ["2026-12-02"], extra: { room_prices: [
    { room_type: "2 ортой өрөө", price: 1_320_000 },
  ], price_groups: [{ dates: ["2026-12-02"], room_prices: [{ room_type: "2 ортой өрөө", price: 1_420_000 }] }] } });
  assert.equal(buildFarePriceLines(twice, NOW).kind, "no_fare");
});

test("named packages on a weekly schedule print one block each, named", () => {
  const t = trip({ extra: { price_groups: [
    { label: "Онгоцны тийзгүй үнэ", dates: ["Ням гараг бүр"], adult_price: 1_490_000, child_price: 1_460_000 },
    { label: "Онгоцны тийзтэй үнэ", dates: ["Ням гараг бүр"], adult_price: 5_600_000, child_price: 1_550_000 },
  ] } });
  const text = card(t);
  assert.match(text, /Багц: Онгоцны тийзгүй үнэ\n• Том хүн: 1,490,000₮\n• Хүүхэд: 1,460,000₮\n\nБагц: Онгоцны тийзтэй үнэ\n• Том хүн: 5,600,000₮/);
  accepted(t, text);
});

test("a program question that asks the price gets the shared fare card, every band and the free infant", () => {
  // The program reply printed one flat "Насанд хүрэгч: X | Хүүхэд: Y" line for a trip the shared
  // card could not read: the cheaper child band and the free infant were dropped, and a trip
  // with no fare answered with dates and no price instead of silence.
  const days = [{ day: 1, title: "Улаанбаатар-Вэлмор", description: "Нисэх" }, { day: 2, title: "Чөлөөт өдөр", description: "Далайн эрэг" }];
  const weekly = weeklyTrip({ itinerary_days: days });
  const reply = buildTripProgramReply("Вэлмор Нарвэл аялал хөтөлбөр үнэ хэд вэ", [weekly], NOW)?.reply || "";
  assert.match(reply, /• Том хүн: 1,690,000₮/);
  assert.match(reply, /• Хүүхэд \/2016-2023 онд төрсөн\/: 1,290,000₮/);
  assert.match(reply, /• Хүүхэд \/2014-2015 онд төрсөн\/: 1,490,000₮/);
  assert.match(reply, /• Нярай[^:\n]*: Үнэгүй/);
  assert.match(reply, /📅 Гарах өдрүүд:\nНям гараг бүр/);
  assert.doesNotMatch(reply, /Насанд хүрэгч/);
  accepted(weekly, reply);

  const unpriced = trip({ id: "program-no-fare", route_name: "Мирвэн Нарвэл аялал", adult_price: null, child_price: null, departure_dates: ["2026-12-08"], extra: { itinerary_days: days } });
  const silent = buildTripProgramReply("Мирвэн Нарвэл аялал хөтөлбөр үнэ хэд вэ", [unpriced], NOW)?.reply || "";
  assert.match(silent, /Үнийн мэдээлэл одоогоор тодорхойгүй байна/);
  assert.ok(shouldSilenceNoDataReply(silent), "no fare is silence and a staff lead, not dates without a price");
});

test("a birth-year band reads 'born in'; any other band is printed as written", () => {
  assert.equal(displayAgeBand("2014-2015 он"), "2014-2015 онд төрсөн");
  assert.equal(displayAgeBand(" 2016 – 2023 он "), "2016 – 2023 онд төрсөн");
  assert.equal(displayAgeBand("2-11 нас"), "2-11 нас");
  assert.equal(displayAgeBand("2024-2026 онд төрсөн"), "2024-2026 онд төрсөн");
});
