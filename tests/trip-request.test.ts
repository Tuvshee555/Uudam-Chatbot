import assert from "node:assert/strict";
import test from "node:test";
import { buildTripRequest, mergeTripSelection, parseRequestedPassengers, requestedPassengersFromText } from "../src/lib/tripRequest";
import type { TravelTrip } from "../src/lib/travelTypes";
import { tripMatchesRequestedDuration } from "../src/lib/travelFastPathsSearch";

const now = new Date("2026-10-02T04:00:00Z");

test("one request preserves prices, dates, hotel and passenger questions together", () => {
  const request = buildTripRequest("10 сарын 8-нд 2 том хүн, 5, 8 настай хүүхдүүд, буудал, нийт үнэ хэд вэ?", [], undefined, now);
  assert.equal(request.date, "2026-10-08");
  assert.ok(request.topics.includes("price"));
  assert.ok(request.topics.includes("availability"));
  assert.ok(request.topics.includes("hotel"));
  assert.deepEqual(request.passengers, [{ kind: "adult", count: 2 }, { kind: "child", count: 1, age: 5 }, { kind: "child", count: 1, age: 8 }]);
});

test("a hotel star requirement never becomes a passenger age or duration", () => {
  const request = buildTripRequest("4 одтой буудал уу 5 одтой юу", [], undefined, now);
  assert.deepEqual(request.passengers, []);
  assert.equal(request.days, null);
  assert.ok(request.topics.includes("hotel"));
});

test("offer selection is retained across follow-ups and reset on a different trip", () => {
  const previous = { tripId: "one", date: "2026-10-08", hotel: "Hotel Lumi", package: "program", passengers: [{ kind: "adult" as const, count: 2 }] };
  const request = buildTripRequest("үнэ хэд вэ", [], undefined, now);
  assert.deepEqual(mergeTripSelection("one", request, previous), previous);
  assert.deepEqual(mergeTripSelection("two", request, previous), { tripId: "two", date: null, hotel: null, package: null, passengers: [] });
});

test("invalid passenger counts and ages cannot enter pricing", () => {
  assert.deepEqual(parseRequestedPassengers([{ kind: "child", count: 1, age: -1 }, { kind: "adult", count: 0 }, { kind: "adult", count: 1000000 }]), []);
  assert.deepEqual(requestedPassengersFromText("2 том хүн 3 хүүхэд"), [{ kind: "adult", count: 2 }, { kind: "child", count: 3 }]);
});

test("a nearby duration is an alternative rather than an exact match", () => {
  const trip = { duration_text: "7 өдөр 6 шөнө", extra: {} } as TravelTrip;
  assert.equal(tripMatchesRequestedDuration(trip, [5, 6]), false);
  assert.equal(tripMatchesRequestedDuration(trip, [6, 7]), true);
});

test("infant months and ambiguous comma ages are not silently converted into years", () => {
  assert.deepEqual(requestedPassengersFromText("6 сартай нярай"), [{ kind: "infant", count: 1, age: 6, ageUnit: "month" }]);
  assert.deepEqual(requestedPassengersFromText("1,5 настай хүүхэд"), []);
  assert.deepEqual(requestedPassengersFromText("2 хүүхэд 5,8 настай"), [{ kind: "child", count: 1, age: 5 }, { kind: "child", count: 1, age: 8 }]);
});

test("a child-age follow-up does not drop the adults already supplied", () => {
  const previous = { tripId: "one", date: "2026-10-08", hotel: null, package: null, passengers: [{ kind: "adult" as const, count: 2 }, { kind: "child" as const, count: 1 }] };
  const request = buildTripRequest("6 настай хүүхэд", [], undefined, now);
  const selection = mergeTripSelection("one", request, previous);
  assert.deepEqual(selection.passengers, [{ kind: "adult", count: 2 }, { kind: "child", count: 1, age: 6 }]);
});
