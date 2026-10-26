import assert from "node:assert/strict";
import test from "node:test";
import { buildTripRequest, mergeTripSelection, requestedPassengersFromText, type TripSelection } from "../src/lib/tripRequest";
import { buildTripAnswerPlan } from "../src/lib/tripAnswerPlan";
import type { TravelTrip } from "../src/lib/travelTypes";
import { requestedDepartureScope, resolveRequestedMonth, resolveRequestedRange } from "../src/lib/travelDates";

const now = new Date("2098-02-01T04:00:00Z");
const trip: TravelTrip = {
  id: "nerith-family", route_name: "Нерит гэр бүлийн аялал", category: "", operator_name: "Invented",
  duration_text: "5 өдөр", adult_price: 731_000, child_price: 333_000, infant_price: 111_000,
  currency: "MNT", departure_dates: ["2098-03-08"], seats_total: null, seats_left: null,
  has_food: null, status: "active", hotel: "", notes: "", source_description: "", photo_urls: [],
  extra: { age_rules: { infant: "0-23 сар", child: "2-11 нас", adult: "12+ нас" } }, created_at: "", updated_at: "",
};
function previous(childCount = 1): TripSelection {
  return { tripId: trip.id, date: trip.departure_dates[0], hotel: null, package: null,
    passengers: [{ kind: "adult", count: 2 }, { kind: "child", count: childCount }] };
}
function plan(text: string, selection = previous()) {
  const answer = buildTripAnswerPlan({ text, trips: [trip], route: { chosenTripId: trip.id, matchText: "", scopedClarify: null, selection }, now });
  assert.ok(answer);
  return answer;
}

test("a teenager's age follow-up retains the adults and replaces the unaged child", () => {
  const answer = plan("13 настай хүүхэд нийт хэд вэ");
  assert.equal(answer.status, "answered");
  assert.deepEqual(answer.selection.passengers, [{ kind: "adult", count: 2 }, { kind: "adult", count: 1, age: 13 }]);
  assert.match(answer.reply, /Нийт: 2,193,000₮/);
});

test("an infant's age follow-up replaces the unaged child without adding another person", () => {
  const answer = plan("6 сартай хүүхэд нийт хэд вэ");
  assert.equal(answer.status, "answered");
  assert.deepEqual(answer.selection.passengers, [{ kind: "adult", count: 2 }, { kind: "infant", count: 1, age: 6, ageUnit: "month" }]);
  assert.match(answer.reply, /Нийт: 1,573,000₮/);
});

test("infant ages are not calendar months in shared routing or answer requests", () => {
  for (const text of ["6 сартай хүүхэд", "6сартай нярай", "нярай нь 3 сартай"]) {
    assert.equal(resolveRequestedMonth(text, now), null, text);
    assert.equal(requestedDepartureScope(text, now), null, text);
    assert.equal(buildTripRequest(text, [trip], undefined, now).month, null, text);
  }
  assert.equal(resolveRequestedMonth("4сарынх", now)?.month, 4);
  assert.equal(resolveRequestedMonth("6 сард", now)?.month, 6);
});

test("short romanized month-end spellings keep the same departure window", () => {
  for (const text of ["3sarin suuler ywahar sonirhoj baina", "3 sariin suuleer", "3 сарын сүүлээр"]) {
    assert.deepEqual(resolveRequestedRange(text, now), { startYmd: "2098-03-20", endYmd: "2098-03-31", label: "3 сарын 20–31" }, text);
    const request = buildTripRequest(text, [trip], undefined, now);
    assert.deepEqual(request.range, ["2098-03-20", "2098-03-31"], text);
  }
});

test("one supplied age leaves the remaining child's count intact", () => {
  const request = buildTripRequest("6 настай хүүхэд", [trip], undefined, now);
  const merged = mergeTripSelection(trip.id, request, previous(2));
  assert.deepEqual(merged.passengers, [{ kind: "adult", count: 2 }, { kind: "child", count: 1 }, { kind: "child", count: 1, age: 6 }]);
  assert.equal(merged.passengers.reduce((count, passenger) => count + passenger.count, 0), 4);
});

