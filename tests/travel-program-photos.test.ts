import assert from "node:assert/strict";
import test from "node:test";
import { buildTripProgramReply } from "../src/lib/travelFastPathsProgram";
import type { TravelTrip } from "../src/lib/travelTypes";

function trip(overrides: Partial<TravelTrip>): TravelTrip {
  return {
    id: "trip-1",
    category: "direct flight",
    operator_name: "UUDAM TRAVEL AGENCY",
    route_name: "Chongqing ground flight combo",
    duration_text: "9 days / 8 nights",
    adult_price: 2150000,
    child_price: 2150000,
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
    "https://example.com/chongqing-1.png",
    "https://example.com/chongqing-2.png",
    "https://example.com/chongqing-3.png",
  ];
  const result = buildTripProgramReply("Chongqing ground flight zurag", [
    trip({
      photo_urls: photos,
      extra: {
        itinerary_days: [
          { day: 1, title: "UB-Chongqing" },
          { day: 2, title: "Chongqing city" },
        ],
      },
    }),
  ]);

  assert.deepEqual(result?.mediaUrls, photos);
  assert.match(result?.reply || "", /Chongqing ground flight combo/);
  assert.doesNotMatch(result?.reply || "", /UB-Chongqing|Chongqing city/);
  assert.doesNotMatch(result?.reply || "", /2,150,000/);
});
