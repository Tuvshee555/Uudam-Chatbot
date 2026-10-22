import assert from "node:assert/strict";
import test from "node:test";
import { parseRequestedFacts, requestedFactsFromText } from "../src/lib/requestedFacts";
import { buildTripAnswerPlan } from "../src/lib/tripAnswerPlan";
import { buildTripRequest } from "../src/lib/tripRequest";
import type { TravelTrip } from "../src/lib/travelTypes";

const trip: TravelTrip = { id: "velmor", route_name: "Вэлмор аялал", category: "", operator_name: "Invented",
  duration_text: "5 өдөр", adult_price: 731_000, child_price: null, infant_price: null, currency: "MNT",
  departure_dates: ["2098-03-17"], seats_total: null, seats_left: null, has_food: true, status: "active",
  notes: "", hotel: "Лумир буудал", source_description: "", photo_urls: [], extra: {}, created_at: "", updated_at: "" };
const now = new Date("2098-02-01T00:00:00Z");

test("requested subfacts require current customer evidence and an allowed field", () => {
  assert.deepEqual(parseRequestedFacts([
    { field: "hotel.connectivity", evidence: "Wi-Fi" },
    { field: "hotel.room", evidence: "stale room question" },
    { field: "invented.field", evidence: "буудал" },
  ], "Лумир буудал Wi-Fi байна уу"), [{ field: "hotel.connectivity", evidence: "Wi-Fi" }]);
});

test("bounded property requirements survive a model omission without inventing identity", () => {
  for (const [text, field] of [
    ["Лумир буудал Wi-Fi байна уу", "hotel.connectivity"],
    ["Лумир буудал усан сан байна уу", "hotel.facilities"],
    ["Лумир буудал хэдэн одтой вэ", "hotel.rating"],
    ["Лумир буудал өрөө ямар вэ", "hotel.room"],
    ["Лумир буудал төвөөс зайтай юу", "hotel.location"],
  ]) {
    const request = buildTripRequest(text, [trip], { topics: ["hotel"] }, now);
    assert.ok(request.requestedFacts?.some(fact => fact.field === field), text);
    const plan = buildTripAnswerPlan({ text, trips: [trip], route: { chosenTripId: trip.id, matchText: text, scopedClarify: null }, now });
    assert.equal(plan?.status, "handoff", text);
    assert.equal(plan?.reply, "REFER");
    assert.ok(plan?.missingFacts.includes(field));
  }
});

test("an amenity inside a proper name does not become a property question", () => {
  const named = { ...trip, hotel: "Лумир Spa Hotel" };
  const request = buildTripRequest("Вэлмор аялал Лумир Spa Hotel үнэ хэд вэ", [named], undefined, now);
  assert.deepEqual(request.requestedFacts, []);
  assert.deepEqual(requestedFactsFromText("Вэлмор аялал үнэ хэд вэ"), []);
});

test("an unsupported subquestion prevents a broad topic or known fare from claiming completion", () => {
  const text = "Вэлмор аялал үнэ хэд вэ Лумир буудал Wi-Fi байна уу";
  const plan = buildTripAnswerPlan({ text, trips: [trip], route: { chosenTripId: trip.id, matchText: text, scopedClarify: null }, now });
  assert.equal(plan?.status, "handoff");
  assert.deepEqual(plan?.missingFacts, ["hotel.connectivity"]);
  const otherText = "Вэлмор аялал тусгай зөвшөөрөл хэрэгтэй юу";
  const request = buildTripRequest(otherText, [trip], { requestedFacts: [{ field: "other.unsupported", evidence: "тусгай зөвшөөрөл" }] }, now);
  assert.equal(request.requestedFacts?.[0].field, "other.unsupported");
});
