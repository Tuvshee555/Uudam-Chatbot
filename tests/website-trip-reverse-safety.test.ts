import assert from "node:assert/strict";
import test from "node:test";
import { WebsiteTripPayloadError, websiteTripPatch, websiteTripToCanonicalFields } from "../src/lib/websiteTripBridge";

const website = () => ({
  sourceTripId: "velmor-canonical", title: "Вэлмор аялал", description: "Эхний тайлбар", summary: "Товч тайлбар",
  durationDays: 6, durationNights: 5, currency: "MNT", price: 1_234_567, childPrice: null, infantPrice: null,
  image: "https://example.com/velmor-cover.webp", extraImages: ["https://example.com/velmor-gallery.webp"],
  included: ["Хөтөлбөрийн үйлчилгээ"], excluded: [], importantNotes: [], departureRule: "", hotel: "Вэлмор буудал",
  foodIncluded: false, isPublished: false, itinerary: [],
  departures: [{ id: "velmor-departure", startDate: "2098-03-17T00:00:00.000Z", status: "OPEN", seatsLeft: 11, price: 1_234_567 }],
  sourceMetadata: {} as Record<string, unknown>,
});
function canonical(input = website()) {
  return { id: input.sourceTripId, ...websiteTripToCanonicalFields(input).fields };
}

test("omitted website fields never become invented canonical removals or defaults", () => {
  const { fields } = websiteTripToCanonicalFields({ sourceTripId: "velmor-canonical", description: "Өөр тайлбар" });
  for (const key of ["route_name", "duration_text", "currency", "adult_price", "departure_dates", "photo_urls", "status", "extra"]) {
    assert.equal(fields[key as keyof typeof fields], undefined, key);
  }
  assert.equal(fields.notes, "Өөр тайлбар");
});

test("a partial description save preserves concurrent canonical fares, media and visibility", () => {
  const old = website();
  const current = { ...canonical(old), adult_price: 1_876_543, photo_urls: ["https://example.com/canonical.webp"],
    extra: { ...canonical(old).extra, customer_visible: true, aliases: ["Вэлморын өөр нэр"] } };
  const before = structuredClone(current);
  assert.deepEqual(websiteTripPatch({ sourceTripId: old.sourceTripId, description: "Шинэ тайлбар" }, old, current), { notes: "Шинэ тайлбар" });
  assert.deepEqual(current, before);
});

test("partial cover and duration edits retain the unchanged gallery and night count", () => {
  const old = website();
  const patch = websiteTripPatch({ sourceTripId: old.sourceTripId, image: "https://example.com/new-cover.webp", durationDays: 7 }, old, canonical(old));
  assert.deepEqual(patch.photo_urls, ["https://example.com/new-cover.webp", ...old.extraImages]);
  assert.equal(patch.duration_text, "7 өдөр 5 шөнө");
  assert.equal(patch.extra, undefined);
});

test("a fare-only patch uses the saved currency rather than assuming local currency", () => {
  const old = { ...website(), currency: "USD", price: 234.56, departures: [] };
  assert.deepEqual(websiteTripPatch({ sourceTripId: old.sourceTripId, price: 345.67 }, old, canonical(old)), { adult_price: 345.67 });
});

test("a partial departure edit retains rich hotel, package and passenger fares", () => {
  const groups = [{ label: "Вэлмор багц", hotel: "Вэлмор буудал", package_id: "velmor-package", date_keys: ["2098-03-17"],
    adult_price: 1_234_567, passenger_prices: [{ label: "Хүүхэд", age_range: "3-8 нас", price: 765_432, currency: "MNT" }] }];
  const old = { ...website(), sourceMetadata: { price_groups: groups } };
  const patch = websiteTripPatch({ sourceTripId: old.sourceTripId, departures: [{ ...old.departures[0], status: "PAUSED" }] }, old, canonical(old));
  assert.equal(patch.extra?.price_groups, undefined);
  assert.deepEqual(patch.extra?.website_departure_availability, [{ date: "2098-03-17", status: "PAUSED", seatsLeft: 11 }]);
  assert.deepEqual(canonical(old).extra?.price_groups, groups);
});

