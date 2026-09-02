import assert from "node:assert/strict";
import test from "node:test";
import { buildPosterBulkPlan } from "../src/lib/poster/bulkPlan";
import type { TravelTrip } from "../src/lib/travelTypes";

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: fields.id || "trip-1",
    category: fields.category || "",
    operator_name: fields.operator_name || "UUDAM TRAVEL AGENCY",
    route_name: fields.route_name || "Test trip",
    duration_text: fields.duration_text || "",
    adult_price: fields.adult_price ?? null,
    child_price: fields.child_price ?? null,
    currency: fields.currency || "MNT",
    departure_dates: fields.departure_dates || [],
    seats_total: fields.seats_total ?? null,
    seats_left: fields.seats_left ?? null,
    has_food: fields.has_food ?? null,
    status: fields.status || "draft",
    notes: fields.notes || "",
    hotel: fields.hotel || "",
    source_description: fields.source_description || "",
    photo_urls: fields.photo_urls || [],
    extra: fields.extra || {},
    created_at: fields.created_at || "",
    updated_at: fields.updated_at || "",
  };
}

function poster(id: string, title: string, data: Record<string, unknown> = {}, updatedAt = "") {
  return {
    id,
    title,
    source_file: `${id}.pdf`,
    data: { title, ...data },
    updated_at: updatedAt,
  };
}

test("bulk poster plan processes only the newest duplicate poster title", () => {
  const plan = buildPosterBulkPlan(
    [
      poster("poster-new", "Хайнан аялал"),
      poster("poster-old", "Хайнан аялал"),
    ],
    [],
  );

  assert.equal(plan.summary.create, 1);
  assert.equal(plan.summary.skipped, 1);
  assert.equal(plan.items[0].action, "create");
  assert.equal(plan.items[1].reasonCode, "duplicate_poster_title");
});

test("bulk poster plan chooses newest duplicate by saved time, not input order", () => {
  const plan = buildPosterBulkPlan(
    [
      poster("poster-old", "Хайнан аялал", {}, "2026-01-01T00:00:00.000Z"),
      poster("poster-new", "Хайнан аялал", {}, "2026-02-01T00:00:00.000Z"),
    ],
    [],
  );

  assert.equal(plan.summary.create, 1);
  assert.equal(plan.summary.skipped, 1);
  assert.equal(plan.items[0].posterId, "poster-new");
  assert.equal(plan.items[0].action, "create");
  assert.equal(plan.items[1].posterId, "poster-old");
  assert.equal(plan.items[1].reasonCode, "duplicate_poster_title");
});

test("bulk poster plan skips exact catalog trips that already have photos", () => {
  const plan = buildPosterBulkPlan(
    [poster("poster-1", "Хайнан")],
    [trip({ id: "hainan", route_name: "Хайнан аялал", photo_urls: ["https://example.com/poster.jpg"] })],
  );

  assert.equal(plan.items[0].action, "skip");
  assert.equal(plan.items[0].reasonCode, "existing_trip_has_photos");
});

test("bulk poster plan attaches exact empty trip and fills only missing fields", () => {
  const plan = buildPosterBulkPlan(
    [
      poster("poster-1", "Бээжин аялал", {
        duration_days: 5,
        duration_nights: 4,
        departures: [{ date: "2026-10-01" }],
        price_table: { columns: ["Adult", "Child"], rows: [{ dates: "Oct", cells: ["2,000,000₮", "1,500,000₮"] }] },
        days: [{ hotel: "Beijing Hotel", meals: { breakfast: true } }],
      }),
    ],
    [trip({ id: "beijing", route_name: "Бээжин", adult_price: 1_900_000 })],
  );

  assert.equal(plan.items[0].action, "attach_exact");
  assert.equal(plan.items[0].targetTripId, "beijing");
  assert.deepEqual(plan.items[0].fields.departure_dates, ["2026-10-01"]);
  assert.equal(plan.items[0].fields.hotel, "Beijing Hotel");
  assert.equal(plan.items[0].fields.has_food, true);
  assert.equal(plan.items[0].fields.adult_price, undefined);
  assert.equal(plan.items[0].fields.child_price, 1_500_000);
});

test("bulk poster plan skips when multiple catalog trips have the same exact title", () => {
  const plan = buildPosterBulkPlan(
    [poster("poster-1", "Манжуур")],
    [
      trip({ id: "a", route_name: "Манжуур аялал" }),
      trip({ id: "b", route_name: "Манжуур" }),
    ],
  );

  assert.equal(plan.items[0].action, "skip");
  assert.equal(plan.items[0].reasonCode, "duplicate_trip_title");
});

test("bulk poster plan skips near matches instead of creating risky duplicates", () => {
  const plan = buildPosterBulkPlan(
    [poster("poster-1", "Бээжин Жинин")],
    [trip({ id: "near", route_name: "Бээжин Жинин онгоцтой аялал" })],
  );

  assert.equal(plan.items[0].action, "skip");
  assert.equal(plan.items[0].reasonCode, "needs_manual_match");
});
