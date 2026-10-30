import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";

let buildCatalogListingReply: typeof import("../src/lib/catalogListing").buildCatalogListingReply;
let buildAmbiguousTripReply: typeof import("../src/lib/travelFastPathsPricing").buildAmbiguousTripReply;
let hasPriceIntent: typeof import("../src/lib/travelFastPathsPricing").hasPriceIntent;
before(async () => {
  applyTestEnv();
  ({ buildCatalogListingReply } = await import("../src/lib/catalogListing"));
  ({ buildAmbiguousTripReply, hasPriceIntent } = await import("../src/lib/travelFastPathsPricing"));
});

const now = new Date("2098-02-01T00:00:00Z");

test("program requests do not accidentally ask for payment, while explicit prices still count", () => {
  for (const text of ["Хөтөлбөр", "Хөтөлбөр үзэх", "хөтөлбөрийн дэлгэрэнгүй", "Хөтөлбөрт юу багтсан бэ"]) {
    assert.equal(hasPriceIntent(text), false, text);
  }
  for (const text of ["Төлбөр", "Төлбөрийн нөхцөл", "Хөтөлбөрийн үнэ", "Хөтөлбөр ба төлбөр"]) {
    assert.equal(hasPriceIntent(text), true, text);
  }
});

function trip(index: number, dates = ["2098-03-27"], extra: TravelTrip["extra"] = {}): TravelTrip {
  return {
    id: `compact-${index}`, route_name: `Вэлмор ${index} аялал`, category: "Аялал", operator_name: "Invented",
    duration_text: "5 өдөр 4 шөнө", adult_price: 901_001, child_price: 401_001, infant_price: 101_001,
    currency: "MNT", departure_dates: dates, status: "active", seats_total: null, seats_left: null,
    has_food: null, notes: "", hotel: "", source_description: "", photo_urls: [], extra, created_at: "", updated_at: "",
  };
}

test("ordinary month-end menus filter every displayed date before taking three trips", () => {
  const early = Array.from({ length: 7 }, (_, index) => trip(index, ["2098-03-05"]));
  const late = Array.from({ length: 4 }, (_, index) => trip(index + 7, ["2098-03-05", "2098-03-27"]));
  const result = buildCatalogListingReply("3 сарын сүүлээр аялал гарах уу", [...early, ...late], now)!;
  assert.deepEqual(result.listed.map(value => value.id), late.slice(0, 3).map(value => value.id));
  assert.equal((result.reply.match(/^• /gm) || []).length, 3);
  assert.match(result.reply, /3 сарын 27/);
  assert.doesNotMatch(result.reply, /3 сарын 5|compact-0/);
  assert.match(result.reply, /Өөр 1 аялал бий/);
  assert.equal(buildCatalogListingReply("3 сарын сүүлээр аялал гарах уу", early, now)?.reply, "REFER");
});

test("ordinary month and duration menus remain compact while explicit full requests expand", () => {
  const catalog = Array.from({ length: 7 }, (_, index) => trip(index));
  for (const question of ["3 сард гарах аялал", "5 хоногийн аялал байна уу"]) {
    assert.equal(buildCatalogListingReply(question, catalog, now)?.listed.length, 3);
    assert.equal(buildCatalogListingReply(`бүх ${question}`, catalog, now)?.listed.length, 7);
  }
});

test("destination options show three compact choices with a truthful remaining count", () => {
  const catalog = Array.from({ length: 7 }, (_, index) => trip(index));
  const reply = buildAmbiguousTripReply(catalog, undefined, { customerText: "Вэлмор" }, now);
  assert.equal((reply.match(/^• /gm) || []).length, 3);
  assert.match(reply, /Өөр 4 сонголт бий/);
  assert.doesNotMatch(reply, /хүүхэд|нярай|5 өдөр|4 шөнө|Вэлмор 3 аялал/);
  assert.equal((reply.match(/\?/g) || []).length, 1);
  const full = buildAmbiguousTripReply(catalog, undefined, { customerText: "Вэлмор бүх сонголт" }, now);
  assert.equal((full.match(/^• /gm) || []).length, 7);
  assert.match(full, /хүүхэд|нярай/);
});

test("focused child menus retain the selected fare's age, hotel and package conditions", () => {
  const value = trip(0, ["2098-03-27"], { price_groups: [{ dates: ["2098-03-27"], hotel: "Lumen Lodge", package_id: "standard",
    passenger_prices: [{ label: "Хүүхэд", age_range: "3-9 нас", price: 401_001 }, { label: "Том хүн", age_range: "10+ нас", price: 901_001 }],
  }] });
  const reply = buildAmbiguousTripReply([value], undefined, { customerText: "Вэлмор хүүхдийн үнэ" }, now);
  assert.match(reply, /хүүхэд \(3-9 нас\) 401,001₮/);
  assert.match(reply, /Lumen Lodge.*standard/);
  assert.doesNotMatch(reply, /том хүн|нярай/);
});

test("compact menus keep every explicitly requested departure in a shared-month list", () => {
  const value = trip(0, ["2098-03-23", "2098-03-25", "2098-03-27"]);
  for (const reply of [
    buildAmbiguousTripReply([value], undefined, { customerText: "Вэлмор 3.23,25,27-нд үнэ" }, now),
    buildCatalogListingReply("3.23,25,27-нд бүх аялал", [value], now)!.reply,
  ]) {
    assert.match(reply, /3 сарын 23, 3 сарын 25, 3 сарын 27/);
  }
});
