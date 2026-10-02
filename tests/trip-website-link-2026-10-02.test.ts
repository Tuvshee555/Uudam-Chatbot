/**
 * 2026-10-02: the owner wants the live booking-website page sent instead of
 * the PDF file — a link stays current (price, dates, photos) while a sent
 * PDF is frozen the moment it goes out. Trip names here are invented.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { getTripWebsiteLink } from "../src/lib/travelFastPathsSearch";
import { buildTripProgramReply } from "../src/lib/travelFastPathsProgram";
import type { TravelTrip } from "../src/lib/travelOps";

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "trip-1", category: "Аялал", operator_name: "Uudam Travel", route_name: "Вэлмор – Кардан аялал",
    duration_text: "8 өдөр 7 шөнө", adult_price: 1_100_000, child_price: 900_000, infant_price: 100_000,
    currency: "MNT", departure_dates: ["6 сарын 27"], seats_total: null, seats_left: null, has_food: true,
    status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
    extra: { poster_trip_id: "poster-1", source_file_attachment_id: "999" },
    created_at: "", updated_at: "", ...fields,
  };
}

test("getTripWebsiteLink only returns a link for a real, published website slug", () => {
  assert.equal(getTripWebsiteLink(trip({})), null);
  assert.equal(
    getTripWebsiteLink(trip({ extra: { website_slug: "trip-0123456789abcdef0123", website_published: true } })),
    null,
    "a hash-fallback slug (never renamed by staff) is not a real link yet",
  );
  assert.equal(
    getTripWebsiteLink(trip({ extra: { website_slug: "velmor-kardan-ayalal", website_published: false } })),
    null,
    "unpublished on the website — never send a link that 404s",
  );
  assert.equal(
    getTripWebsiteLink(trip({ extra: { website_slug: "velmor-kardan-ayalal", website_published: true } })),
    "https://uudamtravel.mn/trips/velmor-kardan-ayalal",
  );
});

test("a program/PDF request sends the website link instead of the PDF when one exists", () => {
  const t = trip({ extra: {
    poster_trip_id: "poster-1", source_file_attachment_id: "999",
    website_slug: "velmor-kardan-ayalal", website_published: true,
  } });
  const result = buildTripProgramReply("Хөтөлбөр үзэх", [t]);
  assert.ok(result);
  assert.match(result!.reply, /https:\/\/uudamtravel\.mn\/trips\/velmor-kardan-ayalal/);
  assert.doesNotMatch(result!.reply, /PDF.*хавсаргалаа/);
  // No file attachment is sent when the reply already carries the link.
  assert.equal(result!.brochure, null);
});

test("a picture-only request also prefers the website link over the PDF", () => {
  const t = trip({ extra: {
    poster_trip_id: "poster-1", source_file_attachment_id: "999",
    website_slug: "velmor-kardan-ayalal", website_published: true,
  } });
  const result = buildTripProgramReply("зураг явуулаач", [t]);
  assert.ok(result);
  assert.match(result!.reply, /uudamtravel\.mn\/trips\/velmor-kardan-ayalal/);
  assert.equal(result!.brochure, null);
  assert.equal(result!.mediaUrls.length, 0);
});

test("a trip not yet on the website still sends its PDF — no link available", () => {
  const t = trip({ extra: { poster_trip_id: "poster-1", source_file_attachment_id: "999" } });
  const result = buildTripProgramReply("Хөтөлбөр үзэх", [t]);
  assert.ok(result);
  assert.match(result!.reply, /PDF.*хавсаргалаа/);
  assert.ok(result!.brochure);
});
