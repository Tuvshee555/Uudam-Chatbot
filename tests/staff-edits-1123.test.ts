import test from "node:test";
import assert from "node:assert/strict";
import { DEALS_KEY } from "../src/lib/departureDeals";
import { resolveTripOffer } from "../src/lib/tripOffers";
import { resolveTripFromUserMessage } from "../src/lib/travelFastPathsSearch";
import { stripTripNamesForIntent } from "../src/lib/customerTurn";
import { requestedDepartureScope } from "../src/lib/travelDates";
import { withoutStrayDatelessGroups } from "../src/lib/tripEditorState";
import type { TravelTrip } from "../src/lib/travelTypes";
import type { PriceGroup } from "../src/lib/adminTypes";
import { conversationGateHarness, type FixtureTrip, type ModelOverride } from "./helpers/conversationGateHarness";
import { textOf } from "./helpers/understandingRoutingFixtures";

const readings: Array<[string, ModelOverride]> = [["the model gives no help", {}], ["the model is unavailable", { unavailable: true }]];

/**
 * 2026-11-23 staff-action check on a copy of the live data: each change staff make in the admin was made, then the
 * website and the bot were read back. These are the bot-side failures it found. Invented trips and prices only.
 */
const NOW = new Date("2098-11-23T04:00:00Z");
const DATES = ["2099-01-14", "2099-01-21", "2099-01-28", "2099-02-18", "2099-03-06"];
const ADULT: Record<string, number> = { "2099-01-14": 3_551_000, "2099-01-21": 3_491_000, "2099-01-28": 3_591_000, "2099-02-18": 3_591_000, "2099-03-06": 3_391_000 };
const TALL: Record<string, number> = { "2099-01-14": 3_261_000, "2099-01-21": 3_061_000, "2099-01-28": 3_261_000, "2099-02-18": 3_191_000, "2099-03-06": 3_091_000 };
const SMALL: Record<string, number> = { "2099-01-14": 2_901_000, "2099-01-21": 2_701_000, "2099-01-28": 2_901_000, "2099-02-18": 2_851_000, "2099-03-06": 2_751_000 };

const group = (date: string) => ({
  label: "", note: "", dates: [date], display_dates: [date], date_keys: [date], child_age: "", infant_age: "",
  adult_price: ADULT[date], child_price: TALL[date], infant_price: null,
  passenger_prices: [
    { label: "Хүүхэд 1,2 м-1,4м өндөр", price: TALL[date], currency: "MNT", age_range: "", note: "" },
    { label: "Хүүхэд 1,2 м доош өндөр", price: SMALL[date], currency: "MNT", age_range: "" , note: "" },
  ],
});

const NAME = "УБ-Норвел хотын 1,2,3-р сарын аяллын хөтөлбөр";
function norvel(extra: Record<string, unknown> = {}, name = NAME): TravelTrip {
  return {
    id: "fixture-norvel-123", route_name: name, operator_name: "Uudam", category: "Аялал", duration_text: "6 өдөр 5 шөнө",
    adult_price: 3_391_000, child_price: 3_091_000, infant_price: null, currency: "MNT", departure_dates: DATES,
    seats_total: null, seats_left: null, has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
    extra: {
      age_rules: { adult: "", child: "1,2м-1,4м өндөртэй хүүхэд", infant: "" },
      price_groups: DATES.map(group),
      website_departure_availability: DATES.map((date) => ({ date, status: date === "2099-01-21" ? "ALMOST_FULL" : "OPEN", seatsLeft: null })),
      ...extra,
    },
    created_at: "", updated_at: "",
  } as TravelTrip;
}
const SALE = { date: "2099-02-18", regular_adult_price: 3_591_000, regular_child_price: 3_191_000, sale_adult_price: 3_291_000, sale_child_price: 2_991_000, featured: false };
const siblings = (): TravelTrip[] => [
  { ...norvel({}, "УБ-Норвел хотын 12-р сарын аяллын хөтөлбөр"), id: "fixture-norvel-12", departure_dates: ["2098-12-22"],
    extra: { age_rules: { adult: "12+ нас", child: "2-11 нас" }, price_groups: [] } } as TravelTrip,
  { ...norvel({}, "Норвел + Лунария хаалга шууд нислэгтэй аялал"), id: "fixture-norvel-lun", departure_dates: ["2099-01-21"],
    extra: { age_rules: { adult: "12+ нас", child: "2-11 нас" }, price_groups: [] } } as TravelTrip,
];

test("a date on sale quotes the sale to the child tier that had the regular child fare, and only to it", () => {
  // The sale's child fare replaced BOTH height tiers, and before that the date answered nothing (invalid_age_band:
  // the child band read its saved height rule as an age).
  const offer = resolveTripOffer(norvel({ [DEALS_KEY]: [SALE] }), { date: "2099-02-18" }, NOW);
  assert.equal(offer.status, "ready", JSON.stringify(offer).slice(0, 300));
  if (offer.status !== "ready") return;
  const amounts = offer.offer.fares.map((fare) => [fare.kind, fare.fare.kind === "exact" ? fare.fare.amount : null]);
  assert.deepEqual(amounts.filter(([kind]) => kind === "adult"), [["adult", 3_291_000]]);
  assert.deepEqual(amounts.filter(([kind]) => kind === "child").map(([, amount]) => amount).sort(), [2_851_000, 2_991_000]);
});

