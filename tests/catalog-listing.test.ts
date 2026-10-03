import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";

let buildCatalogListingReply: typeof import("../src/lib/catalogListing").buildCatalogListingReply;
before(async () => {
  applyTestEnv();
  ({ buildCatalogListingReply } = await import("../src/lib/catalogListing"));
});
const NOW = new Date("2026-10-03T04:00:00Z");
function trip(index = 0, fields: Partial<TravelTrip> = {}): TravelTrip {
  return { id: `invented-${index}`, category: "Шууд нислэгтэй аялал", operator_name: "Invented",
    route_name: `Вэлмор${index} шууд нислэгтэй аялал`, duration_text: `${index + 3} өдөр`,
    adult_price: 1_200_000, child_price: null, infant_price: null, currency: "MNT",
    departure_dates: ["2026-12-17"], seats_total: null, seats_left: null, has_food: null,
    status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
    extra: {}, created_at: "", updated_at: "", ...fields };
}
function listing(text: string, trips: TravelTrip[]) {
  const result = buildCatalogListingReply(text, trips, NOW);
  assert.ok(result);
  const visible = result.reply.split("\n").filter((line) => line.startsWith("• "));
  assert.equal(result.listed.length, visible.length);
  assert.deepEqual(result.listed.map((t) => t.route_name), visible.map((line) => line.slice(2).split(" — ")[0]));
  return result;
}

test("category and generic lists default to three with remaining count; explicit all/full allows eight", () => {
  const trips = Array.from({ length: 12 }, (_, i) => trip(i));
  for (const text of ["шууд нислэгтэй аяллууд", "аяллууд"]) {
    const result = listing(text, trips);
    assert.equal(result.listed.length, 3);
    assert.match(result.reply, /Өөр 9 сонголт бий.*https:/);
    assert.ok(!result.reply.includes(trips[3].route_name));
  }
  for (const text of ["бүх шууд нислэгтэй аяллууд", "full шууд нислэгтэй аяллууд", "all trips"]) {
    const result = listing(text, trips);
    assert.equal(result.listed.length, 8);
    assert.match(result.reply, /Өөр 4 сонголт бий/);
    assert.ok(!result.reply.includes(trips[8].route_name));
  }
});

test("explicit whole catalog stays grouped and listed IDs match visible rows", () => {
  const trips = Array.from({ length: 12 }, (_, i) => trip(i, { category: i < 4 ? "Ангилал А" : "Ангилал Б" }));
  const result = listing("бүх аяллын жагсаалт", trips);
  assert.equal(result.listed.length, 8);
  assert.match(result.reply, /Ангилал А:/);
  assert.match(result.reply, /Ангилал Б:/);
  assert.ok(!result.reply.includes("том хүн"));
});

test("shortest recommendations show two by default and five explicitly requested", () => {
  const trips = Array.from({ length: 7 }, (_, i) => trip(i)).reverse();
  const compact = listing("богино хоногтой аялал", trips);
  assert.deepEqual(compact.listed.map((t) => t.id), ["invented-0", "invented-1"]);
  assert.match(compact.reply, /Өөр 5 сонголт бий/);
  assert.equal(listing("бүх богино хоногтой аялал", trips).listed.length, 5);
});

test("Lunar listings show three by default and eight for explicit full requests", () => {
  const trips = Array.from({ length: 10 }, (_, i) => trip(i, { route_name: `Сар шинийн Вэлмор${i}` }));
  const compact = listing("Сар шинийн аялал", trips);
  assert.equal(compact.listed.length, 3); assert.equal(compact.authoritative, true);
  assert.match(compact.reply, /Өөр 7 сонголт бий/);
  assert.equal(listing("бүх Сар шинийн аялал", trips).listed.length, 8);
  assert.equal(listing("Сар шинийн аялал", [trip()]).listed.length, 0);
});

test("message-budget truncation returns only complete visible options, including grouped lists", () => {
  const trips = Array.from({ length: 12 }, (_, i) => trip(i, { route_name: `Вэлмор${i} ${"а".repeat(350)}` }));
  for (const text of ["all trips", "full шууд нислэгтэй аяллууд"]) {
    const result = listing(text, trips);
    assert.ok(result.reply.length <= 1800);
    assert.ok(result.listed.length > 0 && result.listed.length < 8);
    assert.match(result.reply, new RegExp(`Өөр ${12 - result.listed.length} сонголт бий`));
    for (const hidden of trips.filter((t) => !result.listed.includes(t))) assert.ok(!result.reply.includes(hidden.route_name));
  }
});

test("canonical hotel/date fare replaces stale scalar without choosing an arbitrary hotel", () => {
  const single = trip(0, { extra: { price_groups: [
    { hotel: "Verified Lodge", package_id: "standard", dates: ["2026-12-17"], adult_price: 4_000_000 },
  ] } });
  const result = listing("аяллууд", [single]);
  assert.match(result.reply, /4,000,000₮.*Verified Lodge.*standard/);
  assert.ok(!result.reply.includes("1,200,000"));
  const ambiguous = trip(0, { extra: { price_groups: [
    { hotel: "First Lodge", adult_price: 4_000_000 },
    { hotel: "Other Lodge", adult_price: 5_000_000 },
  ] } });
  const uncertain = listing("аяллууд", [ambiguous]);
  assert.ok(!uncertain.reply.includes("том хүн"));
  assert.ok(!uncertain.reply.includes("Lodge"));
  assert.ok(!uncertain.reply.includes("1,200,000"));
});