test("explicit empty lists and metadata remain intentional removals", () => {
  const old = { ...website(), sourceMetadata: { price_groups: [{ adult_price: 1_234_567 }], age_rules: { adult: "18+ нас" } } };
  const patch = websiteTripPatch({ sourceTripId: old.sourceTripId, summary: "", included: [], sourceMetadata: { price_groups: [], age_rules: {} } }, old, canonical(old));
  assert.equal(patch.extra?.website_summary, "");
  assert.deepEqual(patch.extra?.included_items, []);
  assert.deepEqual(patch.extra?.price_groups, []);
  assert.deepEqual(patch.extra?.age_rules, {});
});

test("new website age rules compare against the latest saved rules, preserving independent conflicts", () => {
  const old = { ...website(), sourceMetadata: { age_rules: { adult: "18+ нас" }, connectedSource: { extra: { age_rules: { adult: "16+ нас" } } } } };
  const incoming = { ...old, sourceMetadata: { ...old.sourceMetadata, age_rules: { adult: "19+ нас" } } };
  assert.deepEqual(websiteTripPatch(incoming, old, canonical(old)).extra?.age_rules, { adult: "19+ нас" });
  const conflict = websiteTripPatch(incoming, old, { ...canonical(old), extra: { ...canonical(old).extra, age_rules: { adult: "20+ нас" } } });
  assert.equal(conflict.extra?.age_rules, undefined);
  assert.deepEqual(conflict.extra?.shared_conflicts, [{ field: "extra.age_rules", chatbot: { adult: "20+ нас" }, website: { adult: "19+ нас" }, base: { adult: "18+ нас" } }]);
});

test("repeated accepted and conflicting deliveries are true no-op patches", () => {
  const old = website();
  const incoming = { sourceTripId: old.sourceTripId, description: "Вэбийн тайлбар" };
  assert.deepEqual(websiteTripPatch(incoming, old, { ...canonical(old), notes: incoming.description }), {});
  const current = { ...canonical(old), notes: "Чатботын тайлбар" };
  const first = websiteTripPatch(incoming, old, current);
  assert.equal((first.extra?.shared_conflicts as unknown[]).length, 1);
  assert.deepEqual(websiteTripPatch(incoming, old, { ...current, extra: { ...current.extra, ...first.extra } }), {});
});

test("snapshot identities cannot redirect a save to a different canonical trip", () => {
  const old = website();
  assert.throws(() => websiteTripPatch(old, { ...old, sourceTripId: "other-velmor" }, canonical(old)), WebsiteTripPayloadError);
  assert.throws(() => websiteTripPatch(old, old, { ...canonical(old), id: "other-velmor" }), WebsiteTripPayloadError);
  assert.throws(() => websiteTripPatch({ ...old, sourceMetadata: { connectedSource: { id: "other-velmor" } } }, old, canonical(old)), WebsiteTripPayloadError);
});

test("invalid calendar dates, departure states and numeric shapes fail closed", () => {
  const old = website();
  for (const change of [
    { departures: [{ startDate: "2098-02-30", status: "OPEN" }] },
    { departures: [{ startDate: "2098-03-17suffix", status: "OPEN" }] },
    { departures: [{ startDate: "2098-03-17", status: "UNKNOWN" }] },
    { departures: [{ startDate: "2098-03-17" }] },
    { departures: [{ startDate: "2098-03-17", status: "OPEN", seatsLeft: -1 }] },
    { departures: [old.departures[0], old.departures[0]] },
    { departures: null }, { departures: [null] }, { included: "Хөтөлбөр" }, { price: NaN }, { childPrice: -1 },
    { durationDays: 2.5 }, { isPublished: "false" }, { title: "" },
    { sourceMetadata: { canonicalExtraPatch: { values: { customer_visible: "false" } } } },
  ]) assert.throws(() => websiteTripToCanonicalFields({ ...old, ...change }), WebsiteTripPayloadError);
});

