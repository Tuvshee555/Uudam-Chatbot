/**
 * A child fare told apart by height or bed (no age range) reaches the website
 * with its condition, so two such fares never read as one bare "Хүүхэд"; a band
 * listed twice is sent once. Trip name and prices are invented.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { TravelTrip } from "../src/lib/travelTypes";
import { websiteTripPayload } from "../src/lib/websiteTripPayload";
import { websiteDepartureSchedule } from "../src/lib/connectedTripMapping";

const NOW = new Date("2099-06-01T00:00:00Z");
const DATE = "2099-06-12";

function trip(passengerPrices: Array<Record<string, unknown>>): TravelTrip {
  return {
    id: "trip-condition-bands", category: "Аялал", operator_name: "Sample", route_name: "Зохиомол аялал", duration_text: "5 өдөр 4 шөнө",
    adult_price: 2_222_000, child_price: null, infant_price: null, currency: "MNT", departure_dates: [DATE],
    seats_total: null, seats_left: null, has_food: null, status: "active", notes: "", hotel: "", source_description: "",
    photo_urls: [], created_at: "", updated_at: "",
    extra: { price_groups: [{ dates: [DATE], adult_price: 2_222_000, passenger_prices: passengerPrices }] },
  };
}
const bands = (value: TravelTrip) => websiteTripPayload(value, websiteDepartureSchedule(value, NOW), NOW).priceGroups
  .flatMap((group) => group.passenger_prices);

test("height and bed child fares reach the website named by their condition, each once", () => {
  assert.deepEqual(bands(trip([
    { label: "Хүүхэд 1,2-1,4 м өндөр", age_range: "", price: 1_222_000 },
    { label: "Хүүхэд оргүй", age_range: "", price: 1_333_000 },
    // The same band twice: one band, not two counters.
    { label: "Хүүхэд оргүй", age_range: "", price: 1_333_000 },
    { label: "Нярай", age_range: "0-2 нас", price: 333_000 },
  ])), [
    { label: "Хүүхэд (1,2–1,4 м өндөр)", age_range: "", price: 1_222_000, currency: "MNT", condition: "1,2–1,4 м өндөр" },
    { label: "Хүүхэд (оргүй)", age_range: "", price: 1_333_000, currency: "MNT", condition: "оргүй" },
    { label: "Нярай 0-2 нас", age_range: "0-2 нас", price: 333_000, currency: "MNT" },
  ]);
});

test("two age bands keep their age labels and carry no condition", () => {
  assert.deepEqual(bands(trip([
    { label: "Хүүхэд", age_range: "2-5 нас", price: 1_111_000 },
    { label: "Хүүхэд", age_range: "6-11 нас", price: 1_444_000 },
  ])), [
    { label: "Хүүхэд 2-5 нас", age_range: "2-5 нас", price: 1_111_000, currency: "MNT" },
    { label: "Хүүхэд 6-11 нас", age_range: "6-11 нас", price: 1_444_000, currency: "MNT" },
  ]);
});
