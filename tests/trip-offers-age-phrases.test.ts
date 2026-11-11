import test from "node:test";
import assert from "node:assert/strict";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";

applyTestEnv();

// Invented trip. "12-оос дээш нас" / "12-оос доош нас" / "2-оос доош нас" is how most partner pages write ages;
// unread, every fare got "invalid_age_band" and the whole fare card became a contradiction (no price quoted).
const NOW = new Date("2099-01-05T04:00:00Z");
function trip(ages: Record<string, string>): TravelTrip {
  return {
    id: "trip-age-phrases", route_name: "НОРВЕЛ", operator_name: "", category: "", duration_text: "5 өдөр", adult_price: 2_000_000,
    child_price: 1_500_000, infant_price: 0, currency: "MNT", departure_dates: ["2099-02-10"], seats_total: null, seats_left: null,
    has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [], created_at: "", updated_at: "",
    extra: { age_rules: ages },
  } as TravelTrip;
}

test("ages written with the ablative ending are read; the fare card quotes the trip", async () => {
  const { normalizeTripOffers, resolveTripOfferFareCard } = await import("../src/lib/tripOffers");
  const ages = { adult: "12-оос дээш нас", child: "12-оос доош нас", infant: "2-оос доош нас" };
  const fares = normalizeTripOffers(trip(ages), NOW).flatMap((offer) => offer.fares);
  assert.deepEqual(fares.flatMap((fare) => fare.issues), []);
  const card = resolveTripOfferFareCard(trip(ages), { date: "2099-02-10" }, NOW);
  assert.equal(card.status, "ready", JSON.stringify(card));
  for (const ending of ["ээс", "аас", "өөс"]) {
    const other = normalizeTripOffers(trip({ adult: `18-${ending} дээш нас`, child: "", infant: "" }), NOW).flatMap((offer) => offer.fares);
    assert.deepEqual(other.flatMap((fare) => fare.issues), [], ending);
  }
});
