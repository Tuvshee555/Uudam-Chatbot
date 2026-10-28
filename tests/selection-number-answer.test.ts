import assert from "node:assert/strict";
import test from "node:test";
import { optionChosenByNumber, selectionOptions } from "../src/lib/selectionAnswer";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";

const hotelQuestion = ["ВЭЛМОР НУУРЫН АЯЛАЛ", "Аль буудлын хувилбарыг сонгох вэ?", "• Lumen Lodge", "• Sable Lodge"].join("\n");

test("a bulleted selection question lists its options without the 'more options' footer", () => {
  assert.deepEqual(selectionOptions(hotelQuestion), ["Lumen Lodge", "Sable Lodge"]);
  const dates = "ВЭЛМОР АЯЛАЛ Аль гарах өдрөөр аялах вэ? • 11 сарын 11 • 11 сарын 18 • Өөр 8 сонголт бий. Бүх сонголтыг хүсвэл хэлээрэй. https://example.invalid/trips/velmor";
  assert.deepEqual(selectionOptions(dates), ["11 сарын 11", "11 сарын 18"], "a collapsed single-line reply reads the same");
  assert.deepEqual(selectionOptions("Энэ чиглэлээр хэд хэдэн сонголт байна 😊\n• ВЭЛМОР А\n• ВЭЛМОР Б\nАль аяллыг нь сонирхож байна вэ?"), [], "a trip menu has its own numbering");
});

test("a bare number picks the matching option of the bot's last selection question", () => {
  const history = [{ role: "user", text: "Вэлмор үнэ" }, { role: "assistant", text: hotelQuestion }];
  for (const [text, option] of [["1", "Lumen Lodge"], ["2", "Sable Lodge"], ["2.", "Sable Lodge"], ["1-р", "Lumen Lodge"], [" 2) ", "Sable Lodge"]] as const) {
    assert.equal(optionChosenByNumber(history, text), option, text);
  }
  assert.equal(optionChosenByNumber(history, "3"), null, "past the last option");
  assert.equal(optionChosenByNumber(history, "2 том хүн"), null, "a number with words is a passenger count");
  assert.equal(optionChosenByNumber(history, "Sable Lodge"), null);
  assert.equal(optionChosenByNumber([{ role: "assistant", text: "Сайн байна уу!" }], "1"), null, "no selection question, no option");
  assert.equal(optionChosenByNumber([], "1"), null);
});

const trip: FixtureTrip = {
  id: "velmor-lake", route_name: "ВЭЛМОР НУУРЫН АЯЛАЛ", category: "Аялал", operator_name: "Invented", duration_text: "5 өдөр 4 шөнө",
  adult_price: 901_000, child_price: 401_000, infant_price: null, currency: "MNT", departure_dates: ["2098-03-08"],
  seats_total: null, seats_left: null, has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
  extra: { price_groups: [
    { dates: ["2098-03-08"], hotel: "Lumen Lodge", adult_price: 901_000, child_price: 401_000 },
    { dates: ["2098-03-08"], hotel: "Sable Lodge", adult_price: 1_001_000, child_price: 501_000 },
  ] },
  created_at: "", updated_at: "",
};

test("customer answers the hotel question with '2' and gets that hotel's fare instead of silence", async (context) => {
  const harness = await conversationGateHarness(context);
  try {
    harness.catalog([trip]);
    const asked = await harness.turn("pick-by-number", "ВЭЛМОР НУУРЫН АЯЛАЛ 3 сарын 8 2 том хүн нийт үнэ хэд вэ", { tripId: trip.id, place: trip.route_name });
    assert.equal(asked.sends.length, 1);
    assert.match(asked.sends[0].text, /Аль буудлын хувилбарыг сонгох вэ\?[\s\S]*Lumen Lodge[\s\S]*Sable Lodge/);
    const leadsBefore = harness.leads.length;
    const answered = await harness.turn("pick-by-number", "2", { tripId: trip.id, place: trip.route_name });
    assert.equal(answered.sends.length, 1, "the customer gets an answer");
    assert.match(answered.sends[0].text, /2,002,000₮/, "two adults at the second hotel's fare");
    assert.doesNotMatch(answered.sends[0].text, /1,802,000₮/);
    assert.equal(harness.leads.length, leadsBefore, "no hand-off: nothing was missing");
  } finally { await harness.close(); }
});
