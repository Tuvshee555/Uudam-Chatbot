import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";

// Shape of 32 real conversations (2026-09-16 → 11-03): the bot answers a trip question,
// the customer taps Messenger's 👍, and the bot replied "Файл хүлээн авлаа." — the like
// sticker arrives as an image plus a second non-image entry, so it read as a file upload
// and was also sent to the vision model. A sticker is a reaction: kept for staff, no reply.
const trip = {
  id: "sticker-t0", route_name: "ВЭЛМОР ЛУМИР АЯЛАЛ", operator_name: "Fixture agency", category: "Аялал",
  adult_price: 1_731_000, child_price: 1_531_000, infant_price: null, currency: "MNT", status: "active",
  duration_text: "8 өдөр", departure_dates: ["2098-03-17"], seats_total: 24, seats_left: 12, has_food: null,
  hotel: "Орин буудал", photo_urls: [], notes: "", source_description: "",
  extra: { aliases: ["ВЭЛМОР"], customer_visible: true },
} as unknown as FixtureTrip;

const STICKER_URL = "https://cdn.example.test/v/t39.1997-6/fixture_like_sticker_n.png";

function stickerDelivery(senderId: string, mid: string, message: Record<string, unknown>) {
  return { object: "page", entry: [{ id: "1234567890", time: Date.now(), messaging: [{
    sender: { id: senderId }, recipient: { id: "1234567890" }, timestamp: Date.now(),
    message: { mid, ...message } }] }] };
}

test("sticker reactions are recorded for staff and never answered", async context => {
  const harness = await conversationGateHarness(context);
  harness.catalog([trip]);
  try {
    await context.test("a 👍 after a trip answer gets no 'file received' reply", async () => {
      const id = "sticker-customer-like";
      const answer = await harness.turn(id, `${trip.route_name} үнэ хэд вэ`, { tripId: trip.id, place: trip.route_name });
      assert.equal(answer.sends.length, 1, "the trip question itself is answered");
      const like = await harness.rawDelivery(stickerDelivery(id, "mid-sticker-like-1", {
        sticker_id: 369_000_000_000_001,
        attachments: [
          { type: "image", payload: { url: STICKER_URL, sticker_id: 369_000_000_000_001 } },
          { type: "sticker", payload: { url: STICKER_URL, sticker_id: 369_000_000_000_001 } },
        ],
      }));
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(like.status, 200);
      assert.deepEqual(like.sends, [], "a thumbs-up is not a file and not a question");
      const row = harness.history.filter(entry => entry.sender_id === id && entry.role === "user").at(-1);
      assert.equal(row?.text, "[Хэрэглэгч стикер илгээсэн]", "staff still see the reaction in the inbox");
    });

    await context.test("a sticker recognised only by its CDN path (image + file entries) stays silent", async () => {
      const id = "sticker-customer-cdn";
      const like = await harness.rawDelivery(stickerDelivery(id, "mid-sticker-cdn-1", {
        attachments: [
          { type: "image", payload: { url: STICKER_URL } },
          { type: "file", payload: { url: STICKER_URL } },
        ],
      }));
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(like.status, 200);
      assert.deepEqual(like.sends, []);
      assert.equal(harness.history.filter(entry => entry.sender_id === id && entry.role === "user").at(-1)?.text,
        "[Хэрэглэгч стикер илгээсэн]");
    });
  } finally {
    await harness.close();
  }
});
