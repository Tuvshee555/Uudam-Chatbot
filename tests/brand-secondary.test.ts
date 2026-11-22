import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { brandText, getBrand, resolveBrand } from "../src/lib/brand";
import {
  applyBrandFares,
  applyBrandFaresToPoster,
  BRAND_FARES_MARK,
  makeFareTextReplacer,
  posterFareMap,
  tripFareMap,
} from "../src/lib/brandFares";
import { classifyBrandWrite, __guardClientForTests } from "../src/lib/brandWriteGuard";
import type { TravelTrip } from "../src/lib/travelTypes";

const ORIGINAL_BRAND = process.env.BRAND;
afterEach(() => {
  if (ORIGINAL_BRAND === undefined) delete process.env.BRAND; else process.env.BRAND = ORIGINAL_BRAND;
  delete process.env.BRAND_WEBSITE_URL;
  delete process.env.BRAND_DISCOUNT_MNT;
});

// Invented catalogue data only (repo rule): no real trip, place, price or date.
function inventedTrip(overrides: Partial<TravelTrip> = {}): TravelTrip {
  return {
    id: "trip-invented-1", category: "Аялал", operator_name: "UUDAM TRAVEL AGENCY", route_name: "Зорвэл хотын аялал",
    duration_text: "6 өдөр", adult_price: 3_333_000, child_price: 2_222_000, infant_price: 444_000, currency: "MNT",
    departure_dates: ["2099-03-14"], seats_total: 20, seats_left: 7, has_food: true, status: "active",
    notes: "Том хүн 3,333,000₮, хүүхэд 2 222 000₮, нярай 444,000₮. Ганц өрөө +600,000₮. Нийт 3.33 сая орчим.",
    hotel: "", source_description: "Уудам Трэвэл зохион байгуулна: uudamtravel.mn", photo_urls: ["https://res.cloudinary.com/x/image/upload/uudam-travel-trips/a.jpg"],
    extra: {
      price_groups: [
        { label: "2099-03-14", dates: ["2099-03-14"], adult_price: 3_333_000, child_price: 2_222_000, infant_price: 444_000, single_price: 600_000,
          passenger_prices: [{ label: "Хүүхэд", age_range: "3-11 нас", price: 2_111_000 }, { label: "Нярай", age_range: "0-2 нас", price: 444_000 }] },
        { label: "2099-04-02", dates: ["2099-04-02"], adult_price: 3_383_000, child_price: 2_222_000, infant_price: 2_222_000, single_price: 3_999_000 },
      ],
      child_rules: [
        { label: "2-11 нас хүүхэд", age_range: "2-11 нас", price: 2_222_000, note: "буудалд ороогүй 2,222,000₮" },
        { label: "0-2 нас хүүхэд/такс", age_range: "0-2 нас", price: 2_222_000, note: "" },
      ],
      extra_fees: [{ label: "Виз", amount: 3_333_000, note: "3,333,000₮ виз" }],
      room_prices: [{ room_type: "2 хүний өрөө", price: 3_333_000 }, { room_type: "Ганц өрөө нэмэлт", price: 600_000 }],
      seats_total: 3_333_000,
      website_details: { price: 3_333_000, childPrice: 2_222_000, infantPrice: 2_222_000, singleSupplement: 600_000 },
    },
    created_at: "", updated_at: "",
    ...overrides,
  };
}

test("the default brand is the primary: no discount, no text change", () => {
  delete process.env.BRAND;
  const brand = getBrand();
  assert.equal(brand.key, "uudam");
  assert.equal(brand.isPrimary, true);
  assert.equal(brand.storageKey, "");
  assert.equal(brand.fareDiscountMnt, 0);
  assert.equal(brandText("Уудам Трэвэл-д тавтай морил: uudamtravel.mn"), "Уудам Трэвэл-д тавтай морил: uudamtravel.mn");
});

