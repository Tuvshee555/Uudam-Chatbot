import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";

applyTestEnv({});

/**
 * Two trips added 2026-11-11 had correct price cards that the reply checker (tripReplyVerification.ts)
 * rejected, so a customer asking their price got silence. Invented trips only.
 *  1. A free infant fare labelled "/2 нас хүртэл/" ("up to 2"): the label was read as a 2-year-old.
 *  2. A trip sold on request: its title carries a staff note with a date, its departures field is words,
 *     and it has only base fares. The title's digits were read as a price and a departure.
 */
const base = (id: string, name: string, fields: Record<string, unknown>) => ({
  id, route_name: name, operator_name: "x", category: "Аялал", currency: "MNT", status: "active", duration_text: "8 өдөр 7 шөнө",
  seats_total: null, seats_left: null, has_food: null, hotel: "", photo_urls: [], notes: "", source_description: "", ...fields,
}) as unknown as TravelTrip;

test("a free infant fare labelled 'up to 2' and a sold-on-request trip pass the reply checker", async () => {
  const { verifyTripReply } = await import("../src/lib/tripReplyVerification");
  const { buildStructuredTripReply } = await import("../src/lib/travelFastPaths");
  const now = new Date("2098-02-01T04:00:00Z");

  const infant = base("infant", "ЛУМАРА – ВЭЛМОР ШУУД НИСЛЭГ", {
    adult_price: 4_490_000, child_price: 3_990_000, infant_price: 0, departure_dates: ["2098-03-05"],
    extra: { customer_visible: true, price_groups: [{ dates: ["2098-03-05"], adult_price: 4_490_000, child_price: 3_990_000, infant_price: 0,
      passenger_prices: [{ label: "Нярай", price: 0, note: "Үнэгүй", age_range: "2 нас хүртэл", currency: "MNT" }] }] },
  });
  const onRequest = base("on-request", "Калдор – Норвел – Орвелия арал - ХАМТ ОЛНЫ ЗАХИАЛГА - 2098-12-15-с өмнөх өдрүүдэд хамт олны захиалга авна", {
    adult_price: 2_690_000, child_price: 2_290_000, infant_price: 1_390_000, departure_dates: ["12/15-аас өмнөх өдрүүдэд хамт олны захиалгаар"],
    extra: { customer_visible: true, age_rules: { infant: "1-2 нас" } },
  });
  for (const trip of [infant, onRequest]) {
    const card = buildStructuredTripReply(`${trip.route_name} үнэ хэд вэ`, [infant, onRequest], now);
    assert.ok(card && card !== "REFER", `${trip.id}: a price card is built`);
    assert.notEqual(verifyTripReply({ reply: card!, trips: [trip], now }), "REFER", `${trip.id}: the checker accepts the trip's own card:\n${card}`);
  }
  // The checker still rejects an invented price on the same trips.
  assert.equal(verifyTripReply({ reply: `✈️ ${onRequest.route_name}\n💰 Үнэ:\n• Том хүн: 1,999,000₮`, trips: [onRequest], now }), "REFER");
  assert.equal(verifyTripReply({ reply: `✈️ ${infant.route_name}\n3/5:\n• Нярай /2 нас хүртэл/: 500,000₮`, trips: [infant], now }), "REFER");
});

test("under a list, a trip whose party fare depends on the departure date says so, never a bare name", async () => {
  const { buildAmbiguousPassengerTotalReply } = await import("../src/lib/travelFastPaths");
  const now = new Date("2098-02-01T04:00:00Z");
  const simple = base("simple", "НОРВЕЛ ХОТЫН АЯЛАЛ", { adult_price: 1_790_000, child_price: 1_590_000, infant_price: null, departure_dates: ["2098-03-15"],
    extra: { customer_visible: true, age_rules: { adult: "12+ нас", child: "2-11 нас" } } });
  const byDate = base("by-date", "ОРВЕЛИЯ АРЛЫН АЯЛАЛ", { adult_price: 5_390_000, child_price: null, infant_price: null, departure_dates: ["2098-03-10", "2098-03-24"],
    extra: { customer_visible: true, price_groups: [
      { dates: ["2098-03-10"], adult_price: 5_390_000, passenger_prices: [{ label: "Хүүхэд", age_range: "3-6 нас", price: 3_590_000 }, { label: "Хүүхэд", age_range: "7-13 нас", price: 4_990_000 }] },
      { dates: ["2098-03-24"], adult_price: 5_190_000, passenger_prices: [{ label: "Хүүхэд", age_range: "3-6 нас", price: 3_390_000 }, { label: "Хүүхэд", age_range: "7-13 нас", price: 4_790_000 }] },
    ] } });
  const reply = buildAmbiguousPassengerTotalReply("4 bolon 7 nastai huuhed tulbur hed ve?", [simple, byDate], now) || "";
  assert.ok(reply.includes("НОРВЕЛ ХОТЫН АЯЛАЛ: 2 хүүхэд") && reply.includes("x 1,590,000₮"), reply);
  assert.doesNotMatch(reply, /^• ОРВЕЛИЯ АРЛЫН АЯЛАЛ\s*$/mu, `never the bare name: ${reply}`);
  assert.match(reply, /ОРВЕЛИЯ АРЛЫН АЯЛАЛ — (?:үнэ нь таны сонголтоос|энэ насны үнэ бүртгэгдээгүй)|ОРВЕЛИЯ АРЛЫН АЯЛАЛ:.*₮/u, reply);
});
