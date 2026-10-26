import assert from "node:assert/strict";
import test from "node:test";
import { verifyTripReply } from "../src/lib/tripReplyVerification";
import type { TravelTrip } from "../src/lib/travelTypes";
import type { TripSelection } from "../src/lib/tripRequest";

const now = new Date("2098-02-01T04:00:00Z");
const departure = "2098-03-17";
function trip(fields: Partial<TravelTrip> = {}): TravelTrip {
  return { id: "velmor", route_name: "Вэлмор аялал", category: "", operator_name: "Invented", duration_text: "5 өдөр",
    adult_price: 731_000, child_price: null, infant_price: null, currency: "MNT", departure_dates: [departure],
    seats_total: null, seats_left: null, has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
    extra: {}, created_at: "", updated_at: "", ...fields };
}

test("a trip section cannot borrow another candidate's copied supplement text", () => {
  const a = trip();
  const supplement = "Өрөөнд ганцаараа байрлах нэмэлт төлбөр 287,000₮";
  const b = trip({ id: "nerith", route_name: "Нерит аялал", extra: { excluded_items: [supplement] } });
  const wrong = `${a.route_name}\nҮнэд багтаагүй:\n• ${supplement}`;
  assert.equal(verifyTripReply({ reply: wrong, trips: [a, b], now }), "REFER");
  const valid = `${b.route_name}\nҮнэд багтаагүй:\n• ${supplement}`;
  assert.equal(verifyTripReply({ reply: valid, trips: [a, b], now }), valid);
});

test("a trip section cannot borrow another candidate's booking policy topic", () => {
  const a = trip();
  const b = trip({ id: "nerith", route_name: "Нерит аялал", extra: { booking_terms: { visa: "Виз шаардлагагүй." } } });
  const wrong = `${a.route_name}\nВиз шаардлагагүй.`;
  assert.equal(verifyTripReply({ reply: wrong, trips: [a, b], now }), "REFER");
  const valid = `${b.route_name}\nВиз шаардлагагүй.`;
  assert.equal(verifyTripReply({ reply: valid, trips: [a, b], now }), valid);
});

test("fare verification keeps the selected and printed package scope", () => {
  const value = trip({ extra: { price_groups: [
    { dates: [departure], hotel: "Lumen Lodge", package_id: "Хөтөлбөргүй", adult_price: 831_000, single_price: 183_000 },
    { dates: [departure], hotel: "Lumen Lodge", package_id: "Хөтөлбөртэй", adult_price: 1_131_000, single_price: 283_000 },
  ] } });
  const selection: TripSelection = { tripId: value.id, date: departure, hotel: "Lumen Lodge", package: "Хөтөлбөргүй", passengers: [] };
  const check = (reply: string) => verifyTripReply({ reply, trips: [value], selection, now });
  for (const label of ["", "Багц: Хөтөлбөргүй\n"]) {
    assert.equal(check(`${value.route_name}\n${label}Том хүн: 1,131,000₮`), "REFER");
    assert.equal(check(`${value.route_name}\n${label}Үнэ: 1,131,000₮`), "REFER");
    const valid = `${value.route_name}\n${label}Том хүн: 831,000₮`;
    assert.equal(check(valid), valid);
  }
  const alternatives = `${value.route_name}\nБагц: Хөтөлбөргүй\nТом хүн: 831,000₮\nБагц: Хөтөлбөртэй\nТом хүн: 1,131,000₮`;
  assert.equal(check(alternatives), alternatives);
  const supplement = `${value.route_name}\nБагц: Хөтөлбөргүй\nНэг хүний өрөөний нэмэлт: 183,000₮`;
  assert.equal(check(supplement), supplement);
  assert.equal(check(supplement.replace("183,000", "283,000")), "REFER");
});

test("zero and free passenger fare claims require an explicitly free source fare", () => {
  const missing = trip();
  const paid = trip({ infant_price: 127_000 });
  const free = trip({ infant_price: 0, extra: { child_rules: [{ label: "infant", age_range: "0-23 months", price: 0, note: "free" }] } });
  for (const fare of ["Үнэгүй", "free", "0₮"]) {
    const reply = `${missing.route_name}\nНярай: ${fare}`;
    for (const value of [missing, paid]) {
      assert.equal(verifyTripReply({ reply, trips: [value], now }), "REFER", fare);
    }
    assert.equal(verifyTripReply({ reply, trips: [free], now }), reply, fare);
  }
  assert.equal(verifyTripReply({ reply: `${missing.route_name}\nҮнэ: 731₮`, trips: [missing], now }), "REFER");
  const negative = `${paid.route_name}\nНярай үнэгүй биш: 127,000₮`;
  assert.equal(verifyTripReply({ reply: negative, trips: [paid], now }), negative);
  const amenity = `${missing.route_name}\nТом хүн: 731,000₮, free Wi-Fi`;
  assert.equal(verifyTripReply({ reply: amenity, trips: [missing], now }), amenity);
});

test("an incorrect party total cannot pass by equalling one real unit fare", () => {
  const value = trip();
  const wrong = `${value.route_name}\nТом хүн x 2: 731,000₮\nНийт: 731,000₮`;
  assert.equal(verifyTripReply({ reply: wrong, trips: [value], now }), "REFER");
  const valid = wrong.replace("Нийт: 731,000₮", "Нийт: 1,462,000₮");
  assert.equal(verifyTripReply({ reply: valid, trips: [value], now }), valid);
});
