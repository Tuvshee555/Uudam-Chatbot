import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";

let mod: typeof import("../src/lib/adReferral");
before(async () => { applyTestEnv(); mod = await import("../src/lib/adReferral"); });

function trip(id: string, route_name: string): TravelTrip {
  return { id, category: "", operator_name: "Invented", route_name, duration_text: "5 өдөр", adult_price: 1_000_000, child_price: null,
    infant_price: null, currency: "MNT", departure_dates: ["2026-12-17"], seats_total: null, seats_left: null, has_food: null,
    status: "active", notes: "", hotel: "", source_description: "", photo_urls: [], extra: {}, created_at: "", updated_at: "" };
}
const CATALOG = [trip("a", "Вэлмор нуурын аялал"), trip("b", "Тармиз Кардан аялал")];

test("the referral is found on the event, the message or the postback", () => {
  const referral = { source: "ADS", type: "OPEN_THREAD", ad_id: "1", ads_context_data: { ad_title: "Вэлмор" } };
  assert.deepEqual(mod.pickReferral({ referral, message: { text: "1" } }), referral);
  assert.deepEqual(mod.pickReferral({ message: { text: "1", referral } }), referral);
  assert.deepEqual(mod.pickReferral({ postback: { payload: "GET_STARTED", referral } }), referral);
  assert.equal(mod.pickReferral({ message: { text: "1" } }), null);
});

test("an ad names a trip only when its text clearly matches exactly one", () => {
  assert.equal(mod.tripFromAdText("🌍 #Вэлмор нуурын аялал 🎯 Аяллын хөтөлбөр, үнэ", CATALOG)?.id, "a");
  assert.equal(mod.tripFromAdText("Сайхан амралт", CATALOG), null);
  assert.equal(mod.tripFromAdText("", CATALOG), null);
});

test("the website's chat button ref (the trip's website slug or id) names the trip exactly", () => {
  const withSlug = [{ ...CATALOG[0], extra: { website_slug: "velmor-nuur" } }, { ...CATALOG[1], extra: { website_slug: "trip-0123abcd" } }];
  assert.equal(mod.tripFromRef("trip-0123abcd", withSlug)?.id, "b");
  assert.equal(mod.tripFromRef("VELMOR-NUUR", withSlug)?.id, "a");
  assert.equal(mod.tripFromRef("a", withSlug)?.id, "a");
  assert.equal(mod.tripFromRef("unknown-slug", withSlug), null);
  assert.equal(mod.tripFromRef(undefined, withSlug), null);
});
