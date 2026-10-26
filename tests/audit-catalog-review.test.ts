import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";

let buildCatalogListingReply: typeof import("../src/lib/catalogListing").buildCatalogListingReply;
before(async () => {
  applyTestEnv();
  ({ buildCatalogListingReply } = await import("../src/lib/catalogListing"));
});
const now = new Date("2098-02-01T04:00:00Z");
function trip(id: string, dates: string[], overrides: Partial<TravelTrip> = {}): TravelTrip {
  return { id, route_name: `Зорвин ${id} шууд нислэгтэй аялал`, category: "Шууд нислэгтэй аялал", operator_name: "Invented",
    duration_text: "5 өдөр", adult_price: 1_234_567, child_price: null, infant_price: null, currency: "MNT",
    departure_dates: dates, seats_total: null, seats_left: null, has_food: null, status: "active", notes: "", hotel: "",
    source_description: "", photo_urls: [], extra: { transport_type: "direct_flight" }, created_at: "", updated_at: "", ...overrides };
}

test("exact-date flight listings filter the catalog before limits and print only matching dates", () => {
  const early = Array.from({ length: 7 }, (_, i) => trip(`early-${i}`, ["2098-02-03"]));
  const matching = trip("matching", ["2098-02-02", "2098-03-19", "2098-04-21"]);
  const land = trip("land", ["2098-03-19"], { route_name: "Нерит газрын аялал", extra: { transport_type: "land" }, category: "Газрын аялал" });
  const result = buildCatalogListingReply("3.19 nii shuud nislegtei aylal medeelel avii", [...early, matching, land], now)!;
  assert.deepEqual(result.listed.map(t => t.id), [matching.id]);
  assert.match(result.reply, /гарах: 3 сарын 19/);
  assert.doesNotMatch(result.reply, /2 сарын 2|2 сарын 3|4 сарын 21|early-|Нерит/);
});

test("a missing or closed requested flight date returns a silent handoff signal", () => {
  const later = trip("later", ["2098-03-20"]);
  const closed = trip("closed", ["2098-03-19"], { extra: { transport_type: "direct_flight",
    website_departure_availability: [{ date: "2098-03-19", status: "SOLD_OUT", seatsLeft: 0 }] } });
  for (const catalog of [[later], [later, closed]]) {
    const result = buildCatalogListingReply("3 сарын 19 шууд нислэгтэй аялал", catalog, now)!;
    assert.equal(result.reply, "REFER");
    assert.deepEqual(result.listed, []);
    assert.equal(result.authoritative, true);
  }
});

test("category lists preserve shared-month alternative days and their destination", () => {
  const matching = trip("matching", ["2098-03-18", "2098-03-19", "2098-03-20", "2098-03-21"]);
  const other = trip("other", ["2098-03-19"], { route_name: "Нерит шууд нислэгтэй аялал" });
  const result = buildCatalogListingReply("Зорвин 3.19,21-nd шууд нислэгтэй аялал", [other, matching], now)!;
  assert.deepEqual(result.listed.map(t => t.id), [matching.id]);
  assert.match(result.reply, /гарах: 3 сарын 19, 3 сарын 21/);
  assert.doesNotMatch(result.reply, /3 сарын 18|3 сарын 20|Нерит/);
});

test("a scoped category question cannot replace a missing flight with a land alternative", () => {
  const land = trip("land", ["2098-03-19"], { route_name: "Зорвин газрын аялал", extra: { transport_type: "land" }, category: "Газрын аялал" });
  const flight = trip("flight", ["2098-03-20"], { route_name: "Нерит шууд нислэгтэй аялал" });
  const result = buildCatalogListingReply("Зорвин 3 сарын 19 шууд нислэгтэй аялал", [land, flight], now)!;
  assert.equal(result.reply, "REFER");
  assert.deepEqual(result.listed, []);
});

test("an exact-date category answer uses that departure's fare", () => {
  const value = trip("dated", ["2098-03-19", "2098-04-21"], { extra: { transport_type: "direct_flight", price_groups: [
    { dates: ["2098-03-19"], adult_price: 1_234_567 },
    { dates: ["2098-04-21"], adult_price: 2_345_678 },
  ] } });
  const result = buildCatalogListingReply("3 сарын 19 шууд нислэгтэй аялал үнэ", [value], now)!;
  assert.match(result.reply, /1,234,567₮/);
  assert.doesNotMatch(result.reply, /2,345,678|4 сарын 21/);
});
