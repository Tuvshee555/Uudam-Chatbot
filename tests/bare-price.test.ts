import test from "node:test";
import assert from "node:assert/strict";
import { buildBarePriceReply, isBarePriceMessage } from "../src/lib/travelFastPaths";
import { verifyTripReply } from "../src/lib/tripReplyVerification";
import type { TravelTrip } from "../src/lib/travelTypes";

// Invented trips only. One sells per date at two prices; the advert quotes the lower.
const NOW = new Date("2099-01-05T04:00:00Z");
const trip = (id: string, route_name: string, extra: Record<string, unknown>, more: Partial<TravelTrip> = {}): TravelTrip => ({
  id, route_name, operator_name: "Uudam", category: "", duration_text: "8 өдөр 7 шөнө",
  adult_price: 2_690_000, child_price: 2_390_000, infant_price: null, currency: "MNT",
  departure_dates: ["2099-02-10", "2099-02-17"], seats_total: null, seats_left: null,
  has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
  extra: { age_rules: { adult: "12+ нас", child: "2-11 нас" }, ...extra }, created_at: "", updated_at: "", ...more,
});
const catalog = [
  trip("dated", "ЗАНДАН ДАЛАЙН АЯЛАЛ", { price_groups: [
    { dates: ["2099-02-10"], adult_price: 2_690_000, child_price: 2_390_000 },
    { dates: ["2099-02-17"], adult_price: 2_990_000, child_price: 2_690_000 },
  ] }),
  trip("other", "ХАРСАЙ УУЛЫН АЯЛАЛ", {}, { adult_price: 3_990_000, child_price: 3_490_000 }),
];

test("a message that is only a price, as pasted from an advert, is recognised", () => {
  for (const text of ["2,690,000", "2690000", "2,690,000₮", "2.69 сая", "2 сая 690", "2,690,000 аялал"]) assert.ok(isBarePriceMessage(text), text);
  for (const text of ["Зандан 2,690,000", "10/15", "2 хүн 2,690,000", "2,690,000 шилжүүлсэн"]) assert.ok(!isBarePriceMessage(text), text);
});

test("a pasted price lists the trips that sell at exactly that price, and the bot accepts its own answer", () => {
  const reply = buildBarePriceReply("2,690,000", catalog)!;
  assert.match(reply, /2,690,000₮ үнэтэй тохирох аяллууд/);
  assert.match(reply, /ЗАНДАН ДАЛАЙН АЯЛАЛ — Том хүн/);
  assert.doesNotMatch(reply, /ХАРСАЙ/);
  assert.equal(verifyTripReply({ reply, trips: catalog, now: NOW }), reply);
});

test("a number no trip sells at changes nothing", () => {
  assert.equal(buildBarePriceReply("99168432", catalog), null);
  assert.equal(buildBarePriceReply("1,234,567", catalog), null);
});