test("different date prices, conflicting groups and unverified fares omit price instead of scalar fallback", () => {
  const variants = [
    trip(0, { departure_dates: ["2026-12-17", "2026-12-20"], extra: { price_groups: [
      { hotel: "Same Lodge", dates: ["2026-12-17"], adult_price: 4_000_000 },
      { hotel: "Same Lodge", dates: ["2026-12-20"], adult_price: 5_000_000 },
    ] } }),
    trip(0, { extra: { price_groups: [{ adult_price: 4_000_000 }, { adult_price: 5_000_000 }] } }),
    trip(0, { extra: { price_groups: [{ passenger_prices: [{ label: "adult", price: null }] }] } }),
    trip(0, { adult_price: 0, extra: { discounts: [{ condition: "Pay before deadline", adult_price: 2_000_000 }] } }),
  ];
  for (const value of variants) {
    const result = listing("аяллууд", [value]);
    assert.ok(!result.reply.includes("том хүн"));
    assert.ok(!result.reply.includes("1,200,000"));
  }
});

test("verified ranges and free fares survive with hotel/package qualifications", () => {
  const range = listing("аяллууд", [trip(0, { adult_price: 3_000_000, extra: { adult_price_range: { min: 3_000_000, max: 4_000_000 } } })]);
  assert.match(range.reply, /3,000,000₮ - 4,000,000₮/);
  const free = listing("аяллууд", [trip(0, { adult_price: 0, extra: { adult_price_free: true } })]);
  assert.match(free.reply, /том хүн Үнэгүй/);
  const longQualifier = listing("аяллууд", [trip(0, { extra: { price_groups: [{ hotel: "а".repeat(230), adult_price: 4_000_000 }] } })]);
  assert.ok(!longQualifier.reply.includes("том хүн"));
  assert.ok(!longQualifier.reply.includes("4,000,000"));
});

test("known closed/conflicting departures are never advertised as upcoming bookable dates", () => {
  for (const status of ["SOLD_OUT", "PAUSED", "CANCELLED", "CLOSED"]) {
    const value = trip(0, { departure_dates: ["2026-12-17", "2026-12-20"], extra: { website_departure_availability: [
      { date: "2026-12-17", status, seatsLeft: 0 },
      { date: "2026-12-20", status: "OPEN", seatsLeft: 5 },
    ] } });
    const result = listing("аяллууд", [value]);
    assert.ok(!result.reply.includes("2026-12-17"));
    assert.match(result.reply, /гарах: 2026-12-20/);
  }
  const closed = listing("аяллууд", [trip(0, { seats_left: 0 })]);
  assert.ok(!closed.reply.includes("гарах:"));
  assert.ok(!closed.reply.includes("том хүн"));
  const groupClosed = listing("аяллууд", [trip(0, { extra: { price_groups: [{ dates: ["2026-12-17"], status: "closed" }] } })]);
  assert.ok(!groupClosed.reply.includes("2026-12-17"));
  const conflict = listing("аяллууд", [trip(0, { extra: { website_departure_availability: [
    { date: "2026-12-17", status: "OPEN", seatsLeft: 4 }, { date: "2026-12-17", status: "SOLD_OUT", seatsLeft: 0 },
  ] } })]);
  assert.ok(!conflict.reply.includes("2026-12-17"));
});

test("expired departures are excluded using Mongolia's day boundary while today and future remain", () => {
  // UTC is still October 3, but it is already October 4 in Mongolia.
  const now = new Date("2026-10-03T16:30:00Z");
  const value = trip(0, { departure_dates: ["2026-10-03", "2026-10-04", "2026-10-05"], extra: {
    website_departure_availability: [
      { date: "2026-10-03", status: "OPEN", seatsLeft: 5 },
      { date: "2026-10-04", status: "OPEN", seatsLeft: 5 },
      { date: "2026-10-05", status: "OPEN", seatsLeft: 5 },
    ],
  } });
  const result = buildCatalogListingReply("аяллууд", [value], now);
  assert.ok(result);
  assert.ok(!result.reply.includes("2026-10-03"));
  assert.match(result.reply, /гарах: 2026-10-04, 2026-10-05/);
});

test("active trips with all departures closed use neutral compact and grouped headings", () => {
  const trips = Array.from({ length: 10 }, (_, i) => trip(i, { seats_left: 0 }));
  for (const text of ["аяллууд", "all trips"]) {
    const result = listing(text, trips);
    assert.match(result.reply, /^Манай аяллууд/);
    assert.ok(!result.reply.includes("Одоо захиалга"));
    assert.ok(!result.reply.includes("2026-12-17"));
  }
});

test("catalog and reply-policy modules load in either order without a new runtime cycle", () => {
  for (const order of [["catalogListing", "chatbotReplyPolicy"], ["chatbotReplyPolicy", "catalogListing"]]) {
    const code = `(async () => { for (const name of ${JSON.stringify(order)}) await import('./src/lib/' + name + '.ts'); })().catch(e => { console.error(e); process.exitCode = 1; });`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--eval", code], { encoding: "utf8", env: process.env });
    assert.equal(result.status, 0, result.stderr);
  }
});
