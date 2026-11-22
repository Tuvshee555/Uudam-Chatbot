import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dealDateNote, dealFromRow, dealPercent, departureDeals, featuredDealDates, salePercent, dealChangeText, DEALS_KEY } from "../src/lib/departureDeals";
import { resolveTripOffer } from "../src/lib/tripOffers";
import { buildStructuredTripReply } from "../src/lib/travelFastPaths";
import { checkSelfConsistency } from "../src/lib/selfConsistency";
import { quotablePrices } from "../src/lib/tripFacts";
import { applyBrandFares } from "../src/lib/brandFares";
import { websiteTripPayload } from "../src/lib/websiteTripPayload";
import { normalizeExtra } from "../src/lib/tripExtraSchema";
import { DateSeatsEditor } from "../src/components/admin/DateSeatsEditor";
import { ToastProvider } from "../src/components/ui";
import type { TravelTrip } from "../src/lib/travelTypes";
import type { TravelTrip as AdminTrip } from "../src/lib/adminTypes";

// Invented trip only: three future dates, the middle one on sale.
const NOW = new Date("2099-01-05T04:00:00Z");
const row = (date: string, status = "OPEN") => ({ date, status, seatsLeft: null });
const sale = { date: "2099-02-17", regular_adult_price: 2_000_000, regular_child_price: 1_500_000, sale_adult_price: 1_800_000, sale_child_price: null, featured: false };
const trip = (deals: unknown[] = [sale], more: Partial<TravelTrip> = {}): TravelTrip => ({
  id: "fixture-deals", route_name: "ЗАНДАН ДАЛАЙН АЯЛАЛ", operator_name: "Uudam", category: "",
  duration_text: "6 өдөр 5 шөнө", adult_price: 2_000_000, child_price: 1_500_000, infant_price: null, currency: "MNT",
  departure_dates: ["2099-02-10", "2099-02-17", "2099-02-24"], seats_total: null, seats_left: null,
  has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
  extra: {
    age_rules: { adult: "12+ нас", child: "2-11 нас" },
    website_departure_availability: [row("2099-02-10"), row("2099-02-17"), row("2099-02-24")],
    [DEALS_KEY]: deals,
  },
  created_at: "", updated_at: "", ...more,
});

test("a website departure row becomes a deal only with a lower fare or «Онцлох»", () => {
  assert.deepEqual(dealFromRow({ date: "2099-02-17", price: 2_000_000, salePrice: 1_800_000 }), {
    date: "2099-02-17", regular_adult_price: 2_000_000, regular_child_price: null, sale_adult_price: 1_800_000, sale_child_price: null, featured: false,
  });
  assert.equal(dealFromRow({ date: "2099-02-17", price: 2_000_000, salePrice: 2_100_000 }), null, "not below the regular fare = no sale");
  assert.equal(dealFromRow({ date: "2099-02-17", price: 2_000_000 }), null);
  const regularFromTrip = dealFromRow({ date: "2099-02-17", price: null, tripPrice: 2_000_000, salePrice: 1_500_000 })!;
  assert.equal(regularFromTrip.regular_adult_price, 2_000_000, "a row without its own fare takes the trip's");
  assert.equal(dealFromRow({ date: "2099-02-17", price: 2_000_000, isFeatured: true })!.featured, true);
});

test("the percent is worked out from the two fares", () => {
  assert.equal(salePercent(2_000_000, 1_800_000), 10);
  assert.equal(salePercent(2_000_000, 2_000_000), null);
  assert.equal(salePercent(null, 1_800_000), null);
  assert.equal(dealChangeText(2_000_000, 1_800_000), "2,000,000₮ → 1,800,000₮ (−10%)");
  assert.equal(dealPercent(departureDeals(trip())[0]), 10);
  assert.equal(dealDateNote(trip(), "2099-02-17"), "хямдрал −10%");
  assert.equal(dealDateNote(trip(), "2099-02-10"), "");
});

