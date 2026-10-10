import test from "node:test";
import assert from "node:assert/strict";
import { checkSelfConsistency } from "../src/lib/selfConsistency";
import { buildStructuredTripReply } from "../src/lib/travelFastPaths";
import type { TravelTrip } from "../src/lib/travelTypes";

// Invented trips only. Each one carries a shape that made the bot reject its
// own answer on the live catalog (2026-10-10) and send the customer silence.
const NOW = new Date("2099-01-05T04:00:00Z");
const base = (id: string, route_name: string, extra: Record<string, unknown>, more: Partial<TravelTrip> = {}): TravelTrip => ({
  id, route_name, operator_name: "Uudam", category: "", duration_text: "8 өдөр 7 шөнө",
  adult_price: 3_000_000, child_price: 2_500_000, infant_price: 400_000, currency: "MNT",
  departure_dates: ["2099-02-10", "2099-02-17", "2099-02-24"], seats_total: null, seats_left: null,
  has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [], extra,
  created_at: "", updated_at: "", ...more,
});

const catalog: TravelTrip[] = [
  // Each departure priced differently, and the base fare differs from all of them.
  base("dated", "ЗАНДАН ДАЛАЙН АЯЛАЛ", { age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" }, price_groups: [
    { dates: ["2099-02-10", "2099-02-17"], adult_price: 3_100_000, child_price: 2_600_000 },
    { dates: ["2099-02-24"], adult_price: 3_400_000, child_price: 2_800_000 },
  ] }),
  // Child band touching the adult band ("2-12" next to "12+") and infant touching child.
  base("touching", "ХАРСАЙ УУЛЫН АЯЛАЛ", { age_rules: { adult: "12+ нас", child: "2-12 нас", infant: "0-2 нас" } }),
  // Sold per hotel on the same date; one hotel name contains another.
  base("hotels", "НАРАН АРЛЫН АЯЛАЛ", { age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-2 нас" }, price_groups: [
    { dates: ["2099-02-10"], hotel: "Lotus", adult_price: 3_600_000, child_price: 3_000_000 },
    { dates: ["2099-02-10"], hotel: "Lotus + Pearl", adult_price: 3_200_000, child_price: 2_700_000 },
  ] }, { departure_dates: ["2099-02-10"] }),
  // The nearest departure is sold out; later ones still sell.
  base("soldout", "ТОЛЬ НУУРЫН АЯЛАЛ", { age_rules: { adult: "12+ нас", child: "2-11 нас" },
    website_departure_availability: [{ date: "2099-02-10", status: "SOLD_OUT", seatsLeft: 0 }] }),
];

test("the bot accepts every answer it builds about the catalog", () => {
  const report = checkSelfConsistency(catalog, NOW);
  assert.ok(report.answers >= 20, `only ${report.answers} answers were built`);
  assert.deepEqual(report.failures.map((f) => `${f.routeName} — ${f.question}`), []);
});

test("the trip card leaves sold-out departures out and keeps each hotel's own prices", () => {
  const soldOut = buildStructuredTripReply("ТОЛЬ НУУРЫН АЯЛАЛ", catalog, NOW)!;
  assert.doesNotMatch(soldOut, /2\/10/);
  assert.match(soldOut, /2\/17/);
  const hotels = buildStructuredTripReply("НАРАН АРЛЫН АЯЛАЛ", catalog, NOW)!;
  assert.match(hotels, /Буудал: Lotus\n• Том хүн: 3,600,000₮/);
  assert.match(hotels, /Буудал: Lotus \+ Pearl\n• Том хүн: 3,200,000₮/);
});
