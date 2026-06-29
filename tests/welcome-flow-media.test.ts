import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";

async function loadWelcomeFlow() {
  applyTestEnv();
  return import("../src/lib/welcomeFlow");
}

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "trip-1",
    category: "Outbound",
    operator_name: "Uudam Travel",
    route_name: "Tokyo Fuji",
    duration_text: "5 days",
    adult_price: 1000,
    child_price: 800,
    currency: "MNT",
    departure_dates: [],
    seats_total: null,
    seats_left: null,
    has_food: null,
    status: "active",
    notes: "",
    hotel: "",
    source_description: "",
    photo_urls: ["https://example.com/tokyo-fuji-1.jpg", "https://example.com/tokyo-fuji-2.jpg"],
    extra: {},
    created_at: "",
    updated_at: "",
    ...fields,
  };
}

test("trip media fails closed when only a shared destination token matches", async () => {
  const { extractTripPhotosForReply } = await loadWelcomeFlow();
  const photos = extractTripPhotosForReply(
    "Tokyo trip price is 1,000.",
    [
      trip({ id: "fuji", route_name: "Tokyo Fuji" }),
      trip({
        id: "universal",
        route_name: "Tokyo Universal",
        photo_urls: ["https://example.com/tokyo-universal.jpg"],
      }),
    ],
  );

  assert.deepEqual(photos, []);
});

test("trip media requires user and reply to agree before sending attachments", async () => {
  const { extractTripPhotosForReply } = await loadWelcomeFlow();
  const photos = extractTripPhotosForReply(
    "Tokyo Universal program images are ready.",
    [
      trip({ id: "fuji", route_name: "Tokyo Fuji" }),
      trip({
        id: "universal",
        route_name: "Tokyo Universal",
        photo_urls: ["https://example.com/tokyo-universal.jpg"],
      }),
    ],
    { userText: "Please send Tokyo Fuji program" },
  );

  assert.deepEqual(photos, []);
});

test("trip media sends only after the same specific trip passes both gates", async () => {
  const { extractTripPhotosForReply } = await loadWelcomeFlow();
  const photos = extractTripPhotosForReply(
    "Tokyo Fuji program images are ready.",
    [
      trip({ id: "fuji", route_name: "Tokyo Fuji" }),
      trip({
        id: "universal",
        route_name: "Tokyo Universal",
        photo_urls: ["https://example.com/tokyo-universal.jpg"],
      }),
    ],
    { userText: "Please send Tokyo Fuji program" },
  );

  assert.deepEqual(photos, [
    "https://example.com/tokyo-fuji-1.jpg",
    "https://example.com/tokyo-fuji-2.jpg",
  ]);
});

test("brochure matching also refuses mismatched user and reply trips", async () => {
  const { extractTripBrochureAttachmentId } = await loadWelcomeFlow();
  const brochure = extractTripBrochureAttachmentId(
    "Tokyo Universal PDF is ready.",
    [
      trip({
        id: "fuji",
        route_name: "Tokyo Fuji",
        extra: { brochure_pdf_url: "https://example.com/fuji.pdf" },
      }),
      trip({
        id: "universal",
        route_name: "Tokyo Universal",
        extra: { brochure_pdf_url: "https://example.com/universal.pdf" },
      }),
    ],
    { userText: "Please send Tokyo Fuji PDF" },
  );

  assert.equal(brochure, null);
});
