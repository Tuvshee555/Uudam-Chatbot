import assert from "node:assert/strict";
import test from "node:test";
import { verifyTripReply } from "../src/lib/tripReplyVerification";
import type { TravelTrip } from "../src/lib/travelTypes";

const NOW = new Date("2026-10-02T04:00:00Z");
const TRIP: TravelTrip = {
  id: "lumi", category: "", operator_name: "Invented", route_name: "Лумиа аялал", duration_text: "5 өдөр", adult_price: 1_000_000,
  child_price: 500_000, infant_price: null, currency: "MNT", departure_dates: ["2026-12-17"], seats_total: null, seats_left: null,
  has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [], created_at: "", updated_at: "",
  extra: {
    excluded_items: ["Өрөөнд ганцаараа байрлах нэмэлт төлбөр 990,000₮"],
    itinerary_days: [{ day: 1, title: "Нисэх", description: "Лотус руу ✈ 12:00 – 16:30 нисэж 2026 оны шинэ терминалд буух" }],
  },
};
const check = (reply: string) => verifyTripReply({ reply, trips: [TRIP], now: NOW });

test("lines copied from the trip's own inclusions or program are not read as fares or departures", () => {
  const includes = "Лумиа аялал\n\nҮнэд багтаагүй:\n• Өрөөнд ганцаараа байрлах нэмэлт төлбөр 990,000₮";
  assert.equal(check(includes), includes);
  const program = "Лумиа аялал\n1-р өдөр: Нисэх — Лотус руу ✈ 12:00 – 16:30 нисэж 2026 оны шинэ терминалд буух\nГарах өдөр: 12 сарын 17";
  assert.equal(check(program), program);
  // An invented fare is still caught, even next to copied text.
  assert.equal(check(`${includes}\nТом хүн: 999,000₮`), "REFER");
});

test("links and a total that adds up are not rejected; a wrong total is", () => {
  const link = "Лумиа аялал\nТом хүн: 1,000,000₮\nhttps://example.test/api/poster-pdf?id=poster-8eb72174-9bbc-2026";
  assert.equal(check(link), link);
  const total = "Лумиа аялал\n12 сарын 17\nТом хүн x 2: 1,000,000₮\nХүүхэд x 1: 500,000₮\nНийт: 2,500,000₮";
  assert.equal(check(total), total);
  assert.equal(check(total.replace("2,500,000", "2,600,000")), "REFER");
});
