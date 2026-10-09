import assert from "node:assert/strict";
import test from "node:test";
import { applyWebsiteDetailsPatch, mergeWebsiteContent, websiteDetailsPatch } from "../src/lib/websiteTripDetails";
import { websiteTripPatch, websiteTripToCanonicalFields } from "../src/lib/websiteTripBridge";
import { applyTestEnv } from "./helpers/env";

test("database timestamp serialization preserves milliseconds for stale-save checks", async () => {
  applyTestEnv();
  const { mapTripRow } = await import("../src/lib/travelDb");
  const timestamp = new Date("2026-10-05T10:30:12.456Z");
  const row = mapTripRow({ id: "safe-trip", created_at: timestamp, updated_at: timestamp });
  assert.equal(row.updated_at, timestamp.toISOString());
  assert.equal(row.created_at, timestamp.toISOString());
});

const website = { sourceTripId: "safe-trip", title: "Trip", description: "Original", summary: "Summary", durationDays: 3, durationNights: 2, price: 2_000_000, isPublished: true, departures: [], sourceMetadata: { connectedSource: { extra: { aliases: ["Keep alias"] } } } };
const canonical = () => ({ ...websiteTripToCanonicalFields(website).fields, seats_left: 10, seats_total: 20, source_description: "original.pdf", extra: { ...websiteTripToCanonicalFields(website).fields.extra, aliases: ["New alias"] } });

test("a description-only website edit does not replay stale fares, seats or aliases", () => {
  const before = canonical();
  const patch = websiteTripPatch({ ...website, description: "Edited" }, website, before);
  assert.deepEqual(patch, { notes: "Edited" });
  assert.equal(before.source_description, "original.pdf");
});
test("both independently changed descriptions remain available for review", () => {
  const current = { ...canonical(), notes: "Chatbot edit" };
  const patch = websiteTripPatch({ ...website, description: "Website edit" }, website, current);
  assert.equal(patch.notes, undefined);
  assert.deepEqual(patch.extra?.shared_conflicts, [{ field: "notes", chatbot: "Chatbot edit", website: "Website edit", base: "Original" }]);
  assert.equal(current.notes, "Chatbot edit");
});
test("retrying an accepted website edit is idempotent", () => {
  const patch = websiteTripPatch({ ...website, description: "Edited" }, website, { ...canonical(), notes: "Edited" });
  assert.equal(patch.notes, "Edited");
  assert.equal(patch.extra?.shared_conflicts, undefined);
});

test("generated itinerary photos and empty optional fields do not block a website reorder", () => {
  const days = [{ id: "one", title: "First", meals: ["Breakfast"], image: "https://example.com/generated.jpg" }, { id: "two", title: "Second", meals: [] }];
  const old = { ...website, itinerary: days };
  const current = { ...canonical(), extra: { itinerary_days: [{ day: 1, title: "First", meals: { breakfast: true } }, { day: 2, title: "Second", meals: {} }] } };
  const patch = websiteTripPatch({ ...old, itinerary: [days[1], days[0]] }, old, current);
  const result = patch.extra?.itinerary_days as Record<string, unknown>[];
  assert.equal(result[0].title, "Second");
  assert.equal(result[1].title, "First");
  assert.equal(result[1].photo, undefined);
  assert.equal(patch.extra?.shared_conflicts, undefined);
});
test("rich conflicting passenger fares are not silently deduplicated", () => {
  const groups = [{ passenger_prices: [{ label: "Child", age_range: "2-6", price: 1_000_000 }, { label: "Child", age_range: "2-6", price: 1_500_000 }] }];
  const fields = websiteTripToCanonicalFields({ ...website, sourceMetadata: { price_groups: groups } }).fields;
  assert.deepEqual(fields.extra?.price_groups, groups);
});
test("shared content updates only unchanged fields and retains each conflict", () => {
  const base = { description: "Old", hotel: "Hotel A", price: 1_000_000 };
  const current = { ...base, description: "Website version", price: 1_100_000 };
  const result = mergeWebsiteContent(current, base, { description: "Chatbot version", hotel: "Hotel B", price: 1_200_000 });
  assert.deepEqual(result.data, { hotel: "Hotel B" });
  assert.equal(result.conflicts.length, 2);
  assert.deepEqual(current, { ...base, description: "Website version", price: 1_100_000 });
});
test("canonical projection replaces an older website representation", () => {
  const base = { description: "Old" };
  const result = mergeWebsiteContent({ description: "Website version" }, base, { description: "Canonical version" }, { preferIncoming: true });
  assert.deepEqual(result, { data: { description: "Canonical version" }, conflicts: [] });
});
test("website extras edit only changed keys, including clearing an existing list", () => {
  const before = { requirements: "Passport", videos: ["https://example.com/a.mp4"], country: "Mongolia" };
  const patch = websiteDetailsPatch(before, { ...before, videos: [] });
  assert.deepEqual(patch.values, { videos: [] });
  assert.deepEqual(applyWebsiteDetailsPatch(before, patch).data, { videos: [] });
});
test("a stale media edit preserves both versions rather than replacing new website media", () => {
  const old = [{ url: "https://example.com/old.jpg", caption: "Old" }];
  const current = { hotelMedia: [{ url: "https://example.com/web.jpg", caption: "Website" }] };
  const patch = { base: { hotelMedia: old }, values: { hotelMedia: [{ url: "https://example.com/bot.jpg", caption: "Chatbot" }] } };
  const result = applyWebsiteDetailsPatch(current, patch);
  assert.deepEqual(result.data, {});
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0].website, current.hotelMedia);
});
test("unknown columns and unsafe media URLs never reach website SQL", () => {
  assert.deepEqual(applyWebsiteDetailsPatch({}, { values: { id: "Other trip", weather: "bad" } }).data, {});
  assert.throws(() => applyWebsiteDetailsPatch({}, { values: { hotelMedia: [{ url: "javascript:alert(1)", caption: "" }] } }));
});

test("website numeric controls reject unsafe values and preserve unrelated legacy fields", () => {
  assert.throws(() => applyWebsiteDetailsPatch({ minTravelers: 1 }, { base: { minTravelers: 1 }, values: { minTravelers: -1 } }));
  assert.throws(() => applyWebsiteDetailsPatch({ minTravelers: 4 }, { base: { maxTravelers: null }, values: { maxTravelers: 2 } }));
  assert.throws(() => applyWebsiteDetailsPatch({}, { values: { discount: 101 } }));
  assert.deepEqual(applyWebsiteDetailsPatch({ minTravelers: 4, maxTravelers: 2 }, { base: { country: null }, values: { country: "Mongolia" } }).data, { country: "Mongolia" });
});
test("website booking-term edits carry their own base, not a stale imported snapshot", () => {
  const extra = { ...canonical().extra, booking_terms: { deposit: "30%" } };
  const input = { ...website, sourceMetadata: { canonicalExtraPatch: { base: { booking_terms: extra.booking_terms }, values: { booking_terms: { deposit: "40%" } } } } };
  assert.deepEqual(websiteTripPatch(input, website, { ...canonical(), extra }).extra?.booking_terms, { deposit: "40%" });
  const conflict = websiteTripPatch(input, website, { ...canonical(), extra: { ...extra, booking_terms: { deposit: "50%" } } });
  assert.equal(conflict.extra?.booking_terms, undefined);
  assert.equal((conflict.extra?.shared_conflicts as unknown[]).length, 1);
});
