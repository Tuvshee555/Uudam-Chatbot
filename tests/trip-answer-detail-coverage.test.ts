import assert from "node:assert/strict";
import test from "node:test";
import { replyPreferences } from "../src/lib/chatbotReplyPolicy";
import { buildTripAnswerPlan } from "../src/lib/tripAnswerPlan";
import { decideTripAnswer } from "../src/lib/tripAnswerDecision";
import type { TravelTrip } from "../src/lib/travelTypes";

const now = new Date("2098-02-01T04:00:00Z");
function trip(fields: Partial<TravelTrip> = {}): TravelTrip {
  return { id: "velmor", route_name: "Вэлмор аялал", category: "", operator_name: "Invented", duration_text: "5 өдөр",
    adult_price: 1_700_000, child_price: null, infant_price: null, currency: "MNT", departure_dates: ["2098-03-17"],
    seats_total: null, seats_left: null, has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
    extra: {}, created_at: "", updated_at: "", ...fields };
}
function answer(text: string, value = trip()) {
  const plan = buildTripAnswerPlan({ text, trips: [value], route: { chosenTripId: value.id, matchText: "", scopedClarify: null }, now });
  assert.ok(plan);
  return { plan, decision: decideTripAnswer(plan, { userText: text }) };
}

test("detail broadens display without erasing explicitly requested fact targets", () => {
  const preferences = replyPreferences("хүүхдийн үнэ, виз, хоол, даатгал дэлгэрэнгүй");
  assert.equal(preferences.full, true);
  assert.deepEqual(preferences.fareKinds, []);
  assert.deepEqual(preferences.termKeys, []);
  assert.deepEqual(preferences.includes, []);
  assert.deepEqual(preferences.requiredFareKinds, ["child"]);
  assert.deepEqual(preferences.requiredTermKeys, ["visa"]);
  assert.deepEqual(preferences.requiredIncludes.map(target => target.label), ["Хоол", "Даатгал", "Виз"]);
});

test("detail never hides missing requested insurance behind a known meal inclusion", () => {
  for (const suffix of ["", " дэлгэрэнгүй", " бүтэн", " full", " detailed"]) {
    const { plan, decision } = answer(`Вэлмор аялал хоол болон даатгал үнэд багтсан уу${suffix}`, trip({ extra: { included_items: ["Хоол"] } }));
    assert.equal(decision.outcome, "handoff", suffix);
    assert.equal(plan.reply, "REFER");
    assert.deepEqual(plan.missingFacts, ["includes.Даатгал"]);
  }
});

test("supported inclusions retain detailed display and typed food fallback", () => {
  const { plan, decision } = answer("Вэлмор аялал хоол болон даатгал үнэд багтсан уу дэлгэрэнгүй", trip({ has_food: false,
    extra: { included_items: ["Тийз"], excluded_items: ["Даатгал"] } }));
  assert.equal(decision.outcome, "answered");
  assert.deepEqual(plan.missingFacts, []);
  assert.match(decision.reply, /Тийз/);
  assert.match(decision.reply, /Үнэд багтаагүй:[\s\S]*Даатгал/);
  assert.match(decision.reply, /Хоол: багтаагүй/);
});

test("a detailed known visa answer does not require unasked booking terms", () => {
  const { plan, decision } = answer("Вэлмор аялал виз дэлгэрэнгүй", trip({ extra: { booking_terms: { visa: "Виз шаардлагагүй.", payment: "Төлбөрийн баталгааг шалгана." } } }));
  assert.equal(decision.outcome, "answered");
  assert.deepEqual(plan.missingFacts, []);
  assert.match(decision.reply, /Виз: Виз шаардлагагүй/);
  assert.match(decision.reply, /Төлбөр: Төлбөрийн баталгааг шалгана/);
});

test("a detailed composite term request still requires every explicitly requested term", () => {
  const { plan, decision } = answer("Вэлмор аялал виз болон урьдчилгаа дэлгэрэнгүй", trip({ extra: { booking_terms: { visa: "Виз шаардлагагүй." } } }));
  assert.equal(decision.outcome, "handoff");
  assert.deepEqual(plan.missingFacts, ["booking_terms.deposit"]);
});

test("a known adult fare cannot complete an unknown requested child fare with detail wording", () => {
  for (const text of ["Вэлмор аялал хүүхдийн үнэ", "Вэлмор аялал хүүхдийн үнэ дэлгэрэнгүй", "Вэлмор аялал том хүн болон хүүхдийн үнэ"]) {
    const { plan, decision } = answer(text);
    assert.equal(decision.outcome, "handoff", text);
    assert.deepEqual(plan.missingFacts, ["price.child"]);
  }
  const { plan, decision } = answer("Вэлмор аялал хүүхдийн үнэ дэлгэрэнгүй", trip({ child_price: 1_200_000 }));
  assert.equal(decision.outcome, "answered");
  assert.deepEqual(plan.missingFacts, []);
  assert.match(decision.reply, /Том хүн: 1,700,000₮/);
  assert.match(decision.reply, /Хүүхэд: 1,200,000₮/);
});

test("fare previews never use an adult-only card to answer an unknown child fare", () => {
  for (const value of [trip({ departure_dates: ["2098-03-17", "2098-03-22"] }), trip({ extra: { price_groups: [
    { dates: ["2098-03-17"], hotel: "Hotel Nerith", adult_price: 1_700_000 },
    { dates: ["2098-03-17"], hotel: "Hotel Kelvor", adult_price: 1_900_000 },
  ] } })]) {
    const { plan, decision } = answer("Вэлмор аялал хүүхдийн үнэ дэлгэрэнгүй", value);
    assert.equal(decision.outcome, "clarify");
    assert.doesNotMatch(plan.reply, /Том хүн:|₮/);
  }
});

test("an adult party cannot hide a separate unknown child-fare request", () => {
  for (const text of ["Вэлмор аялал 2 том хүн болон хүүхдийн үнэ дэлгэрэнгүй", "Вэлмор аялал 40 настай том хүн болон хүүхдийн үнэ дэлгэрэнгүй"]) {
    const { plan, decision } = answer(text);
    assert.equal(decision.outcome, "handoff", text);
    assert.deepEqual(plan.missingFacts, ["price.child"]);
  }
});

test("the customer's age-qualified older child still uses the resolved adult fare", () => {
  for (const text of ["Вэлмор аялал 2 том хүн 13 настай хүүхэд нийт үнэ дэлгэрэнгүй", "Вэлмор аялал 2 том хүн хүүхэд нь 13 настай нийт үнэ дэлгэрэнгүй"]) {
    const { plan, decision } = answer(text);
    assert.equal(decision.outcome, "answered", text);
    assert.deepEqual(plan.missingFacts, []);
    assert.match(decision.reply, /Нийт: 5,100,000₮/);
  }
});
