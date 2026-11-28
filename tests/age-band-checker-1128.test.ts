import test from "node:test";
import assert from "node:assert/strict";
import { applyTestEnv } from "./helpers/env";

applyTestEnv();

/**
 * Live 2026-11-28: a trip whose child tier is written «11 наснаас доош» (нас + the ablative «наас») had its own
 * price card refused by the bot's fact checker, so a customer asking the price got a staff hand-off instead of
 * the answer. The checker's band reader knew «11-ээс доош» but not «наснаас». Invented trip only.
 */
const NOW = new Date("2099-01-05T04:00:00Z");
const tier = (label: string, age_range: string, price: number) => ({ label, age_range, price, currency: "MNT", note: "" });
const group = (dates: string[], adult: number, child: number) => ({
  label: "", dates, adult_price: adult, child_price: child, infant_price: 300_000,
  passenger_prices: [tier("Хүүхэд ор эзлэхгүй", "11 наснаас доош", child), tier("Нярай", "0-2 нас", 300_000)],
});

function fixture() {
  return {
    id: "fixture-age-band", route_name: "ЗҮҮДНИЙ ТУРШИЛТЫН ХОСОЛСОН АЯЛАЛ", operator_name: "Uudam", category: "",
    duration_text: "8 өдөр 7 шөнө", adult_price: 3_000_000, child_price: 2_600_000, infant_price: 300_000, currency: "MNT",
    departure_dates: ["2099-02-10", "2099-02-17", "2099-02-24"], seats_total: null, seats_left: null,
    has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
    extra: {
      age_rules: { adult: "12+ нас", child: "11 наснаас доош", infant: "0-2 нас" },
      price_groups: [group(["2099-02-10"], 3_000_000, 2_600_000), group(["2099-02-17", "2099-02-24"], 3_100_000, 2_700_000)],
      website_departure_availability: [
        { date: "2099-02-10", status: "OPEN", seatsLeft: null },
        { date: "2099-02-17", status: "OPEN", seatsLeft: null },
        { date: "2099-02-24", status: "OPEN", seatsLeft: null },
      ],
    },
    created_at: "", updated_at: "",
  };
}

test("a price card whose child band reads «11 наснаас доош» passes the bot's own checker", async () => {
  const { checkSelfConsistency } = await import("../src/lib/selfConsistency");
  const { buildStructuredTripReply } = await import("../src/lib/travelFastPaths");
  const trip = fixture() as never;
  const card = buildStructuredTripReply("ЗҮҮДНИЙ ТУРШИЛТЫН ХОСОЛСОН АЯЛАЛ үнэ хэд вэ", [trip], NOW)!;
  assert.match(card, /Хүүхэд \/11 наснаас доош[^:]*\/: 2,600,000₮/);
  assert.deepEqual(checkSelfConsistency([trip], NOW).failures.map((failure) => failure.question), []);
});

test("the checker still refuses a child fare the trip does not have under that band", async () => {
  const { verifyTripReply } = await import("../src/lib/tripReplyVerification");
  const trip = fixture() as never;
  const wrong = "✈️ ЗҮҮДНИЙ ТУРШИЛТЫН ХОСОЛСОН АЯЛАЛ\n2/10:\n• Хүүхэд /11 наснаас доош, ор эзлэхгүй/: 2,100,000₮";
  assert.equal(verifyTripReply({ reply: wrong, trips: [trip], now: NOW }), "REFER");
  const right = "✈️ ЗҮҮДНИЙ ТУРШИЛТЫН ХОСОЛСОН АЯЛАЛ\n2/10:\n• Хүүхэд /11 наснаас доош, ор эзлэхгүй/: 2,600,000₮";
  assert.notEqual(verifyTripReply({ reply: right, trips: [trip], now: NOW }), "REFER");
});