test("the start of a trip's name through its numbers names that trip, and its numbers are no month", () => {
  const trips = [norvel(), ...siblings()];
  const text = "УБ-Норвел хотын 1,2,3-р сарын аялал хэзээ гарах вэ";
  const resolved = resolveTripFromUserMessage(text, trips);
  assert.equal(resolved.status, "verified");
  assert.equal(resolved.trip?.id, "fixture-norvel-123");
  assert.doesNotMatch(stripTripNamesForIntent(text, trips), /сар/u, "«3-р сарын» belongs to the name");
  // A month typed after the shared start stays a month question, not this trip.
  assert.notEqual(resolveTripFromUserMessage("УБ-Норвел хотын 1 сарын аялал байгаа юу", trips).trip?.id, "fixture-norvel-123");
});

test("several months at once are read as one window from the first to the last", () => {
  assert.deepEqual(requestedDepartureScope("1,2,3-р сарын аялал хэзээ гарах вэ", NOW), { kind: "range", startYmd: "2099-01-01", endYmd: "2099-03-31" });
  assert.deepEqual(requestedDepartureScope("12, 1-р сард явах", NOW), { kind: "range", startYmd: "2098-12-01", endYmd: "2099-01-31" });
  assert.deepEqual(requestedDepartureScope("1 болон 2-р сард", NOW), { kind: "range", startYmd: "2099-01-01", endYmd: "2099-02-28" });
  assert.deepEqual(requestedDepartureScope("3-р сард", NOW), { kind: "month", year: 2099, month: 3 });
  assert.deepEqual(requestedDepartureScope("1,2,3 сарын 5-нд", NOW), { kind: "dates", dates: ["2099-03-05"] }, "a day after the list is that day");
});

test("journey: «хэзээ гарах вэ» lists every date with its marks; «хэд вэ» gives each date's adult fare; «1,2,3-р сар» is Jan–Mar", async (outer) => {
  for (const [label, model] of readings) await outer.test(label, async (context) => {
    const harness = await conversationGateHarness(context);
    context.mock.timers.setTime(NOW.getTime());
    harness.catalog([norvel({ [DEALS_KEY]: [SALE] }), ...siblings()] as unknown as FixtureTrip[]);
    const say = async (sender: string, text: string) => {
      const result = await harness.turn(sender, text, model, undefined, { platform: "facebook" });
      context.mock.timers.tick(30_000);
      return textOf(result.sends);
    };
    try {
      // Was: a list of three same-start trips; then, picked, three dates and «Өөр 2 сонголт бий.».
      const dates = await say(`dates-${label}`, "УБ-Норвел хотын 1,2,3-р сарын аялал хэзээ гарах вэ");
      // Each date on its own line, its few-seats or sale mark beside it (a fare may come first on the line).
      for (const line of [/• 1 сарын 14\b/u, /• 1 сарын 21 — [^\n]*цөөн суудал/u, /• 1 сарын 28\b/u, /• 2 сарын 18 — [^\n]*хямдрал −8%/u, /• 3 сарын 6\b/u]) {
        assert.match(dates, line, `${label}: ${line} missing:\n${dates}`);
      }
      assert.doesNotMatch(dates, /Өөр \d+ сонголт бий|Аль аяллыг/u, `${label}: ${dates}`);

      // Was: «Аль гарах өдрөөр аялах вэ?» and three of the five dates, no price.
      const price = await say(`price-${label}`, `${NAME} хэд вэ`);
      assert.match(price, /1 сарын 14(?:\n| — )Том хүн[^\n]*3,551,000₮/u, `${label}: ${price}`);
      assert.match(price, /2 сарын 18(?:\n| — )Том хүн[^\n]*3,291,000₮/u, `${label}: the sale fare on its date: ${price}`);
      assert.match(price, /3 сарын 6(?:\n| — )Том хүн[^\n]*3,391,000₮/u, `${label}: ${price}`);

      // The months listed in a renamed trip's old name: January to March, not March alone.
      const months = await say(`months-${label}`, "Норвел 1,2,3-р сард аялал байгаа юу");
      assert.match(months, /1 сарын 14/u, `${label}: ${months}`);
      assert.match(months, /3 сарын 6/u, `${label}: ${months}`);
    } finally {
      await harness.close();
    }
  });
});

test("a departure whose last date was removed is not kept as a dateless price row", () => {
  const dated = group("2099-01-14") as unknown as PriceGroup;
  const emptied = { ...group("2099-03-20"), dates: [], display_dates: [], date_keys: [] } as unknown as PriceGroup;
  assert.deepEqual(withoutStrayDatelessGroups([dated, emptied]), [dated]);
  const onlyDateless = [emptied];
  assert.deepEqual(withoutStrayDatelessGroups(onlyDateless), onlyDateless, "a trip priced without dates keeps its rows");
});

test("a date beside a named trip never hands the question to a trip that shares one word and leaves that day", () => {
  // Replay gate 2026-11-23 (a real message, names invented here): seven words named the trip, «аватар» alone
  // matched another one, and the 12/20 in the message picked that other trip because it left on 12/20.
  const named = { ...norvel({}, "Норвел + Лунария хаалга шууд нислэгтэй аялал ( Калдара - Аватар )"), id: "fixture-named", departure_dates: ["2099-01-21"],
    extra: { age_rules: { adult: "12+ нас", child: "2-11 нас" }, price_groups: [] } } as TravelTrip;
  const other = { ...norvel({}, "ЗЭЛМОР ХАЛУУН РАШААН МИНИ АВАТАР ОРВЕЛ ХОТ АЯЛАЛ"), id: "fixture-other", departure_dates: ["2098-12-20"],
    extra: { age_rules: { adult: "12+ нас", child: "2-11 нас" }, price_groups: [] } } as TravelTrip;
  const resolved = resolveTripFromUserMessage("12.20 хавьцаа НОРВЕЛ + ЛУНАРИЯ ХААЛГА + АВАТАРЫН ЕРТӨНЦ аялал гарахуу?", [named, other]);
  assert.equal(resolved.trip?.id, "fixture-named", JSON.stringify(resolved).slice(0, 200));
});
