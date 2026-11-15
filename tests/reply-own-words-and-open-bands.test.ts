import test from "node:test";
import assert from "node:assert/strict";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";

applyTestEnv();

// Invented trips. Found on 2026-11-11: answers the bot built itself were refused by its own checker.
const NOW = new Date("2099-01-05T04:00:00Z");
const base = (fields: Partial<TravelTrip>): TravelTrip => ({
  id: "t", route_name: "НОРВЕЛ", operator_name: "", category: "", duration_text: "5 өдөр", adult_price: 2_000_000, child_price: 1_500_000,
  infant_price: null, currency: "MNT", departure_dates: ["2099-02-10"], seats_total: null, seats_left: null, has_food: null, status: "active",
  notes: "", hotel: "", source_description: "", photo_urls: [], created_at: "", updated_at: "", extra: {}, ...fields,
}) as TravelTrip;

test("a date inside the trip's own name or its departure rule is not a claimed departure", async () => {
  const { verifyTripReply } = await import("../src/lib/tripReplyVerification");
  const trip = base({ route_name: "НОРВЕЛ - ХАМТ ОЛНЫ ЗАХИАЛГА - 2099-03-15-с өмнөх өдрүүдэд", departure_dates: ["3/15-аас өмнөх өдрүүдэд хамт олны захиалгаар"] });
  const reply = `✈️ ${trip.route_name}\n💰 Үнэ:\n• Том хүн: 2,000,000₮\n• Хүүхэд: 1,500,000₮\n📅 Гарах өдрүүд: ${trip.departure_dates[0]}`;
  assert.equal(verifyTripReply({ reply, trips: [trip], now: NOW }), reply);
  // A date the trip does not have is still refused.
  assert.equal(verifyTripReply({ reply: `${reply}\n2099-04-20-нд гарна`, trips: [trip], now: NOW }), "REFER");
});

test("a free infant printed with the trip's own open band is that fare", async () => {
  const { verifyTripReply } = await import("../src/lib/tripReplyVerification");
  const trip = base({ infant_price: 0, extra: { age_rules: { child: "2-12 нас", infant: "2 нас хүртэл" }, price_groups: [{ dates: ["2099-02-10"], adult_price: 2_000_000,
    passenger_prices: [{ label: "Хүүхэд", age_range: "2-12 нас", price: 1_500_000 }, { label: "Нярай", age_range: "2 нас хүртэл", price: 0, note: "Үнэгүй" }] }] } });
  const reply = "✈️ НОРВЕЛ\n2/10:\n• Том хүн: 2,000,000₮\n• Хүүхэд /2-12 нас/: 1,500,000₮\n• Нярай /2 нас хүртэл/: Үнэгүй";
  assert.equal(verifyTripReply({ reply, trips: [trip], now: NOW }), reply);
});

test("a package named under one date heading does not carry into the next dates", async () => {
  const { verifyTripReply } = await import("../src/lib/tripReplyVerification");
  const trip = base({ departure_dates: ["2099-02-10", "2099-02-17"], extra: { price_groups: [
    { dates: ["2099-02-10"], label: "Шинэ жил", adult_price: 2_500_000, child_price: 2_000_000 },
    { dates: ["2099-02-17"], adult_price: 2_000_000, child_price: 1_500_000 },
  ] } });
  const reply = "✈️ НОРВЕЛ\n2/10:\nБагц: Шинэ жил\n• Том хүн: 2,500,000₮\n\n2/17:\n• Том хүн: 2,000,000₮";
  assert.equal(verifyTripReply({ reply, trips: [trip], now: NOW }), reply);
});
