import assert from "node:assert/strict";
import test from "node:test";
import {
  blockingGaps,
  findTripGaps,
  formatGapLabels,
  tripCompletenessInput,
} from "../src/lib/tripCompleteness";

const complete = {
  route_name: "Жэжү арлын аялал",
  duration_text: "5 өдөр 4 шөнө",
  adult_price: 4290000,
  child_price: 4090000,
  infant_price: 590000,
  departure_dates: ["6 сарын 17-21"],
  photo_urls: ["https://example.com/1.jpg"],
  extra: {
    itinerary_days: [{ day: 1, title: "УБ - Жэжү" }],
    poster_trip_id: "poster-jeju",
  },
};

test("a fully filled trip reports no gaps", () => {
  assert.deepEqual(findTripGaps(tripCompletenessInput(complete)), []);
});

test("the commercially required fields block a save when empty", () => {
  const gaps = blockingGaps(
    findTripGaps(
      tripCompletenessInput({
        ...complete,
        adult_price: null,
        child_price: null,
        infant_price: null,
        departure_dates: [],
        photo_urls: [],
      }),
    ),
  );

  assert.deepEqual(
    gaps.map((gap) => gap.key).sort(),
    ["adult_price", "child_price", "departure_dates", "infant_price", "photo_urls"],
  );
  assert.equal(formatGapLabels(gaps), "Том хүний үнэ, Хүүхдийн үнэ, Нярайн үнэ, Гарах өдөр, Зураг");
});

test("the infant fare is its own required tier, not something child_price covers", () => {
  const gaps = blockingGaps(findTripGaps(tripCompletenessInput({ ...complete, infant_price: null })));
  assert.deepEqual(gaps.map((gap) => gap.key), ["infant_price"]);
  assert.equal(gaps[0].label, "Нярайн үнэ");
});

test("included and excluded lists are never required — staff answer that manually", () => {
  const gaps = findTripGaps(
    tripCompletenessInput({
      ...complete,
      extra: { ...complete.extra, included_items: [], excluded_items: [] },
    }),
  );
  assert.deepEqual(gaps, []);
});

test("a zero price counts as missing, not as free", () => {
  const gaps = findTripGaps(tripCompletenessInput({ ...complete, adult_price: 0 }));
  assert.ok(gaps.some((gap) => gap.key === "adult_price"));
});

test("blank strings in a list do not count as filled", () => {
  const gaps = findTripGaps(tripCompletenessInput({ ...complete, departure_dates: ["  "] }));
  assert.ok(gaps.some((gap) => gap.key === "departure_dates"));
});

test("poster-owned facts warn but never block the trip form", () => {
  const gaps = findTripGaps(
    tripCompletenessInput({
      ...complete,
      extra: { ...complete.extra, itinerary_days: [] },
    }),
  );

  assert.deepEqual(blockingGaps(gaps), []);
  assert.deepEqual(gaps.map((gap) => gap.key), ["itinerary_days"]);
});

test("a trip linked to a poster counts as having a brochure", () => {
  const withPoster = findTripGaps(tripCompletenessInput(complete));
  const withoutPoster = findTripGaps(
    tripCompletenessInput({ ...complete, extra: { ...complete.extra, poster_trip_id: "" } }),
  );

  assert.ok(!withPoster.some((gap) => gap.key === "brochure"));
  assert.ok(withoutPoster.some((gap) => gap.key === "brochure"));
});

test("photos on the poster satisfy the photo rule for a linked trip", () => {
  const emptyGallery = { ...complete, photo_urls: [] };

  assert.ok(
    findTripGaps(tripCompletenessInput(emptyGallery)).some((gap) => gap.key === "photo_urls"),
    "no photos anywhere is still a gap",
  );
  assert.ok(
    !findTripGaps(tripCompletenessInput(emptyGallery, { posterPhotoCount: 6 }))
      .some((gap) => gap.key === "photo_urls"),
    "the poster's gallery is what the website publishes",
  );
  assert.ok(
    !findTripGaps(
      tripCompletenessInput({ ...emptyGallery, extra: { ...complete.extra, poster_photo_count: 6 } }),
    ).some((gap) => gap.key === "photo_urls"),
    "the count travels on extra for the admin screens",
  );
});

test("an explicit brochure result overrides what extra suggests", () => {
  const gaps = findTripGaps(tripCompletenessInput(complete, { hasBrochure: false }));
  assert.ok(gaps.some((gap) => gap.key === "brochure" && gap.severity === "warning"));
});