test("BRAND=magnai: its own names, website, storage key and a 50,000 discount", () => {
  const brand = resolveBrand({ BRAND: "magnai", BRAND_WEBSITE_URL: "magnai-invented.example/" } as unknown as NodeJS.ProcessEnv);
  assert.equal(brand.key, "magnai");
  assert.equal(brand.isPrimary, false);
  assert.equal(brand.storageKey, "magnai");
  assert.equal(brand.fareDiscountMnt, 50_000);
  assert.equal(brand.websiteUrl, "https://magnai-invented.example");
  assert.equal(resolveBrand({ BRAND: "magnai", BRAND_DISCOUNT_MNT: "70000" } as unknown as NodeJS.ProcessEnv).fareDiscountMnt, 70_000);
});

test("brand text swaps names and the website host, never text inside other URLs", () => {
  process.env.BRAND = "magnai";
  process.env.BRAND_WEBSITE_URL = "https://magnai-invented.example";
  assert.equal(brandText("Уудам Трэвэл-д тавтай морилно уу!"), "Магнай Травел-д тавтай морилно уу!");
  assert.equal(brandText("You are the official AI travel assistant for Uudam Travel."), "You are the official AI travel assistant for Magnai Travel.");
  assert.equal(brandText("UUDAM TRAVEL AGENCY"), "MAGNAI TRAVEL");
  assert.equal(brandText("Дэлгэрэнгүйг uudamtravel.mn вебсайтаас"), "Дэлгэрэнгүйг magnai-invented.example вебсайтаас");
  assert.equal(brandText("https://uudamtravel.mn/mn/trips/zorvel"), "https://magnai-invented.example/mn/trips/zorvel");
  const photo = "https://res.cloudinary.com/x/image/upload/uudam-travel-trips/Uudam.jpg";
  assert.equal(brandText(`Зураг: ${photo}`), `Зураг: ${photo}`);
});

test("fare map: adult and child tiers only — infant tiers, supplements and fees are not fares", () => {
  const map = tripFareMap(inventedTrip(), 50_000);
  assert.equal(map.get(3_333_000), 3_283_000);
  assert.equal(map.get(2_222_000), 2_172_000);
  assert.equal(map.get(2_111_000), 2_061_000);
  assert.equal(map.get(3_383_000), 3_333_000);
  assert.equal(map.get(3_999_000), 3_949_000, "a single-occupancy full fare (>= adult) is a fare");
  assert.equal(map.has(444_000), false, "infant fare");
  assert.equal(map.has(600_000), false, "single supplement");
  assert.equal(tripFareMap(inventedTrip(), 0).size, 0);
});

test("a trip as the secondary brand quotes it: every adult/child figure 50,000 lower, once", () => {
  process.env.BRAND = "magnai";
  const trip = applyBrandFares(inventedTrip(), 50_000, brandText);
  assert.equal(trip.adult_price, 3_283_000);
  assert.equal(trip.child_price, 2_172_000);
  assert.equal(trip.infant_price, 444_000);
  assert.equal(trip.operator_name, "MAGNAI TRAVEL");
  // «3.33 сая» is only an approximation of 3,333,000 (not an exact fare), so it stays.
  assert.equal(trip.notes, "Том хүн 3,283,000₮, хүүхэд 2 172 000₮, нярай 444,000₮. Ганц өрөө +600,000₮. Нийт 3.33 сая орчим.");
  assert.match(trip.source_description, /^Магнай Травел зохион байгуулна: /);
  const groups = trip.extra.price_groups as Array<Record<string, unknown>>;
  assert.equal(groups[0].adult_price, 3_283_000);
  assert.equal(groups[0].child_price, 2_172_000);
  assert.equal(groups[0].infant_price, 444_000);
  assert.equal(groups[0].single_price, 600_000, "supplement kept");
  const bands = groups[0].passenger_prices as Array<Record<string, unknown>>;
  assert.equal(bands[0].price, 2_061_000);
  assert.equal(bands[1].price, 444_000);
  // One pass: 3,383,000 becomes 3,333,000 and is NOT discounted again although 3,333,000 is a fare.
  assert.equal(groups[1].adult_price, 3_333_000);
  assert.equal(groups[1].infant_price, 2_222_000, "an infant key is never discounted, even when it equals a child fare");
  assert.equal(groups[1].single_price, 3_949_000);
  const rules = trip.extra.child_rules as Array<Record<string, unknown>>;
  assert.equal(rules[0].price, 2_172_000);
  assert.equal(rules[0].note, "буудалд ороогүй 2,172,000₮");
  assert.equal(rules[1].price, 2_222_000, "infant-shaped band kept");
  const fees = trip.extra.extra_fees as Array<Record<string, unknown>>;
  assert.equal(fees[0].amount, 3_333_000, "a fee is never a fare, even when it equals one");
  assert.equal(fees[0].note, "3,283,000₮ виз", "a fare amount written in a text is still the fare");
  const rooms = trip.extra.room_prices as Array<Record<string, unknown>>;
  assert.equal(rooms[0].price, 3_283_000);
  assert.equal(rooms[1].price, 600_000);
  assert.equal(trip.extra.seats_total, 3_333_000, "a non-fare key is never changed");
  const details = trip.extra.website_details as Record<string, unknown>;
  assert.equal(details.price, 3_283_000);
  assert.equal(details.childPrice, 2_172_000);
  assert.equal(details.infantPrice, 2_222_000);
  assert.equal(details.singleSupplement, 600_000);
  assert.deepEqual(trip.photo_urls, inventedTrip().photo_urls);
  assert.equal(trip.extra[BRAND_FARES_MARK], true);
  // Applying again changes nothing.
  assert.deepEqual(applyBrandFares(trip, 50_000, brandText), trip);
});

