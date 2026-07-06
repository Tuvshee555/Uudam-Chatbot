import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";

applyTestEnv();

async function loadMatcher() {
  const { matchImportItemToTrips } = await import(
    "../src/lib/tripPhotoImport/match"
  );
  return { matchImportItemToTrips };
}

async function loadPreviewHelpers() {
  const { mergeMatchedImageItems } = await import(
    "../src/pages/api/admin/trip-photos-preview"
  );
  return { mergeMatchedImageItems };
}

function makeTrip(id: string, routeName: string, aliases: string[] = []): TravelTrip {
  return {
    id,
    category: "test",
    operator_name: "UUDAM TRAVEL AGENCY",
    route_name: routeName,
    duration_text: "",
    adult_price: null,
    child_price: null,
    currency: "MNT",
    departure_dates: [],
    seats_total: null,
    seats_left: null,
    has_food: null,
    status: "active",
    notes: "",
    hotel: "",
    source_description: "",
    photo_urls: [],
    extra: { aliases },
    created_at: "",
    updated_at: "",
  };
}

describe("tripPhotoImport preview grouping", () => {
  it("groups separate image uploads matched to the same trip", async () => {
    const { mergeMatchedImageItems } = await loadPreviewHelpers();
    const match = {
      tripId: "trip-1",
      tripName: "Shared trip",
      confidence: "medium" as const,
      score: 0.72,
      matchedBy: "fuzzy" as const,
      reason: "same trip",
    };
    const items = mergeMatchedImageItems([
      {
        id: "item-a",
        name: "photo-a.jpg",
        sourceType: "image",
        images: [
          {
            id: "img-a",
            fileName: "photo-a.jpg",
            originalName: "photo-a.jpg",
            mimeType: "image/jpeg",
            size: 1,
            buffer: Buffer.from("a"),
            sha256: "a",
          },
        ],
        imageCount: 1,
        match,
        duplicateImageIds: [],
        duplicateTripItemIds: [],
      },
      {
        id: "item-b",
        name: "photo-b.jpg",
        sourceType: "image",
        images: [
          {
            id: "img-b",
            fileName: "photo-b.jpg",
            originalName: "photo-b.jpg",
            mimeType: "image/jpeg",
            size: 1,
            buffer: Buffer.from("b"),
            sha256: "b",
          },
        ],
        imageCount: 1,
        match,
        duplicateImageIds: [],
        duplicateTripItemIds: [],
      },
    ]);

    assert.equal(items.length, 1);
    assert.equal(items[0].id, "item-a");
    assert.equal(items[0].name, "Shared trip");
    assert.equal(items[0].imageCount, 2);
    assert.deepEqual(items[0].images.map((image) => image.id), ["img-a", "img-b"]);
  });
});

describe("tripPhotoImport match", () => {
  it("exactly matches normalized route name", async () => {
    const { matchImportItemToTrips } = await loadMatcher();
    const trips = [makeTrip("trip-1", "ШАР ТЭНГИС БУЮУ БЭЙДАЙХЭ-БЭЭЖИНГИЙН ГАЗРЫН АЯЛАЛ")];
    const match = matchImportItemToTrips(
      "ШАР ТЭНГИС БУЮУ БЭЙДАЙХЭ-БЭЭЖИНГИЙН ГАЗРЫН АЯЛАЛ.zip",
      trips,
    );
    assert.equal(match.tripId, "trip-1");
    assert.equal(match.matchedBy, "exact");
  });

  it("matches via alias", async () => {
    const { matchImportItemToTrips } = await loadMatcher();
    const trips = [makeTrip("trip-2", "Датан Утай", ["Датун Утай", "УБ-Датун-Утай"])];
    const match = matchImportItemToTrips("УБ-Датун-Утай.zip", trips);
    assert.equal(match.tripId, "trip-2");
    assert.equal(match.matchedBy, "exact");
  });

  it("fuzzy matches similar names", async () => {
    const { matchImportItemToTrips } = await loadMatcher();
    const trips = [makeTrip("trip-3", "Бээжин-Шанхай нислэгтэй аялал")];
    const match = matchImportItemToTrips("Бээжин Шанхай.zip", trips);
    assert.equal(match.tripId, "trip-3");
    assert.equal(match.matchedBy, "exact");
  });

  it("returns none for unrelated names", async () => {
    const { matchImportItemToTrips } = await loadMatcher();
    const trips = [makeTrip("trip-4", "Бангкок аялал")];
    const match = matchImportItemToTrips("Токио.zip", trips);
    assert.equal(match.tripId, null);
    assert.equal(match.matchedBy, "none");
  });
});
