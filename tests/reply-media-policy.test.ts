import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";

applyTestEnv();
const policyModule = import("../src/lib/replyMediaPolicy");
const urls = Array.from({ length: 7 }, (_, i) => `https://example.com/photo-${i}.jpg`);
const trip: TravelTrip = {
  id: "media-trip", route_name: "Surmak Felmor", category: "Outbound", operator_name: "Uudam",
  duration_text: "5 days", adult_price: 1000, child_price: null, infant_price: null,
  currency: "MNT", departure_dates: [], seats_total: null, seats_left: null, has_food: null,
  status: "active", notes: "", hotel: "", source_description: "", photo_urls: urls,
  extra: {}, created_at: "", updated_at: "",
};

test("price and date questions cannot opt in through reply text or explicit assets", async () => {
  const { buildReplyMedia } = await policyModule;
  for (const userText of ["Surmak Felmor price?", "Surmak Felmor departure dates?", "Surmak Felmor үнэ хэд вэ?", "Surmak Felmor хэзээ гарах вэ?"]) {
    assert.deepEqual(buildReplyMedia({ userText, reply: "Surmak Felmor program photos attached.", trips: [trip], explicitMediaUrls: urls, brochureUrl: "https://example.com/program.pdf" }), { mediaUrls: [], brochureUrl: null });
  }
});

test("photos and program requests default to three images; explicit full galleries cap at five", async () => {
  const { buildReplyMedia } = await policyModule;
  for (const request of ["photos", "images", "pictures", "program", "PDF", "хөтөлбөр", "zurag", "hutulbur"]) {
    const media = buildReplyMedia({ userText: `Surmak Felmor ${request}`, reply: "Surmak Felmor is ready.", trips: [trip] });
    assert.deepEqual(media.mediaUrls, urls.slice(0, 3), request);
  }
  for (const request of ["all photos", "full gallery", "бүх зураг", "buh zurag"]) {
    assert.deepEqual(buildReplyMedia({ userText: `Surmak Felmor ${request}`, reply: "Surmak Felmor is ready.", trips: [trip] }).mediaUrls, urls.slice(0, 5), request);
  }
});

test("silent handoff and ambiguous replies suppress even explicit media", async () => {
  const { buildReplyMedia } = await policyModule;
  for (const reply of ["", "  ", "REFER", "SILENT Surmak Felmor", "NOTRIPMEDIA", "Surmak Felmor. Аль аяллыг нь сонирхож байна вэ?"]) {
    assert.deepEqual(buildReplyMedia({ userText: "Surmak Felmor photos", reply, trips: [trip], explicitMediaUrls: urls, brochureUrl: "https://example.com/program.pdf" }), { mediaUrls: [], brochureUrl: null }, reply);
  }
});

test("explicit assets are deduplicated and validated before applying the cap", async () => {
  const { buildReplyMedia } = await policyModule;
  assert.deepEqual(buildReplyMedia({ userText: "Surmak Felmor photos", reply: "Surmak Felmor", trips: [trip], explicitMediaUrls: ["https://", "http://example.com/a", urls[0], urls[0], ...urls], brochureUrl: "javascript:alert(1)" }), { mediaUrls: urls.slice(0, 3), brochureUrl: null });
});

test("brochure safety and published website preference remain available", async () => {
  const { getTripWebsiteLink } = await import("../src/lib/travelFastPathsSearch");
  const { extractTripBrochureAttachmentId } = await import("../src/lib/welcomeFlow");
  const stored = { ...trip, extra: { source_file_attachment_id: "legacy-id", website_slug: "surmak-felmor", website_published: true } };
  assert.equal(getTripWebsiteLink(stored), "https://uudamtravel.mn/trips/surmak-felmor");
  assert.equal(getTripWebsiteLink({ ...stored, extra: { ...stored.extra, website_published: false } }), null);
  assert.deepEqual(extractTripBrochureAttachmentId("Surmak Felmor program", [stored], { userText: "Surmak Felmor program" }), { type: "id", value: "legacy-id" });
});

test("album fallback counts actual successful images and failures", async (context) => {
  const { sendPhotoAlbum, sendTripMediaForReply } = await import("../src/lib/webhookMedia");
  const { getMetricsSnapshot } = await import("../src/lib/observability");
  const count = (outcome: string) => getMetricsSnapshot().counters.find((entry) => entry.name === "webhook.trip_media_delivery_total" && entry.tags.kind === "photo" && entry.tags.outcome === outcome)?.value ?? 0;
  const before = { attempted: count("attempted"), sent: count("sent"), failed: count("failed") };
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify(calls === 2 ? { message_id: "accepted" } : { error: { message: "rejected" } }), { status: calls === 2 ? 200 : 400 });
  });
  await sendPhotoAlbum("test-sender", urls.slice(0, 2), "test-token");
  assert.equal(calls, 3);
  assert.equal(count("attempted") - before.attempted, 2);
  assert.equal(count("sent") - before.sent, 1);
  assert.equal(count("failed") - before.failed, 1);
  await sendTripMediaForReply("facebook", "test-sender", "Surmak Felmor photos", "Surmak Felmor price?", "test-token", "page");
  await sendTripMediaForReply("facebook", "test-sender", "", "Surmak Felmor photos", "test-token", "page");
  assert.equal(calls, 3);
});
