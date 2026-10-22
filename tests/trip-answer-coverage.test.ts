import assert from "node:assert/strict";
import test from "node:test";
import { buildTripAnswerPlan } from "../src/lib/tripAnswerPlan";
import { buildTripAnswerRuntime } from "../src/lib/tripAnswerRuntime";
import { verifyTripReply } from "../src/lib/tripReplyVerification";
import type { FastPathRoute } from "../src/lib/fastPathRouting";
import type { TravelTrip } from "../src/lib/travelTypes";

const NOW = new Date("2098-02-01T04:00:00Z");
const route = (selection?: FastPathRoute["selection"]): FastPathRoute => ({ chosenTripId: "velmor", matchText: "", scopedClarify: null, selection });
function trip(fields: Partial<TravelTrip> = {}): TravelTrip {
  return { id: "velmor", route_name: "Вэлмор аялал", category: "", operator_name: "Invented", duration_text: "5 өдөр",
    adult_price: 1_700_000, child_price: null, infant_price: null, currency: "MNT", departure_dates: ["2098-03-17"],
    seats_total: null, seats_left: null, has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
    extra: {}, created_at: "", updated_at: "", ...fields };
}
const plan = (text: string, value = trip()) => buildTripAnswerPlan({ text, trips: [value], route: route(), now: NOW })!;

test("one missing requested topic makes a composite request a terminal handoff", () => {
  const result = plan("Вэлмор аялал үнэ, виз, зураг явуулна уу", trip({ photo_urls: ["https://example.test/velmor.jpg"] }));
  assert.equal(result.status, "handoff");
  assert.equal(result.reply, "REFER");
  assert.ok(result.answeredTopics.includes("price"));
  assert.ok(!result.answeredTopics.includes("booking_terms"));
  assert.ok(result.missingTopics.includes("booking_terms"));
  assert.deepEqual(result.missingFacts, ["booking_terms.visa"]);
  assert.deepEqual(result.mediaUrls, []);
  assert.equal(result.brochureUrl, null);
});

test("a partially known inclusion topic identifies its missing requested subfield", () => {
  const result = plan("Вэлмор аялал хоол болон даатгал үнэд багтсан уу", trip({ has_food: true }));
  assert.equal(result.status, "handoff");
  assert.equal(result.reply, "REFER");
  assert.deepEqual(result.answeredTopics, []);
  assert.deepEqual(result.missingTopics, ["includes"]);
  assert.deepEqual(result.missingFacts, ["includes.Даатгал"]);
});

test("a partially known booking topic identifies each missing term without a deflection", () => {
  const result = plan("Вэлмор аялал виз болон урьдчилгаа ямар вэ", trip({ extra: { booking_terms: { visa: "Виз шаардлагагүй." } } }));
  assert.equal(result.status, "handoff");
  assert.equal(result.reply, "REFER");
  assert.deepEqual(result.answeredTopics, []);
  assert.deepEqual(result.missingTopics, ["booking_terms"]);
  assert.deepEqual(result.missingFacts, ["booking_terms.deposit"]);
});

test("an unknown seat answer cannot be relabelled as a supported schedule answer", () => {
  const result = plan("Вэлмор аялал суудал байна уу");
  assert.equal(result.status, "handoff");
  assert.deepEqual(result.missingFacts, ["availability.seats"]);
  assert.deepEqual(result.answeredTopics, []);
  assert.equal(result.reply, "REFER");
  const price = plan("Вэлмор аялал 2098-03-17 үнэ хэд вэ");
  assert.equal(price.status, "answered", "a price question does not require an unasked seat count");
  assert.match(price.reply, /1,700,000₮/);
  assert.doesNotMatch(price.reply, /зөвлөхөөс|суудал/);
  assert.deepEqual(price.missingFacts, []);
});

test("an add-on question cannot preempt a fare or claim a missing mandatory policy was answered", () => {
  const result = plan("Вэлмор аялал үнэ хэд вэ, нэмэлт үзвэрийг заавал үзэх үү", trip({ extra: {
    itinerary_days: [{ day: 2, description: "Нэмэлт: Шилэн цамхаг: 127 нэгж/хүн" }],
  } }));
  assert.equal(result.status, "handoff");
  assert.equal(result.reply, "REFER");
  assert.ok(!result.answeredTopics.includes("price"));
  assert.deepEqual(result.missingFacts, ["extras.mandatory"]);
});

test("weather source failure remains a terminal plan with the missing fact identified", async () => {
  const input = { text: "Вэлмор аялал 2098-03-17 үнэ болон цаг агаар", trips: [trip()], route: route(), now: NOW };
  for (const source of [async () => null, async () => { throw new Error("fixture weather unavailable"); }]) {
    const result = await buildTripAnswerRuntime(input, source);
    assert.equal(result?.status, "handoff");
    assert.equal(result?.reply, "REFER");
    assert.deepEqual(result?.missingFacts, ["weather.report"]);
    assert.ok(result?.answeredTopics.includes("price"));
  }
});

test("known negative facts answer the request and pass numeric verification", () => {
  const negative = plan("Вэлмор аялал хоол болон даатгал үнэд багтсан уу", trip({ has_food: false, extra: { excluded_items: ["Даатгал"] } }));
  assert.equal(negative.status, "answered");
  assert.match(negative.reply, /Хоол: багтаагүй/);
  assert.match(negative.reply, /Үнэд багтаагүй:[\s\S]*Даатгал/);
  assert.deepEqual(negative.missingFacts, []);
  const value = trip({ seats_left: 0 });
  const closed = plan("Вэлмор аялал 2098-03-17 суудал байна уу", value);
  assert.equal(closed.status, "answered");
  assert.match(closed.reply, /суудал дүүрсэн/);
  assert.deepEqual(closed.missingFacts, []);
  assert.equal(verifyTripReply({ reply: closed.reply, trips: [value], selection: closed.selection, now: NOW }), closed.reply);
});

test("complete requests and real selections have no missing coverage", () => {
  const value = trip({ seats_left: 8, hotel: "Hotel Nerith", extra: { transport_type: "direct_flight" } });
  const complete = plan("Вэлмор аялал 2098-03-17 үнэ, буудал, хэдэн хоног вэ", value);
  assert.equal(complete.status, "answered");
  assert.deepEqual(complete.missingTopics, []);
  assert.deepEqual(complete.missingFacts, []);
  assert.equal(verifyTripReply({ reply: complete.reply, trips: [value], selection: complete.selection, now: NOW }), complete.reply);
  const hotels = trip({ extra: { price_groups: [
    { dates: ["2098-03-17"], hotel: "Hotel Velmor", adult_price: 1_700_000 },
    { dates: ["2098-03-17"], hotel: "Hotel Nerith", adult_price: 1_900_000 },
  ] } });
  const clarify = plan("Вэлмор аялал 2098-03-17 2 том хүн нийт хэд вэ", hotels);
  assert.equal(clarify.status, "clarify");
  assert.match(clarify.reply, /Аль буудлын/);
  assert.deepEqual(clarify.missingTopics, []);
  assert.deepEqual(clarify.missingFacts, []);
});