test("complete replacement parties and switching trips retain their established semantics", () => {
  const replacement = buildTripRequest("3 том хүн 2 хүүхэд", [trip], undefined, now);
  assert.deepEqual(mergeTripSelection(trip.id, replacement, previous()).passengers, [{ kind: "adult", count: 3 }, { kind: "child", count: 2 }]);
  const age = buildTripRequest("13 настай хүүхэд", [trip], undefined, now);
  assert.deepEqual(mergeTripSelection("other", age, previous()).passengers, [{ kind: "adult", count: 1, age: 13 }]);
});

test("invalid counts or ages never price a suffix or reuse the previous party", () => {
  for (const text of ["150 adults total price", "-2 adults total price", "1.5 adults total price", "-1 настай хүүхэд нийт үнэ", "125 настай хүүхэд нийт үнэ", "1,5 настай хүүхэд нийт үнэ"]) {
    assert.deepEqual(requestedPassengersFromText(text), [], text);
    const answer = plan(text);
    assert.equal(answer.status, "handoff", text);
    assert.equal(answer.reply, "REFER", text);
    assert.deepEqual(answer.missingFacts, ["price.passengers"], text);
  }
  assert.deepEqual(requestedPassengersFromText("100 adults"), [{ kind: "adult", count: 100 }]);
  assert.deepEqual(requestedPassengersFromText("2 хүүхэд 5,8 настай"), [{ kind: "child", count: 1, age: 5 }, { kind: "child", count: 1, age: 8 }]);
});

test("counted adults with adult-age details never create an extra traveler", () => {
  for (const text of ["2 adults 35 years old total price", "2 adults aged 35 years old total price", "2 том хүн 35 настай нийт үнэ", "2 adults 35 years old and 1 child 6 years old total price"]) {
    assert.deepEqual(requestedPassengersFromText(text), [], text);
    const answer = plan(text);
    assert.equal(answer.status, "handoff", text);
    assert.equal(answer.reply, "REFER", text);
    assert.deepEqual(answer.missingFacts, ["price.passengers"], text);
  }
  const child = plan("2 том хүн 13 настай хүүхэд нийт үнэ");
  assert.equal(child.status, "answered");
  assert.match(child.reply, /Нийт: 2,193,000₮/);
});

test("counted adults retain explicitly named and unlabeled young-child ages", () => {
  for (const text of ["2 том хүн, 6 настай нэг хүүхэд нийт хэд вэ?", "2 adults 6 years old one child total price"]) {
    const answer = plan(text);
    assert.equal(answer.request.unsupportedPassengerSelection, undefined, text);
    assert.equal(answer.status, "answered", text);
    assert.deepEqual(answer.selection.passengers, [{ kind: "adult", count: 2 }, { kind: "child", count: 1, age: 6 }], text);
    assert.match(answer.reply, /Нийт: 1,795,000₮/, text);
  }
  const siblings = plan("2 том хүн 5, 8 настай нийт хэд вэ?");
  assert.equal(siblings.request.unsupportedPassengerSelection, undefined);
  assert.equal(siblings.status, "answered");
  assert.deepEqual(siblings.selection.passengers, [{ kind: "adult", count: 2 }, { kind: "child", count: 1, age: 5 }, { kind: "child", count: 1, age: 8 }]);
  assert.match(siblings.reply, /Нийт: 2,128,000₮/);
});

test("infant age details refine the infant slot before an unaged child slot", () => {
  const selection = previous();
  selection.passengers.push({ kind: "infant", count: 1 });
  const merged = mergeTripSelection(trip.id, buildTripRequest("6 сартай нярай", [trip], undefined, now), selection);
  assert.deepEqual(merged.passengers, [{ kind: "adult", count: 2 }, { kind: "child", count: 1 }, { kind: "infant", count: 1, age: 6, ageUnit: "month" }]);
});

test("an explicitly adult age never fills a child's pending age slot", () => {
  const request = buildTripRequest("40 настай том хүн үнэ", [trip], undefined, now);
  assert.equal(request.passengerAgeFollowup, undefined);
  const merged = mergeTripSelection(trip.id, request, previous());
  assert.deepEqual(merged.passengers, [{ kind: "adult", count: 1, age: 40 }]);
});
