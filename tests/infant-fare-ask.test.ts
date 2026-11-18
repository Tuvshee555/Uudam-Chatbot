/**
 * An infant fare the trip does not give is said as «тодруулж мэдээлэл аваарай», with a
 * «Нярайн үнэ тодруулах» button that reaches staff (the owner, 2026-11-18). Invented trips only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { INFANT_ASK_BUTTON, INFANT_FARE_ASK, hasInfantFareAsk, withInfantAskButton } from "../src/lib/infantFareAsk";
import { buildSmartButtons, buildStructuredTripReply } from "../src/lib/travelFastPaths";
import { formatPassengerPriceLines } from "../src/lib/travelFastPathsPricing";
import { buildPassengerTotalReply } from "../src/lib/passengerTotalReply";
import { isHandoffRequest } from "../src/lib/handoffDetection";
import { shouldSilenceNoDataReply } from "../src/lib/reply";
import type { TravelTrip } from "../src/lib/travelOps";

const NOW = new Date("2098-06-24T04:00:00.000Z");

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "trip-norvel", category: "Outbound", operator_name: "Uudam Travel", route_name: "НОРВЕЛ ХОТЫН АЯЛАЛ",
    duration_text: "5 өдөр / 4 шөнө", adult_price: 2_000_000, child_price: 1_500_000, infant_price: null, currency: "MNT",
    departure_dates: ["2098-07-10"], seats_total: null, seats_left: null, has_food: true, status: "active", notes: "", hotel: "",
    source_description: "", photo_urls: [], extra: {}, created_at: "", updated_at: "", ...fields,
  };
}

test("the reply carries the ask and the button comes first, never twice", () => {
  const reply = `• Том хүн: 2,000,000₮\n• Нярай /0-23 сар/: ${INFANT_FARE_ASK}`;
  assert.equal(hasInfantFareAsk(reply), true);
  assert.deepEqual(withInfantAskButton(reply, ["Захиалах", "Хөтөлбөр"]), [INFANT_ASK_BUTTON, "Захиалах", "Хөтөлбөр"]);
  assert.deepEqual(withInfantAskButton(reply, [INFANT_ASK_BUTTON]), [INFANT_ASK_BUTTON]);
  assert.deepEqual(withInfantAskButton("• Нярай: 350,000₮", ["Захиалах"]), ["Захиалах"]);
  assert.ok(INFANT_ASK_BUTTON.length <= 20, "a Messenger quick reply title holds 20 characters");
});

test("a fare list says the unknown infant fare; a real or free one is printed as before", () => {
  assert.deepEqual(formatPassengerPriceLines({ adult: 2_000_000, child: 1_500_000, infant: null, currency: "MNT" }),
    ["• Том хүн: 2,000,000₮", "• Хүүхэд: 1,500,000₮", `• Нярай: ${INFANT_FARE_ASK}`]);
  assert.match(formatPassengerPriceLines({ adult: 2_000_000, infant: 350_000, currency: "MNT" }).join("\n"), /• Нярай: 350,000₮/);
  assert.match(formatPassengerPriceLines({ adult: 2_000_000, infant: 0, infantFree: true, currency: "MNT" }).join("\n"), /• Нярай: Үнэгүй/);
  assert.deepEqual(formatPassengerPriceLines({ currency: "MNT" }), [], "no fares at all: nothing to stand beside");
});

test("the trip card says it, the reply is not silenced, and it gets the button", () => {
  const t = trip({});
  const card = buildStructuredTripReply([t.route_name, "үнэ хэд вэ?"].join("\n"), [t], NOW) || "";
  assert.match(card, /Том хүн: 2,000,000₮/);
  assert.match(card, new RegExp(`Нярай[^\\n]*: ${INFANT_FARE_ASK}`));
  assert.equal(shouldSilenceNoDataReply(card), false);
  assert.deepEqual(buildSmartButtons(card, [t]), [INFANT_ASK_BUTTON]);
});

test("«нярайн үнэ хэд?» with no infant fare is answered with the ask, not silence", () => {
  const t = trip({ extra: { price_groups: [{ dates: ["2098-07-10"], adult_price: 2_000_000, child_price: 1_500_000, infant_price: 0 }] } });
  const reply = buildStructuredTripReply([t.route_name, "нярайн үнэ хэд вэ?"].join("\n"), [t], NOW) || "";
  assert.match(reply, new RegExp(`Нярай[^\\n]*: ${INFANT_FARE_ASK}`));
  assert.doesNotMatch(reply, /:\s*0₮|Үнэгүй/);
  assert.equal(shouldSilenceNoDataReply(reply), false);
});

test("a party total names the infant as unknown and leaves it out of the total", () => {
  const t = trip({});
  const reply = buildPassengerTotalReply(t, `${t.route_name}\n2 том хүн 1 нярай нийт хэд вэ`, NOW) || "";
  assert.match(reply, /4,000,000₮ \(нярайн үнэ ороогүй\)/);
  assert.match(reply, new RegExp(`• Нярай 1: ${INFANT_FARE_ASK}`));
  assert.equal(shouldSilenceNoDataReply(reply), false);
});

test("the button's words reach staff", () => {
  assert.equal(isHandoffRequest(INFANT_ASK_BUTTON, []), true);
  assert.equal(isHandoffRequest("нярайн үнэ хэд вэ", []), false, "a price question is not a hand-off");
});
