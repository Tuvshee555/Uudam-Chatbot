import assert from "node:assert/strict";
import test from "node:test";
import { resolveTripFromUserMessage, tripIdentityName } from "../src/lib/travelFastPathsSearch";
import type { TravelTrip } from "../src/lib/travelTypes";

/**
 * Live 2026-11-11: a trip title carried a staff instruction ("<places> - ХАМТ ОЛНЫ ЗАХИАЛГА - <date>-с өмнөх
 * өдрүүдэд хамт олны захиалга авна"). Its everyday words made "Хоёулаа явна", "Найзуудтайгаа хамт явах аялал"
 * and "Онгоцны билетээ өөрсдөө авна" pick that trip. Invented trips only.
 */
const trip = (id: string, name: string, aliases: string[] = []) => ({
  id, route_name: name, operator_name: "x", category: "Аялал", adult_price: 1_000_000, child_price: null, infant_price: null, currency: "MNT",
  status: "active", duration_text: "8 өдөр", departure_dates: ["2098-03-01"], seats_total: 20, seats_left: 10, has_food: null, hotel: "",
  photo_urls: [], notes: "", source_description: "", extra: { customer_visible: true, aliases },
}) as unknown as TravelTrip;

const noted = trip("noted", "Калдор – Вэлмор – Лунариа арал - ХАМТ ОЛНЫ ЗАХИАЛГА - 2098-12-15-с өмнөх өдрүүдэд хамт олны захиалга авна", ["Калдор", "Лунариа арал"]);
const trips = [noted, trip("city", "НОРВЕЛ ХОТЫН АЯЛАЛ", ["Норвел"])];

test("a staff instruction written into a trip title is not the trip's name", () => {
  assert.equal(tripIdentityName(noted.route_name), "Калдор – Вэлмор – Лунариа арал");
  assert.equal(tripIdentityName("ПЕКАРА - ЖИРОН - ЭРМЕН 4 ХОТЫН АЯЛАЛ"), "ПЕКАРА - ЖИРОН - ЭРМЕН 4 ХОТЫН АЯЛАЛ", "an ordinary dashed title is kept whole");
  for (const text of ["Хоёулаа явна", "Найзуудтайгаа хамт явах аялал", "Онгоцны билетээ өөрсдөө авна", "Амралтын өдрүүдээр"]) {
    const result = resolveTripFromUserMessage(text, trips, { allowLooseFallback: false });
    assert.notEqual(result.status === "verified" ? result.trip?.id : null, "noted", text);
    if (result.status === "ambiguous") assert.ok(!result.candidates.some((candidate) => candidate.id === "noted"), text);
  }
  // The places in the title still name it.
  for (const text of ["Лунариа арал аялал", "Калдор Вэлмор аяллын үнэ"]) {
    const result = resolveTripFromUserMessage(text, trips, { allowLooseFallback: false });
    assert.ok(result.status === "verified" ? result.trip?.id === "noted" : result.status === "ambiguous" && result.candidates.some((c) => c.id === "noted"), text);
  }
});