test("partial duration needs an actual saved counterpart and image-only itinerary days survive", () => {
  assert.throws(() => websiteTripToCanonicalFields({ sourceTripId: "velmor-canonical", durationDays: 4 }), WebsiteTripPayloadError);
  const fields = websiteTripToCanonicalFields({ sourceTripId: "velmor-canonical", itinerary: [
    { image: "https://example.com/itinerary.webp" }, { meals: ["Өглөө"] },
  ] }).fields;
  assert.equal((fields.extra?.itinerary_days as unknown[]).length, 2);
});

// 2026-10-30: a fare a consultant typed for one departure on the website, for a trip whose
// hotel/package pricing is richer than the website's single fare, was dropped without a trace
// and the next projection showed the trip's fare again. The rich pricing is still kept (which
// package a single fare belongs to is the owner's decision); the typed fare is now a visible
// conflict in the trip editor, beside the package fares it would contradict.
test("a departure fare typed on the website for a package-priced trip is a visible conflict, not a silent drop", () => {
  const groups = [{ label: "Вэлмор багц", hotel: "Вэлмор буудал", package_id: "velmor-package", date_keys: ["2098-03-17"], adult_price: 1_234_567 }];
  const old = { ...website(), sourceMetadata: { price_groups: groups } };
  const patch = websiteTripPatch({ sourceTripId: old.sourceTripId, departures: [{ ...old.departures[0], price: 1_111_111 }] }, old, canonical(old));
  assert.equal(patch.extra?.price_groups, undefined, "package pricing is not replaced by a single fare");
  const conflicts = (patch.extra?.shared_conflicts ?? []) as Array<Record<string, unknown>>;
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].field, "departure.2098-03-17.price");
  assert.equal(conflicts[0].website, 1_111_111);
  assert.equal(conflicts[0].base, 1_234_567);
  assert.deepEqual(conflicts[0].chatbot, [{ label: "Вэлмор багц", adult_price: 1_234_567 }]);
  // The same save again is a no-op, not a second conflict.
  const again = websiteTripPatch({ sourceTripId: old.sourceTripId, departures: [{ ...old.departures[0], price: 1_111_111 }] }, old,
    { ...canonical(old), extra: { ...canonical(old).extra, shared_conflicts: conflicts } });
  assert.equal(again.extra?.shared_conflicts, undefined);
});

test("a departure fare typed on the website for a simply priced trip becomes that date's fare", () => {
  const old = website();
  const patch = websiteTripPatch({ sourceTripId: old.sourceTripId, departures: [{ ...old.departures[0], price: 1_111_111 }] }, old, canonical(old));
  assert.deepEqual((patch.extra?.price_groups as Array<Record<string, unknown>>)?.map((group) => [group.dates, group.adult_price]), [[["2098-03-17"], 1_111_111]]);
  assert.equal(patch.extra?.shared_conflicts, undefined);
});

test("a departure fare typed for a trip without package pricing becomes that date's fare, keeping the trip's other fares", () => {
  // The projection writes an empty price_groups list into the website metadata of such trips.
  const old = { ...website(), childPrice: 834_000, sourceMetadata: { price_groups: [] } };
  const base = canonical(old as unknown as ReturnType<typeof website>);
  const typed = websiteTripPatch({ sourceTripId: old.sourceTripId, departures: [{ ...old.departures[0], price: 1_111_111 }] }, old, base);
  assert.deepEqual(typed.extra?.price_groups, [{ dates: ["2098-03-17"], adult_price: 1_111_111, child_price: 834_000, infant_price: null }]);
  assert.equal(typed.extra?.shared_conflicts, undefined, "nothing ambiguous, no conflict");
  // The trip's own fare typed again is no per-date fare at all.
  const same = websiteTripPatch({ sourceTripId: old.sourceTripId, departures: [{ ...old.departures[0], price: 1_234_567 }] }, old, base);
  assert.equal(same.extra?.price_groups, undefined);
});
