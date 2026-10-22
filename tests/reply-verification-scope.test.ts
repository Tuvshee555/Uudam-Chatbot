import assert from "node:assert/strict";
import test from "node:test";
import { verifyTripReply } from "../src/lib/tripReplyVerification";
import { guardUnverifiedDates, guardUnverifiedPrices } from "../src/lib/reply";
import type { TravelTrip } from "../src/lib/travelTypes";

const NOW = new Date("2098-02-01T04:00:00Z");
function trip(id: string, route_name: string, date: string, extra: Record<string, unknown> = {}): TravelTrip {
  return { id, route_name, category: "", operator_name: "Invented", duration_text: "5 өдөр",
    adult_price: 1_700_000, child_price: null, infant_price: null, currency: "MNT", departure_dates: [date],
    seats_total: null, seats_left: null, has_food: null, status: "active", notes: "", hotel: "",
    source_description: "", photo_urls: [], extra, created_at: "", updated_at: "" };
}
const VELMOR = trip("velmor", "Вэлмор аялал", "2098-03-17", { transport_type: "land" });
const NERITH = trip("nerith", "Нерит аялал", "2098-03-19", { transport_type: "direct_flight" });
const check = (reply: string, trips = [VELMOR, NERITH]) => verifyTripReply({ reply, trips, now: NOW });

test("naming a trip does not exempt an unsupported direct-flight claim", () => {
  assert.equal(check(`${VELMOR.route_name} — шууд нислэгтэй`), "REFER");
  assert.equal(check(`${VELMOR.route_name}\nШууд нислэгтэй`), "REFER");
  assert.equal(check(`${VELMOR.route_name} — шууд нислэгтэй`, [{ ...VELMOR, extra: {} }]), "REFER");
  const supported = `${NERITH.route_name} — шууд нислэгтэй`;
  assert.equal(check(supported), supported);
  const negative = `${VELMOR.route_name} — шууд нислэгтэй биш`;
  assert.equal(check(negative), negative);
});

test("a named departure claim must belong to that trip rather than a sibling candidate", () => {
  assert.equal(check(`${VELMOR.route_name}\nГарах өдөр: 2098-03-19`), "REFER");
  const supported = `${VELMOR.route_name}\nГарах өдөр: 2098-03-17\n${NERITH.route_name}\nГарах өдөр: 2098-03-19`;
  assert.equal(check(supported), supported);
  const negative = `${VELMOR.route_name}\n2098-03-19 гарахгүй байна`;
  assert.equal(check(negative), negative);
});

test("a new trip section does not inherit the previous trip's grouped departure dates", () => {
  const grouped = { ...VELMOR, departure_dates: ["2098-03-17", "2098-03-18"] };
  const reply = `${VELMOR.route_name}\nГарах өдөр: 2098-03-17, 2098-03-18\nТом хүн: 1,700,000₮\n${NERITH.route_name}\nТом хүн: 1,700,000₮`;
  assert.equal(check(reply, [grouped, NERITH]), reply);
});

test("price and date guards use the trip named by the current section", () => {
  const nerith = { ...NERITH, adult_price: 1_900_000 };
  const trips = [VELMOR, nerith];
  const valid = `${VELMOR.route_name}\nГарах өдөр: 2098-03-17\nТом хүн: 1,700,000₮\n${NERITH.route_name}\nТом хүн: 1,900,000₮`;
  assert.equal(guardUnverifiedPrices(valid, trips, NOW), valid);
  assert.equal(check(valid, trips), valid);
  assert.equal(guardUnverifiedPrices(`${VELMOR.route_name}\nҮнэ: 1,900,000₮`, trips, NOW), "REFER");
  assert.equal(guardUnverifiedDates(`${VELMOR.route_name}\nГарах өдөр: 2098-03-19`, trips, undefined, NOW), "REFER");
});

test("a section's date below its fare still restricts that fare", () => {
  const trip = { ...VELMOR, departure_dates: ["2098-03-17", "2098-03-18"], extra: {
    price_groups: [{ dates: ["2098-03-17"], adult_price: 1_700_000 }, { dates: ["2098-03-18"], adult_price: 1_900_000 }],
  } };
  const wrong = `${trip.route_name}\nТом хүн: 1,700,000₮\nГарах өдөр: 2098-03-18`;
  assert.equal(guardUnverifiedPrices(wrong, [trip], NOW), "REFER");
  assert.equal(check(wrong, [trip]), "REFER");
  const valid = wrong.replace("1,700,000", "1,900,000");
  assert.equal(check(valid, [trip]), valid);
});