test("text amounts: only exact fares, any separator, never inside a longer number", () => {
  const replace = makeFareTextReplacer(new Map([[3_333_000, 3_283_000], [2_220_000, 2_170_000]]));
  assert.equal(replace("3,333,000₮ / 3 333 000 / 3.333.000 / 3333000"), "3,283,000₮ / 3 283 000 / 3.283.000 / 3283000");
  assert.equal(replace("13,333,000₮ 3,333,0001 33333000"), "13,333,000₮ 3,333,0001 33333000");
  assert.equal(replace("2.22 сая, 2,22 сая, 2.22 км"), "2.17 сая, 2,17 сая, 2.22 км");
  assert.equal(replace("Үнэ: 3,333,000₮-с 2,220,000₮"), "Үнэ: 3,283,000₮-с 2,170,000₮");
});

test("poster: fare columns and the linked trip's fares are discounted; infant and supplement columns kept", () => {
  process.env.BRAND = "magnai";
  const data = {
    agency: "UUDAM TRAVEL AGENCY",
    title: "Зорвэл хотын аялал",
    hero_image: "https://res.cloudinary.com/x/image/upload/uudam-travel-trips/h.jpg",
    price_table: {
      columns: ["Том хүн", "Хүүхэд 2-11", "Нярай 0-2", "Ганц өрөө"],
      rows: [{ dates: "3/14", cells: ["3,333,000₮", "2,222,000₮", "444,000₮", "600,000₮"] }, { dates: "4/02", cells: ["3,555,000₮", "2,555,000₮", "444,000₮", "600,000₮"] }],
    },
    price_note: "Том хүн 3,333,000₮",
    contacts: { phones: ["0000-0000"] },
  };
  const fares = posterFareMap(data, tripFareMap(inventedTrip(), 50_000), 50_000);
  const out = applyBrandFaresToPoster(data, fares, brandText) as typeof data;
  assert.equal(out.agency, "MAGNAI TRAVEL");
  assert.deepEqual(out.price_table.rows[0].cells, ["3,283,000₮", "2,172,000₮", "444,000₮", "600,000₮"]);
  assert.deepEqual(out.price_table.rows[1].cells, ["3,505,000₮", "2,505,000₮", "444,000₮", "600,000₮"]);
  assert.equal(out.price_note, "Том хүн 3,283,000₮");
  assert.equal(out.hero_image, data.hero_image);
  assert.deepEqual(out.contacts, data.contacts);
});

