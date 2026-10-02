import assert from "node:assert/strict";
import test from "node:test";
import { withBookableDepartureDates } from "../src/lib/departureAvailability";
import { buildDateQuestionReply, buildDepartureUnavailableReply, buildStructuredTripReply, buildSeatsReply } from "../src/lib/travelFastPaths";
import { joinContextAndTurn } from "../src/lib/customerTurn";
import type { TravelTrip } from "../src/lib/travelTypes";

const trip: TravelTrip = {
  id: "hainan", category: "Аялал", operator_name: "Uudam", route_name: "ХАЙНАН САНЬЯА АЯЛАЛ",
  duration_text: "9 өдөр", adult_price: 2690000, child_price: null, infant_price: null, currency: "MNT",
  departure_dates: ["2027-10-08", "2027-10-15"], seats_total: null, seats_left: null,
  has_food: true, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
  created_at: "", updated_at: "", extra: { website_departure_availability: [
    { date: "2027-10-08", status: "SOLD_OUT", seatsLeft: 0 },
    { date: "2027-10-15", status: "OPEN", seatsLeft: 40 },
  ] },
};

test("one full departure leaves the trip active and only the other date bookable", () => {
  const result = withBookableDepartureDates(trip, new Date("2027-10-01"));
  assert.equal(result.status, "active");
  assert.deepEqual(result.departure_dates, ["2027-10-15"]);
  assert.deepEqual(trip.departure_dates, ["2027-10-08", "2027-10-15"]);
});

test("date-specific price and seat questions explain full status and suggest another date", () => {
  const result = withBookableDepartureDates(trip, new Date("2027-10-01"));
  for (const builder of [buildDepartureUnavailableReply, buildStructuredTripReply, buildSeatsReply]) {
    const reply = builder("ХАЙНАН САНЬЯА 10 сарын 8 үнэ хэд вэ", [result]);
    assert.match(reply || "", /2027-10-08 — Суудал дүүрсэн/);
    assert.match(reply || "", /Нээлттэй гарах өдрүүд: 2027-10-15/);
  }
  assert.equal(buildDepartureUnavailableReply("ХАЙНАН САНЬЯА 10 сарын 15 үнэ", [result]), null);
  assert.equal(buildDepartureUnavailableReply("ХАЙНАН САНЬЯА 2028-10-08 үнэ", [result]), null);
  assert.match(buildDateQuestionReply("10 сарын 8 байна уу", trip.route_name, [result]) || "", /Суудал дүүрсэн/);
});

test("old reply context with a full date does not override the customer's new date", () => {
  const text = joinContextAndTurn("ХАЙНАН САНЬЯА 10 сарын 8 суудал дүүрсэн", "10 сарын 15 байна уу");
  assert.equal(buildDepartureUnavailableReply(text, [trip]), null);
});

test("all future departures full closes the customer trip; reopening restores it", () => {
  const full = { ...trip, extra: { website_departure_availability: [
    { date: "2027-10-08", status: "SOLD_OUT", seatsLeft: 0 },
    { date: "2027-10-15", status: "SOLD_OUT", seatsLeft: 0 },
  ] } };
  assert.equal(withBookableDepartureDates(full, new Date("2027-10-01")).status, "sold_out");
  assert.deepEqual(withBookableDepartureDates(full, new Date("2027-10-01")).departure_dates, []);
  assert.equal(withBookableDepartureDates(trip, new Date("2027-10-01")).status, "active");
});
