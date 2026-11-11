import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip, type ModelOverride } from "./helpers/conversationGateHarness";
import { HOLIDAY_NOW } from "./helpers/holidayFixture";

/**
 * Three production conversations of 2026-11-07 .. 11-11 (shapes only; invented trips, prices and places).
 *
 *  1. "<city A> <city B> 2 hotiin aylal ni 1 sard garah" (a two-city trip) was answered with a four-city trip
 *     that shares neither city (a look-alike of city B), and the next "Vne" quoted that wrong trip's price.
 *  2. "Хамгийн хямд аялалыг санал болгооч шинэ жилийн" got the New Year list in date order, dearest first.
 *  3. "<city> <island>ын хөтөлбөр" (a trip that has ended) got the card of another trip sharing only the city.
 *
 * The rule behind 1 and 3 (placeCoverage.ts): every place the customer names must be in the trip the bot
 * answers about; otherwise the bot does not know, stays silent, a lead goes to staff and no trip is remembered.
 */
const trip = (id: string, name: string, dates: string[], adult: number, fields: Record<string, unknown> = {}) => ({
  id, route_name: name, operator_name: "Fixture agency", category: "Аялал", adult_price: adult, child_price: adult - 200_000, infant_price: null,
  currency: "MNT", status: "active", duration_text: "8 өдөр 7 шөнө", departure_dates: dates, seats_total: 20, seats_left: 10,
  has_food: null, hotel: "", photo_urls: [], notes: "", source_description: "",
  extra: { customer_visible: true, age_rules: { adult: "12+ нас", child: "2-11 нас" } }, ...fields,
} as unknown as FixtureTrip);
const one = (tripId: string, extra: ModelOverride = {}): ModelOverride => ({ certainty: "one", tripId, topics: ["price"], ...extra });

test("production conversations of 2026-11-07 .. 11-11", async (context) => {
  const harness = await conversationGateHarness(context);
  const say = async (sender: string, text: string, model: ModelOverride = {}) => {
    const result = await harness.turn(sender, text, model);
    return { ...result, text: result.sends.map((send) => send.text).join("\n") };
  };
  try {
    await context.test("a two-city ask never gets a trip missing one of the cities, and the next 'Vne' quotes no wrong trip", async () => {
      harness.catalog([
        // As in production: the two-city trip exists, its only departure is full.
        trip("two-city", "ТАЛВЕР + ЛОРИАЖЭ ШУУД НИСЛЭГТЭЙ АЯЛАЛ", ["2098-02-19"], 3_100_000, { extra: { customer_visible: true, aliases: ["Talver", "Лориажэ", "Loriaje"],
          website_departure_availability: [{ date: "2098-02-19", status: "SOLD_OUT", seatsLeft: 0 }] } }),
        trip("four-city", "ПЕКАРА - ЖИРОН - ЛОРИАКОУ - ЭРМЕН 4 ХОТЫН АЯЛАЛ", ["2098-02-08", "2098-02-15"], 1_690_000),
        trip("talver-city", "УБ-ТАЛВЕР ХОТЫН АЯЛАЛ", ["2098-02-12"], 2_990_000),
      ]);
      // As in production: the matcher (or the model) settles on the four-city trip.
      const ask = await say("two-city", "Talver Loriaje 2 hotiin aylal ni 2 sard garah", one("four-city"));
      assert.doesNotMatch(ask.text, /ПЕКАРА|ЛОРИАКОУ|1,690,000/u, "the trip that lacks a named city is never the answer");
      assert.ok(ask.sends.length === 0 || /дууссан/u.test(ask.text), `silence, or the two-city trip announced as full: ${ask.text}`);
      const price = await say("two-city", "Vne", one("four-city"));
      assert.doesNotMatch(price.text, /1,690,000|ПЕКАРА/u, "no trip was remembered from a turn the customer never saw");
      // Positive control: a one-city ask still gets that city's trip.
      const right = await say("two-city-ok", "УБ-Талвер хотын аялал үнэ", one("talver-city"));
      assert.match(right.text, /2,990,000₮/u);
    });

    await context.test("a city + island ask about an ended trip never gets another trip that only shares the city", async () => {
      harness.catalog([
        trip("pkg", "ШЭНЗАР – ХОНГСАН – ЗОРГАН – МАКОР 8 ШӨНӨ 9 ӨДӨР", ["2098-02-11"], 4_090_000, { extra: { customer_visible: true,
          website_url: "https://site.example.test/trips/pkg" } }),
        trip("ended", "МАКОР – ЗОРГАН – ХАЙЛИВ АРАЛ", ["2097-10-30"], 2_690_000, { status: "archived" }),
      ]);
      const ask = await say("island", "зорган хайливын хөтөлбөр", one("pkg", { topics: ["program"] }));
      assert.doesNotMatch(ask.text, /ШЭНЗАР|4,090,000|site\.example\.test/u, "not the package that only shares the city");
      assert.ok(harness.leads.some((lead) => lead.sender_id === "island"), "staff get the ask");
      // Positive control: the package asked by its own city still gets its programme / card.
      const pkg = await say("island-ok", "зорган макор аяллын үнэ", one("pkg"));
      assert.match(pkg.text, /4,090,000₮/u);
    });

    await context.test("'хамгийн хямд' lists the cheapest New Year trips first; 'санал болгооч' is a verb, not a place", async () => {
      context.mock.timers.setTime(Date.parse(HOLIDAY_NOW));
      harness.catalog([
        trip("ny-dear", "ОРВЕЛИЯ ШИНЭ ЖИЛИЙН АЯЛАЛ", ["2026-12-28"], 4_290_000),
        trip("ny-mid", "НОРВЕЛ ХОТЫН АЯЛАЛ", ["2026-12-27"], 1_990_000),
        trip("ny-cheap", "КАЛДОР МИНИ АЯЛАЛ", ["2026-12-27", "2026-12-31"], 990_000),
      ]);
      for (const [index, text] of ["Хамгийн хямд аялалыг санал болгооч шинэ жилийн", "shine jiliin hamgiin hyamd aylal sanal bolgooch"].entries()) {
        const reply = await say(`cheap-${index}`, text);
        assert.ok(reply.sends.length > 0, `answered, not silence: ${text}`);
        const cheap = reply.text.indexOf("КАЛДОР"), dear = reply.text.indexOf("ОРВЕЛИЯ");
        assert.ok(cheap >= 0 && (dear < 0 || cheap < dear), `the cheapest trip comes first: ${reply.text}`);
      }
    });

    await context.test("a date no trip runs on also points to the website for the other trips", async () => {
      context.mock.timers.setTime(Date.parse("2098-02-01T04:00:00Z"));
      harness.catalog([trip("norvel", "НОРВЕЛ ХОТЫН АЯЛАЛ", ["2098-03-15", "2098-03-29"], 1_790_000)]);
      await say("miss", "Норвел хотын аялал", one("norvel"));
      const miss = await say("miss", "3 сарын 20-нд гарах уу", one("norvel", { topics: ["dates"] }));
      assert.match(miss.text, /Бусад аяллуудыг эндээс харж болно: https:\/\/uudamtravel\.mn — сонирхсон аяллаа бичээрэй/u, miss.text);
    });
  } finally {
    await harness.close();
  }
});
