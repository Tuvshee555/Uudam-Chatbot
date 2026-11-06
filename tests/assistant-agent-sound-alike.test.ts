import assert from "node:assert/strict";
import test from "node:test";
import { soundAlikeTrips, soundSkeleton } from "../src/lib/assistantAgent/fuzzyTripSearch";
import type { TravelTrip } from "../src/lib/travelTypes";

// Invented trips shaped like the catalogue: names typed the way they sound must find their trip.
const trip = (id: string, route_name: string, aliases: string[] = [], status = "active"): TravelTrip => ({
  id, route_name, status, category: "Аялал", operator_name: "Туршилт", duration_text: "", adult_price: null, child_price: null, infant_price: null,
  currency: "MNT", departure_dates: [], seats_total: null, seats_left: null, has_food: null, notes: "", hotel: "", source_description: "",
  photo_urls: [], created_at: "", updated_at: "", extra: { aliases },
} as unknown as TravelTrip);

const TRIPS = [
  trip("t-velmor", "Велмор – Жухай – Тавлин арал", ["Жухай", "Zhuhai", "Тавлин арал"], "archived"),
  trip("t-tavlaar-1", "ТАВЛААР НОРВЕЛЫН АЯЛАЛ"),
  trip("t-tavlaar-2", "ТАВЛААР САРНАЙН АЯЛАЛ"),
  trip("t-other", "АЛТАРА ДАЛАЙН АЯЛАЛ"),
];

test("one sound skeleton for both scripts and the usual spellings", () => {
  assert.equal(soundSkeleton("Жухай"), soundSkeleton("chuhai"));
  assert.equal(soundSkeleton("Жухай"), soundSkeleton("Чухай"));
  assert.equal(soundSkeleton("Zhuhai"), soundSkeleton("Жухай"));
});

test("a name typed by sound in Latin letters finds its trip first, even archived, ahead of a one-word near-miss", () => {
  const found = soundAlikeTrips("tavlan chuhai aylal iin nerin ard", TRIPS);
  assert.equal(found[0]?.trip.id, "t-velmor", JSON.stringify(found.map((entry) => [entry.trip.id, entry.matched])));
  assert.equal(found[0].matched, 2);
  // The same in the model's own Cyrillic guess.
  assert.equal(soundAlikeTrips("Тавлан Чухай", TRIPS)[0]?.trip.id, "t-velmor");
});

test("generic words alone find nothing", () => {
  assert.deepEqual(soundAlikeTrips("aylal iin nerin ard bich", TRIPS), []);
});
