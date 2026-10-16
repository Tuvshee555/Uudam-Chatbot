import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";

function trip(id: string, route_name: string): TravelTrip {
  return { id, category: "", operator_name: "Invented", route_name, duration_text: "5 өдөр", adult_price: 1_000_000, child_price: null,
    infant_price: null, currency: "MNT", departure_dates: ["2026-12-17"], seats_total: null, seats_left: null, has_food: null,
    status: "active", notes: "", hotel: "", source_description: "", photo_urls: [], extra: {}, created_at: "", updated_at: "" };
}
const PAIR = [trip("a", "Вэлмор нуурын аялал"), trip("b", "Тармиз Кардан аялал")];

test("an English first message that names no trip is asked which trip, in both languages", async () => {
  applyTestEnv();
  const { isGenericTripRequest } = await import("../src/lib/travelFastPaths");
  const { whichTripClarifyReply, WHICH_TRIP_CLARIFY_REPLY } = await import("../src/lib/reply");
  for (const text of ["Can you tell me more about your ad?", "hello, price please", "How much is the tour?", "Hi, I want more information"]) {
    assert.equal(isGenericTripRequest(text), true, text);
    assert.match(whichTripClarifyReply(text), /Which trip or destination/);
    assert.ok(whichTripClarifyReply(text).includes(WHICH_TRIP_CLARIFY_REPLY));
  }
  // A destination makes it a real question, and Mongolian stays Mongolian-only.
  assert.equal(isGenericTripRequest("Do you have a Bali tour?"), false);
  assert.equal(whichTripClarifyReply("Үнэ"), WHICH_TRIP_CLARIFY_REPLY);
});

test("'Огноо нь' right after a which-trip list lists those trips' dates", async () => {
  applyTestEnv();
  const { setClarificationState, clearClarificationState } = await import("../src/lib/clarificationState");
  const { routeFastPathText } = await import("../src/lib/fastPathRouting");
  const senderId = "dates-after-list";
  try {
    await setClarificationState(senderId, PAIR.map((t) => t.id));
    for (const text of ["Огноо нь", "хэзээ вэ?", "гарах өдөр"]) {
      const routed = await routeFastPathText({ senderId, text, contextualUserText: text, trips: PAIR,
        history: [{ role: "assistant", text: "Энэ чиглэлээр хэд хэдэн сонголт байна 😊 Аль аяллыг нь сонирхож байна вэ?" }] });
      assert.deepEqual(routed.scopedClarify?.map((t) => t.id), ["a", "b"], text);
      assert.equal(routed.informationalAlternatives, true);
      assert.match(routed.scopedClarifyNote || "", /гарах өдрүүд/);
    }
  } finally { await clearClarificationState(senderId); }
});
