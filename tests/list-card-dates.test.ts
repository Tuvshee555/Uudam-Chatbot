import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";
import { formatTripListCard } from "../src/lib/travelFastPathsPricing";
import { shortDate } from "../src/lib/tripFareBlock";
import { presentAssistantReply, withoutBrokenValues } from "../src/lib/chatbotReplyPolicy";

// Live 2026-10-30: every list holding a weekly-schedule trip showed "📅 undefined/undefined".
const now = new Date("2098-02-01T04:00:00Z");
const trip = (id: string, name: string, dates: string[]) => ({
  id, route_name: name, operator_name: "Fixture agency", category: "Аялал", adult_price: 1_591_000, child_price: 1_391_000, infant_price: null,
  currency: "MNT", status: "active", duration_text: "8 өдөр 7 шөнө", departure_dates: dates, seats_total: 20, seats_left: 10,
  has_food: null, hotel: "", photo_urls: [], notes: "", source_description: "", extra: { customer_visible: true, aliases: ["Вэлмор"] },
} as unknown as FixtureTrip);

test("a weekly schedule prints as written; real departure dates keep their month/day form", () => {
  assert.match(formatTripListCard(1, trip("w", "ВЭЛМОР ДӨРВӨН ХОТЫН АЯЛАЛ", []), { dates: ["Ням гараг бүр"] }, now), /^📅 Ням гараг бүр$/m);
  assert.match(formatTripListCard(2, trip("d", "ВЭЛМОР НУУРЫН АЯЛАЛ", []), { dates: ["2098-03-08", "2098-03-22"] }, now), /^📅 3\/8, 3\/22$/m);
  assert.match(formatTripListCard(3, trip("m", "ВЭЛМОР ХОЛИМОГ АЯЛАЛ", []), { dates: ["2098-03-08", "Ням гараг бүр"] }, now), /^📅 3\/8, Ням гараг бүр$/m);
  assert.equal(shortDate("Ням гараг бүр", now), "Ням гараг бүр");
  assert.equal(shortDate("2098-03-08", now), "3/8");
  assert.equal(shortDate("2099-06-01", now), "2099.6.1", "a date over a year away keeps its year");
});

test("no customer reply carries a leaked undefined, null, NaN or invalid date", () => {
  assert.equal(withoutBrokenValues("1. ВЭЛМОР\n📅 undefined/undefined\n💰 Том хүн 1,591,000₮"), "1. ВЭЛМОР\n💰 Том хүн 1,591,000₮");
  for (const broken of ["Үнэ: null", "📅 NaN/NaN", "Гарах: Invalid Date"]) assert.equal(withoutBrokenValues(`ВЭЛМОР\n${broken}`), "ВЭЛМОР");
  assert.equal(withoutBrokenValues("📅 undefined/undefined"), "REFER", "nothing left: a silent staff hand-off, never a broken message");
  assert.equal(withoutBrokenValues("Хөтөлбөр: https://example.invalid/trip/null-x"), "Хөтөлбөр: https://example.invalid/trip/null-x", "links are left alone");
  assert.equal(presentAssistantReply({ userText: "Вэлмор", reply: "Аяллууд:\n\n1. ВЭЛМОР\n📅 undefined/undefined" }), "Аяллууд:\n\n1. ВЭЛМОР");
});

test("the webhook's trip list shows a weekly schedule and real dates, never undefined", async (context) => {
  const harness = await conversationGateHarness(context);
  try {
    harness.catalog([trip("weekly", "ВЭЛМОР ДӨРВӨН ХОТЫН АЯЛАЛ", ["Ням гараг бүр"]), trip("dated", "ВЭЛМОР НУУРЫН АЯЛАЛ", ["2098-03-08", "2098-03-22"])]);
    const bothTrips = { certainty: "several", trips: ["T1", "T2"], intent: "catalog" };
    const reply = (await harness.turn("weekly-list", "Вэлмор", bothTrips)).sends[0]?.text || "";
    assert.match(reply, /ВЭЛМОР ДӨРВӨН ХОТЫН АЯЛАЛ/);
    assert.match(reply, /Ням гараг бүр/);
    assert.match(reply, /3\/8, 3\/22/);
    assert.doesNotMatch(reply, /undefined|null|NaN|Invalid Date/);
  } finally {
    await harness.close();
  }
});
