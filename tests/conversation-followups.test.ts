import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";
import { isPassengerCountOnly } from "../src/lib/travelFastPathsPricing";
import { verifyTripReply } from "../src/lib/tripReplyVerification";

// Real failures of 2026-10-26..29, replayed on an invented catalogue: a head count under a
// list looped, a date none of the listed trips runs on went silent, and that silence paused
// the bot so the customer's next, answerable question got nothing either.
const trip = (id: string, name: string, adult: number, child: number, infant: number | null, dates: string[]) => ({
  id, route_name: name, operator_name: "Fixture agency", category: "Аялал", adult_price: adult, child_price: child, infant_price: infant,
  currency: "MNT", status: "active", duration_text: "6 өдөр 5 шөнө", departure_dates: dates, seats_total: 20, seats_left: 10,
  has_food: null, hotel: "", photo_urls: [], notes: "", source_description: "",
  extra: { aliases: ["Лумара", "lumara"], customer_visible: true, age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" } },
} as unknown as FixtureTrip);

const trips = [
  trip("lum-air", "ЛУМАРА НИСЛЭГТЭЙ АЯЛАЛ", 3_111_000, 2_511_000, 611_000, ["2098-03-15", "2098-03-20"]),
  trip("lum-land", "ЛУМАРА ГАЗРЫН АЯЛАЛ", 2_222_000, 1_822_000, 422_000, ["2098-03-18"]),
  trip("lum-combo", "ЛУМАРА + ТЭВРИН АЯЛАЛ", 3_933_000, 3_333_000, null, ["2098-03-25"]),
];
// The understanding model reads a bare destination as all of its trips.
const several = { certainty: "several", trips: ["T1", "T2", "T3"], place: "Лумара" };

test("follow-ups under a trip list are answered from the data, never looped or silenced", async (context) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(trips);
  try {
    await context.test("a head count prices every listed trip; a missing infant fare is stated, not estimated", async () => {
      assert.equal((await harness.turn("party", "Лумара", several)).sends.length, 1);
      const party = { ...several, place: null, passengers: [{ kind: "adult" as const, count: 2 }, { kind: "child" as const, count: 1, age: 1 }] };
      for (const text of ["2 том хүн 1 нярай", "2 том хүн 1 нярай хэд болох вэ"]) {
        const result = await harness.turn("party", text, party);
        assert.equal(result.sends.length, 1, `answered: ${text}`);
        const reply = result.sends[0].text;
        assert.match(reply, /ЛУМАРА НИСЛЭГТЭЙ АЯЛАЛ: 6,833,000₮/);
        assert.match(reply, /ЛУМАРА ГАЗРЫН АЯЛАЛ: 4,866,000₮/);
        assert.ok(reply.split("\n").includes("• ЛУМАРА + ТЭВРИН АЯЛАЛ"), "no infant fare: name only, no estimate");
      }
    });

    await context.test("a date none of the listed trips runs on gets their real departures; the next question is still answered", async () => {
      await harness.turn("date", "Лумара", several);
      const unscheduled = await harness.turn("date", "4 сарын 20-нд бга юу", { ...several, place: null, date: "2098-04-20" });
      assert.equal(unscheduled.sends.length, 1);
      assert.match(unscheduled.sends[0].text, /^Тэр хугацаанд гарах аялал алга\. Гарах өдрүүд:/);
      assert.match(unscheduled.sends[0].text, /ЛУМАРА НИСЛЭГТЭЙ АЯЛАЛ: 3 сарын 15, 3 сарын 20/);
      assert.ok(unscheduled.leads.some((lead) => lead.kind === "handoff"), "staff still hear about the wanted date");
      // The off-schedule date does not ride along into the pick that follows.
      const next = await harness.turn("date", "Лумара газрын аялал үнэ хэд вэ", { certainty: "one", tripId: "lum-land" });
      assert.equal(next.sends.length, 1);
      assert.match(next.sends[0].text, /2,222,000₮/);
    });

    await context.test("an unanswerable question stays silent but does not pause the bot", async () => {
      const unknown = await harness.turn("unknown", "Надад энгийнээр тайлбарлаад өгөөч", { intent: "other", topics: [] });
      assert.equal(unknown.sends.length, 0);
      assert.ok(unknown.leads.some((lead) => lead.kind === "handoff"));
      const next = await harness.turn("unknown", "Лумара газрын аялал үнэ хэд вэ", { certainty: "one", tripId: "lum-land" });
      assert.equal(next.sends.length, 1, "the next, answerable question is answered");
      assert.match(next.sends[0].text, /2,222,000₮/);
    });
  } finally {
    await harness.close();
  }
});