test("the sale date is quoted at the sale fare, the other dates at the regular one", () => {
  const onSale = resolveTripOffer(trip(), { date: "2099-02-17" }, NOW);
  assert.equal(onSale.status, "ready");
  if (onSale.status === "ready") {
    assert.deepEqual(onSale.offer.prices.adult, { kind: "exact", amount: 1_800_000 });
    assert.deepEqual(onSale.offer.prices.child, { kind: "exact", amount: 1_500_000 }, "a child fare not on sale stays");
  }
  const regular = resolveTripOffer(trip(), { date: "2099-02-10" }, NOW);
  if (regular.status === "ready") assert.deepEqual(regular.offer.prices.adult, { kind: "exact", amount: 2_000_000 });
  assert.ok(quotablePrices(trip(), "2099-02-17", NOW).has(1_800_000), "the reply checker accepts the sale fare on that date");
  const withChild = trip([{ ...sale, sale_child_price: 1_200_000 }]);
  const both = resolveTripOffer(withChild, { date: "2099-02-17" }, NOW);
  if (both.status === "ready") assert.deepEqual(both.offer.prices.child, { kind: "exact", amount: 1_200_000 });
});

test("the trip card prints the sale fare beside its date with the percent, and passes its own checker", () => {
  const card = buildStructuredTripReply("ЗАНДАН ДАЛАЙН АЯЛАЛ дэлгэрэнгүй", [trip()], NOW)!;
  assert.match(card, /2\/17 \(хямдрал −10%\)/);
  assert.match(card, /1,800,000₮/);
  assert.match(card, /2,000,000₮/);
  assert.doesNotMatch(card, /2\/10 \(хямдрал/);
  assert.deepEqual(checkSelfConsistency([trip()], NOW).failures, []);
});

test("a trip with no deal reads exactly as before", () => {
  const plain = trip([]);
  const card = buildStructuredTripReply("ЗАНДАН ДАЛАЙН АЯЛАЛ дэлгэрэнгүй", [plain], NOW)!;
  assert.doesNotMatch(card, /хямдрал/i);
  const result = resolveTripOffer(plain, { date: "2099-02-17" }, NOW);
  if (result.status === "ready") assert.deepEqual(result.offer.prices.adult, { kind: "exact", amount: 2_000_000 });
});

test("«Онцлох» dates are the upcoming ones staff marked", () => {
  const featured = trip([{ ...sale, featured: true }, { date: "2099-01-01", regular_adult_price: 2_000_000, regular_child_price: null, sale_adult_price: null, sale_child_price: null, featured: true }]);
  assert.deepEqual(featuredDealDates(featured, "2099-01-05"), ["2099-02-17"]);
});

test("the secondary brand lowers the regular and the sale fare alike, so the percent follows", () => {
  const branded = applyBrandFares(trip(), 50_000);
  const [deal] = departureDeals(branded);
  assert.equal(deal.regular_adult_price, 1_950_000);
  assert.equal(deal.sale_adult_price, 1_750_000);
  assert.equal(dealPercent(deal), 10);
  const offer = resolveTripOffer(branded, { date: "2099-02-17" }, NOW);
  if (offer.status === "ready") assert.deepEqual(offer.offer.prices.adult, { kind: "exact", amount: 1_750_000 });
});

test("the deals are read with the trip and never saved with it", () => {
  const { extra } = normalizeExtra(trip().extra as Record<string, unknown>);
  assert.equal(DEALS_KEY in extra, false);
});

test("the admin date row has a sale and an «Онцлох» button beside the seat buttons", () => {
  const html = renderToStaticMarkup(createElement(ToastProvider, null, createElement(DateSeatsEditor, {
    trip: trip() as unknown as AdminTrip, apiFetch: async () => new Response("{}"),
  })));
  assert.equal((html.match(/>Хямдрал</g) || []).length, 3);
  assert.equal((html.match(/★ Онцлох/g) || []).length, 3);
  assert.match(html, /Дүүрсэн/);
});

test("the website projection keeps the REGULAR fare on a sale date (the sale has its own column)", () => {
  const schedule = ["2099-02-10", "2099-02-17"].map((date) => ({ start: `${date}T00:00:00.000Z`, end: `${date}T00:00:00.000Z`, label: date }));
  const payload = websiteTripPayload(trip(), schedule, NOW);
  assert.deepEqual(payload.departures.map((d) => d.price), [2_000_000, 2_000_000]);
});