test("write guard: a secondary may write only its customer tables", () => {
  const allowed = [
    "INSERT INTO travel_senders (sender_id) VALUES ($1) ON CONFLICT (sender_id) DO UPDATE\n SET last_seen = NOW()",
    "UPDATE travel_senders SET follow_up_sent_at = NOW() WHERE sender_id = $1",
    "WITH due AS (SELECT sender_id FROM travel_senders FOR UPDATE SKIP LOCKED) UPDATE travel_senders s SET x = 1 FROM due",
    "INSERT INTO travel_leads (kind) VALUES ('handoff') RETURNING id",
    "SELECT * FROM travel_trip_entries WHERE id = $1",
    "SELECT id FROM \"Trip\" WHERE slug = $1 FOR NO KEY UPDATE",
    "CREATE TABLE IF NOT EXISTS travel_trip_entries (id TEXT)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_x ON travel_trip_entries (id)",
    "ALTER TABLE travel_senders ADD COLUMN IF NOT EXISTS brand TEXT NOT NULL DEFAULT ''",
    "-- update travel_trip_entries\nSELECT 1",
    "SELECT 'UPDATE travel_trip_entries SET x=1' AS text",
    "INSERT INTO travel_sweep_lock (id, last_run_at) VALUES (2, NOW()) ON CONFLICT (id) DO UPDATE SET last_run_at = NOW()",
  ];
  for (const sql of allowed) assert.equal(classifyBrandWrite(sql).allowed, true, sql);
  const blocked: Array<[string, string]> = [
    ["UPDATE travel_trip_entries SET adult_price = $2 WHERE id = $1", "travel_trip_entries"],
    ["INSERT INTO travel_bot_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING", "travel_bot_settings"],
    ["UPDATE \"Trip\" SET price = $1", "trip"],
    ["UPDATE public.\"Departure\" SET price = $1", "departure"],
    ["DELETE FROM travel_trip_entries WHERE id = $1", "travel_trip_entries"],
    ["INSERT INTO poster_pdf_cache(poster_id,hash,pdf) VALUES ($1,$2,$3)", "poster_pdf_cache"],
    ["WITH x AS (UPDATE travel_bot_control SET bot_paused = TRUE RETURNING 1) SELECT * FROM x", "travel_bot_control"],
    ["TRUNCATE travel_leads", "travel_leads"],
  ];
  for (const [sql, table] of blocked) {
    const verdict = classifyBrandWrite(sql);
    assert.equal(verdict.allowed, false, sql);
    if (!verdict.allowed && table !== "travel_leads") assert.ok(verdict.tables.includes(table), `${sql} → ${verdict.tables}`);
  }
  for (const sql of ["DROP TABLE travel_leads", "ALTER TABLE travel_senders DROP COLUMN brand", "ALTER TABLE travel_senders ALTER COLUMN brand TYPE INT", "CREATE TABLE travel_new (id INT)"]) {
    assert.equal(classifyBrandWrite(sql).allowed, false, sql);
  }
});

test("a guarded client never sends a blocked write and answers it like a write that matched nothing", async () => {
  const sent: string[] = [];
  const client = {
    query: (text: string, _values?: unknown, callback?: (e: Error | null, r: unknown) => void) => {
      sent.push(text);
      const result = { command: "SELECT", rowCount: 1, rows: [{ ok: 1 }] };
      if (typeof callback === "function") { callback(null, result); return undefined; }
      return Promise.resolve(result);
    },
  };
  __guardClientForTests(client as never);
  const blocked = await (client.query as (t: string, v?: unknown) => Promise<{ rowCount: number; rows: unknown[] }>)("UPDATE travel_trip_entries SET adult_price = 1", []);
  assert.equal(blocked.rowCount, 0);
  assert.deepEqual(blocked.rows, []);
  const viaCallback = await new Promise<{ rowCount: number }>((resolve) => {
    client.query("DELETE FROM travel_bot_settings", [], (_error, result) => resolve(result as { rowCount: number }));
  });
  assert.equal(viaCallback.rowCount, 0);
  const allowed = await (client.query as (t: string) => Promise<{ rowCount: number }>)("SELECT 1");
  assert.equal(allowed.rowCount, 1);
  assert.deepEqual(sent, ["SELECT 1"]);
});