// The owner's 2026-10-30 review of a real thread: lists were one long line per trip, and the
// picked trip's card repeated the travel type its own title already named.
test("a trip list is numbered cards, and the picked trip gets the full card without repeating its type", async (context) => {
  const harness = await conversationGateHarness(context);
  const combo = (id: string, name: string, days: string, adult: number, dates: string[]) => ({
    ...trip(id, name, adult, adult - 400_000, 351_000, dates), duration_text: days, source_description: "газар нислэг хосолсон",
  } as unknown as FixtureTrip);
  harness.catalog([
    combo("c1", "ЛУМАРА – ТЭВРИН газар нислэг хосолсон аялал", "10 өдөр 9 шөнө", 2_991_000, ["2098-03-08", "2098-03-22"]),
    combo("c2", "ЦЭНХЭР ХААЛГАНЫ ГАЗАР НИСЛЭГ ХОСОЛСОН АЯЛАЛ", "10 өдөр 9 шөнө", 2_651_000, ["2098-03-08", "2098-03-13"]),
    combo("c3", "ЛУМАРА-ГАЗАР НИСЛЭГ ХОСОЛСОН", "9 өдөр 8 шөнө", 2_291_000, ["2098-03-11", "2098-03-18"]),
  ]);
  try {
    const catalogAsk = { certainty: "several", trips: ["T1", "T2", "T3"], intent: "catalog" };
    const list = (await harness.turn("cards", "Нислэг газар хосолсон", catalogAsk)).sends[0]?.text || "";
    assert.match(list, /^✈️ Газар \+ нислэг хосолсон аяллууд\n\n1\. /);
    // Each trip keeps its own length line, even when two trips share it.
    assert.equal((list.match(/^⏳ 10 өдөр 9 шөнө$/gm) || []).length, 2);
    assert.match(list, /\n\n3\. ЛУМАРА-ГАЗАР НИСЛЭГ ХОСОЛСОН\n⏳ 9 өдөр 8 шөнө\n💰 Том хүн \(12\+ нас\) 2,291,000₮\n📅 3\/11, 3\/18\n/);
    assert.match(list, /1, 2 эсвэл 3 гэж бичээрэй/);

    const card = (await harness.turn("cards", "3. ЛУМАРА-ГАЗАР НИС…")).sends[0]?.text || "";
    assert.match(card, /^✈️ ЛУМАРА-ГАЗАР НИСЛЭГ ХОСОЛСОН\n\n🗓 Хугацаа: 9 өдөр 8 шөнө\n\n💰 Үнэ:/);
    assert.match(card, /Нярай \/0-23 сар\/: 351,000₮/);
    assert.doesNotMatch(card, /Энэ нь газар \+ нислэг хосолсон аялал/, "the title already says it");
    assert.doesNotMatch(card, /дугаараа/, "no phone request on a trip card");
  } finally {
    await harness.close();
  }
});

test("quick-reply buttons follow the order the list shows", async () => {
  const { buildSmartButtons } = await import("../src/lib/travelFastPaths");
  const [first, second] = trips;
  const reply = `Аяллууд:\n\n1. ${second.route_name}\n\n2. ${first.route_name}\n\nАль аяллыг нь сонирхож байна вэ?`;
  assert.deepEqual(buildSmartButtons(reply, trips)?.map((label) => label.slice(0, 3)), ["1. ", "2. "]);
  assert.match(buildSmartButtons(reply, trips)![0], /ГАЗРЫН/);
});

test("a head count followed by 'how much' is still only a head count", () => {
  for (const text of ["2 том хүн 1 нярай", "2 том хүн 1 нярай хэд болох вэ", "2tom hun 2huuhed hed ve", "3 хүн үнэ хэд вэ"]) {
    assert.equal(isPassengerCountOnly(text), true, text);
  }
  for (const text of ["2 том хүн Лумара", "3 сарын 15", "хэд вэ"]) assert.equal(isPassengerCountOnly(text), false, text);
});

test("an inline party total passes the checker only when it adds up from real fares", () => {
  const now = new Date("2098-02-01T04:00:00Z");
  const line = "• ЛУМАРА НИСЛЭГТЭЙ АЯЛАЛ: 6,833,000₮ (2 том хүн /12+ нас/ x 3,111,000₮ + 1 нярай /0-23 сар/ x 611,000₮)";
  assert.equal(verifyTripReply({ reply: line, trips, now }), line);
  assert.equal(verifyTripReply({ reply: line.replace("6,833,000", "6,900,000"), trips, now }), "REFER", "a total that does not add up");
  assert.equal(verifyTripReply({ reply: line.replace("x 3,111,000₮", "x 3,000,000₮").replace("6,833,000", "6,611,000"), trips, now }), "REFER",
    "a consistent sum over an invented unit fare");
});
