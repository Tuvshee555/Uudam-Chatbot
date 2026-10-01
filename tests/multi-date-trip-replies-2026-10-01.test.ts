/**
 * Found by replaying customer questions about a trip priced per departure
 * through the live Messenger handler. Trip names and prices are invented.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { TravelTrip } from "../src/lib/travelOps";
import { sanitizeAssistantReply } from "../src/lib/reply";
import { buildContextualUserText, isLikelyContextDependentText } from "../src/lib/contextualText";
import { buildHotelReply, isHotelQuestion } from "../src/lib/tripHotelReply";
import { buildPassengerTotalReply } from "../src/lib/passengerTotalReply";

const NOW = new Date("2026-09-30T04:00:00Z");

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "t", category: "Аялал", operator_name: "Test", route_name: "Вэлмор – Кардан аялал", duration_text: "8 өдөр 7 шөнө",
    adult_price: 1_100_000, child_price: 900_000, infant_price: 100_000, currency: "MNT", departure_dates: ["12 сарын 7", "12 сарын 21"],
    seats_total: null, seats_left: null, has_food: true, status: "active", notes: "", hotel: "", source_description: "",
    photo_urls: [], extra: {}, created_at: "", updated_at: "", ...fields,
  };
}

test("a fare repeated under a second departure heading is kept", () => {
  const card = [
    "✈️ Вэлмор – Кардан аялал", "", "12 сарын 7-ны гаралт", "• Том хүн: 1,100,000₮", "• Нярай: 100,000₮",
    "", "12 сарын 21-ны гаралт", "• Том хүн: 1,300,000₮", "• Нярай: 100,000₮",
  ].join("\n");
  const out = sanitizeAssistantReply(card);
  assert.equal((out.match(/Нярай: 100,000₮/g) || []).length, 2);
  // A sentence the model repeats in two paragraphs is still dropped once.
  const repeated = sanitizeAssistantReply("Сайн байна уу!\n\nСайн байна уу!\nӨөр асуулт байна уу?");
  assert.equal((repeated.match(/Сайн байна уу!/g) || []).length, 1);
});

test("a date price question with a conditional verb stays tied to the trip on screen", () => {
  assert.equal(isLikelyContextDependentText("1 сарын 25-нд явбал хэд вэ"), true);
  assert.equal(isLikelyContextDependentText("12 sariin 7nd yavbal hed ve"), true);
});

test("'Хөтөлбөр үзэх' under a card ending in a solo-price line still finds the trip", () => {
  const card = "✈️ Вэлмор – Кардан аялал\n💰 1 сарын 25:\n• Том хүн: 1,200,000₮\n• Ганцаараа явбал: 1,700,000₮";
  const ctx = buildContextualUserText([{ role: "assistant", text: card }], "Хөтөлбөр үзэх");
  assert.match(ctx, /Вэлмор – Кардан аялал/);
  assert.doesNotMatch(ctx.split("\n")[0], /Ганцаараа/);
});

test("a hotel question gets the hotels by itinerary day, never an airport", () => {
  const t = trip({ extra: { itinerary_days: [
    { day: 1, hotel: "Alpha Bay" }, { day: 2, hotel: "Alpha Bay" }, { day: 3, hotel: "Delta Cove" }, { day: 4, hotel: "Alpha Bay" }, { day: 5 },
  ] } });
  assert.equal(buildHotelReply(t, "ямар буудалд буудаллах вэ"),
    "🏨 Вэлмор – Кардан аялал — буудал:\n• 1-2, 4-р өдөр: Alpha Bay\n• 3-р өдөр: Delta Cove");
  assert.equal(isHotelQuestion("нисэх буудлаас хэдэн цагт гарах вэ"), false);
  assert.equal(isHotelQuestion("buudliin medeelel"), true);
});

test("a party total is given per price level, using the tier for each stated age", () => {
  const t = trip({ extra: {
    departure_dates_resolved: [{ text: "12 сарын 7", ymd: "2026-12-07" }, { text: "12 сарын 21", ymd: "2026-12-21" }],
    price_groups: [
      { dates: ["12 сарын 7"], adult_price: 1_100_000, child_price: 900_000, infant_price: 100_000,
        passenger_prices: [{ label: "Хүүхэд 6-12 нас", age_range: "6-12 нас", price: 900_000 }, { label: "Хүүхэд 2-6 нас", age_range: "2-6 нас", price: 800_000 }] },
      { dates: ["12 сарын 21"], adult_price: 1_300_000, child_price: 1_000_000, infant_price: 100_000,
        passenger_prices: [{ label: "Хүүхэд 6-12 нас", age_range: "6-12 нас", price: 1_000_000 }, { label: "Хүүхэд 2-6 нас", age_range: "2-6 нас", price: 900_000 }] },
    ],
  } });
  const reply = buildPassengerTotalReply(t, "2 том хүн 1 хүүхэд 8 настай нийт хэд болох вэ", NOW) || "";
  assert.match(reply, /12 сарын 7-ны гаралт: 3,100,000₮/);
  assert.match(reply, /12 сарын 21-ны гаралт: 3,600,000₮/);
  assert.match(reply, /Хүүхэд 8 настай \/6-12 нас\/ = 900,000₮/);
  assert.doesNotMatch(reply, /насаас хамаарна/);
});
