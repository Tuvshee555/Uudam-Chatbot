import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";

/**
 * Customer journeys, end to end through the signed webhook (CI gate: npm run qa:conversations).
 * Each journey is the shape of real conversations that failed between June and October 2026
 * (docs/chatbot-forensic-audit.md), replayed on an invented catalogue with a mocked model.
 * Besides each journey's own expectations, every price and date the bot sends must come from
 * the catalogue (or be correct arithmetic on it).
 */
const trip = (id: string, name: string, dates: string[], fares: [number, number, number | null], fields: Record<string, unknown> = {}) => ({
  id, route_name: name, operator_name: "Fixture agency", category: "Аялал", adult_price: fares[0], child_price: fares[1], infant_price: fares[2],
  currency: "MNT", status: "active", duration_text: "9 өдөр 8 шөнө", departure_dates: dates, seats_total: 20, seats_left: 10,
  has_food: null, hotel: "", photo_urls: [], notes: "", source_description: "",
  extra: { customer_visible: true, age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" } }, ...fields,
} as unknown as FixtureTrip);
const combo = (id: string, name: string, adult: number, dates: string[]) =>
  trip(id, name, dates, [adult, adult - 400_000, 351_000], { category: "Газар + нислэг хосолсон", source_description: "газар нислэг хосолсон" });

const catalog = [
  combo("a1", "ЛУМАРА А ГАЗАР НИСЛЭГ ХОСОЛСОН", 2_991_000, ["2098-03-08", "2098-03-22"]),
  combo("a2", "ЛУМАРА Б ГАЗАР НИСЛЭГ ХОСОЛСОН", 2_651_000, ["2098-03-08", "2098-03-13"]),
  combo("a3", "ЛУМАРА В ГАЗАР НИСЛЭГ ХОСОЛСОН", 2_291_000, ["2098-03-11", "2098-03-18"]),
  trip("sea", "ВЭЛМОР ДАЛАЙН ЭРГИЙН АЯЛАЛ", ["2098-02-15", "2098-03-06", "2098-03-20"], [1_391_000, 1_191_000, null]),
  trip("city", "НОРВЕЛ ХОТЫН АЯЛАЛ", ["2098-03-15", "2098-03-29"], [1_791_000, 1_591_000, 381_000], { extra: { customer_visible: true, aliases: ["Норвел"] } }),
];
const comboList = { certainty: "several", trips: ["T1", "T2", "T3"], intent: "catalog" };
const one = (tripId: string, extra: Record<string, unknown> = {}) => ({ certainty: "one", tripId, ...extra });

/** Every amount is a catalogue fare or a sum of listed fares; every date a catalogue departure. */
function assertGrounded(reply: string) {
  const fares = new Set(catalog.flatMap((value) => [value.adult_price, value.child_price, value.infant_price]).filter((fare): fare is number => typeof fare === "number"));
  const amounts = [...reply.matchAll(/(\d{1,3}(?:,\d{3})+)₮/g)].map((match) => Number(match[1].replace(/,/g, "")));
  const total = /Нийт:\s*(\d{1,3}(?:,\d{3})+)₮/.exec(reply);
  const lines = [...reply.matchAll(/x\s*(\d+):\s*(\d{1,3}(?:,\d{3})+)₮/g)].reduce((sum, match) => sum + Number(match[1]) * Number(match[2].replace(/,/g, "")), 0);
  if (total) assert.equal(Number(total[1].replace(/,/g, "")), lines, `total must add up: ${reply}`);
  for (const amount of amounts) assert.ok(fares.has(amount) || (total && amount === Number(total[1].replace(/,/g, ""))), `unknown amount ${amount}: ${reply}`);
  const days = new Set(catalog.flatMap((value) => value.departure_dates).map((date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`));
  // A heading restating the customer's own window ("3 сарын 10 – 3 сарын 16-ны хооронд") is not a departure.
  const departures = reply.replace(/[^\n]*хооронд[^\n]*/g, "");
  for (const match of departures.matchAll(/(?<![\d,])(\d{1,2})\/(\d{1,2})(?![\d,])|(\d{1,2}) сарын (\d{1,2})/g)) {
    const day = match[1] ? `${Number(match[1])}/${Number(match[2])}` : `${Number(match[3])}/${Number(match[4])}`;
    assert.ok(days.has(day), `date ${day} is not a catalogue departure: ${reply}`);
  }
  assert.doesNotMatch(reply, /undefined|null|NaN|Invalid Date/);
}

test("customer journeys reach their goal with grounded facts", async (context) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalog);
  const say = async (sender: string, text: string, model: Record<string, unknown> = {}) => {
    const result = await harness.turn(sender, text, model);
    for (const send of result.sends) assertGrounded(send.text);
    return { ...result, text: result.sends.map((send) => send.text).join("\n") };
  };
  try {
    await context.test("selecting a trip by typed number or by button gives the same full card", async () => {
      await say("pick", "Нислэг газар хосолсон", comboList);
      const typed = await say("pick", "2");
      assert.equal(typed.answerModelCalls, 0);
      assert.match(typed.text, /^✈️ ЛУМАРА Б ГАЗАР НИСЛЭГ ХОСОЛСОН\n\n🗓 Хугацаа: 9 өдөр 8 шөнө\n\n💰 Үнэ:/);
      await say("pick", "Нислэг газар хосолсон", comboList);
      const tapped = await say("pick", "3. ЛУМАРА В ГАЗАР НИС…");
      assert.match(tapped.text, /^✈️ ЛУМАРА В ГАЗАР НИСЛЭГ ХОСОЛСОН\n\n🗓 Хугацаа/);
      assert.match(tapped.text, /• Том хүн: 2,291,000₮/);
    });

    await context.test("booking intent then a phone writes one lead with the trip, then staff own the chat", async () => {
      await say("book", "Нислэг газар хосолсон", comboList);
      await say("book", "1");
      assert.equal((await say("book", "Захиалга өгье")).text, "Утасны дугаараа бичнэ үү.");
      const phone = await say("book", "90000000");
      assert.equal(phone.leads.length, 1);
      assert.equal(phone.leads[0].kind, "booking");
      assert.match(phone.leads[0].context, /ЛУМАРА А ГАЗАР НИСЛЭГ ХОСОЛСОН/);
      assert.match(phone.leads[0].context, /90000000/);
      assert.equal(phone.text, "ЛУМАРА А ГАЗАР НИСЛЭГ ХОСОЛСОН\nЗахиалгын хүсэлтийг хүлээн авлаа.");
      const after = await say("book", "Хэзээ холбогдох вэ?");
      assert.equal(after.sends.length, 0, "a booked customer belongs to staff");
      assert.equal(after.leads.length, 0, "no second lead");
    });

    await context.test("family pricing follows each change to the party", async () => {
      await say("family", "Норвел хотын аялал үнэ", one("city"));
      const party = await say("family", "2 том хүн 1 хүүхэд", one("city", { passengers: [{ kind: "adult", count: 2 }, { kind: "child", count: 1 }] }));
      assert.match(party.text, /Нийт: 5,173,000₮/);
      const changed = await say("family", "Одоо 3 том хүн", one("city", { passengers: [{ kind: "adult", count: 3 }] }));
      assert.match(changed.text, /Нийт: 6,964,000₮/, "3 adults and the child");
    });

    await context.test("travel-date constraints narrow the departures shown", async () => {
      await say("dates", "Вэлмор далай", one("sea"));
      const onward = await say("dates", "3.1-ээс хойш бна уу", one("sea"));
      assert.match(onward.text, /3 сарын 6/);
      assert.doesNotMatch(onward.text, /2 сарын 15/);
      const windowed = await say("window", "3.10-16-ны хооронд эхлэх аялал бнуу", { certainty: "none", trips: [] });
      assert.match(windowed.text, /НОРВЕЛ ХОТЫН АЯЛАЛ|ЛУМАРА В ГАЗАР НИСЛЭГ ХОСОЛСОН|ЛУМАРА Б ГАЗАР НИСЛЭГ ХОСОЛСОН/);
      assert.doesNotMatch(windowed.text, /ВЭЛМОР ДАЛАЙН/, "no trip outside the window");
    });

    // Live 2026-10-30 on production: "<place> aylal neg sariin eheer sonirhoj bb" (early January, Latin
    // script) got December dates, then "neg sard" got silence — Latin month words were not read.
    await context.test("a month written as a Latin number word is honoured and never answered with silence", async () => {
      const early = await say("latin-month", "norvel aylal hoyor sariin eheer sonirhoj bb", one("city"));
      assert.match(early.text, /^Тэр хугацаанд гарах аялал алга\. Гарах өдрүүд:/, "nothing departs early February: said, with the real dates");
      assert.match(early.text, /3 сарын 15/);
      const march = await say("latin-month", "gurav sard", one("city", { topics: [] }));
      assert.equal(march.sends.length, 1, "a month follow-up is answered");
      assert.match(march.text, /3 сарын 15/);
    });

    await context.test("changing destination mid-conversation moves every answer to the new trip", async () => {
      await say("switch", "Вэлмор далай үнэ", one("sea"));
      const moved = await say("switch", "Норвел хотын аялал үнэ хэд вэ", one("city"));
      assert.match(moved.text, /1,791,000₮/);
      assert.equal(moved.selection?.tripId, "city");
      const follow = await say("switch", "хүүхдийн үнэ", one("city"));
      assert.match(follow.text, /1,591,000₮/);
      assert.doesNotMatch(follow.text, /1,191,000₮/, "not the earlier trip's fare");
    });

    await context.test("during a human takeover the bot sends nothing but keeps the message", async () => {
      await say("takeover", "Норвел хотын аялал үнэ", one("city"));
      harness.pause("takeover");
      const paused = await say("takeover", "Үнэ хэд вэ дахиад", one("city"));
      assert.equal(paused.sends.length, 0);
      assert.ok(paused.history.some((row) => row.role === "user" && row.text === "Үнэ хэд вэ дахиад"), "staff still see what the customer wrote");
    });

    await context.test("a customer returning after 40 days is not answered from a stale trip", async () => {
      await say("returning", "Норвел хотын аялал үнэ", one("city"));
      context.mock.timers.tick(40 * 86_400_000);
      const hello = await say("returning", "Сайн байна уу");
      assert.equal(hello.sends.length, 1);
      assert.doesNotMatch(hello.text, /₮|НОРВЕЛ/, "a greeting is not answered with the old trip");
      // Prices are re-read from today's catalogue; an answer drawn from the old turns must say
      // which trip it prices, since the customer may not remember.
      const price = await say("returning", "үнэ");
      if (/₮/.test(price.text)) assert.match(price.text, /^НОРВЕЛ ХОТЫН АЯЛАЛ\n/, "a price from old context names its trip");
    });
  } finally {
    await harness.close();
  }
});

// Known gap (Oct 24 shape, see docs/chatbot-conversation-quality.md backlog): one opening message
// carrying a date window, the children's ages, a lodging preference and "send the programme" is
// answered on the date alone. Kept visible here until it is built.
test.todo("a multi-constraint family opening (dates + ages + villa/resort + programme) addresses every constraint");
