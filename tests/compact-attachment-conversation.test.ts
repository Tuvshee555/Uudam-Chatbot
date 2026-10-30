import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";

const trip: FixtureTrip = {
  id: "nuvora-poster", route_name: "НУВОРА НУУРЫН АЯЛАЛ", category: "Аялал", operator_name: "Invented",
  duration_text: "5 өдөр 4 шөнө", adult_price: 609_000, child_price: 309_000, infant_price: null,
  currency: "MNT", departure_dates: ["2098-03-08"], seats_total: null, seats_left: null,
  has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
  extra: {}, created_at: "", updated_at: "",
};

test("a resolved poster queues a compact identification and keeps its trip for the typed date", async context => {
  const harness = await conversationGateHarness(context);
  try {
    harness.catalog([trip, { ...trip, id: "other-poster", route_name: "ТАРУНА ОЙН АЯЛАЛ", adult_price: 819_000 }]);
    const { buildMatchedTripReply } = await import("../src/lib/webhookAttachments");
    const { enqueueAttachmentReply } = await import("../src/pages/api/webhook");
    const { appendMessage } = await import("../src/lib/conversation");
    const { addActiveConversation, deleteActiveConversation } = await import("../src/lib/webhookDedup");
    const senderId = "poster-date-followup";
    const key = `instagram:gate-page:${senderId}`;
    await appendMessage(senderId, "user", "[Хэрэглэгч зураг илгээсэн]");
    const reply = await buildMatchedTripReply([{ category: "trip_screenshot", extracted_json: {
      trip_match: { id: trip.id, route_name: trip.route_name },
    } }]);
    assert.equal(reply?.tripId, trip.id);
    addActiveConversation(key);
    await enqueueAttachmentReply({ platform: "instagram", senderId, pageId: "gate-page", token: "fixture-token" }, reply!);
    assert.equal(harness.history.filter(row => row.sender_id === senderId && row.role === "assistant").length, 0, "document processing respects an active text turn");
    deleteActiveConversation(key);
    const answered = await harness.turn(senderId, "3 сарын 8 үнэ", { tripId: trip.id });
    assert.equal(answered.sends.length, 2);
    assert.match(answered.sends[0].text, /НУВОРА НУУРЫН АЯЛАЛ\nАль өдөр явах вэ\?/);
    assert.doesNotMatch(answered.sends[0].text, /₮|http|Хугацаа/);
    assert.match(answered.sends[1].text, /609,000₮/);
    assert.doesNotMatch(answered.sends[1].text, /ТАРУНА|819,000/);
    assert.equal(answered.selection?.tripId, trip.id);
    assert.equal(answered.selection?.date, "2098-03-08");
    assert.equal(answered.leads.length, 0);
  } finally { await harness.close(); }
});

test("a stale screenshot match cannot invent a canonical trip or send its OCR facts", async context => {
  const harness = await conversationGateHarness(context);
  try {
    harness.catalog([trip]);
    const { buildMatchedTripReply } = await import("../src/lib/webhookAttachments");
    const { enqueueAttachmentReply } = await import("../src/pages/api/webhook");
    const reply = await buildMatchedTripReply([{ category: "trip_screenshot", extracted_json: {
      trip_match: { id: "deleted-trip", route_name: trip.route_name },
    } }]);
    assert.equal(reply?.reply, "REFER");
    await enqueueAttachmentReply({ platform: "instagram", senderId: "stale-poster", pageId: "gate-page", token: "fixture-token" }, reply!);
    assert.equal(harness.history.filter(row => row.sender_id === "stale-poster" && row.role === "assistant").length, 0);
    assert.equal(harness.leads.filter(lead => lead.sender_id === "stale-poster").length, 1);
  } finally { await harness.close(); }
});

test("a fact without a trip title still requires customer evidence for its plan's trip", async context => {
  const harness = await conversationGateHarness(context);
  try {
    const other = { ...trip, id: "untitled-wrong-trip", route_name: "ТАРУНА ОЙН АЯЛАЛ", adult_price: 819_000 };
    harness.catalog([trip, other]);
    const { answerPlanHasCustomerEvidence } = await import("../src/pages/api/webhook");
    const context = { customerText: "үнэ", history: [], trips: [trip, other], routedTripIds: [other.id] };
    assert.equal(answerPlanHasCustomerEvidence(other.id, context), false, "a model-selected ID cannot authorize its own unlabelled fare");
    assert.equal(answerPlanHasCustomerEvidence(other.id, { ...context, selectionTripId: trip.id }), false);
    assert.equal(answerPlanHasCustomerEvidence(trip.id, { ...context, selectionTripId: trip.id }), true);
    const corrected = await harness.turn("untitled-mismatch", "НУВОРА НУУРЫН АЯЛАЛ үнэ", { tripId: other.id, place: other.route_name });
    assert.match(corrected.sends[0]?.text || "", /609,000₮/, "explicit customer identity wins over the model's proposed trip");
    const accepted = await harness.turn("untitled-correct", "НУВОРА НУУРЫН АЯЛАЛ үнэ", { tripId: trip.id, place: trip.route_name });
    assert.equal(accepted.sends.length, 1);
    assert.match(accepted.sends[0].text, /609,000₮/);
    assert.doesNotMatch(accepted.sends[0].text, /819,000₮/);
  } finally { await harness.close(); }
});

test("a stated date is kept when asking about a direct-flight trip's seats", async context => {
  const harness = await conversationGateHarness(context);
  try {
    const flight = { ...trip, id: "nuvora-direct", route_name: "НУВОРА ШУУД НИСЛЭГТЭЙ АЯЛАЛ",
      departure_dates: ["2098-03-08", "2098-03-15"], seats_left: 5 };
    harness.catalog([flight]);
    const answered = await harness.turn("dated-seat-request", "НУВОРА шууд нислэгтэй 3 сарын 8 суудал байна уу", { tripId: flight.id });
    assert.equal(answered.sends.length, 1);
    assert.doesNotMatch(answered.sends[0].text, /Аль гарах өдрөөр|Аль өдөр/);
    assert.equal(answered.selection?.date, "2098-03-08");
  } finally { await harness.close(); }
});
