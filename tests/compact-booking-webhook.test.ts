import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";

const trip: FixtureTrip = {
  id: "compact-booking-fixture", route_name: "ВЭЛМОР НУУРЫН АЯЛАЛ", category: "Аялал", operator_name: "Fixture agency",
  duration_text: "5 өдөр 4 шөнө", adult_price: 901_000, child_price: 401_000, infant_price: null,
  currency: "MNT", departure_dates: ["2098-03-08"], seats_total: null, seats_left: null, has_food: null,
  status: "active", notes: "", hotel: "", source_description: "", photo_urls: [], extra: {}, created_at: "", updated_at: "",
};

test("compact booking asks one missing detail, saves the request, and permits questions", async context => {
  const harness = await conversationGateHarness(context);
  try {
    harness.catalog([trip]);
    const start = await harness.turn("compact-book-known", `${trip.route_name} захиалга хийе`);
    assert.equal(start.sends.length, 1);
    assert.equal(start.sends[0].text, "Утасны дугаараа бичнэ үү.");
    assert.equal(start.leads.length, 0, "asking for contact does not claim a booking is received");
    const done = await harness.turn("compact-book-known", "99112233");
    assert.equal(done.leads.length, 1, "a phone alone suffices; a name is optional");
    assert.equal(done.leads[0].kind, "booking");
    assert.ok(done.leads[0].context.includes(trip.route_name), "the known trip survives without repeating it in the prompt");
    assert.ok(done.leads[0].context.includes("99112233"));
    assert.equal(done.sends.length, 1);
    assert.equal(done.sends[0].text, `${trip.route_name}\nЗахиалгын хүсэлтийг хүлээн авлаа.`);

    const unknown = await harness.turn("compact-book-unknown", "Захиалах");
    assert.equal(unknown.sends[0].text, "Утасны дугаараа бичнэ үү.");
    // The phone completes the request at once: no "Аль аялал вэ?" holding the lead back.
    const contact = await harness.turn("compact-book-unknown", "99113344");
    assert.equal(contact.leads.length, 1, "the lead is written when the phone arrives");
    assert.ok(contact.leads[0].context.includes("99113344"));
    assert.ok(contact.leads[0].context.includes("Захиалах"), "staff see what the customer wrote");
    assert.equal(contact.sends.length, 1);
    assert.equal(contact.sends[0].text, "Захиалгын хүсэлтийг хүлээн авлаа.");
    assert.doesNotMatch(contact.sends[0].text, /Аль аялал|утасны|холбогдоно|https?:/i);

    await harness.turn("compact-book-question", `${trip.route_name} захиалга хийе`);
    const question = await harness.turn("compact-book-question", `${trip.route_name} том хүн үнэ хэд вэ`, { tripId: trip.id, place: trip.route_name });
    assert.equal(question.sends.length, 1, "a question interrupts collection and receives its actual answer");
    assert.match(question.sends[0].text, /901,000₮/);
    assert.equal(question.leads.length, 0);
    assert.doesNotMatch(question.sends[0].text, /утасны дугаараа|нэрээ/i);
  } finally { await harness.close(); }
});
