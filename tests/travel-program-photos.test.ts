import assert from "node:assert/strict";
import test from "node:test";
import { buildTripProgramReply } from "../src/lib/travelFastPathsProgram";
import type { TravelTrip } from "../src/lib/travelTypes";

function trip(overrides: Partial<TravelTrip>): TravelTrip {
  return {
    id: "trip-1",
    category: "direct flight",
    operator_name: "UUDAM TRAVEL AGENCY",
    route_name: "Eldor ground flight combo",
    duration_text: "9 days / 8 nights",
    adult_price: 1270000,
    child_price: 1270000,
    infant_price: null,
    currency: "MNT",
    departure_dates: ["2026-08-02", "2026-08-09"],
    seats_total: null,
    seats_left: null,
    has_food: null,
    status: "active",
    notes: "",
    hotel: "",
    source_description: "",
    photo_urls: [],
    extra: {},
    created_at: "2026-07-25T00:00:00.000Z",
    updated_at: "2026-07-25T00:00:00.000Z",
    ...overrides,
  };
}

test("photo requests send stored poster slices even when itinerary data also exists", () => {
  const photos = [
    "https://example.com/eldor-1.png",
    "https://example.com/eldor-2.png",
    "https://example.com/eldor-3.png",
  ];
  const result = buildTripProgramReply("Eldor ground flight zurag", [
    trip({
      photo_urls: photos,
      extra: {
        itinerary_days: [
          { day: 1, title: "UB-Eldor" },
          { day: 2, title: "Eldor city" },
        ],
      },
    }),
  ]);

  assert.deepEqual(result?.mediaUrls, photos);
  assert.match(result?.reply || "", /Eldor ground flight combo/);
  assert.doesNotMatch(result?.reply || "", /UB-Eldor|Eldor city/);
  assert.doesNotMatch(result?.reply || "", /1,270,000/);
});
